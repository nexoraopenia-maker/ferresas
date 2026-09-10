import { z } from 'zod'

/**
 * El MOTIVO es obligatorio en las tres acciones (§6.6). No es burocracia: un
 * AuditLog lleno de "suspendido" sin explicación no sirve para nada el día
 * que haya que reconstruir qué pasó con una cuenta.
 */
const motivo = z
  .string()
  .trim()
  .min(10, 'Explica el motivo con al menos 10 caracteres.')
  .max(500, 'El motivo es demasiado largo.')

const id = z.string().min(1).max(64)

export const suspendTenantSchema = z.object({ tenantId: id, reason: motivo })
export const reactivateTenantSchema = z.object({ tenantId: id, reason: motivo })

export const startImpersonationSchema = z.object({
  tenantId: id,
  /** Sin especificar, se suplanta al OWNER. */
  targetUserId: id.optional(),
  reason: motivo,
})

export type SuspendTenantInput = z.infer<typeof suspendTenantSchema>
export type StartImpersonationInput = z.infer<typeof startImpersonationSchema>
