import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { openCashSession } from '../src/features/branches/cash-service'
import { openCashSchema } from '../src/features/branches/cash-schemas'
import { crearPresentacion } from '../src/features/inventory/presentaciones-service'
import { crearBorrador, recibirCompra } from '../src/features/compras/service'
import { crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { informeCobros, informeVentasPorMedio, informeVentasPorPeriodo, informeVentasPorVendedor } from '../src/features/reportes/ventas-service'
import { parametrosCostosSchema, parametrosVentasSchema } from '../src/features/reportes/schemas'
import { informeAbc, informeInventario, informeMargen } from '../src/features/reportes/rentabilidad-service'
import { informeRegistroCompras, informeRegistroVentas } from '../src/features/registros/registro-service'
import { parametrosRegistrosSchema } from '../src/features/registros/schemas'
import { informeConciliacion } from '../src/features/conciliacion/conciliacion-service'
import { anularOdevolverVenta } from '../src/features/devoluciones/service'
import { anularOdevolverVentaSchema } from '../src/features/devoluciones/schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F5.8 · IDENTIDADES ENTRE REPORTES, con datos variados creados por los servicios reales (ventas con descuento, presentaciones, exentos,
 * fiado, pagos mixtos con vuelto, vendedores distintos, compras con y sin documento y costo, dos sucursales) y comprobantes y notas de crédito.
 * Lo que se demuestra: los reportes de Fase 5 no solo son correctos cada uno, sino que dicen LO MISMO entre sí.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const cent = (n: number) => Math.round(n * 100)
