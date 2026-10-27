'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { anularPagoSchema, estadoCuentaProveedorSchema, previsualizarPagoSchema, registrarPagoSchema } from './schemas'
import {
  anularPagoProveedor as runAnular, previsualizarPago as runPrevisualizar, registrarPagoProveedor as runRegistrar,
  type PagoRegistrado, type VistaPreviaPago,
} from './pagos'
import {
  estadoDeCuentaProveedor as runEstado, exportarEstadoDeCuentaProveedorCsv as runCsvEstado, exportarPorPagarCsv as runCsvPorPagar,
  informeDePorPagar as runInforme, type ArchivoCsv, type EstadoDeCuentaProveedor, type InformePorPagar,
} from './informes'

/**
 * Server Actions de pagos a proveedores y cuentas por pagar. Sesión en el servidor, Zod antes de la base, el servicio decide permisos y
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
    console.error('[por-pagar] fallo inesperado', { accion, tenantId: ctx?.tenantId ?? null, error: e instanceof Error ? { name: e.name, message: e.message } : e })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos completar la operación. Intenta de nuevo.' }
  }
}

function refrescar(supplierId?: string) {
  revalidatePath('/por-pagar')
  revalidatePath('/proveedores')
  revalidatePath('/caja')
  revalidatePath('/')
  if (supplierId) revalidatePath(`/proveedores/${supplierId}`)
}

export async function registrarPagoProveedor(raw: unknown): Promise<ActionResult<PagoRegistrado>> {
  const p = registrarPagoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('registrarPagoProveedor', (db, ctx) => runRegistrar(db, ctx, p.data))
  if (r.ok) refrescar(p.data.supplierId)
  return r
}

export async function anularPagoProveedor(raw: unknown): Promise<ActionResult<{ paymentId: string; deudaDespues: number; replayed: boolean }>> {
  const p = anularPagoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('anularPagoProveedor', (db, ctx) => runAnular(db, ctx, p.data))
  if (r.ok) refrescar()
  return r
}

export async function previsualizarPagoProveedor(raw: unknown): Promise<ActionResult<VistaPreviaPago>> {
  const p = previsualizarPagoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  return conTenant('previsualizarPagoProveedor', (db, ctx) => runPrevisualizar(db, ctx, p.data))
}

export async function informePorPagar(): Promise<ActionResult<InformePorPagar>> {
  return conTenant('informePorPagar', (db, ctx) => runInforme(db, ctx))
}

export async function estadoDeCuentaDelProveedor(raw: unknown): Promise<ActionResult<EstadoDeCuentaProveedor>> {
  const p = estadoCuentaProveedorSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  return conTenant('estadoDeCuentaDelProveedor', (db, ctx) => runEstado(db, ctx, p.data))
}

export async function descargarPorPagarCsv(): Promise<ActionResult<ArchivoCsv>> {
  return conTenant('descargarPorPagarCsv', (db, ctx) => runCsvPorPagar(db, ctx))
}

export async function descargarEstadoCuentaProveedorCsv(raw: unknown): Promise<ActionResult<ArchivoCsv>> {
  const p = estadoCuentaProveedorSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  return conTenant('descargarEstadoCuentaProveedorCsv', (db, ctx) => runCsvEstado(db, ctx, p.data))
}
