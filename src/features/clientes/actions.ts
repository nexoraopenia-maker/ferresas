'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import {
  bajaClienteSchema, crearClienteSchema, editarClienteSchema, fichaClienteSchema, listarClientesSchema, reactivarClienteSchema,
} from './schemas'
import {
  crearCliente as runCrear, darDeBajaCliente as runBaja, editarCliente as runEditar, listarClientes as runListar,
  obtenerFichaCliente as runFicha, reactivarCliente as runReactivar, type FichaCliente, type PaginaClientes,
} from './service'

/**
 * Server Actions de clientes. Mismo guion de siempre: sesión en el servidor, Zod antes de la base, el servicio decide permisos y
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
    console.error('[clientes] fallo inesperado', { accion, tenantId: ctx?.tenantId ?? null, error: e instanceof Error ? { name: e.name, message: e.message } : e })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos completar la operación. Intenta de nuevo.' }
  }
}

export async function crearCliente(raw: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const p = crearClienteSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('crearCliente', (db, ctx) => runCrear(db, ctx, p.data))
  if (r.ok) revalidatePath('/clientes')
  return r
}

export async function editarCliente(raw: unknown): Promise<ActionResult<{ id: string; cambios: string[] }>> {
  const p = editarClienteSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('editarCliente', (db, ctx) => runEditar(db, ctx, p.data))
  if (r.ok) { revalidatePath('/clientes'); revalidatePath(`/clientes/${p.data.customerId}`) }
  return r
}

export async function darDeBajaCliente(raw: unknown): Promise<ActionResult<{ id: string }>> {
  const p = bajaClienteSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('darDeBajaCliente', (db, ctx) => runBaja(db, ctx, p.data))
  if (r.ok) revalidatePath('/clientes')
  return r
}

export async function reactivarCliente(raw: unknown): Promise<ActionResult<{ id: string }>> {
  const p = reactivarClienteSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('reactivarCliente', (db, ctx) => runReactivar(db, ctx, p.data))
  if (r.ok) revalidatePath('/clientes')
  return r
}

export async function listarClientes(raw: unknown): Promise<ActionResult<PaginaClientes>> {
  const p = listarClientesSchema.safeParse(raw ?? {})
  if (!p.success) return invalida(p.error)
  return conTenant('listarClientes', (db, ctx) => runListar(db, ctx, p.data))
}

export async function fichaCliente(raw: unknown): Promise<ActionResult<FichaCliente>> {
  const p = fichaClienteSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  return conTenant('fichaCliente', (db, ctx) => runFicha(db, ctx, p.data.customerId))
}
