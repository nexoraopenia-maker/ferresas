import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'dotenv'

/**
 * Huella de una base de datos: «host/nombre», SIN usuario, clave ni parámetros.
 *
 * Compara host Y nombre de base: el mismo servidor puede alojar bases distintas, y bases con el mismo
 * nombre en servidores distintos tampoco son la misma. Del host se descarta `-pooler` (el endpoint
 * de Neon con pooler y el directo son LA MISMA base) y el puerto.
 *
 * La usan `tests/guard.ts` y `scripts/migrar-staging.sh`. Es una función pura: no se conecta a nada.
 */

/** Variables de entorno que el código o el CLI de Prisma usan para conectarse. */
export const VARIABLES_DE_CONEXION = ['DATABASE_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL'] as const

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

export interface Veredicto {
  ok: boolean
  /** Motivo legible; nunca contiene credenciales. */
  motivo: string
  /** true si el destino ES producción (distinto de «no se pudo comprobar»). */
  contraProduccion?: boolean
}

/**
 * ¿Es seguro escribir en estos destinos? `destinos` son las URL a las que se conectaría el proceso;
 * `produccion` son las huellas conocidas de producción (la variable explícita y la de `.env`).
 * Se niega si: falta la huella explícita (no se puede garantizar nada), algún destino no se puede leer,
 * o algún destino coincide en host Y base con producción.
 */
export function evaluarDestinos(destinos: Record<string, string | undefined>, huellaExplicita: string | undefined, huellasExtra: string[] = []): Veredicto {
  const prod = normalizarHuella(huellaExplicita)
  if (!prod) {
    return { ok: false, motivo: 'PROD_DB_FINGERPRINT no está definida o no tiene la forma «host/nombre_de_base». Sin la huella de producción no se puede comprobar que el destino sea otro.' }
  }
  const conocidas = new Set([prod, ...huellasExtra])
  const definidos = Object.entries(destinos).filter(([, v]) => v)
  if (definidos.length === 0) return { ok: false, motivo: 'No hay ninguna URL de base de datos definida.' }
  for (const [nombre, url] of definidos) {
    const h = huella(url)
    if (!h) return { ok: false, motivo: `${nombre} no se puede interpretar como URL con host y nombre de base.` }
    if (conocidas.has(h)) return { ok: false, contraProduccion: true, motivo: `${nombre} apunta a PRODUCCIÓN (${h}): mismo host y mismo nombre de base.` }
  }
  return { ok: true, motivo: 'ningún destino coincide con la huella de producción' }
}

/** Lee un archivo .env SIN tocar process.env. */
export function leerEnv(ruta: string): Record<string, string> {
  return existsSync(ruta) ? parse(readFileSync(ruta)) : {}
}

/**
 * Evalúa el entorno real: lo que el proceso usará (ya cargado) más lo que dice `.env` de producción.
 * Si `.env` y el destino comparten host y base, se niega aunque nadie haya definido la huella a mano.
 */
export function evaluarEntorno(env: Record<string, string | undefined> = process.env, rutaEnvProd = '.env'): Veredicto {
  const destinos: Record<string, string | undefined> = {}
  for (const k of VARIABLES_DE_CONEXION) destinos[k] = env[k]
  const delArchivo = leerEnv(rutaEnvProd)
  const extra = VARIABLES_DE_CONEXION.map((k) => huella(delArchivo[k])).filter((x): x is string => !!x)
  return evaluarDestinos(destinos, env.PROD_DB_FINGERPRINT ?? delArchivo.PROD_DB_FINGERPRINT, extra)
}

// ─── Guardia del CLI de Prisma ──────────────────────────────────────────────────────────────────
// `prisma.config.ts` la ejecuta en CADA comando de prisma (npx, scripts de npm, build de Vercel):
// no hay forma de llegar a una base con `prisma migrate` sin pasar por aquí, ni por el .env por defecto.

