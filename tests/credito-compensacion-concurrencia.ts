import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { anularAbono, registrarAbono } from '../src/features/credito/credito-service'
import { anularAbonoSchema, registrarAbonoSchema } from '../src/features/credito/schemas'
import { auditarCoherenciaCredito } from '../src/features/credito/auditoria'
import { closeCashSession, openCashSession, totalesDelTurno } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { registrarMovimientoCaja } from '../src/features/branches/cash-movement-service'
import { registrarMovimientoCajaSchema } from '../src/features/branches/cash-movement-schemas'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.3b · Concurrencia de la compensación: el mismo abono anulado por varias personas a la vez, muchos abonos a la vez, y la anulación contra el cierre
 * de la caja donde se compensa o contra un gasto manual.
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
  const t = await prisma.tenant.create({ data: { slug: `rp-cc3c-${randomUUID().slice(0, 6)}`, name: 'Compensación concurrencia', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cc3c' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const x = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`.toLowerCase(), name: 'Dueño', role: 'OWNER' } })
  await asignarSucursal(t.id, x.id, b1.branch.id)
  const O: TenantContext = { tenantId: t.id, userId: x.id, role: 'OWNER', access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  const db = getTenantPrisma(O)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Cemento', unitType: 'UNIDAD', salePrice: 100, costPrice: 60 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: b1.warehouse.id, quantity: 10000 } })
  let dni = 53300000
  const cliente = () => prisma.customer.create({ data: { tenantId: t.id, name: `Cliente ${dni}`, docType: 'DNI', docNumber: String(dni++), creditLimit: 99999 } })
  const fiar = (monto: number, customerId: string) => registerSale(db, O, { warehouseId: b1.warehouse.id, customerId, items: [{ productId: prod.id, quantity: monto / 100, discount: 0 }], payments: [{ method: 'CREDITO', amount: monto }], documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() } as never)
  const abonar = (customerId: string, amount: number) => registrarAbono(db, O, registrarAbonoSchema.parse({ customerId, method: 'EFECTIVO', amount, idempotencyKey: randomUUID() }))
  const anular = (paymentId: string) => anularAbono(db, O, anularAbonoSchema.parse({ paymentId, motivo: 'Prueba de concurrencia' }))
  const abrir = (f = 0) => openCashSession(db, O, openCashSchema.parse({ openingAmount: f }))
  const cerrar = (id: string) => closeCashSession(db, O, closeCashSchema.parse({ sessionId: id, countedAmount: 0 }))

  const C = await cliente()
  const T1 = await abrir(0)
  await fiar(5000, C.id)   // F6.8b: fiar exige el turno propio
  const abonos: Awaited<ReturnType<typeof abonar>>[] = []
  for (let i = 0; i < 6; i++) abonos.push(await abonar(C.id, 100))
  await cerrar(T1.id)
  const T2 = await abrir(1000)

  console.log('\nA) El MISMO abono anulado por 5 personas a la vez')
  const rs = await Promise.allSettled(Array.from({ length: 5 }, () => anular(abonos[0]!.paymentId)))
  check('>>> exactamente una anulación prospera y las demás ven el abono ya anulado', rs.filter((r) => r.status === 'fulfilled').length === 1, rs.map(msg).join(' | '))
  check('>>> UNA sola compensación, y la deuda se restituye una sola vez (4900 → 5000 − 500 + 100…)', (await prisma.cashMovement.count({ where: { relatedPaymentId: abonos[0]!.paymentId } })) === 1 && num((await prisma.customer.findUniqueOrThrow({ where: { id: C.id } })).creditBalance) === 4400 + 100)

  console.log('\nB) Cinco abonos distintos a la vez')
  const r5 = await Promise.allSettled(abonos.slice(1).map((a) => anular(a.paymentId)))
  const tot = await totalesDelTurno(db, T2.id)
  check('>>> los 5 prosperan, cada uno con SU compensación, y el turno de hoy suma 600.00 de egresos manuales', r5.every((x) => x.status === 'fulfilled') && (await prisma.cashMovement.count({ where: { tenantId: t.id, category: 'COMPENSACION_ABONO' } })) === 6 && tot.manualOutTotal === 600, r5.map(msg).filter(Boolean).join(' | '))
  check('>>> la deuda vuelve entera (5000) y `auditar-credito` no ve errores', num((await prisma.customer.findUniqueOrThrow({ where: { id: C.id } })).creditBalance) === 5000 && (await auditarCoherenciaCredito(db)).hallazgos.filter((h) => h.gravedad === 'ERROR').length === 0)

  await cerrar(T2.id)   // las rondas siguientes abren y cierran sus propios turnos

  console.log('\nC) Anular contra cerrar la caja donde se compensa')
  let coherente = true, det = '', entro = 0, rechazado = 0
  for (let i = 0; i < 4; i++) {
    const cli = await cliente(); const Tc = await abrir(0); await fiar(300, cli.id)
    const ab = await abonar(cli.id, 50); await cerrar(Tc.id)
    const Th = await abrir(500)
    const res = await Promise.allSettled([anular(ab.paymentId), cerrar(Th.id)])
    const cerrada = await prisma.cashSession.findUniqueOrThrow({ where: { id: Th.id } })
    const vivos = await prisma.cashMovement.aggregate({ where: { cashSessionId: Th.id, voidedAt: null, method: 'EFECTIVO', kind: 'EGRESO' }, _sum: { amount: true } })
    // Lo congelado al cerrar = lo que hay en la base: la compensación o entró antes del cierre (y está congelada) o se rechazó. Nunca llega después.
    if (num(cerrada.manualOutTotal) !== num(vivos._sum.amount)) { coherente = false; det = `${cerrada.manualOutTotal} congelado vs ${vivos._sum.amount} ${res.map(msg).join('|')}` }
    if (res[0].status === 'fulfilled') entro++; else rechazado++
    const anulado = (await prisma.customerPayment.findUniqueOrThrow({ where: { id: ab.paymentId } })).voidedAt !== null
    // O el abono quedó anulado Y compensado, o sigue vigente y sin compensación: nunca a medias.
    const comp = await prisma.cashMovement.count({ where: { relatedPaymentId: ab.paymentId } })
    if (anulado !== (comp === 1)) { coherente = false; det = `abono anulado=${anulado} compensaciones=${comp}` }
  }
  check('>>> en 4 rondas: lo congelado en el cierre = lo que quedó en la base, y el abono nunca queda anulado sin compensación (ni compensado sin anular)', coherente, det)
  check('(informativo) hubo carreras reales: la anulación entró o se rechazó según quién llegó primero', entro + rechazado === 4)

  console.log('\nD) Anular contra un gasto manual en la misma caja')
  const cli = await cliente(); const Tx = await abrir(0); await fiar(300, cli.id)
  const abx = await abonar(cli.id, 70); await cerrar(Tx.id)
  const Ty = await abrir(1000)
  const mix = await Promise.allSettled([
    anular(abx.paymentId),
    registrarMovimientoCaja(db, O, registrarMovimientoCajaSchema.parse({ kind: 'EGRESO', category: 'GASTO_MENOR', amount: 20, description: 'Gasto a la vez', idempotencyKey: randomUUID() })),
  ])
  const t3 = await totalesDelTurno(db, Ty.id)
  check('>>> las dos entran y el turno suma 90.00 de egresos (70 de compensación + 20 de gasto)', mix.every((r) => r.status === 'fulfilled') && t3.manualOutTotal === 90, mix.map(msg).filter(Boolean).join(' | '))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
