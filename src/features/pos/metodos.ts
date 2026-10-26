import type { MetodoPago } from './pagos'

/**
 * Los métodos de pago que el cajero ve en el POS. «T. crédito» es la TARJETA de crédito; el fiado (`CREDITO`, que se financia al
 * cliente) NO está aquí: tiene su propio botón «Fiado por el saldo». Dos cosas distintas no pueden llamarse igual en el mostrador.
 */
export const METODOS_POS = [
  { value: 'EFECTIVO', label: 'Efectivo' },
  { value: 'YAPE', label: 'Yape' },
  { value: 'PLIN', label: 'Plin' },
  { value: 'TARJETA_DEBITO', label: 'Débito' },
  { value: 'TARJETA_CREDITO', label: 'T. crédito' },
  { value: 'TRANSFERENCIA', label: 'Transfer.' },
] as const satisfies readonly { value: MetodoPago; label: string }[]

export type MetodoPos = (typeof METODOS_POS)[number]['value']

/** Rótulo de la línea de fiado. */
export const ROTULO_FIADO = 'Fiado'
