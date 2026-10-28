/**
 * Devolución PARCIAL por líneas (F6.2a): el cálculo, como funciones PURAS y en ENTEROS. Diseño: docs/F6.2-DISENO.md.
 *
 *  · Cantidades en DIEZMILÉSIMAS de unidad base (la columna es Decimal(14,4)); importes en CÉNTIMOS. Los productos intermedios usan BigInt.
 *  · El importe de lo devuelto se calcula sobre lo ACUMULADO, no por tramo: `round(T·c/Q) − round(T·c_previo/Q)`. Así devolver una línea en 2, 3 o N
 *    partes suma EXACTAMENTE su `lineTotal`, sin céntimo huérfano y sin poder devolver de más. El IGV se reparte sobre ese importe acumulado y la
 *    base es la diferencia: base e IGV no decrecen nunca (ningún tramo sale negativo) y suman la base y el IGV de la línea entera.
 *  · El descuento ya está dentro de `lineTotal` (es neto): se reparte proporcionalmente sin más.
 */
import { redondearCentimos } from '@/lib/dinero'

export const CODIGO_NOTA_PARCIAL = '07' as const
/** ⚠️ Operativa, a validar con el contador: a partir de cuántos días de la venta se avisa (no se bloquea) al devolver. */
export const UMBRAL_ADVERTENCIA_DEVOLUCION_DIAS = 30

export type DestinoDevolucion = 'STOCK' | 'MERMA' | 'SIN_STOCK'

const MIL = 10_000
const big = (n: number) => BigInt(n)

/** División entera con redondeo «medio hacia arriba» de enteros no negativos. */
export function divRedondeada(a: bigint, b: bigint): bigint {
  if (b <= 0n || a < 0n) throw new RangeError('divRedondeada: solo enteros no negativos y divisor positivo')
  return (2n * a + b) / (2n * b)
}

/** Unidades (hasta 4 decimales) → diezmilésimas enteras. Lanza si trae más decimales o no es finito/positivo. */
export function aDiezmilesimas(n: number | string): number {
  const v = typeof n === 'string' ? Number(n) : n
  if (!Number.isFinite(v) || v < 0) throw new RangeError('La cantidad debe ser un número positivo.')
  const m = Math.round(v * MIL)
  if (Math.abs(v * MIL - m) > 1e-6) throw new RangeError('La cantidad lleva como máximo 4 decimales.')
  return m
}
export const deDiezmilesimas = (m: number): number => m / MIL

// ─── El reparto de una línea ────────────────────────────────────────────────────────────────────────────────────────────────

export interface LineaParaDevolver {
  /** `lineTotal` de la venta, en céntimos (neto de descuento, con IGV). */
  totalCent: number
  /** Cantidad vendida, en diezmilésimas de unidad base. */
  vendidaM: number
  /** Tasa de IGV de la línea (0.18, 0 si exonerada). */
  tasa: number
}

export interface Acumulado { importeCent: number; baseCent: number; igvCent: number }

/** La base de la línea completa: la MISMA expresión con la que la venta (y el envío del comprobante) la extraen del total con IGV. */
export function baseDeLineaCent(totalCent: number, tasa: number): number {
  const neto = totalCent / 100
  return Math.round(redondearCentimos(neto / (1 + tasa)) * 100)
}

/**
 * Lo que corresponde a haber devuelto `devueltaM` unidades de la línea (acumulado). `devueltaM = vendidaM` da exactamente la línea entera.
 *  · importe = round(T · c / Q), la fórmula acordada, tal cual.
 *  · IGV = round(G · importe / T) con G = IGV de la línea entera: crece con el importe y su aumento nunca supera al del importe (G ≤ T), así que
 *    base = importe − IGV tampoco decrece: ningún tramo sale negativo, y al devolverlo todo suman exactamente T, G y la base de la línea.
 */
export function acumulado(l: LineaParaDevolver, devueltaM: number): Acumulado {
  if (!Number.isInteger(devueltaM) || devueltaM < 0 || devueltaM > l.vendidaM) throw new RangeError('Cantidad devuelta fuera de lo vendido.')
  if (l.vendidaM <= 0) throw new RangeError('La línea no tiene cantidad vendida.')
  const importe = Number(divRedondeada(big(l.totalCent) * big(devueltaM), big(l.vendidaM)))
  const igvTotal = l.totalCent - baseDeLineaCent(l.totalCent, l.tasa)
  const igv = l.totalCent === 0 ? 0 : Number(divRedondeada(big(igvTotal) * big(importe), big(l.totalCent)))
  return { importeCent: importe, igvCent: igv, baseCent: importe - igv }
}

export interface TramoDevuelto {
  /** Unidades de este tramo (diezmilésimas) y lo acumulado después de él. */
  cantidadM: number
  nuevaDevueltaM: number
  importeCent: number
  baseCent: number
  igvCent: number
  /** ¿Con este tramo la línea queda devuelta por completo? */
  completaLinea: boolean
}

