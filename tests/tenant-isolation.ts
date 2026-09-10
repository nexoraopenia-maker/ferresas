import 'dotenv/config'
import { prisma } from '@/lib/prisma'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { computeAccessLevel } from '@/lib/tenant-context'
import type { TenantContext } from '@/lib/tenant-context'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? ` — ${extra}` : ''}`)
}

async function main() {
  const basico = await prisma.plan.findUniqueOrThrow({ where: { code: 'basico' } })

  const mk = async (slug: string) =>
    prisma.tenant.create({ data: { slug, name: slug, planId: basico.id } })

  const A = await mk(`ferre-a-${Date.now()}`)
  const B = await mk(`ferre-b-${Date.now()}`)

  const userA = await prisma.user.create({
    data: { email: `a-${Date.now()}@x.com`, name: 'A', role: 'OWNER', tenantId: A.id },
  })

  const prodB = await prisma.product.create({
    data: { tenantId: B.id, sku: 'MARTILLO-B', name: 'Martillo de B', salePrice: '25.00' },
  })

  const ctxA: TenantContext = { tenantId: A.id, userId: userA.id, role: 'OWNER', access: 'FULL' }
  const db = getTenantPrisma(ctxA)

  console.log('\n1) Lectura cruzada')
  check('findMany de A no ve productos de B', (await db.product.findMany()).length === 0)
  check('findUnique del id de B devuelve null',
    (await db.product.findUnique({ where: { id: prodB.id } })) === null)
  check('count de A ignora a B', (await db.product.count()) === 0)

  console.log('\n2) tenantId falsificado desde el llamador')
  try {
    await db.product.findMany({ where: { tenantId: B.id } })
    check('where.tenantId ajeno debe lanzar', false)
  } catch (e: any) {
    check('where.tenantId ajeno lanza TenantIsolationError', e.code === 'TENANT_MISMATCH')
    check('el mensaje no filtra ids', !e.message.includes(B.id), JSON.stringify(e.message))
  }
  try {
    await db.product.create({ data: { tenantId: B.id, sku: 'X', name: 'X' } as any })
    check('data.tenantId ajeno debe lanzar', false)
  } catch (e: any) {
    check('data.tenantId ajeno lanza TenantIsolationError', e.code === 'TENANT_MISMATCH')
  }

  console.log('\n3) Escritura: inyección automática')
  const creado = await db.product.create({ data: { sku: 'TALADRO-A', name: 'Taladro' } as any })
  check('create inyecta el tenantId de la sesión', creado.tenantId === A.id)
  check('updateMany no alcanza filas de B',
    (await db.product.updateMany({ data: { brand: 'HACKED' } })).count === 1)
  check('producto de B intacto',
    (await prisma.product.findUniqueOrThrow({ where: { id: prodB.id } })).brand === null)
  check('delete del id de B no borra nada',
    await db.product.delete({ where: { id: prodB.id } }).then(() => false).catch(() => true))
  check('producto de B sigue existiendo',
    (await prisma.product.count({ where: { id: prodB.id } })) === 1)

  console.log('\n4) Enforcement de suscripción')
  const ro = getTenantPrisma({ ...ctxA, access: 'READ_ONLY' })
  check('READ_ONLY permite leer', Array.isArray(await ro.product.findMany()))
  try {
    await ro.product.create({ data: { sku: 'NOPE', name: 'Nope' } as any })
    check('READ_ONLY debe bloquear escritura', false)
  } catch (e: any) {
    check('READ_ONLY bloquea escritura', e.code === 'SUBSCRIPTION_READ_ONLY')
  }
  const blocked = getTenantPrisma({ ...ctxA, access: 'BLOCKED' })
  try {
    await blocked.product.create({ data: { sku: 'NOPE2', name: 'Nope' } as any })
    check('BLOCKED debe bloquear escritura', false)
  } catch (e: any) {
    check('BLOCKED bloquea escritura', e.code === 'SUBSCRIPTION_BLOCKED')
  }

  console.log('\n5) Deny by default sobre modelos sin clasificar')
  check('Session no es accesible desde el cliente de tenant',
    await (db as any).session.findMany().then(() => false).catch((e: any) => e.code === 'TENANT_MISMATCH'))
  check('Plan sí se puede leer', (await db.plan.findMany()).length === 3)
  check('Plan no se puede escribir',
    await (db as any).plan.create({ data: { code: 'x', name: 'x', priceMonthly: '1', priceYearly: '1' } })
      .then(() => false).catch((e: any) => e.code === 'TENANT_MISMATCH'))

  console.log('\n6) FK compuesta: la BD rechaza el cruce aunque el código falle')
  // Venta real de A, para que la FK que reviente sea la del PRODUCTO y no la
  // de la venta: es esa la que garantiza el aislamiento entre catálogos.
  const almacenA = await prisma.warehouse.create({
    data: { tenantId: A.id, code: 'PRIN', name: 'Principal' },
  })
  const ventaA = await prisma.sale.create({
    data: { tenantId: A.id, warehouseId: almacenA.id, userId: userA.id, number: 'V-001' },
  })
  const cruce = await prisma.$executeRawUnsafe(
    `INSERT INTO sale_items (id,"tenantId","saleId","productId","nameSnapshot","skuSnapshot",quantity,"unitPrice","lineTotal")
     VALUES ('x','${A.id}','${ventaA.id}','${prodB.id}','n','s',1,1,1)`,
  ).then(() => null).catch((e: any) => e.message as string)
  check('SaleItem de A no puede apuntar a Product de B', cruce !== null)
  check('revienta la FK compuesta de producto, no otra',
    /sale_items_tenantId_productId_fkey/.test(cruce ?? ''), (cruce ?? '').slice(-60))

  console.log('\n7) computeAccessLevel (función pura)')
  const now = new Date('2026-08-24T12:00:00Z')
  const base = { trialEndsAt: null, currentPeriodEnd: null, graceDays: 7, pastDueSince: null }
  check('ACTIVE -> FULL',
    computeAccessLevel({ isActive: true }, { ...base, status: 'ACTIVE' }, now) === 'FULL')
  check('tenant suspendido gana sobre ACTIVE',
    computeAccessLevel({ isActive: false }, { ...base, status: 'ACTIVE' }, now) === 'BLOCKED')
  check('PAST_DUE dentro de gracia -> WARN',
    computeAccessLevel({ isActive: true },
      { ...base, status: 'PAST_DUE', pastDueSince: new Date('2026-08-20T12:00:00Z') }, now) === 'WARN')
  check('PAST_DUE pasada la gracia -> READ_ONLY',
    computeAccessLevel({ isActive: true },
      { ...base, status: 'PAST_DUE', pastDueSince: new Date('2026-08-01T12:00:00Z') }, now) === 'READ_ONLY')
  check('TRIALING vencido -> READ_ONLY',
    computeAccessLevel({ isActive: true },
      { ...base, status: 'TRIALING', trialEndsAt: new Date('2026-08-01T12:00:00Z') }, now) === 'READ_ONLY')
  check('CANCELED -> READ_ONLY',
    computeAccessLevel({ isActive: true }, { ...base, status: 'CANCELED' }, now) === 'READ_ONLY')

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
