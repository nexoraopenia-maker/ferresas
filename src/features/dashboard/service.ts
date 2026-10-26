import { BusinessError } from '@/lib/errors'
import { redondearCentimos } from '@/lib/dinero'
import { diaLocal, periodos, type Rango } from '@/lib/periodos'
import { exigir, puede } from '@/lib/puede'
import { getStockStatus } from '@/lib/stock-status'
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
  const total = redondearCentimos(num(a._sum.total))
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

  const [hoy, semana, mes, ventas7, top] = await Promise.all([
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
      _sum: { quantity: true, lineTotal: true },
      orderBy: { _sum: { lineTotal: 'desc' } },
      take: 5,
    }),
  ])

  const porDia = new Map(p.dias7.map((d) => [d, 0]))
  for (const v of ventas7) {
    if (!v.completedAt) continue
    const d = diaLocal(zona, v.completedAt)
    if (porDia.has(d)) porDia.set(d, (porDia.get(d) ?? 0) + num(v.total))
  }

  return {
    zona,
    hoy, semana, mes,
    ultimos7: p.dias7.map((dia) => ({ dia, total: redondearCentimos(porDia.get(dia) ?? 0) })),
    topProductos: top.map((t) => ({
      productId: t.productId,
      nombre: t.nameSnapshot,
      cantidad: num(t._sum.quantity),
      total: redondearCentimos(num(t._sum.lineTotal)),
    })),
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
  productId: string
  nombre: string
  sku: string
  unitType: string
  stock: number
  minimo: number
  estado: 'OUT' | 'LOW'
}

export interface ResumenAlertas {
  agotados: number
  criticos: number
  /** Los más urgentes primero: agotados, luego los más cerca de cero respecto a su mínimo. */
  items: AlertaStock[]
}

/**
 * Productos agotados o en su mínimo.
 *
 * Suma el stock de los almacenes de las sucursales que el usuario alcanza
 * (`ctx.branchIds`): el saldo de un local ajeno no tapa un faltante en el
 * propio. No pide un permiso aparte: es el mismo dato que el POS enseña al
 * vender, y no incluye costos.
 */
export async function alertasDeStock(
  db: TenantPrismaClient,
  ctx: TenantContext,
  limite = 8,
): Promise<ResumenAlertas> {
  const [productos, saldos] = await Promise.all([
    db.product.findMany({
      where: { deletedAt: null, isActive: true, trackStock: true },
      select: { id: true, name: true, sku: true, unitType: true, minStock: true },
    }),
    db.stock.groupBy({
      by: ['productId'],
      where: ctx.branchIds ? { warehouse: { branchId: { in: [...ctx.branchIds] } } } : {},
      _sum: { quantity: true },
    }),
  ])
  const saldo = new Map(saldos.map((s) => [s.productId, num(s._sum.quantity)]))

  const alertas: AlertaStock[] = []
  for (const p of productos) {
    const stock = saldo.get(p.id) ?? 0
    const minimo = num(p.minStock)
    const estado = getStockStatus(stock, minimo)
    // Un mínimo en 0 significa «sin umbral»: solo importa si se agotó del todo.
    if (estado === 'OK' || (estado === 'LOW' && minimo <= 0)) continue
    alertas.push({
      productId: p.id, nombre: p.name, sku: p.sku, unitType: p.unitType,
      stock, minimo, estado,
    })
  }
  alertas.sort((a, b) =>
    (a.estado === b.estado ? 0 : a.estado === 'OUT' ? -1 : 1) ||
    (a.stock / (a.minimo || 1)) - (b.stock / (b.minimo || 1)) ||
    a.nombre.localeCompare(b.nombre))

  return {
    agotados: alertas.filter((a) => a.estado === 'OUT').length,
    criticos: alertas.filter((a) => a.estado === 'LOW').length,
    items: alertas.slice(0, limite),
  }
}
