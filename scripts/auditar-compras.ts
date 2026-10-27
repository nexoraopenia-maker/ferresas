/**
 * SOLO LECTURA. Comprueba que las compras y las cuentas por pagar cuadran entre sus tablas: deuda del proveedor = suma de sus cuentas
 * abiertas, pagado de cada cuenta = suma de sus repartos, cada compra recibida con su stock y (si es a crédito) su cuenta, cierres de
 * caja con sus pagos a proveedores. No modifica nada ni corrige nada: solo informa para que una persona decida.
 *
 *   npx tsx scripts/auditar-compras.ts                       # resumen por negocio (solo los que tienen hallazgos)
 *   npx tsx scripts/auditar-compras.ts --detalle             # todos los hallazgos, no solo los tres primeros de cada tipo
 *   npx tsx scripts/auditar-compras.ts --negocio <slug>      # un solo negocio (lo muestra aunque esté limpio)
 *
 * Código de salida: 0 = sin errores · 3 = hay errores de coherencia · 1 = fallo del propio script.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { auditarCoherenciaPorPagar, formatearInformePorPagar } from '../src/features/por-pagar/auditoria'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }

async function main() {
  const slug = arg('negocio')
  const detalle = process.argv.includes('--detalle')
  const negocios = await prisma.tenant.findMany({ where: { deletedAt: null, ...(slug ? { slug } : {}) }, select: { id: true, slug: true }, orderBy: { slug: 'asc' } })
  if (negocios.length === 0) { console.log('No hay negocios que revisar.'); return }

  let errores = 0, conCompras = 0
  for (const n of negocios) {
    const db = getTenantPrisma({ tenantId: n.id, userId: 'script-lectura', role: 'SUPERADMIN', access: 'FULL' })
    const informe = await auditarCoherenciaPorPagar(db)
    errores += informe.errores
    if (informe.compras > 0) conCompras++
    if (informe.hallazgos.length > 0 || slug) console.log(formatearInformePorPagar(n.slug, informe, detalle))
  }
  console.log(`\nSOLO LECTURA (no se escribió nada): ${negocios.length} negocio(s) revisados, ${conCompras} con compras, ${errores} error(es).`)
  if (errores > 0) process.exitCode = 3
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) }).finally(() => prisma.$disconnect())
