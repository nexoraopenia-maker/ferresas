/**
 * SOLO LECTURA. Lista las ventas cuyo vuelto quedó mal guardado por el bug anterior a la Fase 3 (el vuelto solo se registraba si
 * el primer pago era efectivo) y su efecto en los cierres de caja. No modifica nada ni recalcula cierres ya cerrados.
 *
 *   npx tsx scripts/listar-vueltos-historicos.ts                       # resumen por negocio y por turno de caja
 *   npx tsx scripts/listar-vueltos-historicos.ts --detalle             # además, una línea por venta
 *   npx tsx scripts/listar-vueltos-historicos.ts --negocio <slug>      # un solo negocio
 *   npx tsx scripts/listar-vueltos-historicos.ts --desde 2026-01-01    # solo ventas desde esa fecha
 *
 * Sale con código 3 si encontró ventas afectadas (para que un procedimiento pueda detenerse a revisarlas).
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { auditarVueltos, formatearInformeVueltos } from '../src/features/pos/vueltos-historicos'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }

async function main() {
  const slug = arg('negocio')
  const desdeTexto = arg('desde')
  const desde = desdeTexto ? new Date(`${desdeTexto}T00:00:00-05:00`) : undefined
  if (desde && Number.isNaN(desde.getTime())) throw new Error('--desde debe ser una fecha AAAA-MM-DD.')
  const detalle = process.argv.includes('--detalle')

  const negocios = await prisma.tenant.findMany({ where: { deletedAt: null, ...(slug ? { slug } : {}) }, select: { id: true, slug: true }, orderBy: { slug: 'asc' } })
  if (negocios.length === 0) { console.log('No hay negocios que revisar.'); return }

  let afectadas = 0
  let revisadas = 0
  for (const n of negocios) {
    const db = getTenantPrisma({ tenantId: n.id, userId: 'script-lectura', role: 'SUPERADMIN', access: 'FULL' })
    const informe = await auditarVueltos(db, { desde })
    revisadas += informe.ventasRevisadas
    afectadas += informe.hallazgos.length
    if (informe.hallazgos.length > 0 || slug) console.log(formatearInformeVueltos(n.slug, informe, detalle))
  }
  console.log(`\nSOLO LECTURA (no se escribió nada): ${negocios.length} negocio(s), ${revisadas} ventas revisadas, ${afectadas} con el vuelto mal guardado.`)
  if (afectadas > 0) process.exitCode = 3
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) }).finally(() => prisma.$disconnect())
