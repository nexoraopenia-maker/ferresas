import { BusinessError } from '@/lib/errors'
import { generarCsv } from '@/lib/csv-export'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { CODIGOS_NOTA_CREDITO_PARCIAL, CODIGOS_NOTA_CREDITO_TOTAL } from '@/features/invoicing/notas'
import { modoFiscal, type ModoFiscal } from '@/features/invoicing/modo-fiscal'
import { describirPeriodo, resolverPeriodo, type PeriodoElegido } from '@/features/reportes/periodo'
import type { ArchivoCsv } from '@/features/reportes/ventas-service'
import { filtroComprasDelPeriodo, leerCompras, leerComprobantes } from '@/features/registros/registro-service'
import { registroCompras, registroVentas } from '@/features/registros/registro-calculo'
import type { ParametrosRegistros } from '@/features/registros/schemas'
import {
  ETIQUETA_PUENTE, armarInforme, cuadre, hallazgoDeCuadre, hallazgoDePuente, hallazgosDeCompras, hallazgosDeEnvio, hallazgosDeNotas, hallazgosDeNumeracion, hallazgosDeVentas,
  hallazgosDeNotasParciales, hallazgosInformativos, hallazgosVentasCerradas, puenteVentas, scopeDeSerie, serieSospechosa, totalDesdeAgregados,
  type AgregadoDoc, type DocAbierto, type DocVenta, type EnvioAgotado, type EstadoDoc, type Hallazgo, type InformeConciliacion, type NotaConc, type SerieConc, type TipoDoc,
  type VentaCerrada, type VentaConc, type VentaConParciales,
} from './conciliacion-calculo'

/**
 * Conciliación fiscal. SOLO LECTURA (salvo la línea de auditoría de cada descarga). La pide `reportes.ver`: dueño, administrador y contador.
 *
 * `calcularConciliacion` NO comprueba permisos: es el núcleo que comparten la pantalla (a través de `informeConciliacion`, que sí exige el
 * permiso) y el script `scripts/auditar-fiscal.ts` (que corre sin usuario, como los demás auditores). Ninguna pantalla ni ruta lo llama directo.
 *
 * Sucursales: ventas y comprobantes se acotan solos (por su venta). Las compras, los contadores de numeración y los envíos NO se acotan solos,
 * así que se acotan aquí a mano por las sucursales dadas.
 */
const LOTE = 1000
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0)
const TIPOS_DOC = ['BOLETA', 'FACTURA', 'NOTA_CREDITO', 'NOTA_DEBITO'] as const
const PRINCIPALES = ['BOLETA', 'FACTURA'] as const
const TOPE_DOCS_ABIERTOS = 2000
const MAX_FALTANTES_A_LEER = 200_000

export interface ResultadoConciliacion { periodo: PeriodoElegido; textoPeriodo: string; zona: string; informe: InformeConciliacion }

