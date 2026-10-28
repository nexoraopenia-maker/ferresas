import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { cancelarConteo, cerrarConteo, crearConteo, iniciarConteo, registrarPasada } from '../src/features/inventory/conteo-service'
import { aplicarConteo, aprobarLinea, solicitarRecuento } from '../src/features/inventory/conteo-revision'
import { aplicarConteoSchema, aprobarLineaSchema, cancelarConteoSchema, cerrarConteoSchema, crearConteoSchema, iniciarConteoSchema, recontarLineaSchema, registrarPasadaSchema } from '../src/features/inventory/conteo-schemas'
import { createStockMovement } from '../src/features/inventory/stock-service'
import { createStockMovementSchema } from '../src/features/inventory/schemas'
import { kardexDeProducto } from '../src/features/inventory/kardex-service'
import { kardexSchema } from '../src/features/inventory/kardex-schemas'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.5b · Concurrencia de la aplicación de un conteo: ventas simultáneas MIENTRAS se aplica (el stock final es exactamente lo vendido más la diferencia y el libro cuadra),
 * dos aplicaciones a la vez (una sola gana y el stock se ajusta una vez), aprobar contra recontar, y varias tandas a la vez (cada línea se aplica una sola vez).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))
const res = async <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: { code?: string; message: string }) => ({ ok: false as const, code: e.code ?? 'ERR', message: e.message }))

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 500) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-cac-${randomUUID().slice(0, 6)}`, name: 'Conteo aplicación concurrencia', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cac' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const W = b1.warehouse.id
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ADMIN', 'ALMACENERO'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, x.id, b1.branch.id)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  }
  const O = u.OWNER!, AD = u.ADMIN!, AL = u.ALMACENERO!
  const db = (c: TenantContext) => getTenantPrisma(c)
  const ids: Record<string, string> = {}
  const producto = async (sku: string, stock: number) => {
    const p = await prisma.product.create({ data: { tenantId: t.id, sku, name: `Producto ${sku}`, unitType: 'UNIDAD', salePrice: 20, costPrice: 4 } })
    await createStockMovement(db(O), O, createStockMovementSchema.parse({ productId: p.id, warehouseId: W, type: 'ENTRADA', quantity: stock, unitCost: 4, source: 'MANUAL' }))
    ids[sku] = p.id
  }
  const vender = (sku: string) => registerSale(db(O), O, registerSaleSchema.parse({ warehouseId: W, items: [{ productId: ids[sku]!, quantity: 1, discount: 0 }], payments: [{ method: 'EFECTIVO', amount: 20 }], documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() }) as never)
  const conteoListo = async (skus: string[], contados: number[]) => {
    const c = await crearConteo(db(O), O, crearConteoSchema.parse({ warehouseId: W, scope: 'SELECCION', productIds: skus.map((s) => ids[s]!), idempotencyKey: randomUUID() }))
    await iniciarConteo(db(O), O, iniciarConteoSchema.parse({ countId: c.id }))
    await dormir(6)
    for (const [i, s] of skus.entries()) { await registrarPasada(db(AL), AL, registrarPasadaSchema.parse({ countId: c.id, productId: ids[s]!, quantity: contados[i]!, idempotencyKey: randomUUID() })); await dormir(4) }
    await cerrarConteo(db(O), O, cerrarConteoSchema.parse({ countId: c.id }))
    for (const s of skus) {
      const it = await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: c.id, productId: ids[s]! } })
      await aprobarLinea(db(AD), AD, aprobarLineaSchema.parse({ countId: c.id, itemId: it.id, confirmaUmbral: true }))
    }
    return c
  }
  const stockDe = async (sku: string) => num((await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId: ids[sku]!, warehouseId: W } })).quantity)
  const aplicar = (countId: string, lote?: number) => aplicarConteo(db(AD), AD, aplicarConteoSchema.parse({ countId }), lote ? { lote } : {})

  console.log('\nA) Diez ventas simultáneas MIENTRAS se aplica el conteo')
  for (const [ronda, retardo] of [[1, 0], [2, 35], [3, 80]] as const) {   // cuándo arranca la aplicación respecto de las ventas, que se reparten a lo largo de ~100 ms
    const sku = `V${ronda}`
    await producto(sku, 30)
    const c = await conteoListo([sku], [28])                       // el sistema decía 30: diferencia −2
    const ventas = Array.from({ length: 10 }, (_, i) => res((async () => { await dormir(i * 10); return vender(sku) })()))
    const aplicacion = res((async () => { await dormir(retardo); return aplicar(c.id) })())
    const [ap, ...vs] = await Promise.all([aplicacion, ...ventas])
    const hechas = vs.filter((v) => v.ok).length
    const fin = await stockDe(sku)
    const movs = await prisma.stockMovement.findMany({ where: { tenantId: t.id, productId: ids[sku]! }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const encadenado = movs.every((m, i) => i === 0 || Math.abs(num(m.balanceAfter) - (num(movs[i - 1]!.balanceAfter) + num(m.quantity))) < 1e-9)
    const k = await kardexDeProducto(db(AD), AD, kardexSchema.parse({ productId: ids[sku]!, limite: 200 }))
    check(`>>> (ronda ${ronda}: la aplicación arranca a los ${retardo} ms) la aplicación termina bien y las ${hechas} ventas que entraron se conservan: stock final = 30 − ${hechas} − 2`, ap.ok && fin === 30 - hechas - 2, `final ${fin}, ventas ${hechas}, ${vs.filter((v) => !v.ok).map((v) => (v as { code: string }).code).join() || 'sin fallos'}`)
    check(`>>> (ronda ${ronda}) el libro queda encadenado (cada saldo = el anterior + su cantidad), consistente y cuadrado con el stock`, encadenado && k.totales.consistente && k.totales.cuadraConStock === true && movs.filter((m) => m.referenceType === 'CONTEO').length === 1)
    console.log(`  (informativo) ronda ${ronda}: el ajuste quedó en el lugar ${movs.findIndex((m) => m.referenceType === 'CONTEO') + 1} de ${movs.length} movimientos del producto`)
    check(`>>> (ronda ${ronda}) el ajuste es de −2 aunque las ventas hayan entrado antes o después de él`, num(movs.find((m) => m.referenceType === 'CONTEO')!.quantity) === -2)
  }

  console.log('\nB) Dos aplicaciones a la vez')
  await producto('B1', 10)
  const cb = await conteoListo(['B1'], [12])
  const dos = await Promise.all([res(aplicar(cb.id)), res(aplicar(cb.id)), res(aplicar(cb.id))])
  check('>>> una sola aplica; las otras reciben que el conteo ya no está en revisión', dos.filter((r) => r.ok).length === 1 && dos.filter((r) => !r.ok).every((r) => (r as { code: string }).code === 'INVALID_DOCUMENT'), dos.map((r) => (r.ok ? 'ok' : r.code)).join())
  check('>>> el stock se ajustó UNA vez (10 → 12) y hay un solo movimiento del conteo', (await stockDe('B1')) === 12 && (await prisma.stockMovement.count({ where: { tenantId: t.id, referenceId: cb.id } })) === 1)

  console.log('\nC) Aprobar contra recontar, a la vez')
  await producto('C1', 10)
  const cc = await crearConteo(db(O), O, crearConteoSchema.parse({ warehouseId: W, scope: 'SELECCION', productIds: [ids.C1!], idempotencyKey: randomUUID() }))
  await iniciarConteo(db(O), O, iniciarConteoSchema.parse({ countId: cc.id }))
  await registrarPasada(db(AL), AL, registrarPasadaSchema.parse({ countId: cc.id, productId: ids.C1!, quantity: 11, idempotencyKey: randomUUID() }))
  await cerrarConteo(db(O), O, cerrarConteoSchema.parse({ countId: cc.id }))
  const itC = await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: cc.id } })
  const carrera = await Promise.all([
    res(aprobarLinea(db(AD), AD, aprobarLineaSchema.parse({ countId: cc.id, itemId: itC.id, confirmaUmbral: true }))),
    res(solicitarRecuento(db(AD), AD, recontarLineaSchema.parse({ countId: cc.id, itemId: itC.id, reason: 'Hay que volver a contar' }))),
  ])
  const filaC = await prisma.inventoryCountItem.findUniqueOrThrow({ where: { id: itC.id } })
  check('>>> el recuento siempre gana al final (si la aprobación entró primero se deshizo; si no, se rechazó): la línea queda RECONTAR y coherente', carrera[1].ok && filaC.status === 'RECONTAR' && filaC.reviewedAt === null && filaC.difference === null && filaC.countedQty === null)

  await cancelarConteo(db(O), O, cancelarConteoSchema.parse({ countId: cc.id, reason: 'Prueba de concurrencia' }))

  console.log('\nD) Varias tandas a la vez: cada línea se aplica una sola vez')
  for (const s of ['D1', 'D2', 'D3', 'D4']) await producto(s, 10)
  const cd = await conteoListo(['D1', 'D2', 'D3', 'D4'], [12, 12, 12, 12])
  const tandas = await Promise.all(Array.from({ length: 6 }, () => res(aplicar(cd.id, 1))))
  const movsD = await prisma.stockMovement.findMany({ where: { tenantId: t.id, referenceId: cd.id } })
  check('>>> exactamente 4 movimientos, uno por producto, aunque 6 tandas corrieran juntas', movsD.length === 4 && new Set(movsD.map((m) => m.productId)).size === 4 && (await Promise.all(['D1', 'D2', 'D3', 'D4'].map(stockDe))).every((x) => x === 12))
  check('>>> el conteo quedó APLICADO y las tandas que llegaron tarde recibieron un rechazo limpio (no un error raro)', (await prisma.inventoryCount.findUniqueOrThrow({ where: { id: cd.id } })).status === 'APLICADO' && tandas.filter((r) => !r.ok).every((r) => (r as { code: string }).code === 'INVALID_DOCUMENT') && tandas.filter((r) => r.ok).length >= 4, tandas.map((r) => (r.ok ? 'ok' : r.code)).join())

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
