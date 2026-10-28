'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { anularMovimientoCajaSchema, registrarMovimientoCajaSchema } from './cash-movement-schemas'
import { anularMovimientoCaja as runAnular, registrarMovimientoCaja as runRegistrar, type MovimientoCaja } from './cash-movement-service'

/**
 * Server Actions de los movimientos manuales de caja (F6.3c). Sesión en el servidor, Zod antes de la base y el permiso lo decide el SERVICIO
 * (`caja.movimientos` / `caja.ajuste`): una Server Action es un endpoint HTTP y cualquiera puede invocarla a mano. Los errores llegan con su mensaje
 * en español; el aviso de exceso viaja con su código (`CASH_EXCEEDS_EXPECTED`) para que la pantalla pida la doble confirmación.
 */

function invalida(error: z.ZodError): ActionResult<never> {
  return { ok: false, code: 'VALIDATION', message: error.issues[0]?.message ?? 'Revisa los datos.', details: z.flattenError(error).fieldErrors }
}

async function conTenant<T>(accion: string, fn: (db: TenantPrismaClient, ctx: TenantContext) => Promise<T>): Promise<ActionResult<T>> {
  let ctx: TenantContext | null = null
  try {
    ctx = await requireTenantContext()
    return { ok: true, data: await fn(getTenantPrisma(ctx), ctx) }
  } catch (e) {
    if (isBusinessError(e)) return { ok: false, code: e.code, message: e.message, details: e.details }
    console.error('[caja] fallo inesperado', { accion, tenantId: ctx?.tenantId ?? null, error: e instanceof Error ? { name: e.name, message: e.message } : e })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos completar la operación. Intenta de nuevo.' }
  }
}

export async function registrarMovimiento(raw: unknown): Promise<ActionResult<MovimientoCaja>> {
  const p = registrarMovimientoCajaSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('registrarMovimiento', (db, ctx) => runRegistrar(db, ctx, p.data))
  if (r.ok) { revalidatePath('/caja'); revalidatePath('/dashboard') }
  return r
}

export async function anularMovimiento(raw: unknown): Promise<ActionResult<{ id: string; voidedAt: string }>> {
  const p = anularMovimientoCajaSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('anularMovimiento', (db, ctx) => runAnular(db, ctx, p.data))
  if (r.ok) { revalidatePath('/caja'); revalidatePath('/dashboard') }
  return r
}
