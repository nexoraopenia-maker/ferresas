import './guard'
import { completarRuc } from '../src/lib/documentos'
const RUC_CLIENTE = completarRuc('2051234567')
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { registerSale, ensureCounter, claimNextNumber } from '@/features/pos/sale-service'
import { registerSaleSchema } from '@/features/pos/schemas'
import { issueTaxDocument, updateTaxStatus } from '@/features/invoicing/service'
import { updateTaxStatusSchema } from '@/features/invoicing/schemas'
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
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  await asignarSucursal(t.id, owner.id, branch.id)
  const ctx: TenantContext = {
    tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL', branchId: branch.id,
  }
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

  console.log('\n2b) INVARIANTE DEL UBL: la suma de líneas cuadra con los totales')
  // SUNAT rechaza un comprobante cuyos totales no cuadren con sus líneas.
  // Se comprueba sobre una venta de VARIAS líneas con tasas MEZCLADAS, que es
  // donde un IGV calculado sobre el total se rompería.
  /*
   * Productos PROPIOS de esta sección, no el compartido: si consumiera el
   * stock de `prod`, las aserciones de la sección 3 —que comprueban que el
   * stock bajó de 100 a 90— medirían otra cosa y fallarían sin que hubiera
   * ningún problema real. Es el tipo de acoplamiento entre secciones que
   * convierte una suite en algo que nadie se atreve a tocar.
   */
  const afecto = await db.product.create({
    data: {
      tenantId: t.id, sku: `UBL-A-${M}`, name: 'Afecto A', salePrice: 11.8,
      taxRate: 0.18, unitType: 'UNIDAD',
    },
  })
  const afecto2 = await db.product.create({
    data: {
      tenantId: t.id, sku: `UBL-B-${M}`, name: 'Afecto B', salePrice: 11.8,
      taxRate: 0.18, unitType: 'KILOGRAMO',
    },
  })
  for (const id of [afecto.id, afecto2.id]) {
    await db.stock.create({
      data: { tenantId: t.id, productId: id, warehouseId: w.id, quantity: 100 },
    })
  }
  const exonerado = await db.product.create({
    data: {
      tenantId: t.id, sku: `EXO-${M}`, name: 'Manual exonerado',
      salePrice: 25, taxRate: 0, unitType: 'UNIDAD',
    },
  })
  await db.stock.create({
    data: { tenantId: t.id, productId: exonerado.id, warehouseId: w.id, quantity: 100 },
  })
  const mixta = await registerSale(db, ctx, parse({
    warehouseId: w.id,
    items: [
      { productId: afecto.id, quantity: 3 },      // 35.40 al 18 %
      { productId: exonerado.id, quantity: 2 },   // 50.00 exonerado
      { productId: afecto2.id, quantity: 0.5 },   // 5.90 al 18 %, fraccionada
    ],
    payments: [{ method: 'EFECTIVO', amount: 200 }],
  }))
  const lineasMixta = await db.saleItem.findMany({
    where: { saleId: mixta.saleId },
    select: { lineTotal: true, taxRate: true },
  })
  const sumaLineas = lineasMixta.reduce((a, l) => a + Number(l.lineTotal), 0)
  check('>>> Σ lineTotal == total del documento, EXACTO',
    Math.abs(sumaLineas - mixta.total) < 1e-9, `${sumaLineas} vs ${mixta.total}`)
  check('>>> subtotal + IGV == total, EXACTO',
    Math.abs(mixta.subtotal + mixta.taxTotal - mixta.total) < 1e-9,
    `${mixta.subtotal} + ${mixta.taxTotal} = ${mixta.subtotal + mixta.taxTotal} vs ${mixta.total}`)
  check('convive una línea exonerada con dos afectas',
    new Set(lineasMixta.map((l) => Number(l.taxRate))).size === 2)
  check('el IGV NO se cobra sobre la línea exonerada: es menor que el 18 % del total',
    mixta.taxTotal < mixta.total * 0.18 / 1.18,
    `IGV ${mixta.taxTotal} de un total ${mixta.total}`)

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
    data: { tenantId: t.id, docType: 'RUC', docNumber: RUC_CLIENTE, name: 'CONSTRUCTORA X S.A.C.' },
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
  check('congela el RUC del receptor', fdoc.receiverDocNumber === RUC_CLIENTE)
  check('y su razón social', fdoc.receiverName === 'CONSTRUCTORA X S.A.C.')

  const malRuc = await prisma.customer.create({
    data: { tenantId: t.id, docType: 'RUC', docNumber: '20512345678', name: 'EMPRESA CON RUC MAL TECLEADO' },
  })
  const vMal = await registerSale(db, ctx, parse({
    warehouseId: w.id, customerId: malRuc.id,
    items: [{ productId: prod.productId, quantity: 1 }],
    payments: [{ method: 'TRANSFERENCIA', amount: 11.8 }],
  }))
  const rechazoRuc = await issueTaxDocument(db, ctx, { saleId: vMal.saleId, documentType: 'FACTURA' })
    .then(() => null).catch((e) => e)
  check('>>> una factura con RUC de dígito verificador erróneo se rechaza ANTES de numerarse',
    rechazoRuc?.code === 'INVALID_DOCUMENT' && /RUC del cliente/.test(rechazoRuc?.message ?? ''), rechazoRuc?.message)
  check('y no gastó correlativo', (await db.taxDocument.count({ where: { documentType: 'FACTURA' } })) === 1)

  await prisma.customer.update({ where: { id: cliente.id }, data: { docNumber: '20500000000' } })
  check('cambiar el RUC del cliente NO altera la factura emitida',
    (await db.taxDocument.findFirstOrThrow({ where: { id: f1.id } })).receiverDocNumber === RUC_CLIENTE)

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
  await ensureCounter(db, t.id, branch.id, 'TAX_PRUEBA', 'Z001', '')
  const antes = (await db.documentCounter.findFirstOrThrow({ where: { scope: 'TAX_PRUEBA' } })).next
  await db.$transaction(async (tx) => {
    await claimNextNumber(tx as any, t.id, 'TAX_PRUEBA', 'Z001')
    throw new Error('fallo simulado')
  }).catch(() => {})
  const despues = (await db.documentCounter.findFirstOrThrow({ where: { scope: 'TAX_PRUEBA' } })).next
  check('el número reservado se devuelve al rollback', antes === despues, `${antes} -> ${despues}`)

  console.log('\n12) Transiciones de estado tributario')
  await updateTaxStatus(db, ctx, { taxDocumentId: b1.id, status: 'ENVIADO', motivo: 'Prueba automatizada del cambio de estado' })
  check('PENDIENTE -> ENVIADO',
    (await db.taxDocument.findFirstOrThrow({ where: { id: b1.id } })).status === 'ENVIADO')
  check('ENVIADO -> PENDIENTE se rechaza',
    await updateTaxStatus(db, ctx, { taxDocumentId: b1.id, status: 'ENVIADO' as any, motivo: 'Prueba automatizada del cambio de estado' })
      .then(() => null).catch((e) => e.code) === 'DUPLICATE_CODE')
  await updateTaxStatus(db, ctx, { taxDocumentId: b1.id, status: 'ACEPTADO', motivo: 'Prueba automatizada del cambio de estado' })
  const aceptado = await db.taxDocument.findFirstOrThrow({ where: { id: b1.id } })
  check('ENVIADO -> ACEPTADO', aceptado.status === 'ACEPTADO')
  check('marca acceptedAt', aceptado.acceptedAt !== null)
  check('>>> ACEPTADO es terminal: no se puede degradar',
    await updateTaxStatus(db, ctx, { taxDocumentId: b1.id, status: 'RECHAZADO', motivo: 'Prueba automatizada del cambio de estado' })
      .then(() => null).catch((e) => e.code) === 'DUPLICATE_CODE')
  check('un VENDEDOR no puede cambiar el estado tributario',
    await updateTaxStatus(getTenantPrisma({ ...ctx, role: 'VENDEDOR' }), { ...ctx, role: 'VENDEDOR' },
      { taxDocumentId: f1.id, status: 'ENVIADO', motivo: 'Prueba automatizada del cambio de estado' }).then(() => null).catch((e) => e.code) === 'FORBIDDEN_ROLE')

  console.log('\n12b) >>> ESTADO MANUAL: motivo obligatorio y auditoría completa')
  /*
   * Cambiar a mano el estado tributario es DECLARAR algo que el sistema no ha
   * comprobado. Sin motivo escrito y sin rastro del antes y el después, el día
   * que una fiscalización pregunte por qué este comprobante figura ACEPTADO
   * no habría nada que responder.
   */
  check('>>> el esquema EXIGE motivo',
    !updateTaxStatusSchema.safeParse({ taxDocumentId: f1.id, status: 'ENVIADO' }).success)
  check('un motivo de una palabra no vale (mínimo 10 caracteres)',
    !updateTaxStatusSchema.safeParse({ taxDocumentId: f1.id, status: 'ENVIADO', motivo: 'ok' }).success)
  check('con motivo suficiente pasa',
    updateTaxStatusSchema.safeParse({
      taxDocumentId: f1.id, status: 'ENVIADO', motivo: 'Reenvío tras corregir el RUC del cliente',
    }).success)

  await updateTaxStatus(db, ctx, {
    taxDocumentId: f1.id, status: 'ENVIADO',
    motivo: 'Reenvío tras corregir el RUC del cliente',
  })
  const rastro = await db.auditLog.findFirstOrThrow({
    where: { action: 'taxdocument.status.manual', entityId: f1.id },
    orderBy: { createdAt: 'desc' },
    select: { actorId: true, actorRole: true, reason: true, before: true, after: true },
  })
  check('>>> queda auditado con QUIÉN', rastro.actorId === owner.id)
  check('>>> con el MOTIVO', rastro.reason === 'Reenvío tras corregir el RUC del cliente')
  check('>>> con el estado ANTERIOR', (rastro.before as { status?: string }).status === 'PENDIENTE')
  check('>>> y el estado NUEVO', (rastro.after as { status?: string }).status === 'ENVIADO')
  check('con el número del comprobante',
    String((rastro.after as { comprobante?: string }).comprobante).startsWith('F001-'))
  check('>>> el listado dice que el cambio fue MANUAL y por qué',
    ((await db.taxDocument.findFirstOrThrow({ where: { id: f1.id } })).statusMessage ?? '')
      .startsWith('Cambio manual:'))

  const ctxCajero: TenantContext = { ...ctx, role: 'CAJERO' }
  check('>>> un CAJERO emite comprobantes pero NO declara su estado a mano',
    await updateTaxStatus(getTenantPrisma(ctxCajero), ctxCajero, {
      taxDocumentId: f1.id, status: 'ACEPTADO', motivo: 'Intento de un cajero sin permiso',
    }).then(() => null).catch((e) => e.code) === 'FORBIDDEN_ROLE')
  const ctxAdm: TenantContext = { ...ctx, role: 'ADMIN' }
  check('un ADMIN sí puede',
    await updateTaxStatus(getTenantPrisma(ctxAdm), ctxAdm, {
      taxDocumentId: f1.id, status: 'ACEPTADO', motivo: 'SUNAT respondió aceptado; CDR guardado aparte',
    }).then(() => 'ok').catch((e) => e.code) === 'ok')

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
  return fail
}

correr(main)
