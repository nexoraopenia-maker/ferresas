/**
 * SOLO LECTURA. Concilia, por negocio, las ventas con sus comprobantes, la numeración de las series, los envíos pendientes, las notas de crédito y
 * los registros de ventas y de compras. No modifica nada ni corrige nada: solo informa para que una persona decida.
 *
 *   npx tsx scripts/auditar-fiscal.ts                          # este mes, solo los negocios con hallazgos de ERROR o ADVERTENCIA
 *   npx tsx scripts/auditar-fiscal.ts --detalle                # todos los items de cada hallazgo, no solo los tres primeros
 *   npx tsx scripts/auditar-fiscal.ts --negocio <slug>         # un solo negocio (lo muestra aunque esté limpio)
 *   npx tsx scripts/auditar-fiscal.ts --desde 2026-10-01 --hasta 2026-10-31
 *
 * ⚠️ Los umbrales de tiempo (24 h advierte, 72 h error) son un criterio operativo, no plazos de SUNAT.
 * Un negocio en ensayo o demostración no tiene comprobantes con valor fiscal: sale sin errores.
 * Código de salida: 0 = sin errores · 3 = hay errores · 1 = fallo del propio script.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { parametrosRegistrosSchema } from '../src/features/registros/schemas'
import { calcularConciliacion } from '../src/features/conciliacion/conciliacion-service'
import { formatearInformeFiscal } from '../src/features/conciliacion/formato'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }
const CONOCIDAS = new Set(['--detalle', '--negocio', '--desde', '--hasta'])

async function main() {
  const raros = process.argv.slice(2).filter((a) => a.startsWith('--') && !CONOCIDAS.has(a))
  if (raros.length) { console.error(`Opción desconocida: ${raros.join(', ')}`); process.exit(1) }
  const slug = arg('negocio')
  const detalle = process.argv.includes('--detalle')
  const desde = arg('desde'), hasta = arg('hasta')
  const parsed = parametrosRegistrosSchema.safeParse(desde || hasta ? { p: 'RANGO', desde, hasta } : {})
  if (!parsed.success) { console.error(parsed.error.issues[0]?.message ?? 'Parámetros inválidos'); process.exit(1) }

  const negocios = await prisma.tenant.findMany({ where: { deletedAt: null, ...(slug ? { slug } : {}) }, select: { id: true, slug: true }, orderBy: { slug: 'asc' } })
  if (negocios.length === 0) { console.log('No hay negocios que revisar.'); return }

  let errores = 0, advertencias = 0, revisados = 0
  for (const n of negocios) {
    const db = getTenantPrisma({ tenantId: n.id, userId: 'script-lectura', role: 'SUPERADMIN', access: 'FULL' })
    const r = await calcularConciliacion(db, parsed.data)
    revisados++
    errores += r.informe.resumen.errores
    advertencias += r.informe.resumen.advertencias
    if (r.informe.resumen.errores + r.informe.resumen.advertencias > 0 || slug) console.log(formatearInformeFiscal(n.slug, r.textoPeriodo, r.informe, detalle) + '\n')
  }
  console.log(`SOLO LECTURA (no se escribió nada): ${revisados} negocio(s) revisados, ${errores} error(es), ${advertencias} advertencia(s).`)
  if (errores > 0) process.exitCode = 3
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) }).finally(() => prisma.$disconnect())
