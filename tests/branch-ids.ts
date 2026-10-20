import './guard'
import { correr } from './teardown'
import { crearSucursal, asignarSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { sucursalesPermitidas, resolverSucursalActiva } from '../src/lib/branch-selection'
import type { TenantContext } from '../src/lib/tenant-context'
import { abrir, proyecto } from './ast'
import { SyntaxKind } from 'ts-morph'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))

async function main() {
  console.log('\n1) Función pura: qué sucursales alcanza cada uno')
  const A = { id: 'a', code: 'A', isDefault: true }
  const B = { id: 'b', code: 'B', isDefault: false }
  const C = { id: 'c', code: 'C', isDefault: false }
  check('un usuario normal alcanza solo las asignadas',
    sucursalesPermitidas([A], [A, B, C], false).map((x) => x.id).join() === 'a')
  check('quien gestiona sucursales alcanza TODAS',
    sucursalesPermitidas([A], [A, B, C], true).length === 3)
  check('sin asignaciones y sin gestionar: ninguna',
    sucursalesPermitidas([], [A, B, C], false).length === 0)
  check('la sucursal activa pedida por cookie debe estar entre las permitidas',
    resolverSucursalActiva(sucursalesPermitidas([A], [A, B], false), 'b') === 'a')
  check('el administrador puede operar en una que no tenía asignada',
    resolverSucursalActiva(sucursalesPermitidas([A], [A, B], true), 'b') === 'b')

  console.log('\n2) >>> El cliente aislado filtra por sucursal')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({
    data: { slug: `bi-${randomUUID().slice(0, 8)}`, name: 'Sucursales', planId: plan.id },
  })
  const bA = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const bB = await crearSucursal(t.id, { code: 'SUR', name: 'Sur', seriesNumber: 2, isDefault: false, establishmentCode: '0001' })
  const wA = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WA', name: 'A', isDefault: true } })
  const wB = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bB.id, code: 'WB', name: 'B', isDefault: true } })
  const mk = (role: 'OWNER' | 'VENDEDOR') =>
    prisma.user.create({ data: { email: `${role}-${randomUUID()}@x.com`, name: role, role, tenantId: t.id } })
  const [uOwner, uVendA, uSinSuc] = await Promise.all([mk('OWNER'), mk('VENDEDOR'), mk('VENDEDOR')])
  await asignarSucursal(t.id, uVendA.id, bA.id)

  const venta = (branchId: string, warehouseId: string, n: string) => prisma.sale.create({
    data: { tenantId: t.id, branchId, warehouseId, userId: uOwner.id, number: n },
  })
  const sA = await venta(bA.id, wA.id, 'N-A-1')
  const sB = await venta(bB.id, wB.id, 'N-B-1')
  const cajaB = await prisma.cashSession.create({
    data: { tenantId: t.id, branchId: bB.id, openedById: uOwner.id, openingAmount: 10 },
  })
  const trAB = await prisma.branchTransfer.create({
    data: {
      tenantId: t.id, number: 'T-1', fromBranchId: bA.id, fromWarehouseId: wA.id,
      toBranchId: bB.id, toWarehouseId: wB.id, requestedById: uOwner.id,
    },
  })

  const ctx = (userId: string, role: 'OWNER' | 'VENDEDOR', branchIds?: string[]): TenantContext => ({
    tenantId: t.id, userId, role, access: 'FULL', branchId: branchIds?.[0], branchIds,
  })
  const dbA = getTenantPrisma(ctx(uVendA.id, 'VENDEDOR', [bA.id]))
  const dbOwner = getTenantPrisma(ctx(uOwner.id, 'OWNER', [bA.id, bB.id]))
  const dbNada = getTenantPrisma(ctx(uSinSuc.id, 'VENDEDOR', []))
  const dbLibre = getTenantPrisma(ctx(uOwner.id, 'OWNER', undefined))

  check('VENDEDOR de A ve la venta de A', (await dbA.sale.findMany()).map((s) => s.id).join() === sA.id)
  check('>>> y NO ve la venta de B con findMany', !(await dbA.sale.findMany()).some((s) => s.id === sB.id))
  check('>>> ni con findUnique por id', (await dbA.sale.findUnique({ where: { id: sB.id } })) === null)
  check('>>> ni con findFirst por id', (await dbA.sale.findFirst({ where: { id: sB.id } })) === null)
  check('>>> el count tampoco cuenta lo ajeno', (await dbA.sale.count()) === 1)
  check('>>> no puede actualizar la venta de B',
    await code(dbA.sale.update({ where: { id: sB.id }, data: { notes: 'x' } })) !== null)
  check('la venta de B quedó intacta', (await prisma.sale.findUniqueOrThrow({ where: { id: sB.id } })).notes === null)
  const intento = await code(dbA.sale.create({ data: { tenantId: t.id, branchId: bB.id, warehouseId: wB.id, userId: uVendA.id, number: 'N-X' } }))
  check('>>> no puede crear una venta en B', intento !== null && (await prisma.sale.count({ where: { number: 'N-X' } })) === 0, String(intento))
  check('>>> no ve el turno de caja de B', (await dbA.cashSession.findMany()).length === 0)
  check('el dueño (A y B) ve las dos ventas', (await dbOwner.sale.count()) === 2)
  check('el dueño ve el turno de B', (await dbOwner.cashSession.count()) === 1 && cajaB.id !== '')
  check('>>> sin sucursales no ve NADA', (await dbNada.sale.count()) === 0 && (await dbNada.cashSession.count()) === 0)
  check('contexto sin branchIds (SUPERADMIN, alta) no se restringe', (await dbLibre.sale.count()) === 2)

  console.log('\n3) Transferencias: se ven desde ambos extremos')
  const dbB = getTenantPrisma(ctx(uSinSuc.id, 'VENDEDOR', [bB.id]))
  check('el origen la ve', (await dbA.branchTransfer.count()) === 1)
  check('el destino la ve', (await dbB.branchTransfer.count()) === 1)
  check('una tercera sucursal NO la ve', (await dbNada.branchTransfer.count()) === 0)
  check('el origen puede leerla por id', (await dbA.branchTransfer.findUnique({ where: { id: trAB.id } }))?.id === trAB.id)

  console.log('\n4) >>> AST: los contextos de usuario siempre traen branchIds')
  const sf = abrir(proyecto(), 'src/lib/session.ts')
  const contextos = sf.getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .map((r) => r.getExpressionIfKind(SyntaxKind.ObjectLiteralExpression))
    .filter((o): o is NonNullable<typeof o> => !!o)
    .filter((o) => o.getProperty('branchId') !== undefined)
  const sin = contextos.filter((o) => o.getProperty('branchIds') === undefined)
  check('>>> todo contexto con branchId trae también branchIds (si no, el filtro se apaga)',
    contextos.length >= 2 && sin.length === 0,
    `${contextos.length} contextos; sin branchIds en líneas ${sin.map((o) => o.getStartLineNumber()).join(',')}`)

  await prisma.tenant.delete({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