/** Subcomandos que abren una conexión a la base. */
const TOCA_BASE = new Set(['migrate', 'db', 'studio'])
/** Lo único que se permite contra producción, y solo a propósito. */
const PERMITIDO_EN_PRODUCCION = new Set(['migrate deploy', 'migrate status'])
/** Opciones del CLI que traen su propia URL o su propia configuración (se saltarían el .env). */
const OPCIONES_CON_URL = ['--url', '--from-url', '--to-url', '--shadow-database-url', '--from-schema-datasource', '--to-schema-datasource']

export function evaluarComandoPrisma(argv: string[], env: Record<string, string | undefined> = process.env, rutaEnvProd = '.env'): Veredicto {
  const args = argv.slice(2)
  const sub = args.find((a) => !a.startsWith('-'))
  if (!sub || !TOCA_BASE.has(sub)) return { ok: true, motivo: 'comando sin conexión a la base' }
  const comando = [sub, args.filter((a) => !a.startsWith('-'))[1]].filter(Boolean).join(' ')

  if (args.some((a) => a === '--config' || a.startsWith('--config='))) {
    return { ok: false, motivo: '`--config` está prohibido: saltaría la guardia de huella de producción.' }
  }
  // URL pasadas por opción: se evalúan igual que las del entorno.
  const destinos: Record<string, string | undefined> = { DATABASE_URL: env.DATABASE_URL, DIRECT_URL: env.DIRECT_URL, SHADOW_DATABASE_URL: env.SHADOW_DATABASE_URL }
  args.forEach((a, i) => {
    for (const o of OPCIONES_CON_URL) {
      if (a === o) destinos[o] = args[i + 1]
      else if (a.startsWith(`${o}=`)) destinos[o] = a.slice(o.length + 1)
    }
  })
  const delArchivo = leerEnv(rutaEnvProd)
  const extra = VARIABLES_DE_CONEXION.map((k) => huella(delArchivo[k])).filter((x): x is string => !!x)
  const v = evaluarDestinos(destinos, env.PROD_DB_FINGERPRINT ?? delArchivo.PROD_DB_FINGERPRINT, extra)
  if (v.ok || !v.contraProduccion) return v

  // Es producción: solo `migrate deploy|status`, y solo en el build de producción de Vercel o con el
  // permiso escrito en la propia línea de comandos (nunca en un fichero).
  const intencional = env.VERCEL_ENV === 'production' || env.I_UNDERSTAND_THIS_IS_PRODUCTION === 'true'
  if (!PERMITIDO_EN_PRODUCCION.has(comando)) return { ...v, motivo: `${v.motivo} \`prisma ${comando}\` nunca se ejecuta contra producción.` }
  if (!intencional) return { ...v, motivo: `${v.motivo} Para migrar producción a propósito: I_UNDERSTAND_THIS_IS_PRODUCTION=true en la línea de comandos (o el build de producción de Vercel).` }
  return { ok: true, contraProduccion: true, motivo: `producción, a propósito: prisma ${comando}` }
}

// ─── Uso desde el shell: `tsx scripts/huella-bd.ts` ─────────────────────────────────────────────
// Carga .env.local y luego .env (como Prisma), imprime SOLO huellas y sale con 0 (seguro) o 2 (negado).
if (process.argv[1] && /huella-bd\.ts$/.test(process.argv[1])) {
  const local = leerEnv('.env.local')
  const base = leerEnv('.env')
  const env = { ...base, ...local, ...process.env }
  const v = evaluarEntorno(env)
  const mostrar = (k: string) => `${k}: ${huella(env[k]) ?? '—'}`
  console.log(['DATABASE_URL', 'DIRECT_URL'].map(mostrar).join('\n'))
  console.log(`producción (huella explícita): ${normalizarHuella(env.PROD_DB_FINGERPRINT) ?? '—'}`)
  console.log(v.ok ? `✓ ${v.motivo}` : `✗ ${v.motivo}`)
  process.exit(v.ok ? 0 : 2)
}
