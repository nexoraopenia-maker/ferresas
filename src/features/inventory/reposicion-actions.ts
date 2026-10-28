'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import { aplicarUmbralesSchema, analizarUmbralesCsvSchema } from './umbrales-schemas'
import { analizarUmbralesCsv, aplicarUmbrales } from './umbrales-service'
import { borradorDesdeReposicionSchema, transferenciaDesdeReposicionSchema } from './reposicion-schemas'
import { crearBorradorDeCompraDesdeReposicion, solicitarTransferenciaDesdeReposicion } from './reposicion-acciones'

/**
 * Server Actions de los mínimos y máximos de reposición (F6.6b). Cada una resuelve la sesión en el SERVIDOR, valida con Zod ANTES de tocar la base y deja que el SERVICIO
 * decida el permiso (`reposicion.configurar`, fuera del PIN). Nunca lanzan hacia el navegador: devuelven un resultado tipado. Solo revalidan si salió bien.
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
    console.error('[reposicion] fallo inesperado', { accion, tenantId: ctx?.tenantId ?? null, error: e instanceof Error ? { name: e.name, message: e.message } : e })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos completar la operación. Intenta de nuevo.' }
  }
}

export async function guardarUmbralesAccion(raw: unknown) {
  const p = aplicarUmbralesSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('guardarUmbrales', (db, ctx) => aplicarUmbrales(db, ctx, p.data))
  if (r.ok) { revalidatePath('/inventario/reposicion'); revalidatePath('/inventario/reposicion/umbrales'); revalidatePath('/inventario/alertas'); revalidatePath('/panel') }
  return r
}

/** Solo lee y analiza: no escribe nada. */
export async function analizarUmbralesCsvAccion(raw: unknown) {
  const p = analizarUmbralesCsvSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  return conTenant('analizarUmbralesCsv', (db, ctx) => analizarUmbralesCsv(db, ctx, p.data.contenido))
}

/** Crea el borrador de compra de un proveedor (o sin proveedor) con lo que el reporte sugiere. Exige `compras.registrar` en el servicio. */
export async function crearBorradorDeCompraAccion(raw: unknown) {
  const p = borradorDesdeReposicionSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('crearBorradorDeCompra', (db, ctx) => crearBorradorDeCompraDesdeReposicion(db, ctx, p.data))
  if (r.ok) { revalidatePath('/compras'); revalidatePath('/inventario/reposicion') }
  return r
}

/** Pide a la sucursal con excedente lo que falta. Exige `stock.transferir_solicitar` en el servicio. */
export async function solicitarTransferenciaDesdeReposicionAccion(raw: unknown) {
  const p = transferenciaDesdeReposicionSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('solicitarTransferenciaDesdeReposicion', (db, ctx) => solicitarTransferenciaDesdeReposicion(db, ctx, p.data))
  if (r.ok) { revalidatePath('/transferencias'); revalidatePath('/inventario/reposicion') }
  return r
}
