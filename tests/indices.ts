import './guard'
import { correr } from './teardown'
import { prisma } from '../src/lib/prisma'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

/**
 * Los índices parciales no se pueden expresar en schema.prisma: viven solo en
 * el SQL de las migraciones. Una base construida con `db push` (en vez de
 * `migrate deploy`) los pierde EN SILENCIO, y con ellos garantías de
 * integridad (una sola caja abierta por sucursal, una sola fila de stock por
 * producto sin variante). Esta prueba falla de inmediato y dice por qué.
 */
const ESPERADOS = [
  { nombre: 'stocks_no_variant_key', unico: true, donde: /"variantId" IS NULL/ },
  { nombre: 'products_barcode_lookup', unico: false, donde: /"?barcode"? IS NOT NULL/ },
  { nombre: 'products_qrcode_lookup', unico: false, donde: /"qrCode" IS NOT NULL/ },
  { nombre: 'cash_sessions_una_abierta_por_sucursal', unico: true, donde: /status.*ABIERTA/ },
]

async function main() {
  console.log('\n1) Índices parciales (solo existen en las migraciones)')
  const filas = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()`
  const porNombre = new Map(filas.map((f) => [f.indexname, f.indexdef]))
  for (const e of ESPERADOS) {
    const def = porNombre.get(e.nombre)
    check(`existe ${e.nombre}`, def !== undefined,
      def === undefined ? 'FALTA: ¿la base se creó con `db push`? Usa `prisma migrate deploy`.' : '')
    if (def === undefined) continue
    check(`  ${e.nombre} ${e.unico ? 'es UNIQUE' : 'no es unique'}`, /UNIQUE/i.test(def) === e.unico)
    check(`  ${e.nombre} es parcial (WHERE correcto)`, e.donde.test(def), def)
  }
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
