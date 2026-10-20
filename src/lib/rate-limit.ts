/**
 * Rate limiter de ventana deslizante, en memoria.
 *
 * ─── LO QUE ESTO ES Y LO QUE NO ES ───────────────────────────────────────
 *
 * En Vercel cada instancia serverless tiene SU PROPIA memoria. Con tres
 * instancias calientes, un atacante obtiene efectivamente el triple del
 * límite, y un despliegue reinicia todos los contadores. Así que esto NO es
 * una defensa dura: es un freno que convierte "un script llena la BD de
 * tenants basura en un minuto" en "necesita esfuerzo sostenido y se le ve
 * venir en las métricas".
 *
 * Para una defensa real hace falta estado compartido (Vercel KV, Upstash) o
 * el WAF del borde. Se deja preparado: `checkRateLimit` es asíncrona a
 * propósito, aunque hoy no lo necesite, para poder cambiar el almacén por uno
 * remoto sin tocar ni una línea de quien la llama.
 *
 * La ventana es DESLIZANTE y no fija: con ventana fija, un atacante manda su
 * cupo al final de un minuto y otro cupo al principio del siguiente, logrando
 * el doble del límite en dos segundos.
 */

export interface RateLimitRule {
  /** Peticiones permitidas dentro de la ventana. */
  limit: number
  windowSeconds: number
}

export interface RateLimitResult {
  ok: boolean
  remaining: number
  retryAfterSeconds: number
}

/** Marcas de tiempo (ms) de los intentos recientes, por clave. */
const hits = new Map<string, number[]>()

/**
 * Sin esto el Map crece sin fin: cada IP que pase una vez por el registro
 * dejaría su entrada para siempre. En un proceso de larga vida es una fuga
 * de memoria lenta pero segura.
 */
const MAX_KEYS = 10_000

function evictIfNeeded(now: number, windowMs: number) {
  if (hits.size <= MAX_KEYS) return
  for (const [key, marcas] of hits) {
    const vivas = marcas.filter((t) => now - t < windowMs)
    if (vivas.length === 0) hits.delete(key)
    else hits.set(key, vivas)
  }
  // Si tras limpiar sigue lleno, es un ataque distribuido: se vacía entero.
  // Perder contadores es preferible a quedarse sin memoria.
  if (hits.size > MAX_KEYS) hits.clear()
}

export async function checkRateLimit(
  key: string,
  rule: RateLimitRule,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const ahora = now.getTime()
  const windowMs = rule.windowSeconds * 1000

  evictIfNeeded(ahora, windowMs)

  const previas = hits.get(key) ?? []
  const dentro = previas.filter((t) => ahora - t < windowMs)

  if (dentro.length >= rule.limit) {
    const masAntigua = dentro[0]!
    const esperar = Math.ceil((windowMs - (ahora - masAntigua)) / 1000)
    // No se registra el intento rechazado: si se hiciera, un atacante que
    // insiste extendería su propio castigo indefinidamente y un usuario
    // legítimo detrás de la misma IP nunca podría entrar.
    hits.set(key, dentro)
    return { ok: false, remaining: 0, retryAfterSeconds: Math.max(esperar, 1) }
  }

  dentro.push(ahora)
  hits.set(key, dentro)

  return {
    ok: true,
    remaining: rule.limit - dentro.length,
    retryAfterSeconds: 0,
  }
}

/** Solo para pruebas: reinicia el estado entre casos. */
export function resetRateLimits() {
  hits.clear()
}

/**
 * IP del cliente.
 *
 * `x-forwarded-for` lo puede falsificar cualquiera SI la app se expone
 * directamente. Detrás de Vercel no: su borde reescribe la cabecera y la
 * primera entrada es la IP real. Por eso este código asume despliegue tras
 * un proxy de confianza — servirlo directo desde Node invalidaría el límite.
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for')
  if (xff) {
    const primera = xff.split(',')[0]?.trim()
    if (primera) return primera
  }
  return headers.get('x-real-ip')?.trim() || 'desconocida'
}

/** Reglas del SaaS, en un solo sitio para poder razonar sobre ellas juntas. */
export const RATE_RULES = {
  /**
   * Registro: 5 por hora y por IP. Una ferretería se registra una vez en la
   * vida; cinco intentos cubren de sobra los errores de formulario.
   */
  register: { limit: 5, windowSeconds: 3600 },
  /**
   * Login: 10 por 15 min. bcrypt(12) ya hace lenta la fuerza bruta, pero no
   * frena a quien prueba las 20 contraseñas más comunes contra muchas
   * cuentas.
   */
  login: { limit: 10, windowSeconds: 900 },
  /**
   * Aceptar invitación: 10 por hora y por IP. El token tiene 256 bits y no se
   * adivina; el límite frena el abuso del bcrypt, no el acierto del token.
   */
  invitation: { limit: 10, windowSeconds: 3600 },
  /** Checkout: evita crear decenas de sesiones de pago por doble clic. */
  checkout: { limit: 10, windowSeconds: 300 },
} as const satisfies Record<string, RateLimitRule>