export async function calcularConciliacion(db: TenantPrismaClient, p: ParametrosRegistros, ahora: Date = new Date(), branchIds?: readonly string[]): Promise<ResultadoConciliacion> {
  const t = await db.tenant.findFirstOrThrow({ select: { timezone: true, isDemo: true, realBillingEnabledAt: true, realBillingPausedAt: true } })
  const modo: ModoFiscal = modoFiscal(t)
  let periodo: PeriodoElegido
  try {
    periodo = resolverPeriodo({ preset: p.p, desde: p.desde, hasta: p.hasta }, ahora, t.timezone)
  } catch (e) {
    if (e instanceof RangeError) throw new BusinessError('INVALID_DOCUMENT', e.message)
    throw e
  }
  const ahoraMs = ahora.getTime()
  const rango = { gte: periodo.desde, lt: periodo.hasta }

  // 1) Ventas completadas del periodo, con su comprobante principal.
  const ventas: VentaConc[] = []
  let cursor: string | undefined
  for (;;) {
    const lote = await db.sale.findMany({
      where: { status: 'COMPLETADA', completedAt: rango },
      orderBy: { id: 'asc' }, take: LOTE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, number: true, documentType: true, total: true, subtotal: true, taxTotal: true, completedAt: true,
        saleReturns: { select: { returnTotal: true } },
        taxDocuments: { where: { documentType: { in: [...PRINCIPALES] } }, take: 1, select: { id: true, documentType: true, fullNumber: true, status: true, isTrial: true, subtotal: true, taxTotal: true, total: true, receiverDocType: true, receiverDocNumber: true, issuedAt: true } },
      },
    })
    for (const v of lote) {
      const d = v.taxDocuments[0]
      ventas.push({
        id: v.id, numero: v.number, pide: v.documentType, total: num(v.total), base: num(v.subtotal), igv: num(v.taxTotal),
        devuelto: v.saleReturns.reduce((a, r) => a + Math.round(num(r.returnTotal) * 100), 0) / 100, completadaMs: (v.completedAt ?? ahora).getTime(),
        doc: d ? { id: d.id, tipo: d.documentType as TipoDoc, numero: d.fullNumber, estado: d.status as EstadoDoc, isTrial: d.isTrial, base: num(d.subtotal), igv: num(d.taxTotal), total: num(d.total), receptorTipo: d.receiverDocType, receptorNumero: d.receiverDocNumber, emitidoMs: d.issuedAt.getTime() } satisfies DocVenta : null,
      })
    }
    if (lote.length < LOTE) break
    cursor = lote[lote.length - 1]!.id
  }

  // 2) Anuladas y devueltas del periodo (informativas) y las que conservan un comprobante vivo (de cualquier fecha).
  const cerradasPeriodo = await db.sale.groupBy({ by: ['status'], where: { status: { in: ['ANULADA', 'DEVUELTA'] }, completedAt: rango }, _count: { _all: true }, _sum: { total: true } })
  const lineaDe = (st: 'ANULADA' | 'DEVUELTA') => { const g = cerradasPeriodo.find((x) => x.status === st); return { documentos: g?._count._all ?? 0, total: num(g?._sum.total) } }
  const cerradas = await db.sale.findMany({
    where: { status: { in: ['ANULADA', 'DEVUELTA'] }, taxDocuments: { some: { isTrial: false, documentType: { in: [...PRINCIPALES] }, status: { notIn: ['RECHAZADO', 'ANULADO'] } } } },
    orderBy: { id: 'asc' }, take: 500,
    select: {
      id: true, number: true, status: true,
      taxDocuments: { where: { isTrial: false, documentType: { in: [...PRINCIPALES] } }, take: 1, select: { fullNumber: true, status: true, total: true, notes: { select: { documentType: true, status: true, total: true, reasonCode: true } } } },
    },
  })
  const ventasCerradas: VentaCerrada[] = cerradas.flatMap((v) => {
    const d = v.taxDocuments[0]
    if (!d || (v.status !== 'ANULADA' && v.status !== 'DEVUELTA')) return []
    return [{ id: v.id, numero: v.number, estado: v.status, doc: { numero: d.fullNumber, estado: d.status as EstadoDoc, total: num(d.total), notas: d.notes.map((n) => ({ tipo: n.documentType as TipoDoc, estado: n.status as EstadoDoc, total: num(n.total), motivoTotal: n.documentType === 'NOTA_CREDITO' && CODIGOS_NOTA_CREDITO_TOTAL.includes(n.reasonCode ?? '') })) } }]
  })

  // 3) Registro de ventas y su cálculo independiente (agregados de la base).
  const registroV = registroVentas(await leerComprobantes(db, t.timezone, periodo))
  const grupos = await db.taxDocument.groupBy({
    by: ['documentType', 'status'], where: { isTrial: false, documentType: { in: [...TIPOS_DOC] }, issuedAt: rango },
    _count: { _all: true }, _sum: { subtotal: true, taxTotal: true, total: true },
  })
  const agregados: AgregadoDoc[] = grupos.map((g) => ({ tipo: g.documentType as TipoDoc, estado: g.status as EstadoDoc, documentos: g._count._all, base: num(g._sum.subtotal), igv: num(g._sum.taxTotal), total: num(g._sum.total) }))
  const indepV = totalDesdeAgregados(agregados)
  // Comprobantes válidos emitidos en el periodo cuya venta ya se anuló o devolvió (F6.1): se explican aparte, no como diferencia de fechas.
  const deDevueltas = await db.taxDocument.findMany({
    where: { isTrial: false, documentType: { in: [...PRINCIPALES] }, status: { in: ['ACEPTADO', 'OBSERVADO'] }, issuedAt: rango, sale: { status: { in: ['ANULADA', 'DEVUELTA'] } } },
    select: { total: true }, take: 5000,
  })
  const lineaDevueltas = { documentos: deDevueltas.length, total: deDevueltas.reduce((a, d) => a + Math.round(num(d.total) * 100), 0) / 100 }
  const brutoEmitido = totalDesdeAgregados(agregados.filter((a) => a.tipo === 'BOLETA' || a.tipo === 'FACTURA')).total

  // 3b) Devoluciones PARCIALES (F6.2). (a) Las notas parciales válidas emitidas en el periodo, según la venta sea de este periodo o de otro: son
  //     los dos desfases de fecha. (b) Por venta con comprobante real vivo: sus notas parciales deben sumar exactamente lo devuelto.
  const notasParciales = await db.taxDocument.findMany({
    where: { isTrial: false, documentType: 'NOTA_CREDITO', reasonCode: { in: [...CODIGOS_NOTA_CREDITO_PARCIAL] }, status: { in: ['ACEPTADO', 'OBSERVADO'] }, issuedAt: rango },
    select: { total: true, sale: { select: { status: true, completedAt: true } } }, take: 5000,
  })
  const enRango = (d: Date | null) => !!d && d >= periodo.desde && d < periodo.hasta
  const notasParcialesCent = { deVentasDelPeriodo: 0, deOtrasVentas: 0 }
  for (const n of notasParciales) {
    if (n.sale.status === 'COMPLETADA' && enRango(n.sale.completedAt)) notasParcialesCent.deVentasDelPeriodo += Math.round(num(n.total) * 100)
    else notasParcialesCent.deOtrasVentas += Math.round(num(n.total) * 100)
  }
  const conParciales = await db.sale.findMany({
    where: {
      // Con alguna devolución, o con alguna nota parcial emitida en el periodo (una nota 07 SIN devolución que la respalde también es un hallazgo).
      OR: [
        { saleReturns: { some: {} }, completedAt: rango },
        { saleReturns: { some: { createdAt: rango } } },
        { taxDocuments: { some: { notes: { some: { documentType: 'NOTA_CREDITO', reasonCode: { in: [...CODIGOS_NOTA_CREDITO_PARCIAL] }, issuedAt: rango } } } } },
      ],
      taxDocuments: { some: { isTrial: false, documentType: { in: [...PRINCIPALES] }, status: { in: ['ACEPTADO', 'OBSERVADO'] } } },
    },
    orderBy: { id: 'asc' }, take: 1000,
    select: {
      id: true, number: true,
      saleReturns: { select: { returnTotal: true, creditNote: { select: { reasonCode: true } } } },
      taxDocuments: { where: { isTrial: false, documentType: { in: [...PRINCIPALES] } }, take: 1, select: { fullNumber: true, notes: { where: { documentType: 'NOTA_CREDITO', reasonCode: { in: [...CODIGOS_NOTA_CREDITO_PARCIAL] }, status: { not: 'RECHAZADO' } }, select: { total: true } } } },
    },
  })
  const ventasParciales: VentaConParciales[] = conParciales.flatMap((v) => {
    const d = v.taxDocuments[0]
    if (!d) return []
    // Lo que debe tener nota parcial: las devoluciones sin nota o con nota parcial (las que tienen una nota TOTAL se vigilan aparte).
    const esperado = v.saleReturns.filter((r) => !r.creditNote || CODIGOS_NOTA_CREDITO_PARCIAL.includes(r.creditNote.reasonCode ?? '')).reduce((a, r) => a + Math.round(num(r.returnTotal) * 100), 0)
    const notas = d.notes.reduce((a, n) => a + Math.round(num(n.total) * 100), 0)
    return [{ id: v.id, numero: v.number, devuelto: esperado / 100, notas: notas / 100, comprobante: d.fullNumber }]
  })

  // 4) Lo abierto (pendiente, enviado, rechazado) y los envíos agotados: sin importar la fecha.
  const abiertosDb = await db.taxDocument.findMany({
    where: { isTrial: false, documentType: { in: [...TIPOS_DOC] }, status: { in: ['PENDIENTE', 'ENVIADO', 'RECHAZADO'] } },
    orderBy: { issuedAt: 'asc' }, take: TOPE_DOCS_ABIERTOS, select: { id: true, fullNumber: true, status: true, total: true, issuedAt: true },
  })
  const abiertos: DocAbierto[] = abiertosDb.map((d) => ({ id: d.id, numero: d.fullNumber, estado: d.status as DocAbierto['estado'], total: num(d.total), emitidoMs: d.issuedAt.getTime() }))
  const agotadosDb = await db.fiscalDispatch.findMany({
    where: { status: 'AGOTADO', taxDocument: { isTrial: false, ...(branchIds ? { sale: { branchId: { in: [...branchIds] } } } : {}) } },
    take: 200, orderBy: { exhaustedAt: 'asc' }, select: { attempts: true, lastError: true, taxDocument: { select: { fullNumber: true } } },
  })
  const agotados: EnvioAgotado[] = agotadosDb.map((a) => ({ numero: a.taxDocument.fullNumber, intentos: a.attempts, ultimoError: a.lastError }))
  const comprobantesReales = await db.taxDocument.count({ where: { isTrial: false, documentType: { in: [...TIPOS_DOC] }, OR: [{ issuedAt: rango }, { status: { in: ['PENDIENTE', 'ENVIADO', 'RECHAZADO'] } }] } })

  // 5) Numeración: por serie, cuántos hay, el primero y el último; los números uno por uno solo si algo no cuadra.
  const porSerie = await db.taxDocument.groupBy({ by: ['documentType', 'series'], where: { isTrial: false, documentType: { in: [...TIPOS_DOC] } }, _count: { _all: true }, _min: { correlativo: true }, _max: { correlativo: true } })
  const contadores = await db.documentCounter.findMany({
    where: { scope: { in: ['TAX_BOLETA', 'TAX_FACTURA', 'TAX_NC_BOLETA', 'TAX_NC_FACTURA'] }, ...(branchIds ? { branchId: { in: [...branchIds] } } : {}) },
    select: { scope: true, series: true, next: true, startNumber: true },
  })
  const series: SerieConc[] = []
  for (const g of porSerie) {
    const tipo = g.documentType as TipoDoc
    const sc = scopeDeSerie(tipo, g.series)
    const ct = sc ? contadores.find((x) => x.scope === sc && x.series === g.series) : undefined
    const base: SerieConc = { tipo, serie: g.series, emitidos: g._count._all, min: g._min.correlativo ?? 0, max: g._max.correlativo ?? 0, correlativos: null, contador: ct ? { next: ct.next, startNumber: ct.startNumber } : null }
    if (serieSospechosa(base) && base.max - base.min < MAX_FALTANTES_A_LEER) {
      const filas = await db.taxDocument.findMany({ where: { isTrial: false, documentType: tipo, series: g.series }, select: { correlativo: true }, orderBy: { correlativo: 'asc' } })
      base.correlativos = filas.map((f) => f.correlativo)
    }
    series.push(base)
  }

  // 6) Notas emitidas en el periodo.
  const notasDb = await db.taxDocument.findMany({
    where: { isTrial: false, documentType: { in: ['NOTA_CREDITO', 'NOTA_DEBITO'] }, relatedDocumentId: { not: null }, issuedAt: rango }, take: 1000, orderBy: { id: 'asc' },
    select: { fullNumber: true, documentType: true, status: true, total: true, saleId: true, relatedDocument: { select: { fullNumber: true, total: true, saleId: true, notes: { where: { documentType: 'NOTA_CREDITO' }, select: { status: true, total: true } } } } },
  })
  const notas: NotaConc[] = notasDb.flatMap((n) => n.relatedDocument ? [{
    numero: n.fullNumber, tipo: n.documentType as 'NOTA_CREDITO' | 'NOTA_DEBITO', estado: n.status as EstadoDoc, total: num(n.total), saleId: n.saleId,
    original: { numero: n.relatedDocument.fullNumber, total: num(n.relatedDocument.total), saleId: n.relatedDocument.saleId, notasCredito: n.relatedDocument.notes.map((x) => ({ estado: x.status as EstadoDoc, total: num(x.total) })) },
  }] : [])

  // 7) Compras: el registro y su cálculo independiente.
  const registroC = registroCompras(await leerCompras(db, t.timezone, periodo, branchIds))
  const gC = await db.purchase.groupBy({ by: ['docType'], where: filtroComprasDelPeriodo(periodo, branchIds), _count: { _all: true }, _sum: { total: true } })
  const indepC = gC.reduce((a, g) => a + (g.docType === 'NOTA_CREDITO' ? -1 : 1) * Math.round(num(g._sum.total) * 100), 0) / 100

  // 8) Armar.
  const puente = puenteVentas(ventas, lineaDe('ANULADA'), lineaDe('DEVUELTA'), { deVentasDelPeriodo: notasParcialesCent.deVentasDelPeriodo / 100, deOtrasVentas: notasParcialesCent.deOtrasVentas / 100 })
  const hallazgos: Hallazgo[] = [
    hallazgoDePuente(puente, modo),
    ...hallazgosDeVentas(ventas, ahoraMs, modo),
    ...hallazgosVentasCerradas(ventasCerradas, modo),
    ...hallazgosDeEnvio(abiertos, agotados, ahoraMs, modo),
    ...hallazgosDeNumeracion(series, modo),
    ...hallazgosDeNotas(notas, modo),
    ...hallazgosDeNotasParciales(ventasParciales, modo),
    hallazgoDeCuadre('REGISTRO_VENTAS_NO_CUADRA', cuadre(registroV.totales.total, indepV.total), modo),
    hallazgoDeCuadre('REGISTRO_COMPRAS_NO_CUADRA', cuadre(registroC.totales.total, indepC), modo),
    ...hallazgosDeCompras(registroC, modo),
    ...hallazgosInformativos(puente, modo, brutoEmitido, lineaDevueltas),
  ].filter((h): h is Hallazgo => h !== null)

  const informe = armarInforme({
    modo, puente, cuadreVentas: cuadre(registroV.totales.total, indepV.total), cuadreCompras: cuadre(registroC.totales.total, indepC), hallazgos,
    comprobantesReales, registroVentas: registroV, comprasEnRegistro: registroC.filas.length,
  })
  return { periodo, textoPeriodo: describirPeriodo(periodo), zona: t.timezone, informe }
}

