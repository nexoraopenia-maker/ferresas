import { BusinessError } from '@/lib/errors'
import { redondearCentimos } from '@/lib/dinero'
import { diaLocal, periodos, type Rango } from '@/lib/periodos'
import { exigir, puede } from '@/lib/puede'
import { posicionesDeStock } from '@/features/inventory/reposicion-service'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'

const num = (v: unknown) => Number(v ?? 0)

export interface TotalPeriodo {
  total: number
  ventas: number
  ticketPromedio: number
}

export interface VentasDelDia { dia: string; total: number }

export interface ProductoTop { productId: string; nombre: string; cantidad: number; total: number }

export interface ResumenVentas {
  zona: string
  hoy: TotalPeriodo
  semana: TotalPeriodo
  mes: TotalPeriodo
  /** Ventas de los últimos 7 días (hoy incluido), del más antiguo al más reciente. */
  ultimos7: VentasDelDia[]
  topProductos: ProductoTop[]
}

async function totalDe(db: TenantPrismaClient, r: Rango): Promise<TotalPeriodo> {
  const a = await db.sale.aggregate({
    where: { status: 'COMPLETADA', completedAt: { gte: r.desde, lt: r.hasta } },
    _sum: { total: true },
    _count: { _all: true },
  })
  // Lo devuelto en parcial (F6.2) resta en el periodo de la VENTA, igual que en /reportes/ventas.
  const dev = await db.saleReturn.aggregate({ where: { sale: { status: 'COMPLETADA', completedAt: { gte: r.desde, lt: r.hasta } } }, _sum: { returnTotal: true } })
  const total = redondearCentimos(num(a._sum.total) - num(dev._sum.returnTotal))
  const ventas = a._count._all
  return { total, ventas, ticketPromedio: ventas > 0 ? redondearCentimos(total / ventas) : 0 }
}

/**
 * Resumen gerencial de ventas.
 *
 * Es dinero del negocio, así que exige `reportes.ver`. NO devuelve costos ni
 * márgenes: el margen revela el costo, y ese lo gobierna `productos.ver_costo`.
 * El acotado por sucursal lo hace el cliente aislado (`ctx.branchIds`), también
 * para las líneas de venta del ranking de productos.
 */
export async function resumenDeVentas(
  db: TenantPrismaClient,
  ctx: TenantContext,
  ahora: Date = new Date(),
): Promise<ResumenVentas> {
  exigir(ctx, 'reportes.ver')

  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const zona = tenant.timezone
  const p = periodos(ahora, zona)

  const [hoy, semana, mes, ventas7, top, devueltas7] = await Promise.all([
    totalDe(db, p.hoy),
    totalDe(db, p.semana),
    totalDe(db, p.mes),
    db.sale.findMany({
      where: { status: 'COMPLETADA', completedAt: { gte: p.ultimos7.desde, lt: p.ultimos7.hasta } },
      select: { completedAt: true, total: true },
      take: 20_000,
    }),
    db.saleItem.groupBy({
      by: ['productId', 'nameSnapshot'],
      where: { sale: { status: 'COMPLETADA', completedAt: { gte: p.mes.desde, lt: p.mes.hasta } } },
      _sum: { quantity: true, lineTotal: true, returnedQuantity: true, returnedAmount: true },
    }),
    db.saleReturn.findMany({
      where: { sale: { status: 'COMPLETADA', completedAt: { gte: p.ultimos7.desde, lt: p.ultimos7.hasta } } },
      select: { returnTotal: true, sale: { select: { completedAt: true } } },
      take: 20_000,
    }),
  ])

  const porDia = new Map(p.dias7.map((d) => [d, 0]))
  for (const v of ventas7) {
    if (!v.completedAt) continue
    const d = diaLocal(zona, v.completedAt)
    if (porDia.has(d)) porDia.set(d, (porDia.get(d) ?? 0) + num(v.total))
  }

  for (const d of devueltas7) {
    if (!d.sale.completedAt) continue
    const dia = diaLocal(zona, d.sale.completedAt)
    if (porDia.has(dia)) porDia.set(dia, (porDia.get(dia) ?? 0) - num(d.returnTotal))
  }

  // Ranking NETO de lo devuelto (importe y unidades de cada producto). Se ordena aquí porque la base no ordena por una resta.
  const netos = top.map((t) => ({
    productId: t.productId,
    nombre: t.nameSnapshot,
    cantidad: Math.round((num(t._sum.quantity) - num(t._sum.returnedQuantity)) * 10_000) / 10_000,
    total: redondearCentimos(num(t._sum.lineTotal) - num(t._sum.returnedAmount)),
  })).sort((x, y) => y.total - x.total || (x.nombre < y.nombre ? -1 : x.nombre > y.nombre ? 1 : x.productId < y.productId ? -1 : 1))

  return {
    zona,
    hoy, semana, mes,
    ultimos7: p.dias7.map((dia) => ({ dia, total: redondearCentimos(porDia.get(dia) ?? 0) })),
    topProductos: netos.slice(0, 5),
  }
}

