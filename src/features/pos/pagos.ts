import { BusinessError } from '@/lib/errors'

/**
 * Reglas de los pagos de una venta (pagos mixtos). Lógica pura, en CÉNTIMOS enteros: sin flotantes que arrastren ruido.
 *
 * ─── EL DINERO DE UNA VENTA ──────────────────────────────────────────────
 *
 *   Σ pagos − Σ vuelto = total        (siempre, al céntimo)
 *
 *  · El vuelto SOLO sale del efectivo: lo pagado con Yape, tarjeta o transferencia no se devuelve en el mostrador. Si lo no
 *    efectivo ya supera el total, se rechaza en vez de inventar un vuelto que el cajón no tiene.
 *  · El vuelto se registra en las líneas de EFECTIVO (en orden, sin pasar de lo que recibió cada una), NUNCA en «el primer
 *    pago»: antes solo se guardaba si el primero era efectivo, y con `[Yape 50, efectivo 60]` sobre 100 el vuelto de 10 se
 *    perdía y el cierre de caja esperaba 10 de más en el cajón.
 *
 * ─── FIADO (`CREDITO`) ───────────────────────────────────────────────────
 *
 * La línea CREDITO es lo que se FINANCIA, no dinero que entra. Reglas, todas estrictas:
 *
 *  · Una sola línea de crédito por venta.
 *  · Con cliente identificado: no hay fiado a «público general».
 *  · Nunca con factura (necesita forma de pago y cuotas en el XML, que no están soportadas): nota de venta o boleta.
 *  · El total CUADRA EXACTO, sin vuelto: lo que se paga más lo que se fía es el total. Un fiado con sobrepago en efectivo
 *    mezclaría el vuelto con la deuda; la pantalla ofrece «Fiado por el saldo», que lo calcula.
 *
 * Esta función solo valida y reparte. Que el cliente exista, no esté bloqueado y tenga línea disponible lo decide el servicio de
 * crédito, dentro de la transacción de la venta.
 */

export type MetodoPago = 'EFECTIVO' | 'TARJETA_DEBITO' | 'TARJETA_CREDITO' | 'TRANSFERENCIA' | 'YAPE' | 'PLIN' | 'CREDITO' | 'OTRO'

export interface PagoEntrada { method: MetodoPago; amount: number; reference?: string }
export interface PagoResuelto { method: MetodoPago; amount: number; reference: string | null; change: number }
export interface PagosResueltos {
  pagos: PagoResuelto[]
  /** Σ pagos (incluye lo fiado: cubre el total). */
  pagado: number
  /** Vuelto total entregado. */
  vuelto: number
  /** Monto financiado (la línea CREDITO); 0 si la venta no se fía. */
  credito: number
}

export interface OpcionesPagos {
  /** La venta lleva un cliente (`customerId`). Obligatorio para fiar. */
  conCliente?: boolean
  /** Tipo de comprobante pedido. La factura no admite fiado. */
  documentType?: string
}

export const MENSAJE_SIN_FIADO = 'La venta a crédito (fiado) todavía no está disponible.'
export const MENSAJE_FIADO_CLIENTE = 'El fiado necesita un cliente identificado con DNI o RUC: no se fía a «público general».'
export const MENSAJE_FIADO_UNA_LINEA = 'Una venta admite una sola línea de fiado.'
export const MENSAJE_FIADO_FACTURA = 'La factura a crédito todavía no está disponible: emite nota de venta o boleta.'
export const MENSAJE_FIADO_EXACTO = 'Con fiado el pago debe cuadrar exacto, sin vuelto: usa «Fiado por el saldo».'

const aCentimos = (n: number) => Math.round(n * 100)
const deCentimos = (c: number) => c / 100
const invalido = (m: string, d?: Record<string, string | number>) => new BusinessError('INVALID_DOCUMENT', m, d)

export function resolverPagos(total: number, pagos: readonly PagoEntrada[], opciones: OpcionesPagos = {}): PagosResueltos {
  if (pagos.length === 0) throw invalido('Registra al menos un pago.')
  const cents = pagos.map((p) => {
    const c = aCentimos(p.amount)
    if (!Number.isFinite(p.amount) || c <= 0 || Math.abs(p.amount * 100 - c) > 1e-6) {
      throw invalido('Cada pago debe ser mayor que cero y tener como máximo 2 decimales.')
    }
    return c
  })

  const lineasCredito = pagos.filter((p) => p.method === 'CREDITO')
  if (lineasCredito.length > 1) throw invalido(MENSAJE_FIADO_UNA_LINEA)
  const fiado = lineasCredito.length === 1
  if (fiado && !opciones.conCliente) throw new BusinessError('CREDIT_CUSTOMER', MENSAJE_FIADO_CLIENTE)
  if (fiado && opciones.documentType === 'FACTURA') throw invalido(MENSAJE_FIADO_FACTURA)

  const T = aCentimos(total)
  const S = cents.reduce((s, c) => s + c, 0)
  if (S < T) {
    throw new BusinessError('INSUFFICIENT_STOCK', 'Los pagos no cubren el total de la venta.', { total: deCentimos(T), pagado: deCentimos(S) })
  }

  // Con fiado el total cuadra exacto: no hay exceso ni vuelto que mezclar con la deuda.
  if (fiado && S > T) throw invalido(MENSAJE_FIADO_EXACTO, { total: deCentimos(T), pagado: deCentimos(S) })

  // Exceso = vuelto a entregar. Solo hay efectivo para devolverlo.
  let resto = S - T
  const efectivo = pagos.reduce((s, p, i) => (p.method === 'EFECTIVO' ? s + cents[i]! : s), 0)
  if (resto > efectivo) {
    throw invalido('Solo el efectivo da vuelto: lo pagado con Yape, tarjeta u otros medios no puede superar el total.', {
      total: deCentimos(T), pagado: deCentimos(S),
    })
  }

  const resueltos = pagos.map((p, i): PagoResuelto => {
    let change = 0
    if (p.method === 'EFECTIVO' && resto > 0) {
      change = Math.min(cents[i]!, resto)
      resto -= change
    }
    return { method: p.method, amount: deCentimos(cents[i]!), reference: p.reference ?? null, change: deCentimos(change) }
  })
  const credito = pagos.reduce((s, p, i) => (p.method === 'CREDITO' ? s + cents[i]! : s), 0)
  return { pagos: resueltos, pagado: deCentimos(S), vuelto: deCentimos(S - T), credito: deCentimos(credito) }
}
