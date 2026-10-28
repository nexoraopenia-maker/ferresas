import type { UnitType } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { mensajeAmbiguo, resolverCodigo } from './codigos'
import { invalido, noExiste, num } from './conteo-service'

/**
 * Lo que necesita la pantalla de CONTAR (F6.5c). Es la pantalla de quien cuenta, así que NUNCA devuelve lo que dice el sistema: ni el stock, ni su foto, ni el mínimo. Solo el
 * producto (para saber qué se está contando), sus presentaciones (cajas × factor) y las pasadas propias.
 */

export interface PresentacionOpcion { id: string; nombre: string; unidad: UnitType; factor: string }

export interface ProductoParaContar {
  productId: string
  variantId: string | null
  nombre: string
  sku: string
  unidad: UnitType
  /** Si lo que se leyó fue el código de una presentación (la caja), esa; si no, `null`. */
  presentacionLeida: PresentacionOpcion | null
  presentaciones: PresentacionOpcion[]
}

async function conteoParaContar(db: TenantPrismaClient, countId: string) {
  const c = await db.inventoryCount.findFirst({ where: { id: countId }, select: { id: true, number: true, status: true, warehouseId: true } })
  if (!c) throw noExiste()
  if (c.status !== 'EN_CONTEO' && c.status !== 'EN_REVISION') throw invalido(`La toma de inventario ${c.number} no está recibiendo conteos.`)
  return c
}

const PRESENTACION_SEL = { id: true, name: true, unitType: true, factor: true } as const
const aOpcion = (p: { id: string; name: string; unitType: UnitType; factor: { toString(): string } }): PresentacionOpcion => ({ id: p.id, nombre: p.name, unidad: p.unitType, factor: p.factor.toString() })

async function presentacionesDe(db: TenantPrismaClient, productId: string): Promise<PresentacionOpcion[]> {
  const filas = await db.productPresentation.findMany({ where: { productId, isActive: true, deletedAt: null }, select: PRESENTACION_SEL, orderBy: [{ factor: 'asc' }, { name: 'asc' }] })
  return filas.map(aOpcion)
}

/** Resuelve un código escaneado o tecleado (barras, QR, SKU, código de una caja) al producto que se va a contar. `null` si no existe. */
export async function resolverProductoParaContar(db: TenantPrismaClient, ctx: TenantContext, input: { countId: string; code: string }): Promise<ProductoParaContar | null> {
  exigir(ctx, 'conteo.registrar')
  const c = await conteoParaContar(db, input.countId)
  const r = await resolverCodigo(db, input.code, { almacenId: c.warehouseId })
  if (!r) return null
  if (r.estado === 'ambiguo') throw new BusinessError('DUPLICATE_CODE', mensajeAmbiguo(r))
  if (!r.producto.trackStock) throw new BusinessError('NOT_FOUND', `«${r.producto.name}» no lleva control de stock: no se cuenta.`)
  return {
    productId: r.producto.id, variantId: r.variante?.id ?? null, nombre: r.variante ? `${r.producto.name} · ${r.variante.name}` : r.producto.name, sku: r.variante?.sku ?? r.producto.sku,
    unidad: r.producto.unitType as UnitType, presentacionLeida: r.presentacion ? aOpcion({ id: r.presentacion.id, name: r.presentacion.name, unitType: r.presentacion.unitType as UnitType, factor: r.presentacion.factor }) : null,
    presentaciones: await presentacionesDe(db, r.producto.id),
  }
}

/** Productos que coinciden con lo tecleado (nombre, SKU o código de barras), para elegir uno a mano. Mínimo 2 letras; solo los que llevan control de stock. */
export async function buscarProductosParaContar(db: TenantPrismaClient, ctx: TenantContext, input: { countId: string; q: string }): Promise<ProductoParaContar[]> {
  exigir(ctx, 'conteo.registrar')
  await conteoParaContar(db, input.countId)
  const q = input.q.trim().slice(0, 80)
  if (q.length < 2) return []
  const filas = await db.product.findMany({
    where: { trackStock: true, deletedAt: null, OR: [{ name: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }, { barcode: { contains: q } }] },
    select: { id: true, name: true, sku: true, unitType: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 20,
  })
  return Promise.all(filas.map(async (p): Promise<ProductoParaContar> => ({ productId: p.id, variantId: null, nombre: p.name, sku: p.sku, unidad: p.unitType, presentacionLeida: null, presentaciones: await presentacionesDe(db, p.id) })))
}

export interface MiPasada {
  id: string
  producto: string
  sku: string
  cantidad: number
  presentacion: { nombre: string; cantidad: number } | null
  zona: string | null
  cuando: string
  anulada: boolean
  /** Todavía se puede anular: el conteo sigue en conteo y la pasada no está anulada. */
  puedeAnular: boolean
}

/** Las últimas pasadas de la propia persona en este conteo (las más recientes primero), para corregir un error al momento. */
export async function misPasadas(db: TenantPrismaClient, ctx: TenantContext, input: { countId: string; limite?: number }): Promise<MiPasada[]> {
  exigir(ctx, 'conteo.registrar')
  const c = await db.inventoryCount.findFirst({ where: { id: input.countId }, select: { id: true, status: true } })
  if (!c) throw noExiste()
  const filas = await db.inventoryCountEntry.findMany({
    where: { countId: c.id, userId: ctx.userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: Math.min(input.limite ?? 30, 100),
    select: { id: true, quantity: true, enteredQuantity: true, presentation: { select: { name: true } }, zone: true, createdAt: true, voidedAt: true, item: { select: { nameSnapshot: true, skuSnapshot: true } } },
  })
  return filas.map((f) => ({
    id: f.id, producto: f.item.nameSnapshot, sku: f.item.skuSnapshot, cantidad: num(f.quantity), zona: f.zone, cuando: f.createdAt.toISOString(), anulada: f.voidedAt !== null,
    presentacion: f.presentation && f.enteredQuantity !== null ? { nombre: f.presentation.name, cantidad: num(f.enteredQuantity) } : null,
    puedeAnular: c.status === 'EN_CONTEO' && f.voidedAt === null,
  }))
}

export interface ProductoParaSeleccion { id: string; nombre: string; sku: string }

/** Productos para armar una SELECCIÓN al crear un conteo (quien gestiona): nombre, SKU o código de barras; mínimo 2 letras; solo los que llevan control de stock. */
export async function buscarProductosParaSeleccion(db: TenantPrismaClient, ctx: TenantContext, q: string): Promise<ProductoParaSeleccion[]> {
  exigir(ctx, 'conteo.gestionar')
  const texto = q.trim().slice(0, 80)
  if (texto.length < 2) return []
  const filas = await db.product.findMany({
    where: { trackStock: true, deletedAt: null, OR: [{ name: { contains: texto, mode: 'insensitive' } }, { sku: { contains: texto, mode: 'insensitive' } }, { barcode: { contains: texto } }] },
    select: { id: true, name: true, sku: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 20,
  })
  return filas.map((p) => ({ id: p.id, nombre: p.name, sku: p.sku }))
}
