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

/**
 * INTERRUPTOR GENERAL del segundo factor. Por decisión del dueño el sistema NO lo pide por defecto: ni el código al iniciar sesión ni la activación obligatoria de dueño y
 * administrador. Para volver a exigirlo, define `MFA_ACTIVO=true` en el entorno (Vercel / .env.local). Nada se borra: el código, los secretos ya guardados y las pantallas de
 * activación siguen ahí, y al reactivar el interruptor las cuentas que lo habían activado vuelven a pedir el código.
 * ⚠️ Con el interruptor apagado una contraseña robada basta para entrar (también a la cuenta de SuperAdmin).
 */
export const segundoFactorExigido = (env: Record<string, string | undefined> = process.env): boolean => env.MFA_ACTIVO === 'true'

export const MAX_INTENTOS_MFA = 5
export const BLOQUEO_MFA_MS = 15 * 60_000
export const EMISOR_TOTP = 'FerreSaaS'
