import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { anularCompraSchema, crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { anularCompra, crearBorrador, recibirCompra } from '../src/features/compras/service'
import { completarCostoEntrada, createStockMovement } from '../src/features/inventory/stock-service'
import { createStockMovementSchema } from '../src/features/inventory/schemas'
import { resolverMerma, solicitarMerma } from '../src/features/inventory/merma-service'
import { resolverMermaSchema, solicitarMermaSchema } from '../src/features/inventory/merma-schemas'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { formatearInformeRelleno, rellenarCostoKardex } from '../src/features/inventory/kardex-relleno'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.4a · El rellenado histórico contra la base: se arma una historia REAL con los servicios (compras, ventas, merma, ajuste, entradas, anulación de
 * compra, un costo editado a mano), se guarda lo que el sistema escribió como «la verdad», se borra el costo de todos los movimientos (como estaban antes de
 * F6.4a) y se comprueba que el rellenado devuelve la verdad: EXACTO en las ventas, RECONSTRUIDO en el resto, con las mismas cifras. Además: simulación sin
 * escribir, idempotencia, lo ya escrito no se pisa y las ventas antiguas se enlazan con su venta.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const num = (d: { toString(): string } | null | undefined) => (d === null || d === undefined ? null : Number(d.toString()))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 500) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-krl-${randomUUID().slice(0, 6)}`, name: 'Kardex relleno', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_krl' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ALMACENERO'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, x.id, b1.branch.id)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  }
  const O = u.OWNER!, AL = u.ALMACENERO!
  const db = (c: TenantContext) => getTenantPrisma(c)
  const W = b1.warehouse.id
  const P = await prisma.product.create({ data: { tenantId: t.id, sku: 'R1', name: 'Cemento', unitType: 'UNIDAD', salePrice: 20, costPrice: 0 } })
  const R = await prisma.product.create({ data: { tenantId: t.id, sku: 'R2', name: 'Pintura', unitType: 'UNIDAD', salePrice: 30, costPrice: 0 } })
  const comprar = async (productId: string, cantidad: number, costo: number) => {
    const b = await crearBorrador(db(O), O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: W, items: [{ productId, enteredQuantity: cantidad, unitCost: costo }] }))
    await recibirCompra(db(O), O, recibirCompraSchema.parse({ purchaseId: b.id }))
    return b.id
  }
  const vender = (productId: string, quantity: number, monto: number) =>
    registerSale(db(O), O, registerSaleSchema.parse({ warehouseId: W, items: [{ productId, quantity, discount: 0 }], payments: [{ method: 'EFECTIVO', amount: monto }], documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() }) as never)

  // ─── La historia real ────────────────────────────────────────────────────────────────────────────────────────────
  await comprar(P.id, 10, 5)
  const c2 = await comprar(P.id, 10, 7)
  await vender(P.id, 4, 80)
  const sol = await solicitarMerma(db(AL), AL, solicitarMermaSchema.parse({ warehouseId: W, productId: P.id, quantity: 3, reason: 'Se cayó el rollo y quedó inservible' }))
  await resolverMerma(db(O), O, resolverMermaSchema.parse({ mermaId: sol.id, decision: 'APROBAR' }))
  const fila = await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId: P.id, warehouseId: W } })
  await createStockMovement(db(O), O, createStockMovementSchema.parse({ productId: P.id, warehouseId: W, type: 'AJUSTE', quantity: 15, reason: 'Conteo físico del mes', expectedVersion: fila.version, source: 'MANUAL' }))
  await createStockMovement(db(O), O, createStockMovementSchema.parse({ productId: P.id, warehouseId: W, type: 'ENTRADA', quantity: 5, unitCost: 9, source: 'MANUAL' }))
  await createStockMovement(db(AL), AL, createStockMovementSchema.parse({ productId: P.id, warehouseId: W, type: 'ENTRADA', quantity: 2, source: 'MANUAL' }))
  const pend = await prisma.stockMovement.findFirstOrThrow({ where: { tenantId: t.id, productId: P.id, costPending: true } })
  await completarCostoEntrada(db(O), O, pend.id, 8)
  await anularCompra(db(O), O, anularCompraSchema.parse({ purchaseId: c2, motivo: 'Error de digitación' }))
  // Una salida MANUAL cuyo motivo se parece a «Venta …» no es una venta: no ancla ni se enlaza con ella.
  const numeroVenta = (await prisma.sale.findFirstOrThrow({ where: { tenantId: t.id, items: { some: { productId: P.id } } }, orderBy: { createdAt: 'asc' } })).number
  await createStockMovement(db(O), O, createStockMovementSchema.parse({ productId: P.id, warehouseId: W, type: 'SALIDA', quantity: 1, reason: `Venta ${numeroVenta} (anotada a mano)`, source: 'MANUAL' }))
  // Producto R: el costo se EDITA A MANO entre dos ventas; la venta posterior guarda el costo real y ancla la reconstrucción.
  await comprar(R.id, 10, 5)
  await vender(R.id, 2, 60)
  await prisma.product.update({ where: { id: R.id }, data: { costPrice: 8 } })
  await vender(R.id, 2, 60)
  await comprar(R.id, 10, 10)
  await vender(R.id, 1, 30)

  const todosAntes = await prisma.stockMovement.findMany({ where: { tenantId: t.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const verdad = new Map(todosAntes.map((m) => [m.id, { unitCostApplied: num(m.unitCostApplied), costAfter: num(m.costAfter), source: m.source, type: m.type, saleId: m.referenceType === 'VENTA' ? m.referenceId : null }]))
  check('(preparación) la historia tiene al menos 13 movimientos y todos nacieron EXACTO', todosAntes.length >= 13 && todosAntes.every((m) => m.costOrigin === 'EXACTO'), `${todosAntes.length}`)
  const cr = num((await prisma.product.findUniqueOrThrow({ where: { id: R.id } })).costPrice)!
  check('(preparación) la edición manual del costo (5 → 8) y la compra posterior dejaron un promedio coherente', cr > 8 && cr < 10, `costo final ${cr}`)

  // ─── Antes de F6.4a: sin costo, y las ventas sin enlace ──────────────────────────────────────────────────────────────
  await prisma.$executeRawUnsafe(`UPDATE stock_movements SET "costOrigin"='SIN_DATO', "costAfter"=NULL, "unitCostApplied"=NULL WHERE "tenantId"='${t.id}'`)
  await prisma.$executeRawUnsafe(`UPDATE stock_movements SET "referenceType"='MANUAL', "referenceId"=NULL WHERE "tenantId"='${t.id}' AND source='VENTA' AND type='SALIDA'`)
  const sc = getTenantPrisma({ tenantId: t.id, userId: 'script-relleno', role: 'SUPERADMIN', access: 'FULL' })

  console.log('\nA) Simulación: cuenta pero no escribe')
  const sim = await rellenarCostoKardex(sc, { aplicar: false })
  const tras1 = await prisma.stockMovement.count({ where: { tenantId: t.id, costOrigin: 'SIN_DATO' } })
  check('>>> la simulación examina todos los movimientos, informa por marca y NO escribe nada', sim.aplicado === false && sim.examinados === todosAntes.length && tras1 === todosAntes.length && sim.productos === 2 && sim.resultado.EXACTO + sim.resultado.RECONSTRUIDO + sim.resultado.SIN_DATO === sim.examinados)
  check('>>> la simulación no enlaza ventas (sólo las cuenta)', sim.ventasEnlazadas === 4 && (await prisma.stockMovement.count({ where: { tenantId: t.id, referenceType: 'VENTA' } })) === 0)

  console.log('\nB) Aplicar: devuelve la verdad')
  const ap = await rellenarCostoKardex(sc, { aplicar: true })
  const despues = await prisma.stockMovement.findMany({ where: { tenantId: t.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const distintos = despues.filter((m) => { const v = verdad.get(m.id)!; return num(m.costAfter) !== v.costAfter || num(m.unitCostApplied) !== v.unitCostApplied })
  check('>>> TODOS los movimientos recuperan exactamente el costo aplicado y el promedio que escribió el sistema', despues.length === todosAntes.length && distintos.length === 0, distintos.map((m) => `${m.type}:${num(m.costAfter)}≠${verdad.get(m.id)!.costAfter}`).join(' ').slice(0, 300))
  const ventas = despues.filter((m) => m.source === 'VENTA' && m.type === 'SALIDA')
  check('>>> las ventas salen EXACTO (su costo es el real que guardó la línea) y todo lo demás RECONSTRUIDO', ventas.length === 4 && ventas.every((m) => m.costOrigin === 'EXACTO') && despues.filter((m) => !(m.source === 'VENTA' && m.type === 'SALIDA')).every((m) => m.costOrigin === 'RECONSTRUIDO'))
  const manual = despues.find((m) => m.reason?.includes('anotada a mano'))!
  check('>>> una salida manual que dice «Venta …» NO se toma por venta: queda RECONSTRUIDO, sin enlace', manual.source === 'MANUAL' && manual.costOrigin === 'RECONSTRUIDO' && manual.referenceType !== 'VENTA')
  check('>>> el informe cuadra con lo escrito', ap.resultado.EXACTO === 4 && ap.resultado.RECONSTRUIDO === despues.length - 4 && ap.resultado.SIN_DATO === 0 && ap.aplicado === true)
  check('>>> las ventas antiguas se enlazan con SU venta (el mismo id que escribe el sistema hoy)', ventas.every((m) => m.referenceType === 'VENTA' && m.referenceId === verdad.get(m.id)!.saleId) && ap.ventasEnlazadas === 4)
  check('>>> la edición manual del costo de R (5 → 8) no rompe nada: la venta posterior la ancla y la compra siguiente promedia desde ahí', num((await prisma.stockMovement.findFirstOrThrow({ where: { tenantId: t.id, productId: R.id, source: 'VENTA' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })).costAfter) === cr)
  check('>>> el informe se imprime con el nombre del negocio y el modo', formatearInformeRelleno('x', ap).includes('APLICADO') && formatearInformeRelleno('x', sim).includes('SIMULACIÓN'))

  console.log('\nC) Idempotencia y respeto de lo ya escrito')
  const otra = await rellenarCostoKardex(sc, { aplicar: true })
  const despues2 = await prisma.stockMovement.findMany({ where: { tenantId: t.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  check('>>> una segunda corrida no tiene nada que hacer y no cambia ni una fila', otra.productos === 0 && otra.examinados === 0 && JSON.stringify(despues2.map((m) => [m.id, num(m.costAfter), num(m.unitCostApplied), m.costOrigin])) === JSON.stringify(despues.map((m) => [m.id, num(m.costAfter), num(m.unitCostApplied), m.costOrigin])))
  // Un movimiento NUEVO (EXACTO) después de rellenar, y otro histórico vuelto a SIN_DATO: sólo se toca el segundo.
  await vender(P.id, 1, 20)
  const nuevo = await prisma.stockMovement.findFirstOrThrow({ where: { tenantId: t.id, productId: P.id, source: 'VENTA' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const viejo = despues.find((m) => m.productId === P.id && m.type === 'AJUSTE')!
  await prisma.$executeRawUnsafe(`UPDATE stock_movements SET "costOrigin"='SIN_DATO', "costAfter"=NULL, "unitCostApplied"=NULL WHERE id='${viejo.id}'`)
  const otra2 = await rellenarCostoKardex(sc, { aplicar: true })
  const n2 = await prisma.stockMovement.findUniqueOrThrow({ where: { id: nuevo.id } }), v2 = await prisma.stockMovement.findUniqueOrThrow({ where: { id: viejo.id } })
  check('>>> el movimiento nuevo (EXACTO) no se toca; el histórico vuelto a SIN_DATO se recupera', otra2.examinados === 1 && n2.costOrigin === 'EXACTO' && JSON.stringify([num(n2.costAfter), num(n2.unitCostApplied)]) === JSON.stringify([num(nuevo.costAfter), num(nuevo.unitCostApplied)]) && v2.costOrigin === 'RECONSTRUIDO' && num(v2.costAfter) === verdad.get(viejo.id)!.costAfter)

  console.log('\nD) Otros negocios y movimientos sin costo posible')
  const t2 = await prisma.tenant.create({ data: { slug: `rp-krl2-${randomUUID().slice(0, 6)}`, name: 'Otro', taxId: ruc(), planId: plan.id } })
  const b2 = await crearSucursalConAlmacen(t2.id)
  const u2 = await prisma.user.create({ data: { tenantId: t2.id, email: `o-${randomUUID()}@x.com`.toLowerCase(), name: 'O', role: 'OWNER' } })
  const p2 = await prisma.product.create({ data: { tenantId: t2.id, sku: 'X', name: 'X', unitType: 'UNIDAD', salePrice: 1, costPrice: 0 } })
  await prisma.stockMovement.create({ data: { tenantId: t2.id, productId: p2.id, warehouseId: b2.warehouse.id, userId: u2.id, type: 'ENTRADA', quantity: 5, balanceAfter: 5, costPending: true } })
  const r2 = await rellenarCostoKardex(getTenantPrisma({ tenantId: t2.id, userId: 's', role: 'SUPERADMIN', access: 'FULL' }), { aplicar: true })
  const m2 = await prisma.stockMovement.findFirstOrThrow({ where: { tenantId: t2.id } })
  check('>>> una entrada sin costo y sin compras queda SIN_DATO (sin cifras inventadas) y el informe lo cuenta', r2.resultado.SIN_DATO === 1 && m2.costOrigin === 'SIN_DATO' && m2.costAfter === null && m2.unitCostApplied === null)
  const r1b = await rellenarCostoKardex(sc, { aplicar: true })
  check('>>> correr un negocio no toca los movimientos de otro (aislamiento por negocio)', r1b.examinados === 0 && (await prisma.stockMovement.findFirstOrThrow({ where: { tenantId: t2.id } })).costOrigin === 'SIN_DATO')

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
