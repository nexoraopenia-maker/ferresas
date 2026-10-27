import { z } from 'zod'
import { tieneMaxDecimales } from '@/lib/dinero'

const id = z.string().trim().min(1).max(64)
const unicos = (a: string[]) => new Set(a).size === a.length
const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va como AAAA-MM-DD.')

/**
 * Un pago a un proveedor. La clave de idempotencia es OBLIGATORIA: el mismo envío repetido no paga dos veces.
 * Nunca CREDITO: pagar es dinero que SALE.
 */
export const registrarPagoSchema = z.object({
  supplierId: id,
  method: z.enum(['EFECTIVO', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'TRANSFERENCIA', 'YAPE', 'PLIN', 'OTRO']),
  amount: z.number().finite().positive('El pago debe ser mayor que cero.').max(99_999_999, 'El monto está fuera de rango.')
    .refine((n) => tieneMaxDecimales(n, 2), 'Máximo 2 decimales.'),
  /** N.º de operación o de voucher. */
  reference: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(300).optional(),
  /** Si se omite, el pago se aplica a la deuda MÁS ANTIGUA primero. Si se envía, solo a esas cuentas y en ese orden. */
  payableIds: z.array(id).min(1).max(50).refine(unicos, 'Hay cuentas repetidas.').optional(),
  idempotencyKey: z.uuid('Clave de idempotencia inválida.'),
})
export type RegistrarPagoInput = z.infer<typeof registrarPagoSchema>

export const anularPagoSchema = z.object({ paymentId: id, motivo: z.string().trim().min(3, 'Escribe el motivo.').max(300) })
export type AnularPagoInput = z.infer<typeof anularPagoSchema>

export const estadoCuentaProveedorSchema = z.object({ supplierId: id, desde: dia.optional(), hasta: dia.optional() })
export type EstadoCuentaProveedorInput = z.infer<typeof estadoCuentaProveedorSchema>

/** Vista previa del reparto de un pago (la misma función pura que escribe). */
export const previsualizarPagoSchema = z.object({
  supplierId: id,
  amount: z.number().finite().positive().max(99_999_999).refine((n) => tieneMaxDecimales(n, 2), 'Máximo 2 decimales.'),
  payableIds: z.array(id).min(1).max(50).refine(unicos, 'Hay cuentas repetidas.').optional(),
})
export type PrevisualizarPagoInput = z.infer<typeof previsualizarPagoSchema>
