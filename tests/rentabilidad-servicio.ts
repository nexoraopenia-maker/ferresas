import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { parametrosCostosSchema, type ParametrosCostos } from '../src/features/reportes/schemas'
import { ventaSinIgvDeLinea } from '../src/features/reportes/rentabilidad-calculo'
import { exportarCostosCsv, informeAbc, informeInventario, informeMargen } from '../src/features/reportes/rentabilidad-service'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F5.3 · Rentabilidad contra la base. Lo que más importa: SOLO `productos.ver_costo` abre estos reportes (reportes.ver no basta); el margen
 * usa solo líneas con costo real y dice la cobertura; las ventas anuladas/borrador/devueltas y las de fuera del periodo no cuentan; la
 * venta neta suma EXACTAMENTE el subtotal de las ventas; cada quien ve solo sus sucursales; nada se mezcla entre negocios.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const AHORA = new Date('2026-10-27T03:00:00Z')   // lunes 26/10/2026 22:00 en Lima
const P = (o: Partial<ParametrosCostos> = {}): ParametrosCostos => parametrosCostosSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26', ...o })
const r2 = (n: number) => Math.round(n * 100) / 100

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-${tag}-${randomUUID().slice(0, 6)}`, name: `Rentabilidad ${tag}`, taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_rp' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const u: Record<string, { id: string; ctx: TenantContext }> = {}
  for (const [nombre, role] of [['owner', 'OWNER'], ['admin', 'ADMIN'], ['contador', 'CONTADOR'], ['cajero', 'CAJERO'], ['vendedor', 'VENDEDOR'], ['almacenero', 'ALMACENERO']] as [string, Role][]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${nombre}-${randomUUID()}@x.com`.toLowerCase(), name: nombre, role } })
    await asignarSucursal(t.id, x.id, b1.branch.id)
    u[nombre] = { id: x.id, ctx: { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: [] } }
  }
  return { t, b1, b2, u, soloB1: { ...u.admin!.ctx, branchIds: [b1.branch.id] } as TenantContext, db: (c: TenantContext) => getTenantPrisma(c) }
}
type N = Awaited<ReturnType<typeof negocio>>

const producto = (n: N, sku: string, o: { costPrice?: number; trackStock?: boolean; deletedAt?: Date } = {}) =>
  prisma.product.create({ data: { tenantId: n.t.id, sku, name: `Prod ${sku}`, costPrice: o.costPrice ?? 0, salePrice: 100, ...(o.trackStock === false ? { trackStock: false } : {}), ...(o.deletedAt ? { deletedAt: o.deletedAt } : {}) } })

