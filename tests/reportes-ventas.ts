import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { parametrosVentasSchema, type ParametrosVentas } from '../src/features/reportes/schemas'
import { exportarVentasCsv, informeCobros, informeVentasPorMedio, informeVentasPorPeriodo, informeVentasPorVendedor } from '../src/features/reportes/ventas-service'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F5.2 · Reportes de ventas contra la base. Lo que más importa: SOLO ventas completadas (no anuladas, borradores ni devueltas), por el día
 * del NEGOCIO (la frontera de medianoche de Lima), con el vuelto descontado, lo fiado fuera de los cobros, los abonos válidos dentro y los
 * anulados fuera, cada quien ve solo sus sucursales —abonos incluidos, que no se filtran solos— y nada se mezcla entre negocios.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const AHORA = new Date('2026-10-27T03:00:00Z')   // lunes 26/10/2026 22:00 en Lima
const P = (o: Partial<ParametrosVentas> = {}): ParametrosVentas => parametrosVentasSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26', ...o })
const iso = (s: string) => new Date(s)

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-${tag}-${randomUUID().slice(0, 6)}`, name: `Reportes ${tag}`, taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_rp' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const usuarios: Record<string, { id: string; ctx: TenantContext }> = {}
  const todas = [b1.branch.id, b2.branch.id]
  for (const [nombre, role] of [['owner', 'OWNER'], ['admin', 'ADMIN'], ['contador', 'CONTADOR'], ['cajero', 'CAJERO'], ['vendedor', 'VENDEDOR'], ['almacenero', 'ALMACENERO'], ['ana', 'VENDEDOR'], ['beto', 'CAJERO'], ['cami', 'CAJERO']] as [string, Role][]) {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${nombre}-${randomUUID()}@x.com`.toLowerCase(), name: nombre === 'owner' ? 'Dueño' : nombre[0]!.toUpperCase() + nombre.slice(1), role } })
    await asignarSucursal(t.id, u.id, b1.branch.id)
    usuarios[nombre] = { id: u.id, ctx: { tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: todas, permisosExtra: [] } }
  }
  const soloB1: TenantContext = { ...usuarios.admin!.ctx, branchIds: [b1.branch.id] }
  return { t, b1, b2, u: usuarios, soloB1, db: (c: TenantContext) => getTenantPrisma(c) }
}
type N = Awaited<ReturnType<typeof negocio>>

async function venta(n: N, o: { branch?: 'b1' | 'b2'; userId: string; numero: string; total: number; igv?: number; desc?: number; status?: 'COMPLETADA' | 'ANULADA' | 'BORRADOR' | 'DEVUELTA'; completedAt: string | null; quoteId?: string; customerId?: string; pagos: { metodo: string; monto: number; cambio?: number; userId?: string }[] }) {
  const b = o.branch === 'b2' ? n.b2 : n.b1
  const v = await prisma.sale.create({ data: {
    tenantId: n.t.id, branchId: b.branch.id, warehouseId: b.warehouse.id, userId: o.userId, number: o.numero, documentType: 'NOTA_VENTA', status: o.status ?? 'COMPLETADA', ...((o.status ?? 'COMPLETADA') === 'ANULADA' || o.status === 'DEVUELTA' ? { voidedAt: new Date(), voidReason: 'Prueba' } : {}), 
    subtotal: o.total - (o.igv ?? 0), taxTotal: o.igv ?? 0, discountTotal: o.desc ?? 0, total: o.total, completedAt: o.completedAt ? iso(o.completedAt) : null,
    ...(o.quoteId ? { quoteId: o.quoteId } : {}), ...(o.customerId ? { customerId: o.customerId } : {}),
  } })
  for (const p of o.pagos) {
    await prisma.payment.create({ data: { tenantId: n.t.id, saleId: v.id, userId: p.userId ?? o.userId, method: p.metodo as never, amount: p.monto, change: p.cambio ?? 0, receivedAt: iso(o.completedAt ?? '2026-10-22T12:00:00Z') } })
  }
  return v
}

