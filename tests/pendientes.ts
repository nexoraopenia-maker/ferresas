import './guard'
import { correr } from './teardown'
import { crearSucursal, asignarSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { contarMermasPendientes, listarMermas, resolverMerma, solicitarMerma } from '../src/features/inventory/merma-service'
import { resolverMermaSchema, solicitarMermaSchema } from '../src/features/inventory/merma-schemas'
import { completarCostoEntrada, createStockMovement } from '../src/features/inventory/stock-service'
import { contarCostosPendientes, listarCostosPendientes } from '../src/features/inventory/costos-service'
import { createStockMovementSchema } from '../src/features/inventory/schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `pe-${randomUUID().slice(0, 8)}`, name: 'Pendientes', planId: plan.id } })
  const bA = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const bB = await crearSucursal(t.id, { code: 'SUR', name: 'Sur', seriesNumber: 2, isDefault: false, establishmentCode: '0001' })
  const wA = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WA', name: 'Almacén A', isDefault: true } })
  const wB = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bB.id, code: 'WB', name: 'Almacén B', isDefault: true } })
  const mk = async (role: Role, branches: string[], tag: string) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${tag}-${randomUUID()}@x.com`.toLowerCase(), name: tag, role } })
    for (const b of branches) await asignarSucursal(t.id, u.id, b)
    return u
  }
  const ctxDe = (u: { id: string }, role: Role, branch: string, all = [branch]): TenantContext =>
    ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branch, branchIds: all })
  const alm = await mk('ALMACENERO', [bA.id], 'almacenero')
  const alm2 = await mk('ALMACENERO', [bA.id], 'almacenero2')
  const almB = await mk('ALMACENERO', [bB.id], 'almaceneroB')
  const admin = await mk('ADMIN', [bA.id], 'admin')
  const owner = await mk('OWNER', [bA.id], 'dueno')
  const conta = await mk('CONTADOR', [bA.id], 'contador')
  const cAlm = ctxDe(alm, 'ALMACENERO', bA.id), cAlm2 = ctxDe(alm2, 'ALMACENERO', bA.id), cAlmB = ctxDe(almB, 'ALMACENERO', bB.id)
  const cAd = ctxDe(admin, 'ADMIN', bA.id, [bA.id, bB.id]), cOw = ctxDe(owner, 'OWNER', bA.id, [bA.id, bB.id])
  const cCo = ctxDe(conta, 'CONTADOR', bA.id, [bA.id])
  const g = (c: TenantContext) => getTenantPrisma(c)
  const p = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Cable', salePrice: 5 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: wA.id, quantity: 100 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: wB.id, quantity: 100 } })

  console.log('\n1) Mermas: quién ve qué')
  const pide = (c: TenantContext, wh: string, q: number, extra: Record<string, unknown> = {}) =>
    solicitarMerma(g(c), c, solicitarMermaSchema.parse({ warehouseId: wh, productId: p.id, quantity: q, reason: 'Se cayó el rollo y quedó inservible', ...extra }))
  const m1 = await pide(cAlm, wA.id, 2, { photoUrl: 'https://fotos.test/a.jpg' })
  const m2 = await pide(cAlm2, wA.id, 3)
  const m3 = await pide(cAlmB, wB.id, 4)
  const delAdmin = await listarMermas(g(cAd), cAd)
  check('>>> quien aprueba (ADMIN) ve TODAS las de su sucursal activa y ninguna de la otra', delAdmin.length === 2 && !delAdmin.some((f) => f.id === m3.id))
  const delAlm = await listarMermas(g(cAlm), cAlm)
  check('>>> quien solo solicita ve SOLO las suyas', delAlm.length === 1 && delAlm[0]!.id === m1.id && delAlm[0]!.esMia)
  check('lleva el motivo, la foto y el solicitante', delAlm[0]!.motivo.includes('rollo') && delAlm[0]!.fotoUrl === 'https://fotos.test/a.jpg' && delAlm[0]!.solicitante === 'almacenero')
  check('>>> el CONTADOR no tiene acceso a las mermas', await code(listarMermas(g(cCo), cCo)) === 'FORBIDDEN_ROLE')
  check('el contador del panel cuenta las pendientes de la sucursal (2)', (await contarMermasPendientes(g(cAd), bA.id)) === 2)
  check('y las de la otra sucursal son otra cuenta (1)', (await contarMermasPendientes(g(cAd), bB.id)) === 1)
  check('>>> el administrador ve cuáles son suyas: ninguna', delAdmin.every((f) => !f.esMia))

  console.log('\n2) Resolver')
  await resolverMerma(g(cAd), cAd, resolverMermaSchema.parse({ mermaId: m1.id, decision: 'APROBAR' }))
  await resolverMerma(g(cAd), cAd, resolverMermaSchema.parse({ mermaId: m2.id, decision: 'RECHAZAR', rejectReason: 'Ya estaba descontada' }))
  const trasResolver = await listarMermas(g(cAd), cAd)
  check('>>> el contador baja a 0', (await contarMermasPendientes(g(cAd), bA.id)) === 0)
  const a = trasResolver.find((f) => f.id === m1.id)!, r = trasResolver.find((f) => f.id === m2.id)!
  check('la aprobada dice quién la resolvió y cuándo', a.estado === 'APROBADA' && a.resolvio === 'admin' && a.resueltaEn !== null)
  check('la rechazada guarda el motivo', r.estado === 'RECHAZADA' && r.motivoRechazo === 'Ya estaba descontada')
  const m4 = await pide(cAlm, wA.id, 1)
  const orden = await listarMermas(g(cAd), cAd)
  check('>>> las pendientes salen PRIMERO', orden[0]!.id === m4.id && orden[0]!.estado === 'PENDIENTE')
  check('>>> quien la pidió no puede aprobarla aunque la vea', await code(resolverMerma(g(cAlm), cAlm, resolverMermaSchema.parse({ mermaId: m4.id, decision: 'APROBAR' }))) === 'FORBIDDEN_ROLE')

  console.log('\n3) Costos pendientes')
  const entrada = (c: TenantContext, wh: string, q: number, costo?: number) =>
    createStockMovement(g(c), c, createStockMovementSchema.parse({ type: 'ENTRADA', productId: p.id, warehouseId: wh, quantity: q, ...(costo !== undefined ? { unitCost: costo } : {}) }))
  const e1 = await entrada(cAlm, wA.id, 10)
  const e2 = await entrada(cAlm2, wA.id, 20)
  const eB = await entrada(cAlmB, wB.id, 30)
  await entrada(cOw, wA.id, 5, 8)   // con costo: no queda pendiente
  const lista = await listarCostosPendientes(g(cAd), cAd)
  check('>>> el ADMIN ve las entradas sin costo de sus sucursales (2 de A + 1 de B)', lista.length === 3 && lista.some((f) => f.movementId === eB.movementId))
  check('con producto, cantidad, almacén y quién la registró', lista[0]!.producto === 'Cable' && lista[0]!.cantidad === 10 && lista[0]!.almacen === 'Almacén A' && lista[0]!.registradaPor === 'almacenero')
  check('>>> la que ya tenía costo no aparece', !lista.some((f) => f.cantidad === 5))
  const delConta = await listarCostosPendientes(g(cCo), cCo)
  check('>>> el CONTADOR (solo su sucursal) ve las 2 de A y NO la de B', delConta.length === 2 && !delConta.some((f) => f.movementId === eB.movementId))
  check('>>> el ALMACENERO no puede ver ni contar costos', await code(listarCostosPendientes(g(cAlm), cAlm)) === 'FORBIDDEN_ROLE' && await code(contarCostosPendientes(g(cAlm), cAlm)) === 'FORBIDDEN_ROLE')
  check('el contador del panel cuenta 3', (await contarCostosPendientes(g(cAd), cAd)) === 3)

  console.log('\n4) Completar el costo')
  check('>>> el almacenero no puede completarlo', await code(completarCostoEntrada(g(cAlm), cAlm, e1.movementId, 9)) === 'FORBIDDEN_ROLE')
  await completarCostoEntrada(g(cCo), cCo, e1.movementId, 9.5)
  const fila = await prisma.stockMovement.findUniqueOrThrow({ where: { id: e1.movementId } })
  check('>>> el contador lo completa: costo fijado y deja de estar pendiente', Number(fila.unitCost) === 9.5 && fila.costPending === false)
  check('desaparece de la lista y baja el contador', (await listarCostosPendientes(g(cAd), cAd)).length === 2 && (await contarCostosPendientes(g(cAd), cAd)) === 2)
  check('queda auditado con quién', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'stock.completar_costo', entityId: e1.movementId, actorId: conta.id } })) === 1)
  check('>>> completarlo otra vez no reescribe un costo ya fijado', await code(completarCostoEntrada(g(cCo), cCo, e1.movementId, 1)) === 'NOT_FOUND')
  check('>>> el contador no puede completar una entrada de una sucursal que no alcanza', await code(completarCostoEntrada(g(cCo), cCo, eB.movementId, 7)) === 'NOT_FOUND' && (await prisma.stockMovement.findUniqueOrThrow({ where: { id: eB.movementId } })).costPending === true)
  await completarCostoEntrada(g(cAd), cAd, e2.movementId, 0)
  check('un costo de 0 es válido (mercadería regalada)', (await prisma.stockMovement.findUniqueOrThrow({ where: { id: e2.movementId } })).costPending === false)

  await prisma.tenant.deleteMany({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
