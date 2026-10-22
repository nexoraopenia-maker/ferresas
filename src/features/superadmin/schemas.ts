import { z } from 'zod'
import { passwordSchema } from '@/features/usuarios/schemas'

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

/**
 * Cambio de contraseña del propio Super Admin.
 *
 * Exige la contraseña ACTUAL aunque la sesión ya esté autenticada. No es
 * redundante: si alguien roba una sesión abierta, sin este requisito podría
 * cambiar la contraseña y quedarse con la cuenta, dejando fuera al dueño
 * legítimo. Pedirla convierte el robo de sesión en algo temporal.
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Escribe tu contraseña actual.').max(200),
    newPassword: z
      .string()
      .min(12, 'Para esta cuenta, usa al menos 12 caracteres.')
      .max(200, 'La contraseña es demasiado larga.')
      .refine((p) => p.trim().length >= 12, 'No puede ser solo espacios.'),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Las contraseñas no coinciden.',
    path: ['confirmPassword'],
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    message: 'La contraseña nueva debe ser distinta de la actual.',
    path: ['newPassword'],
  })

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>

/** Cambio manual de plan de un cliente (§5.3: siempre auditado). */
export const changeTenantPlanSchema = z.object({
  tenantId: z.string().min(1).max(64),
  planCode: z.string().trim().min(1).max(40),
  reason: z
    .string()
    .trim()
    .min(10, 'Explica el motivo con al menos 10 caracteres.')
    .max(500),
})

export type ChangeTenantPlanInput = z.infer<typeof changeTenantPlanSchema>

/** Extensión manual del período de prueba. */
export const extendTrialSchema = z.object({
  tenantId: z.string().min(1).max(64),
  days: z
    .number()
    .int('Usa días enteros.')
    .min(1, 'Mínimo 1 día.')
    .max(90, 'Máximo 90 días: por encima de eso, cámbiale el plan.'),
  reason: z.string().trim().min(10, 'Explica el motivo.').max(500),
})

export type ExtendTrialInput = z.infer<typeof extendTrialSchema>

/**
 * Reseteo de la contraseña del dueño de una ferretería, hecho por soporte.
 *
 * No pide la contraseña actual —el Super Admin no la conoce— así que el
 * control es el rol más el motivo auditado. La nueva se TECLEA a mano
 * (`password`) o, si se omite, la genera el sistema. Al teclearla, soporte
 * decide la clave: conviene darle una distinta a cada cuenta.
 */
export const resetOwnerPasswordSchema = z.object({
  tenantId: z.string().min(1).max(64),
  /** Usuario concreto; si falta, se resetea al OWNER del tenant. */
  userId: z.string().min(1).max(64).optional(),
  reason: z
    .string()
    .trim()
    .min(10, 'Explica el motivo con al menos 10 caracteres.')
    .max(500),
  /** Contraseña nueva escrita por soporte. Si falta, el servidor genera una al azar. */
  password: passwordSchema.optional(),
})

export type ResetOwnerPasswordInput = z.infer<typeof resetOwnerPasswordSchema>

/** Edición de los datos fiscales y de contacto de una ferretería. */
export const updateTenantProfileSchema = z.object({
  tenantId: z.string().min(1).max(64),
  name: z.string().trim().min(3, 'El nombre es muy corto.').max(120).optional(),
  legalName: z.string().trim().max(160).optional(),
  // 11 dígitos exactos: un RUC mal escrito invalida las facturas emitidas
  // después, y eso no se ve hasta que SUNAT las rechaza.
  taxId: z
    .string()
    .trim()
    .regex(/^\d{11}$/, 'El RUC debe tener exactamente 11 dígitos.')
    .optional()
    .or(z.literal('')),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  email: z.email('Correo inválido.').max(200).optional().or(z.literal('')),
  address: z.string().trim().max(300).optional().or(z.literal('')),
  reason: z.string().trim().min(10, 'Explica el motivo.').max(500),
})

export type UpdateTenantProfileInput = z.infer<typeof updateTenantProfileSchema>