export interface TurnoResumen {
  id: string
  sucursal: string
  abiertoPor: string
  abiertaEn: Date
  estado: 'ABIERTA' | 'CERRADA'
  montoInicial: number
  /** Ventas del turno hasta ahora (efectivo y demás medios). */
  ventas: number
  /** Solo en turnos cerrados: contado − esperado. Negativo = faltante. */
  diferencia: number | null
  /** Congelados al cerrar (0 mientras el turno está abierto): lo fiado no entró al cajón; los abonos de deuda sí o no, según el medio. */
  fiado: number
  abonosEfectivo: number
  abonosOtros: number
}

export interface RendimientoCaja {
  abiertos: TurnoResumen[]
  cerradosHoy: TurnoResumen[]
  /** Suma de las diferencias de los turnos cerrados hoy. */
  descuadreHoy: number
}

/** Cajas abiertas ahora y arqueos de hoy. Para quien puede ver reportes o arquear. */
export async function rendimientoDeCaja(
  db: TenantPrismaClient,
  ctx: TenantContext,
  ahora: Date = new Date(),
): Promise<RendimientoCaja> {
  if (!puede(ctx, 'reportes.ver') && !puede(ctx, 'caja.arqueo')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver el rendimiento de caja.')
  }
  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const { hoy } = periodos(ahora, tenant.timezone)

  const filas = await db.cashSession.findMany({
    where: { OR: [{ status: 'ABIERTA' }, { openedAt: { gte: hoy.desde, lt: hoy.hasta } }] },
    orderBy: { openedAt: 'desc' },
    take: 60,
    select: {
      id: true, status: true, openedAt: true, openingAmount: true, salesTotal: true, difference: true,
      creditSalesTotal: true, cashReceiptsTotal: true, otherReceiptsTotal: true,
      branch: { select: { name: true } },
      openedBy: { select: { name: true } },
    },
  })
  const aTurno = (f: (typeof filas)[number]): TurnoResumen => ({
    id: f.id,
    sucursal: f.branch.name,
    abiertoPor: f.openedBy.name,
    abiertaEn: f.openedAt,
    estado: f.status === 'ABIERTA' ? 'ABIERTA' : 'CERRADA',
    montoInicial: num(f.openingAmount),
    ventas: num(f.salesTotal),
    diferencia: f.difference === null ? null : num(f.difference),
    fiado: num(f.creditSalesTotal),
    abonosEfectivo: num(f.cashReceiptsTotal),
    abonosOtros: num(f.otherReceiptsTotal),
  })
  const abiertos = filas.filter((f) => f.status === 'ABIERTA').map(aTurno)
  const cerradosHoy = filas
    .filter((f) => f.status !== 'ABIERTA' && f.openedAt >= hoy.desde)
    .map(aTurno)
  return {
    abiertos, cerradosHoy,
    descuadreHoy: redondearCentimos(cerradosHoy.reduce((s, t) => s + (t.diferencia ?? 0), 0)),
  }
}

export interface AlertaStock {
  /** Identifica la fila (almacén × producto × variante): un producto puede alertar en dos almacenes a la vez. */
  clave: string
  productId: string
  variantId: string | null
  /** `null` solo para un producto que nunca tuvo existencias en un almacén alcanzable. */
  warehouseId: string | null
  almacen: string | null
  nombre: string
  sku: string
  unitType: string
  /** Lo DISPONIBLE (cantidad − reservado): lo que el semáforo juzgó. */
  stock: number
  minimo: number
  /** Lo que ya viene en camino por transferencias. */
  enTransito: number
  estado: 'OUT' | 'LOW'
}

export interface ResumenAlertas {
  agotados: number
  criticos: number
  /** Los más urgentes primero: agotados, luego los más cerca de cero respecto a su mínimo. */
  items: AlertaStock[]
}

/**
 * Filas de stock agotadas o en su mínimo.
 *
 * Usa el criterio ÚNICO de reposición (`posicionesDeStock` + `evaluarReposicion`): el mismo semáforo que enseñan el escáner y el POS, por almacén y con la
 * herencia de umbrales. El saldo de un local ajeno ya no tapa un faltante en otro. No pide un permiso aparte: es el mismo dato que el POS enseña al vender,
 * y no incluye costos.
 */
export async function alertasDeStock(
  db: TenantPrismaClient,
  ctx: TenantContext,
  limite = 8,
): Promise<ResumenAlertas> {
  const posiciones = await posicionesDeStock(db, ctx)

  const alertas: AlertaStock[] = []
  for (const p of posiciones) {
    if (p.estado === 'OK') continue
    alertas.push({
      clave: `${p.warehouseId ?? '-'}:${p.productId}:${p.variantId ?? '-'}`,
      productId: p.productId, variantId: p.variantId, warehouseId: p.warehouseId, almacen: p.almacen,
      nombre: p.nombre, sku: p.sku, unitType: p.unitType,
      stock: p.disponible, minimo: p.minimo, enTransito: p.enTransito, estado: p.estado,
    })
  }
  alertas.sort((a, b) =>
    (a.estado === b.estado ? 0 : a.estado === 'OUT' ? -1 : 1) ||
    (a.stock / (a.minimo || 1)) - (b.stock / (b.minimo || 1)) ||
    a.nombre.localeCompare(b.nombre) || (a.almacen ?? '').localeCompare(b.almacen ?? ''))

  return {
    agotados: alertas.filter((a) => a.estado === 'OUT').length,
    criticos: alertas.filter((a) => a.estado === 'LOW').length,
    items: alertas.slice(0, limite),
  }
}
