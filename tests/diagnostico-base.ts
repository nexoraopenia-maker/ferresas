import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calcularMigracionesPendientes, clasificarMigraciones, diagnosticarHuella } from '../src/lib/diagnostico-base'

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

console.log('\n6) Migraciones pendientes: nunca un falso «todo aplicado»')
const repo = ['20261110_a', '20261111_b', '20261112_compras']
const dosAplicadas = ['20261110_a', '20261111_b']
const pend = calcularMigracionesPendientes(repo, dosAplicadas)
check('>>> falta una (el caso real: compras) → la nombra y levanta un problema', JSON.stringify(pend.pendientes) === JSON.stringify(['20261112_compras']) && (pend.problema ?? '').includes('20261112_compras') && (pend.problema ?? '').includes('SIN APLICAR'))
const ok = calcularMigracionesPendientes(repo, repo)
check('todas aplicadas → lista vacía y sin problema', ok.pendientes?.length === 0 && ok.problema === null)
check('>>> la base va POR DELANTE del despliegue (tras volver a un despliegue anterior) → nada pendiente, sin alarma', calcularMigracionesPendientes(repo.slice(0, 2), repo).pendientes?.length === 0 && calcularMigracionesPendientes(repo.slice(0, 2), repo).problema === null)
const sinCarpeta = calcularMigracionesPendientes(null, repo)
check('>>> carpeta ilegible → `null` y un problema que lo dice (ANTES devolvía «ninguna pendiente» en silencio)', sinCarpeta.pendientes === null && (sinCarpeta.problema ?? '').includes('No se pudo comparar') && (sinCarpeta.problema ?? '').includes('migrate status'))
check('>>> carpeta vacía tampoco se toma por «todo aplicado»', calcularMigracionesPendientes([], repo).pendientes === null && calcularMigracionesPendientes([], repo).problema !== null)
check('el orden de entrada no importa y los nombres no se duplican', JSON.stringify(calcularMigracionesPendientes(['z', 'a', 'm'], ['m']).pendientes) === JSON.stringify(['a', 'z']))

console.log('\n7) La ruta lo usa y ya no se traga el fallo')
check('>>> usa calcularMigracionesPendientes, expone cuántas trae el despliegue y suma el problema', ruta.includes('calcularMigracionesPendientes(enDespliegue, aplicadas)') && ruta.includes('migracionesEnElDespliegue') && ruta.includes('problemaMigraciones') && ruta.includes('problemas.push(problemaMigraciones)'))
check('>>> el `catch` de la carpeta ya NO fija «ninguna pendiente» (pendientes = [])', !/catch \{[^}]*pendientes = \[\]/s.test(ruta))

console.log('\n8) El build imprime su decisión y falla si la migración falla')
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
const guion = pkg.scripts.build!
const bin = mkdtempSync(join(tmpdir(), 'build-shims-'))
const bitacora = join(bin, 'llamadas.log')
const shim = (nombre: string, codigo = 0) => { const f = join(bin, nombre); writeFileSync(f, `#!/bin/sh\necho "${nombre} $*" >> "${bitacora}"\necho "(${nombre} $*)"\nexit ${codigo}\n`); chmodSync(f, 0o755) }
const correrBuild = (env: Record<string, string>, prismaFalla = false) => {
  writeFileSync(bitacora, '')
  shim('prisma', prismaFalla ? 1 : 0); shim('next')
  const r = spawnSync('sh', ['-c', guion], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' })
  return { salida: `${r.stdout}${r.stderr}`, estado: r.status, llamadas: readFileSync(bitacora, 'utf8').trim().split('\n').filter(Boolean) }
}
const prod2 = correrBuild({ VERCEL_ENV: 'production' })
check('>>> PRODUCCIÓN: lo dice en el log, corre `prisma migrate deploy` ANTES de `next build` y sale bien', prod2.salida.includes('[build] VERCEL_ENV=production') && prod2.salida.includes('PRODUCCION') && JSON.stringify(prod2.llamadas) === JSON.stringify(['prisma migrate deploy', 'next build']) && prod2.estado === 0, JSON.stringify(prod2.llamadas))
const prev = correrBuild({ VERCEL_ENV: 'preview' })
check('>>> PREVIEW: dice que OMITE las migraciones, no llama a prisma y compila', prev.salida.includes('[build] VERCEL_ENV=preview') && prev.salida.includes('se OMITEN las migraciones') && JSON.stringify(prev.llamadas) === JSON.stringify(['next build']) && prev.estado === 0)
const sin = correrBuild({})
check('>>> SIN VERCEL_ENV: lo dice («no definida»), omite y compila (así un build local no migra nada)', sin.salida.includes('VERCEL_ENV=no definida') && sin.salida.includes('se OMITEN') && JSON.stringify(sin.llamadas) === JSON.stringify(['next build']))
const falla = correrBuild({ VERCEL_ENV: 'production' }, true)
check('>>> si la migración FALLA en producción, el build falla y NO se compila ni se despliega (el código viejo sigue sirviendo)', falla.estado !== 0 && JSON.stringify(falla.llamadas) === JSON.stringify(['prisma migrate deploy']) && !falla.llamadas.includes('next build'))
check('>>> el texto del script conserva «prisma migrate deploy» y «next build» (se puede buscar en el log de Vercel)', guion.includes('prisma migrate deploy') && guion.includes('next build') && guion.includes('"$VERCEL_ENV" = "production"'))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
