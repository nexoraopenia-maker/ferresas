import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { evaluarComandoPrisma, evaluarDestinos, evaluarEntorno, huella, normalizarHuella } from '../scripts/huella-bd'

/**
 * Prueba de la huella de producción. NO importa ./guard y NO se conecta a ninguna base:
 * trabaja solo con URL inventadas (host de ejemplo, clave falsa).
 */
let ok = 0
let mal = 0
function check(n: string, c: boolean, d = '') {
  if (c) { ok++; console.log(`  ✓ ${n}`) } else { mal++; console.log(`  ✗ ${n} ${d}`) }
}

const PROD = 'postgresql://u:clave-falsa@ep-aaa-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require'
const PROD_DIRECTA = 'postgresql://u:clave-falsa@ep-aaa.c-5.us-east-2.aws.neon.tech:5432/neondb'
const OTRA_BASE_MISMO_HOST = 'postgresql://u:x@ep-aaa-pooler.c-5.us-east-2.aws.neon.tech/staging'
const OTRO_HOST_MISMA_BASE = 'postgresql://u:x@ep-bbb-pooler.c-5.us-east-2.aws.neon.tech/neondb'
const HUELLA = 'ep-aaa.c-5.us-east-2.aws.neon.tech/neondb'
const STG = 'ep-aaa.c-5.us-east-2.aws.neon.tech/staging'
const STG2 = 'ep-bbb.c-5.us-east-2.aws.neon.tech/neondb'

console.log('\n1) La huella')
check('«host/base», sin usuario, clave ni parámetros', huella(PROD) === HUELLA && !huella(PROD)!.includes('clave'))
check('pooler y directa son LA MISMA base', huella(PROD) === huella(PROD_DIRECTA))
check('mismo host, otra base → huella distinta', huella(OTRA_BASE_MISMO_HOST) !== HUELLA)
check('otro host, misma base → huella distinta', huella(OTRO_HOST_MISMA_BASE) !== HUELLA)
check('URL ilegible o sin base → null', huella('esto no es url') === null && huella('postgresql://u:x@h/') === null && huella(undefined) === null)
check('la variable explícita acepta con o sin -pooler, mayúsculas y puerto', normalizarHuella('EP-AAA-pooler.c-5.us-east-2.aws.neon.tech:5432/neondb') === HUELLA && normalizarHuella(HUELLA) === HUELLA)
check('la variable explícita mal escrita → null', normalizarHuella('solo-host') === null && normalizarHuella('') === null && normalizarHuella(undefined) === null)

console.log('\n2) Veredicto')
check('>>> mismo host Y misma base → NEGADO', !evaluarDestinos({ DATABASE_URL: PROD }, HUELLA).ok)
check('>>> también por la conexión directa → NEGADO', !evaluarDestinos({ DATABASE_URL: OTRO_HOST_MISMA_BASE.replace('ep-bbb', 'ep-ccc'), DIRECT_URL: PROD_DIRECTA }, HUELLA).ok)
check('>>> basta UNA variable apuntando a producción (p. ej. la sombra)', !evaluarDestinos({ DATABASE_URL: OTRA_BASE_MISMO_HOST, SHADOW_DATABASE_URL: PROD }, HUELLA).ok)
check('mismo host pero OTRA base, declarada como staging → permitido', evaluarDestinos({ DATABASE_URL: OTRA_BASE_MISMO_HOST }, HUELLA, [], STG).ok)
check('otro host con el mismo nombre de base, declarado como staging → permitido', evaluarDestinos({ DATABASE_URL: OTRO_HOST_MISMA_BASE }, HUELLA, [], STG2).ok)
check('>>> sin la variable explícita → NEGADO (no se puede garantizar nada)', !evaluarDestinos({ DATABASE_URL: OTRA_BASE_MISMO_HOST }, undefined, [], STG).ok)
check('>>> variable mal formada → NEGADO', !evaluarDestinos({ DATABASE_URL: OTRA_BASE_MISMO_HOST }, 'host-sin-base', [], STG).ok)
check('>>> sin ninguna URL → NEGADO', !evaluarDestinos({}, HUELLA, [], STG).ok)
check('>>> URL ilegible → NEGADO', !evaluarDestinos({ DATABASE_URL: 'basura' }, HUELLA, [], STG).ok)
console.log('\n2b) LISTA BLANCA: solo staging identificado positivamente')
check('>>> una base DESCONOCIDA (ni producción ni staging) → NEGADA', !evaluarDestinos({ DATABASE_URL: 'postgresql://u:x@localhost:5432/dev' }, HUELLA, [], STG).ok)
check('>>> sin STAGING_DB_FINGERPRINT → NEGADO aunque no sea producción', !evaluarDestinos({ DATABASE_URL: OTRA_BASE_MISMO_HOST }, HUELLA).ok)
check('>>> STAGING_DB_FINGERPRINT mal formada → NEGADO', !evaluarDestinos({ DATABASE_URL: OTRA_BASE_MISMO_HOST }, HUELLA, [], 'sin-base').ok)
check('>>> staging igual a producción → NEGADO', !evaluarDestinos({ DATABASE_URL: PROD }, HUELLA, [], HUELLA).ok)
check('>>> una variable en staging y otra desconocida → NEGADO', !evaluarDestinos({ DATABASE_URL: OTRA_BASE_MISMO_HOST, DIRECT_URL: 'postgresql://u:x@otro.host/staging' }, HUELLA, [], STG).ok)
check('pooler y directa del staging declarado → permitido', evaluarDestinos({ DATABASE_URL: OTRA_BASE_MISMO_HOST, DIRECT_URL: 'postgresql://u:x@ep-aaa.c-5.us-east-2.aws.neon.tech/staging' }, HUELLA, [], STG).ok)
check('el motivo NO contiene la clave', !evaluarDestinos({ DATABASE_URL: PROD }, HUELLA).motivo.includes('clave'))

