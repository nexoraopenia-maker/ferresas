import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { closeCashSession, openCashSession, totalesDelTurno } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { registrarAbono } from '../src/features/credito/credito-service'
import { registrarAbonoSchema } from '../src/features/credito/schemas'
import { auditarCoherenciaCredito } from '../src/features/credito/auditoria'
import { anularOdevolverVenta } from '../src/features/devoluciones/service'
import { anularOdevolverVentaSchema } from '../src/features/devoluciones/schemas'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.1a · Concurrencia de la devolución: dos personas devolviendo la misma venta, la devolución contra el cierre de caja, contra un abono,
 * y varias devoluciones a la vez que tocan los mismos productos en distinto orden (sin abrazos mortales).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 300) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-dvc-${randomUUID().slice(0, 6)}`, name: 'Devoluciones concurrencia', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_dvc' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`.toLowerCase(), name: 'Dueño', role: 'OWNER' } })
  await asignarSucursal(t.id, u.id, b1.branch.id)
  const O: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  const db = getTenantPrisma(O)
  const prod = (sku: string) => prisma.product.create({ data: { tenantId: t.id, sku, name: `Prod ${sku}`, unitType: 'UNIDAD', salePrice: 100, costPrice: 60 } })
  const [P1, P2, P3] = [await prod('P1'), await prod('P2'), await prod('P3')]
  for (const p of [P1, P2, P3]) await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: b1.warehouse.id, quantity: 1000 } })
  const cliente = await prisma.customer.create({ data: { tenantId: t.id, name: 'Cliente', docType: 'RUC', docNumber: ruc(), creditLimit: 100000 } })
  const vender = (items: { productId: string; quantity: number }[], payments: unknown[], over: Record<string, unknown> = {}) =>
    registerSale(db, O, registerSaleSchema.parse({ warehouseId: b1.warehouse.id, items: items.map((i) => ({ ...i, discount: 0 })), payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID(), ...over }) as never)
  const devolver = (saleId: string, over: Record<string, unknown> = {}) => anularOdevolverVenta(db, O, anularOdevolverVentaSchema.parse({ saleId, kind: 'DEVOLUCION', reason: 'Prueba de concurrencia', idempotencyKey: randomUUID(), ...over }))
  const stock = async (id: string) => num((await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId: id } })).quantity)

  console.log('\nA) Dos personas devuelven la MISMA venta a la vez')
  await openCashSession(db, O, openCashSchema.parse({ openingAmount: 0 }))
  let unaSola = 0, dobles = 0
  for (let i = 0; i < 5; i++) {
    const v = await vender([{ productId: P1.id, quantity: 2 }], [{ method: 'YAPE', amount: 200 }])
    const antes = await stock(P1.id)
    const [a, b] = await Promise.allSettled([devolver(v.saleId), devolver(v.saleId)])
    const ok = [a, b].filter((x) => x.status === 'fulfilled').length
    const devs = await prisma.saleReturn.count({ where: { tenantId: t.id, saleId: v.saleId } })
    if (ok === 1 && devs === 1 && (await stock(P1.id)) === antes + 2) unaSola++
    if (devs > 1) dobles++
  }
  check('>>> 5 carreras: SIEMPRE una sola devolución por venta y el stock se repone UNA vez', unaSola === 5 && dobles === 0, `${unaSola}/5`)

  const v2 = await vender([{ productId: P1.id, quantity: 1 }], [{ method: 'YAPE', amount: 100 }])
  const clave = randomUUID()
  const [x, y] = await Promise.allSettled([devolver(v2.saleId, { idempotencyKey: clave }), devolver(v2.saleId, { idempotencyKey: clave })])
  const okIds = [x, y].filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ returnId: string }>).value.returnId)
  check('>>> la MISMA clave a la vez: las dos reciben la MISMA devolución (una nueva y una repetida) y hay un solo registro', okIds.length === 2 && okIds[0] === okIds[1] && (await prisma.saleReturn.count({ where: { tenantId: t.id, saleId: v2.saleId } })) === 1)

  console.log('\nB) Devolución en efectivo contra el CIERRE de caja')
  let coherentes = 0, devueltaYcerrada = 0, rechazadaPorCierre = 0
  for (let i = 0; i < 6; i++) {
    const turno = await prisma.cashSession.findFirst({ where: { tenantId: t.id, status: 'ABIERTA' } })
    const turnoId = turno?.id ?? (await openCashSession(db, O, openCashSchema.parse({ openingAmount: 50 }))).id
    const v = await vender([{ productId: P2.id, quantity: 1 }], [{ method: 'EFECTIVO', amount: 100 }])
    const demora = [0, 10, 30, 60, 100, 160][i]!   // distintos desfases: unas veces gana el cierre y otras la devolución
    const [d, c] = await Promise.allSettled([devolver(v.saleId), new Promise((r) => setTimeout(r, demora)).then(() => closeCashSession(db, O, closeCashSchema.parse({ sessionId: turnoId, countedAmount: 0 })))])
    const cierre = await prisma.cashSession.findUniqueOrThrow({ where: { id: turnoId } })
    const enFilas = (await prisma.saleReturnRefund.findMany({ where: { cashSessionId: turnoId, mode: 'CAJA' } })).reduce((a, r) => a + Math.round(num(r.amount) * 100), 0) / 100
    if (c.status === 'fulfilled') {
      // El turno quedó cerrado: lo congelado tiene que coincidir con lo enlazado a él y con el recálculo.
      const re = await totalesDelTurno(db, turnoId)
      if (num(cierre.refundsCashTotal) === enFilas && re.refundsCashTotal === enFilas && num(cierre.expectedAmount) === Math.round((50 * 0 + num(cierre.openingAmount) + re.cashTotal - re.changeTotal - enFilas) * 100) / 100) coherentes++
      if (d.status === 'fulfilled') devueltaYcerrada++
      else if ((d.reason as { code?: string }).code === 'CASH_REQUIRED') rechazadaPorCierre++
    }
  }
  check('>>> 6 carreras: el cierre congela EXACTAMENTE las devoluciones enlazadas a su turno; o la devolución entró antes (y está en el cierre) o la rechazó el cierre (CASH_REQUIRED); nunca queda a medias', coherentes === 6 && devueltaYcerrada + rechazadaPorCierre === 6, `coherentes ${coherentes} · entró antes ${devueltaYcerrada} · rechazada ${rechazadaPorCierre}`)

  console.log('\nC) Venta fiada: devolución contra un ABONO a la vez')
  if (!(await prisma.cashSession.findFirst({ where: { tenantId: t.id, status: 'ABIERTA' } }))) await openCashSession(db, O, openCashSchema.parse({ openingAmount: 0 }))   // F6.8b: se cobra y se abona en el turno propio
  let unGanador = 0, balanceOk = true
  for (let i = 0; i < 5; i++) {
    const v = await vender([{ productId: P3.id, quantity: 2 }], [{ method: 'CREDITO', amount: 200 }], { customerId: cliente.id })
    const [d, a] = await Promise.allSettled([devolver(v.saleId), registrarAbono(db, O, registrarAbonoSchema.parse({ customerId: cliente.id, method: 'YAPE', amount: 50, receivableIds: [(await prisma.receivable.findFirstOrThrow({ where: { saleId: v.saleId } })).id], idempotencyKey: randomUUID() }))])
    const estado = (await prisma.sale.findUniqueOrThrow({ where: { id: v.saleId } })).status
    const cuenta = await prisma.receivable.findFirstOrThrow({ where: { saleId: v.saleId } })
    // O gana la devolución (cuenta ANULADA, sin abono) o gana el abono (venta COMPLETADA, cuenta con 50): nunca ambas cosas.
    const gano = (d.status === 'fulfilled' && a.status === 'rejected' && estado === 'DEVUELTA' && cuenta.status === 'ANULADA' && num(cuenta.paidAmount) === 0)
      || (d.status === 'rejected' && a.status === 'fulfilled' && estado === 'COMPLETADA' && num(cuenta.paidAmount) === 50)
    if (gano) unGanador++
    if ((await auditarCoherenciaCredito(db)).errores > 0) balanceOk = false
  }
  check('>>> 5 carreras: gana UNO solo (o la devolución, o el abono), y `auditar-credito` no ve errores en ningún caso', unGanador === 5 && balanceOk, `${unGanador}/5`)
  check('>>> la deuda del cliente = la suma de sus saldos abiertos al final', await (async () => { const cuentas = await prisma.receivable.findMany({ where: { tenantId: t.id, status: 'ABIERTA' } }); const suma = cuentas.reduce((a, r) => a + Math.round((num(r.amount) - num(r.paidAmount)) * 100), 0) / 100; return suma === num((await prisma.customer.findUniqueOrThrow({ where: { id: cliente.id } })).creditBalance) })())

  console.log('\nD) Varias devoluciones a la vez sobre los mismos productos, en distinto orden')
  const ventas = await Promise.all([
    vender([{ productId: P1.id, quantity: 1 }, { productId: P2.id, quantity: 1 }, { productId: P3.id, quantity: 1 }], [{ method: 'YAPE', amount: 300 }]),
    vender([{ productId: P3.id, quantity: 1 }, { productId: P2.id, quantity: 1 }, { productId: P1.id, quantity: 1 }], [{ method: 'YAPE', amount: 300 }]),
    vender([{ productId: P2.id, quantity: 1 }, { productId: P3.id, quantity: 1 }, { productId: P1.id, quantity: 1 }], [{ method: 'YAPE', amount: 300 }]),
    vender([{ productId: P1.id, quantity: 1 }, { productId: P3.id, quantity: 1 }, { productId: P2.id, quantity: 1 }], [{ method: 'YAPE', amount: 300 }]),
  ])
  const antes = [await stock(P1.id), await stock(P2.id), await stock(P3.id)]
  const rs = await Promise.allSettled(ventas.map((v) => devolver(v.saleId)))
  const despues = [await stock(P1.id), await stock(P2.id), await stock(P3.id)]
  check('>>> 4 devoluciones simultáneas con productos en distinto orden: todas terminan (sin abrazos mortales) y el stock sube exactamente 4 de cada producto', rs.every((r) => r.status === 'fulfilled') && despues.every((d, i) => d === antes[i]! + 4), rs.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason?.message).join(' | '))
  const numeros = (await prisma.saleReturn.findMany({ where: { tenantId: t.id }, select: { number: true } })).map((r) => r.number)
  check('>>> los números de devolución no se repiten ni se saltan (correlativo sin huecos)', new Set(numeros).size === numeros.length && numeros.sort().every((n, i) => n === `D001-${String(i + 1).padStart(8, '0')}`))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
