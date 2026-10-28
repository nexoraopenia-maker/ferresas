import { z } from 'zod'

const id = z.string().trim().min(1).max(64)

const reembolso = z.object({
  mode: z.enum(['CAJA', 'EXTERNO', 'SIN_SALIDA']),
  method: z.enum(['EFECTIVO', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'TRANSFERENCIA', 'YAPE', 'PLIN', 'CREDITO', 'OTRO']).nullish(),
  amount: z.number().finite().positive('El reembolso debe ser mayor que cero.'),
  reference: z.string().trim().max(120).nullish(),
})

/** Anular o devolver una venta completa. El servidor decide los importes, el comprobante, el stock y la deuda; el cliente solo elige el tipo, el motivo y adónde va el dinero. */
export const anularOdevolverVentaSchema = z.object({
  saleId: id,
  kind: z.enum(['ANULACION', 'DEVOLUCION']),
  reason: z.string().trim().min(3, 'Explica el motivo (mínimo 3 caracteres).').max(250, 'El motivo es demasiado largo (máximo 250 caracteres).'),
  /** Sin él, el dinero vuelve por donde entró. */
  refunds: z.array(reembolso).max(8).optional(),
  idempotencyKey: z.uuid('Clave de idempotencia inválida.'),
})
export type AnularOdevolverVentaInput = z.infer<typeof anularOdevolverVentaSchema>
