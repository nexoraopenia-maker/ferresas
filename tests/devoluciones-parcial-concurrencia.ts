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
import { devolverProductosVenta } from '../src/features/devoluciones/parcial-service'
import { devolverProductosSchema } from '../src/features/devoluciones/schemas'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.2a · Concurrencia de la devolución parcial: varias personas devolviendo la MISMA línea a la vez (el tope no se pasa nunca), la misma clave
 * repetida, devoluciones de líneas distintas en distinto orden (sin abrazos mortales), contra el cierre de caja y contra un abono.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
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
  const t = await prisma.tenant.create({ data: { slug: `rp-dpc-${randomUUID().slice(0, 6)}`, name: 'Parcial concurrencia', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_dpc' } })
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
  const linea = (saleId: string, productId: string) => prisma.saleItem.findFirstOrThrow({ where: { saleId, productId } })
  const devolver = (saleId: string, lines: { saleItemId: string; quantity: number; destination?: 'STOCK' | 'MERMA' }[], over: Record<string, unknown> = {}) =>
    devolverProductosVenta(db, O, devolverProductosSchema.parse({ saleId, reason: 'Prueba de concurrencia', lines, idempotencyKey: randomUUID(), ...over }))
  const stock = async (id: string) => num((await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId: id } })).quantity)
  await openCashSession(db, O, openCashSchema.parse({ openingAmount: 0 }))

  console.log('\nA) Cinco personas devuelven la MISMA línea de 3 unidades, de 1 en 1, a la vez')
  let tope = true, suma = true, stockOk = true, unaCompleta = true, tres = true, detalle = ''
  for (let i = 0; i < 4; i++) {
    const v = await vender([{ productId: P1.id, quantity: 3 }], [{ method: 'YAPE', amount: 300 }])
    const li = await linea(v.saleId, P1.id)
    const antes = await stock(P1.id)
    const rs = await Promise.allSettled(Array.from({ length: 5 }, () => devolver(v.saleId, [{ saleItemId: li.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] })))
    const ok = rs.filter((r) => r.status === 'fulfilled').length
    const fin = await prisma.saleItem.findUniqueOrThrow({ where: { id: li.id } })
    const devs = await prisma.saleReturn.findMany({ where: { saleId: v.saleId } })
    if (ok !== 3) { tres = false; detalle = `ok=${ok} ${rs.map(msg).join(' | ')}` }
    if (num(fin.returnedQuantity) !== 3 || num(fin.returnedAmount) !== 300) tope = false
    if (Math.round(devs.reduce((a, d) => a + num(d.returnTotal), 0) * 100) !== 30_000) suma = false
    if ((await stock(P1.id)) !== antes + 3) stockOk = false
    if (devs.filter((d) => d.isFull).length !== 1 || (await prisma.sale.findUniqueOrThrow({ where: { id: v.saleId } })).status !== 'DEVUELTA') unaCompleta = false
  }
  check('>>> en 4 rondas de 5 intentos para 3 unidades: SIEMPRE exactamente 3 salen bien y 2 se rechazan', tres, detalle)
  check('>>> el tope de la línea queda en 3 de 3 y 300.00 de 300.00 (nunca se pasa)', tope)
  check('>>> Σ de las devoluciones = 300.00 exactos y el stock repone exactamente 3', suma && stockOk)
  check('>>> una sola devolución queda marcada como la que completa la venta, y la venta es DEVUELTA', unaCompleta)

  console.log('\nB) La misma clave de idempotencia, a la vez')
  const vI = await vender([{ productId: P1.id, quantity: 2 }], [{ method: 'YAPE', amount: 200 }])
  const lI = await linea(vI.saleId, P1.id)
  const clave = randomUUID(), antesI = await stock(P1.id)
  const ri = await Promise.allSettled(Array.from({ length: 4 }, () => devolver(vI.saleId, [{ saleItemId: lI.id, quantity: 1 }], { idempotencyKey: clave, refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] })))
  const idsI = new Set(ri.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ returnId: string }>).value.returnId))
  check('>>> 4 envíos simultáneos con la misma clave dejan UNA sola devolución y UN solo reingreso', idsI.size === 1 && (await prisma.saleReturn.count({ where: { saleId: vI.saleId } })) === 1 && (await stock(P1.id)) === antesI + 1, ri.map(msg).filter(Boolean).join(' | '))

  console.log('\nC) Líneas distintas en distinto orden, a la vez (sin abrazos mortales)')
  let sinMuertos = true, detC = ''
  for (let i = 0; i < 3; i++) {
    const v1 = await vender([{ productId: P1.id, quantity: 2 }, { productId: P2.id, quantity: 2 }, { productId: P3.id, quantity: 2 }], [{ method: 'YAPE', amount: 600 }])
    const v2 = await vender([{ productId: P3.id, quantity: 2 }, { productId: P2.id, quantity: 2 }, { productId: P1.id, quantity: 2 }], [{ method: 'YAPE', amount: 600 }])
    const todas = async (id: string) => (await prisma.saleItem.findMany({ where: { saleId: id } })).map((x) => ({ saleItemId: x.id, quantity: 1 }))
    const ys = await Promise.allSettled([
      devolver(v1.saleId, await todas(v1.saleId), { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 300 }] }),
      devolver(v2.saleId, (await todas(v2.saleId)).reverse(), { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 300 }] }),
    ])
    if (ys.some((r) => r.status === 'rejected')) { sinMuertos = false; detC = ys.map(msg).join(' | ') }
  }
  check('>>> dos devoluciones parciales cruzadas sobre los mismos productos en orden opuesto salen bien las dos', sinMuertos, detC)

  console.log('\nD) Contra el cierre de caja')
  let coherente = true, detD = ''
  for (let i = 0; i < 3; i++) {
    const turno = await prisma.cashSession.findFirstOrThrow({ where: { tenantId: t.id, status: 'ABIERTA' } })
    const v = await vender([{ productId: P1.id, quantity: 2 }], [{ method: 'EFECTIVO', amount: 200 }])
    const li = await linea(v.saleId, P1.id)
    const r = await Promise.allSettled([
      devolver(v.saleId, [{ saleItemId: li.id, quantity: 1 }]),
      closeCashSession(db, O, closeCashSchema.parse({ sessionId: turno.id, countedAmount: 0 })),
    ])
    const cerrado = await prisma.cashSession.findUniqueOrThrow({ where: { id: turno.id } })
    const vivo = await totalesDelTurno(db, turno.id)
    // O la devolución entró en el turno antes de cerrarse (y el cierre la congeló), o vio el turno cerrado y se negó: nunca queda a medias.
    if (num(cerrado.refundsCashTotal) !== vivo.refundsCashTotal) { coherente = false; detD = `${cerrado.refundsCashTotal} vs ${vivo.refundsCashTotal} ${r.map(msg).join('|')}` }
    await openCashSession(db, O, openCashSchema.parse({ openingAmount: 0 }))
  }
  check('>>> lo congelado en el cierre = lo que el turno recalcula, gane quien gane la carrera', coherente, detD)

  console.log('\nE) Contra un abono (fiado)')
  let creditoLimpio = true, nunca = true, detE = ''
  {
    const v = await vender([{ productId: P1.id, quantity: 3 }], [{ method: 'CREDITO', amount: 300 }], { customerId: cliente.id })
    const li = await linea(v.saleId, P1.id)
    const r = await Promise.allSettled([
      devolver(v.saleId, [{ saleItemId: li.id, quantity: 3 }]),
      registrarAbono(db, O, registrarAbonoSchema.parse({ customerId: cliente.id, method: 'YAPE', amount: 100, idempotencyKey: randomUUID() })),
    ])
    // Si el abono entró primero, devolver las 3 (300) excede el saldo → bloqueado; si la devolución entró primero, la deuda ya no existe.
    // Ambas no pueden prosperar cuando el abono se aplicó a ESTA cuenta.
    const cuenta = await prisma.receivable.findFirstOrThrow({ where: { saleId: v.saleId } })
    if (r[0].status === 'fulfilled' && num(cuenta.paidAmount) > 0) { nunca = false; detE = `devolvió con abono: ${cuenta.status} ${cuenta.amount}/${cuenta.paidAmount}` }
    const inf = await auditarCoherenciaCredito(db)
    if (inf.hallazgos.length > 0) { creditoLimpio = false; detE = JSON.stringify(inf.hallazgos.slice(0, 2)) }
  }
  check('>>> devolver todo un fiado de 300 y abonar 100 a la vez nunca prospera con ambos sobre la misma cuenta', nunca, detE)
  check('>>> y `auditar-credito` queda limpio', creditoLimpio, detE)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
