/**
 * Rellena la tabla `product_codes` desde las columnas antiguas (`barcode`, `qrCode`) de productos y variantes.
 *
 *   npx tsx scripts/poblar-codigos.ts                       # ENSAYO: no escribe, informa colisiones
 *   npx tsx scripts/poblar-codigos.ts --ejecutar            # escribe los códigos sin colisión
 *   npx tsx scripts/poblar-codigos.ts --negocio <slug> ...  # solo un negocio
 *
 * No muta NADA de lo antiguo. Los códigos con más de un dueño se informan (con SKU, nombre y columna de cada dueño) y no se
 * insertan: decidir cuál es el correcto es de una persona. Es idempotente. Contra producción solo con la guardia de huella y el
 * permiso explícito (`I_UNDERSTAND_THIS_IS_PRODUCTION=true` en la línea de comandos).
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { assertWritableEnvironment } from '../src/lib/env-guard'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { formatearInforme, poblarCodigos } from '../src/features/inventory/codigos-relleno'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }

async function main() {
  const ejecutar = process.argv.includes('--ejecutar')
  if (ejecutar) assertWritableEnvironment({ script: 'poblar-codigos', efecto: 'inserta filas en product_codes (no modifica productos ni variantes)' })
  const slug = arg('negocio')
  const negocios = await prisma.tenant.findMany({ where: { deletedAt: null, ...(slug ? { slug } : {}) }, select: { id: true, slug: true }, orderBy: { slug: 'asc' } })
  if (negocios.length === 0) { console.log('No hay negocios que procesar.'); return }
  let conflictos = 0
  for (const n of negocios) {
    const db = getTenantPrisma({ tenantId: n.id, userId: 'script', role: 'SUPERADMIN', access: 'FULL' })
    const informe = await poblarCodigos(db, n.id, { ejecutar })
    console.log(formatearInforme(n.slug, informe))
    conflictos += informe.colisiones.length + informe.desfases.length
  }
  console.log(`\n${ejecutar ? 'Hecho' : 'ENSAYO (no se escribió nada)'}: ${negocios.length} negocio(s), ${conflictos} conflicto(s) a revisar a mano.`)
  if (conflictos > 0) process.exitCode = 3
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) }).finally(() => prisma.$disconnect())
