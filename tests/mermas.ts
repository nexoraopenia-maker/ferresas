import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { createStockMovement } from '../src/features/inventory/stock-service'
import { solicitarMerma, resolverMerma, contarMermasPendientes } from '../src/features/inventory/merma-service'
import { solicitarMermaSchema, resolverMermaSchema } from '../src/features/inventory/merma-schemas'
import { createStockMovementSchema } from '../src/features/inventory/schemas'
import type { TenantContext } from '../src/lib/tenant-context'
import { RAIZ, abrir, cadenas, proyecto } from './ast'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? String(e))

type Rol = 'OWNER' | 'ADMIN' | 'ALMACENERO' | 'VENDEDOR'

async function negocio(etiqueta: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({
    data: { slug: `mm-${etiqueta}-${randomUUID().slice(0, 6)}`, name: `Merma ${etiqueta}`, planId: plan.id },
  })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const ctxs = {} as Record<Rol, TenantContext>
  for (const role of ['OWNER', 'ADMIN', 'ALMACENERO', 'VENDEDOR'] as Rol[]) {
    const u = await prisma.user.create({
      data: { email: `${role}-${randomUUID()}@x.com`, name: role, role, tenantId: t.id },
    })
    await asignarSucursal(t.id, u.id, branch.id)
    ctxs[role] = { tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branch.id }
  }
  const dbOwner = getTenantPrisma(ctxs.OWNER)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: `M-${etiqueta}`, name: `Cable ${etiqueta}` } })
  await createStockMovement(dbOwner, ctxs.OWNER, createStockMovementSchema.parse({
    type: 'ENTRADA', productId: prod.id, warehouseId: w.id, quantity: 20, unitCost: 1,
  }))
  const db = (r: Rol) => getTenantPrisma(ctxs[r])
  return { t, w, ctxs, db, prod }
}

async function main() {
  const A = await negocio('A')
  const B = await negocio('B')
  const stockDe = async (n: typeof A) =>
    Number((await prisma.stock.findFirstOrThrow({ where: { productId: n.prod.id } })).quantity)
  const pedir = (n: typeof A, rol: Rol, q = 3) =>
    solicitarMerma(n.db(rol), n.ctxs[rol], solicitarMermaSchema.parse({
      warehouseId: n.w.id, productId: n.prod.id, quantity: q, reason: 'Se cayó el rollo y quedó inservible',
    }))

  console.log('\n1) Solicitar: el stock NO se mueve')
  const m1 = await pedir(A, 'ALMACENERO')
  check('ALMACENERO la solicita: queda PENDIENTE', m1.status === 'PENDIENTE')
  check('>>> el stock sigue en 20', (await stockDe(A)) === 20)
  check('>>> VENDEDOR no puede solicitar', await code(pedir(A, 'VENDEDOR')) === 'FORBIDDEN_ROLE')
  check('el contador de pendientes ve 1', (await contarMermasPendientes(A.db('OWNER'))) === 1)

  console.log('\n2) Resolver')
  const res = (n: typeof A, rol: Rol, id: string, d: 'APROBAR' | 'RECHAZAR' = 'APROBAR') =>
    resolverMerma(n.db(rol), n.ctxs[rol], resolverMermaSchema.parse(
      d === 'APROBAR' ? { mermaId: id, decision: 'APROBAR' } : { mermaId: id, decision: 'RECHAZAR', rejectReason: 'No procede' }))
  check('>>> ALMACENERO no puede aprobar', await code(res(A, 'ALMACENERO', m1.id)) === 'FORBIDDEN_ROLE')
  const mOwn = await pedir(A, 'OWNER', 1)
  check('>>> quien la pidió no la aprueba (ni siendo OWNER)', await code(res(A, 'OWNER', mOwn.id)) === 'FORBIDDEN_ROLE')
  const r1 = await res(A, 'ADMIN', m1.id)
  check('ADMIN aprueba', r1.status === 'APROBADA')
  check('>>> el stock bajó a 17', (await stockDe(A)) === 17, String(await stockDe(A)))
  const mov = await prisma.stockMovement.findFirst({ where: { productId: A.prod.id, type: 'MERMA', reason: { contains: 'inservible' } } })
  check('hay un movimiento MERMA en el ledger', mov !== null && Number(mov.quantity) === -3, String(mov?.quantity))
  check('>>> aprobar dos veces no descuenta dos veces',
    await code(res(A, 'OWNER', m1.id)) === 'INVALID_DOCUMENT' && (await stockDe(A)) === 17)
  const rr = await res(A, 'ADMIN', mOwn.id, 'RECHAZAR')
  check('rechazar no mueve el stock', rr.status === 'RECHAZADA' && (await stockDe(A)) === 17)

  console.log('\n3) >>> AISLAMIENTO entre negocios')
  const mB = await pedir(B, 'ALMACENERO', 2)
  check('B tiene su merma pendiente', (await contarMermasPendientes(B.db('OWNER'))) === 1)
  check('>>> A no ve las mermas de B',
    (await A.db('OWNER').merma.findMany({ where: { id: mB.id } })).length === 0)
  check('>>> el contador de A no cuenta las de B', (await contarMermasPendientes(A.db('OWNER'))) === 0)
  check('>>> ADMIN de A no puede resolver la merma de B (NOT_FOUND)',
    await code(res(A, 'ADMIN', mB.id)) === 'NOT_FOUND')
  check('>>> y el stock de B no se tocó', (await stockDe(B)) === 20)
  check('>>> A no puede solicitar sobre el producto/almacén de B',
    await code(solicitarMerma(A.db('ALMACENERO'), A.ctxs.ALMACENERO, solicitarMermaSchema.parse({
      warehouseId: B.w.id, productId: B.prod.id, quantity: 1, reason: 'intento cruzado entre negocios',
    }))) !== null)

  console.log('\n4) >>> Todo modelo con tenantId está clasificado en el cliente aislado')
  const schema = readFileSync(join(RAIZ, 'prisma/schema.prisma'), 'utf8')
  const conTenant: string[] = []
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    if (/^\s+tenantId\s+String/m.test(m[2]!)) conTenant.push(m[1]!)
  }
  const proj = proyecto()
  const clasificados = new Set(cadenas(abrir(proj, 'src/lib/tenant-prisma.ts')))
  const sinClasificar = conTenant.filter((m) => !clasificados.has(m))
  check('>>> ningún modelo con tenantId queda fuera de TENANT_SCOPED',
    sinClasificar.length === 0, sinClasificar.join(', '))

  await prisma.tenant.deleteMany({ where: { id: { in: [A.t.id, B.t.id] } } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