const AHORA = new Date('2026-10-27T03:00:00Z')   // lunes 26/10/2026 22:00 en Lima
const DESDE = new Date('2026-10-20T05:00:00Z'), HASTA = new Date('2026-10-27T05:00:00Z')

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 300) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  console.log('\nA) El escenario (servicios reales)')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-ident-${randomUUID().slice(0, 6)}`, name: 'Identidades', taxId: ruc(), planId: plan.id, realBillingEnabledAt: new Date('2026-01-01T00:00:00Z') } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_id' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const todas = [b1.branch.id, b2.branch.id]
  const mk = async (role: Role) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    for (const b of todas) await asignarSucursal(t.id, u.id, b)
    return u
  }
  const owner = await mk('OWNER'), cajero = await mk('CAJERO')
  const ctx = (u: { id: string }, role: Role, branchId: string, branchIds = todas): TenantContext => ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId, branchIds, permisosExtra: [] })
  const O1 = ctx(owner, 'OWNER', b1.branch.id), O2 = ctx(owner, 'OWNER', b2.branch.id), C1 = ctx(cajero, 'CAJERO', b1.branch.id)
  const OALL = O1, OB1 = { ...O1, branchIds: [b1.branch.id] } as TenantContext
  const db = getTenantPrisma(O1), dbB2 = getTenantPrisma(O2), dbC = getTenantPrisma(C1)
  await openCashSession(db, O1, openCashSchema.parse({ openingAmount: 100 }))
  await openCashSession(dbB2, O2, openCashSchema.parse({ openingAmount: 100 })).catch(() => undefined)

  const prod = (sku: string, o: Record<string, unknown>) => prisma.product.create({ data: { tenantId: t.id, sku, name: `Prod ${sku}`, unitType: 'UNIDAD', ...o } })
  const P1 = await prod('P1', { salePrice: 100, costPrice: 60 }), P2 = await prod('P2', { salePrice: 2.5, costPrice: 0, taxRate: 0 })
  const P3 = await prod('P3', { salePrice: 33.33, costPrice: 17.77 }), P4 = await prod('P4', { salePrice: 0.35, costPrice: 0.1 })
  for (const p of [P1, P2, P3, P4]) for (const w of [b1.warehouse, b2.warehouse]) await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: w.id, quantity: 500 } })
  const caja = await crearPresentacion(db, O1, { productId: P3.id, name: 'Caja x 12', unitType: 'CAJA', factor: '12' })
  const cliente = await prisma.customer.create({ data: { tenantId: t.id, name: 'Constructora SAC', docType: 'RUC', docNumber: ruc(), creditLimit: 5000 } })

  type Sede = { ctx: TenantContext; db: ReturnType<typeof getTenantPrisma>; w: string }
  const S1: Sede = { ctx: O1, db, w: b1.warehouse.id }, S2: Sede = { ctx: O2, db: dbB2, w: b2.warehouse.id }, SC: Sede = { ctx: C1, db: dbC, w: b1.warehouse.id }
  const vender = (s: Sede, items: unknown[], payments: unknown[], over: Record<string, unknown> = {}) =>
    registerSale(s.db, s.ctx, registerSaleSchema.parse({ warehouseId: s.w, items, payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID(), ...over }) as never)
  const L = (productId: string, quantity: number, discount = 0, extra: Record<string, unknown> = {}) => ({ productId, quantity, discount, ...extra })

  const v1 = await vender(S1, [L(P1.id, 2)], [{ method: 'EFECTIVO', amount: 200 }], { documentType: 'BOLETA' })                                   // 200.00
  const v2 = await vender(S1, [L(P3.id, 3, 5.55)], [{ method: 'EFECTIVO', amount: 100 }], { documentType: 'BOLETA' })                              // 3×33.33 − 5.55 = 94.44
  const v3 = await vender(S2, [L(P3.id, 24, 0, { presentationId: caja.id, enteredQuantity: 2 })], [{ method: 'TARJETA_DEBITO', amount: 799.92 }], { documentType: 'BOLETA' })   // 2 cajas
  const v4 = await vender(S1, [L(P1.id, 5)], [{ method: 'CREDITO', amount: 500 }], { customerId: cliente.id, documentType: 'BOLETA' })               // fiado 500.00
  const v5 = await vender(S1, [L(P1.id, 1), L(P2.id, 10)], [{ method: 'EFECTIVO', amount: 100 }, { method: 'YAPE', amount: 25 }], { documentType: 'BOLETA' })   // 125.00 mixto
  const v6 = await vender(S2, [L(P2.id, 7), L(P4.id, 3.5)], [{ method: 'EFECTIVO', amount: 20 }], { documentType: 'BOLETA' })                      // exento + decimales, con vuelto
  const v7 = await vender(SC, [L(P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }], { documentType: 'BOLETA' })                                 // otro cajero
  const v8 = await vender(S1, [L(P4.id, 1)], [{ method: 'EFECTIVO', amount: 1 }])                                                                    // nota de venta
  const v9 = await vender(S1, [L(P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }], { documentType: 'BOLETA' })                                    // se anula después
  const v10 = await vender(S1, [L(P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }], { documentType: 'BOLETA' })                                   // fuera del periodo
  const ids = [v1, v2, v3, v4, v5, v6, v7, v8, v9, v10].map((v) => (v as { id?: string; saleId?: string }).id ?? (v as { saleId: string }).saleId)
  const en = ['2026-10-21T15:00:00Z', '2026-10-21T16:00:00Z', '2026-10-22T15:00:00Z', '2026-10-23T15:00:00Z', '2026-10-26T04:59:59Z', '2026-10-24T15:00:00Z', '2026-10-25T15:00:00Z', '2026-10-24T17:00:00Z', '2026-10-22T18:00:00Z', '2026-10-27T05:00:00Z']
  for (let i = 0; i < ids.length; i++) {
    await prisma.sale.update({ where: { id: ids[i]! }, data: { completedAt: new Date(en[i]!) } })
    await prisma.payment.updateMany({ where: { saleId: ids[i]! }, data: { receivedAt: new Date(en[i]!) } })
  }
  await prisma.sale.update({ where: { id: ids[8]! }, data: { status: 'ANULADA', voidedAt: new Date(), voidReason: 'Prueba' } })
  const ventas = await prisma.sale.findMany({ where: { tenantId: t.id }, orderBy: { number: 'asc' } })
  check('(preparación) 10 ventas creadas por registerSale', ventas.length === 10)

  // Comprobantes tal como los emite el servicio: los importes se COPIAN de la venta.
  let corr = 0
  const doc = async (saleId: string, o: { estado?: string; tipo?: 'BOLETA' | 'FACTURA'; en: string }) => {
    const s = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } })
    const tipo = o.tipo ?? 'BOLETA', serie = tipo === 'FACTURA' ? 'F001' : 'B001', c = ++corr
    return prisma.taxDocument.create({ data: {
      tenantId: t.id, saleId, documentType: tipo, series: serie, correlativo: c, fullNumber: `${serie}-${String(c).padStart(8, '0')}`, status: (o.estado ?? 'ACEPTADO') as never, isTrial: false,
      subtotal: s.subtotal, taxTotal: s.taxTotal, discountTotal: s.discountTotal, total: s.total, issuedAt: new Date(o.en),
      receiverDocType: tipo === 'FACTURA' ? 'RUC' : 'SIN_DOCUMENTO', receiverDocNumber: tipo === 'FACTURA' ? ruc() : null, receiverName: 'Cliente', externalId: `ext-${c}`,
    } })
  }
  const d1 = await doc(ids[0]!, { en: en[0]! }), d2 = await doc(ids[1]!, { en: en[1]! }), d3 = await doc(ids[2]!, { en: en[2]! })
  await doc(ids[3]!, { en: en[3]!, tipo: 'FACTURA', estado: 'OBSERVADO' })
  await doc(ids[4]!, { en: en[4]! })
  await doc(ids[5]!, { en: en[5]!, estado: 'PENDIENTE' })
  await doc(ids[6]!, { en: en[6]!, estado: 'RECHAZADO' })
  // v8 es nota de venta (sin comprobante). v9 anulada. v10 fuera del periodo.
  await prisma.taxDocument.create({ data: { tenantId: t.id, saleId: ids[1]!, documentType: 'NOTA_CREDITO', series: 'BC01', correlativo: 1, fullNumber: 'BC01-00000001', status: 'ACEPTADO', isTrial: false, subtotal: 80, taxTotal: 14.4, total: 94.4, issuedAt: new Date('2026-10-22T10:00:00Z'), relatedDocumentId: d2.id, reasonCode: '07', reasonDescription: 'Devolución parcial' } })
  void d1; void d3
  for (const [sc, sr, nx] of [['TAX_BOLETA', 'B001', corr + 1], ['TAX_FACTURA', 'F001', 2], ['TAX_NC_BOLETA', 'BC01', 2]] as const) await prisma.documentCounter.upsert({ where: { tenantId_scope_series: { tenantId: t.id, scope: sc, series: sr } }, update: { next: nx }, create: { tenantId: t.id, branchId: b1.branch.id, scope: sc, series: sr, prefix: '', next: nx, startNumber: 1 } })

  // Compras: con documento y costo, sin documento (provisional), con costo cero, en la sucursal 2.
  const prov = await prisma.supplier.create({ data: { tenantId: t.id, name: 'Proveedor', taxId: ruc() } })
  const comprar = async (c: TenantContext, o: Record<string, unknown>, items: unknown[]) => {
    const k = await crearBorrador(getTenantPrisma(c), c, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: c.branchId === b2.branch.id ? b2.warehouse.id : b1.warehouse.id, supplierId: prov.id, items, ...o }))
    await recibirCompra(getTenantPrisma(c), c, recibirCompraSchema.parse({ purchaseId: k.id }))
    return k
  }
  const k1 = await comprar(O1, { docType: 'FACTURA', docSeries: 'F001', docNumber: '1', issueDate: '2026-10-22' }, [{ productId: P1.id, enteredQuantity: 10, unitCost: 55.5 }])
  const k2 = await comprar(O1, { invoiceRef: 'LIBRE' }, [{ productId: P3.id, enteredQuantity: 4, unitCost: 17.1234 }])
  const k3 = await comprar(O1, { docType: 'BOLETA', docSeries: 'B001', docNumber: '2', issueDate: '2026-10-23' }, [{ productId: P4.id, enteredQuantity: 100, unitCost: 0 }])
  const k4 = await comprar(O2, { docType: 'FACTURA', docSeries: 'F002', docNumber: '3', issueDate: '2026-10-24' }, [{ productId: P2.id, enteredQuantity: 50, unitCost: 1.3333 }])
  await prisma.purchase.update({ where: { id: k2.id }, data: { receivedAt: new Date('2026-10-24T15:00:00Z') } })
  await prisma.purchase.update({ where: { id: k3.id }, data: { receivedAt: new Date('2026-10-24T16:00:00Z') } })
  void k1; void k4

  const PV = parametrosVentasSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26' })
  const PC = parametrosCostosSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26' })
  const PR = parametrosRegistrosSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26' })
  const enPeriodo = { tenantId: t.id, status: 'COMPLETADA' as const, completedAt: { gte: DESDE, lt: HASTA } }
  const sumas = async (extra: Record<string, unknown> = {}) => { const a = await prisma.sale.aggregate({ where: { ...enPeriodo, ...extra }, _sum: { total: true, subtotal: true, taxTotal: true, discountTotal: true }, _count: true }); return { n: a._count, total: cent(num(a._sum.total)), subtotal: cent(num(a._sum.subtotal)), igv: cent(num(a._sum.taxTotal)), desc: cent(num(a._sum.discountTotal)) } }
  const real = await sumas()
  check('(preparación) 8 ventas completadas en el periodo (la anulada y la de fuera NO) y compras recibidas', real.n === 8 && (await prisma.purchase.count({ where: { tenantId: t.id, status: 'RECIBIDA' } })) === 4, String(real.n))

  console.log('\nB) /reportes/ventas: todas las vistas dicen lo mismo')
  const [vp, vv, vm, vc] = [await informeVentasPorPeriodo(db, OALL, PV, AHORA), await informeVentasPorVendedor(db, OALL, PV, AHORA), await informeVentasPorMedio(db, OALL, PV, AHORA), await informeCobros(db, OALL, PV, AHORA)]
  check('>>> por periodo = por vendedor = por medio de pago = suma de las ventas completadas de la base (al céntimo)', cent(vp.datos.totales.total) === real.total && cent(vv.datos.totales.total) === real.total && cent(vm.datos.totalVentas) === real.total, `${real.total / 100} / ${vp.datos.totales.total} / ${vv.datos.totales.total} / ${vm.datos.totalVentas}`)
  check('>>> y el mismo número de ventas en las tres vistas', vp.datos.totales.ventas === real.n && vv.datos.totales.ventas === real.n)
  check('>>> el IGV y los descuentos del periodo = los de la base', cent(vp.datos.totales.igv) === real.igv && cent(vp.datos.totales.descuentos) === real.desc, `${vp.datos.totales.igv} / ${real.igv / 100}`)
  check('>>> por medio: lo pagado (neto de vuelto, con el fiado como medio) cuadra con las ventas, sin ventas descuadradas', cent(vm.datos.totalMedios) === real.total && vm.datos.descuadradas.ventas === 0)
  check('>>> los días suman el total (7 días sin huecos) y por vendedor hay dos personas', vp.datos.filas.length === 7 && vp.datos.filas.reduce((a, f) => a + cent(f.total), 0) === real.total && vv.datos.filas.length === 2)
  const fiado = cent(500)
  check('>>> cobros = ventas − lo fiado (no entró dinero) − vuelto: el fiado de 500.00 está fuera de los cobros del día de la venta', cent(vc.datos.totales.contado) === real.total - fiado && vc.datos.totales.abonos === 0 && cent(vc.datos.totales.total) === real.total - fiado)

  console.log('\nC) /reportes/rentabilidad ↔ ventas')
  const mg = await informeMargen(db, OALL, PC, AHORA)
  check('>>> la venta sin IGV de rentabilidad = la suma EXACTA de los subtotales de las ventas completadas', cent(mg.datos.totales.ventaSinIgv) === real.subtotal, `${mg.datos.totales.ventaSinIgv} vs ${real.subtotal / 100}`)
  check('>>> el IGV implícito (total − sin IGV) = el IGV de ventas', real.total - cent(mg.datos.totales.ventaSinIgv) === real.igv)
  check('>>> venta con costo + sin costo = venta sin IGV; el producto P2 (costo 0) es lo «sin costo»', cent(mg.datos.totales.ventaConCosto) + cent(mg.datos.totales.ventaSinCosto) === cent(mg.datos.totales.ventaSinIgv) && mg.datos.sinCosto.some((f) => f.productId === P2.id) && mg.datos.totales.cobertura < 100)
  const abc = await informeAbc(db, OALL, PC, AHORA)
  check('>>> el ABC por ventas suma lo mismo que el margen (todos los productos vendidos)', cent(abc.datos.total) === cent(mg.datos.totales.ventaSinIgv))
  const inv = await informeInventario(db, OALL, AHORA)
  const stocks = await prisma.stock.findMany({ where: { tenantId: t.id }, include: { product: true } })
  const esperadoInv = stocks.filter((s) => num(s.quantity) > 0 && num(s.product.costPrice) > 0).reduce((a, s) => a + Math.round(num(s.quantity) * num(s.product.costPrice) * 100), 0)
  check('>>> el valor del inventario = Σ saldo positivo × costo actual de la base (al céntimo)', Math.abs(cent(inv.datos.totales.valor) - esperadoInv) <= stocks.length, `${inv.datos.totales.valor} vs ${esperadoInv / 100}`)

  console.log('\nD) /reportes/conciliacion: del total de ventas al registro')
  const cc = (await informeConciliacion(db, OALL, PR, AHORA)).informe
  const reg = (await informeRegistroVentas(db, OALL, PR, AHORA)).datos
  check('>>> el puente PARTE del total de /reportes/ventas (mismo importe y mismo número de ventas)', cent(cc.puente.ventasCompletadas.total) === cent(vp.datos.totales.total) && cc.puente.ventasCompletadas.documentos === vp.datos.totales.ventas)
  const k = cc.puente.clasificacion
  check('>>> y se reparte sin dejar nada: notas de venta + válidos + pendiente + rechazado + anulado + ensayo + sin comprobante = total de ventas; diferencia 0', cc.puente.diferencia === 0 && cent(cc.puente.notasDeVenta.total) + cent(k.valido.total) + cent(k.pendiente.total) + cent(k.rechazado.total) + cent(k.anulado.total) + cent(k.ensayo.total) + cent(k.sinComprobante.total) === cent(cc.puente.ventasCompletadas.total))
  check('>>> cada categoría tiene lo que debe (5 válidos, 1 pendiente, 1 rechazado, 1 nota de venta, 0 sin comprobante)', k.valido.documentos === 5 && k.pendiente.documentos === 1 && k.rechazado.documentos === 1 && cc.puente.notasDeVenta.documentos === 1 && k.sinComprobante.documentos === 0)
  const nc = 94.4
  check('>>> LLEGA al registro de ventas: total del registro = válidos del puente − notas de crédito emitidas (diferencia 0)', cent(reg.totales.total) === cent(k.valido.total) - cent(nc) && cc.cuadreVentas.diferencia === 0 && cent(cc.cuadreVentas.registro) === cent(reg.totales.total), `${reg.totales.total} vs ${k.valido.total} − ${nc}`)
  check('>>> el registro y su cálculo independiente de la base coinciden; base + IGV = total', cc.cuadreVentas.independiente === reg.totales.total && Math.abs(cent(reg.totales.base) + cent(reg.totales.igv) - cent(reg.totales.total)) <= reg.totales.documentos)
  check('>>> lo pendiente y lo rechazado aparecen en el control del registro, no en su total', reg.control.find((x) => x.estado === 'PENDIENTE')!.documentos === 1 && reg.control.find((x) => x.estado === 'RECHAZADO')!.documentos === 1)

  console.log('\nE) Compras: conciliación ↔ registros')
  const rc = (await informeRegistroCompras(db, OALL, PR, AHORA)).datos
  const sumaCompras = await prisma.purchase.findMany({ where: { tenantId: t.id, status: 'RECIBIDA' } })
  check('>>> el cuadre de compras de la conciliación = el total del registro de compras (al céntimo) y su cálculo independiente', cent(cc.cuadreCompras.registro) === cent(rc.totales.total) && cc.cuadreCompras.diferencia === 0 && cc.cuadreCompras.independiente === rc.totales.total)
  check('>>> el registro de compras = la suma de las compras recibidas del periodo en la base (4 compras)', rc.filas.length === 4 && cent(rc.totales.total) === sumaCompras.reduce((a, p) => a + cent(num(p.total)), 0))
  check('>>> base + IGV = total, y el control cuenta la provisional (la compra sin documento)', cent(rc.totales.base) + cent(rc.totales.igv) === cent(rc.totales.total) && rc.control.provisionales === 1)

  console.log('\nF) Por sucursal: las mismas identidades con una sola sucursal')
  const real1 = await sumas({ branchId: b1.branch.id })
  const [v1p, v1v, v1m] = [await informeVentasPorPeriodo(getTenantPrisma(OB1), OB1, PV, AHORA), await informeVentasPorVendedor(getTenantPrisma(OB1), OB1, PV, AHORA), await informeVentasPorMedio(getTenantPrisma(OB1), OB1, PV, AHORA)]
  check('>>> sucursal 1: por periodo = por vendedor = por medio = base, y es MENOS que el total del negocio', cent(v1p.datos.totales.total) === real1.total && cent(v1v.datos.totales.total) === real1.total && cent(v1m.datos.totalVentas) === real1.total && real1.total < real.total)
  const m1 = await informeMargen(getTenantPrisma(OB1), OB1, PC, AHORA)
  check('>>> sucursal 1: la venta sin IGV de rentabilidad = subtotales de la base', cent(m1.datos.totales.ventaSinIgv) === real1.subtotal)
  const c1 = (await informeConciliacion(getTenantPrisma(OB1), OB1, PR, AHORA)).informe
  const r1 = (await informeRegistroCompras(getTenantPrisma(OB1), OB1, PR, AHORA)).datos
  check('>>> sucursal 1: el puente parte del total de ventas de la sucursal y cuadra; compras: conciliación = registro y sin la compra de la sucursal 2', cent(c1.puente.ventasCompletadas.total) === real1.total && c1.puente.diferencia === 0 && cent(c1.cuadreCompras.registro) === cent(r1.totales.total) && c1.cuadreCompras.diferencia === 0 && r1.filas.length === 3)
  const inv1 = await informeInventario(getTenantPrisma(OB1), OB1, AHORA)
  check('el inventario de la sucursal 1 vale menos que el del negocio', inv1.datos.totales.valor < inv.datos.totales.valor && inv1.datos.almacenes.length === 1)

  console.log('\nG) Después de DEVOLVER una venta con comprobante real (F6.1): las identidades se mantienen')
  const antesDev = await sumas()
  const dev = await anularOdevolverVenta(db, O1, anularOdevolverVentaSchema.parse({ saleId: ids[2]!, kind: 'DEVOLUCION', reason: 'Devolución de la caja de pintura', idempotencyKey: randomUUID() }))
  await prisma.taxDocument.update({ where: { id: dev.creditNote!.id }, data: { issuedAt: new Date('2026-11-02T15:00:00Z') } })   // la nota nace «hoy», después del periodo que se concilia
  const realG = await sumas()
  const [gp, gv, gm] = [await informeVentasPorPeriodo(db, OALL, PV, AHORA), await informeVentasPorVendedor(db, OALL, PV, AHORA), await informeVentasPorMedio(db, OALL, PV, AHORA)]
  check('>>> la venta devuelta SALE de las ventas: una menos y exactamente su importe menos, en las tres vistas y en la base', realG.n === antesDev.n - 1 && antesDev.total - realG.total === 79992 && cent(gp.datos.totales.total) === realG.total && cent(gv.datos.totales.total) === realG.total && cent(gm.datos.totalVentas) === realG.total && gp.datos.totales.ventas === realG.n)
  const mgG = await informeMargen(db, OALL, PC, AHORA)
  check('>>> la rentabilidad sigue = suma exacta de los subtotales, sin la venta devuelta', cent(mgG.datos.totales.ventaSinIgv) === realG.subtotal)
  const ccG = (await informeConciliacion(db, OALL, PR, AHORA)).informe
  const regG = (await informeRegistroVentas(db, OALL, PR, AHORA)).datos
  const ncs = await prisma.taxDocument.findMany({ where: { tenantId: t.id, documentType: 'NOTA_CREDITO', status: { in: ['ACEPTADO', 'OBSERVADO'] }, issuedAt: { gte: DESDE, lt: HASTA } } })
  const sumaNc = ncs.reduce((a, x) => a + cent(num(x.total)), 0)
  const devueltasConDoc = await prisma.taxDocument.findMany({ where: { tenantId: t.id, isTrial: false, documentType: { in: ['BOLETA', 'FACTURA'] }, status: { in: ['ACEPTADO', 'OBSERVADO'] }, issuedAt: { gte: DESDE, lt: HASTA }, sale: { status: { in: ['ANULADA', 'DEVUELTA'] } } } })
  const sumaDev = devueltasConDoc.reduce((a, x) => a + cent(num(x.total)), 0)
  check('>>> el puente sigue PARTIENDO del total de ventas y cuadrando (diferencia 0), con una venta completada menos', cent(ccG.puente.ventasCompletadas.total) === cent(gp.datos.totales.total) && ccG.puente.ventasCompletadas.documentos === realG.n && ccG.puente.diferencia === 0 && ccG.puente.devueltas.documentos === 1 && ccG.cuadreVentas.diferencia === 0)
  check('>>> llega al registro con UNA línea más que explicar: registro = válidos del puente + comprobantes de ventas devueltas − notas de crédito VÁLIDAS (la nota de la devolución se emite HOY, fuera del periodo: restará en el registro de su propio periodo, y mientras SUNAT no la acepte va al control)', cent(regG.totales.total) === cent(ccG.puente.clasificacion.valido.total) + sumaDev - sumaNc && ncs.length === 1 && devueltasConDoc.length === 1 && (await prisma.taxDocument.count({ where: { tenantId: t.id, documentType: 'NOTA_CREDITO', status: 'PENDIENTE' } })) === 1, `${regG.totales.total}`)
  check('>>> y la conciliación lo EXPLICA sin alarmar: la devuelta con su nota no es un comprobante vivo ni una diferencia de fechas', !ccG.hallazgos.some((h) => h.codigo === 'COMPROBANTE_VIVO_EN_VENTA_CERRADA' && h.items.some((i) => i.detalle.includes(dev.saleNumber))) && ccG.hallazgos.some((h) => h.codigo === 'COMPROBANTES_DE_VENTAS_DEVUELTAS') && !ccG.hallazgos.some((h) => h.codigo === 'DIFERENCIA_DE_FECHAS'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
