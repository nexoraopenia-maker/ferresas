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
