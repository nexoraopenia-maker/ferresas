import type { Role } from '@/generated/prisma/enums'

/**
 * Reglas del segundo factor (puras, sin base de datos).
 *
 * Una cuenta que puede borrar datos o cambiar la configuración no puede
 * depender solo de una contraseña; pero al cajero del mostrador no se le frena
 * pidiéndole el celular. Por eso es obligatorio para quien manda y opcional
 * para el resto. Es una tabla, no comparaciones de rol sueltas.
 */
export const ROLES_CON_MFA_OBLIGATORIO: ReadonlySet<Role> = new Set<Role>(['OWNER', 'ADMIN'])

/** Con varios roles basta uno de los que lo exigen. */
export const mfaObligatorio = (roles: readonly Role[]): boolean =>
  roles.some((r) => ROLES_CON_MFA_OBLIGATORIO.has(r))

export const MAX_INTENTOS_MFA = 5
export const BLOQUEO_MFA_MS = 15 * 60_000
export const EMISOR_TOTP = 'FerreSaaS'
