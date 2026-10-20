import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Cookie del operador activo (PIN de cajero).
 *
 * Dice «en ESTE dispositivo, cuya sesión es la de `sub` (sesión `sid`), el
 * operador actual es `op`». Va firmada con HMAC y atada al `sid`: copiar la
 * cookie a otro dispositivo, o conservarla tras cerrar la sesión, no sirve de
 * nada, porque el `sid` ya no coincide o está revocado.
 *
 * NO es una credencial: no da acceso a nada por sí sola. Solo cambia a QUIÉN se
 * atribuyen las acciones dentro de una sesión que ya estaba autenticada.
 */
export const OPERATOR_COOKIE = 'ferresaas.operador'
export const OPERADOR_MAX_HORAS = 12

export interface OperadorClaims {
  /** Sesión de dispositivo (DeviceSession.id) a la que está atada. */
  sid: string
  /** Usuario de la sesión (quien inició sesión en el dispositivo). */
  sub: string
  /** Operador que entró con su PIN. */
  op: string
  exp: number
}

function secreto(): string {
  const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET
  if (!s) throw new Error('AUTH_SECRET ausente: no se puede firmar la cookie de operador.')
  return s
}

const firma = (cuerpo: string) => createHmac('sha256', `operador:${secreto()}`).update(cuerpo).digest('base64url')

export function emitirOperadorToken(
  claims: Omit<OperadorClaims, 'exp'>,
  ahora: Date = new Date(),
  horas: number = OPERADOR_MAX_HORAS,
): string {
  const exp = Math.floor(ahora.getTime() / 1000) + horas * 3600
  const cuerpo = Buffer.from(JSON.stringify({ ...claims, exp })).toString('base64url')
  return `${cuerpo}.${firma(cuerpo)}`
}

export function verificarOperadorToken(token: string | undefined, ahora: Date = new Date()): OperadorClaims | null {
  if (!token) return null
  const corte = token.lastIndexOf('.')
  if (corte <= 0) return null
  const cuerpo = token.slice(0, corte)
  const dada = token.slice(corte + 1)

  let esperada: string
  try { esperada = firma(cuerpo) } catch { return null }
  const a = Buffer.from(dada)
  const b = Buffer.from(esperada)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const c = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8')) as Partial<OperadorClaims>
    if (typeof c.sid !== 'string' || typeof c.sub !== 'string' || typeof c.op !== 'string' || typeof c.exp !== 'number') return null
    if (c.exp * 1000 <= ahora.getTime()) return null
    return c as OperadorClaims
  } catch {
    return null
  }
}
