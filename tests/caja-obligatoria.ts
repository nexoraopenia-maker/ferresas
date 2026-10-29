import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { closeCashSession, configurarCajaObligatoria, currentCashSession, openCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `co-${tag}-${randomUUID().slice(0, 6)}`, name: `Caja ${tag}`, planId: plan.id } })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const mk = async (role: Role) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, u.id, branch.id)
    const ctx: TenantContext = { tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
    return { ctx, db: getTenantPrisma(ctx) }
  }
  const owner = await mk('OWNER')
  const cajero = await mk('CAJERO')
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Producto', salePrice: 10 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: w.id, quantity: 100 } })
  const vender = (n: typeof owner, metodo: 'EFECTIVO' | 'YAPE') =>
    registerSale(n.db, n.ctx, registerSaleSchema.parse({
      warehouseId: w.id, items: [{ productId: prod.id, quantity: 1 }],
      payments: [{ method: metodo, amount: 10 }], idempotencyKey: randomUUID(),
    }))
  return { t, owner, cajero, prod, w, vender }
}

async function main() {
  console.log('\n1) Declarar el monto es obligatorio')
  check('abrir sin monto inicial es inválido', !openCashSchema.safeParse({}).success)
  check('un monto inicial negativo es inválido', !openCashSchema.safeParse({ openingAmount: -1 }).success)
  check('0 SÍ vale: es una declaración explícita', openCashSchema.safeParse({ openingAmount: 0 }).success)
  check('cerrar sin el conteo es inválido', !closeCashSchema.safeParse({ sessionId: 'x' }).success)
  check('cerrar con el conteo en 0 vale (el cajón está vacío)', closeCashSchema.safeParse({ sessionId: 'x', countedAmount: 0 }).success)

  const A = await negocio('A')
  const B = await negocio('B')

  console.log('\n2) F6.8b: el turno propio es obligatorio SIEMPRE (el ajuste del negocio ya no decide nada)')
  check('>>> sin la política, cobrar sin turno propio se rechaza con CASH_REQUIRED, en efectivo o por Yape',
    await code(A.vender(A.cajero, 'EFECTIVO')) === 'CASH_REQUIRED' && await code(A.vender(A.cajero, 'YAPE')) === 'CASH_REQUIRED')

  console.log('\n3) Solo la administración decide')
  check('>>> el CAJERO no puede activarla', await code(configurarCajaObligatoria(A.cajero.db, A.cajero.ctx, true)) === 'FORBIDDEN_ROLE')
  await configurarCajaObligatoria(A.owner.db, A.owner.ctx, true)
  check('el dueño la activa', (await prisma.tenant.findUniqueOrThrow({ where: { id: A.t.id } })).cashRequired)
  check('queda auditada con el valor anterior',
    JSON.stringify((await prisma.auditLog.findFirst({ where: { tenantId: A.t.id, action: 'caja.obligatoria' } }))?.before).includes('false'))
  await configurarCajaObligatoria(A.owner.db, A.owner.ctx, true)
  check('repetirla no duplica la auditoría', (await prisma.auditLog.count({ where: { tenantId: A.t.id, action: 'caja.obligatoria' } })) === 1)

  console.log('\n4) Con la política activa o no, lo mismo')
  const antes = Number((await prisma.stock.findFirstOrThrow({ where: { productId: A.prod.id } })).quantity)
  check('>>> cobrar sin turno propio se rechaza (también con la política activa)', await code(A.vender(A.cajero, 'EFECTIVO')) === 'CASH_REQUIRED')
  check('>>> y no descontó stock', Number((await prisma.stock.findFirstOrThrow({ where: { productId: A.prod.id } })).quantity) === antes)
  check('>>> por Yape tampoco: ese dinero también tiene que quedar en un turno', await code(A.vender(A.cajero, 'YAPE')) === 'CASH_REQUIRED')
  await openCashSession(A.cajero.db, A.cajero.ctx, openCashSchema.parse({ openingAmount: 50 }))
  const v = await A.vender(A.cajero, 'EFECTIVO')
  check('>>> con el turno propio abierto, el efectivo se cobra', !!v.saleId)
  check('y queda dentro del turno', (await prisma.sale.findUniqueOrThrow({ where: { id: v.saleId } })).cashSessionId !== null)
  check('>>> el turno de otra persona no sirve: el dueño no cobra en el turno del cajero', await code(A.vender(A.owner, 'EFECTIVO')) === 'CASH_REQUIRED')
  const turno = await currentCashSession(A.cajero.db, A.cajero.ctx)
  await closeCashSession(A.cajero.db, A.cajero.ctx, closeCashSchema.parse({ sessionId: turno!.id, countedAmount: 60 }))
  check('>>> al cerrar el turno vuelve a exigirse', await code(A.vender(A.cajero, 'EFECTIVO')) === 'CASH_REQUIRED')

  console.log('\n5) Es por persona y por negocio')
  check('>>> el otro negocio tampoco cobra sin turno', await code(B.vender(B.cajero, 'EFECTIVO')) === 'CASH_REQUIRED')
  await configurarCajaObligatoria(A.owner.db, A.owner.ctx, false)
  check('>>> desactivar el ajuste no devuelve el comportamiento anterior: el turno propio sigue siendo obligatorio', await code(A.vender(A.cajero, 'EFECTIVO')) === 'CASH_REQUIRED')

  await prisma.tenant.deleteMany({ where: { id: { in: [A.t.id, B.t.id] } } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
