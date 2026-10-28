/**
 * Rellena el costo de los movimientos de stock ANTERIORES al kardex valorizado (F6.4a): `unitCostApplied`, `costAfter` y `costOrigin`.
 * Repite la historia de cada producto con la misma fórmula de compras y marca cada dato como EXACTO / RECONSTRUIDO / SIN_DATO (ver
 * `src/features/inventory/kardex-reconstruccion.ts`). Solo toca movimientos SIN_DATO: se puede correr las veces que haga falta.
 *
 *   npx tsx scripts/rellenar-costo-kardex.ts                       # SIMULACIÓN de todos los negocios: cuenta, no escribe
 *   npx tsx scripts/rellenar-costo-kardex.ts --negocio <slug>      # un solo negocio
 *   npx tsx scripts/rellenar-costo-kardex.ts --aplicar             # escribe
 *
 * Código de salida: 0 = bien · 1 = fallo del propio script.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { formatearInformeRelleno, rellenarCostoKardex } from '../src/features/inventory/kardex-relleno'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }

async function main() {
  const slug = arg('negocio')
  const aplicar = process.argv.includes('--aplicar')
  const negocios = await prisma.tenant.findMany({ where: { deletedAt: null, ...(slug ? { slug } : {}) }, select: { id: true, slug: true }, orderBy: { slug: 'asc' } })
  if (negocios.length === 0) { console.log('No hay negocios que revisar.'); return }
  for (const n of negocios) {
    const db = getTenantPrisma({ tenantId: n.id, userId: 'script-relleno', role: 'SUPERADMIN', access: 'FULL' })
    const informe = await rellenarCostoKardex(db, { aplicar })
    if (informe.productos > 0 || slug) console.log(formatearInformeRelleno(n.slug, informe))
  }
  console.log(aplicar ? '\nAPLICADO.' : '\nSIMULACIÓN: no se escribió nada. Añade --aplicar para escribir.')
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) }).finally(() => prisma.$disconnect())
