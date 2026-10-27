import { BusinessError } from '@/lib/errors'
import { generarCsv } from '@/lib/csv-export'
import { diaLocal } from '@/lib/periodos'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { describirPeriodo, resolverPeriodo, type PeriodoElegido } from './periodo'
import {
  analisisAbc, inventarioValorizado, margenPorProducto,
  type FilaStock, type InventarioValorizado, type LineaVentaCosto, type Margenes, type ResultadoAbc,
} from './rentabilidad-calculo'
import { csvAbc, csvInventario, csvMargen } from './rentabilidad-csv'
import type { ParametrosCostos, TipoReporteCostos } from './schemas'
import type { ArchivoCsv } from './ventas-service'
import type { TablaCsv } from './ventas-csv'

/**
 * Margen por producto, valor del inventario y análisis ABC. SOLO LECTURA (salvo la línea de auditoría de cada descarga).
 *
 * Los tres revelan el costo del negocio, así que exigen `productos.ver_costo` —«Ver costos y márgenes»— y NADA MÁS: en este proyecto un
 * poder es un permiso nombrado, nunca la intersección de dos (los permisos de varios roles se unen y la intersección concede lo que nadie
 * quiso). Quien ve costos ve estos reportes; el menú los enseña a quien tenga cualquiera de los dos permisos, pero cada uno se guarda aquí.
 *
 * El acotado por sucursal: el cliente aislado acota las líneas de venta (por su venta). El STOCK y los almacenes no se acotan solos —una
 * transferencia obliga a mirar el almacén de otra sucursal—, así que el inventario se acota aquí a mano por las sucursales del usuario.
 */

const LOTE = 1000
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0)

function exigirCostos(ctx: TenantContext): void { exigir(ctx, 'productos.ver_costo') }

async function preparar(db: TenantPrismaClient, ctx: TenantContext, p: Pick<ParametrosCostos, 'p' | 'desde' | 'hasta'>, ahora: Date) {
  exigirCostos(ctx)
  const t = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  try {
    return { zona: t.timezone, periodo: resolverPeriodo({ preset: p.p, desde: p.desde, hasta: p.hasta }, ahora, t.timezone) }
  } catch (e) {
    if (e instanceof RangeError) throw new BusinessError('INVALID_DOCUMENT', e.message)
    throw e
  }
}

/** Las líneas de las ventas COMPLETADAS del periodo (por lotes), con el nombre ACTUAL del producto (el de la venta si ya no existe). */
async function leerLineas(db: TenantPrismaClient, periodo: Pick<PeriodoElegido, 'desde' | 'hasta'>): Promise<LineaVentaCosto[]> {
  const crudas: { productId: string; nombre: string; sku: string; unidad: string; cantidad: number; costoUnitario: number; totalConIgv: number; tasaIgv: number }[] = []
  let cursor: string | undefined
  for (;;) {
    const lote = await db.saleItem.findMany({
      where: { sale: { status: 'COMPLETADA', completedAt: { gte: periodo.desde, lt: periodo.hasta } } },
      orderBy: { id: 'asc' }, take: LOTE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, productId: true, nameSnapshot: true, skuSnapshot: true, unitType: true, quantity: true, unitCost: true, lineTotal: true, taxRate: true },
    })
    for (const l of lote) crudas.push({ productId: l.productId, nombre: l.nameSnapshot, sku: l.skuSnapshot, unidad: l.unitType, cantidad: num(l.quantity), costoUnitario: num(l.unitCost), totalConIgv: num(l.lineTotal), tasaIgv: num(l.taxRate) })
    if (lote.length < LOTE) break
    cursor = lote[lote.length - 1]!.id
  }
  const ids = [...new Set(crudas.map((l) => l.productId))]
  const actuales = new Map<string, { name: string; sku: string }>()
  for (let i = 0; i < ids.length; i += 500) {
    for (const p of await db.product.findMany({ where: { id: { in: ids.slice(i, i + 500) } }, select: { id: true, name: true, sku: true } })) actuales.set(p.id, { name: p.name, sku: p.sku })
  }
  return crudas.map((l) => ({ ...l, nombre: actuales.get(l.productId)?.name ?? l.nombre, sku: actuales.get(l.productId)?.sku ?? l.sku }))
}

export interface ReporteCostos<T> { periodo: PeriodoElegido; textoPeriodo: string; zona: string; datos: T }

export async function informeMargen(db: TenantPrismaClient, ctx: TenantContext, params: ParametrosCostos, ahora: Date = new Date()): Promise<ReporteCostos<Margenes>> {
  const prep = await preparar(db, ctx, params, ahora)
  return { ...prep, textoPeriodo: describirPeriodo(prep.periodo), datos: margenPorProducto(await leerLineas(db, prep.periodo)) }
}

export interface InformeInventario { fecha: string; datos: InventarioValorizado }

