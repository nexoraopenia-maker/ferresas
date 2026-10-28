import { z } from 'zod'

/**
 * Parámetros del kardex (F6.4b). Todo viaja como texto sencillo (la pantalla lo arma desde la dirección): ids, días `YYYY-MM-DD` del negocio,
 * un cursor opaco y el tamaño de página. Sin `desde`/`hasta` el servicio usa los últimos 30 días; sin `warehouseId`, todos los almacenes que el usuario alcanza.
 */

export const TAMANO_PAGINA_KARDEX = 50
export const TAMANO_PAGINA_MAXIMO = 200
/** Rango máximo de una consulta: 12 meses (366 días, para cubrir un año bisiesto). */
export const DIAS_MAXIMOS_KARDEX = 366
/** Tope de filas de la exportación: si el rango trae más, se pide acortarlo (nunca se corta en silencio). */
export const TOPE_FILAS_CSV_KARDEX = 50_000

const id = z.string().trim().min(1, 'Falta el dato.').max(64, 'El identificador es demasiado largo.')
const dia = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe ser AAAA-MM-DD.').refine((v) => {
  const [y, m, d] = v.split('-').map(Number) as [number, number, number]
  const f = new Date(Date.UTC(y, m - 1, d))
  return f.getUTCFullYear() === y && f.getUTCMonth() === m - 1 && f.getUTCDate() === d
}, 'La fecha no existe.')

export const kardexSchema = z.object({
  productId: id,
  warehouseId: id.optional(),
  variantId: id.optional(),
  desde: dia.optional(),
  hasta: dia.optional(),
  cursor: z.string().trim().min(1).max(200).optional(),
  limite: z.number().int('El tamaño de página debe ser un entero.').min(1).max(TAMANO_PAGINA_MAXIMO, `Máximo ${TAMANO_PAGINA_MAXIMO} filas por página.`).default(TAMANO_PAGINA_KARDEX),
})
export type KardexParams = z.infer<typeof kardexSchema>

/** La exportación no pagina: lleva el rango completo. */
export const kardexCsvSchema = kardexSchema.omit({ cursor: true, limite: true })
export type KardexCsvParams = z.infer<typeof kardexCsvSchema>
