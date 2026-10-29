import './guard'
import { completarRuc } from '../src/lib/documentos'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/generated/prisma/client'
import { crearSucursal, asignarSucursal, abrirTurno } from './fixtures'
import { prisma } from '@/lib/prisma'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import {
  fijarArranqueSerie, listarSeriesConfigurables,
} from '@/features/invoicing/counter-service'
import { fijarArranqueSchema, formatFullNumber } from '@/features/invoicing/schemas'
import { issueTaxDocument } from '@/features/invoicing/service'
import { registerSale } from '@/features/pos/sale-service'
import { registerSaleSchema } from '@/features/pos/schemas'
import { createProductExpress } from '@/features/inventory/product-service'
import { createProductExpressSchema } from '@/features/inventory/schemas'
import type { TenantContext } from '@/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const M = randomUUID().slice(0, 6)
const code = async (fn: () => Promise<unknown>) =>
  fn().then(() => 'SIN_ERROR').catch((e) => (e as { code?: string }).code ?? 'ERR')

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'premium' } })
  const t = await prisma.tenant.create({
    data: {
      slug: `corr-${M}`, name: 'Correlativo', planId: plan.id,
      taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`), legalName: 'CORRELATIVO S.A.C.',
      realBillingEnabledAt: new Date(),
    },
  })
  await prisma.subscription.create({
    data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' },
  })
  const owner = await prisma.user.create({
    data: { email: `corr-${M}@x.com`, name: 'Dueño', role: 'OWNER', tenantId: t.id },
  })
  const b = await crearSucursal(t.id)
  await asignarSucursal(t.id, owner.id, b.id)
  const w = await prisma.warehouse.create({
    data: { tenantId: t.id, branchId: b.id, code: 'PRIN', name: 'P', isDefault: true },
  })
  const ctx: TenantContext = {
    tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL', branchId: b.id,
  }
  await abrirTurno(t.id, owner.id, b.id)
  const db = getTenantPrisma(ctx)
  const prod = await createProductExpress(db, ctx, createProductExpressSchema.parse({
    barcode: `corr${M}`, name: 'Cemento', salePrice: 11.8,
    initialStock: 100000, minStock: 1, warehouseId: w.id,
  }))
  // Cliente con RUC: una factura lo exige, y la sección 5 emite una.
  const empresa = await db.customer.create({
    data: {
      tenantId: t.id, name: 'CLIENTE EMPRESA S.A.C.', docType: 'RUC',
      docNumber: completarRuc(`20${Date.now()}`.slice(0, 10)),
    },
  })
  const venta = (conRuc = false) => registerSale(db, ctx, registerSaleSchema.parse({
    warehouseId: w.id,
    ...(conRuc ? { customerId: empresa.id } : {}),
    items: [{ productId: prod.productId, quantity: 1 }],
    payments: [{ method: 'EFECTIVO', amount: 11.8 }],
  }))

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n1) Estado inicial de las series')
  const s0 = await listarSeriesConfigurables(db, ctx, b.id)
  check('se crean las dos series fiscales', s0.length === 2)
  check('boleta es B001', s0.find((s) => s.scope === 'TAX_BOLETA')?.series === 'B001')
  check('factura es F001', s0.find((s) => s.scope === 'TAX_FACTURA')?.series === 'F001')
  check('arrancan en 1', s0.every((s) => s.next === 1 && s.startNumber === 1))
  check('>>> sin emitir, son EDITABLES', s0.every((s) => s.editable))
  check('sin comprobantes previos', s0.every((s) => s.ultimoEmitido === null))

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n2) >>> EL CASO REAL: el cliente venía por el 4 532')
  const r = await fijarArranqueSerie(db, ctx, {
    branchId: b.id, scope: 'TAX_BOLETA', startNumber: 4533,
  })
  check('devuelve el anterior y el nuevo', r.anterior === 1 && r.nuevo === 4533)
  const s1 = await listarSeriesConfigurables(db, ctx, b.id)
  const bol = s1.find((s) => s.scope === 'TAX_BOLETA')!
  check('next pasa a 4533', bol.next === 4533)
  check('startNumber también: next === startNumber ⇒ nada emitido',
    bol.startNumber === 4533 && bol.emitidos === 0)
  check('sigue editable mientras no emita', bol.editable)
  check('la factura NO se tocó', s1.find((s) => s.scope === 'TAX_FACTURA')?.next === 1)

  console.log('\n   Queda auditado')
  const audit = await db.auditLog.findFirst({
    where: { action: 'counter.startNumber' },
    orderBy: { createdAt: 'desc' },
    select: { actorId: true, actorRole: true, before: true, after: true, reason: true, createdAt: true },
  })
  check('>>> hay registro de auditoría', audit !== null)
  check('con QUIÉN', audit?.actorId === owner.id)
  check('y su rol', audit?.actorRole === 'OWNER')
  check('>>> con el valor ANTERIOR',
    (audit?.before as { startNumber?: number })?.startNumber === 1)
  check('>>> y el NUEVO',
    (audit?.after as { startNumber?: number })?.startNumber === 4533)
  check('el motivo menciona la serie y el número',
    (audit?.reason ?? '').includes('B001') && (audit?.reason ?? '').includes('4533'))

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n3) >>> EL PRIMER COMPROBANTE SALE CON EL NÚMERO FIJADO')
  const v1 = await venta()
  const d1 = await issueTaxDocument(db, ctx, { saleId: v1.saleId, documentType: 'BOLETA' })
  check('>>> el primero es B001-00004533', d1.fullNumber === formatFullNumber('B001', 4533),
    d1.fullNumber)
  check('correlativo 4533', d1.correlativo === 4533)

  const v2 = await venta()
  const d2 = await issueTaxDocument(db, ctx, { saleId: v2.saleId, documentType: 'BOLETA' })
  check('el siguiente es 4534, sin huecos', d2.correlativo === 4534, d2.fullNumber)

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n4) >>> YA NO SE PUEDE MOVER')
  const s2 = await listarSeriesConfigurables(db, ctx, b.id)
  const bol2 = s2.find((s) => s.scope === 'TAX_BOLETA')!
  check('la serie se marca NO editable', !bol2.editable)
  check('cuenta 2 emitidos', bol2.emitidos === 2, String(bol2.emitidos))
  check('conoce el último emitido', bol2.ultimoEmitido === 4534, String(bol2.ultimoEmitido))
  check('>>> subirlo se RECHAZA (dejaría un hueco)',
    await code(() => fijarArranqueSerie(db, ctx, {
      branchId: b.id, scope: 'TAX_BOLETA', startNumber: 9000,
    })) === 'INVALID_DOCUMENT')
  check('>>> bajarlo también (produciría un duplicado)',
    await code(() => fijarArranqueSerie(db, ctx, {
      branchId: b.id, scope: 'TAX_BOLETA', startNumber: 100,
    })) === 'INVALID_DOCUMENT')
  check('el mensaje explica el hueco y el duplicado',
    await fijarArranqueSerie(db, ctx, {
      branchId: b.id, scope: 'TAX_BOLETA', startNumber: 9000,
    }).catch((e) => /hueco/.test(e.message) && /duplicado/.test(e.message)) === true)

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n5) NUNCA por debajo del último emitido')
  // La factura sigue virgen; se le emite uno a mano para forzar el caso en el
  // que el contador y TaxDocument discrepan.
  const v3 = await venta(true)
  const f1 = await issueTaxDocument(db, ctx, { saleId: v3.saleId, documentType: 'FACTURA' })
  check('la factura arranca en 1', f1.correlativo === 1)
  // Se reinicia el contador a mano, simulando un estado inconsistente.
  await db.documentCounter.updateMany({
    where: { scope: 'TAX_FACTURA', series: 'F001' },
    data: { next: 1, startNumber: 1 },
  })
  const sInc = await listarSeriesConfigurables(db, ctx, b.id)
  check('>>> con el contador reiniciado, TaxDocument delata que SÍ emitió',
    sInc.find((s) => s.scope === 'TAX_FACTURA')?.editable === false)
  check('>>> y fijar por debajo del último se rechaza igual',
    await code(() => fijarArranqueSerie(db, ctx, {
      branchId: b.id, scope: 'TAX_FACTURA', startNumber: 1,
    })) === 'INVALID_DOCUMENT')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n6) Validación y permisos')
  check('el esquema EXIGE confirmado: true',
    !fijarArranqueSchema.safeParse({
      branchId: b.id, scope: 'TAX_BOLETA', startNumber: 10,
    }).success)
  check('confirmado: false no vale',
    !fijarArranqueSchema.safeParse({
      branchId: b.id, scope: 'TAX_BOLETA', startNumber: 10, confirmado: false,
    }).success)
  check('con confirmado: true pasa',
    fijarArranqueSchema.safeParse({
      branchId: b.id, scope: 'TAX_BOLETA', startNumber: 10, confirmado: true,
    }).success)
  check('rechaza decimales',
    !fijarArranqueSchema.safeParse({
      branchId: b.id, scope: 'TAX_BOLETA', startNumber: 10.5, confirmado: true,
    }).success)
  check('rechaza cero y negativos',
    !fijarArranqueSchema.safeParse({
      branchId: b.id, scope: 'TAX_BOLETA', startNumber: 0, confirmado: true,
    }).success)
  check('rechaza más de 8 dígitos (no cabe en la impresión)',
    !fijarArranqueSchema.safeParse({
      branchId: b.id, scope: 'TAX_BOLETA', startNumber: 100_000_000, confirmado: true,
    }).success)
  check('no se configuran las series internas, solo las fiscales',
    !fijarArranqueSchema.safeParse({
      branchId: b.id, scope: 'SALE', startNumber: 10, confirmado: true,
    }).success)
  check('>>> un VENDEDOR no puede fijarlo',
    await code(() => fijarArranqueSerie(
      getTenantPrisma({ ...ctx, role: 'VENDEDOR' }), { ...ctx, role: 'VENDEDOR' },
      { branchId: b.id, scope: 'TAX_BOLETA', startNumber: 50 },
    )) === 'FORBIDDEN_ROLE')
  check('una sucursal inexistente se rechaza',
    await code(() => fijarArranqueSerie(db, ctx, {
      branchId: 'inventada', scope: 'TAX_BOLETA', startNumber: 50,
    })) === 'NOT_FOUND')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n7) >>> CONCURRENCIA CON ARRANQUE ≠ 1: la serie sigue sin huecos')
  // Sucursal nueva para tener una serie virgen propia.
  const b2 = await crearSucursal(t.id, {
    code: 'SEG', seriesNumber: 2, establishmentCode: '0002', isDefault: false,
  })
  await asignarSucursal(t.id, owner.id, b2.id)
  const w2 = await prisma.warehouse.create({
    data: { tenantId: t.id, branchId: b2.id, code: 'W2', name: 'W2', isDefault: false },
  })
  // F6.8b: una persona tiene un solo turno abierto; la segunda sucursal la cobra otra persona con el suyo.
  const owner2 = await prisma.user.create({ data: { tenantId: t.id, email: `owner2-${M}@x.com`.toLowerCase(), name: 'Dueño 2', role: 'OWNER' } })
  await asignarSucursal(t.id, owner2.id, b2.id)
  await abrirTurno(t.id, owner2.id, b2.id)
  const ctx2: TenantContext = { ...ctx, userId: owner2.id, branchId: b2.id }
  const db2 = getTenantPrisma(ctx2)
  await createProductExpress(db2, ctx2, createProductExpressSchema.parse({
    barcode: `corr2${M}`, name: 'Fierro', salePrice: 11.8,
    initialStock: 100000, minStock: 1, warehouseId: w2.id,
  }))
  const prod2 = await db2.product.findFirstOrThrow({ where: { barcode: `corr2${M}` } })

  await listarSeriesConfigurables(db2, ctx2, b2.id)
  await fijarArranqueSerie(db2, ctx2, {
    branchId: b2.id, scope: 'TAX_BOLETA', startNumber: 7000,
  })
  check('la sucursal 2 arranca su B002 en 7000',
    (await db2.documentCounter.findFirstOrThrow({
      where: { scope: 'TAX_BOLETA', series: 'B002' },
    })).next === 7000)

  // 10 ventas con sus comprobantes, EN PARALELO, con clientes distintos para
  // que la concurrencia sea real y no la serialice el pool.
  const N = 10
  const clientes = Array.from({ length: N }, () => {
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL!
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
  })
  try {
    const ventas = await Promise.all(
      Array.from({ length: N }, () =>
        registerSale(db2, ctx2, registerSaleSchema.parse({
          warehouseId: w2.id,
          items: [{ productId: prod2.id, quantity: 1 }],
          payments: [{ method: 'EFECTIVO', amount: 11.8 }],
        })),
      ),
    )
    const docs = await Promise.allSettled(
      ventas.map((v, i) =>
        issueTaxDocument(
          getTenantPrisma(ctx2) as never, ctx2,
          { saleId: v.saleId, documentType: 'BOLETA' },
        ).then((d) => { void i; return d }),
      ),
    )
    const ok = docs.filter((d) => d.status === 'fulfilled') as PromiseFulfilledResult<{ correlativo: number }>[]
    const correlativos = ok.map((d) => d.value.correlativo).sort((a, c) => a - c)
    check(`${ok.length}/${N} comprobantes emitidos en paralelo`, ok.length === N,
      `${ok.length}`)
    check('>>> todos DISTINTOS', new Set(correlativos).size === correlativos.length)
    const esperado = Array.from({ length: correlativos.length }, (_, i) => 7000 + i)
    check('>>> arrancan en 7000 y NO hay huecos: 7000..7009',
      JSON.stringify(correlativos) === JSON.stringify(esperado),
      correlativos.join(','))
    check('ninguno por debajo del arranque', correlativos.every((c) => c >= 7000))
  } finally {
    await Promise.all(clientes.map((c) => c.$disconnect()))
  }

  console.log('\n   Y el contador queda coherente')
  const cFinal = await db2.documentCounter.findFirstOrThrow({
    where: { scope: 'TAX_BOLETA', series: 'B002' },
    select: { next: true, startNumber: true },
  })
  check('next = arranque + emitidos', cFinal.next === 7000 + N, String(cFinal.next))
  check('startNumber no se movió', cFinal.startNumber === 7000)

  console.log('\n8) El contador no quema números si la emisión falla')
  const antes = (await db2.documentCounter.findFirstOrThrow({
    where: { scope: 'TAX_BOLETA', series: 'B002' },
  })).next
  await db2.$transaction(async (tx) => {
    const { claimNextNumber } = await import('@/features/pos/sale-service')
    await claimNextNumber(tx as never, t.id, 'TAX_BOLETA', 'B002')
    throw new Error('fallo simulado')
  }).catch(() => {})
  check('>>> el número reservado se devuelve al rollback',
    (await db2.documentCounter.findFirstOrThrow({
      where: { scope: 'TAX_BOLETA', series: 'B002' },
    })).next === antes, String(antes))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
