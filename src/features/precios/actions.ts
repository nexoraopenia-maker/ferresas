'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import { asignarListaClienteSchema, crearListaSchema, darDeBajaListaSchema, editarListaSchema, guardarPreciosSchema } from './schemas'
import { asignarListaACliente, crearLista, darDeBajaLista, editarLista, guardarPrecios } from './service'

/**
 * Server Actions de las listas de precio (F6.7c). Cada una resuelve la sesión en el SERVIDOR, valida con Zod ANTES de tocar la base y deja que el SERVICIO decida el permiso
 * (`precios.gestionar`, fuera del PIN). Nunca lanzan hacia el navegador: devuelven un resultado tipado. Solo revalidan si salió bien.
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
    console.error('[precios] fallo inesperado', { accion, tenantId: ctx?.tenantId ?? null, error: e instanceof Error ? { name: e.name, message: e.message } : e })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos completar la operación. Intenta de nuevo.' }
  }
}

const refrescar = () => { revalidatePath('/precios'); revalidatePath('/pos') }

export async function crearListaAccion(raw: unknown) {
  const p = crearListaSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('crearLista', (db, ctx) => crearLista(db, ctx, p.data))
  if (r.ok) refrescar()
  return r
}

export async function editarListaAccion(raw: unknown) {
  const p = editarListaSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('editarLista', (db, ctx) => editarLista(db, ctx, p.data))
  if (r.ok) refrescar()
  return r
}

export async function darDeBajaListaAccion(raw: unknown) {
  const p = darDeBajaListaSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('darDeBajaLista', (db, ctx) => darDeBajaLista(db, ctx, p.data))
  if (r.ok) refrescar()
  return r
}

export async function guardarPreciosAccion(raw: unknown) {
  const p = guardarPreciosSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('guardarPrecios', (db, ctx) => guardarPrecios(db, ctx, p.data))
  if (r.ok) refrescar()
  return r
}

export async function asignarListaClienteAccion(raw: unknown) {
  const p = asignarListaClienteSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('asignarListaCliente', (db, ctx) => asignarListaACliente(db, ctx, p.data))
  if (r.ok) { revalidatePath(`/clientes/${r.data.customerId}`); revalidatePath('/precios') }
  return r
}
