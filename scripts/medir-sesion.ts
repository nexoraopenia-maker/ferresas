/**
 * ¿Cuántas idas y vueltas cuesta la consulta de sesión?
 *
 * Se mide desde el portátil A PROPÓSITO: con 605 ms de latencia, la
 * diferencia entre 1 y 3 idas y vueltas es imposible de confundir con ruido.
 * En producción (14 ms) los tres saltos se ven como "45 ms" y parecen una
 * consulta lenta en vez de tres consultas rápidas.
 */
import '../tests/guard'
import { prisma } from '@/lib/prisma'

const ms = (n: number) => `${n.toFixed(0)} ms`

const USER_SELECT = {
  id: true, role: true, isActive: true, deletedAt: true,
  tenantId: true, passwordChangedAt: true,
  tenant: {
    select: {
      isActive: true,
      subscription: {
        select: {
          status: true, pastDueSince: true, graceDays: true,
          trialEndsAt: true, currentPeriodEnd: true,
        },
      },
    },
  },
  branches: {
    where: { branch: { deletedAt: null, isActive: true } },
    select: { branch: { select: { id: true, code: true, isDefault: true } } },
  },
} as const

async function media(fn: () => Promise<unknown>, n = 4): Promise<number> {
  await fn() // descarta la primera
  const t: number[] = []
  for (let i = 0; i < n; i++) {
    const a = performance.now()
    await fn()
    t.push(performance.now() - a)
  }
  return t.reduce((x, y) => x + y) / t.length
}

async function main() {
  const u = await prisma.user.findFirst({
    where: { tenantId: { not: null }, isActive: true },
    select: { id: true },
  })
  if (!u) throw new Error('sin usuarios para medir')

  const ping = await media(() => prisma.$queryRawUnsafe('SELECT 1'))
  console.log(`\n  una ida y vuelta (SELECT 1):            ${ms(ping)}`)

  const actual = await media(() =>
    prisma.user.findUnique({ where: { id: u.id }, select: USER_SELECT }),
  )
  console.log(`  consulta de sesión ACTUAL:              ${ms(actual)}  ≈ ${(actual / ping).toFixed(1)} idas y vueltas`)

  // `relationLoadStrategy: 'join'` resuelve las relaciones con LATERAL JOIN
  // en UNA sola sentencia, en lugar de una consulta por relación.
  let conJoin = 0
  try {
    conJoin = await media(() =>
      prisma.user.findUnique({
        where: { id: u.id },
        select: USER_SELECT,
        relationLoadStrategy: 'join',
      }),
    )
    console.log(`  con relationLoadStrategy: 'join':       ${ms(conJoin)}  ≈ ${(conJoin / ping).toFixed(1)} idas y vueltas`)
  } catch (e) {
    console.log(`  relationLoadStrategy NO disponible: ${(e as Error).message.slice(0, 90)}`)
  }

  // Control: la misma consulta SIN relaciones anidadas.
  const plana = await media(() =>
    prisma.user.findUnique({
      where: { id: u.id },
      select: { id: true, role: true, isActive: true, deletedAt: true, tenantId: true, passwordChangedAt: true },
    }),
  )
  console.log(`  control, SIN relaciones anidadas:       ${ms(plana)}  ≈ ${(plana / ping).toFixed(1)} idas y vueltas`)

  if (conJoin > 0) {
    const ahorro = ((actual - conJoin) / actual) * 100
    console.log(`\n  ahorro con join: ${ahorro.toFixed(0)}%  (${ms(actual)} → ${ms(conJoin)})`)
  }
  await prisma.$disconnect()
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
