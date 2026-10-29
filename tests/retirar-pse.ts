import './guard'
import { correr } from './teardown'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'

/**
 * S6 · Retiro definitivo del PSE (migración destructiva) y programación del worker fiscal en Vercel Cron.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const MIG = 'prisma/migrations/20261128100000_retirar_pse'
const COLS = ['pseEndpointUrl', 'pseTokenEnc', 'pseConfiguredAt']

async function cuerpo() {
  console.log('\n1) La migración destructiva')
  const up = readFileSync(`${MIG}/migration.sql`, 'utf8').split('\n').filter((l) => !l.startsWith('--') && l.trim()).join('\n')
  const sentencias = up.split(';').map((x) => x.trim()).filter(Boolean)
  check('>>> elimina EXACTAMENTE las tres columnas del PSE de `tenants` y nada más', sentencias.length === 3 && COLS.every((c) => sentencias.some((s) => s === `ALTER TABLE "tenants" DROP COLUMN "${c}"`)))
  const down = readFileSync(`${MIG}/down.sql`, 'utf8')
  check('la reversa devuelve las tres columnas, NULAS (los datos no se recuperan y lo dice)', COLS.every((c) => new RegExp(`ADD COLUMN "${c}" (TEXT|TIMESTAMP\\(3\\));`).test(down)) && /NO se recuperan/.test(down))
  const cols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = ANY(${COLS})`
  check('>>> en la base ya no existen esas columnas', cols.length === 0, cols.map((c) => c.column_name).join())
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  check('el esquema ya no las declara', COLS.every((c) => !schema.includes(c)))
  check('>>> la migración avisa que se pierde lo que hubiera y remite al script de verificación', /SE PIERDE/.test(readFileSync(`${MIG}/migration.sql`, 'utf8')) && /verificar-pse-sin-datos/.test(readFileSync(`${MIG}/migration.sql`, 'utf8')))
  const script = readFileSync('scripts/verificar-pse-sin-datos.ts', 'utf8')
  check('>>> el script de verificación es de SOLO LECTURA (ningún INSERT/UPDATE/DELETE/ALTER), no imprime valores y sale con 3 si hay datos', !/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i.test(script.replace(/\/\*[\s\S]*?\*\//, '')) && /process\.exitCode = 3/.test(script) && !/console\.log\([^)]*pseTokenEnc[^)]*\)/.test(script))

  console.log('\n2) Ni rastro del PSE en el código')
  const hallazgos = execSync(`grep -rnE "pseEndpointUrl|pseTokenEnc|pseConfiguredAt|PSE_ALLOWED_HOSTS|validarUrlPse|pse-rest|PseConfig" src scripts tests .env.example --include='*' 2>/dev/null | grep -v "src/generated" | grep -v "tests/retirar-pse.ts" | grep -v "scripts/verificar-pse-sin-datos.ts" | grep -v "tests/sunat-pantalla.ts" | grep -v "tests/sunat-envio.ts" || true`).toString().trim()
  check('>>> ningún archivo de la aplicación, los scripts, las pruebas ni .env.example menciona ya las columnas, la variable de hosts o el cliente del PSE', hallazgos === '', hallazgos.split('\n')[0] ?? '')
  const recifrado = readFileSync('src/features/seguridad/recifrado.ts', 'utf8')
  check('el re-cifrado de secretos ya no recorre `tenants`: solo credenciales de SUNAT y secretos de MFA', !/db\.tenant|tenant:/.test(recifrado))
  check('la validación de URLs que se conserva (padrón) sigue exportada: IP internas y forma', /export function esIpInterna/.test(readFileSync('src/features/invoicing/url-segura.ts', 'utf8')) && /export function validarFormaUrl/.test(readFileSync('src/features/invoicing/url-segura.ts', 'utf8')))

  console.log('\n3) El worker fiscal en Vercel Cron')
  const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] }
  check('>>> vercel.json programa /api/fiscal/worker CADA MINUTO', vercel.crons.some((c) => c.path === '/api/fiscal/worker' && c.schedule === '* * * * *'))
  check('y conserva el cron de vencimiento de pruebas', vercel.crons.some((c) => c.path === '/api/cron/expire-trials' && c.schedule === '0 3 * * *'))
  const ruta = readFileSync('src/app/api/fiscal/worker/route.ts', 'utf8')
  check('>>> la ruta acepta GET (lo único que sabe hacer Vercel Cron) y POST, ambos con el MISMO control de secreto', /export const POST = ejecutar/.test(ruta) && /export const GET = ejecutar/.test(ruta) && (ruta.match(/secretosIguales\(/g) ?? []).length === 1 && /process\.env\.FISCAL_WORKER_SECRET/.test(ruta))
  check('>>> el secreto sale solo de las cabeceras: nunca de la URL', !/searchParams|\.nextUrl|req\.url/.test(ruta))
  check('no depende de CRON_SECRET en el código (se configura con el mismo valor)', !/process\.env\.CRON_SECRET/.test(ruta))
  const env = readFileSync('.env.example', 'utf8')
  check('.env.example explica que CRON_SECRET debe valer lo mismo que FISCAL_WORKER_SECRET y que un cron por minuto exige el plan Pro', /CRON_SECRET debe tener EXACTAMENTE el mismo valor/.test(env) && /plan Pro/.test(env))
  const acceso = readFileSync('src/lib/route-access.ts', 'utf8')
  check('la ruta es pública para el proxy (se autentica sola) pero sigue figurando en la lista de rutas abiertas', /'\/api\/fiscal'/.test(acceso))
}

async function main() {
  try { await cuerpo() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? (e.stack ?? e.message).slice(0, 500) : e}`, false) }
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
