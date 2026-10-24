import { readFileSync } from 'node:fs'
import { clasificarMigraciones, diagnosticarHuella } from '../src/lib/diagnostico-base'

/** Diagnóstico de la base de la app en ejecución: huella y migraciones reintentadas. Puro: sin base ni red. */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }

const PROD = 'postgresql://u:clave-falsa@ep-prod-aaa-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&pgbouncer=true'
const PROD_DIRECTA = 'postgresql://u:clave-falsa@ep-prod-aaa.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require'
const OTRA = 'postgresql://u:clave-falsa@ep-otra-bbb-pooler.c-5.us-east-2.aws.neon.tech/neondb'
const HUELLA = 'ep-prod-aaa.c-5.us-east-2.aws.neon.tech/neondb'

console.log('\n1) Migraciones: reintentada ≠ fallida')
const filas = [
  { migration_name: '20261019_a', ok: true, rolled_back: false },
  // El caso real (20261020120000_cost_pending): falló, se revirtió con `migrate resolve` y se volvió a aplicar.
  { migration_name: '20261020_cost_pending', ok: false, rolled_back: true },
  { migration_name: '20261020_cost_pending', ok: true, rolled_back: false },
  { migration_name: '20261021_b', ok: true, rolled_back: false },
]
const c = clasificarMigraciones(filas)
check('>>> revertida + reaplicada con éxito → APLICADA, no fallida (la falsa alarma real)', c.aplicadas.includes('20261020_cost_pending') && c.fallidas.length === 0)
check('queda anotada como reintentada (informativo)', JSON.stringify(c.reintentadas) === JSON.stringify(['20261020_cost_pending']))
check('>>> una que solo tiene filas fallidas SÍ es fallida', JSON.stringify(clasificarMigraciones([{ migration_name: 'x', ok: false, rolled_back: false }]).fallidas) === JSON.stringify(['x']))
check('>>> y una revertida sin reaplicar también', clasificarMigraciones([{ migration_name: 'y', ok: false, rolled_back: true }]).fallidas.includes('y'))
check('sin filas → nada', clasificarMigraciones([]).aplicadas.length === 0)

console.log('\n2) Huella de la base conectada (producción)')
const prod = (o: Record<string, string | undefined> = {}) => diagnosticarHuella({ VERCEL_ENV: 'production', DATABASE_URL: PROD, DIRECT_URL: PROD_DIRECTA, PROD_DB_FINGERPRINT: HUELLA, ...o })
check('>>> alineado: la base conectada coincide con la declarada → sin problemas', prod().coincide === true && prod().problemas.length === 0 && prod().conectadaA === HUELLA)
check('>>> el caso real: la huella declarada es OTRA base → problema claro, con las dos', (() => { const d = prod({ PROD_DB_FINGERPRINT: 'ep-ancient.c-5.us-east-2.aws.neon.tech/neondb' }); return d.coincide === false && d.problemas.some((p) => p.includes('NO coincide') && p.includes(HUELLA) && p.includes('ep-ancient')) })())
check('>>> sin PROD_DB_FINGERPRINT en producción → problema', prod({ PROD_DB_FINGERPRINT: undefined }).problemas.some((p) => p.includes('no está definida')) && prod({ PROD_DB_FINGERPRINT: undefined }).coincide === null)
check('huella mal formada → problema', prod({ PROD_DB_FINGERPRINT: 'solo-host' }).problemas.some((p) => p.includes('forma')))
check('>>> DATABASE_URL y DIRECT_URL en bases distintas → problema', prod({ DIRECT_URL: OTRA }).problemas.some((p) => p.includes('bases distintas')))
check('pooler y directa de la misma base NO se confunden con bases distintas', prod().problemas.every((p) => !p.includes('distintas')))

console.log('\n3) Otros entornos: NO deben ver producción')
check('>>> una vista previa conectada a la base de PRODUCCIÓN → problema', diagnosticarHuella({ VERCEL_ENV: 'preview', DATABASE_URL: PROD, PROD_DB_FINGERPRINT: HUELLA }).problemas.some((p) => p.includes('PRODUCCIÓN')))
check('>>> y una máquina local (sin VERCEL_ENV) con la base de producción también', diagnosticarHuella({ DATABASE_URL: PROD, PROD_DB_FINGERPRINT: HUELLA }).problemas.some((p) => p.includes('local') && p.includes('PRODUCCIÓN')))
check('una vista previa en otra base → sin problemas', diagnosticarHuella({ VERCEL_ENV: 'preview', DATABASE_URL: OTRA, PROD_DB_FINGERPRINT: HUELLA }).problemas.length === 0)
check('sin la variable fuera de producción no es un problema', diagnosticarHuella({ VERCEL_ENV: 'preview', DATABASE_URL: OTRA }).problemas.length === 0)

console.log('\n4) Sin secretos')
const todo = JSON.stringify(prod({ PROD_DB_FINGERPRINT: 'ep-ancient.c-5.us-east-2.aws.neon.tech/neondb' }))
check('>>> el resultado no contiene la clave ni el usuario', !todo.includes('clave-falsa') && !todo.includes('postgresql://'))

console.log('\n5) La ruta lo usa')
const ruta = readFileSync('src/app/api/diagnostics/route.ts', 'utf8')
check('>>> /api/diagnostics clasifica las migraciones con clasificarMigraciones (ya no cuenta filas sueltas)', ruta.includes('clasificarMigraciones(migraciones)') && !/migraciones\.filter\(\(m\) => !m\.ok\)/.test(ruta))
check('>>> y suma los problemas de la huella y expone host/base y la coincidencia', ruta.includes('diagnosticarHuella(process.env)') && ruta.includes('...huellaBase.problemas') && ruta.includes('coincideConHuellaProduccion'))
check('la ruta sigue protegida por CRON_SECRET', ruta.includes('autorizado(req)'))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
