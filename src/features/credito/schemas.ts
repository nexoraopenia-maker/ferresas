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
