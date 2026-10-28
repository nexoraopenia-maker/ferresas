import type { InventoryCountItemStatus, UnitType } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import { exigir, puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { applyStockMovement } from './stock-service'
import { LOTE_APLICACION, LOTE_APROBACION, diferenciaDeConteo, evaluarLinea, stockTrasAplicar, type EvaluacionLinea } from './conteo-reglas'
import type { AplicarConteoInput, AprobarLineaInput, AprobarSinAlertaInput, RecontarLineaInput, RechazarLineaInput, RevisionInput } from './conteo-schemas'
import { OPCIONES_TX, SELECCION_CONTEO, auditar, bloquear, exigirEstado, invalido, noExiste, num, r4, resumir, type ResumenConteo } from './conteo-service'

/**
 * Revisión y aplicación de una toma de inventario (F6.5b). Diseño: docs/F6.5-DISENO.md.
 *
 *  · La DIFERENCIA de una línea es `contado − sistema al contar`, con el sistema tomado del KARDEX (F6.4) a la hora de la última pasada vigente (el último `balanceAfter` de esa
 *    fila de stock hasta ese instante). Las ventas posteriores a contar NO distorsionan la diferencia: la aplicación es RELATIVA (`nuevo = stock de ahora + diferencia`).
 *  · Revisar (recontar, aprobar, rechazar) y aplicar es `stock.ajustar` y no se hace con el PIN de operador. Quien fue el único contador no aplica su propio conteo (salvo el dueño).
 *  · Umbrales ⚠️: una diferencia grande (> S/ 200 al costo promedio vigente o > 10 % de lo esperado) se alerta y se recomienda recontar; aprobarla exige confirmarla expresamente.
 *  · Aplicar genera un `AJUSTE` por línea (origen `CONTEO`, enlazado al conteo) al costo promedio vigente y NO toca `Product.costPrice`. Sin costo, el movimiento queda sin valor
 *    aplicado y la línea se marca. Se aplica por TANDAS (cada una, una transacción con las filas de stock bloqueadas en orden), de modo que un conteo grande no retiene miles de filas.
 *  · COSTOS: el servidor lee el costo para decidir los umbrales (es una regla de autorización, no una pantalla) pero SOLO lo manda a quien tiene `productos.ver_costo`; los demás
 *    reciben las diferencias en unidades y una causa genérica («grande»).
 */

/** Quién ve la revisión de diferencias: quien aprueba (`stock.ajustar`) y quien gestiona el conteo (`conteo.gestionar`). */
export const puedeVerRevision = (ctx: TenantContext): boolean => puede(ctx, 'stock.ajustar') || puede(ctx, 'conteo.gestionar')

function exigirRevisor(ctx: TenantContext): void {
  exigir(ctx, 'stock.ajustar')
  if (ctx.operadorDe) throw new BusinessError('FORBIDDEN_ROLE', 'Con el PIN de operador no se aprueban ni se aplican las diferencias de una toma de inventario: entra con tu propio usuario.')
}

// ─── Lo que el sistema decía cuando se contó ────────────────────────────────────────────────────────────────────────────

interface FilaStock { warehouseId: string; productId: string; variantId: string | null }

/**
 * El saldo de una fila de stock en un instante: el `balanceAfter` del último movimiento hasta ese momento (el kardex). Si no hay ninguno (stock cargado sin historial),
 * el stock de ahora menos lo que se movió después (que es lo mismo si el libro está completo).
 */
export async function saldoDelKardexEn(t: TenantPrismaClient, f: FilaStock, instante: Date): Promise<{ saldo: number; fuente: 'KARDEX' | 'STOCK_MENOS_POSTERIORES' }> {
  const ultimo = await t.stockMovement.findFirst({ where: { ...f, createdAt: { lte: instante } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { balanceAfter: true } })
  if (ultimo) return { saldo: num(ultimo.balanceAfter), fuente: 'KARDEX' }
  const [stock, despues] = await Promise.all([
    t.stock.findFirst({ where: f, select: { quantity: true } }),
    t.stockMovement.aggregate({ where: { ...f, createdAt: { gt: instante } }, _sum: { quantity: true } }),
  ])
  return { saldo: r4(num(stock?.quantity) - num(despues._sum.quantity)), fuente: 'STOCK_MENOS_POSTERIORES' }
}

interface Medida {
  contado: number | null
  momento: Date | null
  sistema: number | null
  fuente: 'KARDEX' | 'STOCK_MENOS_POSTERIORES' | null
  diferencia: number | null
  movidosDespues: number
  ev: EvaluacionLinea | null
}
const SIN_MEDIDA: Medida = { contado: null, momento: null, sistema: null, fuente: null, diferencia: null, movidosDespues: 0, ev: null }

/** Mide una línea: la hora de su última pasada vigente, el saldo del kardex entonces, la diferencia, cuánto se movió después y los umbrales. */
async function medir(t: TenantPrismaClient, warehouseId: string, item: { id: string; productId: string; variantId: string | null; countedQty: { toString(): string } | null }, costo: number | null): Promise<Medida> {
  if (item.countedQty === null) return SIN_MEDIDA
  const momento = (await t.inventoryCountEntry.aggregate({ where: { itemId: item.id, voidedAt: null }, _max: { createdAt: true } }))._max.createdAt
  if (!momento) return SIN_MEDIDA
  const f = { warehouseId, productId: item.productId, variantId: item.variantId }
  const { saldo, fuente } = await saldoDelKardexEn(t, f, momento)
  const contado = num(item.countedQty)
  const movidosDespues = await t.stockMovement.count({ where: { ...f, createdAt: { gt: momento } } })
  return { contado, momento, sistema: saldo, fuente, diferencia: diferenciaDeConteo(contado, saldo), movidosDespues, ev: evaluarLinea({ contado, sistema: saldo, costo }) }
}

async function costosDe(t: TenantPrismaClient, productIds: readonly string[]): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map()
  const filas = await t.product.findMany({ where: { id: { in: [...new Set(productIds)] } }, select: { id: true, costPrice: true } })
  return new Map(filas.map((p) => [p.id, num(p.costPrice)]))
}

// ─── Lectura ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type AlertaLinea = 'SOBRE_UMBRAL' | 'SIN_COSTO' | 'MOVIDO_DESPUES' | 'DEJARIA_NEGATIVO'

export interface LineaRevision {
  id: string
  productId: string
  variantId: string | null
  nombre: string
  sku: string
  unidad: UnitType
  estado: InventoryCountItemStatus
  contado: number | null
  /** Lo que el sistema decía cuando se contó (el saldo del kardex a la hora de la última pasada vigente). */
  sistemaAlContar: number | null
  diferencia: number | null
  /** |diferencia| / |sistema|; `null` si el sistema esperaba cero. */
  porcentaje: number | null
  /** Movimientos de esa fila de stock posteriores a la última pasada (ventas, etc.): aviso para el revisor. */
  movimientosDesdeContar: number
  stockActual: number
  alertas: AlertaLinea[]
  /** Por qué es grande: `PORCENTAJE`, `VALOR` (solo con ver costos) o `GRANDE` (la regla del valor, sin decir cuánto). */
  causasUmbral: ('PORCENTAJE' | 'VALOR' | 'GRANDE')[]
  notaRevision: string | null
  /** Ya se aplicó su diferencia al stock (o no había diferencia). */
  aplicada: boolean
  /** AUSENTE (no vacía) sin `productos.ver_costo`. */
  costos?: { costoPromedio: number | null; valorDiferencia: number | null }
}

function leerAlertas(m: { ev: EvaluacionLinea | null; movidos: number; dejariaNegativo: boolean; verCostos: boolean; diferencia: number | null }): { alertas: AlertaLinea[]; causas: LineaRevision['causasUmbral'] } {
  const alertas: AlertaLinea[] = []
  const causas: LineaRevision['causasUmbral'] = []
  if (m.ev?.sobreUmbral) {
    alertas.push('SOBRE_UMBRAL')
    for (const c of m.ev.causas) causas.push(c === 'VALOR' && !m.verCostos ? 'GRANDE' : c)
  }
  if (m.verCostos && m.ev?.sinCosto && m.diferencia !== null && m.diferencia !== 0) alertas.push('SIN_COSTO')
  if (m.movidos > 0 && m.diferencia !== null && m.diferencia !== 0) alertas.push('MOVIDO_DESPUES')
  if (m.dejariaNegativo) alertas.push('DEJARIA_NEGATIVO')
  return { alertas, causas }
}

/** Las líneas de un conteo con su diferencia, umbrales y alertas, por tandas. Las aprobadas muestran lo que se aprobó; las demás se miden en vivo. */
export async function revisionDelConteo(db: TenantPrismaClient, ctx: TenantContext, input: RevisionInput): Promise<{ conteo: ResumenConteo; lineas: LineaRevision[]; siguiente: string | null; conCostos: boolean }> {
  if (!puedeVerRevision(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver las diferencias de una toma de inventario.')
  const c = await db.inventoryCount.findFirst({ where: { id: input.countId }, select: SELECCION_CONTEO })
  if (!c) throw noExiste()
  const verCostos = puede(ctx, 'productos.ver_costo')
  const limite = input.limite ?? 100
  const filas = await db.inventoryCountItem.findMany({
    where: { countId: c.id, ...(input.estado ? { status: input.estado } : {}) },
    orderBy: [{ nameSnapshot: 'asc' }, { id: 'asc' }], take: limite + 1, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true, productId: true, variantId: true, nameSnapshot: true, skuSnapshot: true, unitType: true, status: true, countedQty: true, reviewNote: true,
      systemQtyAtCount: true, difference: true, movedSinceCount: true, resultingMovementId: true,
    },
  })
  const hayMas = filas.length > limite
  const pagina = hayMas ? filas.slice(0, limite) : filas
  const costos = await costosDe(db, pagina.map((f) => f.productId))
  const stockRows = pagina.length ? await db.stock.findMany({ where: { warehouseId: c.warehouseId, productId: { in: [...new Set(pagina.map((f) => f.productId))] } }, select: { productId: true, variantId: true, quantity: true } }) : []
  const stockDe = (p: string, v: string | null) => num(stockRows.find((s) => s.productId === p && s.variantId === v)?.quantity)

  const lineas: LineaRevision[] = []
  for (const f of pagina) {
    const costo = costos.get(f.productId) ?? null
    // Una línea aprobada o aplicada muestra lo que se evaluó al aprobarla; las demás se miden ahora.
    const guardada = f.status === 'APROBADO' && f.systemQtyAtCount !== null
    const m = guardada
      ? ((): Medida => { const contado = num(f.countedQty); const sistema = num(f.systemQtyAtCount); return { contado, momento: null, sistema, fuente: null, diferencia: num(f.difference), movidosDespues: f.movedSinceCount ?? 0, ev: evaluarLinea({ contado, sistema, costo }) } })()
      : await medir(db, c.warehouseId, f, costo)
    const actual = stockDe(f.productId, f.variantId)
    const aplicada = f.resultingMovementId !== null || (f.status === 'APROBADO' && m.diferencia === 0)
    const dejariaNegativo = !aplicada && f.status !== 'RECHAZADO' && m.diferencia !== null && stockTrasAplicar(actual, m.diferencia) < 0
    const { alertas, causas } = leerAlertas({ ev: m.ev, movidos: m.movidosDespues, dejariaNegativo, verCostos, diferencia: m.diferencia })
    lineas.push({
      id: f.id, productId: f.productId, variantId: f.variantId, nombre: f.nameSnapshot, sku: f.skuSnapshot, unidad: f.unitType, estado: f.status,
      contado: m.contado, sistemaAlContar: m.sistema, diferencia: m.diferencia, porcentaje: m.ev?.porcentaje ?? null, movimientosDesdeContar: m.movidosDespues, stockActual: actual,
      alertas, causasUmbral: causas, notaRevision: f.reviewNote, aplicada,
      ...(verCostos ? { costos: { costoPromedio: costo !== null && costo > 0 ? costo : null, valorDiferencia: m.ev?.valor ?? null } } : {}),
    })
  }
  return { conteo: await resumir(db, c), lineas, siguiente: hayMas ? pagina[pagina.length - 1]!.id : null, conCostos: verCostos }
}

export interface EstadoRevision {
  lineas: number
  sinContar: number
  contadas: number
  porRecontar: number
  aprobadas: number
  rechazadas: number
  /** Aprobadas cuyo ajuste ya se aplicó al stock. */
  aplicadas: number
  /** Aprobadas con diferencia que todavía no se aplicaron. */
  porAplicar: number
}

export async function estadoDeRevision(db: TenantPrismaClient, ctx: TenantContext, countId: string): Promise<EstadoRevision> {
  if (!puedeVerRevision(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver las diferencias de una toma de inventario.')
  const c = await db.inventoryCount.findFirst({ where: { id: countId }, select: { id: true } })
  if (!c) throw noExiste()
  const cnt = (where: object) => db.inventoryCountItem.count({ where: { countId, ...where } })
  const [lineas, sinContar, contadas, porRecontar, aprobadas, rechazadas, aplicadas, porAplicar] = await Promise.all([
    cnt({}), cnt({ status: 'PENDIENTE' }), cnt({ status: 'CONTADO' }), cnt({ status: 'RECONTAR' }), cnt({ status: 'APROBADO' }), cnt({ status: 'RECHAZADO' }),
    cnt({ resultingMovementId: { not: null } }), cnt({ status: 'APROBADO', resultingMovementId: null, difference: { not: 0 } }),
  ])
  return { lineas, sinContar, contadas, porRecontar, aprobadas, rechazadas, aplicadas, porAplicar }
}

// ─── Recontar, aprobar, rechazar ────────────────────────────────────────────────────────────────────────────────────────

async function lineaDe(t: TenantPrismaClient, countId: string, itemId: string) {
  const l = await t.inventoryCountItem.findFirst({ where: { id: itemId, countId }, select: { id: true, productId: true, variantId: true, nameSnapshot: true, status: true, countedQty: true, resultingMovementId: true } })
  if (!l) throw new BusinessError('NOT_FOUND', 'La línea no existe en esta toma de inventario.')
  if (l.resultingMovementId) throw invalido(`«${l.nameSnapshot}» ya se aplicó al stock: no se puede cambiar.`)
  return l
}

/**
 * Manda una línea a RECONTAR: anula sus pasadas vigentes (con el motivo) y la deja esperando un nuevo conteo; mientras haya líneas por recontar no se puede aplicar.
 * Con el conteo en revisión, es lo único que admite nuevas pasadas.
 */
export async function solicitarRecuento(db: TenantPrismaClient, ctx: TenantContext, input: RecontarLineaInput): Promise<{ itemId: string; estado: 'RECONTAR'; pasadasAnuladas: number }> {
  exigirRevisor(ctx)
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const c = await bloquear(t, input.countId)
    exigirEstado(c, 'EN_REVISION')
    const l = await lineaDe(t, c.id, input.itemId)
    if (l.status === 'RECONTAR') throw invalido(`«${l.nameSnapshot}» ya está pendiente de recuento.`)
    const ahora = new Date()
    const anuladas = await t.inventoryCountEntry.updateMany({ where: { itemId: l.id, voidedAt: null }, data: { voidedAt: ahora, voidedById: ctx.userId, voidReason: `Recuento: ${input.reason}` } })
    await t.inventoryCountItem.update({
      where: { id: l.id },
      data: {
        status: 'RECONTAR', countedQty: null, lastCountedAt: null, systemQtyAtCount: null, difference: null, movedSinceCount: null, costAtApply: null,
        reviewedAt: null, reviewedById: null, reviewNote: input.reason, thresholdConfirmed: false,
      },
      select: { id: true },
    })
    await auditar(t, ctx, 'conteo.recuento_solicitado', c.id, { reason: input.reason, before: { linea: l.nameSnapshot, estado: l.status, contado: l.countedQty === null ? null : num(l.countedQty) }, after: { pasadasAnuladas: anuladas.count } })
    return { itemId: l.id, estado: 'RECONTAR' as const, pasadasAnuladas: anuladas.count }
  }, OPCIONES_TX)
}

export interface ResultadoAprobacion {
  itemId: string
  estado: 'APROBADO'
  diferencia: number
  sobreUmbral: boolean
}

/** Aprueba una línea contada: fija lo que se evaluó (sistema al contar, diferencia, movimientos posteriores). Una diferencia sobre el umbral exige confirmarla. */
export async function aprobarLinea(db: TenantPrismaClient, ctx: TenantContext, input: AprobarLineaInput): Promise<ResultadoAprobacion> {
  exigirRevisor(ctx)
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const c = await bloquear(t, input.countId)
    exigirEstado(c, 'EN_REVISION')
    const l = await lineaDe(t, c.id, input.itemId)
    if (l.status !== 'CONTADO' && l.status !== 'RECHAZADO') {
      throw invalido(l.status === 'APROBADO' ? `«${l.nameSnapshot}» ya está aprobada.` : `«${l.nameSnapshot}» no se puede aprobar: ${l.status === 'RECONTAR' ? 'está pendiente de recuento' : 'no tiene nada contado'}.`)
    }
    const costo = (await costosDe(t, [l.productId])).get(l.productId) ?? null
    const m = await medir(t, c.warehouseId, l, costo)
    if (m.ev === null || m.diferencia === null || m.sistema === null || m.contado === null) throw invalido(`«${l.nameSnapshot}» no tiene pasadas vigentes que aprobar.`)
    if (m.ev.sobreUmbral && !input.confirmaUmbral) {
      throw new BusinessError('COUNT_OVER_THRESHOLD', `La diferencia de «${l.nameSnapshot}» es grande (más del 10 % de lo esperado o de S/ 200): se recomienda recontarla. Si la apruebas igual, confírmalo expresamente.`)
    }
    await t.inventoryCountItem.update({
      where: { id: l.id },
      data: {
        status: 'APROBADO', reviewedAt: new Date(), reviewedById: ctx.userId, reviewNote: input.note ?? null, thresholdConfirmed: m.ev.sobreUmbral && input.confirmaUmbral,
        systemQtyAtCount: m.sistema, difference: m.diferencia, movedSinceCount: m.movidosDespues,
      },
      select: { id: true },
    })
    await auditar(t, ctx, 'conteo.linea_aprobada', c.id, {
      reason: input.note, after: { linea: l.nameSnapshot, contado: m.contado, sistemaAlContar: m.sistema, diferencia: m.diferencia, movimientosDesdeContar: m.movidosDespues, sobreUmbral: m.ev.sobreUmbral, confirmada: m.ev.sobreUmbral && input.confirmaUmbral },
    })
    return { itemId: l.id, estado: 'APROBADO' as const, diferencia: m.diferencia, sobreUmbral: m.ev.sobreUmbral }
  }, OPCIONES_TX)
}