/** El tramo que se devuelve ahora: lo acumulado después menos lo acumulado antes. */
export function tramo(l: LineaParaDevolver, yaDevueltaM: number, cantidadM: number): TramoDevuelto {
  if (!Number.isInteger(cantidadM) || cantidadM <= 0) throw new RangeError('La cantidad a devolver debe ser mayor que cero.')
  const antes = acumulado(l, yaDevueltaM)
  const despuesM = yaDevueltaM + cantidadM
  const despues = acumulado(l, despuesM)
  return {
    cantidadM, nuevaDevueltaM: despuesM,
    importeCent: despues.importeCent - antes.importeCent, baseCent: despues.baseCent - antes.baseCent, igvCent: despues.igvCent - antes.igvCent,
    completaLinea: despuesM === l.vendidaM,
  }
}

// ─── Validación de lo que se pide devolver ─────────────────────────────────────────────────────────────────────────────────────

export interface LineaVendida extends LineaParaDevolver {
  id: string
  nombre: string
  trackStock: boolean
  yaDevueltaM: number
  /** Lo guardado en `sale_items.returnedAmount` (céntimos): debe coincidir con lo que da la fórmula para `yaDevueltaM`. */
  yaDevueltoImporteCent: number
}
export interface PedidoLinea { saleItemId: string; cantidad: number; destino: 'STOCK' | 'MERMA' }
export interface LineaResuelta extends TramoDevuelto {
  saleItemId: string
  nombre: string
  destino: DestinoDevolucion
  trackStock: boolean
  tasa: number
  /** Cantidad que quedaba por devolver antes de este tramo (diezmilésimas). */
  pendienteAntesM: number
}

export type ResultadoLineas = { ok: true; lineas: LineaResuelta[]; totalCent: number; baseCent: number; igvCent: number; completaVenta: boolean } | { ok: false; mensaje: string }

const unidades = (m: number) => String(deDiezmilesimas(m))

/**
 * Comprueba lo pedido contra lo vendido y lo ya devuelto. Devuelve cada tramo con su importe, base e IGV, el total de la devolución y si con ella
 * la venta queda sin nada por devolver. Una línea de un producto SIN control de stock (servicio) va siempre a `SIN_STOCK`; mandarla a merma se rechaza.
 */
export function resolverLineas(vendidas: readonly LineaVendida[], pedido: readonly PedidoLinea[]): ResultadoLineas {
  if (pedido.length === 0) return { ok: false, mensaje: 'Elige al menos un producto para devolver.' }
  const porId = new Map(vendidas.map((v) => [v.id, v]))
  const vistos = new Set<string>()
  const lineas: LineaResuelta[] = []
  for (const p of pedido) {
    const v = porId.get(p.saleItemId)
    if (!v) return { ok: false, mensaje: 'Una de las líneas no pertenece a esta venta.' }
    if (vistos.has(p.saleItemId)) return { ok: false, mensaje: `«${v.nombre}» aparece dos veces: indica una sola cantidad por producto.` }
    vistos.add(p.saleItemId)
    let m: number
    try { m = aDiezmilesimas(p.cantidad) } catch (e) { return { ok: false, mensaje: `«${v.nombre}»: ${(e as Error).message}` } }
    if (m <= 0) return { ok: false, mensaje: `«${v.nombre}»: la cantidad a devolver debe ser mayor que cero.` }
    const pendiente = v.vendidaM - v.yaDevueltaM
    if (m > pendiente) {
      return { ok: false, mensaje: pendiente === 0
        ? `«${v.nombre}» ya se devolvió por completo.`
        : `«${v.nombre}»: solo quedan ${unidades(pendiente)} por devolver (se vendieron ${unidades(v.vendidaM)} y ya se devolvieron ${unidades(v.yaDevueltaM)}).` }
    }
    if (acumulado(v, v.yaDevueltaM).importeCent !== v.yaDevueltoImporteCent) {
      return { ok: false, mensaje: `«${v.nombre}»: lo devuelto antes no cuadra con su importe. No se puede seguir devolviendo hasta revisarlo.` }
    }
    if (!v.trackStock && p.destino === 'MERMA') return { ok: false, mensaje: `«${v.nombre}» no controla stock: no puede ir a merma.` }
    const t = tramo(v, v.yaDevueltaM, m)
    if (t.importeCent === 0 && v.totalCent > 0) return { ok: false, mensaje: `«${v.nombre}»: esa cantidad es demasiado pequeña para valer un céntimo.` }
    lineas.push({ ...t, saleItemId: v.id, nombre: v.nombre, destino: v.trackStock ? p.destino : 'SIN_STOCK', trackStock: v.trackStock, tasa: v.tasa, pendienteAntesM: pendiente })
  }
  const sum = (f: (l: LineaResuelta) => number) => lineas.reduce((a, l) => a + f(l), 0)
  const devueltasAhora = new Map(lineas.map((l) => [l.saleItemId, l.nuevaDevueltaM]))
  const completaVenta = vendidas.every((v) => (devueltasAhora.get(v.id) ?? v.yaDevueltaM) === v.vendidaM)
  return { ok: true, lineas, totalCent: sum((l) => l.importeCent), baseCent: sum((l) => l.baseCent), igvCent: sum((l) => l.igvCent), completaVenta }
}

