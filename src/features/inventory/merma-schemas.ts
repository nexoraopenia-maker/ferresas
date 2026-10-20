import { z } from 'zod'

const id = z.string().min(1).max(64)

const cantidad = z
  .number()
  .finite()
  .positive('La cantidad debe ser mayor que cero.')
  .max(9_999_999)
  .refine((n) => Number.isFinite(n) && Math.round(n * 10_000) === n * 10_000, {
    message: 'Como máximo 4 decimales.',
  })

export const solicitarMermaSchema = z.object({
  warehouseId: id,
  productId: id,
  variantId: id.nullish(),
  quantity: cantidad,
  /**
   * Motivo OBLIGATORIO y con longitud mínima.
   *
   * Una merma sin explicación no es auditable, y «otro» o «varios» no
   * explican nada. El mínimo de 10 caracteres no garantiza calidad, pero
   * impide el motivo de un carácter que convierte el campo en decorativo.
   */
  reason: z
    .string()
    .trim()
    .min(10, 'Explica qué pasó: al menos 10 caracteres.')
    .max(500),
  /** URL de la foto de evidencia. Opcional. */
  photoUrl: z.string().trim().url('La foto debe ser una URL válida.').max(500).optional(),
})

export type SolicitarMermaInput = z.infer<typeof solicitarMermaSchema>

export const resolverMermaSchema = z.discriminatedUnion('decision', [
  z.object({
    mermaId: id,
    decision: z.literal('APROBAR'),
    /**
     * Permite descontar aunque el saldo quede negativo.
     *
     * Suena peligroso y es lo contrario: la merma es justamente el asiento
     * que explica un faltante que YA ocurrió. Si el sistema cree que hay 3 y
     * en el estante hay 0, bloquear la merma deja el descuadre sin explicar.
     */
    permitirNegativo: z.boolean().default(false),
  }),
  z.object({
    mermaId: id,
    decision: z.literal('RECHAZAR'),
    /** Rechazar sin explicar no le sirve a quien la pidió. */
    rejectReason: z
      .string()
      .trim()
      .min(5, 'Indica por qué se rechaza.')
      .max(300),
  }),
])

export type ResolverMermaInput = z.infer<typeof resolverMermaSchema>
