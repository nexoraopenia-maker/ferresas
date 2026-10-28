import { z } from 'zod'

const id = z.string().trim().min(1).max(64)

/** Crear el borrador de compra de UN proveedor en UN almacén (`supplierId` null = «Otros / Sin proveedor», el borrador queda sin proveedor para asignarlo después). La clave evita dos borradores por un doble clic. */
export const borradorDesdeReposicionSchema = z.object({
  supplierId: id.nullable(),
  warehouseId: id,
  idempotencyKey: z.uuid('Clave de idempotencia inválida.'),
})
export type BorradorDesdeReposicionInput = z.infer<typeof borradorDesdeReposicionSchema>

/** Pedir a una sucursal con excedente lo que a este almacén le falta. Solo IDENTIFICA producto y almacenes: la cantidad la calcula el servidor. */
export const transferenciaDesdeReposicionSchema = z.object({
  fromWarehouseId: id,
  toWarehouseId: id,
  items: z.array(z.object({ productId: id, variantId: id.nullish() })).min(1, 'No hay nada que pedir.').max(50, 'Pide hasta 50 productos por vez.'),
})
export type TransferenciaDesdeReposicionInput = z.infer<typeof transferenciaDesdeReposicionSchema>
