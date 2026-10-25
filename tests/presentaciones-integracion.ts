import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { createStockMovement } from '../src/features/inventory/stock-service'
import { createStockMovementSchema } from '../src/features/inventory/schemas'
import { issueTaxDocument } from '../src/features/invoicing/service'
import { cargarComprobanteFiscal } from '../src/features/invoicing/envio'
import { crearPresentacion } from '../src/features/inventory/presentaciones-service'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Paso 3: las ventas y los movimientos de stock escriben la presentación. Lo que se verifica: el servidor RECALCULA (no cree al
 * cliente), la base valida `quantity = enteredQuantity × presentationFactor`, el precio y el total salen de la presentación, y
 * el stock físico sigue moviéndose SOLO en la unidad base.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const lanza = async (f: () => unknown) => { try { await f(); return null } catch (e) { return e as Error & { code?: string } } }
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: { slug: `cod-int-${randomUUID().slice(0, 6)}`, name: 'Integración', legalName: 'INTEGRACION SAC', taxId, planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_int' } })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const mk = (role: 'OWNER' | 'ALMACENERO') => prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`, name: role, role } })
  const owner = await mk('OWNER'), alm = await mk('ALMACENERO')
  await asignarSucursal(t.id, owner.id, branch.id); await asignarSucursal(t.id, alm.id, branch.id)
  const ctx: TenantContext = { tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
  const ctxAlm: TenantContext = { ...ctx, userId: alm.id, role: 'ALMACENERO' }
  const db = getTenantPrisma(ctx), dbAlm = getTenantPrisma(ctxAlm)

  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'CLAVO', name: 'Clavo 2"', unitType: 'UNIDAD', salePrice: 11.8, costPrice: 6 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: w.id, quantity: 100, minStock: 2 } })
  const caja = await crearPresentacion(db, ctx, { productId: prod.id, name: 'Caja x 12', unitType: 'CAJA', factor: '12', salePrice: '118' })
  const docena = await crearPresentacion(db, ctx, { productId: prod.id, name: 'Docena sin precio', unitType: 'DOCENA', factor: '12' })
  const stockActual = async () => num((await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId: prod.id, variantId: null, warehouseId: w.id } })).quantity)
  const venta = (items: unknown[], pago = 5000, extra: Record<string, unknown> = {}) =>
    registerSale(db, ctx, registerSaleSchema.parse({ warehouseId: w.id, items, payments: [{ method: 'EFECTIVO', amount: pago }], idempotencyKey: randomUUID(), ...extra }))
  const itemsDe = (saleId: string) => prisma.saleItem.findMany({ where: { saleId }, orderBy: { createdAt: 'asc' } })

  console.log('\n1) Venta con una presentación de precio propio')
  const v1 = await venta([{ productId: prod.id, quantity: 36, presentationId: caja.id, enteredQuantity: '3' }])
  const [l1] = await itemsDe(v1.saleId)
  check('>>> 3 cajas × S/ 118 = S/ 354.00: el total sale del precio de la presentación × lo ingresado', num(l1!.lineTotal) === 354 && num((await prisma.sale.findUniqueOrThrow({ where: { id: v1.saleId } })).total) === 354)
  check('>>> la línea guarda la cantidad BASE (36) y la trazabilidad (3 cajas, factor 12, nombre)', num(l1!.quantity) === 36 && l1!.presentationId === caja.id && num(l1!.enteredQuantity) === 3 && num(l1!.presentationFactor) === 12 && l1!.presentationName === 'Caja x 12')
  check('el precio por unidad base es el derivado (118 ÷ 12 = 9.8333), no el de lista', num(l1!.unitPrice) === 9.8333)
  check('>>> el stock físico bajó en UNIDAD BASE: 100 → 64', (await stockActual()) === 64)
  const m1 = await prisma.stockMovement.findFirstOrThrow({ where: { tenantId: t.id, type: 'SALIDA', presentationId: caja.id, quantity: -36 } })
  check('>>> el movimiento de la venta: -36 base, -3 cajas × 12, con signo de salida', num(m1.quantity) === -36 && num(m1.enteredQuantity) === -3 && num(m1.presentationFactor) === 12)
  const s1 = await prisma.sale.findUniqueOrThrow({ where: { id: v1.saleId } })
  check('>>> Σ líneas = subtotal + IGV = total, exacto (el invariante de siempre)', Math.abs(num(l1!.lineTotal) - (num(s1.subtotal) + num(s1.taxTotal))) < 0.0001 && num(s1.subtotal) === 300 && num(s1.taxTotal) === 54)

  console.log('\n2) Presentación SIN precio propio: manda base × cantidad base')
  const v2 = await venta([{ productId: prod.id, quantity: 24, presentationId: docena.id, enteredQuantity: '2' }])
  const [l2] = await itemsDe(v2.saleId)
  check('>>> 2 docenas = 24 unidades × S/ 11.80 = S/ 283.20; con su trazabilidad', num(l2!.lineTotal) === 283.2 && num(l2!.unitPrice) === 11.8 && l2!.presentationName === 'Docena sin precio' && num(l2!.enteredQuantity) === 2 && (await stockActual()) === 40)

  console.log('\n3) Líneas mezcladas, descuento y cantidades fraccionadas')
  const v3 = await venta([
    { productId: prod.id, quantity: 12, presentationId: caja.id, enteredQuantity: 1, discount: 18 },
    { productId: prod.id, quantity: 5 },
  ])
  const ls3 = await itemsDe(v3.saleId)
  check('>>> una caja y 5 sueltas del MISMO producto en una venta: dos líneas, una con presentación y otra sin', ls3.length === 2 && ls3.filter((l) => l.presentationId).length === 1 && ls3.filter((l) => !l.presentationId && l.enteredQuantity === null && l.presentationFactor === null).length === 1)
  check('>>> el descuento se resta del total de la línea de la caja (118 − 18 = 100); la suelta cobra 5 × 11.80 = 59', num(ls3.find((l) => l.presentationId)!.lineTotal) === 100 && num(ls3.find((l) => !l.presentationId)!.lineTotal) === 59)
  check('el stock bajó 12 + 5 = 17: 40 → 23', (await stockActual()) === 23)

  console.log('\n4) El servidor NO cree al cliente')
  const antes = { ventas: await prisma.sale.count({ where: { tenantId: t.id } }), stock: await stockActual(), mov: await prisma.stockMovement.count({ where: { tenantId: t.id } }) }
  const rechaza = async (items: unknown[], codigo = 'INVALID_DOCUMENT') => (await lanza(() => venta(items)))?.code === codigo
  check('>>> cantidad base que NO es lo ingresado × factor (35 ≠ 3 × 12) → rechazada', await rechaza([{ productId: prod.id, quantity: 35, presentationId: caja.id, enteredQuantity: '3' }]))
  check('>>> 2,5 cajas (la caja es entera) → rechazada', await rechaza([{ productId: prod.id, quantity: 30, presentationId: caja.id, enteredQuantity: '2.5' }]))
  check('>>> presentación de OTRO producto → rechazada', await (async () => { const otro = await prisma.product.create({ data: { tenantId: t.id, sku: 'OTRO', name: 'Otro', salePrice: 5 } }); return rechaza([{ productId: otro.id, quantity: 12, presentationId: caja.id, enteredQuantity: '1' }], 'TENANT_MISMATCH') })())
  check('>>> presentación inexistente o de otro negocio → rechazada', await rechaza([{ productId: prod.id, quantity: 12, presentationId: 'no-existe', enteredQuantity: '1' }], 'TENANT_MISMATCH'))
  check('>>> una línea con variante REAL y presentación → rechazada', await (async () => { const vr = await prisma.productVariant.create({ data: { tenantId: t.id, productId: prod.id, sku: 'CLAVO-V', name: 'Variante' } }); return rechaza([{ productId: prod.id, variantId: vr.id, quantity: 12, presentationId: caja.id, enteredQuantity: '1' }]) })())
  check('>>> presentación sin cantidad ingresada (o al revés) → el esquema la rechaza', !registerSaleSchema.safeParse({ warehouseId: 'w', items: [{ productId: 'p', quantity: 12, presentationId: 'x' }], payments: [{ method: 'EFECTIVO', amount: 1 }] }).success && !registerSaleSchema.safeParse({ warehouseId: 'w', items: [{ productId: 'p', quantity: 12, enteredQuantity: '1' }], payments: [{ method: 'EFECTIVO', amount: 1 }] }).success)
  check('>>> NADA se escribió con esos rechazos: ni venta, ni stock, ni movimientos', (await prisma.sale.count({ where: { tenantId: t.id } })) === antes.ventas && (await stockActual()) === antes.stock && (await prisma.stockMovement.count({ where: { tenantId: t.id } })) === antes.mov)
  await prisma.productPresentation.update({ where: { id: docena.id }, data: { isActive: false } })
  check('>>> una presentación DESACTIVADA ya no se vende', await rechaza([{ productId: prod.id, quantity: 12, presentationId: docena.id, enteredQuantity: '1' }], 'TENANT_MISMATCH'))
  await prisma.productPresentation.update({ where: { id: docena.id }, data: { isActive: true } })
  await prisma.productPresentation.update({ where: { id: caja.id }, data: { salePrice: '99' } })
  const v4 = await venta([{ productId: prod.id, quantity: 12, presentationId: caja.id, enteredQuantity: '1' }])
  check('>>> el precio es el de la BASE al cobrar (cambió de 118 a 99): el cliente no lo decide ni lo recuerda', num((await itemsDe(v4.saleId))[0]!.lineTotal) === 99)
  await prisma.productPresentation.update({ where: { id: caja.id }, data: { salePrice: '118' } })

  console.log('\n5) El comprobante electrónico no cambia de significado')
  await prisma.branch.update({ where: { id: branch.id }, data: { address: 'Av. Prueba 123, Lima', ubigeo: '150101' } })
  const doc = await issueTaxDocument(db, ctx, { saleId: v1.saleId, documentType: 'BOLETA' } as never)
  const { comprobante } = await cargarComprobanteFiscal(db, doc.id)
  check('>>> el comprobante de la venta con cajas cuadra: una línea de 36 unidades por S/ 354 y total S/ 354', comprobante.total === 354 && comprobante.lineas.length === 1 && comprobante.lineas[0]!.cantidad === 36 && comprobante.lineas[0]!.importeTotal === 354)

  console.log('\n6) Ingreso y salida de stock por presentación')
  const mov = (o: Record<string, unknown>, dbX = db, cx = ctx) => createStockMovement(dbX, cx, createStockMovementSchema.parse({ productId: prod.id, warehouseId: w.id, ...o }))
  const s0 = await stockActual()
  const clave = randomUUID()
  const e1 = await mov({ type: 'ENTRADA', quantity: 60, presentationId: caja.id, enteredQuantity: '5', idempotencyKey: clave })
  const me = await prisma.stockMovement.findFirstOrThrow({ where: { id: e1.movementId } })
  check('>>> ingresar 5 cajas de 12: el stock sube 60 en BASE y el movimiento guarda 5 × 12', (await stockActual()) === s0 + 60 && num(me.quantity) === 60 && num(me.enteredQuantity) === 5 && num(me.presentationFactor) === 12 && me.presentationId === caja.id)
  const rep = await mov({ type: 'ENTRADA', quantity: 60, presentationId: caja.id, enteredQuantity: '5', idempotencyKey: clave })
  check('>>> el mismo envío repetido (red lenta) NO duplica el ingreso: idempotente', rep.replayed === true && (await stockActual()) === s0 + 60 && (await prisma.stockMovement.count({ where: { tenantId: t.id, idempotencyKey: clave } })) === 1)
  const alm1 = await mov({ type: 'ENTRADA', quantity: 24, presentationId: caja.id, enteredQuantity: '2' }, dbAlm, ctxAlm)
  check('>>> el almacenero (stock.entrada) ingresa cajas; la entrada queda «costo pendiente» como siempre', (await prisma.stockMovement.findFirstOrThrow({ where: { id: alm1.movementId } })).costPending === true && (await stockActual()) === s0 + 84)
  const sal = await mov({ type: 'SALIDA', quantity: 24, presentationId: caja.id, enteredQuantity: '2' })
  const ms = await prisma.stockMovement.findFirstOrThrow({ where: { id: sal.movementId } })
  check('>>> una salida de 2 cajas: -24 base y -2 cajas (con signo)', num(ms.quantity) === -24 && num(ms.enteredQuantity) === -2 && (await stockActual()) === s0 + 60)
  const sBefore = await stockActual(), nBefore = await prisma.stockMovement.count({ where: { tenantId: t.id } })
  check('>>> cantidad que no cuadra con la presentación → rechazada sin tocar nada', (await lanza(() => mov({ type: 'ENTRADA', quantity: 59, presentationId: caja.id, enteredQuantity: '5' })))?.code === 'INVALID_DOCUMENT' && (await stockActual()) === sBefore && (await prisma.stockMovement.count({ where: { tenantId: t.id } })) === nBefore)
  check('>>> el esquema: presentación sin cantidad ingresada, y al revés, se rechaza; un AJUSTE ignora las presentaciones', !createStockMovementSchema.safeParse({ productId: 'p', warehouseId: 'w', type: 'ENTRADA', quantity: 12, presentationId: 'x' }).success && !createStockMovementSchema.safeParse({ productId: 'p', warehouseId: 'w', type: 'ENTRADA', quantity: 12, enteredQuantity: '1' }).success)
  const ajuste = createStockMovementSchema.safeParse({ productId: 'p', warehouseId: 'w', type: 'AJUSTE', quantity: 10, reason: 'conteo físico', expectedVersion: 0, presentationId: 'x', enteredQuantity: '1' })
  check('(un AJUSTE es un conteo absoluto: no lleva presentación)', ajuste.success && !('presentationId' in (ajuste.data as object)))

  console.log('\n7) El stock físico solo se mueve en la unidad base')
  const suma = await prisma.stockMovement.aggregate({ where: { tenantId: t.id, productId: prod.id }, _sum: { quantity: true } })
  check('>>> la suma de los movimientos (en base) + el inicial = el stock actual: el libro cuadra con presentaciones de por medio', num(suma._sum.quantity) + 100 === (await stockActual()))
  check('>>> las columnas de presentación no participan en ningún cálculo de stock (el stock no las tiene)', !('enteredQuantity' in (await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId: prod.id } }))))

  console.log('\n8) Estructura')
  const venta_ = readFileSync('src/features/pos/sale-service.ts', 'utf8')
  check('>>> la venta recalcula la presentación con la matemática de conversion.ts (no con sus propias cuentas)', venta_.includes('resolverLineaDeVenta(') && venta_.includes('cargarPresentaciones('))
  check('>>> el movimiento de stock pasa la traza SIN cambiar la cantidad que mueve el stock', readFileSync('src/features/inventory/stock-service.ts', 'utf8').includes('...(input.traza') && venta_.includes('traza: l.traza'))
  check('el POS y el inventario exponen la presentación escaneada', readFileSync('src/features/pos/actions.ts', 'utf8').includes('presentation: r.presentacion') && readFileSync('src/features/inventory/actions.ts', 'utf8').includes('presentation: r.presentacion'))
  check('(las compras: PurchaseItem tiene las columnas, pero no existe aún un servicio de compras que las escriba)', true)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
