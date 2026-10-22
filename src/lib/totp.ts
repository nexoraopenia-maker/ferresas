import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

/**
 * TOTP (RFC 6238) y códigos de recuperación, sin dependencias: HMAC-SHA1,
 * 6 dígitos, paso de 30 s. Son los parámetros que TODAS las apps
 * autenticadoras (Google Authenticator, Authy, Microsoft) soportan; subir a
 * SHA-256 rompería la compatibilidad sin ganar seguridad real aquí.
 *
 * Todo es puro (el reloj entra por parámetro) para poder probarlo con los
 * vectores del RFC.
 */

export const PASO_SEGUNDOS = 30
export const DIGITOS = 6
/** Ventana de tolerancia: ±1 paso, para el desfase de reloj del teléfono. */
export const VENTANA = 1

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let valor = 0
  let out = ''
  for (const byte of buf) {
    valor = (valor << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALFABETO[(valor >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALFABETO[(valor << (5 - bits)) & 31]
  return out
}

export function base32Decode(texto: string): Buffer {
  const limpio = texto.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let valor = 0
  const bytes: number[] = []
  for (const c of limpio) {
    const i = ALFABETO.indexOf(c)
    if (i < 0) throw new Error('Base32 inválido.')
    valor = (valor << 5) | i
    bits += 5
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** Secreto nuevo de 160 bits (lo recomendado por el RFC 4226), en base32. */
export function generarSecreto(): string {
  return base32Encode(randomBytes(20))
}

export function pasoDe(ahora: Date): number {
  return Math.floor(ahora.getTime() / 1000 / PASO_SEGUNDOS)
}

/** HOTP (RFC 4226) para un contador dado. */
export function hotp(secreto: Buffer, contador: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(contador))
  const h = createHmac('sha1', secreto).update(msg).digest()
  const off = h[h.length - 1]! & 0x0f
  const bin =
    ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!
  return String(bin % 10 ** DIGITOS).padStart(DIGITOS, '0')
}

export function totp(secretoBase32: string, ahora: Date): string {
  return hotp(base32Decode(secretoBase32), pasoDe(ahora))
}

function iguales(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Paso cuyo código coincide con `codigo` dentro de la ventana, o null. Se
 * recorren SIEMPRE los tres pasos y se compara en tiempo constante: quién
 * acertó no debe notarse en el tiempo de respuesta.
 */
export function verificarTotp(secretoBase32: string, codigo: string, ahora: Date): number | null {
  if (!/^\d{6}$/.test(codigo)) return null
  const secreto = base32Decode(secretoBase32)
  const actual = pasoDe(ahora)
  let acierto: number | null = null
  for (let d = -VENTANA; d <= VENTANA; d++) {
    if (iguales(hotp(secreto, actual + d), codigo) && acierto === null) acierto = actual + d
  }
  return acierto
}

/** URI `otpauth://` que leen las apps al escanear el QR. */
export function otpauthUrl(secretoBase32: string, cuenta: string, emisor: string): string {
  const etiqueta = encodeURIComponent(`${emisor}:${cuenta}`)
  const q = new URLSearchParams({
    secret: secretoBase32, issuer: emisor, algorithm: 'SHA1',
    digits: String(DIGITOS), period: String(PASO_SEGUNDOS),
  })
  return `otpauth://totp/${etiqueta}?${q}`
}

// ─── Códigos de recuperación ───────────────────────────────────────────────

export const CANTIDAD_CODIGOS = 10
// Sin 0/O/1/I/L: se dictan o se copian a mano desde un papel.
const ALFABETO_RECUPERACION = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** `XXXXX-XXXXX`: 10 caracteres de un alfabeto de 31 ≈ 49 bits por código. */
export function generarCodigosRecuperacion(n: number = CANTIDAD_CODIGOS): string[] {
  return Array.from({ length: n }, () => {
    const c = Array.from({ length: 10 }, () => ALFABETO_RECUPERACION[randomInt(ALFABETO_RECUPERACION.length)]).join('')
    return `${c.slice(0, 5)}-${c.slice(5)}`
  })
}

/** Quita espacios y guiones y pasa a mayúsculas: tolera cómo lo teclee la persona. */
export function normalizarCodigo(texto: string): string {
  return texto.replace(/[\s-]/g, '').toUpperCase()
}

/** ¿Parece un código TOTP (6 dígitos) y no uno de recuperación? */
export const esCodigoTotp = (texto: string) => /^\d{6}$/.test(normalizarCodigo(texto))

/**
 * Los códigos de recuperación tienen ~49 bits aleatorios: un SHA-256 basta (el
 * coste de bcrypt sirve contra contraseñas humanas, no contra esto). Se ata al
 * usuario para que el mismo texto no dé el mismo hash en dos cuentas.
 */
export function hashCodigoRecuperacion(userId: string, codigo: string): string {
  return createHash('sha256').update(`${userId}:${normalizarCodigo(codigo)}`).digest('hex')
}
