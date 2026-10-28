import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { closeCashSession, openCashSession, totalesDelTurno } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { anularMovimientoCaja, registrarMovimientoCaja } from '../src/features/branches/cash-movement-service'
import { anularMovimientoCajaSchema, registrarMovimientoCajaSchema } from '../src/features/branches/cash-movement-schemas'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.3a · Concurrencia de los movimientos manuales: contra el cierre de caja (nada se cuela en un turno que se está cerrando), el mismo envío
 * repetido a la vez, muchos registros a la vez y anular contra cerrar.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const num = (d: { toString(): string } | null | undefined) => (d == null ? 0 : Number(d.toString()))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const msg = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? String((r.reason as Error).message ?? r.reason) : '')

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 300) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-cmc-${randomUUID().slice(0, 6)}`, name: 'Movimientos concurrencia', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cmc' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const x = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`.toLowerCase(), name: 'Dueño', role: 'OWNER' } })
  await asignarSucursal(t.id, x.id, b1.branch.id)
  const O: TenantContext = { tenantId: t.id, userId: x.id, role: 'OWNER', access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  const db = getTenantPrisma(O)
  const reg = (o: Record<string, unknown> = {}) => registrarMovimientoCaja(db, O, registrarMovimientoCajaSchema.parse({ kind: 'INGRESO', category: 'OTRO', amount: 10, description: 'Ingreso de prueba', idempotencyKey: randomUUID(), ...o }))

  console.log('\nA) Muchos registros a la vez en el mismo turno')
  const turno = await openCashSession(db, O, openCashSchema.parse({ openingAmount: 0 }))
  const rs = await Promise.allSettled(Array.from({ length: 12 }, () => reg()))
  const tot = await totalesDelTurno(db, turno.id)
  check('>>> 12 ingresos de 10 a la vez: los 12 entran y el turno suma exactamente 120.00', rs.every((r) => r.status === 'fulfilled') && tot.manualInTotal === 120 && (await prisma.cashMovement.count({ where: { cashSessionId: turno.id } })) === 12, rs.map(msg).filter(Boolean).join(' | '))

  console.log('\nB) El mismo envío repetido a la vez')
  const clave = randomUUID()
  const rd = await Promise.allSettled(Array.from({ length: 6 }, () => reg({ idempotencyKey: clave, amount: 7.5 })))
  const ids = new Set(rd.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id))
  check('>>> 6 envíos simultáneos con la misma clave dejan UN solo movimiento y todos reciben ese mismo', ids.size === 1 && rd.every((r) => r.status === 'fulfilled') && (await prisma.cashMovement.count({ where: { tenantId: t.id, idempotencyKey: clave } })) === 1, rd.map(msg).filter(Boolean).join(' | '))

  console.log('\nC) Registrar contra cerrar el turno')
  let coherente = true, algunoEntro = false, algunoRechazado = false, det = ''
  for (let i = 0; i < 5; i++) {
    const abierto = await prisma.cashSession.findFirstOrThrow({ where: { tenantId: t.id, status: 'ABIERTA' } })
    const lote = Array.from({ length: 4 }, () => reg({ amount: 3 }))
    const cierre = closeCashSession(db, O, closeCashSchema.parse({ sessionId: abierto.id, countedAmount: 0 }))
    const res = await Promise.allSettled([...lote, cierre])
    const cerrada = await prisma.cashSession.findUniqueOrThrow({ where: { id: abierto.id } })
    const vivos = await prisma.cashMovement.aggregate({ where: { cashSessionId: abierto.id, voidedAt: null, kind: 'INGRESO' }, _sum: { amount: true } })
    // Lo congelado en el cierre DEBE ser exactamente lo que el turno tiene ahora: ningún movimiento llegó después de congelar los totales.
    if (num(cerrada.manualInTotal) !== num(vivos._sum.amount)) { coherente = false; det = `${cerrada.manualInTotal} congelado vs ${vivos._sum.amount} en la base ${res.map(msg).join('|')}` }
    if (res.slice(0, 4).some((r) => r.status === 'fulfilled')) algunoEntro = true
    if (res.slice(0, 4).some((r) => r.status === 'rejected')) algunoRechazado = true
    await openCashSession(db, O, openCashSchema.parse({ openingAmount: 0 }))
  }
  check('>>> en 5 rondas de 4 movimientos contra el cierre: lo congelado = lo que quedó en la base (nada se cuela después del cierre)', coherente, det)
  check('(informativo) hubo rondas con movimientos que entraron antes del cierre o que se rechazaron después: la carrera es real', algunoEntro || algunoRechazado)

  console.log('\nD) Anular contra cerrar')
  let coherente2 = true, det2 = ''
  for (let i = 0; i < 4; i++) {
    const abierto = await prisma.cashSession.findFirstOrThrow({ where: { tenantId: t.id, status: 'ABIERTA' } })
    const m = await reg({ amount: 20 })
    const res = await Promise.allSettled([
      anularMovimientoCaja(db, O, anularMovimientoCajaSchema.parse({ movementId: m.id, reason: 'Carrera con el cierre' })),
      closeCashSession(db, O, closeCashSchema.parse({ sessionId: abierto.id, countedAmount: 0 })),
    ])
    const cerrada = await prisma.cashSession.findUniqueOrThrow({ where: { id: abierto.id } })
    const vivos = await prisma.cashMovement.aggregate({ where: { cashSessionId: abierto.id, voidedAt: null, kind: 'INGRESO' }, _sum: { amount: true } })
    if (num(cerrada.manualInTotal) !== num(vivos._sum.amount)) { coherente2 = false; det2 = `${cerrada.manualInTotal} vs ${vivos._sum.amount} ${res.map(msg).join('|')}` }
    await openCashSession(db, O, openCashSchema.parse({ openingAmount: 0 }))
  }
  check('>>> anular un movimiento a la vez que se cierra el turno: o entra en el cierre ya anulado o se rechaza; lo congelado siempre coincide con la base', coherente2, det2)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
