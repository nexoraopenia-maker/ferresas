import { z } from 'zod'

const id = z.string().min(1).max(64)

const cantidad = z
  .number()
  .finite()
  .positive('La cantidad debe ser mayor que cero.')
  .max(9_999_999)

export const createTransferSchema = z.object({
  fromWarehouseId: id,
  toBranchId: id,
  toWarehouseId: id,
  items: z
    .array(
      z.object({
        productId: id,
        variantId: id.nullish(),
        quantity: cantidad,
      }),
    )
    .min(1, 'Añade al menos un producto a la transferencia.')
    .max(200),
  notes: z.string().trim().max(500).optional(),
})

export type CreateTransferInput = z.infer<typeof createTransferSchema>

export const approveTransferSchema = z.object({ transferId: id })
export type ApproveTransferInput = z.infer<typeof approveTransferSchema>

export const shipTransferSchema = z.object({ transferId: id })
export type ShipTransferInput = z.infer<typeof shipTransferSchema>

export const receiveTransferSchema = z.object({
  transferId: id,
  /**
   * Lo CONTADO al recibir, línea por línea. Se exige explícito en vez de
   * asumir "llegó todo": asumirlo convertiría cada faltante de transporte en
   * un descuadre silencioso que aparece semanas después sin rastro.
   */
  items: z
    .array(z.object({ itemId: id, quantityReceived: z.number().finite().min(0).max(9_999_999) }))
    .min(1)
    .max(200),
  notes: z.string().trim().max(500).optional(),
})

export type ReceiveTransferInput = z.infer<typeof receiveTransferSchema>

export const rejectTransferSchema = z.object({
  transferId: id,
  reason: z.string().trim().min(5, 'Indica el motivo del rechazo.').max(300),
})

export type RejectTransferInput = z.infer<typeof rejectTransferSchema>
