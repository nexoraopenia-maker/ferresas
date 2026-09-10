import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verificación de firma de webhooks.
 *
 * ─── POR QUÉ ESTO ES LO MÁS IMPORTANTE DEL MÓDULO ────────────────────────
 *
 * El endpoint de webhooks es público: no lleva sesión ni cookie. Si no se
 * verifica la firma, cualquiera puede hacer un POST con
 * `{"type":"invoice.payment_succeeded"}` y darse servicio gratis de por vida.
 * Es, literalmente, la puerta trasera al modelo de negocio.
 *
 * Todo lo demás del webhook puede fallar y se arregla con un reintento. Esto
 * no: si se acepta un evento falso, el estado queda corrupto y nadie se
 * entera.
 *
 * Implementado a mano con node:crypto en vez de arrastrar el SDK de Stripe.
 * Son treinta líneas, el algoritmo está especificado y así queda visible qué
 * se está comprobando exactamente — incluida la ventana anti-replay, que es
 * la parte que se olvida cuando uno confía en que "el SDK ya lo hace".
 */

export type VerifyResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: VerifyFailure }

export type VerifyFailure =
  | 'MISSING_HEADER'
  | 'MALFORMED_HEADER'
  | 'BAD_SIGNATURE'
  | 'TIMESTAMP_OUT_OF_TOLERANCE'
  | 'MISSING_SECRET'

/** Ventana anti-replay. Stripe usa 5 minutos por defecto. */
export const DEFAULT_TOLERANCE_SECONDS = 300

/**
 * Comparación en tiempo constante. Un `===` sobre el hex filtraría, byte a
 * byte, cuánto acertó el atacante — suficiente para reconstruir una firma
 * válida a base de intentos.
 */
function equalsConstantTime(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  // timingSafeEqual exige longitudes iguales; distinta longitud es un fallo
  // que se puede reportar sin filtrar nada útil.
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
}

/**
 * Firma de Stripe.
 * Cabecera: `t=1699999999,v1=<hex>,v0=<hex>`
 * Se firma `${t}.${rawBody}` con el secreto `whsec_...`.
 */
export function verifyStripeSignature(params: {
  rawBody: string
  signatureHeader: string | null
  secret: string | undefined
  now?: Date
  toleranceSeconds?: number
}): VerifyResult {
  const {
    rawBody,
    signatureHeader,
    secret,
    now = new Date(),
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  } = params

  if (!secret) return { ok: false, reason: 'MISSING_SECRET' }
  if (!signatureHeader) return { ok: false, reason: 'MISSING_HEADER' }

  let timestamp: number | null = null
  const firmas: string[] = []

  for (const parte of signatureHeader.split(',')) {
    const [clave, valor] = parte.trim().split('=')
    if (!clave || !valor) continue
    if (clave === 't') timestamp = Number(valor)
    // Solo se aceptan firmas v1. v0 es del esquema antiguo y no se admite.
    if (clave === 'v1') firmas.push(valor)
  }

  if (timestamp === null || !Number.isFinite(timestamp) || firmas.length === 0) {
    return { ok: false, reason: 'MALFORMED_HEADER' }
  }

  // Sin esta comprobación, un evento legítimo capturado de la red podría
  // reenviarse meses después y volvería a aplicarse.
  const desfase = Math.abs(Math.floor(now.getTime() / 1000) - timestamp)
  if (desfase > toleranceSeconds) {
    return { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' }
  }

  const esperada = hmacHex(secret, `${timestamp}.${rawBody}`)
  const valida = firmas.some((f) => equalsConstantTime(f, esperada))

  return valida ? { ok: true, timestamp } : { ok: false, reason: 'BAD_SIGNATURE' }
}

/**
 * Firma de MercadoPago.
 * Cabecera `x-signature: ts=<epoch>,v1=<hex>` más `x-request-id`.
 * El manifiesto firmado es `id:<data.id>;request-id:<req-id>;ts:<ts>;`
 *
 * Ojo: MercadoPago NO firma el cuerpo, sino ese manifiesto. Así que la firma
 * garantiza que el AVISO viene de ellos, no que el cuerpo esté intacto. Por
 * eso el handler vuelve a consultar el recurso por API antes de darlo por
 * bueno (ver la nota en webhook-service.ts).
 */
export function verifyMercadoPagoSignature(params: {
  signatureHeader: string | null
  requestId: string | null
  dataId: string | null
  secret: string | undefined
  now?: Date
  toleranceSeconds?: number
}): VerifyResult {
  const {
    signatureHeader,
    requestId,
    dataId,
    secret,
    now = new Date(),
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  } = params

  if (!secret) return { ok: false, reason: 'MISSING_SECRET' }
  if (!signatureHeader) return { ok: false, reason: 'MISSING_HEADER' }

  let ts: number | null = null
  let v1: string | null = null

  for (const parte of signatureHeader.split(',')) {
    const [clave, valor] = parte.trim().split('=')
    if (clave === 'ts') ts = Number(valor)
    if (clave === 'v1') v1 = valor ?? null
  }

  if (ts === null || !Number.isFinite(ts) || !v1 || !dataId) {
    return { ok: false, reason: 'MALFORMED_HEADER' }
  }

  // MercadoPago envía el ts en milisegundos en algunos avisos y en segundos
  // en otros; se normaliza para que la ventana anti-replay no dependa de eso.
  const tsSegundos = ts > 1e11 ? Math.floor(ts / 1000) : ts
  const desfase = Math.abs(Math.floor(now.getTime() / 1000) - tsSegundos)
  if (desfase > toleranceSeconds) {
    return { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' }
  }

  // El id se normaliza a minúsculas si es alfanumérico, como documenta MP.
  const id = /^[a-zA-Z0-9]+$/.test(dataId) ? dataId.toLowerCase() : dataId
  const manifiesto = `id:${id};request-id:${requestId ?? ''};ts:${ts};`

  return equalsConstantTime(v1, hmacHex(secret, manifiesto))
    ? { ok: true, timestamp: tsSegundos }
    : { ok: false, reason: 'BAD_SIGNATURE' }
}

/** Utilidad para tests y para firmar en un entorno de staging propio. */
export function signStripePayload(secret: string, rawBody: string, timestamp: number): string {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${rawBody}`)}`
}

export function signMercadoPagoManifest(
  secret: string,
  dataId: string,
  requestId: string,
  ts: number,
): string {
  const id = /^[a-zA-Z0-9]+$/.test(dataId) ? dataId.toLowerCase() : dataId
  return `ts=${ts},v1=${hmacHex(secret, `id:${id};request-id:${requestId};ts:${ts};`)}`
}
