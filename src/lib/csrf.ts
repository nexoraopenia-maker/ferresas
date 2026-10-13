/**
 * Protección CSRF para Route Handlers.
 *
 * ─── POR QUÉ HACE FALTA ESCRIBIRLA A MANO ────────────────────────────────
 *
 * Las Server Actions de Next llevan comprobación de origen incorporada. Un
 * Route Handler NO. Y un POST autenticado por cookie sin esa comprobación es
 * explotable: basta una página maliciosa que el Super Admin visite con su
 * sesión abierta para que su navegador cree tenants en su nombre. El
 * atacante no ve la respuesta, pero el daño ya está hecho.
 *
 * ─── LA REGLA ────────────────────────────────────────────────────────────
 *
 * Si la petición viene de un NAVEGADOR, se exige mismo origen. Se detecta por
 * la presencia de `Origin` o `Sec-Fetch-Site`, cabeceras que el navegador
 * pone siempre y que el JavaScript de una página no puede falsear.
 *
 * Si no viene ninguna de las dos, es un cliente programático (curl, un
 * script de migración, Postman). Ahí el vector CSRF no existe —nadie le
 * adjunta cookies sin querer— así que se deja pasar y la autenticación la
 * resuelve la sesión o el token. Negarlo rompería el uso legítimo desde
 * consola sin ganar nada de seguridad.
 */

export type CsrfResult = { ok: true } | { ok: false; reason: string }

export function checkSameOrigin(headers: Headers): CsrfResult {
  const origin = headers.get('origin')
  const secFetchSite = headers.get('sec-fetch-site')

  // Cliente no-navegador: sin cookies implícitas, sin riesgo CSRF.
  if (!origin && !secFetchSite) return { ok: true }

  // El navegador lo dice directamente y es la señal más fiable.
  if (secFetchSite) {
    if (secFetchSite === 'same-origin' || secFetchSite === 'none') return { ok: true }
    return { ok: false, reason: `sec-fetch-site: ${secFetchSite}` }
  }

  const host = headers.get('x-forwarded-host') ?? headers.get('host')
  if (!host) return { ok: false, reason: 'sin host' }

  const proto = headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  const esperado = `${proto}://${host}`

  // Comparación exacta de orígenes, no `includes`: "https://miapp.com.evil.io"
  // contiene el dominio legítimo y pasaría una comprobación por subcadena.
  return origin === esperado
    ? { ok: true }
    : { ok: false, reason: 'origen distinto' }
}
