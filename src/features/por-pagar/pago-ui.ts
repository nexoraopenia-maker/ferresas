import { repartirAbono } from '@/features/credito/reglas'

/**
 * Lo que el modal de pago necesita decidir, PURO y en céntimos. Sin servidor: lo importa el navegador.
 *
 * El reparto lo calcula `repartirAbono`, la MISMA función con la que el servicio escribe; los mensajes son los del servidor. Así la vista
 * previa que ve quien paga es exactamente lo que se registrará. Lo único que la pantalla NO sabe es cuánto efectivo hay en el cajón (el
 * arqueo no se adelanta): si el pago en efectivo no cabe, lo rechaza el servidor diciendo cuánto hay.
 */

export interface CuentaPagable { id: string; compra: string; saldo: number; vence: string; vencida: boolean }

/** El mismo texto que el servidor (`exigirTurnoPropio`): desde F6.8b todo pago a proveedor, con cualquier medio, sale del turno propio. */
export const MENSAJE_PAGO_SIN_CAJA = 'Para registrar un pago a proveedor hace falta que tengas tu propio turno de caja abierto. Abre tu caja primero.'
export const MENSAJE_PAGO_SIN_DEUDA = 'No le debes nada a este proveedor.'
export const MENSAJE_PAGO_ELIGE_CUENTA = 'Elige al menos una cuenta o vuelve a «La más antigua primero».'

/** Métodos con los que se puede pagar. «Fiado» no: pagar es dinero que sale. */
export const METODOS_PAGO = [
  { value: 'EFECTIVO', label: 'Efectivo' },
  { value: 'TRANSFERENCIA', label: 'Transferencia' },
  { value: 'YAPE', label: 'Yape' },
  { value: 'PLIN', label: 'Plin' },
  { value: 'TARJETA_DEBITO', label: 'T. débito' },
  { value: 'TARJETA_CREDITO', label: 'T. crédito' },
] as const

/** El monto tecleado: acepta coma decimal. `null` = vacío; `NaN` = no es un importe válido (letras, negativo, cero o 3 decimales). */
export function leerMontoPago(texto: string): number | null {
  const t = texto.trim().replace(',', '.')
  if (t === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN
  const n = Number(t)
  return n > 0 && n <= 99_999_999 ? n : Number.NaN
}

export interface VistaPreviaPagoUi {
  /** Se puede enviar: monto válido, caja si hace falta y nada que lo impida. */
  listo: boolean
  /** Mensaje que impide enviar (el mismo que daría el servidor), o `null`. */
  error: string | null
  monto: number | null
  /** Cuentas a las que se aplicaría, en orden, con lo que se les aplica. */
  partes: { id: string; compra: string; monto: number; saldoDespues: number; pagada: boolean }[]
  /** Lo adeudado en las cuentas a las que se aplicaría. */
  deudaDestino: number
  /** Deuda total con el proveedor tras el pago; `null` si no se puede calcular. */
  deudaDespues: number | null
}

const c = (n: number) => Math.round(n * 100)

export function mensajePagoExcede(monto: number, deuda: number, enCuentasElegidas: boolean): string {
  return enCuentasElegidas
    ? `El pago (S/ ${monto.toFixed(2)}) supera lo que se debe en las cuentas elegidas (S/ ${deuda.toFixed(2)}).`
    : `El pago (S/ ${monto.toFixed(2)}) supera lo que le debes al proveedor (S/ ${deuda.toFixed(2)}).`
}

export function previsualizarPagoUi(i: {
  /** Cuentas abiertas YA en el orden del servidor (vencimiento, luego antigüedad). */
  cuentas: readonly CuentaPagable[]
  /** `null` = la más antigua primero. Con ids = solo esas, EN EL ORDEN en que se eligieron. */
  elegidas: readonly string[] | null
  texto: string
  metodo: string
  /** `null` = aún no se sabe. */
  cajaAbierta: boolean | null
  /** Deuda total con el proveedor, para calcular lo que quedará. */
  deudaTotal: number
}): VistaPreviaPagoUi {
  const monto = leerMontoPago(i.texto)
  const vacio = (error: string | null): VistaPreviaPagoUi => ({ listo: false, error, monto: monto !== null && !Number.isNaN(monto) ? monto : null, partes: [], deudaDestino: 0, deudaDespues: null })

  let destino: CuentaPagable[]
  if (i.elegidas) {
    if (i.elegidas.length === 0) return vacio(MENSAJE_PAGO_ELIGE_CUENTA)
    const porId = new Map(i.cuentas.map((x) => [x.id, x]))
    destino = i.elegidas.map((id) => porId.get(id)).filter((x): x is CuentaPagable => !!x)
  } else {
    destino = [...i.cuentas]
  }
  const deudaDestino = destino.reduce((a, x) => a + c(x.saldo), 0) / 100
  if (deudaDestino <= 0) return { ...vacio(MENSAJE_PAGO_SIN_DEUDA), deudaDestino }
  if (monto === null) return { ...vacio(null), deudaDestino }
  if (Number.isNaN(monto)) return { ...vacio('Escribe un importe mayor que cero, con hasta 2 decimales.'), deudaDestino }
  if (i.metodo === 'EFECTIVO' && i.cajaAbierta === false) return { ...vacio(MENSAJE_PAGO_SIN_CAJA), monto, deudaDestino }

  const { partes, sobrante } = repartirAbono(destino.map((x) => x.saldo), monto)
  const detalle = partes.map((p) => ({ id: destino[p.indice]!.id, compra: destino[p.indice]!.compra, monto: p.monto, saldoDespues: p.saldoDespues, pagada: p.pagada }))
  if (sobrante > 0) {
    return { listo: false, error: mensajePagoExcede(monto, deudaDestino, i.elegidas !== null), monto, partes: detalle, deudaDestino, deudaDespues: null }
  }
  return { listo: true, error: null, monto, partes: detalle, deudaDestino, deudaDespues: (c(i.deudaTotal) - c(monto)) / 100 }
}
