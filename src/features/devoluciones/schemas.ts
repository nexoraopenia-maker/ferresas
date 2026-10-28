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

/**
 * Devolver productos de una venta (F6.2): cantidades por línea, en UNIDADES BASE (la pantalla convierte cajas a unidades). El servidor decide
 * importes, base e IGV, la nota de crédito, el reparto entre deuda y dinero y la merma; el cliente solo elige qué, cuánto y a dónde va (stock o merma).
 */
export const devolverProductosSchema = z.object({
  saleId: id,
  reason: z.string().trim().min(3, 'Explica el motivo (mínimo 3 caracteres).').max(250, 'El motivo es demasiado largo (máximo 250 caracteres).'),
  lines: z.array(z.object({
    saleItemId: id,
    quantity: z.number().finite().positive('La cantidad a devolver debe ser mayor que cero.'),
    /** Dañada o defectuosa → merma; si no, vuelve al stock vendible. Un servicio sin control de stock ignora esto. */
    destination: z.enum(['STOCK', 'MERMA']).default('STOCK'),
  })).min(1, 'Elige al menos un producto para devolver.').max(100),
  /** Solo la parte que se devuelve en DINERO (lo demás baja la deuda). Sin él, el dinero vuelve por donde entró. */
  refunds: z.array(reembolso).max(8).optional(),
  idempotencyKey: z.uuid('Clave de idempotencia inválida.'),
})
export type DevolverProductosInput = z.infer<typeof devolverProductosSchema>