// ─── Deuda y dinero ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type AccionCuenta = 'NINGUNA' | 'REDUCIR' | 'CERRAR_PAGADA' | 'DAR_DE_BAJA'
export type ReparteDeudaDinero =
  | { ok: true; deudaCent: number; dineroCent: number; accion: AccionCuenta }
  | { ok: false; code: 'CREDIT_HAS_PAYMENTS' | 'INVALID_DOCUMENT'; mensaje: string; topeCent: number }

export interface EstadoCuenta { status: 'ABIERTA' | 'PAGADA' | 'ANULADA'; amountCent: number; paidCent: number }

/**
 * Reparte lo devuelto `totalCent` entre la deuda del cliente y el dinero: PRIMERO contra el saldo pendiente de la cuenta por cobrar (fiado), y el
 * resto es dinero que se devuelve de lo pagado al contado (`contadoRestanteCent`: lo pagado sin vuelto menos lo ya devuelto).
 * Si el dinero excede lo pagado al contado, devolverlo obligaría a reembolsar un abono ya cobrado: se bloquea (F6.3).
 */
export function repartirDeudaYDinero(totalCent: number, cuenta: EstadoCuenta | null, contadoRestanteCent: number): ReparteDeudaDinero {
  const saldo = cuenta && cuenta.status === 'ABIERTA' ? cuenta.amountCent - cuenta.paidCent : 0
  const deuda = Math.min(totalCent, saldo)
  const dinero = totalCent - deuda
  if (dinero > contadoRestanteCent) {
    const tope = saldo + contadoRestanteCent
    const abonos = cuenta && cuenta.paidCent > 0
    return abonos
      ? { ok: false, code: 'CREDIT_HAS_PAYMENTS', topeCent: tope, mensaje: `Esta venta fiada ya tiene abonos cobrados: se puede devolver hasta S/ ${(tope / 100).toFixed(2)} (el saldo pendiente más lo pagado al contado). Devolver más obligaría a reembolsar un abono, algo que llegará con los movimientos manuales de caja.` }
      : { ok: false, code: 'INVALID_DOCUMENT', topeCent: tope, mensaje: `Lo devuelto (S/ ${(totalCent / 100).toFixed(2)}) supera lo que se puede devolver de esta venta (S/ ${(tope / 100).toFixed(2)}).` }
  }
  if (deuda === 0) return { ok: true, deudaCent: 0, dineroCent: dinero, accion: 'NINGUNA' }
  const accion: AccionCuenta = deuda < saldo ? 'REDUCIR' : cuenta!.paidCent > 0 ? 'CERRAR_PAGADA' : 'DAR_DE_BAJA'
  return { ok: true, deudaCent: deuda, dineroCent: dinero, accion }
}

/** Lo que de verdad se puede devolver ahora (para mostrarlo y como tope): saldo pendiente + lo pagado al contado que sigue sin devolver. */
export const topeDevolvibleCent = (cuenta: EstadoCuenta | null, contadoRestanteCent: number): number =>
  (cuenta && cuenta.status === 'ABIERTA' ? cuenta.amountCent - cuenta.paidCent : 0) + contadoRestanteCent

export interface MedioRestante { method: string; cent: number }

/**
 * Lo pagado al contado que sigue sin devolverse, por medio: lo pagado (sin vuelto) menos lo ya reembolsado con ese medio. Un reembolso «sin salida»
 * (sin medio) resta del total, no de un medio: se reparte en proporción para que la suma siga siendo la verdad.
 */
export function contadoRestante(pagadoPorMedio: readonly MedioRestante[], reembolsados: readonly { method: string | null; cent: number }[]): { totalCent: number; porMedio: MedioRestante[] } {
  const por = new Map(pagadoPorMedio.map((m) => [m.method, m.cent]))
  let sinMedio = 0
  for (const r of reembolsados) {
    if (r.method && por.has(r.method)) por.set(r.method, Math.max(0, por.get(r.method)! - r.cent))
    else sinMedio += r.cent
  }
  let porMedio = [...por].map(([method, cent]) => ({ method, cent })).filter((m) => m.cent > 0).sort((a, b) => (a.method < b.method ? -1 : 1))
  if (sinMedio > 0) porMedio = repartirProporcional(-sinMedio, porMedio)
  return { totalCent: porMedio.reduce((a, m) => a + m.cent, 0), porMedio }
}

