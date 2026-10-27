import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'dotenv'
import { huella, normalizarHuella } from '../src/lib/huella-bd'

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

export { huella, normalizarHuella }

export interface Veredicto {
  ok: boolean
  /** Motivo legible; nunca contiene credenciales. */
  motivo: string
  /** true si el destino ES producción (distinto de «no se pudo comprobar»). */
  contraProduccion?: boolean
}

/**
 * LISTA BLANCA. Se puede escribir en un destino solo si es staging identificado POSITIVAMENTE:
 * todas las URL de conexión deben tener la huella de `STAGING_DB_FINGERPRINT`. No basta con «no es producción»:
 * una base desconocida, una local olvidada o una URL mal copiada también se niegan.
 *
 * Además se niega si DATABASE_URL y DIRECT_URL apuntan a bases distintas (migración cruzada), si falta cualquiera de las dos huellas, si son la misma, si algún destino coincide con
 * producción (la variable explícita o lo que diga `.env`) o si alguna URL no se puede interpretar.
 */
export function evaluarDestinos(
  destinos: Record<string, string | undefined>,
  huellaProduccion: string | undefined,
  huellasExtraProduccion: string[] = [],
  huellaStaging?: string | undefined,
): Veredicto {
  const prod = normalizarHuella(huellaProduccion)
  if (!prod) {
    return { ok: false, motivo: 'PROD_DB_FINGERPRINT no está definida o no tiene la forma «host/nombre_de_base». Sin la huella de producción no se puede comprobar que el destino sea otro.' }
  }
  // La app lee DATABASE_URL y el CLI de Prisma migra por DIRECT_URL (`prisma.config.ts`). Si apuntan a bases DISTINTAS, se migraría una y se leería
  // otra. Pasó en Vercel: DATABASE_URL a producción y DIRECT_URL a staging; el build migró STAGING y producción se quedó sin sus tablas. La
  // directa es la misma base que la pooled sin `-pooler` (misma huella), así que una diferencia nunca es legítima. Aplica en TODO entorno,
  // y antes que cualquier otro veredicto: ni siquiera «producción a propósito» autoriza migrar una base distinta de la que lee la app.
  const baseApp = huella(destinos.DATABASE_URL), baseCli = huella(destinos.DIRECT_URL)
  if (baseApp && baseCli && baseApp !== baseCli) {
    return {
      ok: false,
      motivo: `DATABASE_URL (${baseApp}) y DIRECT_URL (${baseCli}) apuntan a bases DISTINTAS: Prisma migraría una y la app leería otra. ` +
        'Corrige las variables: la directa es la MISMA base que la pooled, solo que sin «-pooler» ni los parámetros de pgbouncer.',
    }
  }
  const conocidas = new Set([prod, ...huellasExtraProduccion])
  const definidos = Object.entries(destinos).filter(([, v]) => v)
  if (definidos.length === 0) return { ok: false, motivo: 'No hay ninguna URL de base de datos definida.' }
  // Producción primero: es el caso grave y tiene su propio camino (despliegue a propósito).
  for (const [nombre, url] of definidos) {
    const h = huella(url)
    if (!h) return { ok: false, motivo: `${nombre} no se puede interpretar como URL con host y nombre de base.` }
    if (conocidas.has(h)) return { ok: false, contraProduccion: true, motivo: `${nombre} apunta a PRODUCCIÓN (${h}): mismo host y mismo nombre de base.` }
  }
  const stg = normalizarHuella(huellaStaging)
  if (!stg) return { ok: false, motivo: 'STAGING_DB_FINGERPRINT no está definida o no tiene la forma «host/nombre_de_base»: solo se corre contra staging identificado positivamente.' }
  if (conocidas.has(stg)) return { ok: false, motivo: 'STAGING_DB_FINGERPRINT es igual a la de producción: las dos huellas deben ser distintas.' }
  for (const [nombre, url] of definidos) {
    const h = huella(url)
    if (h !== stg) return { ok: false, motivo: `${nombre} (${h}) no es el staging declarado (${stg}): se niega por lista blanca.` }
  }
  return { ok: true, motivo: 'todos los destinos son el staging declarado' }
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
  return evaluarDestinos(destinos, env.PROD_DB_FINGERPRINT ?? delArchivo.PROD_DB_FINGERPRINT, extra, env.STAGING_DB_FINGERPRINT ?? delArchivo.STAGING_DB_FINGERPRINT)
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
  const v = evaluarDestinos(destinos, env.PROD_DB_FINGERPRINT ?? delArchivo.PROD_DB_FINGERPRINT, extra, env.STAGING_DB_FINGERPRINT ?? delArchivo.STAGING_DB_FINGERPRINT)
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
  console.log(`staging    (huella explícita): ${normalizarHuella(env.STAGING_DB_FINGERPRINT) ?? '—'}`)
  console.log(v.ok ? `✓ ${v.motivo}` : `✗ ${v.motivo}`)
  process.exit(v.ok ? 0 : 2)
}