/** Rechaza la diferencia de una línea: el stock se queda como está. */
export async function rechazarLinea(db: TenantPrismaClient, ctx: TenantContext, input: RechazarLineaInput): Promise<{ itemId: string; estado: 'RECHAZADO' }> {
  exigirRevisor(ctx)
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const c = await bloquear(t, input.countId)
    exigirEstado(c, 'EN_REVISION')
    const l = await lineaDe(t, c.id, input.itemId)
    if (l.status !== 'CONTADO' && l.status !== 'APROBADO') throw invalido(`«${l.nameSnapshot}» no se puede rechazar: ${l.status === 'RECHAZADO' ? 'ya está rechazada' : l.status === 'RECONTAR' ? 'está pendiente de recuento' : 'no tiene nada contado'}.`)
    await t.inventoryCountItem.update({
      where: { id: l.id },
      data: { status: 'RECHAZADO', reviewedAt: new Date(), reviewedById: ctx.userId, reviewNote: input.reason, thresholdConfirmed: false, systemQtyAtCount: null, difference: null, movedSinceCount: null },
      select: { id: true },
    })
    await auditar(t, ctx, 'conteo.linea_rechazada', c.id, { reason: input.reason, before: { linea: l.nameSnapshot, estado: l.status, contado: l.countedQty === null ? null : num(l.countedQty) } })
    return { itemId: l.id, estado: 'RECHAZADO' as const }
  }, OPCIONES_TX)
}