/** Reparte `totalCent` (positivo) en proporción a los pesos con el método del resto mayor, sin pasarse de lo que tiene cada uno. */
export function repartirEnProporcion(totalCent: number, pesos: readonly MedioRestante[]): MedioRestante[] {
  const suma = pesos.reduce((a, p) => a + p.cent, 0)
  if (totalCent < 0 || totalCent > suma) throw new RangeError('No se puede repartir más de lo disponible.')
  if (suma === 0) return []
  const base = pesos.map((p) => Number((big(totalCent) * big(p.cent)) / big(suma)))
  const resto = pesos.map((p, i) => ({ i, r: Number((big(totalCent) * big(p.cent)) % big(suma)) }))
  let faltan = totalCent - base.reduce((a, b) => a + b, 0)
  for (const x of [...resto].sort((a, b) => b.r - a.r || a.i - b.i)) {
    if (faltan === 0) break
    if (base[x.i]! < pesos[x.i]!.cent) { base[x.i]!++; faltan-- }
  }
  return pesos.map((p, i) => ({ method: p.method, cent: base[i]! })).filter((p) => p.cent > 0)
}

/** Quita `-totalCent` (negativo) a los pesos en proporción: lo que queda tras un reembolso sin medio. */
function repartirProporcional(menosCent: number, pesos: readonly MedioRestante[]): MedioRestante[] {
  const suma = pesos.reduce((a, p) => a + p.cent, 0)
  const quitar = Math.min(-menosCent, suma)
  const quitado = repartirEnProporcion(quitar, pesos)
  const q = new Map(quitado.map((x) => [x.method, x.cent]))
  return pesos.map((p) => ({ method: p.method, cent: p.cent - (q.get(p.method) ?? 0) })).filter((p) => p.cent > 0)
}

// ─── Aviso de antigüedad (no bloquea) ───────────────────────────────────────────────────────────────────────────────────────────

/** Días enteros (del calendario del negocio) entre el día de la venta y hoy; `dias > UMBRAL` → aviso informativo. */
export function avisoAntiguedad(diaVenta: string, diaHoy: string): { dias: number; avisar: boolean } {
  const a = Date.UTC(+diaVenta.slice(0, 4), +diaVenta.slice(5, 7) - 1, +diaVenta.slice(8, 10))
  const b = Date.UTC(+diaHoy.slice(0, 4), +diaHoy.slice(5, 7) - 1, +diaHoy.slice(8, 10))
  const dias = Math.max(0, Math.round((b - a) / 86_400_000))
  return { dias, avisar: dias > UMBRAL_ADVERTENCIA_DEVOLUCION_DIAS }
}

// ─── Comprobante de una devolución parcial ──────────────────────────────────────────────────────────────────────────────────────

export type PlanComprobanteParcial =
  | { accion: 'NINGUNA' }
  | { accion: 'MARCAR_ENSAYO' }
  | { accion: 'EMITIR_NOTA'; codigo: typeof CODIGO_NOTA_PARCIAL }
  | { accion: 'BLOQUEAR'; mensaje: string }

/**
 * Misma regla que la devolución total (F6.1) con el código 07 (⚠️ devolución por ítem, sin validar): ACEPTADO u OBSERVADO → nota parcial;
 * PENDIENTE o ENVIADO → bloquea; RECHAZADO, ANULADO o sin comprobante → nada. El de ensayo no lleva nota: solo se marca anulado cuando la
 * devolución deja la venta sin nada por devolver (`completaVenta`).
 */
export function planDeComprobanteParcial(
  doc: { estado: 'PENDIENTE' | 'ENVIADO' | 'ACEPTADO' | 'OBSERVADO' | 'RECHAZADO' | 'ANULADO'; isTrial: boolean; numero: string } | null,
  completaVenta: boolean,
): PlanComprobanteParcial {
  if (!doc) return { accion: 'NINGUNA' }
  if (doc.isTrial) return completaVenta ? { accion: 'MARCAR_ENSAYO' } : { accion: 'NINGUNA' }
  if (doc.estado === 'RECHAZADO' || doc.estado === 'ANULADO') return { accion: 'NINGUNA' }
  if (doc.estado === 'PENDIENTE' || doc.estado === 'ENVIADO') {
    return { accion: 'BLOQUEAR', mensaje: `El comprobante ${doc.numero} aún está en la cola fiscal (${doc.estado.toLowerCase()}). Espera la respuesta de SUNAT, o resuélvelo, antes de devolver productos de la venta.` }
  }
  return { accion: 'EMITIR_NOTA', codigo: CODIGO_NOTA_PARCIAL }
}