type Linea = { p: { id: string; name: string; sku: string }; qty: number; total: number; costo: number; tasa?: number }
async function venta(n: N, o: { branch?: 'b1' | 'b2'; numero: string; status?: 'COMPLETADA' | 'ANULADA' | 'BORRADOR' | 'DEVUELTA'; completedAt: string | null; lineas: Linea[] }) {
  const b = o.branch === 'b2' ? n.b2 : n.b1
  const neto = o.lineas.reduce((a, l) => a + ventaSinIgvDeLinea(l.total, l.tasa ?? 0.18), 0)
  const total = o.lineas.reduce((a, l) => a + l.total, 0)
  const v = await prisma.sale.create({ data: {
    tenantId: n.t.id, branchId: b.branch.id, warehouseId: b.warehouse.id, userId: n.u.owner!.id, number: o.numero, documentType: 'NOTA_VENTA', status: o.status ?? 'COMPLETADA',
    subtotal: r2(neto), taxTotal: r2(total - neto), total, completedAt: o.completedAt ? new Date(o.completedAt) : null,
  } })
  await prisma.saleItem.createMany({ data: o.lineas.map((l) => ({
    tenantId: n.t.id, saleId: v.id, productId: l.p.id, nameSnapshot: `Viejo ${l.p.name}`, skuSnapshot: `V-${l.p.sku}`, quantity: l.qty, unitPrice: l.total / l.qty, taxRate: l.tasa ?? 0.18, unitCost: l.costo, lineTotal: l.total,
  })) })
  return v
}

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 200) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  console.log('\nA) El escenario')
  const n = await negocio('uno')
  const { u } = n
  const A = await producto(n, 'A', { costPrice: 60 }), B = await producto(n, 'B'), C = await producto(n, 'C', { costPrice: 5 })
  const D = await producto(n, 'D', { costPrice: 7, deletedAt: new Date('2026-09-01T00:00:00Z') }), E = await producto(n, 'E', { costPrice: 9, trackStock: false })
  await venta(n, { numero: 'S1', completedAt: '2026-10-21T15:00:00Z', lineas: [{ p: A, qty: 2, total: 236, costo: 60 }, { p: B, qty: 1, total: 118, costo: 0 }] })
  await venta(n, { branch: 'b2', numero: 'S2', completedAt: '2026-10-22T15:00:00Z', lineas: [{ p: A, qty: 1, total: 118, costo: 60 }] })
  await venta(n, { numero: 'X-ANU', status: 'ANULADA', completedAt: '2026-10-23T15:00:00Z', lineas: [{ p: A, qty: 9, total: 999, costo: 60 }] })
  await venta(n, { numero: 'X-BOR', status: 'BORRADOR', completedAt: null, lineas: [{ p: A, qty: 9, total: 777, costo: 60 }] })
  await venta(n, { numero: 'X-DEV', status: 'DEVUELTA', completedAt: '2026-10-23T15:00:00Z', lineas: [{ p: A, qty: 1, total: 55, costo: 60 }] })
  await venta(n, { numero: 'X-ANTES', completedAt: '2026-10-20T04:59:59Z', lineas: [{ p: A, qty: 1, total: 1000, costo: 60 }] })
  await venta(n, { numero: 'X-DESPUES', completedAt: '2026-10-27T05:00:00Z', lineas: [{ p: A, qty: 1, total: 2000, costo: 60 }] })
  const stock = (p: { id: string }, b: typeof n.b1, quantity: number) => prisma.stock.create({ data: { tenantId: n.t.id, productId: p.id, warehouseId: b.warehouse.id, quantity } })
  await stock(A, n.b1, 10); await stock(A, n.b2, 5); await stock(B, n.b1, 3); await stock(C, n.b1, -4); await stock(D, n.b1, 2); await stock(E, n.b1, 50)
  const owner = u.owner!.ctx
  check('(preparación) 7 ventas, 8 líneas y 6 saldos creados', (await prisma.sale.count({ where: { tenantId: n.t.id } })) === 7 && (await prisma.saleItem.count({ where: { tenantId: n.t.id } })) === 8 && (await prisma.stock.count({ where: { tenantId: n.t.id } })) === 6)

  console.log('\nB) Margen')
  const m = await informeMargen(n.db(owner), owner, P(), AHORA)
  const t = m.datos.totales
  check('>>> cuenta solo las ventas completadas del periodo: venta sin IGV 400.00 (A: 200 + 100, B: 100); anulada, borrador, devuelta y las dos de fuera NO', t.ventaSinIgv === 400 && t.lineas === 3)
  check('>>> el costo y la utilidad usan SOLO lo que tiene costo: costo 180, utilidad 120, margen 40 %', t.costo === 180 && t.utilidad === 120 && t.margen === 40)
  check('>>> la cobertura es transparente: 300 de 400 tiene costo = 75 %, y 100.00 sin costo en 1 línea', t.ventaConCosto === 300 && t.ventaSinCosto === 100 && t.cobertura === 75 && t.lineasSinCosto === 1)
  const fb = m.datos.filas.find((f) => f.productId === B.id)!
  check('>>> B (costo 0) NO tiene margen ni utilidad inventada: aparece en «sin costo»', fb.margen === null && fb.utilidad === 0 && m.datos.sinCosto.length === 1 && m.datos.sinCosto[0]!.productId === B.id)
  check('el nombre es el ACTUAL del producto, no el de la venta', m.datos.filas.every((f) => f.nombre.startsWith('Prod ') && !f.sku.startsWith('V-')))
  const sub = await prisma.sale.aggregate({ where: { tenantId: n.t.id, status: 'COMPLETADA', completedAt: { gte: new Date('2026-10-20T05:00:00Z'), lt: new Date('2026-10-27T05:00:00Z') } }, _sum: { subtotal: true } })
  check('>>> la venta sin IGV suma EXACTAMENTE el subtotal de las ventas (Σ == Σ)', Number(sub._sum.subtotal) === t.ventaSinIgv)
  const mb1 = await informeMargen(n.db(n.soloB1), n.soloB1, P(), AHORA)
  check('>>> quien ve solo la sucursal 1 no ve la venta de la 2: 300.00 con cobertura 66.67 %', mb1.datos.totales.ventaSinIgv === 300 && mb1.datos.totales.cobertura === 66.67 && mb1.datos.totales.margen === 40)

  console.log('\nC) Inventario valorizado')
  const inv = await informeInventario(n.db(owner), owner, AHORA)
  check('>>> valor = A 15 × 60 + D 2 × 7 = 914.00; B sin costo no vale 0 sino «sin costo»; C negativo no resta; E (sin control de stock) no entra', inv.datos.totales.valor === 914 && inv.datos.productos.find((p) => p.productId === B.id)!.valor === null && !inv.datos.productos.some((p) => p.productId === E.id))
  check('sin costo: 1 producto y 3 unidades; negativo: 1; la fecha es el día de hoy en Lima', inv.datos.totales.productosSinCosto === 1 && inv.datos.totales.unidadesSinCosto === 3 && inv.datos.totales.productosConSaldoNegativo === 1 && inv.fecha === '2026-10-26')
  check('el producto dado de baja con stock se valoriza y se marca', inv.datos.productos.find((p) => p.productId === D.id)!.eliminado && inv.datos.productos.find((p) => p.productId === D.id)!.valor === 14)
  check('>>> productos y almacenes suman lo mismo', r2(inv.datos.almacenes.reduce((a, x) => a + x.valor, 0)) === inv.datos.totales.valor)
  const ib1 = await informeInventario(n.db(n.soloB1), n.soloB1, AHORA)
  check('>>> solo sus sucursales: la sucursal 1 vale 600 + 14 = 614.00 y un solo almacén', ib1.datos.totales.valor === 614 && ib1.datos.almacenes.length === 1)

  console.log('\nD) ABC')
  const av = await informeAbc(n.db(owner), owner, P(), AHORA)
  check('por ventas: A (300) y B (100) clasificados; A es el primero', av.datos.filas.length === 2 && av.datos.filas[0]!.id === A.id && av.datos.total === 400 && av.datos.sinClasificar === 0)
  const au = await informeAbc(n.db(owner), owner, P({ base: 'UTILIDAD' }), AHORA)
  check('>>> por utilidad: B (sin costo) NO se clasifica ni se manda a C: queda fuera y se cuenta aparte; la cobertura se informa', au.datos.filas.length === 1 && au.datos.sinClasificar === 1 && au.datos.cobertura === 75 && au.datos.total === 120)
  check('>>> umbrales inválidos → INVALID_DOCUMENT (no un 500)', (await code(informeAbc(n.db(owner), owner, { ...P(), a: 90, b: 50 }, AHORA))) === 'INVALID_DOCUMENT')

  console.log('\nE) Permisos: solo `productos.ver_costo`')
  const probar = async (c: TenantContext) => [
    await code(informeMargen(n.db(c), c, P(), AHORA)), await code(informeInventario(n.db(c), c, AHORA)), await code(informeAbc(n.db(c), c, P(), AHORA)), await code(exportarCostosCsv(n.db(c), c, 'margen', P(), AHORA)),
  ]
  for (const r of ['owner', 'admin', 'contador']) check(`>>> ${r} puede ver los cuatro`, (await probar(u[r]!.ctx)).every((x) => x === null))
  for (const r of ['cajero', 'vendedor', 'almacenero']) check(`>>> ${r} NO puede ver ninguno (FORBIDDEN_ROLE)`, (await probar(u[r]!.ctx)).every((x) => x === 'FORBIDDEN_ROLE'))
  const contadorSinCosto: TenantContext = { ...u.contador!.ctx, permisosDenegados: ['productos.ver_costo'] }
  check('>>> un contador al que se le quitó `productos.ver_costo` NO entra, aunque conserve `reportes.ver`', (await probar(contadorSinCosto)).every((x) => x === 'FORBIDDEN_ROLE'))
  const cajeroVerReportes: TenantContext = { ...u.cajero!.ctx, permisosExtra: ['reportes.ver'] }
  check('>>> `reportes.ver` por sí solo NO basta', (await probar(cajeroVerReportes)).every((x) => x === 'FORBIDDEN_ROLE'))
  const cajeroVerCosto: TenantContext = { ...u.cajero!.ctx, permisosExtra: ['productos.ver_costo'] }
  check('>>> `productos.ver_costo` por sí solo SÍ basta (un permiso = un poder)', (await probar(cajeroVerCosto)).every((x) => x === null))

  console.log('\nF) CSV y auditoría')
  const antes = await prisma.auditLog.count({ where: { tenantId: n.t.id, action: 'reporte.exportado' } })
  const csv = await exportarCostosCsv(n.db(owner), owner, 'margen', P(), AHORA)
  check('el archivo se llama margen-DESDE_HASTA.csv y trae BOM, «;» y la cobertura', csv.nombre === 'margen-2026-10-20_2026-10-26.csv' && csv.contenido.startsWith('﻿') && csv.contenido.includes(';'))
  const reg = await prisma.auditLog.findFirst({ where: { tenantId: n.t.id, action: 'reporte.exportado', entityId: 'rentabilidad-margen' } })
  check('>>> la descarga queda en la auditoría con quién y qué cobertura', (await prisma.auditLog.count({ where: { tenantId: n.t.id, action: 'reporte.exportado' } })) === antes + 1 && reg?.actorId === u.owner!.id && JSON.stringify(reg?.after).includes('"cobertura":75'))
  const inventarioCsv = await exportarCostosCsv(n.db(owner), owner, 'inventario', P(), AHORA)
  check('inventario: archivo con la fecha y el valor total en el CSV', inventarioCsv.nombre === 'inventario-valorizado-2026-10-26.csv' && inventarioCsv.contenido.includes('914.00'))
  const abcCsv = await exportarCostosCsv(n.db(owner), owner, 'abc', P({ base: 'UTILIDAD' }), AHORA)
  check('abc: el nombre dice la base', abcCsv.nombre === 'abc-utilidad-2026-10-20_2026-10-26.csv')
  const denegado = await code(exportarCostosCsv(n.db(u.cajero!.ctx), u.cajero!.ctx, 'margen', P(), AHORA))
  check('>>> sin permiso no se descarga ni se audita nada', denegado === 'FORBIDDEN_ROLE' && (await prisma.auditLog.count({ where: { tenantId: n.t.id, action: 'reporte.exportado' } })) === antes + 3)

  console.log('\nG) Más de 1000 líneas (lotes)')
  const G = await producto(n, 'G', { costPrice: 1 })
  const grande = await prisma.sale.create({ data: { tenantId: n.t.id, branchId: n.b1.branch.id, warehouseId: n.b1.warehouse.id, userId: u.owner!.id, number: 'GRANDE', documentType: 'NOTA_VENTA', status: 'COMPLETADA', subtotal: 1200, taxTotal: 0, total: 1200, completedAt: new Date('2026-10-24T15:00:00Z') } })
  await prisma.saleItem.createMany({ data: Array.from({ length: 1200 }, () => ({ tenantId: n.t.id, saleId: grande.id, productId: G.id, nameSnapshot: 'G', skuSnapshot: 'G', quantity: 1, unitPrice: 1, taxRate: 0, unitCost: 0.5, lineTotal: 1 })) })
  const mg = await informeMargen(n.db(owner), owner, P(), AHORA)
  const fg = mg.datos.filas.find((f) => f.productId === G.id)!
  check('>>> las 1200 líneas se leen todas (lotes de 1000): 1200.00 de venta, 600.00 de costo, margen 50 %', fg.lineas === 1200 && fg.ventaSinIgv === 1200 && fg.costo === 600 && fg.margen === 50)

  console.log('\nH) Aislamiento entre negocios')
  const o = await negocio('dos')
  const X = await producto(o, 'X', { costPrice: 1 })
  await venta(o, { numero: 'OTRO', completedAt: '2026-10-22T15:00:00Z', lineas: [{ p: X, qty: 1, total: 5900, costo: 1 }] })
  const mo = await informeMargen(o.db(o.u.owner!.ctx), o.u.owner!.ctx, P(), AHORA)
  const m1 = await informeMargen(n.db(owner), owner, P(), AHORA)
  check('>>> cada negocio ve lo suyo: el otro tiene 5000.00 y el primero no lo ve', mo.datos.totales.ventaSinIgv === 5000 && m1.datos.totales.ventaSinIgv === 1600 && !m1.datos.filas.some((f) => f.productId === X.id))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
