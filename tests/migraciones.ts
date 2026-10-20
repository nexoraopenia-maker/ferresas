import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Las migraciones se comprueban SIN base de datos.
 *
 * Existe por un fallo real: una migración escrita a mano decía
 * `ALTER TABLE "StockMovement"` cuando la tabla se llama `stock_movements`
 * (`@@map`). En staging no se notó porque esa base se había construido con
 * `db push`; en producción `prisma migrate deploy` falló, dejó la migración en
 * estado «failed» y Prisma se negó a aplicar nada más (P3009), de modo que
 * cuatro despliegues seguidos cayeron en 10 segundos.
 *
 * Esta prueba recorre las migraciones EN ORDEN y exige que cada tabla que
 * mencionan (ALTER TABLE, CREATE INDEX … ON, REFERENCES) exista ya en ese
 * punto, y que cada modelo del schema acabe teniendo su tabla. No sustituye a
 * aplicar la cadena en una base vacía —se hizo a mano al corregir el fallo—,
 * pero cuesta milisegundos y cierra justo este error.
 */
import './guard'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

const RAIZ = join(import.meta.dirname ?? process.cwd(), '..')
const dirMig = join(RAIZ, 'prisma/migrations')
const carpetas = readdirSync(dirMig, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort()

const sinComentarios = (sql: string) => sql.replace(/--[^\n]*/g, '')

console.log('\n1) Cada migración solo nombra tablas que ya existen')
const existentes = new Set<string>()
const problemas: string[] = []
for (const c of carpetas) {
  const sql = sinComentarios(readFileSync(join(dirMig, c, 'migration.sql'), 'utf8'))
  // Lo que ESTA migración crea cuenta para sí misma.
  for (const m of sql.matchAll(/CREATE TABLE\s+"([^"]+)"/g)) existentes.add(m[1]!)
  const referencias = [
    ...sql.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?"([^"]+)"/g),
    ...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+"[^"]+"\s+ON\s+"([^"]+)"/g),
    ...sql.matchAll(/REFERENCES\s+"([^"]+)"/g),
  ].map((m) => m[1]!)
  for (const t of referencias) {
    if (!existentes.has(t)) problemas.push(`${c}: «${t}»`)
  }
  for (const m of sql.matchAll(/DROP TABLE\s+(?:IF EXISTS\s+)?"([^"]+)"/g)) existentes.delete(m[1]!)
}
check(`>>> ${carpetas.length} migraciones: ninguna nombra una tabla inexistente`, problemas.length === 0, problemas.join(' | '))

console.log('\n2) Cada modelo del schema tiene su tabla')
const schema = readFileSync(join(RAIZ, 'prisma/schema.prisma'), 'utf8')
const faltan: string[] = []
for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
  const mapeo = /@@map\("([^"]+)"\)/.exec(m[2]!)
  const tabla = mapeo ? mapeo[1]! : m[1]!
  if (!existentes.has(tabla)) faltan.push(`${m[1]} → «${tabla}»`)
}
check('>>> toda tabla del schema la crea alguna migración', faltan.length === 0, faltan.join(' | '))

console.log('\n3) Orden y nombres')
check('las carpetas llevan marca de tiempo creciente y única',
  carpetas.every((c, i) => /^\d{14}_/.test(c) && (i === 0 || carpetas[i - 1]! < c)))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
