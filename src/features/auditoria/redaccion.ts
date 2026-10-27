/**
 * Lo que se enseña del «antes» y «después» de un registro de auditoría. Puro.
 *
 * El registro guarda lo que cada servicio decidió anotar; no siempre fue pensado para mostrarse. Antes de pintar nada se tapan los valores
 * de las claves que parecen secretos (contraseñas, tokens, certificados, claves SOL…), aunque estén anidadas, y los textos que PARECEN un
 * token aunque su clave no lo diga. Es una red de seguridad: lo correcto sigue siendo no anotar secretos.
 */
export const OCULTO = '«oculto»'
const MAX_PROFUNDIDAD = 8, MAX_ELEMENTOS = 50, MAX_TEXTO = 500

const FRAGMENTOS = ['pass', 'secret', 'token', 'clave', 'pfx', 'p12', 'certificad', 'certificate', 'privatekey', 'credential', 'authorization', 'cookie', 'apikey', 'cvv', 'totp', 'hash', 'otpauth', 'sol']
const CLAVES_EXACTAS = ['pin', 'key', 'sol', 'otp', 'iv', 'salt']

/** Normaliza «client_secret», «clientSecret», «Client-Secret» → «clientsecret». */
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')
export function esClaveSensible(k: string): boolean {
  const n = norm(k)
  if (CLAVES_EXACTAS.includes(n)) return true
  // «sol» solo cuenta cuando está pegada a usuario/clave/password (usuarioSol, claveSol…); suelta es demasiado común («solicitud»).
  return FRAGMENTOS.some((f) => f !== 'sol' && n.includes(f)) || /(usuario|user|clave|password)sol|^sol(usuario|user|clave|password)/.test(n)
}

const pareceToken = (s: string) => /^bearer\s+\S{8,}/i.test(s) || /^eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*$/.test(s) || /^-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/.test(s)

export function redactar(valor: unknown, profundidad = 0): unknown {
  if (valor === null || valor === undefined) return valor ?? null
  if (typeof valor === 'string') return pareceToken(valor) ? OCULTO : valor.length > MAX_TEXTO ? `${valor.slice(0, MAX_TEXTO)}… (${valor.length - MAX_TEXTO} más)` : valor
  if (typeof valor === 'number' || typeof valor === 'boolean') return valor
  if (profundidad >= MAX_PROFUNDIDAD) return '«…»'
  if (Array.isArray(valor)) {
    const r = valor.slice(0, MAX_ELEMENTOS).map((v) => redactar(v, profundidad + 1))
    if (valor.length > MAX_ELEMENTOS) r.push(`… (${valor.length - MAX_ELEMENTOS} más)`)
    return r
  }
  if (typeof valor === 'object') {
    const r: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) r[k] = esClaveSensible(k) && v !== null && v !== undefined && v !== '' ? OCULTO : redactar(v, profundidad + 1)
    return r
  }
  return String(valor)
}

/** El valor redactado como texto legible, con tope de tamaño. `null` si no había nada que mostrar. */
export function mostrarJson(valor: unknown, max = 4000): { texto: string; truncado: boolean } | null {
  if (valor === null || valor === undefined) return null
  const t = JSON.stringify(redactar(valor), null, 2)
  return t.length > max ? { texto: `${t.slice(0, max)}\n…`, truncado: true } : { texto: t, truncado: false }
}
