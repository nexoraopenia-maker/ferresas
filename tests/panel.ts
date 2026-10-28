import './guard'
import { correr } from './teardown'
import { crearSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { alertasDeStock, rendimientoDeCaja, resumenDeVentas } from '../src/features/dashboard/service'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))

// Martes 20/oct/2026, 8 p. m. en Lima = miércoles 21 01:00 UTC.
const AHORA = new Date('2026-10-21T01:00:00Z')
const lima = (iso: string) => new Date(`${iso}-05:00`)

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({
    data: { slug: `pn-${randomUUID().slice(0, 8)}`, name: 'Panel Test', planId: plan.id },
  })
  const bA = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const bB = await crearSucursal(t.id, { code: 'SUR', name: 'Sur', seriesNumber: 2, isDefault: false, establishmentCode: '0001' })
  const wA = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WA', name: 'A', isDefault: true } })
  const wB = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bB.id, code: 'WB', name: 'B', isDefault: true } })
  const mk = (role: Role) =>
    prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
  const [owner, contador, almacenero] = await Promise.all([mk('OWNER'), mk('CONTADOR'), mk('ALMACENERO')])
  const ctx = (u: { id: string }, role: Role, branchIds: string[]): TenantContext =>
    ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branchIds[0], branchIds })
  const cOwner = ctx(owner, 'OWNER', [bA.id, bB.id])
  const cContA = ctx(contador, 'CONTADOR', [bA.id])
  const cAlm = ctx(almacenero, 'ALMACENERO', [bA.id])
  const dbOwner = getTenantPrisma(cOwner)

  const prodX = await prisma.product.create({ data: { tenantId: t.id, sku: 'CEM', name: 'Cemento', minStock: 10 } })
  const prodY = await prisma.product.create({ data: { tenantId: t.id, sku: 'CLA', name: 'Clavos', minStock: 10 } })

  let n = 0
  const venta = async (branchId: string, warehouseId: string, cuando: Date, total: number, items: [typeof prodX, number, number][], status: 'COMPLETADA' | 'ANULADA' = 'COMPLETADA') => {
    const s = await prisma.sale.create({
      data: { tenantId: t.id, branchId, warehouseId, userId: owner.id, number: `V-${++n}`, status, total, completedAt: cuando, ...(status === 'ANULADA' ? { voidedAt: cuando, voidReason: 'Prueba' } : {}) },
    })
    for (const [p, q, lt] of items) {
      await prisma.saleItem.create({
        data: { tenantId: t.id, saleId: s.id, productId: p.id, nameSnapshot: p.name, skuSnapshot: p.sku, quantity: q, unitPrice: lt / q, lineTotal: lt },
      })
    }
  }
  await venta(bA.id, wA.id, lima('2026-10-20T10:00:00'), 100, [[prodX, 4, 100]])
  await venta(bA.id, wA.id, lima('2026-10-20T19:30:00'), 50, [[prodY, 10, 50]])
  await venta(bB.id, wB.id, lima('2026-10-20T11:00:00'), 200, [[prodX, 8, 200]])
  await venta(bA.id, wA.id, lima('2026-10-20T12:00:00'), 999, [[prodX, 1, 999]], 'ANULADA')
  await venta(bA.id, wA.id, lima('2026-10-19T09:00:00'), 30, [[prodY, 3, 30]])
  await venta(bA.id, wA.id, lima('2026-10-18T09:00:00'), 20, [[prodY, 2, 20]])
  await venta(bA.id, wA.id, lima('2026-09-30T20:00:00'), 7, [[prodY, 1, 7]])

  console.log('\n1) Totales por periodo (zona del negocio)')
  const r = await resumenDeVentas(dbOwner, cOwner, AHORA)
  check('>>> HOY suma lo de las 10:00 y lo de las 19:30 (ya es «mañana» en UTC): 100+50+200 = 350',
    r.hoy.total === 350 && r.hoy.ventas === 3, JSON.stringify(r.hoy))
  check('>>> las anuladas NO cuentan', r.hoy.total !== 350 + 999)
  check('el ticket promedio es total/ventas', r.hoy.ticketPromedio === 116.67, String(r.hoy.ticketPromedio))
  check('>>> la SEMANA empieza el lunes 19: 350 + 30 = 380 (el domingo 18 queda fuera)', r.semana.total === 380, String(r.semana.total))
  check('>>> el MES empieza el 1/oct: 350 + 30 + 20 = 400 (lo del 30/sep no entra)', r.mes.total === 400, String(r.mes.total))
  check('el gráfico trae 7 días, el último es hoy',
    r.ultimos7.length === 7 && r.ultimos7[6]!.dia === '2026-10-20' && r.ultimos7[6]!.total === 350)
  check('el domingo 18 aparece en el gráfico con sus 20', r.ultimos7.find((d) => d.dia === '2026-10-18')?.total === 20)

  console.log('\n2) Productos más vendidos del mes')
  check('>>> ordenados por importe: Cemento 300, Clavos 100',
    r.topProductos[0]?.nombre === 'Cemento' && r.topProductos[0].total === 300 &&
    r.topProductos[1]?.nombre === 'Clavos' && r.topProductos[1].total === 100,
    JSON.stringify(r.topProductos.map((p) => [p.nombre, p.total])))
  check('con su cantidad', r.topProductos[0]?.cantidad === 12)
  check('>>> el resumen NO contiene costos ni márgenes', !/cost|margen|margin/i.test(JSON.stringify(r)))

  console.log('\n3) >>> Alcance por sucursal y permisos')
  const dbCont = getTenantPrisma(cContA)
  const rA = await resumenDeVentas(dbCont, cContA, AHORA)
  check('el contador de la sucursal A NO suma lo de B: hoy 150 (no 350)', rA.hoy.total === 150, String(rA.hoy.total))
  check('>>> ni el ranking: Cemento 100 (no 300)', rA.topProductos.find((p) => p.nombre === 'Cemento')?.total === 100,
    JSON.stringify(rA.topProductos.map((p) => [p.nombre, p.total])))
  check('>>> el ALMACENERO no puede ver ventas',
    await code(resumenDeVentas(getTenantPrisma(cAlm), cAlm, AHORA)) === 'FORBIDDEN_ROLE')
  check('>>> ni el rendimiento de caja', await code(rendimientoDeCaja(getTenantPrisma(cAlm), cAlm, AHORA)) === 'FORBIDDEN_ROLE')

  console.log('\n4) Caja')
  await prisma.cashSession.create({ data: { tenantId: t.id, branchId: bA.id, openedById: owner.id, openingAmount: 100, openedAt: lima('2026-10-20T08:00:00'), salesTotal: 150 } })
  await prisma.cashSession.create({
    data: { tenantId: t.id, branchId: bB.id, openedById: owner.id, openingAmount: 50, openedAt: lima('2026-10-20T08:00:00'),
      status: 'CERRADA', closedAt: lima('2026-10-20T18:00:00'), difference: -5, salesTotal: 200 },
  })
  await prisma.cashSession.create({
    data: { tenantId: t.id, branchId: bB.id, openedById: owner.id, openingAmount: 50, openedAt: lima('2026-10-10T08:00:00'),
      status: 'CERRADA', closedAt: lima('2026-10-10T18:00:00'), difference: -99, salesTotal: 1 },
  })
  const caja = await rendimientoDeCaja(dbOwner, cOwner, AHORA)
  check('1 caja abierta ahora', caja.abiertos.length === 1 && caja.abiertos[0]!.ventas === 150)
  check('>>> el descuadre de HOY suma solo los cierres de hoy: -5 (no -104)', caja.descuadreHoy === -5, String(caja.descuadreHoy))
  const cajaA = await rendimientoDeCaja(dbCont, cContA, AHORA)
  check('>>> el contador de A no ve la caja de B', cajaA.cerradosHoy.length === 0 && cajaA.abiertos.length === 1)

  console.log('\n5) Alertas de stock')
  const prodZ = await prisma.product.create({ data: { tenantId: t.id, sku: 'SIN', name: 'Sin umbral', minStock: 0 } })
  const prodW = await prisma.product.create({ data: { tenantId: t.id, sku: 'OK', name: 'Sobrado', minStock: 5 } })
  await prisma.product.create({ data: { tenantId: t.id, sku: 'SRV', name: 'Servicio', minStock: 5, trackStock: false } })
  const stock = (productId: string, warehouseId: string, quantity: number) =>
    prisma.stock.create({ data: { tenantId: t.id, productId, warehouseId, quantity } })
  await stock(prodX.id, wA.id, 4)
  await stock(prodX.id, wB.id, 500)
  await stock(prodZ.id, wA.id, 2)
  await stock(prodW.id, wA.id, 50)
  const alA = await alertasDeStock(dbCont, cContA)
  check('>>> el crítico de A no queda tapado por el stock de B',
    alA.items.some((a) => a.productId === prodX.id && a.estado === 'LOW'))
  check('un producto sin ninguna existencia es AGOTADO', alA.items.some((a) => a.productId === prodY.id && a.estado === 'OUT'))
  check('>>> los agotados van PRIMERO', alA.items[0]?.estado === 'OUT')
  check('mínimo 0 = sin umbral: no alerta', !alA.items.some((a) => a.productId === prodZ.id))
  check('sobre su mínimo: no alerta', !alA.items.some((a) => a.productId === prodW.id))
  check('lo que no lleva control de stock no alerta', !alA.items.some((a) => a.sku === 'SRV'))
  check('los contadores coinciden con el listado', alA.agotados === 1 && alA.criticos === 1, JSON.stringify([alA.agotados, alA.criticos]))
  const alOwner = await alertasDeStock(dbOwner, cOwner)
  // F6.6a: el criterio es por ALMACÉN (con herencia de umbrales). Antes se sumaban las sucursales y los 500 de B tapaban el faltante de A.
  check('>>> el dueño, que ve A y B, ve el crítico de A aunque B tenga 500 (ya no se suman) y B no alerta', alOwner.items.some((a) => a.productId === prodX.id && a.warehouseId === wA.id && a.estado === 'LOW') && !alOwner.items.some((a) => a.productId === prodX.id && a.warehouseId === wB.id))
  const sinLista = await alertasDeStock(dbOwner, cOwner, 0)
  check('el límite acota la lista pero no los contadores', sinLista.items.length === 0 && sinLista.agotados === alOwner.agotados)

  await prisma.tenant.delete({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
