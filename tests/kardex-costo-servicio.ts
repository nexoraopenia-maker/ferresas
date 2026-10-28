import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma, type TenantPrismaClient } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { costoTrasDevolucion } from '../src/features/compras/costo'
import { anularCompraSchema, crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { anularCompra, crearBorrador, recibirCompra } from '../src/features/compras/service'
import { applyStockMovement, completarCostoEntrada, createStockMovement } from '../src/features/inventory/stock-service'
import { createStockMovementSchema, createProductExpressSchema } from '../src/features/inventory/schemas'
import { createProductExpress } from '../src/features/inventory/product-service'
import { resolverMerma, solicitarMerma } from '../src/features/inventory/merma-service'
import { resolverMermaSchema, solicitarMermaSchema } from '../src/features/inventory/merma-schemas'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { anularOdevolverVenta } from '../src/features/devoluciones/service'
import { anularOdevolverVentaSchema, devolverProductosSchema } from '../src/features/devoluciones/schemas'
import { devolverProductosVenta } from '../src/features/devoluciones/parcial-service'
import { openCashSession } from '../src/features/branches/cash-service'
import { openCashSchema } from '../src/features/branches/cash-schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.4a · Cada punto que escribe un movimiento de stock deja su costo: con qué se valoró (`unitCostApplied`), el promedio vigente justo después
 * (`costAfter`) y de dónde sale el dato (`costOrigin`). Contra la base: compra, anulación de compra, venta (con su enlace), devolución total y parcial
 * (con merma), merma, ajuste, entradas manuales con y sin costo (y completarlo), transferencia, alta exprés, stock negativo y las reglas de la base.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const num = (d: { toString(): string } | null | undefined) => (d === null || d === undefined ? null : Number(d.toString()))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const falla = (p: Promise<unknown>) => p.then(() => false).catch(() => true)

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 500) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-kcs-${randomUUID().slice(0, 6)}`, name: 'Kardex costo', taxId: ruc(), planId: plan.id, realBillingEnabledAt: new Date('2026-01-01T00:00:00Z') } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_kcs' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ALMACENERO'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    for (const b of [b1, b2]) await asignarSucursal(t.id, x.id, b.branch.id)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: [] }
  }
  const O = u.OWNER!, AL = u.ALMACENERO!
  const db = (c: TenantContext) => getTenantPrisma(c)
  const W = b1.warehouse.id
  const P = await prisma.product.create({ data: { tenantId: t.id, sku: 'K1', name: 'Cemento', unitType: 'UNIDAD', salePrice: 20, costPrice: 0 } })
  const costoProducto = async () => num((await prisma.product.findUniqueOrThrow({ where: { id: P.id } })).costPrice)!
  const stockTotal = async () => Number((await prisma.stock.aggregate({ where: { tenantId: t.id, productId: P.id }, _sum: { quantity: true } }))._sum.quantity ?? 0)
  const mov = (id: string) => prisma.stockMovement.findUniqueOrThrow({ where: { id } })
  const ultimo = async (extra: Record<string, unknown> = {}) => prisma.stockMovement.findFirstOrThrow({ where: { tenantId: t.id, productId: P.id, ...extra }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const comprar = async (cantidad: number, costo: number) => {
    const b = await crearBorrador(db(O), O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: W, items: [{ productId: P.id, enteredQuantity: cantidad, unitCost: costo }] }))
    await recibirCompra(db(O), O, recibirCompraSchema.parse({ purchaseId: b.id }))
    return b.id
  }

  console.log('\nA) Compras: el costo de la línea y el promedio NUEVO')
  const c1 = await comprar(10, 5)
  const m1 = await ultimo({ referenceType: 'COMPRA' })
  check('>>> compra 1 (10 u a S/ 5, sin costo previo): se valora a 5 y el promedio queda en 5, EXACTO y con su enlace', num(m1.unitCostApplied) === 5 && num(m1.costAfter) === 5 && m1.costOrigin === 'EXACTO' && m1.referenceId === c1 && m1.costPending === false)
  const c2 = await comprar(10, 7)
  const m2 = await ultimo({ referenceType: 'COMPRA' })
  check('>>> compra 2 (10 u a S/ 7): se valora a 7 y el promedio pasa a 6 (el movimiento guarda el promedio NUEVO)', num(m2.unitCostApplied) === 7 && num(m2.costAfter) === 6 && (await costoProducto()) === 6 && m2.referenceId === c2)
  check('>>> la compra 1 conserva el promedio de SU momento (5): el historial no cambia', num((await mov(m1.id)).costAfter) === 5)

  console.log('\nB) Venta: valora al promedio vigente y se enlaza con su venta')
  const venta = await registerSale(db(O), O, registerSaleSchema.parse({ warehouseId: W, items: [{ productId: P.id, quantity: 4, discount: 0 }], payments: [{ method: 'EFECTIVO', amount: 80 }], documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() }) as never)
  const mv = await ultimo({ source: 'VENTA' })
  const linea = await prisma.saleItem.findFirstOrThrow({ where: { saleId: venta.saleId, productId: P.id } })
  check('>>> la salida de la venta se valora a 6 (= el costo que guardó la línea de venta), con el promedio vigente 6', num(mv.unitCostApplied) === 6 && num(mv.costAfter) === 6 && num(linea.unitCost) === 6 && mv.costOrigin === 'EXACTO' && mv.type === 'SALIDA')
  check('>>> y queda enlazada: referencia VENTA con el id de la venta (antes era «MANUAL» sin enlace)', mv.referenceType === 'VENTA' && mv.referenceId === venta.saleId)

  console.log('\nC) Devoluciones: al costo de la venta original')
  await openCashSession(db(O), O, openCashSchema.parse({ openingAmount: 100 }))
  // El promedio cambia ENTRE la venta y la devolución (6 → 7): lo devuelto se valora al costo de la VENTA (6), no al promedio de hoy (7).
  await prisma.product.update({ where: { id: P.id }, data: { costPrice: 7 } })
  const anul = await anularOdevolverVenta(db(O), O, anularOdevolverVentaSchema.parse({ saleId: venta.saleId, kind: 'ANULACION', reason: 'Se equivocó el cajero', idempotencyKey: randomUUID() }))
  const md = await ultimo({ type: 'DEVOLUCION_CLIENTE' })
  await prisma.product.update({ where: { id: P.id }, data: { costPrice: 6 } })
  check('>>> la anulación devuelve las 4 u al stock valoradas a 6 (el costo de la venta) aunque el promedio ya era 7; el promedio vigente (7) no se toca', !!anul && num(md.unitCostApplied) === 6 && num(md.costAfter) === 7 && md.referenceType === 'DEVOLUCION' && md.costOrigin === 'EXACTO' && (await stockTotal()) === 20)
  const venta2 = await registerSale(db(O), O, registerSaleSchema.parse({ warehouseId: W, items: [{ productId: P.id, quantity: 4, discount: 0 }], payments: [{ method: 'EFECTIVO', amount: 80 }], documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() }) as never)
  const item2 = await prisma.saleItem.findFirstOrThrow({ where: { saleId: venta2.saleId } })
  await prisma.product.update({ where: { id: P.id }, data: { costPrice: 7 } })
  await devolverProductosVenta(db(O), O, devolverProductosSchema.parse({ saleId: venta2.saleId, reason: 'Llegaron dañados', lines: [{ saleItemId: item2.id, quantity: 1, destination: 'MERMA' }], idempotencyKey: randomUUID() }))
  const parcial = await prisma.stockMovement.findMany({ where: { tenantId: t.id, productId: P.id, referenceType: 'DEVOLUCION', createdAt: { gt: md.createdAt } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  await prisma.product.update({ where: { id: P.id }, data: { costPrice: 6 } })
  check('>>> devolución parcial dañada: la entrada y la merma (2 filas) se valoran a 6 (costo de la venta, con el promedio en 7), EXACTO', parcial.length === 2 && parcial.every((m) => num(m.unitCostApplied) === 6 && num(m.costAfter) === 7 && m.costOrigin === 'EXACTO') && parcial[0]!.type === 'DEVOLUCION_CLIENTE' && parcial[1]!.type === 'MERMA')

  console.log('\nD) Merma, ajuste y entradas manuales')
  const sol = await solicitarMerma(db(AL), AL, solicitarMermaSchema.parse({ warehouseId: W, productId: P.id, quantity: 3, reason: 'Se cayó el rollo y quedó inservible' }))
  await resolverMerma(db(O), O, resolverMermaSchema.parse({ mermaId: sol.id, decision: 'APROBAR' }))
  const mm = await ultimo({ type: 'MERMA', source: 'CONTEO' })
  check('>>> la merma aprobada sale al promedio vigente (6), EXACTO', num(mm.unitCostApplied) === 6 && num(mm.costAfter) === 6 && mm.costOrigin === 'EXACTO')
  const fila = await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId: P.id, warehouseId: W } })
  await createStockMovement(db(O), O, createStockMovementSchema.parse({ productId: P.id, warehouseId: W, type: 'AJUSTE', quantity: 15, reason: 'Conteo físico del mes', expectedVersion: fila.version, source: 'MANUAL' }))
  const ma = await ultimo({ type: 'AJUSTE' })
  check('>>> el ajuste se valora al promedio vigente (6)', num(ma.unitCostApplied) === 6 && num(ma.costAfter) === 6 && ma.costOrigin === 'EXACTO')
  await createStockMovement(db(O), O, createStockMovementSchema.parse({ productId: P.id, warehouseId: W, type: 'ENTRADA', quantity: 5, unitCost: 9, source: 'MANUAL' }))
  const me = await ultimo({ type: 'ENTRADA', source: 'MANUAL' })
  check('>>> entrada manual con costo 9: se valora a 9 pero NO mueve el promedio (sigue 6), como hoy', num(me.unitCostApplied) === 9 && num(me.costAfter) === 6 && (await costoProducto()) === 6 && me.costPending === false)
  await createStockMovement(db(AL), AL, createStockMovementSchema.parse({ productId: P.id, warehouseId: W, type: 'ENTRADA', quantity: 2, source: 'MANUAL' }))
  const mp = await ultimo({ type: 'ENTRADA', source: 'MANUAL' })
  check('>>> entrada manual SIN costo (almacenero): sin valor aplicado (NULL), costo pendiente, promedio vigente 6', mp.unitCostApplied === null && num(mp.costAfter) === 6 && mp.costPending === true && mp.costOrigin === 'EXACTO')
  await completarCostoEntrada(db(O), O, mp.id, 8)
  const mp2 = await mov(mp.id)
  check('>>> al completarle el costo (8) se valora a 8; el promedio de su momento (6) no cambia', num(mp2.unitCostApplied) === 8 && num(mp2.unitCost) === 8 && num(mp2.costAfter) === 6 && mp2.costPending === false)

  // Una entrada con costo pendiente ANTERIOR al kardex valorizado (SIN_DATO): completarle el costo guarda el costo, pero no inventa un promedio.
  const antigua = await prisma.stockMovement.create({ data: { tenantId: t.id, productId: P.id, warehouseId: W, userId: AL.userId, type: 'ENTRADA', quantity: 1, balanceAfter: 1, costPending: true } })
  await completarCostoEntrada(db(O), O, antigua.id, 8.5)
  const antigua2 = await mov(antigua.id)
  check('>>> completar el costo de una entrada ANTERIOR al kardex (SIN_DATO) guarda su costo y sigue SIN_DATO, sin cifras de kardex (lo rellena el script)', num(antigua2.unitCost) === 8.5 && antigua2.costOrigin === 'SIN_DATO' && antigua2.unitCostApplied === null && antigua2.costAfter === null && antigua2.costPending === false)
  await prisma.stockMovement.delete({ where: { id: antigua.id } })

  console.log('\nE) Anulación de compra: sale al costo de la FACTURA y el promedio nuevo')
  const stockAntes = await stockTotal()
  const esperado = costoTrasDevolucion({ stock: stockAntes, costo: 6, cantidad: 10, valor: 70 })
  await anularCompra(db(O), O, anularCompraSchema.parse({ purchaseId: c2, motivo: 'Error de digitación' }))
  const mc = await ultimo({ type: 'DEVOLUCION_PROVEEDOR' })
  check('>>> la anulación sale valorada a 7 (el costo de la factura), con el promedio nuevo que calculó compras', num(mc.unitCostApplied) === 7 && esperado !== null && num(mc.costAfter) === esperado && (await costoProducto()) === esperado && mc.costOrigin === 'EXACTO' && mc.referenceId === c2, `esperado ${esperado}`)

  console.log('\nF) Transferencia, alta exprés y stock negativo')
  const tx = await db(O).$transaction(async (tr) => {
    const x = tr as unknown as TenantPrismaClient
    await applyStockMovement(x, O, { type: 'SALIDA', productId: P.id, warehouseId: W, quantity: 1, reason: 'Transferencia T001-1 a sucursal', source: 'MANUAL' } as never, 'TRANSFERENCIA', false, 'TRANSFERENCIA_SALIDA')
    await applyStockMovement(x, O, { type: 'ENTRADA', productId: P.id, warehouseId: b2.warehouse.id, quantity: 1, reason: 'Transferencia T001-1 recibida', source: 'MANUAL' } as never, 'TRANSFERENCIA', false, 'TRANSFERENCIA_ENTRADA')
    return true
  })
  const costoVig = await costoProducto()
  const ts = await ultimo({ type: 'TRANSFERENCIA_SALIDA' }), te = await ultimo({ type: 'TRANSFERENCIA_ENTRADA' })
  check('>>> las dos piernas de una transferencia se valoran al promedio vigente (la entrada NO queda como «costo pendiente»)', tx && num(ts.unitCostApplied) === costoVig && num(ts.costAfter) === costoVig && num(te.unitCostApplied) === costoVig && te.costPending === false && te.costOrigin === 'EXACTO')
  const ex = await createProductExpress(db(O), O, createProductExpressSchema.parse({ name: 'Silicona', salePrice: 12, costPrice: 4.5, initialStock: 10, warehouseId: W }))
  const mi = await prisma.stockMovement.findFirstOrThrow({ where: { tenantId: t.id, productId: ex.productId, type: 'INICIAL' } })
  check('>>> el alta exprés con costo 4.5: el stock inicial se valora a 4.5 y deja ese promedio, EXACTO', num(mi.unitCostApplied) === 4.5 && num(mi.costAfter) === 4.5 && mi.costOrigin === 'EXACTO')
  const ex0 = await createProductExpress(db(O), O, createProductExpressSchema.parse({ name: 'Clavos', salePrice: 1, initialStock: 10, warehouseId: W }))
  const mi0 = await prisma.stockMovement.findFirstOrThrow({ where: { tenantId: t.id, productId: ex0.productId, type: 'INICIAL' } })
  check('>>> el alta exprés SIN costo: valor aplicado NULL y promedio 0 (no se inventa un costo)', mi0.unitCostApplied === null && num(mi0.costAfter) === 0 && mi0.costOrigin === 'EXACTO')
  const Q = await prisma.product.create({ data: { tenantId: t.id, sku: 'K2', name: 'Tubo', unitType: 'UNIDAD', salePrice: 10, costPrice: 3 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: Q.id, warehouseId: W, quantity: 1 } })
  await registerSale(db(O), O, registerSaleSchema.parse({ warehouseId: W, items: [{ productId: Q.id, quantity: 3, discount: 0 }], payments: [{ method: 'EFECTIVO', amount: 30 }], documentType: 'NOTA_VENTA', allowNegativeStock: true, idempotencyKey: randomUUID() }) as never)
  const mn = await prisma.stockMovement.findFirstOrThrow({ where: { tenantId: t.id, productId: Q.id, source: 'VENTA' } })
  check('>>> vender con stock insuficiente (permitido): el stock queda en −2 y la salida se valora al promedio vigente (3); el promedio no cambia', Number(mn.balanceAfter) === -2 && num(mn.unitCostApplied) === 3 && num(mn.costAfter) === 3 && num((await prisma.product.findUniqueOrThrow({ where: { id: Q.id } })).costPrice) === 3)

  console.log('\nG) Invariantes y reglas de la base')
  const todos = await prisma.stockMovement.findMany({ where: { tenantId: t.id } })
  check('>>> TODO movimiento que escribió el sistema es EXACTO y trae el promedio (ninguno quedó SIN_DATO)', todos.length > 15 && todos.every((m) => m.costOrigin === 'EXACTO' && m.costAfter !== null), `${todos.length} movimientos`)
  check('>>> sólo las entradas con costo pendiente carecen de valor aplicado', todos.filter((m) => m.unitCostApplied === null).every((m) => m.costPending || (m.type === 'INICIAL' && num(m.costAfter) === 0)))
  const base = { tenantId: t.id, productId: P.id, warehouseId: W, userId: O.userId, type: 'ENTRADA' as const, quantity: 1, balanceAfter: 1 }
  const crear = (extra: Record<string, unknown>) => prisma.stockMovement.create({ data: { ...base, ...extra } as never })
  const porDefecto = await crear({})
  check('>>> un movimiento creado sin costo nace SIN_DATO, sin cifras', porDefecto.costOrigin === 'SIN_DATO' && porDefecto.costAfter === null && porDefecto.unitCostApplied === null)
  check('>>> la base rechaza SIN_DATO con cifras', await falla(crear({ costOrigin: 'SIN_DATO', costAfter: 3 })) && await falla(crear({ costOrigin: 'SIN_DATO', unitCostApplied: 3 })))
  check('>>> la base rechaza un dato conocido sin promedio (EXACTO / RECONSTRUIDO con costAfter NULL)', await falla(crear({ costOrigin: 'EXACTO' })) && await falla(crear({ costOrigin: 'RECONSTRUIDO', unitCostApplied: 2 })))
  check('>>> la base rechaza costos negativos', await falla(crear({ costOrigin: 'EXACTO', costAfter: -1 })) && await falla(crear({ costOrigin: 'EXACTO', costAfter: 1, unitCostApplied: -0.5 })))
  check('>>> y acepta un dato conocido con promedio 0', !(await falla(crear({ costOrigin: 'RECONSTRUIDO', costAfter: 0, unitCostApplied: 0 }))))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
