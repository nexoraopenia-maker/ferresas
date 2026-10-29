/**
 * Plazos tributarios que usa el sistema (dados por el dueño el 2026-10-29; ⚠️ SIN verificar con la norma ni con el contador: ver `docs/SUNAT-SUPUESTOS.md` #12). Son
 * constantes con nombre, no reglas escondidas en el código: si la norma dice otra cosa, se cambia AQUÍ.
 */

/** Días calendario máximos, desde la emisión, para enviar una factura o una boleta a SUNAT. */
export const PLAZO_ENVIO_DIAS = 3

/** Días calendario máximos, desde la emisión, para comunicar la baja de un comprobante (fase S4). */
export const PLAZO_BAJA_DIAS = 7

/** Años mínimos de conservación del XML firmado y del CDR: no se purgan antes. */
export const CONSERVACION_ANIOS = 5

const MS_DIA = 86_400_000
const aUtc = (dia: string) => Date.UTC(Number(dia.slice(0, 4)), Number(dia.slice(5, 7)) - 1, Number(dia.slice(8, 10)))

/** Días calendario entre dos días `AAAA-MM-DD` (de la zona del negocio). Negativo si `hasta` es anterior. */
export const diasEntre = (desde: string, hasta: string): number => Math.round((aUtc(hasta) - aUtc(desde)) / MS_DIA)

/**
 * ¿Se puede comunicar todavía la baja? Cuenta DÍAS CALENDARIO desde el día de emisión: el día de emisión es el día 0 y el último día válido es el 7.º después
 * (⚠️ la forma de contar, y el plazo mismo, vienen del dueño: docs/SUNAT-SUPUESTOS.md). Los dos días son de la zona horaria del negocio.
 */
export const dentroDelPlazoDeBaja = (diaEmision: string, diaHoy: string): boolean => diasEntre(diaEmision, diaHoy) <= PLAZO_BAJA_DIAS

/** ¿Sigue dentro del plazo para ENVIAR un comprobante a SUNAT? Mismos días calendario que la baja (el día de emisión es el 0). */
export const dentroDelPlazoDeEnvio = (diaEmision: string, diaHoy: string): boolean => diasEntre(diaEmision, diaHoy) <= PLAZO_ENVIO_DIAS
