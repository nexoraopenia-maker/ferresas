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
 *  · `CREDITO` (fiado) todavía no se acepta: hasta que exista cliente, límite y deuda, aceptarlo equivalía a dar la venta
 *    por cobrada sin registrar a nadie que la deba.
 */

export type MetodoPago = 'EFECTIVO' | 'TARJETA_DEBITO' | 'TARJETA_CREDITO' | 'TRANSFERENCIA' | 'YAPE' | 'PLIN' | 'CREDITO' | 'OTRO'

export interface PagoEntrada { method: MetodoPago; amount: number; reference?: string }
export interface PagoResuelto { method: MetodoPago; amount: number; reference: string | null; change: number }
export interface PagosResueltos { pagos: PagoResuelto[]; /** Σ pagos. */ pagado: number; /** Vuelto total entregado. */ vuelto: number }

export const MENSAJE_SIN_FIADO = 'La venta a crédito (fiado) todavía no está disponible.'

const aCentimos = (n: number) => Math.round(n * 100)
const deCentimos = (c: number) => c / 100
const invalido = (m: string, d?: Record<string, string | number>) => new BusinessError('INVALID_DOCUMENT', m, d)

export function resolverPagos(total: number, pagos: readonly PagoEntrada[]): PagosResueltos {
  if (pagos.length === 0) throw invalido('Registra al menos un pago.')
  const cents = pagos.map((p) => {
    const c = aCentimos(p.amount)
    if (!Number.isFinite(p.amount) || c <= 0 || Math.abs(p.amount * 100 - c) > 1e-6) {
      throw invalido('Cada pago debe ser mayor que cero y tener como máximo 2 decimales.')
    }
    return c
  })
  if (pagos.some((p) => p.method === 'CREDITO')) throw invalido(MENSAJE_SIN_FIADO)

  const T = aCentimos(total)
  const S = cents.reduce((s, c) => s + c, 0)
  if (S < T) {
    throw new BusinessError('INSUFFICIENT_STOCK', 'Los pagos no cubren el total de la venta.', { total: deCentimos(T), pagado: deCentimos(S) })
  }

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
  return { pagos: resueltos, pagado: deCentimos(S), vuelto: deCentimos(S - T) }
}
