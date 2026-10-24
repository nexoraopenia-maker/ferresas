/**
 * Huella de una base de datos: «host/nombre», SIN usuario, clave ni parámetros.
 *
 * Compara host Y nombre de base: el mismo servidor puede alojar bases distintas, y bases con el mismo
 * nombre en servidores distintos tampoco son la misma. Del host se descarta `-pooler` (el endpoint
 * de Neon con pooler y el directo son LA MISMA base) y el puerto.
 *
 * Funciones puras, sin dotenv ni fs: las usan la guardia de los scripts (`scripts/huella-bd.ts`) y el diagnóstico
 * de la app en ejecución (`src/lib/diagnostico-base.ts`).
 */

export function huella(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase().replace(/-pooler(?=\.)/, '')
    const base = decodeURIComponent(u.pathname.replace(/^\/+/, '')).toLowerCase()
    if (!host || !base) return null
    return `${host}/${base}`
  } catch {
    return null
  }
}

/** Normaliza lo escrito en `PROD_DB_FINGERPRINT` (acepta «host/base» con o sin `-pooler`). */
export function normalizarHuella(texto: string | undefined | null): string | null {
  const t = (texto ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '')
  const m = /^([^/\s:]+)(?::\d+)?\/([^/?\s]+)$/.exec(t)
  return m ? `${m[1]!.replace(/-pooler(?=\.)/, '')}/${m[2]}` : null
}
