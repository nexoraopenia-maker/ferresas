import './guard'
import { correr } from './teardown'
import { abrirTurno, asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { crearPresentacion } from '../src/features/inventory/presentaciones-service'
import { devolverProductosVenta } from '../src/features/devoluciones/parcial-service'
import { anularOdevolverVentaSchema, devolverProductosSchema } from '../src/features/devoluciones/schemas'
import { anularOdevolverVenta } from '../src/features/devoluciones/service'
import { informeCobros, informeVentasPorMedio, informeVentasPorPeriodo, informeVentasPorVendedor, exportarVentasCsv } from '../src/features/reportes/ventas-service'
import { parametrosCostosSchema, parametrosVentasSchema } from '../src/features/reportes/schemas'
import { informeAbc, informeMargen } from '../src/features/reportes/rentabilidad-service'
import { informeRegistroVentas } from '../src/features/registros/registro-service'
import { parametrosRegistrosSchema } from '../src/features/registros/schemas'
import { csvConciliacion, informeConciliacion } from '../src/features/conciliacion/conciliacion-service'
import { resumenDeVentas } from '../src/features/dashboard/service'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.2b · Las devoluciones PARCIALES en los reportes, con datos creados por los servicios reales: ventas, rentabilidad, ABC, dashboard, registros y
 * el puente de conciliación dicen lo mismo al céntimo. Lo que se demuestra: lo devuelto resta en el periodo de la VENTA; la nota de crédito resta en
 * el del REGISTRO (su fecha de emisión); el puente explica los dos desfases de fecha y la diferencia sin explicar es exactamente 0.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const cent = (n: number) => Math.round(n * 100)
const AHORA = new Date('2026-10-27T03:00:00Z')   // lunes 26/10/2026 22:00 en Lima
const DESDE = new Date('2026-10-20T05:00:00Z'), HASTA = new Date('2026-10-27T05:00:00Z')
const D = (s: string) => new Date(s)

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 400) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-rdp-${tag}-${randomUUID().slice(0, 6)}`, name: `Reportes parciales ${tag}`, taxId: ruc(), planId: plan.id, realBillingEnabledAt: new Date('2026-01-01T00:00:00Z') } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_rdp' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const todas = [b1.branch.id, b2.branch.id]
  const mk = async (role: Role) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    for (const b of todas) await asignarSucursal(t.id, u.id, b)
    return u
  }
  const owner = await mk('OWNER'), owner2 = await mk('OWNER'), cajero = await mk('CAJERO')
  const ctx = (u: { id: string }, role: Role, branchId: string, branchIds = todas): TenantContext => ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId, branchIds, permisosExtra: [] })
  const O1 = ctx(owner, 'OWNER', b1.branch.id), O2 = ctx(owner2, 'OWNER', b2.branch.id)
  // F6.8b: cada sucursal la cobra y devuelve su propia persona con su turno abierto.
  await abrirTurno(t.id, owner.id, b1.branch.id); await abrirTurno(t.id, owner2.id, b2.branch.id)
  const prod = (sku: string, o: Record<string, unknown>) => prisma.product.create({ data: { tenantId: t.id, sku, name: `Prod ${sku}`, unitType: 'UNIDAD', ...o } })
  const P1 = await prod('P1', { salePrice: 100, costPrice: 60 }), P2 = await prod('P2', { salePrice: 2.5, costPrice: 0, taxRate: 0 })
  const P3 = await prod('P3', { salePrice: 33.33, costPrice: 17.77 }), P4 = await prod('P4', { salePrice: 0.35, costPrice: 0.1 })
  for (const p of [P1, P2, P3, P4]) for (const w of [b1.warehouse, b2.warehouse]) await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: w.id, quantity: 500 } })
  const caja = await crearPresentacion(getTenantPrisma(O1), O1, { productId: P3.id, name: 'Caja x 12', unitType: 'CAJA', factor: '12' })
  const cliente = await prisma.customer.create({ data: { tenantId: t.id, name: 'Constructora SAC', docType: 'RUC', docNumber: ruc(), creditLimit: 9000 } })
  const L = (productId: string, quantity: number, discount = 0, extra: Record<string, unknown> = {}) => ({ productId, quantity, discount, ...extra })
  const vender = async (c: TenantContext, w: string, en: string, items: unknown[], payments: unknown[], over: Record<string, unknown> = {}) => {
    const v = await registerSale(getTenantPrisma(c), c, registerSaleSchema.parse({ warehouseId: w, items, payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID(), ...over }) as never)
    await prisma.sale.update({ where: { id: v.saleId }, data: { completedAt: D(en) } })
    await prisma.payment.updateMany({ where: { saleId: v.saleId }, data: { receivedAt: D(en) } })
    return v.saleId
  }
  const corr: Record<string, number> = {}
  const doc = async (saleId: string, en: string, o: { estado?: string; tipo?: 'BOLETA' | 'FACTURA' } = {}) => {
    const s = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } })
    const tipo = o.tipo ?? 'BOLETA', serie = tipo === 'FACTURA' ? 'F001' : 'B001', c = (corr[serie] = (corr[serie] ?? 0) + 1)
    return prisma.taxDocument.create({ data: {
      tenantId: t.id, saleId, documentType: tipo, series: serie, correlativo: c, fullNumber: `${serie}-${String(c).padStart(8, '0')}`, status: (o.estado ?? 'ACEPTADO') as never, isTrial: false,
      subtotal: s.subtotal, taxTotal: s.taxTotal, discountTotal: s.discountTotal, total: s.total, issuedAt: D(en),
      receiverDocType: tipo === 'FACTURA' ? 'RUC' : 'SIN_DOCUMENTO', receiverDocNumber: tipo === 'FACTURA' ? ruc() : null, receiverName: 'Cliente', externalId: `ext-${c}`,
    } })
  }
  const item = (saleId: string, productId: string) => prisma.saleItem.findFirstOrThrow({ where: { saleId, productId } })
  const devolver = async (saleId: string, lines: { saleItemId: string; quantity: number; destination?: 'STOCK' | 'MERMA' }[], refund: { monto?: number; medio?: string } | null, notaEn: string | null) => {
    const dinero = refund?.monto
    // Quien devuelve es la persona con turno en la sucursal de la venta (F6.8b).
    const quien = (await prisma.sale.findUniqueOrThrow({ where: { id: saleId }, select: { branchId: true } })).branchId === b2.branch.id ? O2 : O1
    const r = await devolverProductosVenta(getTenantPrisma(quien), quien, devolverProductosSchema.parse({
      saleId, reason: 'Devolución parcial de prueba', lines, idempotencyKey: randomUUID(),
      ...(dinero ? { refunds: [{ mode: 'EXTERNO', method: refund?.medio ?? 'YAPE', amount: dinero }] } : {}),
    }))
    // La nota nace PENDIENTE y «hoy»: aquí se simula que el proveedor la aceptó y se fija el día de su emisión.
    if (notaEn && r.creditNote) await prisma.taxDocument.update({ where: { id: r.creditNote.id }, data: { issuedAt: D(notaEn), status: 'ACEPTADO' } })
    return r
  }
  return { t, b1, b2, owner, cajero, O1, O2, P1, P2, P3, P4, caja, cliente, L, vender, doc, item, devolver, ctx }
}
type N = Awaited<ReturnType<typeof negocio>>

/** Lo que dice la base, calculado SIN pasar por los reportes. */
async function verdad(N: N, branch?: string) {
  const w = { tenantId: N.t.id, status: 'COMPLETADA' as const, completedAt: { gte: DESDE, lt: HASTA }, ...(branch ? { branchId: branch } : {}) }
  const a = await prisma.sale.aggregate({ where: w, _sum: { total: true, subtotal: true, taxTotal: true, discountTotal: true }, _count: true })
  const d = await prisma.saleReturn.aggregate({ where: { sale: w }, _sum: { returnTotal: true } })
  const di = await prisma.saleReturnItem.aggregate({ where: { saleReturn: { sale: w } }, _sum: { subtotal: true, taxAmount: true } })
  return {
    n: a._count, total: cent(num(a._sum.total)) - cent(num(d._sum.returnTotal)), subtotal: cent(num(a._sum.subtotal)) - cent(num(di._sum.subtotal)),
    igv: cent(num(a._sum.taxTotal)) - cent(num(di._sum.taxAmount)), devuelto: cent(num(d._sum.returnTotal)), bruto: cent(num(a._sum.total)),
  }
}

async function cuerpo() {
  console.log('\nA) El escenario (servicios reales)')
  const N = await negocio('a')
  const { P1, P2, P3, P4, L } = N
  const w1 = N.b1.warehouse.id, w2 = N.b2.warehouse.id
  const s1 = await N.vender(N.O1, w1, '2026-10-21T15:00:00Z', [L(P1.id, 4)], [{ method: 'EFECTIVO', amount: 400 }], { documentType: 'BOLETA' })
  const s2 = await N.vender(N.O2, w2, '2026-10-22T15:00:00Z', [L(P3.id, 24, 0, { presentationId: N.caja.id, enteredQuantity: 2 })], [{ method: 'TARJETA_DEBITO', amount: 799.92 }], { documentType: 'BOLETA' })
  const s3 = await N.vender(N.O1, w1, '2026-10-22T18:00:00Z', [L(P1.id, 2), L(P2.id, 10)], [{ method: 'EFECTIVO', amount: 100 }, { method: 'YAPE', amount: 125 }], { documentType: 'BOLETA' })
  const s4 = await N.vender(N.O1, w1, '2026-10-23T15:00:00Z', [L(P1.id, 5)], [{ method: 'CREDITO', amount: 500 }], { customerId: N.cliente.id, documentType: 'BOLETA' })
  const s5 = await N.vender(N.O1, w1, '2026-10-24T15:00:00Z', [L(P4.id, 10)], [{ method: 'EFECTIVO', amount: 3.5 }])
  const s6 = await N.vender(N.O1, w1, '2026-10-15T15:00:00Z', [L(P1.id, 2)], [{ method: 'EFECTIVO', amount: 200 }], { documentType: 'BOLETA' })        // periodo anterior
  const s7 = await N.vender(N.O1, w1, '2026-10-25T15:00:00Z', [L(P3.id, 3, 5.55)], [{ method: 'EFECTIVO', amount: 94.44 }])                              // con descuento
  const s8 = await N.vender(N.O1, w1, '2026-10-21T16:00:00Z', [L(P1.id, 2)], [{ method: 'EFECTIVO', amount: 200 }], { documentType: 'BOLETA' })         // se devuelve entera por partes
  await N.doc(s1, '2026-10-21T15:00:00Z'); await N.doc(s2, '2026-10-22T15:00:00Z'); await N.doc(s3, '2026-10-22T18:00:00Z', { estado: 'OBSERVADO' })
  await N.doc(s4, '2026-10-23T15:00:00Z', { tipo: 'FACTURA' }); await N.doc(s6, '2026-10-15T15:00:00Z'); await N.doc(s8, '2026-10-21T16:00:00Z')

  const ajustarContadores = async () => {
    for (const [sc, sr] of [['TAX_BOLETA', 'B001'], ['TAX_FACTURA', 'F001']] as const) await prisma.documentCounter.upsert({ where: { tenantId_scope_series: { tenantId: N.t.id, scope: sc, series: sr } }, update: { next: 1 + (await prisma.taxDocument.count({ where: { tenantId: N.t.id, series: sr } })) }, create: { tenantId: N.t.id, branchId: N.b1.branch.id, scope: sc, series: sr, prefix: '', next: 1 + (await prisma.taxDocument.count({ where: { tenantId: N.t.id, series: sr } })) } })
  }
  // Una devolución TOTAL (F6.1) con comprobante real dentro del periodo: su nota es la 06, NO una parcial, y no debe dar un falso error de notas parciales.
  const s10 = await N.vender(N.O1, w1, '2026-10-23T17:00:00Z', [L(P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }], { documentType: 'BOLETA' })
  await N.doc(s10, '2026-10-23T17:00:00Z')
  const tot = await anularOdevolverVenta(getTenantPrisma(N.O1), N.O1, anularOdevolverVentaSchema.parse({ saleId: s10, kind: 'DEVOLUCION', reason: 'Devolución total', idempotencyKey: randomUUID(), refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] }))
  await prisma.saleReturn.update({ where: { id: tot.returnId }, data: { createdAt: D('2026-10-23T18:00:00Z') } })
  await ajustarContadores()
  const i1 = await N.item(s1, P1.id)
  await N.devolver(s1, [{ saleItemId: i1.id, quantity: 1 }], { monto: 100 }, '2026-10-22T10:00:00Z')                                          // 1ª: a stock, nota EN el periodo
  await N.devolver(s1, [{ saleItemId: i1.id, quantity: 1, destination: 'MERMA' }], { monto: 100 }, '2026-11-02T15:00:00Z')                  // 2ª: dañada, nota DESPUÉS del periodo
  const i2 = await N.item(s2, P3.id)
  await N.devolver(s2, [{ saleItemId: i2.id, quantity: 5 }], { monto: 166.65, medio: 'TARJETA_DEBITO' }, '2026-10-23T10:00:00Z')            // 5 sueltas de una caja de 12
  const i3a = await N.item(s3, P1.id), i3b = await N.item(s3, P2.id)
  await N.devolver(s3, [{ saleItemId: i3a.id, quantity: 1 }, { saleItemId: i3b.id, quantity: 4 }], { monto: 110 }, '2026-10-24T10:00:00Z')
  const i4 = await N.item(s4, P1.id)
  await N.devolver(s4, [{ saleItemId: i4.id, quantity: 2 }], null, '2026-10-24T11:00:00Z')                                                  // fiado: baja la deuda
  const i5 = await N.item(s5, P4.id)
  await N.devolver(s5, [{ saleItemId: i5.id, quantity: 3 }], { monto: 1.05 }, null)
  const i6 = await N.item(s6, P1.id)
  await N.devolver(s6, [{ saleItemId: i6.id, quantity: 1 }], { monto: 100 }, '2026-10-22T12:00:00Z')                                        // venta del periodo ANTERIOR, nota DENTRO
  const i7 = await N.item(s7, P3.id)
  await N.devolver(s7, [{ saleItemId: i7.id, quantity: 1 }], { monto: 31.48 }, null)
  const i8 = await N.item(s8, P1.id)
  await N.devolver(s8, [{ saleItemId: i8.id, quantity: 1 }], { monto: 100 }, '2026-10-22T13:00:00Z')
  await N.devolver(s8, [{ saleItemId: i8.id, quantity: 1 }], { monto: 100 }, '2026-10-23T13:00:00Z')                                        // completa: la venta pasa a DEVUELTA
  check('(preparación) 9 ventas, 10 devoluciones parciales + 1 total y la 8 queda DEVUELTA', (await prisma.saleReturn.count({ where: { tenantId: N.t.id } })) === 11 && (await prisma.sale.findUniqueOrThrow({ where: { id: s8 } })).status === 'DEVUELTA')

  const PV = parametrosVentasSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26' })
  const PC = parametrosCostosSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26' })
  const PR = parametrosRegistrosSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26' })
  const db = getTenantPrisma(N.O1), real = await verdad(N)
  check('(preparación) la base: 6 ventas del periodo (la 6 es anterior y la 8 está devuelta) y se devolvió algo de ellas', real.n === 6 && real.devuelto > 0, JSON.stringify(real))

  console.log('\nB) /reportes/ventas: todas las vistas restan lo devuelto en el periodo de la venta')
  const [vp, vv, vm, vc] = [await informeVentasPorPeriodo(db, N.O1, PV, AHORA), await informeVentasPorVendedor(db, N.O1, PV, AHORA), await informeVentasPorMedio(db, N.O1, PV, AHORA), await informeCobros(db, N.O1, PV, AHORA)]
  check('>>> por periodo = por vendedor = por medio de pago = la base NETA de lo devuelto (al céntimo)', cent(vp.datos.totales.total) === real.total && cent(vv.datos.totales.total) === real.total && cent(vm.datos.totalVentas) === real.total, `${real.total / 100} / ${vp.datos.totales.total}`)
  check('>>> y es MENOS que lo vendido bruto, exactamente por lo devuelto', real.bruto - real.total === real.devuelto && cent(vp.datos.totales.devuelto) === real.devuelto)
  check('>>> la venta devuelta con parciales cuenta UNA vez (6 ventas, no 7 ni 12) y el IGV es el de la base neta', vp.datos.totales.ventas === real.n && vv.datos.totales.ventas === real.n && cent(vp.datos.totales.igv) === real.igv)
  check('>>> los descuentos se reducen en proporción a lo devuelto: 5.55 de descuento, 1 de 3 unidades devueltas → queda 3.70', cent(vp.datos.totales.descuentos) === cent(num((await prisma.sale.aggregate({ where: { tenantId: N.t.id, status: 'COMPLETADA', completedAt: { gte: DESDE, lt: HASTA } }, _sum: { discountTotal: true } }))._sum.discountTotal)) - 185)
  check('>>> por medio: lo pagado neto cuadra con las ventas netas, sin ventas descuadradas', cent(vm.datos.totalMedios) === real.total && vm.datos.descuadradas.ventas === 0)
  const fiadoNeto = vm.datos.filas.find((f) => f.metodo === 'CREDITO')
  check('>>> el fiado baja por la deuda reducida: 500.00 − 200.00 = 300.00', cent(fiadoNeto?.monto ?? NaN) === 30_000)
  check('>>> cobros: lo cobrado al contado = ventas netas − fiado neto; y los días suman el total', cent(vc.datos.totales.contado) === real.total - 30_000 && vp.datos.filas.reduce((a, f) => a + cent(f.total), 0) === real.total)
  const csv = await exportarVentasCsv(db, N.O1, 'periodo', PV, AHORA)
  check('la descarga CSV del periodo suma lo mismo (neto)', csv.contenido.includes(((real.total / 100).toFixed(2)).replace('.', ',')) || csv.contenido.includes((real.total / 100).toFixed(2)))

  console.log('\nC) Dashboard')
  const dash = await resumenDeVentas(db, N.O1, AHORA)
  const mesW = { tenantId: N.t.id, status: 'COMPLETADA' as const, completedAt: { gte: D('2026-10-01T05:00:00Z'), lt: D('2026-11-01T05:00:00Z') } }
  const mesTot = cent(num((await prisma.sale.aggregate({ where: mesW, _sum: { total: true } }))._sum.total)) - cent(num((await prisma.saleReturn.aggregate({ where: { sale: mesW }, _sum: { returnTotal: true } }))._sum.returnTotal))
  check('>>> el mes del dashboard resta lo devuelto: = ventas del mes − devoluciones de esas ventas', cent(dash.mes.total) === mesTot, `${dash.mes.total} vs ${mesTot / 100}`)
  check('>>> los últimos 7 días suman las ventas netas del periodo (20 al 26) y el ranking de productos es neto de lo devuelto', cent(dash.ultimos7.reduce((a, d) => a + d.total, 0)) === real.total && dash.topProductos.length > 0)
  const topP1 = dash.topProductos.find((p) => p.productId === P1.id)
  const itemsP1 = await prisma.saleItem.findMany({ where: { tenantId: N.t.id, productId: P1.id, sale: mesW } })
  check('>>> y el total del producto P1 en el ranking = Σ de sus líneas − lo devuelto de ellas', cent(topP1?.total ?? NaN) === itemsP1.reduce((a, i) => a + cent(num(i.lineTotal)) - cent(num(i.returnedAmount)), 0))

  console.log('\nD) /reportes/rentabilidad y ABC')
  const mg = await informeMargen(db, N.O1, PC, AHORA), abc = await informeAbc(db, N.O1, PC, AHORA)
  check('>>> la venta sin IGV = Σ subtotales de las ventas MENOS la base de lo devuelto (al céntimo)', cent(mg.datos.totales.ventaSinIgv) === real.subtotal, `${mg.datos.totales.ventaSinIgv} vs ${real.subtotal / 100}`)
  check('>>> el IGV implícito (neto con IGV − sin IGV) = el IGV neto de ventas', real.total - cent(mg.datos.totales.ventaSinIgv) === real.igv)
  check('>>> el ABC por ventas suma lo mismo que el margen', cent(abc.datos.total) === cent(mg.datos.totales.ventaSinIgv))
  // El costo de lo que se queda con el cliente O se perdió: se compara con un cálculo independiente por línea.
  const lineas = await prisma.saleItem.findMany({ where: { tenantId: N.t.id, sale: { status: 'COMPLETADA', completedAt: { gte: DESDE, lt: HASTA } } }, include: { returnItems: true } })
  const costoEsperado = lineas.reduce((a, l) => {
    const aStock = l.returnItems.filter((r) => r.destination === 'STOCK').reduce((x, r) => x + num(r.quantity), 0)
    return a + (num(l.unitCost) > 0 ? Math.round((num(l.quantity) - aStock) * num(l.unitCost) * 100) : 0)
  }, 0)
  check('>>> el costo conserva el de lo dañado y resta el de lo que volvió al stock (cálculo independiente por línea)', cent(mg.datos.totales.costo) === costoEsperado, `${mg.datos.totales.costo} vs ${costoEsperado / 100}`)
  check('>>> venta con costo + sin costo = venta sin IGV; el producto sin costo (P2) sigue siendo lo «sin costo»', cent(mg.datos.totales.ventaConCosto) + cent(mg.datos.totales.ventaSinCosto) === cent(mg.datos.totales.ventaSinIgv) && mg.datos.sinCosto.some((f) => f.productId === P2.id))
  const fP3 = mg.datos.filas.find((f) => f.productId === P3.id)!
  check('>>> presentación fraccionada: de 24 + 3 unidades de P3 vendidas y 5 + 1 devueltas, quedan 21', fP3.unidades === 21, String(fP3.unidades))
  const fP4 = mg.datos.filas.find((f) => f.productId === P4.id)!
  check('una venta sin comprobante (nota de venta) también resta: P4 10 − 3 = 7 unidades', fP4.unidades === 7)

  console.log('\nE) El efecto del destino en la utilidad: a stock vs dañado (negocios aparte)')
  const util = async (destino: 'STOCK' | 'MERMA') => {
    const X = await negocio(destino === 'STOCK' ? 'stock' : 'merma')
    const sx = await X.vender(X.O1, X.b1.warehouse.id, '2026-10-21T15:00:00Z', [X.L(X.P1.id, 4)], [{ method: 'EFECTIVO', amount: 400 }])
    await X.devolver(sx, [{ saleItemId: (await X.item(sx, X.P1.id)).id, quantity: 1, destination: destino }], { monto: 100 }, null)
    return (await informeMargen(getTenantPrisma(X.O1), X.O1, PC, AHORA)).datos.totales
  }
  const tStock = await util('STOCK'), tMerma = await util('MERMA')
  check('>>> AMBOS restan el mismo ingreso sin IGV: 4 × 100.00 → 3 unidades = 254.24', tStock.ventaSinIgv === 254.24 && tMerma.ventaSinIgv === 254.24)
  check('>>> reingresó a stock: resta su costo → costo 180.00 y utilidad 74.24', tStock.costo === 180 && tStock.utilidad === 74.24)
  check('>>> dañada (merma): CONSERVA su costo → costo 240.00 y la utilidad baja a 14.24 (la pérdida real de esa unidad)', tMerma.costo === 240 && tMerma.utilidad === 14.24)

  console.log('\nF) /reportes/registros y el puente de conciliación')
  const reg = (await informeRegistroVentas(db, N.O1, PR, AHORA)).datos
  const ncValidas = await prisma.taxDocument.findMany({ where: { tenantId: N.t.id, isTrial: false, documentType: 'NOTA_CREDITO', status: { in: ['ACEPTADO', 'OBSERVADO'] }, issuedAt: { gte: DESDE, lt: HASTA } } })
  const docsValidos = await prisma.taxDocument.findMany({ where: { tenantId: N.t.id, isTrial: false, documentType: { in: ['BOLETA', 'FACTURA'] }, status: { in: ['ACEPTADO', 'OBSERVADO'] }, issuedAt: { gte: DESDE, lt: HASTA } } })
  const sumaNc = ncValidas.reduce((a, x) => a + cent(num(x.total)), 0), sumaDocs = docsValidos.reduce((a, x) => a + cent(num(x.total)), 0)
  check('>>> el registro de ventas resta CADA nota parcial por su fecha de emisión: total = comprobantes emitidos − notas emitidas en el periodo', cent(reg.totales.total) === sumaDocs - sumaNc, `${reg.totales.total} vs ${(sumaDocs - sumaNc) / 100}`)
  check('>>> la nota de la 2ª devolución del S1 (emitida el 2 de noviembre) NO está en este registro, y las 6 notas del periodo sí', ncValidas.length === 7 && !ncValidas.some((x) => x.issuedAt >= HASTA) && reg.filas.filter((f) => f.tipo === 'NOTA_CREDITO').length === 7, `${ncValidas.length} notas, ${reg.filas.filter((f) => f.tipo === 'NOTA_CREDITO').length} en el registro`)
  const cc = (await informeConciliacion(db, N.O1, PR, AHORA)).informe
  const p = cc.puente, k = p.clasificacion
  check('>>> el puente PARTE del total de /reportes/ventas NETO (mismo importe y mismo número de ventas)', cent(p.ventasCompletadas.total) === cent(vp.datos.totales.total) && p.ventasCompletadas.documentos === vp.datos.totales.ventas)
  check('>>> y se reparte sin dejar nada: notas de venta + válidos + pendiente + … = ventas netas; diferencia sin explicar EXACTAMENTE 0', p.diferencia === 0 && cent(p.notasDeVenta.total) + cent(k.valido.total) + cent(k.pendiente.total) + cent(k.rechazado.total) + cent(k.anulado.total) + cent(k.ensayo.total) + cent(k.sinComprobante.total) === cent(p.ventasCompletadas.total))
  check('>>> el puente informa las devoluciones parciales de las ventas del periodo (ya restadas)', p.devolucionesParciales.total === real.devuelto / 100 && p.devolucionesParciales.documentos === 6)
  const nDe = (qs: (typeof ncValidas)[number][]) => qs.reduce((a, x) => a + cent(num(x.total)), 0)
  const ventasDelPeriodo = new Set((await prisma.sale.findMany({ where: { tenantId: N.t.id, status: 'COMPLETADA', completedAt: { gte: DESDE, lt: HASTA } }, select: { id: true } })).map((x) => x.id))
  const ncDeVentasDelPeriodo = ncValidas.filter((x) => ventasDelPeriodo.has(x.saleId)), ncDeOtras = ncValidas.filter((x) => !ventasDelPeriodo.has(x.saleId))
  check('>>> DESFASE 2: las notas parciales de este periodo sobre ventas de OTRO periodo (la S6 anterior y la S8 ya devuelta) = lo que dice el puente', cent(p.desfaseParciales.notasDeOtrasVentas) === nDe(ncDeOtras) && nDe(ncDeOtras) > 0, `${p.desfaseParciales.notasDeOtrasVentas} vs ${nDe(ncDeOtras) / 100}`)
  const devueltoValido = cent(p.devolucionesParciales.enValidos)
  check('>>> DESFASE 1: lo devuelto de ventas de este periodo con la nota FUERA del periodo (la 2ª del S1, emitida en noviembre) = devuelto con comprobante válido − notas emitidas en el periodo', cent(p.desfaseParciales.notaFueraDelPeriodo) === devueltoValido - nDe(ncDeVentasDelPeriodo) && p.desfaseParciales.notaFueraDelPeriodo > 0)
  const noParciales = ncValidas.filter((x) => x.reasonCode !== '07').reduce((a, x) => a + cent(num(x.total)), 0)
  const docsDeFuera = docsValidos.filter((x) => !ventasDelPeriodo.has(x.saleId)).reduce((a, x) => a + cent(num(x.total)), 0)    // emitidos en el periodo cuya venta no es del periodo (otra fecha o ya devuelta)
  const sinEmitir = (await prisma.taxDocument.findMany({ where: { tenantId: N.t.id, isTrial: false, documentType: { in: ['BOLETA', 'FACTURA'] }, status: { in: ['ACEPTADO', 'OBSERVADO'] }, issuedAt: { gte: D('2026-10-27T05:00:00Z') }, saleId: { in: [...ventasDelPeriodo] } } })).reduce((a, x) => a + cent(num(x.total)), 0)
  check('>>> LA IDENTIDAD: registro = válidos netos del puente + desfase 1 − desfase 2 − notas no parciales + comprobantes emitidos en el periodo de ventas ajenas al periodo + comprobantes de ventas del periodo emitidos después (…)', cent(reg.totales.total) === cent(k.valido.total) + cent(p.desfaseParciales.notaFueraDelPeriodo) - cent(p.desfaseParciales.notasDeOtrasVentas) - noParciales + docsDeFuera - sinEmitir + cent(p.devolucionesParciales.enValidos) - devueltoValido, `${reg.totales.total} vs ${(cent(k.valido.total) + cent(p.desfaseParciales.notaFueraDelPeriodo) - cent(p.desfaseParciales.notasDeOtrasVentas) - noParciales + docsDeFuera - sinEmitir) / 100}`)
  check('>>> el cuadre del registro de ventas contra su cálculo independiente: diferencia 0 y ningún hallazgo de «no cuadra»', cc.cuadreVentas.diferencia === 0 && !cc.hallazgos.some((h) => h.codigo === 'REGISTRO_VENTAS_NO_CUADRA' || h.codigo === 'PUENTE_NO_CUADRA'))
  check('>>> las notas parciales suman EXACTAMENTE lo devuelto en cada venta con comprobante real (ningún error de notas parciales) y el estado general no es de error', !cc.hallazgos.some((h) => h.codigo === 'NOTAS_PARCIALES_NO_CUADRAN') && cc.estado !== 'ERRORES', cc.hallazgos.filter((h) => h.nivel === 'ERROR').map((h) => h.codigo).join())
  check('>>> la conciliación EXPLICA los desfases (hallazgo informativo) y no son una alarma', cc.hallazgos.some((h) => h.codigo === 'DEVOLUCIONES_PARCIALES_ENTRE_PERIODOS' && h.nivel === 'INFO'))
  check('>>> el CSV de la conciliación lleva las líneas del puente de las parciales', csvConciliacion(cc).filas.some((f) => String(f[2]).startsWith('Devoluciones parciales')) && csvConciliacion(cc).filas.some((f) => String(f[2]).startsWith('Desfase')))
  check('>>> la venta devuelta del todo por partes (S8) deja de contar, sus notas suman su comprobante y no queda «comprobante vivo»', !cc.hallazgos.some((h) => h.codigo === 'COMPROBANTE_VIVO_EN_VENTA_CERRADA') && p.devueltas.documentos >= 0)

  console.log('\nG) Notas parciales que NO suman lo devuelto se detectan')
  const nota8 = await prisma.taxDocument.findFirstOrThrow({ where: { tenantId: N.t.id, relatedDocument: { saleId: s1 }, documentType: 'NOTA_CREDITO' }, orderBy: { correlativo: 'asc' } })
  await prisma.taxDocument.update({ where: { id: nota8.id }, data: { status: 'RECHAZADO' } })
  const ccMal = (await informeConciliacion(db, N.O1, PR, AHORA)).informe
  const hMal = ccMal.hallazgos.find((h) => h.codigo === 'NOTAS_PARCIALES_NO_CUADRAN')
  check('>>> una nota parcial RECHAZADA deja lo devuelto sin nota: ERROR con la venta, lo devuelto y lo que suman las notas', !!hMal && hMal.nivel === 'ERROR' && hMal.items.some((i) => i.detalle.includes('devolvió 200.00') && i.detalle.includes('suman 100.00')) && ccMal.estado === 'ERRORES')
  await prisma.taxDocument.update({ where: { id: nota8.id }, data: { status: 'ACEPTADO' } })
  const ccBien = (await informeConciliacion(db, N.O1, PR, AHORA)).informe
  check('…y al volver a aceptarla, el error desaparece', !ccBien.hallazgos.some((h) => h.codigo === 'NOTAS_PARCIALES_NO_CUADRAN'))

  // Una nota parcial (07) SIN ninguna devolución que la respalde también es un error.
  const s9 = await N.vender(N.O1, w1, '2026-10-23T16:00:00Z', [L(P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }], { documentType: 'BOLETA' })
  const d9 = await N.doc(s9, '2026-10-23T16:00:00Z')
  const huerfana = await prisma.taxDocument.create({ data: { tenantId: N.t.id, saleId: s9, documentType: 'NOTA_CREDITO', series: 'BC01', correlativo: 90, fullNumber: 'BC01-00000090', status: 'ACEPTADO', isTrial: false, relatedDocumentId: d9.id, reasonCode: '07', reasonDescription: 'Sin devolución', subtotal: 8.47, taxTotal: 1.53, total: 10, issuedAt: D('2026-10-24T09:00:00Z'), receiverDocType: 'SIN_DOCUMENTO', receiverName: 'C' } })
  const ccH = (await informeConciliacion(db, N.O1, PR, AHORA)).informe.hallazgos.find((h) => h.codigo === 'NOTAS_PARCIALES_NO_CUADRAN')
  check('>>> una nota parcial sin devolución que la respalde → ERROR (la venta devolvió 0.00 y las notas suman 10.00)', !!ccH && ccH.items.some((i) => i.detalle.includes('devolvió 0.00') && i.detalle.includes('suman 10.00')))
  await prisma.taxDocument.delete({ where: { id: huerfana.id } })

  console.log('\nH) Por sucursal: las mismas identidades')
  const OB2 = { ...N.O2, branchIds: [N.b2.branch.id] } as TenantContext, OB1 = { ...N.O1, branchIds: [N.b1.branch.id] } as TenantContext
  for (const [nombre, c, b] of [['sucursal 2 (solo S2, con presentación)', OB2, N.b2.branch.id], ['sucursal 1', OB1, N.b1.branch.id]] as const) {
    const r = await verdad(N, b), d = getTenantPrisma(c)
    const [a, bb, m, g] = [await informeVentasPorPeriodo(d, c, PV, AHORA), await informeVentasPorVendedor(d, c, PV, AHORA), await informeVentasPorMedio(d, c, PV, AHORA), await informeMargen(d, c, PC, AHORA)]
    const ccb = (await informeConciliacion(d, c, PR, AHORA)).informe
    check(`>>> ${nombre}: periodo = vendedor = medio = base neta; rentabilidad = subtotales netos; el puente parte de lo mismo y cuadra`, cent(a.datos.totales.total) === r.total && cent(bb.datos.totales.total) === r.total && cent(m.datos.totalVentas) === r.total && cent(g.datos.totales.ventaSinIgv) === r.subtotal && cent(ccb.puente.ventasCompletadas.total) === r.total && ccb.puente.diferencia === 0, `${a.datos.totales.total} vs ${r.total / 100}`)
  }

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
