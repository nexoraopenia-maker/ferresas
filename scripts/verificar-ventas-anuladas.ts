/**
 * SOLO LECTURA. Antes de aplicar la migración `devoluciones_venta` en un entorno: busca ventas ANULADA o DEVUELTA que NO tengan fecha de
 * anulación o motivo, porque el CHECK nuevo de `sales` (`sales_anulada_devuelta_chk`) haría fallar la migración. No modifica nada.
 *
 *   npx tsx scripts/verificar-ventas-anuladas.ts
 *
 * Código de salida: 0 = ninguna fila rompe el CHECK (se puede migrar) · 3 = hay filas que lo romperían (no migres; avísame) · 1 = fallo del script.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { prisma } from '../src/lib/prisma'
import { ventasQueRompenElCheck } from '../src/features/devoluciones/verificacion'

async function main() {
  const filas = await ventasQueRompenElCheck(prisma)
  if (filas.length === 0) {
    console.log('SOLO LECTURA (no se escribió nada): ninguna venta ANULADA/DEVUELTA rompe el CHECK. La migración se puede aplicar.')
    return
  }
  console.log(`SOLO LECTURA (no se escribió nada): ${filas.length} venta(s) ANULADA/DEVUELTA sin fecha o motivo romperían el CHECK:`)
  for (const f of filas.slice(0, 50)) console.log(`  - negocio ${f.tenantId} · venta ${f.number} · ${f.status} · fecha ${f.voidedAt ? 'sí' : 'FALTA'} · motivo ${f.voidReason?.trim() ? 'sí' : 'FALTA'}`)
  if (filas.length > 50) console.log(`  … y ${filas.length - 50} más`)
  process.exitCode = 3
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) }).finally(() => prisma.$disconnect())
