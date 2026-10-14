import { z } from 'zod'

/**
 * Emisión de comprobantes.
 *
 * El tipo de documento NO es libre: una factura exige RUC del receptor y una
 * boleta no. Esa regla se valida aquí y se vuelve a comprobar en el servicio
 * contra los datos reales del cliente, porque el cuerpo de la petición puede
 * afirmar un RUC que la base no tiene.
 */

const id = z.string().min(1).max(64)

/** Serie: una letra de tipo + tres dígitos. "F001" facturas, "B001" boletas. */
const serie = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]\d{3}$/, 'La serie debe ser una letra y tres dígitos, como F001.')

export const issueTaxDocumentSchema = z.object({
  saleId: id,
  documentType: z.enum(['BOLETA', 'FACTURA'], {
    error: 'Solo se emiten boletas y facturas.',
  }),
  series: serie.optional(),
  /** Datos del receptor. En factura son obligatorios; en boleta, opcionales. */
  receiverDocType: z.enum(['DNI', 'RUC', 'CE', 'PASAPORTE', 'SIN_DOCUMENTO']).optional(),
  receiverDocNumber: z.string().trim().max(20).optional(),
  receiverName: z.string().trim().max(200).optional(),
  receiverAddress: z.string().trim().max(300).optional(),
})

export type IssueTaxDocumentInput = z.infer<typeof issueTaxDocumentSchema>

/**
 * Actualización del estado tributario. La hará el proceso de firma/envío
 * cuando exista; hoy permite reflejar a mano lo que diga el OSE.
 */
export const updateTaxStatusSchema = z.object({
  taxDocumentId: id,
  status: z.enum(['ENVIADO', 'ACEPTADO', 'RECHAZADO']),
  statusMessage: z.string().trim().max(500).optional(),
  externalTicket: z.string().trim().max(120).optional(),
  responseCode: z.string().trim().max(40).optional(),
})

export type UpdateTaxStatusInput = z.infer<typeof updateTaxStatusSchema>

/** Series por defecto. Cada tipo lleva la suya, como exige la norma. */
export const SERIE_POR_DEFECTO: Record<'BOLETA' | 'FACTURA', string> = {
  BOLETA: 'B001',
  FACTURA: 'F001',
}

/** Dígitos del correlativo en la representación impresa: F001-00000123. */
export const CORRELATIVO_DIGITOS = 8

export function formatFullNumber(series: string, correlativo: number): string {
  return `${series}-${String(correlativo).padStart(CORRELATIVO_DIGITOS, '0')}`
}
