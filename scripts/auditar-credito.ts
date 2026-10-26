/**
 * SOLO LECTURA. Comprueba que el crédito (fiado, abonos, cuentas por cobrar) cuadra entre sus tablas: deuda del cliente = suma de
 * sus cuentas abiertas, abonado de cada cuenta = suma de sus repartos, cada fiado con su cuenta, cierres de caja con sus abonos.
 * No modifica nada ni corrige nada: solo informa para que una persona decida.
 *
 *   npx tsx scripts/auditar-credito.ts                       # resumen por negocio (solo los que tienen hallazgos)
 *   npx tsx scripts/auditar-credito.ts --detalle             # todos los hallazgos, no solo los tres primeros de cada tipo
 *   npx tsx scripts/auditar-credito.ts --negocio <slug>      # un solo negocio (lo muestra aunque esté limpio)
 *
 * Código de salida: 0 = sin errores (los avisos no lo cambian) · 3 = hay errores de coherencia · 1 = fallo del propio script.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { auditarCoherenciaCredito, formatearInformeCredito } from '../src/features/credito/auditoria'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }

async function main() {
  const slug = arg('negocio')
  const detalle = process.argv.includes('--detalle')
  const negocios = await prisma.tenant.findMany({ where: { deletedAt: null, ...(slug ? { slug } : {}) }, select: { id: true, slug: true }, orderBy: { slug: 'asc' } })
  if (negocios.length === 0) { console.log('No hay negocios que revisar.'); return }

  let errores = 0, avisos = 0, conCredito = 0
  for (const n of negocios) {
    const db = getTenantPrisma({ tenantId: n.id, userId: 'script-lectura', role: 'SUPERADMIN', access: 'FULL' })
    const informe = await auditarCoherenciaCredito(db)
    errores += informe.errores
    avisos += informe.avisos
    if (informe.cuentas > 0 || informe.abonos > 0) conCredito++
    if (informe.hallazgos.length > 0 || slug) console.log(formatearInformeCredito(n.slug, informe, detalle))
  }
  console.log(`\nSOLO LECTURA (no se escribió nada): ${negocios.length} negocio(s) revisados, ${conCredito} con crédito, ${errores} error(es), ${avisos} aviso(s).`)
  if (errores > 0) process.exitCode = 3
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) }).finally(() => prisma.$disconnect())
