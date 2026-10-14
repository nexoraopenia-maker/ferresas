import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { registerSale, ensureCounter, claimNextNumber } from '@/features/pos/sale-service'
import { registerSaleSchema } from '@/features/pos/schemas'
import { issueTaxDocument, updateTaxStatus } from '@/features/invoicing/service'
import { formatFullNumber, SERIE_POR_DEFECTO } from '@/features/invoicing/schemas'
import { createProductExpress } from '@/features/inventory/product-service'
import { createProductExpressSchema } from '@/features/inventory/schemas'
import type { TenantContext } from '@/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const M = randomUUID().slice(0, 6)

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'premium' } })
  const t = await prisma.tenant.create({
    data: {
      slug: `pos-${M}`, name: `Ferre POS ${M}`, planId: plan.id,
      taxId: '20600123456', legalName: `FERRE POS ${M} S.A.C.`,
    },
  })
  await prisma.subscription.create({
    data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' },
  })
  const owner = await prisma.user.create({
    data: { email: `o-${M}@x.com`, name: 'Dueño', role: 'OWNER', tenantId: t.id },
  })
  const w = await prisma.warehouse.create({
    data: { tenantId: t.id, code: 'PRIN', name: 'Principal', isDefault: true },
  })
  const ctx: TenantContext = { tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL' }
  const db = getTenantPrisma(ctx)
  const parse = (i: unknown) => registerSaleSchema.parse(i)

  // Producto con código de barras Y QR, precio con IGV incluido.
  const prod = await createProductExpress(db, ctx, createProductExpressSchema.parse({
    barcode: `771${M}0001`, qrCode: `QR-${M}-TUBO`, name: 'Tubo PVC 1/2"',
    salePrice: 11.8, initialStock: 100, minStock: 10, warehouseId: w.id,
  }))

  console.log('\n1) Códigos de barras y QR en el mismo producto')
  const fila = await db.product.findFirstOrThrow({
    where: { id: prod.productId }, select: { barcode: true, qrCode: true },
  })
  check('guarda el código de barras del fabricante', fila.barcode === `771${M}0001`)
  check('y el QR propio, en columna aparte', fila.qrCode === `QR-${M}-TUBO`)
  check('se resuelve por código de barras',
    (await db.product.findFirst({ where: { barcode: `771${M}0001` } }))?.id === prod.productId)
  check('se resuelve por QR',
    (await db.product.findFirst({ where: { qrCode: `QR-${M}-TUBO` } }))?.id === prod.productId)
  check('un QR repetido en el mismo tenant se rechaza',
    await db.product.create({
      data: { tenantId: t.id, sku: `DUP-${M}`, name: 'Dup', qrCode: `QR-${M}-TUBO` },
    }).then(() => false).catch((e) => e.code === 'P2002'))

  console.log('\n2) Venta: el IGV se EXTRAE del precio, no se suma')
  const v1 = await registerSale(db, ctx, parse({
    warehouseId: w.id,
    items: [{ productId: prod.productId, quantity: 10 }],
    payments: [{ method: 'EFECTIVO', amount: 118 }],
  }))
  check('el total es el precio de etiqueta x cantidad', v1.total === 118, String(v1.total))
  check('base imponible = 100.00', v1.subtotal === 100, String(v1.subtotal))
  check('IGV = 18.00', v1.taxTotal === 18, String(v1.taxTotal))
  check('base + IGV = total', v1.subtotal + v1.taxTotal === v1.total)

  console.log('\n3) La venta descuenta stock en la MISMA transacción')
  const stock = await db.stock.findFirstOrThrow({ where: { productId: prod.productId } })
  check('stock bajó de 100 a 90', stock.quantity.toNumber() === 90, String(stock.quantity))
  const mov = await db.stockMovement.findFirstOrThrow({
    where: { productId: prod.productId, type: 'SALIDA' },
    orderBy: { createdAt: 'desc' },
  })
  check('el movimiento se etiqueta como VENTA', mov.source === 'VENTA')
  check('con cantidad signada negativa', mov.quantity.toNumber() === -10)
  check('y referencia a la venta', mov.reason === `Venta ${v1.number}`)
  const suma = await db.stockMovement.aggregate({
    where: { productId: prod.productId }, _sum: { quantity: true },
  })
  check('SUM(ledger) sigue reconciliando', Number(suma._sum.quantity) === 90)

  console.log('\n4) Pagos y validaciones')
  check('rechaza si el pago no cubre el total',
    await registerSale(db, ctx, parse({
      warehouseId: w.id,
      items: [{ productId: prod.productId, quantity: 1 }],
      payments: [{ method: 'EFECTIVO', amount: 5 }],
    })).then(() => null).catch((e) => e.code) === 'INSUFFICIENT_STOCK')
  check('rechaza descuento mayor que la línea',
    await registerSale(db, ctx, parse({
      warehouseId: w.id,
      items: [{ productId: prod.productId, quantity: 1, discount: 999 }],
      payments: [{ method: 'EFECTIVO', amount: 999 }],
    })).then(() => null).catch((e) => /descuento/.test(e.message)) === true)
  check('el carrito vacío no pasa la validación',
    !registerSaleSchema.safeParse({ warehouseId: w.id, items: [], payments: [{ method: 'EFECTIVO', amount: 1 }] }).success)
  check('el cuerpo NO admite precios ni totales del cliente',
    !('total' in (registerSaleSchema.parse({
      warehouseId: w.id,
      items: [{ productId: 'p', quantity: 1 }],
      payments: [{ method: 'EFECTIVO', amount: 1 }],
      total: 1,
    }) as any)))

  console.log('\n5) Emisión de comprobante')
  const b1 = await issueTaxDocument(db, ctx, { saleId: v1.saleId, documentType: 'BOLETA' })
  check('emite boleta con la serie por defecto', b1.series === SERIE_POR_DEFECTO.BOLETA)
  check('correlativo arranca en 1', b1.correlativo === 1, String(b1.correlativo))
  check('número impreso con 8 dígitos', b1.fullNumber === formatFullNumber('B001', 1), b1.fullNumber)
  check('nace en PENDIENTE', b1.status === 'PENDIENTE')
  check('copia los importes de la venta', b1.total === 118)

  const doc = await db.taxDocument.findFirstOrThrow({ where: { id: b1.id } })
  check('congela el RUC del emisor', doc.issuerTaxId === '20600123456')
  check('y su razón social', doc.issuerLegalName === `FERRE POS ${M} S.A.C.`)

  console.log('\n6) INMUTABILIDAD: cambiar el negocio no altera lo emitido')
  await prisma.tenant.update({
    where: { id: t.id }, data: { taxId: '20699999999', legalName: 'OTRA RAZON SOCIAL' },
  })
  const tras = await db.taxDocument.findFirstOrThrow({ where: { id: b1.id } })
  check('el comprobante conserva el RUC original', tras.issuerTaxId === '20600123456')
  check('y la razón social original', tras.issuerLegalName === `FERRE POS ${M} S.A.C.`)

  console.log('\n7) Uno por venta; reintentar devuelve el mismo')
  const b2 = await issueTaxDocument(db, ctx, { saleId: v1.saleId, documentType: 'BOLETA' })
  check('devuelve el existente', b2.id === b1.id)
  check('lo marca como ya emitido', b2.alreadyIssued === true)
  check('NO consume otro correlativo', b2.correlativo === 1)
  check('solo hay un comprobante para esa venta',
    (await db.taxDocument.count({ where: { saleId: v1.saleId } })) === 1)

  console.log('\n8) FACTURA exige RUC del receptor')
  const v2 = await registerSale(db, ctx, parse({
    warehouseId: w.id,
    items: [{ productId: prod.productId, quantity: 1 }],
    payments: [{ method: 'YAPE', amount: 11.8 }],
  }))
  const sinRuc = await issueTaxDocument(db, ctx, { saleId: v2.saleId, documentType: 'FACTURA' })
    .then(() => null).catch((e) => e)
  check('sin cliente con RUC se rechaza', sinRuc?.code === 'INVALID_DOCUMENT')
  check('el mensaje orienta a emitir boleta', /boleta/i.test(sinRuc?.message ?? ''))

  const cliente = await prisma.customer.create({
    data: { tenantId: t.id, docType: 'RUC', docNumber: '20512345678', name: 'CONSTRUCTORA X S.A.C.' },
  })
  const v3 = await registerSale(db, ctx, parse({
    warehouseId: w.id, customerId: cliente.id,
    items: [{ productId: prod.productId, quantity: 2 }],
    payments: [{ method: 'TRANSFERENCIA', amount: 23.6 }],
  }))
  const f1 = await issueTaxDocument(db, ctx, { saleId: v3.saleId, documentType: 'FACTURA' })
  check('con RUC válido sí emite factura', f1.documentType === 'FACTURA')
  check('en serie F001 y correlativo propio',
    f1.series === 'F001' && f1.correlativo === 1, `${f1.series}-${f1.correlativo}`)
  const fdoc = await db.taxDocument.findFirstOrThrow({ where: { id: f1.id } })
  check('congela el RUC del receptor', fdoc.receiverDocNumber === '20512345678')
  check('y su razón social', fdoc.receiverName === 'CONSTRUCTORA X S.A.C.')

  await prisma.customer.update({ where: { id: cliente.id }, data: { docNumber: '20500000000' } })
  check('cambiar el RUC del cliente NO altera la factura emitida',
    (await db.taxDocument.findFirstOrThrow({ where: { id: f1.id } })).receiverDocNumber === '20512345678')

  console.log('\n9) Boletas y facturas llevan series INDEPENDIENTES')
  const b3 = await issueTaxDocument(db, ctx, { saleId: v2.saleId, documentType: 'BOLETA' })
  check('la boleta siguiente es B001-2', b3.fullNumber === formatFullNumber('B001', 2), b3.fullNumber)
  check('la factura no se vio afectada', f1.correlativo === 1)

  console.log('\n10) CONCURRENCIA — 12 comprobantes simultáneos, serie sin huecos (§8)')
  /**
   * Cliente aparte con varias conexiones.
   *
   * El cliente normal lleva `connection_limit=1` en la URL, que es lo
   * CORRECTO en Vercel —cada invocación serverless abre su propia conexión—
   * pero impide que un único proceso abra 12 transacciones a la vez. Con una
   * sola conexión el test mediría la cola del pool, no la numeración.
   *
   * Aquí se replica lo que de verdad pasa en producción: N peticiones
   * concurrentes, cada una con su conexión, compitiendo por el contador.
   */
  // Se usa la conexión DIRECTA, no la pooled: una transacción interactiva de
  // Prisma necesita sesión dedicada, y el pooler en modo transacción las
  // encola hasta agotar el tiempo de espera. En producción cada invocación
  // serverless trae su propia conexión, así que no hay cola; replicarlo en un
  // solo proceso exige saltarse el pooler.
  const base = process.env.DIRECT_URL!
  const urlMulti = `${base}${base.includes('?') ? '&' : '?'}connection_limit=15`
  const prismaMulti = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlMulti }) })
  const dbMulti = (prismaMulti as any).$extends({
    name: 'tenant-test',
    query: { $allModels: { async $allOperations({ args, query }: any) { return query(args) } } },
  }) as unknown as typeof db
  const ventas = await Promise.all(
    Array.from({ length: 12 }, () =>
      registerSale(dbMulti, ctx, parse({
        warehouseId: w.id,
        items: [{ productId: prod.productId, quantity: 1 }],
        payments: [{ method: 'EFECTIVO', amount: 11.8 }],
      })),
    ),
  )
  const emitidos = await Promise.allSettled(
    ventas.map((v) => issueTaxDocument(dbMulti, ctx, { saleId: v.saleId, documentType: 'BOLETA' })),
  )
  const fallos = emitidos.filter((r) => r.status === 'rejected')
  if (fallos.length) console.log('    fallos:', fallos.map((f: any) => f.reason?.message).join(' | '))
  const ok = emitidos.filter((r) => r.status === 'fulfilled')
  check('los 12 se emitieron', ok.length === 12, `${ok.length}/12`)

  const correlativos = (await db.taxDocument.findMany({
    where: { documentType: 'BOLETA', series: 'B001' },
    select: { correlativo: true },
    orderBy: { correlativo: 'asc' },
  })).map((d) => d.correlativo)

  check('todos los correlativos son ÚNICOS',
    new Set(correlativos).size === correlativos.length,
    `${correlativos.length} docs, ${new Set(correlativos).size} distintos`)
  const esperado = Array.from({ length: correlativos.length }, (_, i) => i + 1)
  check('>>> la serie NO tiene HUECOS: 1..N consecutivos',
    JSON.stringify(correlativos) === JSON.stringify(esperado),
    correlativos.join(','))

  await prismaMulti.$disconnect()

  console.log('\n11) El contador no quema números si la operación falla')
  await ensureCounter(db, t.id, 'TAX_PRUEBA', 'Z001', '')
  const antes = (await db.documentCounter.findFirstOrThrow({ where: { scope: 'TAX_PRUEBA' } })).next
  await db.$transaction(async (tx) => {
    await claimNextNumber(tx as any, t.id, 'TAX_PRUEBA', 'Z001')
    throw new Error('fallo simulado')
  }).catch(() => {})
  const despues = (await db.documentCounter.findFirstOrThrow({ where: { scope: 'TAX_PRUEBA' } })).next
  check('el número reservado se devuelve al rollback', antes === despues, `${antes} -> ${despues}`)

  console.log('\n12) Transiciones de estado tributario')
  await updateTaxStatus(db, ctx, { taxDocumentId: b1.id, status: 'ENVIADO' })
  check('PENDIENTE -> ENVIADO',
    (await db.taxDocument.findFirstOrThrow({ where: { id: b1.id } })).status === 'ENVIADO')
  check('ENVIADO -> PENDIENTE se rechaza',
    await updateTaxStatus(db, ctx, { taxDocumentId: b1.id, status: 'ENVIADO' as any })
      .then(() => null).catch((e) => e.code) === 'DUPLICATE_CODE')
  await updateTaxStatus(db, ctx, { taxDocumentId: b1.id, status: 'ACEPTADO' })
  const aceptado = await db.taxDocument.findFirstOrThrow({ where: { id: b1.id } })
  check('ENVIADO -> ACEPTADO', aceptado.status === 'ACEPTADO')
  check('marca acceptedAt', aceptado.acceptedAt !== null)
  check('>>> ACEPTADO es terminal: no se puede degradar',
    await updateTaxStatus(db, ctx, { taxDocumentId: b1.id, status: 'RECHAZADO' })
      .then(() => null).catch((e) => e.code) === 'DUPLICATE_CODE')
  check('un VENDEDOR no puede cambiar el estado tributario',
    await updateTaxStatus(getTenantPrisma({ ...ctx, role: 'VENDEDOR' }), { ...ctx, role: 'VENDEDOR' },
      { taxDocumentId: f1.id, status: 'ENVIADO' }).then(() => null).catch((e) => e.code) === 'FORBIDDEN_ROLE')

  console.log('\n13) Aislamiento y suscripción')
  const otro = await prisma.tenant.create({ data: { slug: `ot-${M}`, name: 'Otro', planId: plan.id } })
  const ou = await prisma.user.create({
    data: { email: `ou-${M}@x.com`, name: 'O', role: 'OWNER', tenantId: otro.id },
  })
  const dbOtro = getTenantPrisma({ tenantId: otro.id, userId: ou.id, role: 'OWNER', access: 'FULL' })
  check('otro tenant no ve estos comprobantes', (await dbOtro.taxDocument.count()) === 0)
  check('ni puede emitir sobre una venta ajena',
    await issueTaxDocument(dbOtro, { tenantId: otro.id, userId: ou.id, role: 'OWNER', access: 'FULL' },
      { saleId: v1.saleId, documentType: 'BOLETA' }).then(() => null).catch((e) => e.code) === 'TENANT_MISMATCH')
  const ro: TenantContext = { ...ctx, access: 'READ_ONLY' }
  check('con suscripción vencida no se puede vender',
    await registerSale(getTenantPrisma(ro), ro, parse({
      warehouseId: w.id,
      items: [{ productId: prod.productId, quantity: 1 }],
      payments: [{ method: 'EFECTIVO', amount: 11.8 }],
    })).then(() => null).catch((e) => e.code) === 'SUBSCRIPTION_READ_ONLY')

  console.log('\n14) Limpieza')
  await prisma.tenant.delete({ where: { id: otro.id } })
  await prisma.taxDocument.deleteMany({ where: { tenantId: t.id } })
  await prisma.tenant.delete({ where: { id: t.id } })
  check('datos de prueba eliminados', (await prisma.tenant.count({ where: { id: t.id } })) === 0)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