/** El inventario valorizado AL DÍA DE HOY (el costo es el promedio actual: no hay historia de costos). Solo las sucursales del usuario. */
export async function informeInventario(db: TenantPrismaClient, ctx: TenantContext, ahora: Date = new Date()): Promise<InformeInventario> {
  exigirCostos(ctx)
  const t = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const filas: FilaStock[] = []
  let cursor: string | undefined
  for (;;) {
    const lote = await db.stock.findMany({
      where: { product: { trackStock: true }, ...(ctx.branchIds ? { warehouse: { branchId: { in: [...ctx.branchIds] } } } : {}) },
      orderBy: { id: 'asc' }, take: LOTE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, productId: true, warehouseId: true, quantity: true,
        warehouse: { select: { name: true } },
        product: { select: { name: true, sku: true, unitType: true, costPrice: true, deletedAt: true } },
      },
    })
    for (const x of lote) {
      filas.push({
        productId: x.productId, nombre: x.product.name, sku: x.product.sku, unidad: x.product.unitType, eliminado: x.product.deletedAt !== null,
        almacenId: x.warehouseId, almacen: x.warehouse.name, cantidad: num(x.quantity), costoUnitario: num(x.product.costPrice),
      })
    }
    if (lote.length < LOTE) break
    cursor = lote[lote.length - 1]!.id
  }
  return { fecha: diaLocal(t.timezone, ahora), datos: inventarioValorizado(filas) }
}

export interface DatosAbc extends ResultadoAbc { base: 'VENTAS' | 'UTILIDAD'; sinClasificar: number; cobertura: number }

/**
 * ABC por venta neta (todos los productos vendidos) o por utilidad (solo los que tienen costo: los demás no se pueden clasificar y se
 * cuentan aparte, no se mandan a «C» como si fueran poco rentables).
 */
export async function informeAbc(db: TenantPrismaClient, ctx: TenantContext, params: ParametrosCostos, ahora: Date = new Date()): Promise<ReporteCostos<DatosAbc>> {
  const prep = await preparar(db, ctx, params, ahora)
  const m = margenPorProducto(await leerLineas(db, prep.periodo))
  const elegibles = params.base === 'VENTAS' ? m.filas : m.filas.filter((f) => f.ventaConCosto > 0)
  const items = elegibles.map((f) => ({ id: f.productId, nombre: f.nombre, sku: f.sku, valor: params.base === 'VENTAS' ? f.ventaSinIgv : f.utilidad }))
  let r: ResultadoAbc
  try {
    r = analisisAbc(items, { a: params.a, b: params.b })
  } catch (e) {
    if (e instanceof RangeError) throw new BusinessError('INVALID_DOCUMENT', e.message)
    throw e
  }
  return { ...prep, textoPeriodo: describirPeriodo(prep.periodo), datos: { ...r, base: params.base, sinClasificar: m.filas.length - elegibles.length, cobertura: m.totales.cobertura } }
}

// ─── Descargas CSV ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Descarga un reporte de costos en CSV. Queda en la auditoría quién lo bajó (un reporte con costos es información sensible). */
export async function exportarCostosCsv(db: TenantPrismaClient, ctx: TenantContext, tipo: TipoReporteCostos, params: ParametrosCostos, ahora: Date = new Date()): Promise<ArchivoCsv> {
  let tabla: TablaCsv
  let nombre: string
  let detalle: Record<string, unknown>
  switch (tipo) {
    case 'margen': { const r = await informeMargen(db, ctx, params, ahora); tabla = csvMargen(r.datos); nombre = `margen-${r.periodo.desdeDia}_${r.periodo.hastaDia}.csv`; detalle = { desde: r.periodo.desdeDia, hasta: r.periodo.hastaDia, cobertura: r.datos.totales.cobertura }; break }
    case 'inventario': { const r = await informeInventario(db, ctx, ahora); tabla = csvInventario(r.datos); nombre = `inventario-valorizado-${r.fecha}.csv`; detalle = { al: r.fecha }; break }
    case 'abc': { const r = await informeAbc(db, ctx, params, ahora); tabla = csvAbc(r.datos, params.base); nombre = `abc-${params.base.toLowerCase()}-${r.periodo.desdeDia}_${r.periodo.hastaDia}.csv`; detalle = { desde: r.periodo.desdeDia, hasta: r.periodo.hastaDia, base: params.base, a: params.a, b: params.b }; break }
  }
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'reporte.exportado', entityType: 'Reporte', entityId: `rentabilidad-${tipo}`,
      after: { reporte: `rentabilidad-${tipo}`, ...detalle, filas: tabla.filas.length - 1 } as never, impersonationId: ctx.impersonationId ?? null,
    },
  })
  return { nombre, contenido: generarCsv(tabla.cabecera, tabla.filas), filas: tabla.filas.length - 1 }
}
