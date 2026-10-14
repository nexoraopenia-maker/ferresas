import { config } from 'dotenv'

/**
 * Guardia obligatoria de la suite de pruebas.
 *
 * ─── POR QUÉ EXISTE ──────────────────────────────────────────────────────
 *
 * Dos veces ya, correr `npm test` dejó once tenants de prueba en la base de
 * PRODUCCIÓN, porque los tests escriben donde apunte `.env` y `.env` apunta a
 * Neon. Hubo que limpiarlos a mano y en una de esas limpiezas había ya un
 * cliente real en la misma tabla. Confiar en recordar cambiar la URL antes de
 * cada ejecución no es una salvaguarda: es una apuesta.
 *
 * Esta guardia invierte la carga de la prueba. La suite se NIEGA a ejecutarse
 * salvo que el entorno declare explícitamente que es desechable con
 * ALLOW_DESTRUCTIVE_TESTS=true. Producción nunca llevará esa variable, así
 * que olvidarse ya no destruye nada: solo impide que los tests arranquen.
 *
 * Orden de carga: `.env.local` primero y `.env` después. dotenv no
 * sobrescribe lo ya definido, así que `.env.local` —que es donde va
 * staging— gana, y `.env` queda para producción.
 */

config({ path: '.env.local' })
config({ path: '.env' })

const PERMITIDO = process.env.ALLOW_DESTRUCTIVE_TESTS === 'true'

function host(url: string | undefined): string {
  if (!url) return '(sin DATABASE_URL)'
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname}`
  } catch {
    return '(URL ilegible)'
  }
}

if (!PERMITIDO) {
  const destino = host(process.env.DATABASE_URL)
  console.error(`
╔════════════════════════════════════════════════════════════════════════╗
║  SUITE DETENIDA — el entorno no está marcado como desechable           ║
╚════════════════════════════════════════════════════════════════════════╝

  Estos tests CREAN y BORRAN datos reales: tenants, usuarios, productos,
  ventas y comprobantes. Correrlos contra producción la ensucia.

  Destino actual:  ${destino}

  Para habilitarlos, en el .env.local de STAGING añade:

      ALLOW_DESTRUCTIVE_TESTS=true

  Si lo que querías era correr la suite contra producción: no lo querías.
  Monta staging primero (ver STAGING.md).
`)
  process.exit(1)
}

/** Aviso si el destino huele a producción aun con el permiso puesto. */
const url = process.env.DATABASE_URL ?? ''
if (/prod|production/i.test(url)) {
  console.warn(
    `⚠️  ALLOW_DESTRUCTIVE_TESTS está activo y la URL contiene "prod": ${host(url)}`,
  )
}

console.log(`▸ suite habilitada contra ${host(process.env.DATABASE_URL)}\n`)
