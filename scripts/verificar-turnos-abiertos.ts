/**
 * SOLO LECTURA. Antes de aplicar la migración `cajas_registradoras` (F6.8, paso 1): busca personas con MÁS DE UN turno de caja abierto. El índice nuevo «un turno abierto por persona»
 * fallaría con ellas, y una migración fallida deja la base marcada como fallida (P3009). No modifica nada.
 *
 *   npx tsx scripts/verificar-turnos-abiertos.ts
 *
 * Código de salida: 0 = nadie tiene dos turnos abiertos (se puede migrar) · 3 = hay personas con varios (cierra esos turnos a mano ANTES de desplegar) · 1 = fallo del script.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { prisma } from '../src/lib/prisma'
import { usuariosConVariosTurnosAbiertos } from '../src/features/branches/verificacion-turnos'

async function main() {
  const abiertos = await prisma.cashSession.count({ where: { status: 'ABIERTA' } })
  const filas = await usuariosConVariosTurnosAbiertos(prisma as never)
  if (filas.length === 0) {
    console.log(`SOLO LECTURA (no se escribió nada): ${abiertos} turno(s) abierto(s) en total y nadie tiene más de uno. La migración se puede aplicar.`)
    return
  }
  console.log(`SOLO LECTURA (no se escribió nada): ${filas.length} persona(s) con más de un turno abierto. La migración FALLARÍA. Cierra los sobrantes y vuelve a correr esto:`)
  for (const f of filas.slice(0, 50)) {
    console.log(`  - negocio ${f.tenantId} · ${f.nombre} (${f.userId}) tiene ${f.turnos.length} abiertos:`)
    for (const t of f.turnos) console.log(`      turno ${t.id} · sucursal ${t.branchId} · abierto el ${t.abiertoEn.toISOString()}`)
  }
  if (filas.length > 50) console.log(`  … y ${filas.length - 50} más`)
  process.exitCode = 3
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) }).finally(() => prisma.$disconnect())
