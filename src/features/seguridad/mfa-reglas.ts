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
 * SEGUNDO FACTOR APAGADO DE FORMA FIJA (decisión del dueño): esta función devuelve `false` en su PRIMERA línea y NO mira ninguna variable de entorno. Ni el inicio de sesión
 * (`auth.ts`) pide el código, ni `resolveTenantContext` marca `mfaPendiente` (no se redirige a activarlo). `MFA_ACTIVO` ya no hace nada.
 * Nada se borró: el código, los secretos guardados y las pantallas de activación siguen ahí. Para volver a exigirlo hay que quitar el `return false` y descomentar la lógica de
 * abajo (un cambio de código y un despliegue).
 * ⚠️ Con esto apagado una contraseña robada basta para entrar (también a la cuenta de SuperAdmin).
 */
export const segundoFactorExigido = (_env: Record<string, string | undefined> = process.env): boolean => {
  return false
  // Lógica anterior (desactivada): solo se exigía con MFA_ACTIVO=true.
  // return _env.MFA_ACTIVO === 'true'
}

export const MAX_INTENTOS_MFA = 5
export const BLOQUEO_MFA_MS = 15 * 60_000
export const EMISOR_TOTP = 'FerreSaaS'