export interface ResultadoAprobacionMasiva {
  aprobadas: number
  /** Líneas que se dejaron para revisar a mano (sobre el umbral, sin costo, movidas o que dejarían el stock en negativo). */
  conAlerta: number
  /** Para seguir con la siguiente tanda; `null` si no quedan líneas contadas por evaluar. */
  siguiente: string | null
}

/**
 * Aprueba, por tandas, las líneas contadas que NO tienen ninguna alerta: sin diferencia, o con una diferencia pequeña, con costo, sin movimientos posteriores a contar
 * y que no dejaría el stock en negativo. Las demás se dejan para revisar a mano.
 */
export async function aprobarLineasSinAlerta(db: TenantPrismaClient, ctx: TenantContext, input: AprobarSinAlertaInput): Promise<ResultadoAprobacionMasiva> {
  exigirRevisor(ctx)
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const c = await bloquear(t, input.countId)
    exigirEstado(c, 'EN_REVISION')
    const filas = await t.inventoryCountItem.findMany({
      where: { countId: c.id, status: 'CONTADO' }, orderBy: { id: 'asc' }, take: LOTE_APROBACION + 1, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: { id: true, productId: true, variantId: true, nameSnapshot: true, countedQty: true },
    })
    const hayMas = filas.length > LOTE_APROBACION
    const lote = hayMas ? filas.slice(0, LOTE_APROBACION) : filas
    const costos = await costosDe(t, lote.map((l) => l.productId))
    const stockRows = lote.length ? await t.stock.findMany({ where: { warehouseId: c.warehouseId, productId: { in: [...new Set(lote.map((l) => l.productId))] } }, select: { productId: true, variantId: true, quantity: true } }) : []
    let aprobadas = 0, conAlerta = 0
    for (const l of lote) {
      const m = await medir(t, c.warehouseId, l, costos.get(l.productId) ?? null)
      if (m.ev === null || m.diferencia === null || m.sistema === null) { conAlerta++; continue }
      const actual = num(stockRows.find((s) => s.productId === l.productId && s.variantId === l.variantId)?.quantity)
      const hayDiferencia = m.diferencia !== 0
      const limpia = !m.ev.sobreUmbral && (!hayDiferencia || (!m.ev.sinCosto && m.movidosDespues === 0 && stockTrasAplicar(actual, m.diferencia) >= 0))
      if (!limpia) { conAlerta++; continue }
      await t.inventoryCountItem.update({
        where: { id: l.id },
        data: { status: 'APROBADO', reviewedAt: new Date(), reviewedById: ctx.userId, reviewNote: null, thresholdConfirmed: false, systemQtyAtCount: m.sistema, difference: m.diferencia, movedSinceCount: m.movidosDespues },
        select: { id: true },
      })
      aprobadas++
    }
    await auditar(t, ctx, 'conteo.aprobacion_masiva', c.id, { after: { aprobadas, conAlerta } })
    return { aprobadas, conAlerta, siguiente: hayMas ? lote[lote.length - 1]!.id : null }
  }, OPCIONES_TX)
}

