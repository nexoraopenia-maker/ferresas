import { BusinessError } from '@/lib/errors'
import { generarCsv } from '@/lib/csv-export'
import { exigir } from '@/lib/puede'
import { leerDevolucionesDeVentas, pagosTrasDevoluciones } from '@/features/devoluciones/neto'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { describirPeriodo, granularidadAuto, gruposDelPeriodo, resolverPeriodo, type Granularidad, type PeriodoElegido } from './periodo'
import type { ParametrosVentas, TipoReporteVentas } from './schemas'
import {
  cobrosPorMedio, ventasPorMedio, ventasPorPeriodo, ventasPorVendedor,
  type CobrosPorMedio, type VentaFila, type VentasPorMedio, type VentasPorPeriodo, type VentasPorVendedor,
} from './ventas-calculo'
import { csvCobros, csvVentasPorMedio, csvVentasPorPeriodo, csvVentasPorVendedor, type TablaCsv } from './ventas-csv'

/**
 * Reportes de ventas: LEEN, no escriben (salvo la línea de auditoría de cada descarga). Solo `reportes.ver`: es dinero del negocio.
 * Ninguno devuelve costos ni márgenes —eso es de `productos.ver_costo` y de otro reporte—. El acotado por sucursal lo hace el cliente
 * aislado (`ctx.branchIds`) para ventas y pagos de ventas; los ABONOS no tienen ese filtro automático, así que se acotan aquí a mano.
 */

const LOTE = 1000

export interface Preparado {
  zona: string
  periodo: PeriodoElegido
}

async function preparar(db: TenantPrismaClient, ctx: TenantContext, p: Pick<ParametrosVentas, 'p' | 'desde' | 'hasta'>, ahora: Date): Promise<Preparado> {
  exigir(ctx, 'reportes.ver')
  const t = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  try {
    return { zona: t.timezone, periodo: resolverPeriodo({ preset: p.p, desde: p.desde, hasta: p.hasta }, ahora, t.timezone) }
  } catch (e) {
    if (e instanceof RangeError) throw new BusinessError('INVALID_DOCUMENT', e.message)
    throw e
  }
}

const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0)

/**
 * Lee TODAS las ventas COMPLETADAS del periodo, por lotes (un periodo largo no se trae de golpe). Los importes ya vienen NETOS de las devoluciones
 * parciales (F6.2): total, IGV, descuentos y pagos restan lo devuelto en el periodo de la venta; `devuelto` guarda lo restado, para informarlo. */
export async function leerVentas(db: TenantPrismaClient, periodo: Pick<PeriodoElegido, 'desde' | 'hasta'>): Promise<VentaFila[]> {
  const filas: VentaFila[] = []
  let cursor: string | undefined
  for (;;) {
    const lote = await db.sale.findMany({
      where: { status: 'COMPLETADA', completedAt: { gte: periodo.desde, lt: periodo.hasta } },
      orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
      take: LOTE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, number: true, completedAt: true, total: true, taxTotal: true, discountTotal: true, userId: true,
        quote: { select: { userId: true } },
        payments: { select: { method: true, amount: true, change: true } },
      },
    })
    const devueltas = await leerDevolucionesDeVentas(db, lote.map((v) => v.id))
    for (const v of lote) {
      const dev = devueltas.get(v.id)
      const cent = (n: number) => Math.round(n * 100)
      filas.push({
        id: v.id, numero: v.number, completedAt: v.completedAt!,
        total: (cent(num(v.total)) - (dev?.totalCent ?? 0)) / 100, igv: (cent(num(v.taxTotal)) - (dev?.igvCent ?? 0)) / 100,
        descuentos: (cent(num(v.discountTotal)) - (dev?.descuentoCent ?? 0)) / 100, devuelto: (dev?.totalCent ?? 0) / 100,
        vendedorId: v.quote?.userId ?? v.userId, cobroId: v.userId,
        pagos: pagosTrasDevoluciones(v.payments.map((p) => ({ metodo: p.method, monto: num(p.amount), vuelto: num(p.change) })), dev),
      })
    }
    if (lote.length < LOTE) break
    cursor = lote[lote.length - 1]!.id
  }
  return filas
}

export interface ReporteConPeriodo<T> { periodo: PeriodoElegido; textoPeriodo: string; zona: string; datos: T }
const con = <T>(p: Preparado, datos: T): ReporteConPeriodo<T> => ({ periodo: p.periodo, textoPeriodo: describirPeriodo(p.periodo), zona: p.zona, datos })

export async function informeVentasPorPeriodo(db: TenantPrismaClient, ctx: TenantContext, params: ParametrosVentas, ahora: Date = new Date()): Promise<ReporteConPeriodo<VentasPorPeriodo>> {
  const prep = await preparar(db, ctx, params, ahora)
  const g: Granularidad = params.agrupar === 'auto' ? granularidadAuto(prep.periodo.dias) : params.agrupar
  const ventas = await leerVentas(db, prep.periodo)
  return con(prep, ventasPorPeriodo(ventas, g, prep.zona, gruposDelPeriodo(prep.periodo, g)))
}

export async function informeVentasPorVendedor(db: TenantPrismaClient, ctx: TenantContext, params: ParametrosVentas, ahora: Date = new Date()): Promise<ReporteConPeriodo<VentasPorVendedor>> {
  const prep = await preparar(db, ctx, params, ahora)
  const ventas = await leerVentas(db, prep.periodo)
  const ids = [...new Set(ventas.map((v) => (params.atrib === 'VENDEDOR' ? v.vendedorId : v.cobroId)))]
  const usuarios = ids.length === 0 ? [] : await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })
  const nombres = new Map(usuarios.map((u) => [u.id, u.name || u.email]))
  return con(prep, ventasPorVendedor(ventas, params.atrib, nombres))
}