/** La conciliación para una persona: exige `reportes.ver` y se acota por sus sucursales. */
export async function informeConciliacion(db: TenantPrismaClient, ctx: TenantContext, p: ParametrosRegistros, ahora: Date = new Date()): Promise<ResultadoConciliacion> {
  exigir(ctx, 'reportes.ver')
  return calcularConciliacion(db, p, ahora, ctx.branchIds)
}

// ─── Descarga CSV ───────────────────────────────────────────────────────────────────────────────────────────────────

const ETIQUETA_NIVEL = { ERROR: 'Error', ADVERTENCIA: 'Advertencia', INFO: 'Información' } as const

export function csvConciliacion(i: InformeConciliacion) {
  const m = (monto: number) => ({ monto })
  const p = i.puente
  return {
    cabecera: ['Nivel', 'Código', 'Hallazgo', 'Referencia', 'Detalle', 'Importe (S/)'],
    filas: [
      ...i.hallazgos.flatMap((h) => h.items.length > 0
        ? h.items.map((it) => [ETIQUETA_NIVEL[h.nivel], h.codigo, h.titulo, it.referencia, it.detalle, it.importe === null ? '' : m(it.importe)])
        : [[ETIQUETA_NIVEL[h.nivel], h.codigo, h.titulo, '', h.explicacion, '']]),
      ['PUENTE', '', 'Ventas completadas', `${p.ventasCompletadas.documentos} ventas`, '', m(p.ventasCompletadas.total)],
      ['PUENTE', '', 'Notas de venta (sin comprobante por diseño)', `${p.notasDeVenta.documentos} ventas`, '', m(p.notasDeVenta.total)],
      ['PUENTE', '', 'Ventas con comprobante emitido o pedido', `${p.conComprobante.documentos} ventas`, '', m(p.conComprobante.total)],
      ...(['valido', 'pendiente', 'rechazado', 'anulado', 'ensayo', 'sinComprobante'] as const).map((k) => ['PUENTE', '', `  ${ETIQUETA_PUENTE[k]}`, `${p.clasificacion[k].documentos} ventas`, '', m(p.clasificacion[k].total)]),
      ['PUENTE', '', 'Diferencia sin explicar (debe ser 0)', '', '', m(p.diferencia)],
      ['PUENTE', '', 'Ventas anuladas (informativo)', `${p.anuladas.documentos} ventas`, '', m(p.anuladas.total)],
      ['PUENTE', '', 'Ventas devueltas (informativo)', `${p.devueltas.documentos} ventas`, '', m(p.devueltas.total)],
      ['PUENTE', '', 'Devoluciones parciales de estas ventas (ya restadas de las ventas completadas)', `${p.devolucionesParciales.documentos} ventas`, '', m(p.devolucionesParciales.total)],
      ['PUENTE', '', 'Desfase: devuelto de este periodo con la nota de crédito en otro (registro mayor)', '', '', m(p.desfaseParciales.notaFueraDelPeriodo)],
      ['PUENTE', '', 'Desfase: notas parciales de este periodo sobre ventas de otro (registro menor)', '', '', m(-p.desfaseParciales.notasDeOtrasVentas)],
      ['CUADRE', '', 'Registro de ventas vs. cálculo independiente', '', '', m(i.cuadreVentas.diferencia)],
      ['CUADRE', '', 'Registro de compras vs. cálculo independiente', '', '', m(i.cuadreCompras.diferencia)],
    ],
  }
}

/** Descarga la conciliación en CSV. Queda en la auditoría quién lo bajó, qué periodo y con qué resultado. */
export async function exportarConciliacionCsv(db: TenantPrismaClient, ctx: TenantContext, p: ParametrosRegistros, ahora: Date = new Date()): Promise<ArchivoCsv> {
  const r = await informeConciliacion(db, ctx, p, ahora)
  const tabla = csvConciliacion(r.informe)
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'reporte.exportado', entityType: 'Reporte', entityId: 'conciliacion-fiscal',
      after: { reporte: 'conciliacion-fiscal', desde: r.periodo.desdeDia, hasta: r.periodo.hastaDia, estado: r.informe.estado, errores: r.informe.resumen.errores, advertencias: r.informe.resumen.advertencias } as never,
      impersonationId: ctx.impersonationId ?? null,
    },
  })
  return { nombre: `conciliacion-fiscal-${r.periodo.desdeDia}_${r.periodo.hastaDia}.csv`, contenido: generarCsv(tabla.cabecera, tabla.filas), filas: tabla.filas.length }
}