// ─── Aplicar ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ResultadoAplicacion {
  estado: 'EN_REVISION' | 'APLICADO'
  /** Movimientos de stock generados en ESTA tanda. */
  movimientos: number
  sobrantes: number
  faltantes: number
  /** Unidades netas que se sumaron (positivo) o restaron (negativo) al stock en esta tanda. */
  unidadesNetas: number
  /** Líneas aprobadas que todavía faltan por aplicar (se aplican en la siguiente tanda); 0 si el conteo quedó APLICADO. */
  pendientes: number
  /** Productos que se ajustaron sin costo (solo se informan a quien ve costos). */
  sinCosto?: string[]
}

/**
 * Aplica el conteo: por cada línea aprobada con diferencia, un `AJUSTE` RELATIVO (`nuevo = stock de ahora + diferencia`) con la fila de stock bloqueada, de origen `CONTEO` y
 * enlazado al conteo. Todo o nada POR TANDA (si una línea dejaría el stock en negativo, la tanda entera se deshace y se nombra el producto). Cuando no quedan líneas por aplicar,
 * el conteo pasa a APLICADO. Exige que no haya líneas por recontar ni contadas sin decidir.
 */
export async function aplicarConteo(db: TenantPrismaClient, ctx: TenantContext, input: AplicarConteoInput, opciones: { lote?: number } = {}): Promise<ResultadoAplicacion> {
  exigirRevisor(ctx)
  const lote = Math.max(1, Math.floor(opciones.lote ?? LOTE_APLICACION))
  const verCostos = puede(ctx, 'productos.ver_costo')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const c = await bloquear(t, input.countId)
    exigirEstado(c, 'EN_REVISION')

    const [porRecontar, sinDecidir] = await Promise.all([
      t.inventoryCountItem.count({ where: { countId: c.id, status: 'RECONTAR' } }),
      t.inventoryCountItem.count({ where: { countId: c.id, status: 'CONTADO' } }),
    ])
    if (porRecontar > 0) throw invalido(`Hay ${porRecontar} línea(s) por recontar: cuéntalas de nuevo antes de aplicar.`)
    if (sinDecidir > 0) throw invalido(`Hay ${sinDecidir} línea(s) contadas sin aprobar ni rechazar: revísalas antes de aplicar.`)

    // Quien fue el ÚNICO contador no aplica su propio conteo. El dueño sí (se le reconoce por `plan.gestionar`, que solo él tiene: el inventario es suyo y un negocio de una persona no puede quedar bloqueado).
    const contadores = await t.inventoryCountEntry.findMany({ where: { countId: c.id, voidedAt: null }, distinct: ['userId'], select: { userId: true } })
    if (contadores.length === 1 && contadores[0]!.userId === ctx.userId && !puede(ctx, 'plan.gestionar')) {
      throw new BusinessError('FORBIDDEN_ROLE', 'Quien contó no aplica su propio conteo: que lo apruebe y lo aplique otra persona con permiso para ajustar el stock.')
    }

    const pendientes = await t.inventoryCountItem.findMany({
      where: { countId: c.id, status: 'APROBADO', resultingMovementId: null, difference: { not: 0 } },
      orderBy: [{ productId: 'asc' }, { variantId: 'asc' }, { id: 'asc' }], take: lote,
      select: { id: true, productId: true, variantId: true, nameSnapshot: true, countedQty: true },
    })

    let movimientos = 0, sobrantes = 0, faltantes = 0, neto = 0
    const sinCosto: string[] = []
    for (const l of pendientes) {
      const f = { warehouseId: c.warehouseId, productId: l.productId, variantId: l.variantId }
      // Se TOCA la fila de stock (sin cambiar nada) para tenerla bloqueada hasta el final: nadie más la mueve entre leerla y ajustarla.
      const fila = await t.stock.findFirst({ where: f, select: { id: true } })
      const bloqueada = fila ? await t.stock.update({ where: { id: fila.id }, data: { updatedAt: new Date() }, select: { quantity: true, version: true } }) : null
      const actual = bloqueada ? num(bloqueada.quantity) : 0
      const version = bloqueada ? bloqueada.version : 0

      const costo = (await costosDe(t, [l.productId])).get(l.productId) ?? null
      const m = await medir(t, c.warehouseId, l, costo)
      if (m.diferencia === null || m.sistema === null) throw invalido(`«${l.nameSnapshot}» ya no tiene pasadas vigentes: revísala de nuevo.`)
      if (m.diferencia === 0) {
        await t.inventoryCountItem.update({ where: { id: l.id }, data: { systemQtyAtCount: m.sistema, difference: 0, movedSinceCount: m.movidosDespues }, select: { id: true } })
        continue
      }
      const nuevo = stockTrasAplicar(actual, m.diferencia)
      if (nuevo < 0) {
        throw invalido(`«${l.nameSnapshot}» quedaría con stock negativo (${nuevo}): hoy hay ${actual} y la diferencia es ${m.diferencia}. Mándala a recontar y vuelve a aplicar.`)
      }
      const motivo = `Toma de inventario ${c.number}: ${m.diferencia > 0 ? 'sobrante' : 'faltante'} de ${Math.abs(m.diferencia)}${input.note ? ` · ${input.note}` : ''}`
      const mov = await applyStockMovement(t, ctx, { type: 'AJUSTE', productId: l.productId, variantId: l.variantId, warehouseId: c.warehouseId, quantity: nuevo, reason: motivo, expectedVersion: version, source: 'CONTEO' } as never)
      const sinValor = costo === null || !(costo > 0)
      await t.stockMovement.update({
        where: { id: mov.movementId },
        data: { referenceType: 'CONTEO', referenceId: c.id, ...(sinValor ? { unitCostApplied: null } : {}) },
        select: { id: true },
      })
      await t.inventoryCountItem.update({
        where: { id: l.id },
        data: { systemQtyAtCount: m.sistema, difference: m.diferencia, movedSinceCount: m.movidosDespues, costAtApply: sinValor ? null : costo, resultingMovementId: mov.movementId },
        select: { id: true },
      })
      movimientos++
      if (m.diferencia > 0) sobrantes++; else faltantes++
      neto = r4(neto + m.diferencia)
      if (sinValor) sinCosto.push(l.nameSnapshot)
    }

    const quedan = await t.inventoryCountItem.count({ where: { countId: c.id, status: 'APROBADO', resultingMovementId: null, difference: { not: 0 } } })
    let estado: ResultadoAplicacion['estado'] = 'EN_REVISION'
    if (quedan === 0) {
      const ok = await t.inventoryCount.updateMany({ where: { id: c.id, status: 'EN_REVISION' }, data: { status: 'APLICADO', appliedAt: new Date(), appliedById: ctx.userId } })
      if (ok.count !== 1) throw invalido('La toma de inventario cambió mientras se aplicaba. Vuelve a cargarla.')
      estado = 'APLICADO'
    }
    await auditar(t, ctx, estado === 'APLICADO' ? 'conteo.aplicar' : 'conteo.aplicar_parcial', c.id, {
      reason: input.note, after: { numero: c.number, movimientos, sobrantes, faltantes, unidadesNetas: neto, pendientes: quedan, sinCosto: sinCosto.length },
    })
    return { estado, movimientos, sobrantes, faltantes, unidadesNetas: neto, pendientes: quedan, ...(verCostos ? { sinCosto } : {}) }
  }, { maxWait: 15_000, timeout: 120_000 })
}