export async function informeVentasPorMedio(db: TenantPrismaClient, ctx: TenantContext, params: ParametrosVentas, ahora: Date = new Date()): Promise<ReporteConPeriodo<VentasPorMedio>> {
  const prep = await preparar(db, ctx, params, ahora)
  return con(prep, ventasPorMedio(await leerVentas(db, prep.periodo)))
}

/** Cobros: lo pagado en el acto por las ventas (neto de vuelto, sin lo fiado) más los abonos de deuda NO anulados, por la fecha en que se cobraron. */
export async function informeCobros(db: TenantPrismaClient, ctx: TenantContext, params: ParametrosVentas, ahora: Date = new Date()): Promise<ReporteConPeriodo<CobrosPorMedio>> {
  const prep = await preparar(db, ctx, params, ahora)
  const { desde, hasta } = prep.periodo

  const pagos: { metodo: string; monto: number; vuelto: number }[] = []
  let cursor: string | undefined
  for (;;) {
    const lote = await db.payment.findMany({
      where: { receivedAt: { gte: desde, lt: hasta }, method: { not: 'CREDITO' }, sale: { status: 'COMPLETADA' } },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: LOTE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, saleId: true, method: true, amount: true, change: true },
    })
    // Lo devuelto en dinero de una venta baja sus cobros (en proporción a lo que cada medio pagó), igual que en «ventas por medio».
    const ventasDelLote = [...new Set(lote.map((p) => p.saleId))]
    const devueltas = await leerDevolucionesDeVentas(db, ventasDelLote)
    for (const idVenta of ventasDelLote) {
      const todos = await db.payment.findMany({ where: { saleId: idVenta }, orderBy: { id: 'asc' }, select: { id: true, method: true, amount: true, change: true } })
      const netos = pagosTrasDevoluciones(todos.map((p) => ({ metodo: p.method, monto: num(p.amount), vuelto: num(p.change) })), devueltas.get(idVenta))
      const porId = new Map(todos.map((p, i) => [p.id, netos[i]!]))
      for (const p of lote.filter((x) => x.saleId === idVenta)) {
        const n = porId.get(p.id)!
        pagos.push({ metodo: n.metodo, monto: n.monto, vuelto: n.vuelto })
      }
    }
    if (lote.length < LOTE) break
    cursor = lote[lote.length - 1]!.id
  }

  const abonos: { metodo: string; monto: number }[] = []
  let cursorAbonos: string | undefined
  for (;;) {
    const lote = await db.customerPayment.findMany({
      where: {
        receivedAt: { gte: desde, lt: hasta }, voidedAt: null,
        // Los abonos no se acotan solos por sucursal: quien ve solo algunas, ve solo los abonos de esas.
        ...(ctx.branchIds ? { branchId: { in: [...ctx.branchIds] } } : {}),
      },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: LOTE,
      ...(cursorAbonos ? { cursor: { id: cursorAbonos }, skip: 1 } : {}),
      select: { id: true, method: true, amount: true },
    })
    for (const a of lote) abonos.push({ metodo: a.method, monto: num(a.amount) })
    if (lote.length < LOTE) break
    cursorAbonos = lote[lote.length - 1]!.id
  }
  return con(prep, cobrosPorMedio(pagos, abonos))
}

// ─── Descargas CSV ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ArchivoCsv { nombre: string; contenido: string; filas: number }

/** Descarga un reporte de ventas en CSV (Excel es-PE). Queda en la auditoría quién lo bajó, de qué periodo y cuántas filas llevaba. */
export async function exportarVentasCsv(db: TenantPrismaClient, ctx: TenantContext, tipo: TipoReporteVentas, params: ParametrosVentas, ahora: Date = new Date()): Promise<ArchivoCsv> {
  let periodo: PeriodoElegido
  let tabla: TablaCsv
  switch (tipo) {
    case 'periodo': { const r = await informeVentasPorPeriodo(db, ctx, params, ahora); periodo = r.periodo; tabla = csvVentasPorPeriodo(r.datos); break }
    case 'vendedor': { const r = await informeVentasPorVendedor(db, ctx, params, ahora); periodo = r.periodo; tabla = csvVentasPorVendedor(r.datos); break }
    case 'medios': { const r = await informeVentasPorMedio(db, ctx, params, ahora); periodo = r.periodo; tabla = csvVentasPorMedio(r.datos); break }
    case 'cobros': { const r = await informeCobros(db, ctx, params, ahora); periodo = r.periodo; tabla = csvCobros(r.datos); break }
  }
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'reporte.exportado', entityType: 'Reporte', entityId: `ventas-${tipo}`,
      after: { reporte: `ventas-${tipo}`, desde: periodo.desdeDia, hasta: periodo.hastaDia, filas: tabla.filas.length - 1, atribucion: tipo === 'vendedor' ? params.atrib : null } as never,
      impersonationId: ctx.impersonationId ?? null,
    },
  })
  return { nombre: `ventas-${tipo}-${periodo.desdeDia}_${periodo.hastaDia}.csv`, contenido: generarCsv(tabla.cabecera, tabla.filas), filas: tabla.filas.length - 1 }
}
