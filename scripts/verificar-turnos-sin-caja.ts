/**
 * SOLO LECTURA. Antes del paso 2 de F6.8 (volver `registerId` NOT NULL): busca turnos de caja que todavía no tienen caja asignada. Los rellena la migración del paso 1, pero un turno que
 * abra la versión anterior del código durante la ventana de despliegue queda sin caja. No modifica nada.
 *
 *   npx tsx scripts/verificar-turnos-sin-caja.ts
 *
 * Código de salida: 0 = todos los turnos tienen caja (se puede pasar al paso 2) · 3 = quedan turnos sin caja (no apliques el paso 2; avísame) · 1 = fallo del script.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { prisma } from '../src/lib/prisma'
import { turnosSinCaja } from '../src/features/branches/verificacion-turnos'

async function main() {
  const filas = await turnosSinCaja(prisma as never)
  if (filas.length === 0) {
    console.log('SOLO LECTURA (no se escribió nada): todos los turnos tienen caja asignada. Se puede pasar al paso 2.')
    return
  }
  console.log(`SOLO LECTURA (no se escribió nada): ${filas.length} turno(s) sin caja asignada:`)
  for (const f of filas.slice(0, 50)) console.log(`  - negocio ${f.tenantId} · sucursal ${f.branchId} · turno ${f.id} · ${f.status}`)
  if (filas.length > 50) console.log(`  … y ${filas.length - 50} más`)
  process.exitCode = 3
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) }).finally(() => prisma.$disconnect())
