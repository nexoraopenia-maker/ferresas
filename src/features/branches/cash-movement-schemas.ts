import { z } from 'zod'
import { tieneMaxDecimales } from '@/lib/dinero'
import { CATEGORIAS_MOVIMIENTO, TIPOS, categoriaValida } from './cash-movement-reglas'

const id = z.string().trim().min(1).max(64)

/** Registrar un ingreso o egreso manual de efectivo en el turno abierto. El servidor decide el turno, el permiso y el aviso de exceso. */
export const registrarMovimientoCajaSchema = z.object({
  kind: z.enum(TIPOS),
  category: z.enum(CATEGORIAS_MOVIMIENTO),
  amount: z.number().finite().positive('El monto debe ser mayor que cero.').max(9_999_999.99, 'El monto es demasiado grande.')
    .refine((n) => tieneMaxDecimales(n, 2), 'El monto lleva como máximo 2 decimales.'),
  description: z.string().trim().min(3, 'Explica el movimiento (mínimo 3 caracteres).').max(200, 'La descripción es demasiado larga (máximo 200 caracteres).'),
  /** Número de comprobante o recibo. Obligatoria para egresos mayores a `REFERENCIA_OBLIGATORIA_DESDE` (la comprueba el servicio). */
  reference: z.string().trim().max(80, 'La referencia es demasiado larga (máximo 80 caracteres).').optional(),
  /** El usuario confirmó expresamente que el egreso supera el efectivo esperado en el cajón. */
  confirmaExceso: z.boolean().default(false),
  idempotencyKey: z.uuid('Clave de idempotencia inválida.'),
}).superRefine((v, ctx) => {
  if (!categoriaValida(v.kind, v.category)) {
    ctx.addIssue({ code: 'custom', path: ['category'], message: v.kind === 'INGRESO' ? 'Un ingreso no puede ser un gasto menor ni un retiro del dueño.' : 'Un egreso no puede ser una reposición del fondo.' })
  }
})
export type RegistrarMovimientoCajaInput = z.infer<typeof registrarMovimientoCajaSchema>

export const anularMovimientoCajaSchema = z.object({
  movementId: id,
  reason: z.string().trim().min(3, 'Explica el motivo (mínimo 3 caracteres).').max(250, 'El motivo es demasiado largo (máximo 250 caracteres).'),
})
export type AnularMovimientoCajaInput = z.infer<typeof anularMovimientoCajaSchema>
