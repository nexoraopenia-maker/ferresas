import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen, abrirTurno } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import {
  formatQuantity, isBulkUnit, isPartialQuantity, limitarDecimales,
  parseQuantity, redondear, stepFor, stepsFor, unitLabel,
} from '../src/lib/quantity'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { createProductExpress } from '../src/features/inventory/product-service'
import { createProductExpressSchema } from '../src/features/inventory/schemas'
import { issueTaxDocument } from '../src/features/invoicing/service'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const M = randomUUID().slice(0, 6)

async function main() {
  console.log('\n1) EL BUG: teclear "1.5" era imposible')
  // Antes: Number("1.") === 1, el estado pasaba a 1 y el punto se perdía.
  check('"1." es un estado intermedio VÁLIDO', isPartialQuantity('1.'))
  check('"0." también', isPartialQuantity('0.'))
  check('"" también (campo vacío al borrar)', isPartialQuantity(''))
  check('"," suelta también (teclado con coma)', isPartialQuantity(','))
  check('"1.5" es válida', isPartialQuantity('1.5'))
  check('"abc" NO es válida', !isPartialQuantity('abc'))
  check('"1.2.3" NO es válida', !isPartialQuantity('1.2.3'))
  check('"-1" NO es válida', !isPartialQuantity('-1'))

  console.log('\n2) Conversión')
  check('"1." todavía no es número completo', parseQuantity('1.') === 1)
  check('"" devuelve null', parseQuantity('') === null)
  check('"." devuelve null', parseQuantity('.') === null)
  check('>>> acepta COMA como separador: "0,250"', parseQuantity('0,250') === 0.25)
  check('y punto: "0.250"', parseQuantity('0.250') === 0.25)
  check('"1.5" -> 1.5', parseQuantity('1.5') === 1.5)
  check('negativos se rechazan', parseQuantity('-2') === null)

  console.log('\n3) Decimales: se recortan, no se bloquean')
  check('5 decimales se recortan a 4', limitarDecimales('1.23456') === '1.2345')
  check('conserva la coma si se usó', limitarDecimales('1,23456') === '1,2345')
  check('no toca lo que ya cabe', limitarDecimales('1.5') === '1.5')
  check('redondear evita la deriva de flotantes',
    redondear(0.1 + 0.2) === 0.3, String(0.1 + 0.2))

  console.log('\n4) Formato según la unidad')
  check('3 unidades no arrastra ceros', formatQuantity(3, 'UNIDAD') === '3')
  check('0.25 kg se muestra completo', formatQuantity(0.25, 'KILOGRAMO') === '0.25')
  check('1.5 m se muestra completo', formatQuantity(1.5, 'METRO') === '1.5')
  check('2 kg no arrastra ".000"', formatQuantity(2, 'KILOGRAMO') === '2')
  check('kg es granel', isBulkUnit('KILOGRAMO') && isBulkUnit('METRO'))
  check('caja no es granel', !isBulkUnit('CAJA') && !isBulkUnit('UNIDAD'))

  console.log('\n5) Atajos adaptados a la unidad')
  check('kg: 0.1 / 0.25 / 0.5 / 1', stepsFor('KILOGRAMO').join(',') === '0.1,0.25,0.5,1')
  check('metro: 0.5 / 1 / 5 / 10', stepsFor('METRO').join(',') === '0.5,1,5,10')
  check('unidad sigue en 1 / 5 / 10 / 25', stepsFor('UNIDAD').join(',') === '1,5,10,25')
  check('el paso de − / + es 0.25 en kg', stepFor('KILOGRAMO') === 0.25)
  check('y 1 en unidades discretas', stepFor('CAJA') === 1)
  check('abreviaturas legibles', unitLabel('KILOGRAMO') === 'kg' && unitLabel('METRO') === 'm')

  // ───────── Ciclo real con datos ─────────
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'premium' } })
  const t = await prisma.tenant.create({
    data: { slug: `gr-${M}`, name: `Ferre Granel ${M}`, planId: plan.id, taxId: `206${M.replace(/\D/g,'0').padEnd(8,'0').slice(0,8)}` },
  })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' } })
  const owner = await prisma.user.create({
    data: { email: `o-${M}@x.com`, name: 'Dueño', role: 'OWNER', tenantId: t.id },
  })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  await asignarSucursal(t.id, owner.id, branch.id)
  const ctx: TenantContext = {
    tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL', branchId: branch.id,
  }
  await abrirTurno(t.id, owner.id, branch.id)
  const db = getTenantPrisma(ctx)
  const parse = (i: unknown) => registerSaleSchema.parse(i)

  // Clavos a S/ 8.50 el kg, 50 kg en stock.
  const clavos = await createProductExpress(db, ctx, createProductExpressSchema.parse({
    name: 'Clavo 3" a granel', salePrice: 8.5, unitType: 'KILOGRAMO',
    initialStock: 50, minStock: 5, warehouseId: w.id,
  }))
  // Cable a S/ 4.20 el metro, 100 m.
  const cable = await createProductExpress(db, ctx, createProductExpressSchema.parse({
    name: 'Cable THW 14 AWG', salePrice: 4.2, unitType: 'METRO',
    initialStock: 100, minStock: 10, warehouseId: w.id,
  }))

  console.log('\n6) VENTA A GRANEL de punta a punta')
  const v = await registerSale(db, ctx, parse({
    warehouseId: w.id,
    items: [
      { productId: clavos.productId, quantity: 0.25 },   // 250 g de clavos
      { productId: cable.productId, quantity: 1.5 },     // 1.5 m de cable
    ],
    payments: [{ method: 'EFECTIVO', amount: 10 }],
  }))
  // 0.25 × 8.50 = 2.125 -> 2.13 ; 1.5 × 4.20 = 6.30 ; total 8.43
  check('cobra la fracción exacta', v.total === 8.43, `S/ ${v.total}`)
  check('IGV extraído, no sumado', redondear(v.subtotal + v.taxTotal) === v.total,
    `${v.subtotal} + ${v.taxTotal}`)

  console.log('\n7) El stock baja en fracciones')
  const sc = await db.stock.findFirstOrThrow({ where: { productId: clavos.productId } })
  const sb = await db.stock.findFirstOrThrow({ where: { productId: cable.productId } })
  check('clavos: 50 -> 49.75', sc.quantity.toNumber() === 49.75, String(sc.quantity))
  check('cable: 100 -> 98.5', sb.quantity.toNumber() === 98.5, String(sb.quantity))

  const mov = await db.stockMovement.findFirstOrThrow({
    where: { productId: clavos.productId, type: 'SALIDA' },
  })
  check('el ledger guarda -0.25, no -1', mov.quantity.toNumber() === -0.25, String(mov.quantity))
  const suma = await db.stockMovement.aggregate({
    where: { productId: clavos.productId }, _sum: { quantity: true },
  })
  check('SUM(ledger) reconcilia con fracciones', Number(suma._sum.quantity) === 49.75)

  console.log('\n8) Las líneas conservan la cantidad fraccionada')
  const items = await db.saleItem.findMany({
    where: { saleId: v.saleId }, orderBy: { nameSnapshot: 'asc' },
  })
  check('la línea de cable dice 1.5',
    items.find((i) => i.nameSnapshot.includes('Cable'))?.quantity.toNumber() === 1.5)
  check('la de clavos dice 0.25',
    items.find((i) => i.nameSnapshot.includes('Clavo'))?.quantity.toNumber() === 0.25)

  console.log('\n9) El comprobante cuadra con la venta a granel')
  const doc = await issueTaxDocument(db, ctx, { saleId: v.saleId, documentType: 'BOLETA' })
  check('se emite sin problema', doc.total === 8.43)
  const d = await db.taxDocument.findFirstOrThrow({ where: { id: doc.id } })
  check('base + IGV = total en el comprobante',
    redondear(d.subtotal.toNumber() + d.taxTotal.toNumber()) === d.total.toNumber())

  console.log('\n10) Cantidades imposibles siguen rechazadas')
  check('5 decimales se rechazan',
    !registerSaleSchema.safeParse({
      warehouseId: w.id, items: [{ productId: clavos.productId, quantity: 0.00001 }],
      payments: [{ method: 'EFECTIVO', amount: 1 }],
    }).success)
  check('cero se rechaza',
    !registerSaleSchema.safeParse({
      warehouseId: w.id, items: [{ productId: clavos.productId, quantity: 0 }],
      payments: [{ method: 'EFECTIVO', amount: 1 }],
    }).success)
  check('negativo se rechaza',
    !registerSaleSchema.safeParse({
      warehouseId: w.id, items: [{ productId: clavos.productId, quantity: -1 }],
      payments: [{ method: 'EFECTIVO', amount: 1 }],
    }).success)

  console.log('\n11) Venta con stock insuficiente a granel')
  const err = await registerSale(db, ctx, parse({
    warehouseId: w.id,
    items: [{ productId: clavos.productId, quantity: 999.5 }],
    payments: [{ method: 'EFECTIVO', amount: 9000 }],
  })).then(() => null).catch((e) => e)
  check('se bloquea con política BLOQUEAR', err?.code === 'INSUFFICIENT_STOCK')
  check('el detalle muestra la fracción disponible',
    err?.details?.disponible === 49.75, String(err?.details?.disponible))

  console.log('\n12) Limpieza')
  await prisma.taxDocument.deleteMany({ where: { tenantId: t.id } })
  await prisma.tenant.delete({ where: { id: t.id } })
  check('datos de prueba eliminados', (await prisma.tenant.count({ where: { id: t.id } })) === 0)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
