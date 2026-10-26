'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import {
  bajaProveedorSchema, crearProveedorSchema, editarProveedorSchema, fichaProveedorSchema, listarProveedoresSchema, reactivarProveedorSchema,
} from './schemas'
import {
  crearProveedor as runCrear, darDeBajaProveedor as runBaja, editarProveedor as runEditar, listarProveedores as runListar,
  obtenerFichaProveedor as runFicha, reactivarProveedor as runReactivar, type FichaProveedor, type PaginaProveedores,
} from './service'

/**
 * Server Actions de proveedores. Mismo guion de siempre: sesión en el servidor, Zod antes de la base, el servicio decide permisos y
 * resultado tipado hacia la pantalla. La autorización NO está aquí: está en el servicio.
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
    console.error('[proveedores] fallo inesperado', { accion, tenantId: ctx?.tenantId ?? null, error: e instanceof Error ? { name: e.name, message: e.message } : e })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos completar la operación. Intenta de nuevo.' }
  }
}

export async function crearProveedor(raw: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const p = crearProveedorSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('crearProveedor', (db, ctx) => runCrear(db, ctx, p.data))
  if (r.ok) revalidatePath('/proveedores')
  return r
}

export async function editarProveedor(raw: unknown): Promise<ActionResult<{ id: string; cambios: string[] }>> {
  const p = editarProveedorSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('editarProveedor', (db, ctx) => runEditar(db, ctx, p.data))
  if (r.ok) { revalidatePath('/proveedores'); revalidatePath(`/proveedores/${p.data.supplierId}`) }
  return r
}

export async function darDeBajaProveedor(raw: unknown): Promise<ActionResult<{ id: string }>> {
  const p = bajaProveedorSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('darDeBajaProveedor', (db, ctx) => runBaja(db, ctx, p.data))
  if (r.ok) revalidatePath('/proveedores')
  return r
}

export async function reactivarProveedor(raw: unknown): Promise<ActionResult<{ id: string }>> {
  const p = reactivarProveedorSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('reactivarProveedor', (db, ctx) => runReactivar(db, ctx, p.data))
  if (r.ok) revalidatePath('/proveedores')
  return r
}

export async function listarProveedores(raw: unknown): Promise<ActionResult<PaginaProveedores>> {
  const p = listarProveedoresSchema.safeParse(raw ?? {})
  if (!p.success) return invalida(p.error)
  return conTenant('listarProveedores', (db, ctx) => runListar(db, ctx, p.data))
}

export async function fichaProveedor(raw: unknown): Promise<ActionResult<FichaProveedor>> {
  const p = fichaProveedorSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  return conTenant('fichaProveedor', (db, ctx) => runFicha(db, ctx, p.data.supplierId))
}