async function main() {
  try {
    return await cuerpo()
  } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 200) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  console.log('\nA) El escenario')
  const n = await negocio('uno')
  const { u } = n
  const cliente = await prisma.customer.create({ data: { tenantId: n.t.id, name: 'Cliente fiado', creditLimit: 1000 } })
  const pedido = await prisma.quote.create({ data: { tenantId: n.t.id, branchId: n.b1.branch.id, warehouseId: n.b1.warehouse.id, userId: u.ana!.id, number: `P-${randomUUID().slice(0, 6)}`, kind: 'PEDIDO', status: 'CONVERTIDA', subtotal: 100, taxTotal: 18, total: 118 } })
  // Dentro del periodo (20–26/10, hora de Lima) y de la sucursal 1:
  await venta(n, { userId: u.beto!.id, numero: 'S1', total: 118, igv: 18, completedAt: '2026-10-21T15:00:00Z', quoteId: pedido.id, pagos: [{ metodo: 'EFECTIVO', monto: 120, cambio: 2 }] })   // pedido de Ana, cobrado por Beto, con vuelto
  await venta(n, { userId: u.beto!.id, numero: 'S2', total: 50, completedAt: '2026-10-26T04:59:59Z', pagos: [{ metodo: 'YAPE', monto: 50 }] })                                  // Lima: 25/10 23:59:59
  await venta(n, { userId: u.ana!.id, numero: 'S3', total: 200, desc: 10, completedAt: '2026-10-26T05:00:00Z', customerId: cliente.id, pagos: [{ metodo: 'EFECTIVO', monto: 50 }, { metodo: 'CREDITO', monto: 150 }] })   // Lima: 26/10 00:00:00, fiado
  // Sucursal 2:
  await venta(n, { branch: 'b2', userId: u.cami!.id, numero: 'S7', total: 300, completedAt: '2026-10-22T15:00:00Z', pagos: [{ metodo: 'TARJETA_CREDITO', monto: 300 }] })
  // NO cuentan: anulada, borrador, devuelta, y dos fuera del periodo por UN SEGUNDO
  await venta(n, { userId: u.beto!.id, numero: 'X-ANU', total: 999, status: 'ANULADA', completedAt: '2026-10-23T15:00:00Z', pagos: [{ metodo: 'EFECTIVO', monto: 999 }] })
  await venta(n, { userId: u.beto!.id, numero: 'X-BOR', total: 777, status: 'BORRADOR', completedAt: null, pagos: [] })
  await venta(n, { userId: u.beto!.id, numero: 'X-DEV', total: 55, status: 'DEVUELTA', completedAt: '2026-10-23T15:00:00Z', pagos: [{ metodo: 'EFECTIVO', monto: 55 }] })
  await venta(n, { userId: u.beto!.id, numero: 'X-ANTES', total: 1000, completedAt: '2026-10-20T04:59:59Z', pagos: [{ metodo: 'EFECTIVO', monto: 1000 }] })   // Lima: 19/10 23:59:59
  await venta(n, { userId: u.beto!.id, numero: 'X-DESPUES', total: 2000, completedAt: '2026-10-27T05:00:00Z', pagos: [{ metodo: 'EFECTIVO', monto: 2000 }] })  // Lima: 27/10 00:00:00
  // Abonos
  const caja = await prisma.cashSession.create({ data: { tenantId: n.t.id, branchId: n.b1.branch.id, openedById: u.beto!.id, openingAmount: 0 } })
  const abono = (o: { metodo: string; monto: number; en: string; branch?: 'b1' | 'b2'; anulado?: boolean; caja?: boolean }) => prisma.customerPayment.create({ data: {
    tenantId: n.t.id, customerId: cliente.id, branchId: (o.branch === 'b2' ? n.b2 : n.b1).branch.id, userId: u.beto!.id, method: o.metodo as never, amount: o.monto, receivedAt: iso(o.en),
    ...(o.caja ? { cashSessionId: caja.id } : {}), ...(o.anulado ? { voidedAt: iso(o.en), voidedById: u.owner!.id, voidReason: 'error' } : {}),
  } })
  await abono({ metodo: 'EFECTIVO', monto: 40, en: '2026-10-24T15:00:00Z', caja: true })
  await abono({ metodo: 'TRANSFERENCIA', monto: 100, en: '2026-10-25T15:00:00Z' })
  await abono({ metodo: 'YAPE', monto: 77, en: '2026-10-25T16:00:00Z', anulado: true })               // anulado: no cuenta
  await abono({ metodo: 'YAPE', monto: 60, en: '2026-10-22T15:00:00Z', branch: 'b2' })                  // otra sucursal
  await abono({ metodo: 'TRANSFERENCIA', monto: 500, en: '2026-10-27T05:00:00Z' })                      // fuera del periodo
  check('(preparación) 9 ventas y 5 abonos creados', (await prisma.sale.count({ where: { tenantId: n.t.id } })) === 9 && (await prisma.customerPayment.count({ where: { tenantId: n.t.id } })) === 5)

  console.log('\nB) Ventas por periodo')
  const por = await informeVentasPorPeriodo(n.db(u.owner!.ctx), u.owner!.ctx, P(), AHORA)
  const dia = (k: string) => por.datos.filas.find((f) => f.clave === k)
  check('>>> cuenta SOLO las completadas del periodo: 4 ventas y 668.00 (la anulada, el borrador, la devuelta y las dos fuera NO)', por.datos.totales.ventas === 4 && por.datos.totales.total === 668)
  check('>>> la frontera es la medianoche de LIMA: 23:59:59 del 25 y 00:00:00 del 26 van a días distintos; el segundo anterior al 20 y el posterior al 26 quedan fuera', dia('2026-10-25')!.total === 50 && dia('2026-10-26')!.total === 200 && dia('2026-10-19') === undefined && dia('2026-10-27') === undefined)
  check('día 21: 118.00 con IGV 18.00; día 22 (sucursal 2): 300.00; el descuento de 10.00 del día 26', dia('2026-10-21')!.total === 118 && dia('2026-10-21')!.igv === 18 && dia('2026-10-22')!.total === 300 && dia('2026-10-26')!.descuentos === 10)
  check('la serie no tiene huecos: 7 días, los vacíos en cero', por.datos.filas.length === 7 && dia('2026-10-23')!.ventas === 0 && dia('2026-10-20')!.total === 0)
  check('el periodo y la zona se informan', por.textoPeriodo === '20/10/2026 – 26/10/2026' && por.zona === 'America/Lima')
  const sem = await informeVentasPorPeriodo(n.db(u.owner!.ctx), u.owner!.ctx, P({ agrupar: 'semana' }), AHORA)
  check('por semana: la del lunes 19 (118 + 300 + 50 = 468) y la del 26 (200)', sem.datos.filas.map((f) => `${f.clave}:${f.total}`).join() === '2026-10-19:468,2026-10-26:200' && sem.datos.totales.total === 668)
  const mes = await informeVentasPorPeriodo(n.db(u.owner!.ctx), u.owner!.ctx, P({ agrupar: 'mes' }), AHORA)
  check('por mes: todo octubre = 668.00', mes.datos.filas.length === 1 && mes.datos.filas[0]!.total === 668)
  const auto = await informeVentasPorPeriodo(n.db(u.owner!.ctx), u.owner!.ctx, P({ agrupar: 'auto' }), AHORA)
  check('automática en un periodo de 7 días: por día', auto.datos.granularidad === 'dia')

  console.log('\nC) Por vendedor')
  const ven = await informeVentasPorVendedor(n.db(u.owner!.ctx), u.owner!.ctx, P(), AHORA)
  const fv = Object.fromEntries(ven.datos.filas.map((f) => [f.nombre, f]))
  check('>>> el pedido de Ana, aunque lo cobró Beto, es de ANA: Ana 318.00 (2), Cami 300.00, Beto 50.00', fv.Ana!.total === 318 && fv.Ana!.ventas === 2 && fv.Cami!.total === 300 && fv.Beto!.total === 50)
  check('ordenado por lo vendido y la suma coincide con el total (668.00)', ven.datos.filas[0]!.nombre === 'Ana' && ven.datos.filas.reduce((a, f) => a + Math.round(f.total * 100), 0) === 66800 && ven.datos.totales.total === 668)
  const cob = await informeVentasPorVendedor(n.db(u.owner!.ctx), u.owner!.ctx, P({ atrib: 'COBRO' }), AHORA)
  const fc = Object.fromEntries(cob.datos.filas.map((f) => [f.nombre, f]))
  check('>>> atribuido a QUIEN COBRÓ: Beto 168.00 (el pedido de Ana y la venta de Yape), Ana 200.00, Cami 300.00', fc.Beto!.total === 168 && fc.Ana!.total === 200 && fc.Cami!.total === 300)
  check('la participación de Ana: 318 / 668 = 47.60 %', fv.Ana!.participacion === 47.6)

  console.log('\nD) Por medio de pago')
  const med = await informeVentasPorMedio(n.db(u.owner!.ctx), u.owner!.ctx, P(), AHORA)
  const fm = Object.fromEntries(med.datos.filas.map((f) => [f.metodo, f]))
  check('>>> efectivo 168.00 = 118 (120 entregados − 2 de vuelto) + 50; Yape 50.00; tarjeta de crédito 300.00; FIADO 150.00', fm.EFECTIVO!.monto === 168 && fm.YAPE!.monto === 50 && fm.TARJETA_CREDITO!.monto === 300 && fm.CREDITO!.monto === 150)
  check('>>> los medios suman EXACTAMENTE lo vendido: 668.00 = 668.00, sin descuadre', med.datos.totalMedios === 668 && med.datos.totalVentas === 668 && med.datos.descuadradas.ventas === 0)
  check('la venta fiada cuenta en efectivo Y en fiado (pago mixto)', fm.EFECTIVO!.ventas === 2 && fm.CREDITO!.ventas === 1)
  await prisma.payment.deleteMany({ where: { tenantId: n.t.id, sale: { number: 'S2' } } })
  const med2 = await informeVentasPorMedio(n.db(u.owner!.ctx), u.owner!.ctx, P(), AHORA)
  check('>>> si a una venta le faltan sus pagos, el reporte lo DICE: 1 venta, diferencia 50.00 (no lo esconde)', med2.datos.descuadradas.ventas === 1 && med2.datos.descuadradas.diferencia === 50 && med2.datos.totalMedios === 618)
  await prisma.payment.create({ data: { tenantId: n.t.id, saleId: (await prisma.sale.findFirstOrThrow({ where: { tenantId: n.t.id, number: 'S2' } })).id, userId: u.beto!.id, method: 'YAPE', amount: 50, receivedAt: iso('2026-10-26T04:59:59Z') } })

  console.log('\nE) Cobros: el dinero que entró')
  const co = await informeCobros(n.db(u.owner!.ctx), u.owner!.ctx, P(), AHORA)
  const fcm = Object.fromEntries(co.datos.filas.map((f) => [f.metodo, f]))
  check('>>> lo fiado NO es un cobro: no hay fila de crédito', !fcm.CREDITO)
  check('>>> efectivo 208.00 = 168.00 de ventas (neto de vuelto) + 40.00 de abonos', fcm.EFECTIVO!.contado === 168 && fcm.EFECTIVO!.abonos === 40 && fcm.EFECTIVO!.total === 208)
  check('transferencia 100.00 y Yape 110.00 (50 de venta + 60 de abono de la otra sucursal) son todo abonos/ventas según corresponde', fcm.TRANSFERENCIA!.abonos === 100 && fcm.TRANSFERENCIA!.contado === 0 && fcm.YAPE!.contado === 50 && fcm.YAPE!.abonos === 60)
  check('>>> el abono ANULADO (77.00) y el de FUERA del periodo (500.00) no entran', co.datos.totales.abonos === 200)
  check('>>> el cobro de la venta ANULADA (999.00) tampoco: ventas de contado = 168 + 50 + 300 = 518.00', co.datos.totales.contado === 518)
  check('>>> total cobrado 718.00 = ventas 668.00 − fiado 150.00 + abonos 200.00', co.datos.totales.total === 718 && 668 - 150 + 200 === 718)

  console.log('\nF) Quién ve qué (sucursales)')
  const b1 = n.soloB1
  const porB1 = await informeVentasPorPeriodo(n.db(b1), b1, P(), AHORA)
  check('>>> un administrador de la sucursal 1 ve solo SUS ventas: 3 y 368.00 (sin los 300.00 de la sucursal 2)', porB1.datos.totales.ventas === 3 && porB1.datos.totales.total === 368)
  const medB1 = await informeVentasPorMedio(n.db(b1), b1, P(), AHORA)
  check('sus medios de pago también: sin la tarjeta de la otra sucursal', !medB1.datos.filas.some((f) => f.metodo === 'TARJETA_CREDITO') && medB1.datos.totalMedios === 368)
  const venB1 = await informeVentasPorVendedor(n.db(b1), b1, P(), AHORA)
  check('sus vendedores: Cami (de la otra sucursal) no aparece', !venB1.datos.filas.some((f) => f.nombre === 'Cami'))
  const cobB1 = await informeCobros(n.db(b1), b1, P(), AHORA)
  check('>>> sus cobros: el abono de 60.00 de la OTRA sucursal NO aparece (los abonos no se filtran solos: el reporte los acota)', cobB1.datos.totales.abonos === 140 && !cobB1.datos.filas.some((f) => f.metodo === 'TARJETA_CREDITO') && cobB1.datos.totales.total === 358, JSON.stringify(cobB1.datos.totales))
  const ctxSinAlcance: TenantContext = { ...u.owner!.ctx, branchIds: undefined }
  const todo = await informeCobros(n.db(ctxSinAlcance), ctxSinAlcance, P(), AHORA)
  check('sin restricción de sucursales (alcance abierto) se ve todo', todo.datos.totales.total === 718)

  console.log('\nG) Permisos y errores')
  const quien = async (rol: string, c: TenantContext) => [
    await code(informeVentasPorPeriodo(n.db(c), c, P(), AHORA)), await code(informeVentasPorVendedor(n.db(c), c, P(), AHORA)),
    await code(informeVentasPorMedio(n.db(c), c, P(), AHORA)), await code(informeCobros(n.db(c), c, P(), AHORA)), await code(exportarVentasCsv(n.db(c), c, 'periodo', P(), AHORA)),
  ].map((x) => `${rol}:${x}`)
  const dentro = [...(await quien('owner', u.owner!.ctx)), ...(await quien('admin', u.admin!.ctx)), ...(await quien('contador', u.contador!.ctx))]
  check('>>> dueño, administrador y CONTADOR (reportes.ver) los ven y los descargan', dentro.every((x) => x.endsWith(':null')), dentro.filter((x) => !x.endsWith(':null')).join(','))
  const fuera = [...(await quien('cajero', u.cajero!.ctx)), ...(await quien('vendedor', u.vendedor!.ctx)), ...(await quien('almacenero', u.almacenero!.ctx))]
  check('>>> cajero, vendedor y almacenero NO: FORBIDDEN_ROLE en los cuatro reportes y en la descarga', fuera.every((x) => x.endsWith(':FORBIDDEN_ROLE')), fuera.filter((x) => !x.endsWith('FORBIDDEN_ROLE')).join(','))
  check('>>> un rango imposible se rechaza con INVALID_DOCUMENT', await code(informeVentasPorPeriodo(n.db(u.owner!.ctx), u.owner!.ctx, P({ desde: '2026-10-26', hasta: '2026-10-01' }), AHORA)) === 'INVALID_DOCUMENT' && await code(informeCobros(n.db(u.owner!.ctx), u.owner!.ctx, P({ desde: '2026-02-31', hasta: '2026-03-05' }), AHORA)) === 'INVALID_DOCUMENT' && await code(informeVentasPorMedio(n.db(u.owner!.ctx), u.owner!.ctx, P({ desde: '2024-01-01', hasta: '2026-01-01' }), AHORA)) === 'INVALID_DOCUMENT')
  const otro = await negocio('otro')
  await venta(otro, { userId: otro.u.beto!.id, numero: 'AJ1', total: 4321, completedAt: '2026-10-22T15:00:00Z', pagos: [{ metodo: 'EFECTIVO', monto: 4321 }] })
  const delOtro = await informeVentasPorPeriodo(otro.db(otro.u.owner!.ctx), otro.u.owner!.ctx, P(), AHORA)
  const delPrimero = await informeVentasPorPeriodo(n.db(u.owner!.ctx), u.owner!.ctx, P(), AHORA)
  check('>>> cada negocio ve SOLO lo suyo: 4321.00 en el otro, 668.00 en este', delOtro.datos.totales.total === 4321 && delPrimero.datos.totales.total === 668)

  console.log('\nH) Descargas CSV y auditoría')
  const antesAud = await prisma.auditLog.count({ where: { tenantId: n.t.id, action: 'reporte.exportado' } })
  const csvP = await exportarVentasCsv(n.db(u.owner!.ctx), u.owner!.ctx, 'periodo', P(), AHORA)
  const lineas = csvP.contenido.split('\r\n').filter(Boolean)
  check('>>> periodo: nombre con las fechas, BOM, 7 días + TOTAL con 668.00 (`filas` cuenta los días, no el total)', csvP.nombre === 'ventas-periodo-2026-10-20_2026-10-26.csv' && csvP.contenido.startsWith('﻿') && lineas.length === 1 + 7 + 1 && lineas.at(-1)!.includes('668.00') && csvP.filas === 7)
  const csvV = await exportarVentasCsv(n.db(u.owner!.ctx), u.owner!.ctx, 'vendedor', P({ atrib: 'COBRO' }), AHORA)
  check('vendedor (por quien cobró): Beto 168.00', csvV.contenido.includes('Beto;') && csvV.contenido.includes('168.00') && csvV.contenido.split('\r\n')[0]!.includes('Cobró en caja'))
  const csvM = await exportarVentasCsv(n.db(u.owner!.ctx), u.owner!.ctx, 'medios', P(), AHORA)
  check('medios: el fiado aparece y los dos totales coinciden', csvM.contenido.includes('Fiado (a crédito)') && csvM.contenido.includes('TOTAL DE LOS MEDIOS;;668.00') && csvM.contenido.includes('TOTAL DE LAS VENTAS;;668.00'))
  const csvC = await exportarVentasCsv(n.db(u.owner!.ctx), u.owner!.ctx, 'cobros', P(), AHORA)
  check('cobros: total 718.00', csvC.contenido.split('\r\n').filter(Boolean).at(-1)!.includes('718.00'))
  const aud = await prisma.auditLog.findMany({ where: { tenantId: n.t.id, action: 'reporte.exportado' }, orderBy: { createdAt: 'asc' } })
  check('>>> las 4 descargas quedan en la auditoría con quién, qué reporte, qué periodo y cuántas filas', aud.length - antesAud === 4 && aud.at(-1)!.actorId === u.owner!.id && JSON.stringify(aud.at(-1)!.after).includes('"desde":"2026-10-20"') && JSON.stringify(aud.at(-1)!.after).includes('"hasta":"2026-10-26"') && JSON.stringify(aud[aud.length - 4]!.after).includes('"filas":7'))
  const antesF = await prisma.auditLog.count({ where: { tenantId: n.t.id, action: 'reporte.exportado' } })
  await code(exportarVentasCsv(n.db(u.cajero!.ctx), u.cajero!.ctx, 'periodo', P(), AHORA)); await code(exportarVentasCsv(n.db(u.owner!.ctx), u.owner!.ctx, 'periodo', P({ desde: '2026-10-26', hasta: '2026-10-01' }), AHORA))
  check('>>> una descarga que se NIEGA o falla no deja registro de descarga', (await prisma.auditLog.count({ where: { tenantId: n.t.id, action: 'reporte.exportado' } })) === antesF)
  const raro = await prisma.user.create({ data: { tenantId: n.t.id, email: `raro-${randomUUID()}@x.com`, name: '=HYPERLINK("http://x","clic")', role: 'VENDEDOR' } })
  await venta(n, { userId: raro.id, numero: 'S-RARO', total: 12, completedAt: '2026-10-23T15:00:00Z', pagos: [{ metodo: 'EFECTIVO', monto: 12 }] })
  const csvRaro = await exportarVentasCsv(n.db(u.owner!.ctx), u.owner!.ctx, 'vendedor', P({ atrib: 'COBRO' }), AHORA)
  check('>>> un vendedor llamado «=HYPERLINK(…)» sale como TEXTO en el CSV, no como fórmula', csvRaro.contenido.includes("'=HYPERLINK") && !/(^|;)=HYPERLINK/m.test(csvRaro.contenido))

  console.log('\nI) Lectura por lotes: más de 2000 ventas')
  const g = await negocio('grande')
  const N = 2050
  const ids = Array.from({ length: N }, (_, i) => `rp-venta-${g.t.id.slice(-6)}-${i}`)
  await prisma.sale.createMany({ data: ids.map((id, i) => ({
    id, tenantId: g.t.id, branchId: g.b1.branch.id, warehouseId: g.b1.warehouse.id, userId: g.u.beto!.id, number: `G-${i}`, documentType: 'NOTA_VENTA' as const, status: 'COMPLETADA' as const,
    subtotal: 1, taxTotal: 0, discountTotal: 0, total: 1, completedAt: new Date(Date.UTC(2026, 9, 21, 15, 0, 0) + (i % 5) * 1000),   // muchas con el MISMO instante: el orden por id desempata
  })) })
  await prisma.payment.createMany({ data: ids.map((id, i) => ({ tenantId: g.t.id, saleId: id, userId: g.u.beto!.id, method: (i % 2 === 0 ? 'EFECTIVO' : 'YAPE') as never, amount: 1, change: 0, receivedAt: new Date(Date.UTC(2026, 9, 21, 15, 0, 0)) })) })
  const gp = await informeVentasPorPeriodo(g.db(g.u.owner!.ctx), g.u.owner!.ctx, P(), AHORA)
  const gm = await informeVentasPorMedio(g.db(g.u.owner!.ctx), g.u.owner!.ctx, P(), AHORA)
  const gc = await informeCobros(g.db(g.u.owner!.ctx), g.u.owner!.ctx, P(), AHORA)
  check('>>> 2050 ventas (más de dos lotes de 1000): ninguna se pierde ni se cuenta dos veces', gp.datos.totales.ventas === 2050 && gp.datos.totales.total === 2050)
  check('los medios y los cobros también leen todo: 1025 de efectivo y 1025 de Yape', gm.datos.totalMedios === 2050 && gm.datos.filas.find((f) => f.metodo === 'EFECTIVO')!.monto === 1025 && gc.datos.totales.contado === 2050 && gc.datos.totales.operacionesContado === 2050)
  const gv = await informeVentasPorVendedor(g.db(g.u.owner!.ctx), g.u.owner!.ctx, P(), AHORA)
  check('por vendedor: Beto con las 2050', gv.datos.filas.length === 1 && gv.datos.filas[0]!.ventas === 2050)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
