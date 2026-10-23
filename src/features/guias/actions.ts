'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import { puede } from '@/lib/puede'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import type { TenantContext } from '@/lib/tenant-context'
import { buscarProductos } from '@/features/pos/busqueda'
import { BusinessError } from '@/lib/errors'
import { anularGuia, emitirGuia, type GuiaEmitida } from './service'
import { anularGuiaSchema, emitirGuiaSchema } from './schemas'

/**
 * Server Actions de guías de remisión. El permiso lo exige cada servicio; aquí
 * van la sesión, Zod y el resultado tipado.
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
    if (isBusinessError(e)) return { ok: false, code: e.code, message: e.message, details: e.details }
    console.error('[guias] fallo inesperado', {
      accion, tenantId: ctx?.tenantId ?? null,
      error: e instanceof Error ? { name: e.name, message: e.message } : e,
    })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos completar la operación. Intenta de nuevo.' }
  }
}

export async function emitirGuiaAction(raw: unknown): Promise<ActionResult<GuiaEmitida>> {
  const parsed = emitirGuiaSchema.safeParse(raw)
  if (!parsed.success) {
    // Los errores van por CAMPO (`details`) para que el formulario los marque donde corresponde.
    const campos: Record<string, string> = {}
    for (const i of parsed.error.issues) campos[i.path.join('.')] ??= i.message
    return { ok: false, code: 'VALIDATION', message: parsed.error.issues[0]?.message ?? 'Revisa los datos de la guía.', details: campos }
  }
  return withTenant('emitirGuia', async (db, ctx) => {
    const g = await emitirGuia(db, ctx, parsed.data)
    revalidatePath('/guias')
    return { ok: true, data: g }
  })
}

export async function anularGuiaAction(raw: unknown): Promise<ActionResult<null>> {
  const parsed = anularGuiaSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: parsed.error.issues[0]?.message ?? 'Revisa los datos.' }
  }
  return withTenant('anularGuia', async (db, ctx) => {
    await anularGuia(db, ctx, parsed.data)
    revalidatePath('/guias')
    return { ok: true, data: null }
  })
}

/** Buscador de productos para añadir líneas a una guía (no exige almacén ni stock). */
export async function buscarProductosGuiaAction(texto: string): Promise<ActionResult<Array<{ productId: string; name: string; sku: string; unitType: string }>>> {
  const t = z.string().trim().min(2).max(80).safeParse(texto)
  if (!t.success) return { ok: true, data: [] }
  return withTenant('buscarProductosGuia', async (db, ctx) => {
    if (!puede(ctx, 'guias.emitir')) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para emitir guías de remisión.')
    const r = await buscarProductos(db, ctx, t.data)
    return { ok: true, data: r.slice(0, 8).map((p) => ({ productId: p.productId, name: p.name, sku: p.sku, unitType: p.unitType })) }
  })
}
