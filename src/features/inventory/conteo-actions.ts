'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import {
  anularPasadaSchema, aplicarConteoSchema, aprobarLineaSchema, aprobarSinAlertaSchema, buscarProductosConteoSchema, cancelarConteoSchema, cerrarConteoSchema, crearConteoSchema,
  buscarProductosSeleccionSchema, iniciarConteoSchema, misPasadasSchema, recontarLineaSchema, rechazarLineaSchema, registrarPasadaSchema, resolverProductoConteoSchema,
} from './conteo-schemas'
import { anularPasada, cancelarConteo, cerrarConteo, crearConteo, iniciarConteo, registrarPasada } from './conteo-service'
import { aplicarConteo, aprobarLinea, aprobarLineasSinAlerta, rechazarLinea, solicitarRecuento } from './conteo-revision'
import { buscarProductosParaContar, buscarProductosParaSeleccion, misPasadas, resolverProductoParaContar } from './conteo-captura'

/**
 * Server Actions de la toma de inventario (F6.5c). Una Server Action es un endpoint HTTP: cualquiera puede invocarla a mano. Por eso cada una resuelve la sesión en el
 * SERVIDOR, valida con Zod ANTES de tocar la base y deja que el SERVICIO decida los permisos (`conteo.registrar`, `conteo.gestionar`, `stock.ajustar`, el PIN de operador).
 * Nunca lanzan hacia el navegador: devuelven un resultado tipado. Solo revalidan las pantallas si la operación salió bien.
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
    console.error('[conteo] fallo inesperado', { accion, tenantId: ctx?.tenantId ?? null, error: e instanceof Error ? { name: e.name, message: e.message } : e })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos completar la operación. Intenta de nuevo.' }
  }
}

const LISTA = '/inventario/conteos'
const refrescar = (countId?: string) => { revalidatePath(LISTA); if (countId) revalidatePath(`${LISTA}/${countId}`) }

export async function crearConteoAccion(raw: unknown) {
  const p = crearConteoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('crearConteo', (db, ctx) => crearConteo(db, ctx, p.data))
  if (r.ok) refrescar()
  return r
}
export async function iniciarConteoAccion(raw: unknown) {
  const p = iniciarConteoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('iniciarConteo', (db, ctx) => iniciarConteo(db, ctx, p.data))
  if (r.ok) refrescar(p.data.countId)
  return r
}
export async function cerrarConteoAccion(raw: unknown) {
  const p = cerrarConteoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('cerrarConteo', (db, ctx) => cerrarConteo(db, ctx, p.data))
  if (r.ok) refrescar(p.data.countId)
  return r
}
export async function cancelarConteoAccion(raw: unknown) {
  const p = cancelarConteoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('cancelarConteo', (db, ctx) => cancelarConteo(db, ctx, p.data))
  if (r.ok) refrescar(p.data.countId)
  return r
}
export async function registrarPasadaAccion(raw: unknown) {
  const p = registrarPasadaSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('registrarPasada', (db, ctx) => registrarPasada(db, ctx, p.data))
  if (r.ok) refrescar(p.data.countId)
  return r
}
export async function anularPasadaAccion(raw: unknown) {
  const p = anularPasadaSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('anularPasada', (db, ctx) => anularPasada(db, ctx, p.data))
  if (r.ok) refrescar()
  return r
}
export async function resolverProductoAccion(raw: unknown) {
  const p = resolverProductoConteoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  return conTenant('resolverProducto', (db, ctx) => resolverProductoParaContar(db, ctx, p.data))
}
export async function buscarProductosAccion(raw: unknown) {
  const p = buscarProductosConteoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  return conTenant('buscarProductos', (db, ctx) => buscarProductosParaContar(db, ctx, p.data))
}
export async function buscarProductosSeleccionAccion(raw: unknown) {
  const p = buscarProductosSeleccionSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  return conTenant('buscarProductosSeleccion', (db, ctx) => buscarProductosParaSeleccion(db, ctx, p.data.q))
}
export async function misPasadasAccion(raw: unknown) {
  const p = misPasadasSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  return conTenant('misPasadas', (db, ctx) => misPasadas(db, ctx, p.data))
}

// ─── Revisión y aplicación ──────────────────────────────────────────────────────────────────────────────────────────

export async function solicitarRecuentoAccion(raw: unknown) {
  const p = recontarLineaSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('solicitarRecuento', (db, ctx) => solicitarRecuento(db, ctx, p.data))
  if (r.ok) refrescar(p.data.countId)
  return r
}
export async function aprobarLineaAccion(raw: unknown) {
  const p = aprobarLineaSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('aprobarLinea', (db, ctx) => aprobarLinea(db, ctx, p.data))
  if (r.ok) refrescar(p.data.countId)
  return r
}
export async function rechazarLineaAccion(raw: unknown) {
  const p = rechazarLineaSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('rechazarLinea', (db, ctx) => rechazarLinea(db, ctx, p.data))
  if (r.ok) refrescar(p.data.countId)
  return r
}
export async function aprobarSinAlertasAccion(raw: unknown) {
  const p = aprobarSinAlertaSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('aprobarSinAlertas', (db, ctx) => aprobarLineasSinAlerta(db, ctx, p.data))
  if (r.ok) refrescar(p.data.countId)
  return r
}
export async function aplicarConteoAccion(raw: unknown) {
  const p = aplicarConteoSchema.safeParse(raw)
  if (!p.success) return invalida(p.error)
  const r = await conTenant('aplicarConteo', (db, ctx) => aplicarConteo(db, ctx, p.data))
  if (r.ok) {
    refrescar(p.data.countId)
    // Aplicar cambia el stock: se refrescan las pantallas que lo muestran.
    revalidatePath('/inventario'); revalidatePath('/inventario/kardex'); revalidatePath('/inventario/alertas'); revalidatePath('/dashboard'); revalidatePath('/panel')
  }
  return r
}
