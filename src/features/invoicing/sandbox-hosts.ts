/**
 * Barrera de entorno de los scripts de certificación: solo se envía a hosts DECLARADOS como sandbox.
 *
 * `PSE_SANDBOX_HOSTS` es una lista de hosts exactos separados por coma (p. ej. `sandbox.proveedor.pe`).
 * Es deliberadamente más estricta que `PSE_ALLOWED_HOSTS` (que permite sufijos de dominio y también sirve a
 * producción): aquí no hay comodines ni sufijos, porque un `api.proveedor.pe` de producción comparte dominio con
 * su sandbox. DENEGAR POR DEFECTO: sin la variable, o con un host que no esté en ella, no se envía nada.
 *
 * Función pura: no se conecta a nada.
 */

export interface VeredictoSandbox {
  ok: boolean
  /** Motivo legible; nunca contiene el token. */
  motivo: string
}

export function hostsSandbox(env: Record<string, string | undefined> = process.env): string[] {
  return (env.PSE_SANDBOX_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

export function evaluarHostSandbox(
  urlBase: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): VeredictoSandbox {
  const permitidos = hostsSandbox(env)
  if (permitidos.length === 0) {
    return { ok: false, motivo: 'PSE_SANDBOX_HOSTS no está definida: sin ella el script no envía a ningún proveedor. Declara el host exacto del sandbox.' }
  }
  if (permitidos.some((h) => h.includes('*') || h.includes('/') || h.includes(':'))) {
    return { ok: false, motivo: 'PSE_SANDBOX_HOSTS solo admite hosts exactos (sin comodines, rutas ni puertos).' }
  }
  if (!urlBase) return { ok: false, motivo: 'El negocio no tiene URL de proveedor configurada.' }
  let host: string
  try {
    const u = new URL(urlBase)
    if (u.protocol !== 'https:') return { ok: false, motivo: 'La URL del proveedor debe ser https.' }
    host = u.hostname.toLowerCase()
  } catch {
    return { ok: false, motivo: 'La URL del proveedor no se puede interpretar.' }
  }
  if (!permitidos.includes(host)) {
    return { ok: false, motivo: `El host ${host} NO está en PSE_SANDBOX_HOSTS: podría ser producción. No se envía nada.` }
  }
  return { ok: true, motivo: `host ${host} declarado como sandbox` }
}
