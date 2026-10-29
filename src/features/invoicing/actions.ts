'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import { emitirNotaCreditoSchema, fijarArranqueSchema, guardarCredencialesSunatSchema, reintentarBajaSchema, solicitarBajaSchema } from './schemas'
import { fijarArranqueSerie, listarSeriesConfigurables } from './counter-service'
import { guardarCredencialesSunat, probarConexionSunat, quitarCredencialesSunat } from '@/features/sunat/credenciales'
import { reintentarBaja, solicitarBajaComprobante } from '@/features/sunat/baja'
import { emitirNotaCreditoTotal } from './service'

/**
 * Server Actions de comprobantes.
 *
 * El rol se comprueba en el SERVICIO, no aquí: una Server Action es un
 * endpoint HTTP y cualquiera puede invocarla a mano (Frente 1).
 */

async function withTenant<T>(
  accion: string,
  fn: (db: TenantPrismaClient, ctx: TenantContext) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  let ctx: TenantContext | null = null
  try {
    ctx = await requireTenantContext()
    return await fn(getTenantPrisma(ctx), ctx)
  } catch (e) {
    if (isBusinessError(e)) {
      return { ok: false, code: e.code, message: e.message, details: e.details }
    }
    console.error('[comprobantes] fallo inesperado', {
      accion,
      tenantId: ctx?.tenantId ?? null,
      error: e instanceof Error ? { name: e.name, message: e.message } : e,
    })
    return {
      ok: false,
      code: 'TENANT_MISMATCH',
      message: 'No pudimos completar la operación. Intenta de nuevo.',
    }
  }
}

export async function getSeriesConfigurables(branchId: string) {
  return withTenant('getSeriesConfigurables', async (db, ctx) => ({
    ok: true as const,
    data: await listarSeriesConfigurables(db, ctx, branchId),
  }))
}

export async function setArranqueSerie(raw: unknown) {
  const parsed = fijarArranqueSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false as const,
      code: 'VALIDATION' as const,
      message: 'Revisa el correlativo inicial.',
      details: z.flattenError(parsed.error).fieldErrors,
    }
  }

  return withTenant('setArranqueSerie', async (db, ctx) => {
    const r = await fijarArranqueSerie(db, ctx, {
      branchId: parsed.data.branchId,
      scope: parsed.data.scope,
      startNumber: parsed.data.startNumber,
    })
    revalidatePath('/comprobantes')
    return { ok: true as const, data: r }
  })
}

/**
 * Emite la nota de crédito TOTAL de una venta. La validación y el permiso (`comprobantes.anular`) viven en el
 * servicio: esto es un endpoint HTTP y cualquiera puede invocarlo a mano.
 */
export async function emitirNotaCreditoAction(raw: unknown) {
  const parsed = emitirNotaCreditoSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false as const,
      code: 'VALIDATION' as const,
      message: 'Revisa el motivo y el sustento.',
      details: z.flattenError(parsed.error).fieldErrors,
    }
  }

  return withTenant('emitirNotaCreditoAction', async (db, ctx) => {
    const r = await emitirNotaCreditoTotal(db, ctx, parsed.data)
    revalidatePath('/comprobantes')
    return { ok: true as const, data: r }
  })
}

/** Pide la baja de una factura ya aceptada (comprobantes.dar_baja; el servicio lo exige). Nada sale a SUNAT aquí: la cola lo envía. */
export async function solicitarBajaAction(raw: unknown) {
  const parsed = solicitarBajaSchema.safeParse(raw)
  if (!parsed.success) return { ok: false as const, code: 'VALIDATION' as const, message: 'Revisa el motivo de la baja.', details: z.flattenError(parsed.error).fieldErrors }
  return withTenant('solicitarBajaAction', async (db, ctx) => {
    const r = await solicitarBajaComprobante(db, ctx, parsed.data.taxDocumentId, parsed.data.motivo)
    revalidatePath('/comprobantes')
    return { ok: true as const, data: r }
  })
}

/** Reintenta una baja que se quedó sin respuesta tras todos los reintentos. */
export async function reintentarBajaAction(raw: unknown) {
  const parsed = reintentarBajaSchema.safeParse(raw)
  if (!parsed.success) return { ok: false as const, code: 'VALIDATION' as const, message: 'Falta el comprobante.', details: z.flattenError(parsed.error).fieldErrors }
  return withTenant('reintentarBajaAction', async (db, ctx) => {
    await reintentarBaja(db, ctx, parsed.data.taxDocumentId)
    revalidatePath('/comprobantes')
    return { ok: true as const, data: {} }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
//  SUNAT DIRECTO — certificado digital y usuario SOL secundario (config.fiscal, solo el dueño)
// ═══════════════════════════════════════════════════════════════════════════

export async function guardarCredencialesSunatAction(raw: unknown) {
  const parsed = guardarCredencialesSunatSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false as const, code: 'VALIDATION' as const, message: parsed.error.issues[0]?.message ?? 'Revisa los datos.', details: z.flattenError(parsed.error).fieldErrors }
  }
  return withTenant('guardarCredencialesSunatAction', async (db, ctx) => {
    const estado = await guardarCredencialesSunat(db, ctx, parsed.data)
    revalidatePath('/comprobantes')
    // Solo metadatos: nunca vuelve el .pfx ni ninguna clave.
    return { ok: true as const, data: { vence: estado.certificado?.vence.toISOString() ?? null } }
  })
}

export async function quitarCredencialesSunatAction() {
  return withTenant('quitarCredencialesSunatAction', async (db, ctx) => {
    await quitarCredencialesSunat(db, ctx)
    revalidatePath('/comprobantes')
    return { ok: true as const, data: null }
  })
}

/** «Probar conexión»: lee las credenciales guardadas, abre el certificado y consulta a SUNAT con el usuario SOL. No emite ni envía nada tributario. */
export async function probarCredencialesSunatAction() {
  return withTenant('probarCredencialesSunatAction', async (db, ctx) => {
    const r = await probarConexionSunat(db, ctx)
    revalidatePath('/comprobantes')
    return { ok: true as const, data: r }
  })
}