console.log('\n3) Contra el .env de producción, aunque nadie defina la variable a mano')
const dir = mkdtempSync(join(tmpdir(), 'huella-'))
const envProd = join(dir, '.env')
writeFileSync(envProd, `DATABASE_URL="${PROD}"\nPROD_DB_FINGERPRINT="${HUELLA}"\n`)
check('>>> destino = el de .env → NEGADO', !evaluarEntorno({ DATABASE_URL: PROD_DIRECTA, PROD_DB_FINGERPRINT: HUELLA }, envProd).ok)
const envSinVariable = join(dir, '.env.sin')
writeFileSync(envSinVariable, `DATABASE_URL="${PROD}"\n`)
check('>>> sin variable, pero el destino coincide con .env → NEGADO', !evaluarEntorno({ DATABASE_URL: PROD }, envSinVariable).ok)
check('destino distinto de .env y de la variable → permitido', evaluarEntorno({ DATABASE_URL: OTRA_BASE_MISMO_HOST, PROD_DB_FINGERPRINT: HUELLA, STAGING_DB_FINGERPRINT: STG }, envProd).ok)
check('la variable puede venir solo de .env', evaluarEntorno({ DATABASE_URL: OTRA_BASE_MISMO_HOST, STAGING_DB_FINGERPRINT: STG }, envProd).ok)

console.log('\n4) Guardia del CLI de Prisma')
const A = ['node', 'prisma']
const E = (extra: Record<string, string | undefined> = {}) => ({ DATABASE_URL: PROD, PROD_DB_FINGERPRINT: HUELLA, ...extra })
const ES = { DATABASE_URL: OTRA_BASE_MISMO_HOST, PROD_DB_FINGERPRINT: HUELLA, STAGING_DB_FINGERPRINT: STG }
const desconocida = { DATABASE_URL: 'postgresql://u:x@localhost:5432/dev', PROD_DB_FINGERPRINT: HUELLA, STAGING_DB_FINGERPRINT: STG }
check('>>> migrate dev contra producción → NEGADO', !evaluarComandoPrisma([...A, 'migrate', 'dev'], E(), envProd).ok)
check('>>> db push / db seed / migrate reset contra producción → NEGADOS, aun con el permiso', ['db push', 'db seed', 'migrate reset', 'db execute'].every((c) => !evaluarComandoPrisma([...A, ...c.split(' ')], E({ I_UNDERSTAND_THIS_IS_PRODUCTION: 'true' }), envProd).ok))
check('>>> migrate deploy contra producción SIN intención → NEGADO', !evaluarComandoPrisma([...A, 'migrate', 'deploy'], E(), envProd).ok)
check('migrate deploy en el build de producción de Vercel → permitido', evaluarComandoPrisma([...A, 'migrate', 'deploy'], E({ VERCEL_ENV: 'production' }), envProd).ok)
check('migrate deploy a propósito (permiso en la línea de comandos) → permitido', evaluarComandoPrisma([...A, 'migrate', 'deploy'], E({ I_UNDERSTAND_THIS_IS_PRODUCTION: 'true' }), envProd).ok)
check('>>> el build de PREVIEW de Vercel no cuenta como producción → NEGADO', !evaluarComandoPrisma([...A, 'migrate', 'deploy'], E({ VERCEL_ENV: 'preview' }), envProd).ok)
check('>>> sin PROD_DB_FINGERPRINT ni siquiera Vercel migra (no se puede comprobar)', !evaluarComandoPrisma([...A, 'migrate', 'deploy'], { DATABASE_URL: OTRA_BASE_MISMO_HOST, VERCEL_ENV: 'production' }, join(dir, 'no-existe')).ok)
check('contra staging todo se permite', ['migrate dev', 'migrate deploy', 'db push', 'db seed', 'migrate reset'].every((c) => evaluarComandoPrisma([...A, ...c.split(' ')], ES, envProd).ok))
check('>>> --url a producción desde la línea de comandos → NEGADO', !evaluarComandoPrisma([...A, 'db', 'execute', '--url', PROD], ES, envProd).ok && !evaluarComandoPrisma([...A, 'migrate', 'diff', `--from-url=${PROD_DIRECTA}`], ES, envProd).ok)
check('>>> --config (saltaría la guardia) → NEGADO', !evaluarComandoPrisma([...A, 'migrate', 'deploy', '--config', 'otra.ts'], ES, envProd).ok)
check('>>> prisma migrate / db contra una base DESCONOCIDA → NEGADO (lista blanca)', ['migrate deploy', 'migrate dev', 'db push', 'db seed'].every((c) => !evaluarComandoPrisma([...A, ...c.split(' ')], desconocida, envProd).ok))
check('generate / validate / format no tocan la base → permitidos siempre', ['generate', 'validate', 'format'].every((c) => evaluarComandoPrisma([...A, c], E(), envProd).ok))
const cfg = readFileSync('prisma.config.ts', 'utf8')
check('>>> prisma.config.ts ejecuta la guardia ANTES de defineConfig', cfg.indexOf('evaluarComandoPrisma(process.argv)') > 0 && cfg.indexOf('evaluarComandoPrisma(process.argv)') < cfg.indexOf('export default defineConfig'))
const pkg = readFileSync('package.json', 'utf8')
check('ningún script de npm usa --config ni --url con prisma', !/prisma[^"]*--(config|url|from-url|to-url)/.test(pkg))

console.log(`\n${mal === 0 ? '✔' : '✘'} ${ok} pasaron, ${mal} fallaron`)
process.exit(mal === 0 ? 0 : 1)
