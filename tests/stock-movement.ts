import './guard'
import { prisma } from '@/lib/prisma'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { createStockMovement } from '@/features/inventory/stock-service'
import { createStockMovementSchema } from '@/features/inventory/schemas'
import type { TenantContext } from '@/lib/tenant-context'
import { randomUUID } from 'node:crypto'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({
    data: { slug: `f-${randomUUID().slice(0, 8)}`, name: 'Ferretería Test', planId: plan.id },
  })
  const owner = await prisma.user.create({
    data: { email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER', tenantId: t.id },
  })
  const almacenero = await prisma.user.create({
    data: { email: `a-${randomUUID()}@x.com`, name: 'Almacenero', role: 'ALMACENERO', tenantId: t.id },
  })
  const w = await prisma.warehouse.create({
    data: { tenantId: t.id, code: 'PRIN', name: 'Principal', isDefault: true },
  })
  const mkProd = (sku: string, min = 5) =>
    prisma.product.create({ data: { tenantId: t.id, sku, name: sku, minStock: min } })

  const ctxOwner: TenantContext = { tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL' }
  const ctxAlm: TenantContext = { tenantId: t.id, userId: almacenero.id, role: 'ALMACENERO', access: 'FULL' }
  const db = getTenantPrisma(ctxOwner)
  const parse = (i: unknown) => createStockMovementSchema.parse(i)

  console.log('\n1) Validación Zod')
  check('rechaza cantidad negativa en ENTRADA',
    !createStockMovementSchema.safeParse({ type: 'ENTRADA', productId: 'a', warehouseId: 'b', quantity: -1 }).success)
  check('rechaza más de 4 decimales',
    !createStockMovementSchema.safeParse({ type: 'ENTRADA', productId: 'a', warehouseId: 'b', quantity: 1.234567 }).success)
  check('AJUSTE exige motivo',
    !createStockMovementSchema.safeParse({ type: 'AJUSTE', productId: 'a', warehouseId: 'b', quantity: 5, expectedVersion: 0 }).success)
  check('AJUSTE acepta cero (se acabó el producto)',
    createStockMovementSchema.safeParse({ type: 'AJUSTE', productId: 'a', warehouseId: 'b', quantity: 0, reason: 'conteo', expectedVersion: 0 }).success)
  check('el input NO admite tenantId del cliente',
    !('tenantId' in (createStockMovementSchema.safeParse({ type: 'ENTRADA', productId: 'a', warehouseId: 'b', quantity: 1, tenantId: 'otro' }) as any).data))

  console.log('\n2) Entrada / salida / atomicidad stock+ledger')
  const p1 = await mkProd('CEMENTO')
  const r1 = await createStockMovement(db, ctxOwner, parse({
    type: 'ENTRADA', productId: p1.id, warehouseId: w.id, quantity: 100,
  }))
  check('ENTRADA deja balance 100', r1.balanceAfter === 100)
  check('creó la fila de Stock', (await db.stock.count({ where: { productId: p1.id } })) === 1)
  check('insertó el movimiento en el ledger',
    (await db.stockMovement.count({ where: { productId: p1.id } })) === 1)

  const r2 = await createStockMovement(db, ctxOwner, parse({
    type: 'SALIDA', productId: p1.id, warehouseId: w.id, quantity: 30,
  }))
  check('SALIDA deja balance 70', r2.balanceAfter === 70)
  check('el ledger guarda la cantidad SIGNADA',
    (await db.stockMovement.findFirstOrThrow({ where: { id: r2.movementId } })).quantity.toNumber() === -30)

  const suma = await db.stockMovement.aggregate({ where: { productId: p1.id }, _sum: { quantity: true } })
  const real = await db.stock.findFirstOrThrow({ where: { productId: p1.id } })
  check('SUM(ledger) reconcilia con Stock.quantity',
    Number(suma._sum.quantity) === real.quantity.toNumber(), `${suma._sum.quantity} vs ${real.quantity}`)

  console.log('\n3) Stock insuficiente con política BLOQUEAR (por defecto)')
  const err = await createStockMovement(db, ctxOwner, parse({
    type: 'SALIDA', productId: p1.id, warehouseId: w.id, quantity: 999,
  })).then(() => null).catch((e) => e)
  check('lanza INSUFFICIENT_STOCK', err?.code === 'INSUFFICIENT_STOCK')
  check('el mensaje es apto para el usuario final', /stock suficiente/i.test(err?.message ?? ''))
  check('los detalles no filtran tenantId ni ids',
    !JSON.stringify(err?.details ?? {}).includes(t.id), JSON.stringify(err?.details))
  check('el stock NO cambió tras el fallo',
    (await db.stock.findFirstOrThrow({ where: { productId: p1.id } })).quantity.toNumber() === 70)

  console.log('\n4) CONCURRENCIA — 10 salidas simultáneas sobre stock 5 (§8)')
  const p2 = await mkProd('DISCO')
  await createStockMovement(db, ctxOwner, parse({ type: 'ENTRADA', productId: p2.id, warehouseId: w.id, quantity: 5 }))

  const carrera = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      createStockMovement(db, ctxOwner, parse({
        type: 'SALIDA', productId: p2.id, warehouseId: w.id, quantity: 1,
      })),
    ),
  )
  const ok = carrera.filter((r) => r.status === 'fulfilled').length
  const ko = carrera.filter((r) => r.status === 'rejected')
  const finalQty = (await db.stock.findFirstOrThrow({ where: { productId: p2.id } })).quantity.toNumber()
  const movs = await db.stockMovement.count({ where: { productId: p2.id, type: 'SALIDA' } })

  check('exactamente 5 salidas tuvieron éxito', ok === 5, `fueron ${ok}`)
  check('las otras 5 fallaron por stock insuficiente',
    ko.length === 5 && ko.every((r: any) => r.reason?.code === 'INSUFFICIENT_STOCK'))
  check('el stock quedó en 0, NUNCA negativo', finalQty === 0, `quedó en ${finalQty}`)
  check('el ledger tiene 5 salidas, no 10', movs === 5, `tiene ${movs}`)
  const balances = (await db.stockMovement.findMany({
    where: { productId: p2.id, type: 'SALIDA' }, select: { balanceAfter: true },
  })).map((m) => m.balanceAfter.toNumber()).sort((a, b) => a - b)
  check('los balanceAfter son 0,1,2,3,4 sin repetir (sin lecturas sucias)',
    JSON.stringify(balances) === '[0,1,2,3,4]', JSON.stringify(balances))

  console.log('\n5) Política PERMITIR_CON_ADVERTENCIA')
  await prisma.tenant.update({ where: { id: t.id }, data: { stockPolicy: 'PERMITIR_CON_ADVERTENCIA' } })
  const p3 = await mkProd('SILICONA')
  const neg = await createStockMovement(db, ctxOwner, parse({
    type: 'SALIDA', productId: p3.id, warehouseId: w.id, quantity: 3,
  }))
  check('permite quedar en negativo', neg.balanceAfter === -3)
  check('lo marca con wentNegative', neg.wentNegative === true)
  await prisma.tenant.update({ where: { id: t.id }, data: { stockPolicy: 'BLOQUEAR' } })

  console.log('\n6) AJUSTE: bloqueo optimista y auditoría')
  const st1 = await db.stock.findFirstOrThrow({ where: { productId: p1.id } })
  const conflicto = await createStockMovement(db, ctxOwner, parse({
    type: 'AJUSTE', productId: p1.id, warehouseId: w.id, quantity: 50,
    reason: 'conteo físico', expectedVersion: st1.version - 1,
  })).then(() => null).catch((e) => e)
  check('versión vieja -> STOCK_CONFLICT', conflicto?.code === 'STOCK_CONFLICT')

  const aj = await createStockMovement(db, ctxOwner, parse({
    type: 'AJUSTE', productId: p1.id, warehouseId: w.id, quantity: 50,
    reason: 'conteo físico del lunes', expectedVersion: st1.version,
  }))
  check('AJUSTE fija el valor absoluto', aj.balanceAfter === 50)
  check('el ledger registra el DELTA (-20), no el absoluto',
    (await db.stockMovement.findFirstOrThrow({ where: { id: aj.movementId } })).quantity.toNumber() === -20)
  const audit = await db.auditLog.findFirst({ where: { action: 'stock.adjust' }, orderBy: { createdAt: 'desc' } })
  check('quedó auditado con motivo (§6.6)', audit?.reason === 'conteo físico del lunes')
  check('el audit guarda antes y después',
    JSON.stringify(audit?.before) === '{"quantity":70}' && JSON.stringify(audit?.after) === '{"quantity":50}')

  console.log('\n7) Autorización por rol (§6.4)')
  const dbAlm = getTenantPrisma(ctxAlm)
  const rolErr = await createStockMovement(dbAlm, ctxAlm, parse({
    type: 'AJUSTE', productId: p1.id, warehouseId: w.id, quantity: 1,
    reason: 'no debería poder', expectedVersion: 0,
  })).then(() => null).catch((e) => e)
  check('ALMACENERO no puede AJUSTAR', rolErr?.code === 'FORBIDDEN_ROLE')
  const okAlm = await createStockMovement(dbAlm, ctxAlm, parse({
    type: 'ENTRADA', productId: p1.id, warehouseId: w.id, quantity: 1,
  }))
  check('ALMACENERO sí puede dar ENTRADA', okAlm.balanceAfter === 51)

  console.log('\n8) Idempotencia (reintento con mala señal)')
  const p4 = await mkProd('BROCA')
  const key = randomUUID()
  const inp = parse({ type: 'ENTRADA', productId: p4.id, warehouseId: w.id, quantity: 7, idempotencyKey: key })
  const a = await createStockMovement(db, ctxOwner, inp)
  const b = await createStockMovement(db, ctxOwner, inp)
  check('el reintento devuelve el MISMO movimiento', a.movementId === b.movementId)
  check('el reintento se marca replayed', b.replayed === true)
  check('el stock se aplicó UNA sola vez',
    (await db.stock.findFirstOrThrow({ where: { productId: p4.id } })).quantity.toNumber() === 7)
  check('hay un solo movimiento en el ledger',
    (await db.stockMovement.count({ where: { productId: p4.id } })) === 1)

  console.log('\n9) Enforcement de suscripción sobre el movimiento')
  const ro = getTenantPrisma({ ...ctxOwner, access: 'READ_ONLY' })
  const roErr = await createStockMovement(ro, { ...ctxOwner, access: 'READ_ONLY' }, parse({
    type: 'ENTRADA', productId: p1.id, warehouseId: w.id, quantity: 1,
  })).then(() => null).catch((e) => e)
  check('READ_ONLY bloquea el movimiento', roErr?.code === 'SUBSCRIPTION_READ_ONLY')

  console.log('\n10) Contador de uso del período')
  const period = new Date().toISOString().slice(0, 7)
  const usage = await db.usagePeriod.findFirst({ where: { period } })
  check('cuenta los movimientos del mes', (usage?.movementsCount ?? 0) > 0, `${usage?.movementsCount}`)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
