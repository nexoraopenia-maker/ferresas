import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { redondearCentimos as cent } from '../src/lib/dinero'
import { crearSucursalConAlmacen, asignarSucursal, abrirTurno } from './fixtures'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { crearPresentacion } from '../src/features/inventory/presentaciones-service'
import { brutoDe, conContada, descuentoDe, itemDe, mismaLinea, type LineaCarrito } from '../src/features/pos/carrito'
import type { PosProduct } from '../src/features/pos/actions'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Pantallas del Paso 3. La matemática del carrito (`carrito.ts`) es la que muestra el total al cajero; la del servidor la que
 * cobra. Aquí se comprueba que dan EXACTAMENTE lo mismo y que lo que envía el carrito es lo que el servidor acepta.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `pan-${randomUUID().slice(0, 6)}`, name: 'Pantallas', legalName: 'PANTALLAS SAC', taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_pan' } })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const owner = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'o', role: 'OWNER' } })
  await asignarSucursal(t.id, owner.id, branch.id)
  const ctx: TenantContext = { tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
  await abrirTurno(t.id, owner.id, branch.id)
  const db = getTenantPrisma(ctx)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'TUB', name: 'Tubo', unitType: 'UNIDAD', salePrice: 7.35, costPrice: 3 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: w.id, quantity: 100000, minStock: 0 } })

  const posProd = (pr?: PosProduct['presentation']): PosProduct => ({
    productId: prod.id, variantId: null, name: 'Tubo', sku: 'TUB', barcode: null, qrCode: null, unitType: 'UNIDAD', salePrice: 7.35, taxRate: 0.18,
    trackStock: true, stock: 100000, minStock: 0, stockStatus: 'OK', warehouseId: w.id, warehouseName: 'A', presentation: pr ?? null,
  } as PosProduct)
  const linea = (pr: PosProduct['presentation'], contada: number, pct = 0): LineaCarrito => {
    const p = posProd(pr)
    const base: LineaCarrito = pr
      ? { key: 'k', producto: p, presentacion: { id: pr.id, name: pr.name, unitType: pr.unitType, factor: Number(pr.factor), precio: Number(pr.precio), precioPropio: pr.precioPropio }, ingresada: 1, quantity: Number(pr.factor), discount: 0, pct }
      : { key: 'k', producto: p, quantity: 1, discount: 0, pct }
    return conContada(base, contada)
  }

  console.log('\n1) El total que ve el cajero = el total que cobra el servidor')
  const casos = [
    { f: '12', precio: '88.40', contada: 3, pct: 0 },
    { f: '12', precio: '88.40', contada: 7, pct: 10 },
    { f: '25', precio: '161.35', contada: 2, pct: 5 },
    { f: '4', precio: '47.99', contada: 9, pct: 0 },
    { f: '10', precio: null, contada: 4, pct: 7.5 },
    { f: '3', precio: '21.10', contada: 33, pct: 15 },
  ]
  let i = 0
  for (const c of casos) {
    const pres = await crearPresentacion(db, ctx, { productId: prod.id, name: `P${i}`, unitType: 'CAJA', factor: c.f, ...(c.precio ? { salePrice: c.precio } : {}) })
    const info: NonNullable<PosProduct['presentation']> = { id: pres.id, name: `P${i++}`, unitType: 'CAJA', factor: c.f, precio: c.precio ?? (7.35 * Number(c.f)).toFixed(2), precioPropio: c.precio != null }
    const l = linea(info, c.contada, c.pct)
    const clienteTotal = cent(brutoDe(l) - l.discount)
    const r = await registerSale(db, ctx, registerSaleSchema.parse({ warehouseId: w.id, items: [itemDe(l)], payments: [{ method: 'EFECTIVO', amount: 100000 }], idempotencyKey: randomUUID() }))
    const venta = await prisma.sale.findUniqueOrThrow({ where: { id: r.saleId } })
    check(`>>> ${c.contada} × caja x${c.f} ${c.precio ? `a S/ ${c.precio}` : '(sin precio propio)'} con ${c.pct}% → pantalla ${clienteTotal.toFixed(2)} = cobro ${Number(venta.total).toFixed(2)}`, Math.abs(clienteTotal - Number(venta.total)) < 1e-9)
  }
  const sueltas = linea(null, 5, 10)
  const rs = await registerSale(db, ctx, registerSaleSchema.parse({ warehouseId: w.id, items: [itemDe(sueltas)], payments: [{ method: 'EFECTIVO', amount: 1000 }], idempotencyKey: randomUUID() }))
  check('>>> una línea suelta (sin presentación) sigue cuadrando y no envía campos de presentación', cent(brutoDe(sueltas) - sueltas.discount) === Number((await prisma.sale.findUniqueOrThrow({ where: { id: rs.saleId } })).total) && !('presentationId' in itemDe(sueltas)))

  console.log('\n2) Comportamiento del carrito')
  const info: NonNullable<PosProduct['presentation']> = { id: 'x', name: 'Caja x 12', unitType: 'CAJA', factor: '12', precio: '88.40', precioPropio: true }
  const l1 = linea(info, 3)
  check('>>> 3 cajas de 12 = 36 en base, y la línea envía presentationId + enteredQuantity "3" + quantity 36', l1.quantity === 36 && itemDe(l1).presentationId === 'x' && itemDe(l1).enteredQuantity === '3' && itemDe(l1).quantity === 36)
  check('>>> sumar una caja más suma 12 en base (no 1)', conContada(l1, 4).quantity === 48)
  check('>>> la misma caja se junta en una línea; la suelta del mismo producto NO se junta con la caja', mismaLinea(l1, posProd(info)) && !mismaLinea(l1, posProd(null)) && !mismaLinea(linea(null, 1), posProd(info)))
  const conDcto = conContada({ ...l1, pct: 10 }, 3)
  check('>>> el descuento en % se recalcula sobre el importe de la presentación (10% de 265.20)', conDcto.discount === descuentoDe(conDcto) && conDcto.discount === 26.52)
  check('>>> sin precio propio el importe es base × cantidad base (3 cajas de 10 × 7.35 = 220.50)', brutoDe(linea({ id: 'y', name: 'Caja x 10', unitType: 'CAJA', factor: '10', precio: '73.50', precioPropio: false }, 3)) === 220.5)

  console.log('\n3) Estructura de las pantallas')
  const pos = readFileSync('src/features/pos/components/PosTerminal.tsx', 'utf8')
  const hoja = readFileSync('src/features/inventory/components/ScanToStockSheet.tsx', 'utf8')
  check('>>> el POS arma las líneas del cobro con itemDe (una sola fuente de lo que se envía)', pos.includes('items: carrito.map(itemDe)') && pos.includes("from '../carrito'"))
  check('>>> cotizaciones y pedidos a caja se bloquean con presentaciones (siguen en unidad base)', (pos.match(/carrito\.some\(\(l\) => l\.presentacion\)/g) ?? []).length === 2)
  check('>>> la hoja de ingresos envía presentationId + enteredQuantity y la cantidad base solo para ENTRADA/SALIDA', hoja.includes('presentationId: p.presentation.id, enteredQuantity: String(qty)') && hoja.includes('type: \'AJUSTE\'') && !/AJUSTE[\s\S]{0,400}presentationId[\s\S]{0,40}reason: reason,/.test(hoja))
  check('(el AJUSTE no lleva presentación: es un conteo absoluto en base)', true)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
