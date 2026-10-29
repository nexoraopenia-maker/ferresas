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
  /**
   * Compatibilidad: la serie la determina la sucursal de la venta. Si se
   * manda y no coincide, el servicio lo rechaza en vez de ignorarlo.
   */
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
  /**
   * Motivo del cambio, OBLIGATORIO.
   *
   * Cambiar a mano el estado tributario de un comprobante es declarar algo
   * que el sistema no ha comprobado: que SUNAT lo aceptó, o lo rechazó. Sin
   * una explicación escrita, el día que una fiscalización pregunte por qué
   * este comprobante figura como ACEPTADO no habrá nada que responder.
   * El mínimo de 10 caracteres impide el motivo de una letra que convierte
   * el campo en decorativo.
   */
  motivo: z
    .string()
    .trim()
    .min(10, 'Explica por qué cambias el estado a mano: al menos 10 caracteres.')
    .max(500),
  statusMessage: z.string().trim().max(500).optional(),
  externalTicket: z.string().trim().max(120).optional(),
  responseCode: z.string().trim().max(40).optional(),
})

export type UpdateTaxStatusInput = z.infer<typeof updateTaxStatusSchema>

/**
 * Nota de crédito TOTAL. Los motivos son los de `MOTIVOS_NOTA_CREDITO_TOTAL` (01, 02, 06); un test comprueba que no
 * se desalineen del servicio. ⚠️ Catálogo 09 sin validar.
 */
export const emitirNotaCreditoSchema = z.object({
  saleId: id,
  reasonCode: z.enum(['01', '02', '06'], { error: 'Elige un motivo.' }),
  reasonDescription: z
    .string()
    .trim()
    .min(3, 'Escribe el sustento (al menos 3 caracteres).')
    .max(250, 'El sustento admite hasta 250 caracteres.'),
})

export type EmitirNotaCreditoInput = z.infer<typeof emitirNotaCreditoSchema>

/**
 * Series de la PRIMERA sucursal (seriesNumber = 1). Cada tipo lleva la suya,
 * como exige la norma.
 *
 * Ya no es "la serie por defecto" en el sentido de elegible: desde que hay
 * multi-sucursal la serie la deriva `serieDeSucursal()` del número de la
 * sucursal, y estos valores son lo que esa función devuelve para la número 1.
 * Se conservan como referencia y para las pruebas.
 */
export const SERIE_POR_DEFECTO: Record<'BOLETA' | 'FACTURA', string> = {
  BOLETA: 'B001',
  FACTURA: 'F001',
}

/** Dígitos del correlativo en la representación impresa: F001-00000123. */
export const CORRELATIVO_DIGITOS = 8

export function formatFullNumber(series: string, correlativo: number): string {
  return `${series}-${String(correlativo).padStart(CORRELATIVO_DIGITOS, '0')}`
}

/**
 * Correlativo inicial de una serie.
 *
 * `confirmado` NO es decoración ni se puede marcar por defecto: fijar el
 * arranque es irreversible en cuanto la serie emite, así que la petición
 * tiene que declarar que alguien lo entendió. Sin este campo, un formulario
 * mal cableado podría enviar un arranque por accidente.
 */
export const fijarArranqueSchema = z.object({
  branchId: z.string().min(1).max(64),
  scope: z.enum(['TAX_BOLETA', 'TAX_FACTURA'], {
    error: 'Solo se configura el arranque de boletas y facturas.',
  }),
  startNumber: z
    .number({ error: 'Escribe el número con el que arrancará la serie.' })
    .int('El correlativo es un número entero.')
    .min(1, 'El correlativo arranca en 1 como mínimo.')
    // 8 dígitos es lo que cabe en la representación impresa (B001-00000123).
    .max(99_999_999, 'El correlativo no puede pasar de 8 dígitos.'),
  confirmado: z.literal(true, {
    error: 'Hay que confirmar que entiendes que esto no se puede cambiar después.',
  }),
})

export type FijarArranqueInputDTO = z.infer<typeof fijarArranqueSchema>

/**
 * Credenciales de SUNAT directo (S2). El .pfx viaja en base64 (Server Action: tope razonable, ≤ 100 KB de archivo). Las claves no se recortan:
 * pueden llevar espacios. La validación de fondo (abrir el .pfx, vigencia, RUC) está en el servicio.
 */
export const guardarCredencialesSunatSchema = z.object({
  pfxBase64: z.string().min(200, 'Elige el archivo del certificado (.pfx).').max(140_000, 'El certificado es demasiado grande.'),
  claveCertificado: z.string().min(1, 'Escribe la clave del certificado.').max(200),
  usuarioSol: z.string().trim().min(3, 'Escribe el usuario SOL secundario.').max(30),
  claveSol: z.string().min(4, 'Escribe la clave SOL.').max(100),
})
