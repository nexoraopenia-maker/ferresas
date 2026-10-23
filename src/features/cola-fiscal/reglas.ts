/**
 * Reglas de la cola de envío fiscal (puras).
 *
 * Rampa de reintentos: el primer intento es inmediato y, si falla, se espera 1 min, 5 min,
 * 30 min, 2 h y 12 h. Tras el sexto intento fallido la fila queda AGOTADO: no se sigue
 * insistiendo solo, y el dueño y el SuperAdmin lo ven.
 */

export const RAMPA_SEGUNDOS = [60, 300, 1800, 7200, 43200] as const

/** 1 intento inmediato + 5 reintentos. */
export const MAX_INTENTOS = RAMPA_SEGUNDOS.length + 1

/**
 * Cuánto dura el lease de una fila reclamada. Tiene que superar con holgura lo que tarda UN envío
 * (el proveedor corta a los 15 s): si el worker se cae, la fila vuelve a estar disponible al vencer.
 */
export const LEASE_MS = 2 * 60_000

/** Lo máximo que tarda un envío (el timeout del proveedor): no se empieza uno sin tener este margen. */
export const TIMEOUT_ENVIO_MS = 15_000

export const ERROR_MAX_CARACTERES = 500

export type Siguiente =
  | { agotado: false; en: Date; segundos: number }
  | { agotado: true; en: null; segundos: null }

/**
 * Tras fallar el intento número `intentosHechos` (contando el que acaba de fallar), ¿cuándo se
 * reintenta? Con 6 intentos hechos no hay más: AGOTADO.
 */
export function proximoIntento(intentosHechos: number, ahora: Date): Siguiente {
  if (intentosHechos >= MAX_INTENTOS) return { agotado: true, en: null, segundos: null }
  const segundos = RAMPA_SEGUNDOS[Math.max(0, intentosHechos - 1)]!
  return { agotado: false, en: new Date(ahora.getTime() + segundos * 1000), segundos }
}

export type OperacionCola = 'ENVIAR' | 'CONSULTAR'

/** Estable por documento y operación: la MISMA en cada reintento. */
export const claveIdempotencia = (tenantId: string, taxDocumentId: string, op: OperacionCola = 'ENVIAR') =>
  `fiscal:${tenantId}:${taxDocumentId}:${op}`

export const recortarError = (e: unknown): string => {
  const t = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  return t.length > ERROR_MAX_CARACTERES ? `${t.slice(0, ERROR_MAX_CARACTERES - 1)}…` : t
}

/** Cuánto falta del presupuesto de tiempo del worker. */
export const tiempoRestante = (inicio: number, presupuestoMs: number, ahoraMs: number) =>
  presupuestoMs - (ahoraMs - inicio)

/** ¿Alcanza el tiempo para empezar OTRO envío? Hace falta el timeout completo de un envío. */
export const cabeOtroEnvio = (restanteMs: number) => restanteMs >= TIMEOUT_ENVIO_MS
