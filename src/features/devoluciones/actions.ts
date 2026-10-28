'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { anularOdevolverVentaSchema } from './schemas'
import { anularOdevolverVenta as runAnular, type ResultadoDevolucion } from './service'

/**
 * Server Action de anular / devolver una venta. Sesión en el servidor, Zod antes de la base, el servicio decide el permiso (`ventas.anular`)
 * y devuelve un resultado tipado a la pantalla. La autorización NO está aquí: está en el servicio.
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
    console.error('[devoluciones] fallo inesperado', { accion, tenantId: ctx?.tenantId ?? null, error: e instanceof Error ? { name: e.name, message: e.message } : e })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos completar la operación. Intenta de nuevo.' }
  }
}

export async function anularOdevolverVenta(raw: unknown): Promise<ActionResult<ResultadoDevolucion>> {
  const p = anularOdevolverVentaSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('anularOdevolverVenta', (db, ctx) => runAnular(db, ctx, p.data))
  if (r.ok) {
    revalidatePath('/ventas')
    revalidatePath(`/ventas/${p.data.saleId}`)
    revalidatePath('/caja')
    revalidatePath('/inventario')
    revalidatePath('/reportes', 'layout')
    revalidatePath('/comprobantes')
    revalidatePath('/cobranza')
  }
  return r
}
