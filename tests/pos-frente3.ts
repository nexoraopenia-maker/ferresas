import './guard'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { registerSale } from '../src/features/pos/sale-service'
import { registerQuote, convertQuoteToSale } from '../src/features/pos/quote-service'
import {
  registerSaleSchema, registerQuoteSchema, convertQuoteSchema, customerByDocSchema,
} from '../src/features/pos/schemas'
import { createProductExpress } from '../src/features/inventory/product-service'
import { createProductExpressSchema } from '../src/features/inventory/schemas'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const M = randomUUID().slice(0, 6)

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'premium' } })
  const t = await prisma.tenant.create({
    data: { slug: `f3-${M}`, name: `Ferre F3 ${M}`, planId: plan.id },
  })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' } })
  const owner = await prisma.user.create({
    data: { email: `o-${M}@x.com`, name: 'Dueño', role: 'OWNER', tenantId: t.id },
  })
  const w = await prisma.warehouse.create({
    data: { tenantId: t.id, code: 'PRIN', name: 'Principal', isDefault: true },
  })
  const ctx: TenantContext = { tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL' }
  const db = getTenantPrisma(ctx)
  const pS = (i: unknown) => registerSaleSchema.parse(i)
  const pQ = (i: unknown) => registerQuoteSchema.parse(i)
  const pC = (i: unknown) => convertQuoteSchema.parse(i)

  const prod = await createProductExpress(db, ctx, createProductExpressSchema.parse({
    name: 'Cemento Sol 42.5kg', salePrice: 32.5, unitType: 'BOLSA',
    initialStock: 3, minStock: 1, warehouseId: w.id,
  }))

  console.log('\n1) Documento del cliente: el tipo se deduce del largo')
  check('8 dígitos es válido (DNI)', customerByDocSchema.safeParse({ docNumber: '12345678' }).success)
  check('11 dígitos es válido (RUC)', customerByDocSchema.safeParse({ docNumber: '20512345678' }).success)
  check('9 dígitos se rechaza', !customerByDocSchema.safeParse({ docNumber: '123456789' }).success)
  check('con letras se rechaza', !customerByDocSchema.safeParse({ docNumber: '1234567A' }).success)
  check('el mensaje explica los dos largos',
    /8 dígitos y el RUC 11/.test(
      customerByDocSchema.safeParse({ docNumber: '123' }).error?.issues[0]?.message ?? ''))

  console.log('\n2) VENTA FORZADA con stock negativo')
  const bloqueada = await registerSale(db, ctx, pS({
    warehouseId: w.id,
    items: [{ productId: prod.productId, quantity: 10 }],  // solo hay 3
    payments: [{ method: 'EFECTIVO', amount: 325 }],
  })).then(() => null).catch((e) => e)
  check('sin forzar, se bloquea', bloqueada?.code === 'INSUFFICIENT_STOCK')
  check('el stock no se movió',
    (await db.stock.findFirstOrThrow({ where: { productId: prod.productId } })).quantity.toNumber() === 3)

  const forzada = await registerSale(db, ctx, pS({
    warehouseId: w.id,
    items: [{ productId: prod.productId, quantity: 10 }],
    payments: [{ method: 'EFECTIVO', amount: 325 }],
    allowNegativeStock: true,
  }))
  check('>>> forzando, la venta se registra', forzada.total === 325)
  check('la marca soldBelowStock queda puesta', forzada.soldBelowStock === true)
  const stockNeg = await db.stock.findFirstOrThrow({ where: { productId: prod.productId } })
  check('el stock queda en -7', stockNeg.quantity.toNumber() === -7, String(stockNeg.quantity))
  const venta = await db.sale.findFirstOrThrow({ where: { id: forzada.saleId } })
  check('la venta lo registra en BD', venta.soldBelowStock === true)

  const log = await db.auditLog.findFirst({
    where: { action: 'sale.below_stock' }, orderBy: { createdAt: 'desc' },
  })
  check('queda AUDITADO', log !== null)
  check('el motivo distingue forzada de política del tenant',
    /forzó la venta/.test(log?.reason ?? ''), log?.reason ?? '')
  check('>>> el audit dice QUÉ producto contar',
    JSON.stringify(log?.after).includes('Cemento Sol'), JSON.stringify(log?.after))
  const mov = await db.stockMovement.findFirstOrThrow({
    where: { productId: prod.productId, type: 'SALIDA' }, orderBy: { createdAt: 'desc' },
  })
  check('el movimiento del ledger lo marca como forzado',
    /forzada/.test(mov.reason ?? ''), mov.reason ?? '')

  console.log('\n3) COTIZACIÓN: no toca el stock')
  await prisma.stock.updateMany({ where: { productId: prod.productId }, data: { quantity: 20 } })
  const antes = (await db.stock.findFirstOrThrow({ where: { productId: prod.productId } })).quantity.toNumber()
  const q = await registerQuote(db, ctx, pQ({
    warehouseId: w.id,
    items: [{ productId: prod.productId, quantity: 4 }],
    validDays: 15,
  }))
  check('se guarda con correlativo propio', /^C001-\d{8}$/.test(q.number), q.number)
  check('>>> el stock NO se movió',
    (await db.stock.findFirstOrThrow({ where: { productId: prod.productId } })).quantity.toNumber() === antes)
  check('calcula el total', q.total === 130, String(q.total))
  check('base + IGV = total', Math.round((q.subtotal + q.taxTotal) * 100) / 100 === q.total)
  check('fija la caducidad a 15 días',
    Math.round((q.validUntil.getTime() - Date.now()) / 86400000) === 15)
  const items = await db.quoteItem.findMany({ where: { quoteId: q.quoteId } })
  check('congela el precio en la línea', items[0]?.unitPrice.toNumber() === 32.5)

  console.log('\n4) Convertir cotización en venta')
  // Se SUBE el precio de lista: la conversión debe cobrar el cotizado.
  await prisma.product.update({ where: { id: prod.productId }, data: { salePrice: 50 } })
  const conv = await convertQuoteToSale(db, ctx, pC({
    quoteId: q.quoteId,
    payments: [{ method: 'EFECTIVO', amount: 130 }],
  }))
  check('>>> cobra el precio COTIZADO, no el de hoy', conv.total === 130, `S/ ${conv.total}`)
  check('el cuerpo público NO admite priceOverrides (sería vender a cualquier precio)',
    !('priceOverrides' in (registerSaleSchema.parse({
      warehouseId: w.id,
      items: [{ productId: prod.productId, quantity: 1 }],
      payments: [{ method: 'EFECTIVO', amount: 100 }],
      priceOverrides: { x: 1 },
    }) as any)))
  check('referencia la cotización', conv.quoteNumber === q.number)
  check('el stock ahora SÍ baja',
    (await db.stock.findFirstOrThrow({ where: { productId: prod.productId } })).quantity.toNumber() === antes - 4)
  const qTras = await db.quote.findFirstOrThrow({ where: { id: q.quoteId } })
  check('la cotización pasa a CONVERTIDA', qTras.status === 'CONVERTIDA')
  const vTras = await db.sale.findFirstOrThrow({ where: { id: conv.saleId } })
  check('la venta apunta a la cotización', vTras.quoteId === q.quoteId)
  check('la nota lo indica', /Convertida de la cotización/.test(vTras.notes ?? ''))

  console.log('\n5) Reintento y doble conversión')
  const otra = await convertQuoteToSale(db, ctx, pC({
    quoteId: q.quoteId, payments: [{ method: 'EFECTIVO', amount: 130 }],
  }))
  check('convertir dos veces devuelve la MISMA venta', otra.saleId === conv.saleId)
  check('no se duplicó el descuento de stock',
    (await db.stock.findFirstOrThrow({ where: { productId: prod.productId } })).quantity.toNumber() === antes - 4)

  console.log('\n6) Cotización VENCIDA no se convierte en silencio')
  const vieja = await registerQuote(db, ctx, pQ({
    warehouseId: w.id, items: [{ productId: prod.productId, quantity: 1 }], validDays: 1,
  }))
  await prisma.quote.update({
    where: { id: vieja.quoteId }, data: { validUntil: new Date('2026-01-01') },
  })
  const venc = await convertQuoteToSale(db, ctx, pC({
    quoteId: vieja.quoteId, payments: [{ method: 'EFECTIVO', amount: 50 }],
  })).then(() => null).catch((e) => e)
  check('>>> se rechaza por vencida', venc?.code === 'DUPLICATE_CODE')
  check('el mensaje dice cuándo venció y qué hacer',
    /venció el/.test(venc?.message ?? '') && /precios de hoy/.test(venc?.message ?? ''),
    venc?.message)

  console.log('\n7) Validación de cotizaciones')
  check('carrito vacío se rechaza',
    !registerQuoteSchema.safeParse({ warehouseId: w.id, items: [] }).success)
  check('más de 90 días se rechaza',
    !registerQuoteSchema.safeParse({
      warehouseId: w.id, items: [{ productId: 'p', quantity: 1 }], validDays: 200,
    }).success)
  check('por defecto son 15 días',
    registerQuoteSchema.parse({
      warehouseId: w.id, items: [{ productId: 'p', quantity: 1 }],
    }).validDays === 15)

  console.log('\n8) Permisos y aislamiento')
  const vendedor: TenantContext = { ...ctx, role: 'VENDEDOR' }
  check('un VENDEDOR sí puede cotizar',
    await registerQuote(getTenantPrisma(vendedor), vendedor, pQ({
      warehouseId: w.id, items: [{ productId: prod.productId, quantity: 1 }],
    })).then(() => true).catch(() => false))
  const ro: TenantContext = { ...ctx, access: 'READ_ONLY' }
  check('con suscripción vencida NO se puede cotizar',
    await registerQuote(getTenantPrisma(ro), ro, pQ({
      warehouseId: w.id, items: [{ productId: prod.productId, quantity: 1 }],
    })).then(() => null).catch((e) => e.code) === 'SUBSCRIPTION_READ_ONLY')

  const otroT = await prisma.tenant.create({ data: { slug: `f3b-${M}`, name: 'Otro', planId: plan.id } })
  const otroU = await prisma.user.create({
    data: { email: `ou-${M}@x.com`, name: 'O', role: 'OWNER', tenantId: otroT.id },
  })
  const dbOtro = getTenantPrisma({ tenantId: otroT.id, userId: otroU.id, role: 'OWNER', access: 'FULL' })
  check('otro tenant no ve estas cotizaciones', (await dbOtro.quote.count()) === 0)
  check('ni puede convertir una ajena',
    await convertQuoteToSale(dbOtro, { tenantId: otroT.id, userId: otroU.id, role: 'OWNER', access: 'FULL' },
      pC({ quoteId: q.quoteId, payments: [{ method: 'EFECTIVO', amount: 1 }] }))
      .then(() => null).catch((e) => e.code) === 'TENANT_MISMATCH')

  console.log('\n9) Limpieza')
  await prisma.tenant.delete({ where: { id: otroT.id } })
  await prisma.taxDocument.deleteMany({ where: { tenantId: t.id } })
  await prisma.tenant.delete({ where: { id: t.id } })
  check('datos de prueba eliminados', (await prisma.tenant.count({ where: { id: t.id } })) === 0)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
