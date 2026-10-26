import { BusinessError } from '@/lib/errors'
import { resolverPagos, type MetodoPago, type OpcionesPagos, type PagoResuelto } from './pagos'

/**
 * Lo que la pantalla del POS necesita saber de los pagos que el cajero va tecleando. Lógica PURA, en céntimos, sin servidor.
 *
 * Una sola fuente de verdad: para decidir si «cuadra» o qué mensaje dar, esto llama a `resolverPagos` —la MISMA función con que
 * `registerSale` valida el cobro—. Si la pantalla reimplementara las reglas, tarde o temprano mostraría «listo para cobrar» y el
 * servidor rechazaría (o al revés). Aquí solo se agrega lo que la pantalla necesita y el servidor no: líneas aún vacías, cuánto
 * falta y el atajo «Fiado por el saldo».
 */

export interface LineaPago { method: MetodoPago; amount: number }

export type EstadoPagos =
  | { estado: 'FALTA'; falta: number }
  /** Cubre el total (con vuelto o fiado si corresponde) y cumple todas las reglas. */
  | { estado: 'LISTO'; vuelto: number; fiado: number; pagado: number; resueltos: PagoResuelto[] }
  /** Cubre el total pero rompe una regla (más de una línea de fiado, sin cliente, factura, vuelto sin efectivo…). */
  | { estado: 'ERROR'; mensaje: string; codigo: string }

const aCentimos = (n: number) => Math.round(n * 100)
const deCentimos = (c: number) => c / 100

/** Las líneas con importe vacío o cero son filas recién añadidas que aún no se rellenaron: no cuentan. */
export function lineasConImporte(lineas: readonly LineaPago[]): LineaPago[] {
  return lineas.filter((l) => Number.isFinite(l.amount) && l.amount !== 0)
}

export function evaluarPagos(total: number, lineas: readonly LineaPago[], opciones: OpcionesPagos = {}): EstadoPagos {
  const v = lineasConImporte(lineas)
  const T = aCentimos(total)
  const S = v.reduce((s, l) => s + aCentimos(l.amount), 0)
  if (v.length === 0 || (S < T && v.every((l) => l.amount > 0 && Math.abs(l.amount * 100 - aCentimos(l.amount)) < 1e-6))) {
    return { estado: 'FALTA', falta: deCentimos(T - S) }
  }
  try {
    const r = resolverPagos(total, v, opciones)
    return { estado: 'LISTO', vuelto: r.vuelto, fiado: r.credito, pagado: r.pagado, resueltos: r.pagos }
  } catch (e) {
    if (e instanceof BusinessError) return { estado: 'ERROR', mensaje: e.message, codigo: e.code }
    throw e
  }
}

/** Lo que falta por cobrar contando solo el dinero que entra (sin la línea de fiado). Nunca negativo. */
export function saldoPorCobrar(total: number, lineas: readonly LineaPago[]): number {
  const cobrado = lineasConImporte(lineas).filter((l) => l.method !== 'CREDITO').reduce((s, l) => s + aCentimos(l.amount), 0)
  return deCentimos(Math.max(0, aCentimos(total) - cobrado))
}

/**
 * «Fiado por el saldo»: deja UNA línea de fiado por lo que falta. Reemplaza la que hubiera. Si ya no falta nada, quita el fiado en
 * vez de dejar una línea de cero. Un sobrepago en efectivo (vuelto) no se mezcla con la deuda: el saldo es el que falta, no más.
 */
export function conFiadoPorElSaldo(total: number, lineas: readonly LineaPago[]): LineaPago[] {
  const sin = lineas.filter((l) => l.method !== 'CREDITO')
  const saldo = saldoPorCobrar(total, sin)
  return saldo > 0 ? [...sin, { method: 'CREDITO', amount: saldo }] : sin
}

/** El cobro de siempre, de un toque: un método y, si es efectivo, lo recibido (o el total exacto). Con otros medios se cobra el total. */
export function lineaUnica(method: MetodoPago, total: number, recibido?: number): LineaPago[] {
  const entregado = method === 'EFECTIVO' ? recibido || total : total
  return [{ method, amount: Math.max(entregado, total) }]
}

export interface DisponibilidadFiado { ofrece: boolean; motivo: string | null }

/**
 * ¿Se muestra el botón de fiado? Solo si el usuario puede fiar, hay cliente, el comprobante no es factura y no es un pedido de la
 * cola (el fiado de pedidos queda fuera por ahora). Lo que no se ofrece se calla; el motivo es para el texto de ayuda.
 */
export function disponibilidadFiado(o: { puedeFiar: boolean; conCliente: boolean; documentType?: string; enPedido?: boolean }): DisponibilidadFiado {
  if (!o.puedeFiar) return { ofrece: false, motivo: null }
  if (o.enPedido) return { ofrece: false, motivo: 'El fiado se cobra desde el POS, no desde un pedido de la cola.' }
  if (o.documentType === 'FACTURA') return { ofrece: false, motivo: 'La factura a crédito todavía no está disponible: emite nota de venta o boleta.' }
  if (!o.conCliente) return { ofrece: false, motivo: 'Asigna un cliente con DNI o RUC para poder fiar.' }
  return { ofrece: true, motivo: null }
}
