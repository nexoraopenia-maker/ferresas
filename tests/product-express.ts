import './guard'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { createProductExpress } from '@/features/inventory/product-service'
import { createProductExpressSchema } from '@/features/inventory/schemas'
import type { TenantContext } from '@/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const parse = (i: unknown) => createProductExpressSchema.parse(i)

async function nuevoTenant(planCode: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: planCode } })
  const t = await prisma.tenant.create({
    data: { slug: `f-${randomUUID().slice(0, 8)}`, name: 'Test', planId: plan.id },
  })
  const u = await prisma.user.create({
    data: { email: `u-${randomUUID()}@x.com`, name: 'U', role: 'ALMACENERO', tenantId: t.id },
  })
  const w = await prisma.warehouse.create({
    data: { tenantId: t.id, code: 'PRIN', name: 'Principal', isDefault: true },
  })
  const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'ALMACENERO', access: 'FULL' }
  return { t, u, w, ctx, db: getTenantPrisma(ctx), plan }
}

async function main() {
  console.log('\n1) Validación Zod del alta exprés')
  check('exige nombre de al menos 2 caracteres',
    !createProductExpressSchema.safeParse({ name: 'a', salePrice: 1, warehouseId: 'w' }).success)
  check('rechaza precio negativo',
    !createProductExpressSchema.safeParse({ name: 'Martillo', salePrice: -5, warehouseId: 'w' }).success)
  check('rechaza stock inicial negativo',
    !createProductExpressSchema.safeParse({ name: 'Martillo', salePrice: 1, initialStock: -1, warehouseId: 'w' }).success)
  check('stock inicial 0 es válido (aún no llega la mercadería)',
    createProductExpressSchema.safeParse({ name: 'Martillo', salePrice: 1, initialStock: 0, warehouseId: 'w' }).success)
  check('el input NO admite tenantId del cliente',
    !('tenantId' in (createProductExpressSchema.safeParse(
      { name: 'Martillo', salePrice: 1, warehouseId: 'w', tenantId: 'ajeno' }) as any).data))

  console.log('\n2) Creación atómica: producto + stock + ledger + auditoría')
  const A = await nuevoTenant('pro')
  const r = await createProductExpress(A.db, A.ctx, parse({
    barcode: '7501234567890', name: 'Cemento Sol 42.5 kg', salePrice: 32.5,
    initialStock: 40, minStock: 10, unitType: 'BOLSA', warehouseId: A.w.id,
  }))
  check('devuelve el producto creado', r.name === 'Cemento Sol 42.5 kg' && !r.alreadyExisted)
  check('usa el código de barras como SKU si no se da uno', r.sku === '7501234567890')
  check('el stock nace con el conteo inicial', r.quantity === 40)
  check('insertó el movimiento INICIAL',
    (await A.db.stockMovement.count({ where: { productId: r.productId, type: 'INICIAL' } })) === 1)
  const suma = await A.db.stockMovement.aggregate({
    where: { productId: r.productId }, _sum: { quantity: true },
  })
  check('SUM(ledger) reconcilia con el stock desde el minuto cero',
    Number(suma._sum.quantity) === 40)
  check('quedó auditado',
    (await A.db.auditLog.count({ where: { action: 'product.create.express' } })) === 1)
  check('el tenantId es el de la sesión',
    (await A.db.product.findFirstOrThrow({ where: { id: r.productId } })).tenantId === A.t.id)

  console.log('\n3) Stock inicial 0: producto sin movimiento')
  const sin = await createProductExpress(A.db, A.ctx, parse({
    name: 'Silicona', salePrice: 12, initialStock: 0, warehouseId: A.w.id,
  }))
  check('crea la fila de Stock igual', sin.quantity === 0)
  check('NO inserta movimiento si no hay nada que mover',
    (await A.db.stockMovement.count({ where: { productId: sin.productId } })) === 0)
  check('genera SKU automático sin código de barras', /^SKU-[0-9A-F]{8}$/.test(sin.sku))

  console.log('\n4) Código repetido: continúa en vez de bloquear')
  const rep = await createProductExpress(A.db, A.ctx, parse({
    barcode: '7501234567890', name: 'Otro nombre', salePrice: 99, warehouseId: A.w.id,
  }))
  check('devuelve el producto existente', rep.productId === r.productId)
  check('lo marca con alreadyExisted', rep.alreadyExisted === true)
  check('trae su stock real para seguir operando', rep.quantity === 40)
  check('NO duplicó el producto',
    (await A.db.product.count({ where: { barcode: '7501234567890' } })) === 1)

  console.log('\n5) Límite de plan maxProducts (§5.2)')
  const B = await nuevoTenant('basico') // 500 productos
  await prisma.plan.update({ where: { code: 'basico' }, data: { maxProducts: 2 } })
  await createProductExpress(B.db, B.ctx, parse({ name: 'P1', salePrice: 1, warehouseId: B.w.id }))
  await createProductExpress(B.db, B.ctx, parse({ name: 'P2', salePrice: 1, warehouseId: B.w.id }))
  const lim = await createProductExpress(B.db, B.ctx, parse({
    name: 'P3', salePrice: 1, warehouseId: B.w.id,
  })).then(() => null).catch((e) => e)
  check('el tercero se rechaza', lim?.code === 'PLAN_LIMIT_REACHED')
  check('el mensaje nombra el plan y el límite', /Básico/.test(lim?.message) && /2 productos/.test(lim?.message), lim?.message)
  check('no filtra tenantId en los detalles', !JSON.stringify(lim?.details ?? {}).includes(B.t.id))
  check('no quedó producto fantasma tras el rechazo',
    (await B.db.product.count()) === 2)
  await prisma.plan.update({ where: { code: 'basico' }, data: { maxProducts: 500 } })

  console.log('\n6) La suscripción manda sobre el plan cacheado en Tenant')
  const C = await nuevoTenant('premium') // ilimitado en Tenant.plan
  const basico = await prisma.plan.findUniqueOrThrow({ where: { code: 'basico' } })
  await prisma.subscription.create({
    data: { tenantId: C.t.id, planId: basico.id, status: 'ACTIVE' },
  })
  await prisma.plan.update({ where: { code: 'basico' }, data: { maxProducts: 1 } })
  await createProductExpress(C.db, C.ctx, parse({ name: 'Q1', salePrice: 1, warehouseId: C.w.id }))
  const sub = await createProductExpress(C.db, C.ctx, parse({
    name: 'Q2', salePrice: 1, warehouseId: C.w.id,
  })).then(() => null).catch((e) => e)
  check('aplica el límite de la SUSCRIPCIÓN, no el del Tenant',
    sub?.code === 'PLAN_LIMIT_REACHED', sub?.message ?? 'no bloqueó')
  await prisma.plan.update({ where: { code: 'basico' }, data: { maxProducts: 500 } })

  console.log('\n7) Autorización y suscripción')
  const vendedorCtx: TenantContext = { ...A.ctx, role: 'VENDEDOR' }
  const rol = await createProductExpress(getTenantPrisma(vendedorCtx), vendedorCtx, parse({
    name: 'No', salePrice: 1, warehouseId: A.w.id,
  })).then(() => null).catch((e) => e)
  check('VENDEDOR no puede crear productos', rol?.code === 'FORBIDDEN_ROLE')
  const roCtx: TenantContext = { ...A.ctx, access: 'READ_ONLY' }
  const ro = await createProductExpress(getTenantPrisma(roCtx), roCtx, parse({
    name: 'No', salePrice: 1, warehouseId: A.w.id,
  })).then(() => null).catch((e) => e)
  check('suscripción READ_ONLY bloquea la creación', ro?.code === 'SUBSCRIPTION_READ_ONLY')

  console.log('\n8) Aislamiento: el almacén de otro tenant no sirve')
  const D = await nuevoTenant('pro')
  const cruce = await createProductExpress(A.db, A.ctx, parse({
    name: 'Cruzado', salePrice: 1, warehouseId: D.w.id,
  })).then(() => null).catch((e) => e)
  check('rechaza un warehouseId ajeno', cruce?.code === 'TENANT_MISMATCH')
  check('no creó nada en el tenant vecino', (await D.db.product.count()) === 0)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
