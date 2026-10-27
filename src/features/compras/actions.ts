'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { anularCompraSchema, buscarProductoCompraSchema, completarDocumentoSchema, crearBorradorSchema, editarBorradorSchema, listarComprasSchema, recibirCompraSchema, verCompraSchema } from './schemas'
import {
  anularCompra as runAnular, completarDocumento as runCompletar, crearBorrador as runCrear, editarBorrador as runEditar, listarCompras as runListar,
  obtenerCompra as runObtener, recibirCompra as runRecibir, buscarProductosParaCompra as runBuscar,
  type PaginaCompras, type ProductoParaCompra, type ResultadoCompra, type ResultadoRecibir,
} from './service'

/**
 * Server Actions de compras. Sesión en el servidor, Zod antes de la base, el servicio decide permisos y resultado tipado hacia la
 * pantalla. La autorización NO está aquí: está en el servicio.
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
    console.error('[compras] fallo inesperado', { accion, tenantId: ctx?.tenantId ?? null, error: e instanceof Error ? { name: e.name, message: e.message } : e })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos completar la operación. Intenta de nuevo.' }
  }
}

function refrescar(id?: string) {
  revalidatePath('/compras')
  revalidatePath('/proveedores')
  revalidatePath('/inventario')
  if (id) revalidatePath(`/compras/${id}`)
}

export async function crearBorrador(raw: unknown): Promise<ActionResult<ResultadoCompra>> {
  const p = crearBorradorSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('crearBorrador', (db, ctx) => runCrear(db, ctx, p.data))
  if (r.ok) refrescar()
  return r
}

export async function editarBorrador(raw: unknown): Promise<ActionResult<{ id: string }>> {
  const p = editarBorradorSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('editarBorrador', (db, ctx) => runEditar(db, ctx, p.data))
  if (r.ok) refrescar(p.data.purchaseId)
  return r
}

export async function recibirCompra(raw: unknown): Promise<ActionResult<ResultadoRecibir>> {
  const p = recibirCompraSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('recibirCompra', (db, ctx) => runRecibir(db, ctx, p.data))
  if (r.ok) refrescar(p.data.purchaseId)
  return r
}

export async function completarDocumento(raw: unknown): Promise<ActionResult<{ id: string; invoiceRef: string }>> {
  const p = completarDocumentoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('completarDocumento', (db, ctx) => runCompletar(db, ctx, p.data))
  if (r.ok) refrescar(p.data.purchaseId)
  return r
}

export async function anularCompra(raw: unknown): Promise<ActionResult<{ id: string; replayed: boolean }>> {
  const p = anularCompraSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('anularCompra', (db, ctx) => runAnular(db, ctx, p.data))
  if (r.ok) refrescar(p.data.purchaseId)
  return r
}

export async function listarCompras(raw: unknown): Promise<ActionResult<PaginaCompras>> {
  const p = listarComprasSchema.safeParse(raw ?? {})
  if (!p.success) return invalida(p.error)
  return conTenant('listarCompras', (db, ctx) => runListar(db, ctx, p.data))
}

export async function verCompra(raw: unknown): Promise<ActionResult<Awaited<ReturnType<typeof runObtener>>>> {
  const p = verCompraSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  return conTenant('verCompra', (db, ctx) => runObtener(db, ctx, p.data.purchaseId))
}

export async function buscarProductosCompra(raw: unknown): Promise<ActionResult<ProductoParaCompra[]>> {
  const p = buscarProductoCompraSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  return conTenant('buscarProductosCompra', (db, ctx) => runBuscar(db, ctx, p.data.texto))
}
