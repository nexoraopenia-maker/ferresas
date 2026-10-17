import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Token de modo soporte, FIRMADO y con su propia caducidad.
 *
 * ─── POR QUÉ EXISTE ──────────────────────────────────────────────────────
 *
 * Antes la cookie guardaba solo el id de la fila `ImpersonationSession`, y
 * para saber si seguía viva había que CONSULTAR LA BASE. Eso obligaba al
 * proxy a hacer una consulta en cada navegación, y el proxy corre cerca del
 * usuario y lejos de la base: medido, `gru1` (São Paulo) contra `us-east-2`
 * (Ohio), ~120-140 ms por navegación.
 *
 * Ahora la caducidad VIAJA DENTRO del token, firmada. El proxy la verifica
 * con el secreto y corta una sesión de soporte vencida sin tocar la base.
 *
 * ─── POR QUÉ UN TOKEN APARTE Y NO EL JWT DE NEXTAUTH ─────────────────────
 *
 * Meterlo en el JWT de sesión exigiría re-emitirlo al abrir el modo soporte,
 * y eso reinicia su `iat`. Pero `iat` es justo lo que usa `sesionRevocada`
 * para invalidar sesiones anteriores a un cambio de contraseña: re-emitirlo
 * haría que abrir soporte "renovara" una sesión que debía estar revocada.
 * Un token propio tiene la misma propiedad —caducidad verificable sin base—
 * sin tocar ese mecanismo.
 *
 * ─── LO QUE EL TOKEN NO SUSTITUYE ────────────────────────────────────────
 *
 * La firma prueba que el token lo emitimos nosotros y que no ha caducado. NO
 * prueba que la sesión de soporte siga abierta: cerrarla deja `endedAt` en la
 * base, y eso solo se ve consultando. Así que al RENDERIZAR se sigue
 * validando contra la base (`resolveImpersonation`). El token acelera el
 * enrutado; no releva a nadie de comprobar.
 */

export const SUPPORT_COOKIE = 'ferresaas.support'

/** Ventana corta: una sesión de soporte olvidada es una puerta abierta. */
export const SUPPORT_MAX_MINUTES = 60

export interface SupportClaims {
  /** Id de la fila ImpersonationSession. */
  id: string
  tenantId: string
  /** SUPERADMIN que la abrió. Debe coincidir con la sesión de NextAuth. */
  superAdminId: string
  /** Caducidad en segundos epoch. */
  exp: number
}

function secreto(): string {
  const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET
  if (!s) {
    // Mismo criterio que en el resto del proyecto: sin secreto no se finge
    // que algo está firmado.
    throw new Error('AUTH_SECRET ausente: no se puede firmar el token de soporte.')
  }
  return s
}

const b64url = (b: Buffer) => b.toString('base64url')

function firma(cuerpo: string): string {
  return createHmac('sha256', secreto()).update(cuerpo).digest('base64url')
}

/** Firma el token. El resultado va en la cookie. */
export function emitirSupportToken(
  claims: Omit<SupportClaims, 'exp'>,
  minutos: number = SUPPORT_MAX_MINUTES,
  ahora: Date = new Date(),
): string {
  const exp = Math.floor(ahora.getTime() / 1000) + minutos * 60
  const cuerpo = b64url(Buffer.from(JSON.stringify({ ...claims, exp })))
  return `${cuerpo}.${firma(cuerpo)}`
}

/**
 * Verifica firma y caducidad. Devuelve `null` ante CUALQUIER duda.
 *
 * Nunca lanza por un token malformado: un token basura es una cookie vieja o
 * un intento de manipulación, y en ambos casos la respuesta correcta es la
 * misma que si no hubiera cookie.
 */
export function verificarSupportToken(
  token: string | undefined,
  ahora: Date = new Date(),
): SupportClaims | null {
  if (!token) return null

  const corte = token.lastIndexOf('.')
  if (corte <= 0) return null

  const cuerpo = token.slice(0, corte)
  const dada = token.slice(corte + 1)

  let esperada: string
  try {
    esperada = firma(cuerpo)
  } catch {
    // Sin AUTH_SECRET no se puede verificar, así que no se concede nada.
    return null
  }

  const a = Buffer.from(dada)
  const b = Buffer.from(esperada)
  // Comparación en tiempo constante: comparar con === filtra información
  // sobre cuántos bytes acertó quien lo intenta.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let claims: SupportClaims
  try {
    claims = JSON.parse(Buffer.from(cuerpo, 'base64url').toString()) as SupportClaims
  } catch {
    return null
  }

  if (
    typeof claims.id !== 'string' ||
    typeof claims.tenantId !== 'string' ||
    typeof claims.superAdminId !== 'string' ||
    typeof claims.exp !== 'number'
  ) {
    return null
  }

  if (claims.exp * 1000 <= ahora.getTime()) return null

  return claims
}

/** Minutos que le quedan, para el banner. 0 si ya caducó. */
export function minutosRestantes(claims: SupportClaims, ahora: Date = new Date()): number {
  return Math.max(0, Math.ceil((claims.exp * 1000 - ahora.getTime()) / 60_000))
}
