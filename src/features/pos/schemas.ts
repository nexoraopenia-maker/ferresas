import { z } from 'zod'

/**
 * Validación del Punto de Venta (§5.4).
 *
 * Igual que en inventario: `tenantId` NO aparece en ningún esquema. Y
 * tampoco los PRECIOS en su forma final — el carrito manda qué producto y
 * cuánto, y el servidor recalcula los importes leyendo el precio de la base.
 * Si el navegador pudiera fijar el total, cualquiera se vendería un taladro
 * a un sol.
 */

const cantidad = z
  .number({ error: 'Ingresa una cantidad.' })
  .finite('La cantidad no es válida.')
  .positive('La cantidad debe ser mayor que cero.')
  .refine((n) => Math.round(n * 10_000) === n * 10_000, 'Máximo 4 decimales.')
  .refine((n) => n < 1e9, 'La cantidad está fuera de rango.')

const importe = z
  .number()
  .finite()
  .nonnegative('No puede ser negativo.')
  .refine((n) => Math.round(n * 100) === n * 100, 'Máximo 2 decimales.')

const id = z.string().min(1).max(64)

export const saleLineSchema = z.object({
  productId: id,
  variantId: id.nullish(),
  quantity: cantidad,
  /**
   * Descuento por línea, en importe. Lo decide el vendedor en el mostrador,
   * así que sí viene del cliente — pero el servidor comprueba que no exceda
   * el subtotal de la línea.
   */
  discount: importe.default(0),
})

export const paymentLineSchema = z.object({
  method: z.enum([
    'EFECTIVO', 'TARJETA_DEBITO', 'TARJETA_CREDITO',
    'TRANSFERENCIA', 'YAPE', 'PLIN', 'CREDITO', 'OTRO',
  ]),
  amount: importe.refine((n) => n > 0, 'El monto debe ser mayor que cero.'),
  reference: z.string().trim().max(60).optional(),
})

export const registerSaleSchema = z.object({
  warehouseId: id,
  customerId: id.nullish(),
  items: z.array(saleLineSchema).min(1, 'Agrega al menos un producto.').max(200),
  payments: z.array(paymentLineSchema).min(1, 'Registra al menos un pago.').max(5),
  documentType: z.enum(['NOTA_VENTA', 'BOLETA', 'FACTURA', 'TICKET']).default('NOTA_VENTA'),
  notes: z.string().trim().max(500).optional(),
  /**
   * Generada por el cliente antes de enviar. Es lo que impide que un doble
   * toque en "Cobrar" con la red lenta registre la venta dos veces y
   * descuente el stock dos veces.
   */
  idempotencyKey: z.uuid().optional(),
})

export type SaleLineInput = z.infer<typeof saleLineSchema>
export type RegisterSaleInput = z.infer<typeof registerSaleSchema>

/** Búsqueda del POS: código escaneado, QR, SKU o texto libre. */
export const posLookupSchema = z.object({
  code: z.string().trim().min(1, 'Escribe o escanea un código.').max(64),
  warehouseId: id.optional(),
})

export type PosLookupInput = z.infer<typeof posLookupSchema>
