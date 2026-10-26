import { z } from 'zod'
import { tieneMaxDecimales } from '@/lib/dinero'

const id = z.string().min(1).max(64)

/** Cambiar la línea, el plazo o el bloqueo de crédito de un cliente. */
export const configurarCreditoSchema = z.object({
  customerId: id,
  /** 0 = sin crédito. Máximo 2 decimales. */
  creditLimit: z.number().finite().min(0, 'La línea no puede ser negativa.').max(99_999_999, 'La línea está fuera de rango.')
    .refine((n) => tieneMaxDecimales(n, 2), 'Máximo 2 decimales.'),
  /** Días de plazo de las ventas a crédito (0 a 365). */
  creditTermDays: z.number().int('El plazo es un número entero de días.').min(0).max(365, 'El plazo máximo es de 365 días.'),
  /** Bloquea (true) o libera (false) el crédito, sin tocar la línea. */
  bloqueado: z.boolean(),
  motivo: z.string().trim().min(3).max(300).optional(),
})

export type ConfigurarCreditoInput = z.infer<typeof configurarCreditoSchema>

const unicos = (a: string[]) => new Set(a).size === a.length

/** Un abono de un cliente con deuda. La clave de idempotencia es OBLIGATORIA: el mismo envío repetido no cobra dos veces. */
export const registrarAbonoSchema = z.object({
  customerId: id,
  /** Nunca CREDITO: un abono es dinero que entra. */
  method: z.enum(['EFECTIVO', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'TRANSFERENCIA', 'YAPE', 'PLIN', 'OTRO']),
  amount: z.number().finite().positive('El abono debe ser mayor que cero.').max(99_999_999, 'El monto está fuera de rango.')
    .refine((n) => tieneMaxDecimales(n, 2), 'Máximo 2 decimales.'),
  reference: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(300).optional(),
  /** Si se omite, el abono se aplica a la deuda MÁS ANTIGUA primero (FIFO). Si se envía, solo a esas cuentas y en ese orden. */
  receivableIds: z.array(id).min(1).max(50).refine(unicos, 'Hay cuentas repetidas.').optional(),
  idempotencyKey: z.uuid(),
})
export type RegistrarAbonoInput = z.infer<typeof registrarAbonoSchema>

/** Anular un abono (error de digitación, cheque rebotado…). El motivo queda auditado. */
export const anularAbonoSchema = z.object({ paymentId: id, motivo: z.string().trim().min(3, 'Escribe el motivo.').max(300) })
export type AnularAbonoInput = z.infer<typeof anularAbonoSchema>

/** Dar de baja una cuenta por cobrar con saldo (castigo, error, nota de crédito aceptada). */
export const anularCuentaSchema = z.object({ receivableId: id, motivo: z.string().trim().min(3, 'Escribe el motivo.').max(300) })
export type AnularCuentaInput = z.infer<typeof anularCuentaSchema>

/** Resolver la marca de «pendiente de revisión» dejando la cuenta como está. */
export const descartarRevisionSchema = z.object({ receivableId: id, nota: z.string().trim().min(3, 'Escribe la nota.').max(300) })
export type DescartarRevisionInput = z.infer<typeof descartarRevisionSchema>
