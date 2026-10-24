import { config } from 'dotenv'
import { evaluarEntorno, huella } from '../scripts/huella-bd'

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

/**
 * Segunda barrera, INDEPENDIENTE del permiso: aunque ALLOW_DESTRUCTIVE_TESTS esté puesto, la suite se niega
 * si algún destino coincide en host Y nombre de base con producción (PROD_DB_FINGERPRINT o lo que diga
 * `.env`). El permiso lo puede arrastrar un `.env.local` copiado de producción; la huella no.
 * Sin PROD_DB_FINGERPRINT también se niega: sin ella no se puede garantizar nada.
 */
const veredicto = evaluarEntorno()
if (!veredicto.ok) {
  console.error(`
╔════════════════════════════════════════════════════════════════════════╗
║  SUITE DETENIDA — el destino puede ser PRODUCCIÓN                      ║
╚════════════════════════════════════════════════════════════════════════╝

  ${veredicto.motivo}

  Destino actual:  ${host(process.env.DATABASE_URL)}
  Huella:          ${huella(process.env.DATABASE_URL) ?? '—'}

  Apunta DATABASE_URL (y DIRECT_URL) de .env.local a una base de STAGING
  distinta, y define PROD_DB_FINGERPRINT=host/nombre_de_base de producción
  (sin usuario ni clave; ver .env.example).
`)
  process.exit(1)
}

console.log(`▸ suite habilitada contra ${host(process.env.DATABASE_URL)}\n`)
