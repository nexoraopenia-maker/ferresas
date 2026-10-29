import './guard'
import { correr } from './teardown'
import { abrirTurno, asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { closeCashSession, currentCashSession, openCashSession, totalesDelTurno } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { registrarAbono } from '../src/features/credito/credito-service'
import { registrarAbonoSchema } from '../src/features/credito/schemas'
import { auditarCoherenciaCredito } from '../src/features/credito/auditoria'
import { crearPresentacion } from '../src/features/inventory/presentaciones-service'
import { anularOdevolverVenta } from '../src/features/devoluciones/service'
import { anularOdevolverVentaSchema, devolverProductosSchema } from '../src/features/devoluciones/schemas'
import { devolverProductosVenta, diagnosticarDevolucionParcial } from '../src/features/devoluciones/parcial-service'
import { emitirNotaCreditoTotal, prepararNotaCreditoParcial } from '../src/features/invoicing/service'
import { cargarComprobanteFiscal } from '../src/features/invoicing/envio'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.2a · Devolución parcial por líneas, contra la base. Lo que más importa: TODO o NADA, el tope por línea, que devolver en N partes cuadre al
 * céntimo con la venta, el reparto entre deuda y dinero, la merma por daño, la nota de crédito parcial con sus líneas y que solo `ventas.anular` pueda.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const err = (p: Promise<unknown>) => p.then(() => null).catch((e) => e as { code?: string; message: string })
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-dp-${tag}-${randomUUID().slice(0, 6)}`, name: `Parcial ${tag}`, taxId: ruc(), planId: plan.id, realBillingEnabledAt: new Date('2026-01-01T00:00:00Z') } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_dp' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const todas = [b1.branch.id, b2.branch.id]
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ADMIN', 'CONTADOR', 'CAJERO', 'VENDEDOR', 'ALMACENERO'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    for (const b of todas) await asignarSucursal(t.id, x.id, b)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: todas, permisosExtra: [] }
  }
  const solo = await prisma.user.create({ data: { tenantId: t.id, email: `solo-${randomUUID()}@x.com`, name: 'Solo B2', role: 'ADMIN' } })
  await asignarSucursal(t.id, solo.id, b2.branch.id)
  u.SOLO_B2 = { tenantId: t.id, userId: solo.id, role: 'ADMIN', access: 'FULL', branchId: b2.branch.id, branchIds: [b2.branch.id], permisosExtra: [] }
  const prod = (sku: string, o: Record<string, unknown> = {}) => prisma.product.create({ data: { tenantId: t.id, sku, name: `Prod ${sku}`, unitType: 'UNIDAD', salePrice: 100, costPrice: 60, ...o } })
  const P1 = await prod('P1'), P2 = await prod('P2', { name: 'Servicio de corte', trackStock: false, costPrice: 0 }), P3 = await prod('P3', { salePrice: 33.33, costPrice: 17.77 })
  for (const p of [P1, P3]) for (const w of [b1.warehouse, b2.warehouse]) await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: w.id, quantity: 100 } })
  const cliente = await prisma.customer.create({ data: { tenantId: t.id, name: 'Constructora SAC', docType: 'RUC', docNumber: ruc(), creditLimit: 5000 } })
  const db = (c: TenantContext) => getTenantPrisma(c)
  const O = u.OWNER!
  const vender = (items: unknown[], payments: unknown[], over: Record<string, unknown> = {}) =>
    registerSale(db(O), O, registerSaleSchema.parse({ warehouseId: b1.warehouse.id, items, payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID(), ...over }) as never)
  const abrir = (monto: number) => openCashSession(db(O), O, openCashSchema.parse({ openingAmount: monto }))
  const L = (productId: string, quantity: number, extra: Record<string, unknown> = {}) => ({ productId, quantity, discount: 0, ...extra })
  const stock = async (productId: string) => num((await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId, warehouseId: b1.warehouse.id } })).quantity)
  let corr = 0
  const doc = async (saleId: string, o: { tipo?: 'BOLETA' | 'FACTURA'; estado?: string; trial?: boolean; externalId?: string | null } = {}) => {
    const s = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } })
    const tipo = o.tipo ?? 'BOLETA', serie = o.trial ? (tipo === 'FACTURA' ? 'PF001' : 'PB001') : tipo === 'FACTURA' ? 'F001' : 'B001', c = ++corr
    return prisma.taxDocument.create({ data: {
      tenantId: t.id, saleId, documentType: tipo, series: serie, correlativo: c, fullNumber: `${serie}-${String(c).padStart(8, '0')}`, status: (o.estado ?? 'ACEPTADO') as never, isTrial: o.trial ?? false,
      subtotal: s.subtotal, taxTotal: s.taxTotal, discountTotal: s.discountTotal, total: s.total, issuedAt: new Date(),
      receiverDocType: tipo === 'FACTURA' ? 'RUC' : 'SIN_DOCUMENTO', receiverDocNumber: tipo === 'FACTURA' ? ruc() : null, receiverName: 'Cliente',
      externalId: o.trial ? null : o.externalId === undefined ? `ext-${randomUUID().slice(0, 8)}` : o.externalId,
    } })
  }
  const item = async (saleId: string, productId?: string) => prisma.saleItem.findFirstOrThrow({ where: { saleId, ...(productId ? { productId } : {}) }, orderBy: { id: 'asc' } })
  const devolver = async (saleId: string, lines: { saleItemId: string; quantity: number; destination?: 'STOCK' | 'MERMA' }[], over: Record<string, unknown> = {}, ctx: TenantContext = O) =>
    devolverProductosVenta(db(ctx), ctx, devolverProductosSchema.parse({ saleId, reason: 'El cliente devolvió parte de la mercadería', lines, idempotencyKey: randomUUID(), ...over }))
  const foto = async (saleId: string) => ({
    ventas: await prisma.sale.count({ where: { tenantId: t.id } }), devoluciones: await prisma.saleReturn.count({ where: { tenantId: t.id } }), items: await prisma.saleReturnItem.count({ where: { tenantId: t.id } }),
    reembolsos: await prisma.saleReturnRefund.count({ where: { tenantId: t.id } }), movs: await prisma.stockMovement.count({ where: { tenantId: t.id } }), stock1: await stock(P1.id), stock3: await stock(P3.id),
    notas: await prisma.taxDocument.count({ where: { tenantId: t.id, documentType: 'NOTA_CREDITO' } }), notaItems: await prisma.taxDocumentItem.count({ where: { tenantId: t.id } }), mermas: await prisma.merma.count({ where: { tenantId: t.id } }),
    cuentas: (await prisma.receivable.findMany({ where: { tenantId: t.id }, orderBy: { id: 'asc' } })).map((r) => `${r.status}:${r.amount}:${r.paidAmount}`).join(), deuda: num((await prisma.customer.findUniqueOrThrow({ where: { id: cliente.id } })).creditBalance),
    estado: (await prisma.sale.findUniqueOrThrow({ where: { id: saleId } })).status, devuelto: (await prisma.saleItem.findMany({ where: { saleId }, orderBy: { id: 'asc' } })).map((i) => `${i.returnedQuantity}/${i.returnedAmount}`).join(),
    contador: (await prisma.documentCounter.findMany({ where: { tenantId: t.id, scope: 'RETURN' } })).map((c) => c.next).join(), refundsCash: (await prisma.cashSession.findMany({ where: { tenantId: t.id } })).map((s) => num(s.refundsCashTotal)).join(),
  })
  return { t, b1, b2, u, O, db, P1, P2, P3, cliente, vender, abrir, L, stock, doc, item, devolver, foto }
}

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 400) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  console.log('\nA) Contado: devolver en partes hasta completar la venta')
  const A = await negocio('contado')
  const turno = await A.abrir(100)
  const s1 = await A.vender([A.L(A.P1.id, 3)], [{ method: 'EFECTIVO', amount: 300 }])
  const i1 = await A.item(s1.saleId)
  check('(preparación) 3 unidades vendidas (stock 97) y el cajón espera 400', (await A.stock(A.P1.id)) === 97 && (await currentCashSession(A.db(A.O), A.O))!.expectedAmount === 400)
  const r1 = await A.devolver(s1.saleId, [{ saleItemId: i1.id, quantity: 1 }])
  check('>>> 1ª parcial: la venta SIGUE COMPLETADA; número D001-…; no completa; total 100.00; reembolso CAJA de 100.00', r1.status === 'COMPLETADA' && !r1.completaVenta && r1.number === 'D001-00000001' && r1.total === 100 && r1.refunds.length === 1 && r1.refunds[0]!.mode === 'CAJA' && r1.refunds[0]!.amount === 100 && r1.creditNote === null && !r1.replayed)
  const l1 = await prisma.saleItem.findUniqueOrThrow({ where: { id: i1.id } })
  check('>>> el tope de la línea queda en 1 de 3 unidades y 100.00 de 300.00', num(l1.returnedQuantity) === 1 && num(l1.returnedAmount) === 100)
  check('>>> STOCK: vuelve 1 unidad (98), con movimiento DEVOLUCION_CLIENTE enlazado a la devolución, sin costo pendiente y con el costo de venta como traza', await (async () => { const m = await prisma.stockMovement.findFirstOrThrow({ where: { tenantId: A.t.id, type: 'DEVOLUCION_CLIENTE' } }); return (await A.stock(A.P1.id)) === 98 && num(m.quantity) === 1 && m.referenceId === r1.returnId && m.costPending === false && num(m.unitCost) === 60 })())
  check('>>> el costo promedio del producto NO cambia', num((await prisma.product.findUniqueOrThrow({ where: { id: A.P1.id } })).costPrice) === 60)
  check('>>> CAJA: el efectivo esperado baja 100 (300), el turno cuenta 100 de devoluciones del cajón y el cobro sigue contando', await (async () => { const x = await totalesDelTurno(A.db(A.O), turno.id); return x.cashTotal === 300 && x.refundsCashTotal === 100 && (await currentCashSession(A.db(A.O), A.O))!.expectedAmount === 300 })())
  check('la auditoría deja `venta.devuelta_parcial` con el motivo, el número y la línea', await (async () => { const a = await prisma.auditLog.findFirst({ where: { tenantId: A.t.id, action: 'venta.devuelta_parcial', entityId: s1.saleId } }); return !!a && a.reason === 'El cliente devolvió parte de la mercadería' && JSON.stringify(a.after).includes('D001-00000001') && JSON.stringify(a.after).includes('"destino":"STOCK"') })())
  const r2 = await A.devolver(s1.saleId, [{ saleItemId: i1.id, quantity: 1 }])
  check('2ª parcial (otra unidad): número correlativo D001-00000002 y la venta sigue COMPLETADA', r2.number === 'D001-00000002' && r2.status === 'COMPLETADA' && !r2.completaVenta)
  const dgMid = await diagnosticarDevolucionParcial(A.db(A.O), A.O, s1.saleId)
  check('>>> el diagnóstico: queda 1 por devolver (100.00), tieneDevoluciones, tope devolvible 100.00 y turno abierto', dgMid.puede && dgMid.lineas[0]!.pendiente === 1 && dgMid.lineas[0]!.devuelta === 2 && dgMid.lineas[0]!.importePendiente === 100 && dgMid.tieneDevoluciones && dgMid.topeDevolvible === 100 && dgMid.hayTurnoAbierto)
  const eAnula = await err(anularOdevolverVenta(A.db(A.O), A.O, anularOdevolverVentaSchema.parse({ saleId: s1.saleId, kind: 'ANULACION', reason: 'Quiero anular', idempotencyKey: randomUUID() })))
  check('>>> con devoluciones parciales, «Anular» y «Devolver todo» (F6.1) se rechazan, mandando a «Devolver productos»', eAnula?.code === 'INVALID_DOCUMENT' && eAnula.message.includes('Devolver productos'))
  const r3 = await A.devolver(s1.saleId, [{ saleItemId: i1.id, quantity: 1 }])
  const v1 = await prisma.sale.findUniqueOrThrow({ where: { id: s1.saleId } })
  check('>>> la 3ª devuelve lo último: la venta pasa a DEVUELTA con fecha y motivo (el CHECK), la devolución es la que completa (isFull) y la auditoría es `venta.devuelta`', r3.status === 'DEVUELTA' && r3.completaVenta && v1.status === 'DEVUELTA' && v1.voidedAt !== null && v1.voidReason === 'El cliente devolvió parte de la mercadería' && (await prisma.saleReturn.findUniqueOrThrow({ where: { id: r3.returnId } })).isFull && (await prisma.auditLog.count({ where: { tenantId: A.t.id, action: 'venta.devuelta', entityId: s1.saleId } })) === 1)
  const lf = await prisma.saleItem.findUniqueOrThrow({ where: { id: i1.id } })
  check('>>> la línea queda devuelta por completo: 3 de 3 y 300.00 de 300.00; el stock vuelve a 100; Σ devoluciones = 300.00', num(lf.returnedQuantity) === 3 && num(lf.returnedAmount) === 300 && (await A.stock(A.P1.id)) === 100 && r1.total + r2.total + r3.total === 300)
  check('>>> y el cajón queda como al principio (400 − 300 = 100): el fondo', (await totalesDelTurno(A.db(A.O), turno.id)).refundsCashTotal === 300)
  check('una venta ya devuelta no admite más', (await err(A.devolver(s1.saleId, [{ saleItemId: i1.id, quantity: 1 }])))?.message.includes('ya está devuelta') === true)
  const cierre = await closeCashSession(A.db(A.O), A.O, closeCashSchema.parse({ sessionId: turno.id, countedAmount: 100 }))
  check('>>> el cierre cuadra (esperado 100 = contado 100) y congela las devoluciones del cajón (300)', cierre.expectedAmount === 100 && cierre.difference === 0 && cierre.refundsCashTotal === 300)

  console.log('\nB) El tope por línea y la validación')
  const B = await negocio('tope')
  await B.abrir(0)
  const sB = await B.vender([B.L(B.P1.id, 2), B.L(B.P3.id, 3)], [{ method: 'EFECTIVO', amount: 299.99 }])
  const iB1 = await B.item(sB.saleId, B.P1.id), iB3 = await B.item(sB.saleId, B.P3.id)
  const fB = await B.foto(sB.saleId)
  const casos: [string, Promise<{ code?: string; message: string } | null>, RegExp][] = [
    ['más de lo vendido', err(B.devolver(sB.saleId, [{ saleItemId: iB1.id, quantity: 3 }])), /solo quedan 2 por devolver/],
    ['cantidad cero', err(B.devolver(sB.saleId, [{ saleItemId: iB1.id, quantity: 0 }])), /mayor que cero/],
    ['5 decimales', err(B.devolver(sB.saleId, [{ saleItemId: iB1.id, quantity: 0.00001 }])), /mayor que cero|4 decimales/],
    ['línea de otra venta', err(B.devolver(sB.saleId, [{ saleItemId: 'otra-linea-123', quantity: 1 }])), /no pertenece/],
    ['la misma línea dos veces', err(B.devolver(sB.saleId, [{ saleItemId: iB1.id, quantity: 1 }, { saleItemId: iB1.id, quantity: 1 }])), /dos veces/],
  ]
  for (const [n, p, re] of casos) { const e = await p; check(`>>> ${n}: rechazada con mensaje claro y SIN tocar nada`, !!e && re.test(e.message) && JSON.stringify(await B.foto(sB.saleId)) === JSON.stringify(fB), e?.message ?? 'no falló') }
  check('el esquema rechaza sin líneas, sin motivo y sin clave de idempotencia', !devolverProductosSchema.safeParse({ saleId: 'x', reason: 'abc', lines: [], idempotencyKey: randomUUID() }).success && !devolverProductosSchema.safeParse({ saleId: 'x', reason: '', lines: [{ saleItemId: 'a', quantity: 1 }], idempotencyKey: randomUUID() }).success && !devolverProductosSchema.safeParse({ saleId: 'x', reason: 'abc', lines: [{ saleItemId: 'a', quantity: 1 }] }).success)
  const ok2 = await B.devolver(sB.saleId, [{ saleItemId: iB1.id, quantity: 1 }, { saleItemId: iB3.id, quantity: 1 }])
  check('dos líneas a la vez: el total es la suma de sus importes (100.00 + 33.33)', ok2.total === 133.33 && ok2.lines.length === 2)
  const eDup = await err(B.devolver(sB.saleId, [{ saleItemId: iB3.id, quantity: 3 }]))
  check('>>> después de devolver 1 de 3, pedir 3 se rechaza: solo quedan 2', !!eDup && /solo quedan 2 por devolver/.test(eDup.message))
  const idem = randomUUID()
  const f0 = await B.foto(sB.saleId)
  const ra = await B.devolver(sB.saleId, [{ saleItemId: iB3.id, quantity: 1 }], { idempotencyKey: idem })
  const rb = await B.devolver(sB.saleId, [{ saleItemId: iB3.id, quantity: 1 }], { idempotencyKey: idem })
  const f1 = await B.foto(sB.saleId)
  check('>>> idempotencia: la misma clave dos veces devuelve el MISMO resultado (replayed), sin repetir stock ni reembolso', ra.returnId === rb.returnId && rb.replayed && !ra.replayed && f1.devoluciones === f0.devoluciones + 1 && f1.stock3 === f0.stock3 + 1)
  const sFin = await B.vender([B.L(B.P3.id, 1)], [{ method: 'EFECTIVO', amount: 33.33 }])
  const iFin = await B.item(sFin.saleId)
  const claveFin = randomUUID()
  const fin1 = await B.devolver(sFin.saleId, [{ saleItemId: iFin.id, quantity: 1 }], { idempotencyKey: claveFin })
  const fin2 = await B.devolver(sFin.saleId, [{ saleItemId: iFin.id, quantity: 1 }], { idempotencyKey: claveFin })
  check('>>> reintentar con la misma clave la devolución que COMPLETÓ la venta devuelve el mismo resultado (no «ya está devuelta»)', fin2.replayed && fin2.returnId === fin1.returnId && fin2.status === 'DEVUELTA')
  check('…y la misma clave con OTRA venta se rechaza', (await err(B.devolver((await B.vender([B.L(B.P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }])).saleId, [{ saleItemId: iB1.id, quantity: 1 }], { idempotencyKey: idem }))) !== null)

  console.log('\nC) Cuadre al céntimo: descuento, 3 partes y presentación')
  const C = await negocio('centimos')
  await C.abrir(0)
  const sC = await C.vender([C.L(C.P3.id, 3, { discount: 7.77 })], [{ method: 'EFECTIVO', amount: 92.22 }])   // 3 × 33.33 − 7.77 = 92.22
  const iC = await C.item(sC.saleId)
  check('(preparación) la línea vale 92.22 con su descuento', num(iC.lineTotal) === 92.22)
  const partes: number[] = []
  for (let k = 0; k < 3; k++) partes.push((await C.devolver(sC.saleId, [{ saleItemId: iC.id, quantity: 1 }])).total)
  check(`>>> 3 devoluciones de 1 unidad de una línea con descuento: ${partes.join(' + ')} = 92.22 EXACTO (sin céntimo huérfano)`, Math.round(partes.reduce((a, b) => a + b, 0) * 100) === 9222 && (await C.foto(sC.saleId)).estado === 'DEVUELTA')
  const ritems = await prisma.saleReturnItem.findMany({ where: { tenantId: C.t.id }, orderBy: { id: 'asc' } })
  check('>>> la BASE y el IGV son los de la línea (92.22 al 18 %: base 78.15 e IGV 14.07), no intercambiados', Math.round(ritems.reduce((a, x) => a + num(x.subtotal), 0) * 100) === 7815 && Math.round(ritems.reduce((a, x) => a + num(x.taxAmount), 0) * 100) === 1407)
  check('>>> cada línea devuelta cumple importe = base + IGV, y Σ base + Σ IGV = la línea', ritems.length === 3 && ritems.every((x) => Math.round(num(x.amount) * 100) === Math.round(num(x.subtotal) * 100) + Math.round(num(x.taxAmount) * 100)) && Math.round(ritems.reduce((a, x) => a + num(x.amount), 0) * 100) === 9222)
  const D = await negocio('presentacion')
  await D.abrir(0)
  const caja = await crearPresentacion(D.db(D.O), D.O, { productId: D.P3.id, name: 'Caja x 12', unitType: 'CAJA', factor: '12' })
  const sD = await D.vender([D.L(D.P3.id, 24, { presentationId: caja.id, enteredQuantity: 2 })], [{ method: 'EFECTIVO', amount: 799.92 }])
  const iD = await D.item(sD.saleId)
  const antes = await D.stock(D.P3.id)
  const d3 = await D.devolver(sD.saleId, [{ saleItemId: iD.id, quantity: 3 }])
  const d21 = await D.devolver(sD.saleId, [{ saleItemId: iD.id, quantity: 21 }])
  check('>>> presentación: 3 sueltas de una caja ×12 y luego las 21 restantes suman EXACTAMENTE el importe vendido (799.92) y la venta queda DEVUELTA', Math.round((d3.total + d21.total) * 100) === 79_992 && d21.status === 'DEVUELTA')
  check('el stock repone 24 unidades base en total', (await D.stock(D.P3.id)) === antes + 24)
  const mD = await prisma.stockMovement.findMany({ where: { tenantId: D.t.id, type: 'DEVOLUCION_CLIENTE' }, orderBy: { createdAt: 'asc' } })
  check('>>> el movimiento de las 3 sueltas guarda su traza (0.25 de caja × 12) y el de 21 también (1.75 × 12)', mD.length === 2 && num(mD[0]!.enteredQuantity) === 0.25 && num(mD[0]!.presentationFactor) === 12 && num(mD[1]!.enteredQuantity) === 1.75)
  const rid = await prisma.saleReturnItem.findMany({ where: { tenantId: D.t.id }, orderBy: { id: 'asc' } })
  check('las líneas devueltas conservan el nombre de la presentación y la cantidad ingresada', rid.every((x) => x.presentationName === 'Caja x 12') && rid.map((x) => num(x.enteredQuantity)).sort().join() === '0.25,1.75')

  const sBaja = await B.vender([B.L(B.P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }])
  const iBaja = await B.item(sBaja.saleId)
  await prisma.product.update({ where: { id: B.P1.id }, data: { deletedAt: new Date() } })
  const fBaja = await B.foto(sBaja.saleId)
  const eBaja = await err(B.devolver(sBaja.saleId, [{ saleItemId: iBaja.id, quantity: 1 }]))
  check('>>> producto dado de baja → BLOQUEADO con su NOMBRE y cómo seguir; nada cambia', eBaja?.code === 'INVALID_DOCUMENT' && eBaja.message.includes('«Prod P1»') && eBaja.message.includes('Reactívalo') && JSON.stringify(await B.foto(sBaja.saleId)) === JSON.stringify(fBaja))

  console.log('\nD) Mercadería dañada: entrada + salida por merma en la misma transacción')
  const E = await negocio('merma')
  await E.abrir(0)
  const sE = await E.vender([E.L(E.P1.id, 3), E.L(E.P2.id, 1)], [{ method: 'EFECTIVO', amount: 400 }])
  const iE1 = await E.item(sE.saleId, E.P1.id), iE2 = await E.item(sE.saleId, E.P2.id)
  const st0 = await E.stock(E.P1.id)
  const rE = await E.devolver(sE.saleId, [{ saleItemId: iE1.id, quantity: 2, destination: 'MERMA' }])
  check('>>> dañado: el stock vendible NO sube (entrada y salida netas = 0)', (await E.stock(E.P1.id)) === st0)
  const movE = await prisma.stockMovement.findMany({ where: { tenantId: E.t.id, referenceId: rE.returnId }, orderBy: { createdAt: 'asc' } })
  check('>>> hay DOS movimientos de la misma cantidad: DEVOLUCION_CLIENTE (entrada) y MERMA (salida), ambos enlazados a la devolución y con el costo de venta (60)', movE.length === 2 && movE[0]!.type === 'DEVOLUCION_CLIENTE' && movE[1]!.type === 'MERMA' && num(movE[0]!.quantity) === 2 && num(movE[1]!.quantity) === -2 && movE.every((m) => num(m.unitCost) === 60))
  const merma = await prisma.merma.findFirstOrThrow({ where: { tenantId: E.t.id } })
  check('>>> la merma nace APROBADA, de la cantidad, con quien autorizó, el motivo de la devolución y el movimiento de salida', merma.status === 'APROBADA' && num(merma.quantity) === 2 && merma.requestedById === E.O.userId && merma.resolvedById === E.O.userId && merma.resolvedAt !== null && merma.movementId === movE[1]!.id && merma.reason.includes(rE.number) && merma.productId === E.P1.id)
  const ri = await prisma.saleReturnItem.findFirstOrThrow({ where: { returnId: rE.returnId } })
  check('>>> la línea devuelta queda como destino MERMA enlazada a su merma; el importe devuelto al cliente es el mismo (200.00)', ri.destination === 'MERMA' && ri.mermaId === merma.id && num(ri.amount) === 200 && rE.mermas === 1)
  const rE2 = await E.devolver(sE.saleId, [{ saleItemId: iE1.id, quantity: 1 }, { saleItemId: iE2.id, quantity: 1 }])
  check('>>> el servicio (sin control de stock) va a SIN_STOCK sin movimiento; la unidad sana de P1 vuelve al stock (+1); la venta queda DEVUELTA', rE2.status === 'DEVUELTA' && (await E.stock(E.P1.id)) === st0 + 1 && (await prisma.stockMovement.count({ where: { tenantId: E.t.id, productId: E.P2.id } })) === 0 && (await prisma.saleReturnItem.findFirstOrThrow({ where: { returnId: rE2.returnId, saleItemId: iE2.id } })).destination === 'SIN_STOCK')
  const sE2 = await E.vender([E.L(E.P2.id, 1)], [{ method: 'EFECTIVO', amount: 100 }])
  const fE = await E.foto(sE2.saleId)
  const eM = await err(E.devolver(sE2.saleId, [{ saleItemId: (await E.item(sE2.saleId)).id, quantity: 1, destination: 'MERMA' }]))
  check('>>> un servicio no puede mandarse a merma: se rechaza sin tocar nada', !!eM && /no controla stock/.test(eM.message) && JSON.stringify(await E.foto(sE2.saleId)) === JSON.stringify(fE))

  console.log('\nF) Crédito: la deuda baja primero')
  const F = await negocio('fiado')
  await F.abrir(0)
  const sF = await F.vender([F.L(F.P1.id, 3)], [{ method: 'CREDITO', amount: 300 }], { customerId: F.cliente.id })
  const iF = await F.item(sF.saleId)
  const rF1 = await F.devolver(sF.saleId, [{ saleItemId: iF.id, quantity: 1 }])
  const cuentaF = await prisma.receivable.findFirstOrThrow({ where: { saleId: sF.saleId } })
  check('>>> fiado sin abonos: devolver 1 baja la cuenta a 200.00 (sigue abierta) y la deuda del cliente a 200.00; NO hay reembolso de dinero', rF1.receivableReducedAmount === 100 && rF1.refunds.length === 0 && num(cuentaF.amount) === 200 && cuentaF.status === 'ABIERTA' && num((await prisma.customer.findUniqueOrThrow({ where: { id: F.cliente.id } })).creditBalance) === 200)
  check('>>> la auditoría deja `credito.cuenta_reducida`', (await prisma.auditLog.count({ where: { tenantId: F.t.id, action: 'credito.cuenta_reducida', entityId: cuentaF.id } })) === 1)
  const eRef = await err(F.devolver(sF.saleId, [{ saleItemId: iF.id, quantity: 1 }], { refunds: [{ mode: 'SIN_SALIDA', amount: 100, reference: 'Acuerdo en mostrador' }] }))
  check('>>> sin dinero que devolver, pedir un reembolso se rechaza (todo es deuda)', !!eRef && /descuenta de la deuda/.test(eRef.message))
  const rF2 = await F.devolver(sF.saleId, [{ saleItemId: iF.id, quantity: 2 }])
  const cuentaF2 = await prisma.receivable.findFirstOrThrow({ where: { saleId: sF.saleId } })
  check('>>> devolver el resto: la cuenta se da de baja (ANULADA), la deuda del cliente es 0 y la venta queda DEVUELTA', rF2.status === 'DEVUELTA' && cuentaF2.status === 'ANULADA' && cuentaF2.voidedAt !== null && num((await prisma.customer.findUniqueOrThrow({ where: { id: F.cliente.id } })).creditBalance) === 0)
  check('>>> `auditar-credito` queda LIMPIO tras las devoluciones', (await auditarCoherenciaCredito(F.db(F.O))).hallazgos.length === 0)

  const G = await negocio('fiado-abonos')
  await G.abrir(0)
  const sG = await G.vender([G.L(G.P1.id, 3)], [{ method: 'CREDITO', amount: 300 }], { customerId: G.cliente.id })
  const iG = await G.item(sG.saleId)
  await registrarAbono(G.db(G.O), G.O, registrarAbonoSchema.parse({ customerId: G.cliente.id, method: 'EFECTIVO', amount: 100, idempotencyKey: randomUUID() }))
  const fG = await G.foto(sG.saleId)
  const eG = await err(G.devolver(sG.saleId, [{ saleItemId: iG.id, quantity: 3 }]))
  check('>>> con un abono de 100 y saldo de 200: devolver las 3 (300) obligaría a reembolsar el abono → BLOQUEADO con el tope (200.00), sin tocar nada', eG?.code === 'CREDIT_HAS_PAYMENTS' && /200\.00/.test(eG.message) && JSON.stringify(await G.foto(sG.saleId)) === JSON.stringify(fG))
  const rG = await G.devolver(sG.saleId, [{ saleItemId: iG.id, quantity: 2 }])
  const cG = await prisma.receivable.findFirstOrThrow({ where: { saleId: sG.saleId } })
  check('>>> pero devolver 2 (200) cabe en el saldo: se permite, no se mueve dinero, y la cuenta queda PAGADA por lo abonado (100)', rG.receivableReducedAmount === 200 && rG.refunds.length === 0 && cG.status === 'PAGADA' && num(cG.amount) === 100 && num(cG.paidAmount) === 100 && cG.closedAt !== null && num((await prisma.customer.findUniqueOrThrow({ where: { id: G.cliente.id } })).creditBalance) === 0)
  const dgG = await diagnosticarDevolucionParcial(G.db(G.O), G.O, sG.saleId)
  check('>>> y el diagnóstico dice que lo que queda (1 unidad, 100.00) NO se puede devolver todavía (sin saldo ni contado): tope 0.00', dgG.topeDevolvible === 0 && dgG.lineas[0]!.importePendiente === 100)
  check('`auditar-credito` limpio también con abonos', (await auditarCoherenciaCredito(G.db(G.O))).hallazgos.length === 0)

  const H = await negocio('mixta')
  await H.abrir(0)
  const sH = await H.vender([H.L(H.P1.id, 3)], [{ method: 'EFECTIVO', amount: 100 }, { method: 'CREDITO', amount: 200 }], { customerId: H.cliente.id })
  const iH = await H.item(sH.saleId)
  await registrarAbono(H.db(H.O), H.O, registrarAbonoSchema.parse({ customerId: H.cliente.id, method: 'YAPE', amount: 50, idempotencyKey: randomUUID() }))
  const rH = await H.devolver(sH.saleId, [{ saleItemId: iH.id, quantity: 2 }])
  check('>>> mixta (100 efectivo + 200 fiado, abono de 50): devolver 200 = deuda 150 + efectivo 50 desde el cajón', rH.receivableReducedAmount === 150 && rH.refunds.length === 1 && rH.refunds[0]!.mode === 'CAJA' && rH.refunds[0]!.amount === 50)
  const tH = await totalesDelTurno(H.db(H.O), (await prisma.cashSession.findFirstOrThrow({ where: { tenantId: H.t.id } })).id)
  check('…y el turno cuenta solo esos 50 como devolución del cajón', tH.refundsCashTotal === 50)
  const eH = await err(H.devolver(sH.saleId, [{ saleItemId: iH.id, quantity: 1 }]))
  check('>>> lo que queda (100.00): la cuenta está PAGADA y el contado restante es 50, así que 100 excede → bloqueado con el tope exacto (50.00)', eH?.code === 'CREDIT_HAS_PAYMENTS' && /50\.00/.test(eH.message), eH?.message)

  console.log('\nG) Caja')
  const K = await negocio('caja')
  const tK0 = await K.abrir(0)
  const sK = await K.vender([K.L(K.P1.id, 2)], [{ method: 'EFECTIVO', amount: 200 }])
  await closeCashSession(K.db(K.O), K.O, closeCashSchema.parse({ sessionId: tK0.id, countedAmount: 200 }))   // F6.8b: quien devuelve necesita SU turno abierto
  const iK = await K.item(sK.saleId)
  const fK = await K.foto(sK.saleId)
  const eK = await err(K.devolver(sK.saleId, [{ saleItemId: iK.id, quantity: 1 }]))
  check('>>> efectivo desde el cajón SIN turno propio abierto → CASH_REQUIRED y no cambia NADA (ni stock, ni contador)', eK?.code === 'CASH_REQUIRED' && JSON.stringify(await K.foto(sK.saleId)) === JSON.stringify(fK))
  const eExt0 = await err(K.devolver(sK.saleId, [{ saleItemId: iK.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100, reference: 'OP-123' }] }))
  check('>>> F6.8b: devolverlo por Yape (EXTERNO) también mueve dinero: sin turno propio, CASH_REQUIRED y no cambia nada', eExt0?.code === 'CASH_REQUIRED' && JSON.stringify(await K.foto(sK.saleId)) === JSON.stringify(fK))
  await K.abrir(0)
  const eExt = await K.devolver(sK.saleId, [{ saleItemId: iK.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100, reference: 'OP-123' }] })
  check('>>> con su turno abierto, el mismo efectivo devuelto por Yape (EXTERNO) sí se permite', eExt.refunds[0]!.mode === 'EXTERNO' && eExt.refunds[0]!.method === 'YAPE')
  const eSin = await err(K.devolver(sK.saleId, [{ saleItemId: iK.id, quantity: 1 }], { refunds: [{ mode: 'SIN_SALIDA', amount: 100 }] }))
  check('SIN_SALIDA exige un motivo', !!eSin && /motivo/i.test(eSin.message))
  const eSuma = await err(K.devolver(sK.saleId, [{ saleItemId: iK.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 60 }] }))
  check('>>> los reembolsos deben sumar exactamente lo que se devuelve en dinero (100.00)', !!eSuma && /deben coincidir/.test(eSuma.message))
  const turnoK = { id: (await prisma.cashSession.findFirstOrThrow({ where: { tenantId: K.t.id, status: 'ABIERTA' }, select: { id: true } })).id }
  const sK2 = await K.vender([K.L(K.P1.id, 1)], [{ method: 'YAPE', amount: 100 }])
  const rK2 = await K.devolver(sK2.saleId, [{ saleItemId: (await K.item(sK2.saleId)).id, quantity: 1 }])
  check('>>> una venta por Yape se devuelve por Yape (EXTERNO) y el turno lo anota como «otro medio», sin tocar el cajón', rK2.refunds[0]!.mode === 'EXTERNO' && rK2.refunds[0]!.method === 'YAPE' && await (async () => { const x = await totalesDelTurno(K.db(K.O), turnoK.id); return x.refundsCashTotal === 0 && x.refundsOtherTotal === 200 /* la anterior por Yape + esta */ })())

  console.log('\nH) Comprobante: nota de crédito parcial con sus líneas')
  const N = await negocio('notas')
  await N.abrir(0)
  const vNota = async (estado: string, o: { trial?: boolean; tipo?: 'BOLETA' | 'FACTURA'; externalId?: string | null; qty?: number } = {}) => {
    const v = await N.vender([N.L(N.P1.id, o.qty ?? 3), N.L(N.P3.id, 3)], [{ method: 'YAPE', amount: (o.qty ?? 3) * 100 + 99.99 }])
    const d = await N.doc(v.saleId, { estado, ...o })
    return { v, d, i1: await N.item(v.saleId, N.P1.id), i3: await N.item(v.saleId, N.P3.id) }
  }
  const n1 = await vNota('ACEPTADO')
  const rn1 = await N.devolver(n1.v.saleId, [{ saleItemId: n1.i1.id, quantity: 1 }, { saleItemId: n1.i3.id, quantity: 2 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 166.66 }] })
  const nc1 = await prisma.taxDocument.findFirstOrThrow({ where: { tenantId: N.t.id, relatedDocumentId: n1.d.id }, include: { items: { orderBy: { lineNo: 'asc' } } } })
  check('>>> boleta ACEPTADA + devolución parcial → nota de crédito 07, serie BC01, ligada a la devolución y al comprobante', nc1.documentType === 'NOTA_CREDITO' && nc1.reasonCode === '07' && nc1.series === 'BC01' && nc1.fullNumber === 'BC01-00000001' && rn1.creditNote?.fullNumber === nc1.fullNumber && nc1.relatedDocumentId === n1.d.id)
  check('>>> la nota lleva SUS líneas (2), cantidades 1 y 2, y cada una con total = base + IGV', nc1.items.length === 2 && nc1.items.map((x) => num(x.quantity)).join() === '1,2' && nc1.items.every((x) => Math.round(num(x.total) * 100) === Math.round(num(x.subtotal) * 100) + Math.round(num(x.taxAmount) * 100)))
  check('>>> Σ líneas = total de la nota = lo devuelto (166.66); subtotal + IGV = total; sin descuento aparte', Math.round(nc1.items.reduce((a, x) => a + num(x.total), 0) * 100) === 16_666 && num(nc1.total) === 166.66 && Math.round((num(nc1.subtotal) + num(nc1.taxTotal)) * 100) === 16_666 && num(nc1.discountTotal) === 0 && rn1.total === 166.66)
  check('>>> el subtotal y el IGV de la nota son la suma de los de sus líneas (no intercambiados)', Math.round(num(nc1.subtotal) * 100) === Math.round(nc1.items.reduce((a, x) => a + num(x.subtotal), 0) * 100) && Math.round(num(nc1.taxTotal) * 100) === Math.round(nc1.items.reduce((a, x) => a + num(x.taxAmount), 0) * 100) && num(nc1.subtotal) > num(nc1.taxTotal))
  check('>>> en un negocio REAL la nota se encola para enviarse', (await prisma.fiscalDispatch.count({ where: { tenantId: N.t.id, taxDocumentId: nc1.id } })) === 1 && nc1.status === 'PENDIENTE')
  const fiscal = await cargarComprobanteFiscal(N.db(N.O), nc1.id)
  check('>>> el envío arma la nota desde SUS líneas (no las de la venta): 2 líneas, mismo total, relación al original y motivo 07', fiscal.comprobante.lineas.length === 2 && fiscal.comprobante.total === 166.66 && fiscal.comprobante.documentoRelacionado?.motivo === '07' && fiscal.comprobante.tipoComprobante === '07' && Math.abs(fiscal.comprobante.lineas.reduce((a, l) => a + l.importeTotal, 0) - 166.66) < 1e-9)
  const rn2 = await N.devolver(n1.v.saleId, [{ saleItemId: n1.i1.id, quantity: 2 }, { saleItemId: n1.i3.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 233.33 }] })
  const notas = await prisma.taxDocument.findMany({ where: { tenantId: N.t.id, relatedDocumentId: n1.d.id }, orderBy: { correlativo: 'asc' } })
  check('>>> la 2ª devolución (la que completa) emite OTRA nota parcial 07; las dos suman EXACTAMENTE el comprobante original', notas.length === 2 && rn2.status === 'DEVUELTA' && Math.round(notas.reduce((a, x) => a + num(x.total), 0) * 100) === Math.round(num(n1.d.total) * 100) && notas.every((x) => x.reasonCode === '07'))
  const eTot = await err(emitirNotaCreditoTotal(N.db(N.O), N.O, { saleId: n1.v.saleId, reasonCode: '06', reasonDescription: 'Nota total manual' }))
  check('>>> una nota TOTAL manual sobre un comprobante con notas parciales se rechaza (contaría dos veces)', !!eTot && /parcial/.test(eTot.message))
  for (const st of ['PENDIENTE', 'ENVIADO'] as const) {
    const g = await vNota(st)
    const fx = await N.foto(g.v.saleId)
    const ex = await err(N.devolver(g.v.saleId, [{ saleItemId: g.i1.id, quantity: 1 }]))
    check(`>>> comprobante ${st} → BLOQUEADO («cola fiscal»), sin tocar nada`, ex?.code === 'INVALID_DOCUMENT' && ex.message.includes('cola fiscal') && JSON.stringify(await N.foto(g.v.saleId)) === JSON.stringify(fx))
  }
  const gObs = await vNota('OBSERVADO')
  const rObs = await N.devolver(gObs.v.saleId, [{ saleItemId: gObs.i1.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] })
  check('OBSERVADO (válido) también recibe su nota parcial ⚠️', rObs.creditNote !== null)
  for (const st of ['RECHAZADO', 'ANULADO'] as const) {
    const g = await vNota(st)
    const rx = await N.devolver(g.v.saleId, [{ saleItemId: g.i1.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] })
    check(`comprobante ${st} → se devuelve SIN nota (ya no está vivo)`, rx.creditNote === null && (await prisma.taxDocument.count({ where: { tenantId: N.t.id, relatedDocumentId: g.d.id } })) === 0)
  }
  const gT = await vNota('ACEPTADO', { trial: true })
  const rT1 = await N.devolver(gT.v.saleId, [{ saleItemId: gT.i1.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] })
  const dT1 = await prisma.taxDocument.findUniqueOrThrow({ where: { id: gT.d.id } })
  check('>>> comprobante de ENSAYO: sin nota y SIN marcar mientras queda algo por devolver', rT1.creditNote === null && dT1.voidedAt === null)
  await N.devolver(gT.v.saleId, [{ saleItemId: gT.i1.id, quantity: 2 }, { saleItemId: gT.i3.id, quantity: 3 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 299.99 }] })
  const dT2 = await prisma.taxDocument.findUniqueOrThrow({ where: { id: gT.d.id } })
  check('>>> al quedar la venta devuelta del todo, el comprobante de ensayo se marca anulado (marca de agua) con el motivo', dT2.voidedAt !== null && !!dT2.voidReason)
  const gS = await vNota('ACEPTADO', { externalId: null })
  const fs = await N.foto(gS.v.saleId)
  const es = await err(N.devolver(gS.v.saleId, [{ saleItemId: gS.i1.id, quantity: 1 }]))
  check('>>> real sin el identificador del proveedor → rechazado con el camino «Consultar»; NADA cambia', es?.message.includes('Consultar') === true && JSON.stringify(await N.foto(gS.v.saleId)) === JSON.stringify(fs))
  const gN = await N.vender([N.L(N.P1.id, 1)], [{ method: 'YAPE', amount: 100 }])
  const rN = await N.devolver(gN.saleId, [{ saleItemId: (await N.item(gN.saleId)).id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] })
  check('una nota de venta (sin comprobante) no emite nota', rN.creditNote === null)
  const gF = await vNota('ACEPTADO', { tipo: 'FACTURA' })
  const rF = await N.devolver(gF.v.saleId, [{ saleItemId: gF.i1.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] })
  check('una factura recibe su nota parcial con serie FC01', rF.creditNote?.fullNumber.startsWith('FC01-') === true)
  // F6.1 sobre una venta que ya tiene parciales y F6.1 que rellena el tope
  const sT = await N.vender([N.L(N.P1.id, 2)], [{ method: 'YAPE', amount: 200 }])
  await anularOdevolverVenta(N.db(N.O), N.O, anularOdevolverVentaSchema.parse({ saleId: sT.saleId, kind: 'DEVOLUCION', reason: 'Devolución completa', idempotencyKey: randomUUID(), refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 200 }] }))
  const lT = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sT.saleId } })
  check('>>> la devolución TOTAL de F6.1 también deja el tope de la línea completo (2 de 2 y 200.00) y las líneas con base e IGV', num(lT.returnedQuantity) === 2 && num(lT.returnedAmount) === 200 && await (async () => { const x = await prisma.saleReturnItem.findFirstOrThrow({ where: { saleItemId: lT.id } }); return num(x.subtotal) + num(x.taxAmount) === 200 && x.destination === 'STOCK' })())

  const sAn = await N.vender([N.L(N.P1.id, 1)], [{ method: 'YAPE', amount: 100 }])
  await anularOdevolverVenta(N.db(N.O), N.O, anularOdevolverVentaSchema.parse({ saleId: sAn.saleId, kind: 'ANULACION', reason: 'Error de digitación', idempotencyKey: randomUUID(), refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] }))
  check('>>> una venta ANULADA no admite devolver productos', /ya está anulada/.test((await err(N.devolver(sAn.saleId, [{ saleItemId: (await N.item(sAn.saleId)).id, quantity: 1 }])))?.message ?? ''))
  // Las notas de un comprobante nunca superan su importe: el tope lo da la suma de líneas, pero el emisor también lo vigila por su cuenta.
  const exceso = await err(prepararNotaCreditoParcial(N.db(N.O), N.O, { saleId: n1.v.saleId, reasonDescription: 'Intento de pasarse', lineas: [{ saleItemId: n1.i1.id, descripcion: 'x', sku: 'x', unitType: 'UNIDAD', cantidad: 1, tasa: 0.18, baseCent: 1, igvCent: 0 }] }))
  check('>>> el emisor rechaza una nota que, sumada a las anteriores, supere el comprobante (aunque sea por 1 céntimo)', !!exceso && /no pueden superar su importe/.test(exceso.message), exceso?.message)
  // Una nota TOTAL ya emitida (a mano) cierra el paso a las parciales.
  const gTot = await vNota('ACEPTADO')
  await emitirNotaCreditoTotal(N.db(N.O), N.O, { saleId: gTot.v.saleId, reasonCode: '06', reasonDescription: 'Nota total previa' })
  const eTotPrev = await err(N.devolver(gTot.v.saleId, [{ saleItemId: gTot.i1.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] }))
  check('>>> con una nota de crédito TOTAL ya emitida, una devolución parcial se rechaza (contaría dos veces) y nada cambia', !!eTotPrev && /nota de crédito total/.test(eTotPrev.message) && (await prisma.saleReturn.count({ where: { saleId: gTot.v.saleId } })) === 0)

  console.log('\nI) Permisos, solo lectura y sucursal')
  const P = await negocio('permisos')
  await P.abrir(0)
  await abrirTurno(P.t.id, P.u.ADMIN!.userId, P.b1.branch.id)   // F6.8b: quien devuelve saca de SU caja
  const sP = await P.vender([P.L(P.P1.id, 2)], [{ method: 'YAPE', amount: 200 }])
  const iP = await P.item(sP.saleId)
  const fP = await P.foto(sP.saleId)
  for (const rol of ['CAJERO', 'CONTADOR', 'VENDEDOR', 'ALMACENERO'] as const) {
    const e = await code(P.devolver(sP.saleId, [{ saleItemId: iP.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] }, P.u[rol]!))
    const d = await code(diagnosticarDevolucionParcial(P.db(P.u[rol]!), P.u[rol]!, sP.saleId))
    check(`>>> ${rol}: NO puede devolver productos ni diagnosticar (FORBIDDEN_ROLE) y no cambia nada`, e === 'FORBIDDEN_ROLE' && d === 'FORBIDDEN_ROLE' && JSON.stringify(await P.foto(sP.saleId)) === JSON.stringify(fP), `${e}/${d}`)
  }
  const ro = { ...P.O, access: 'READ_ONLY' } as TenantContext
  const eRo = await code(P.devolver(sP.saleId, [{ saleItemId: iP.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] }, ro))
  check('>>> cuenta en SOLO LECTURA: no escribe', eRo !== null && JSON.stringify(await P.foto(sP.saleId)) === JSON.stringify(fP), String(eRo))
  const eAjena = await code(P.devolver(sP.saleId, [{ saleItemId: iP.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] }, P.u.SOLO_B2!))
  check('>>> un administrador de OTRA sucursal no puede devolver una venta de la sucursal 1', eAjena !== null && JSON.stringify(await P.foto(sP.saleId)) === JSON.stringify(fP), String(eAjena))
  const okAdmin = await code(P.devolver(sP.saleId, [{ saleItemId: iP.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] }, P.u.ADMIN!))
  check('el administrador (ventas.anular) sí puede', okAdmin === null)
  const dg30 = await (async () => { await prisma.sale.update({ where: { id: sP.saleId }, data: { completedAt: new Date(Date.now() - 40 * 86_400_000) } }); return diagnosticarDevolucionParcial(P.db(P.O), P.O, sP.saleId) })()
  check('>>> una venta de hace 40 días AVISA (⚠️ umbral operativo de 30) pero NO bloquea', dg30.antiguedad.avisar && dg30.antiguedad.dias >= 40 && dg30.puede)
  const rAntigua = await P.devolver(sP.saleId, [{ saleItemId: iP.id, quantity: 1 }], { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] })
  check('…y se puede devolver igual; el resultado también trae el aviso', rAntigua.antiguedad.avisar && rAntigua.status === 'DEVUELTA')

  console.log('\nJ) Todo o nada: un fallo al final deshace TODO')
  const R = await negocio('rollback')
  await R.abrir(0)
  const vr = await R.vender([R.L(R.P1.id, 3)], [{ method: 'EFECTIVO', amount: 100 }, { method: 'CREDITO', amount: 200 }], { customerId: R.cliente.id, documentType: 'BOLETA' })
  await R.doc(vr.saleId)
  const iR = await R.item(vr.saleId)
  const otra = await R.vender([R.L(R.P1.id, 1)], [{ method: 'YAPE', amount: 100 }])
  // Un registro ajeno ya tiene el número que va a tomar esta devolución: la creación falla DESPUÉS de reducir la deuda y emitir la nota.
  await prisma.documentCounter.upsert({ where: { tenantId_scope_series: { tenantId: R.t.id, scope: 'RETURN', series: '001' } }, update: { next: 7 }, create: { tenantId: R.t.id, branchId: R.b1.branch.id, scope: 'RETURN', series: '001', prefix: 'D', next: 7 } })
  await prisma.saleReturn.create({ data: { tenantId: R.t.id, saleId: otra.saleId, kind: 'DEVOLUCION', number: 'D001-00000007', reason: 'Registro previo', isFull: false, userId: R.O.userId, saleTotal: 100, returnTotal: 100, paidNet: 100, idempotencyKey: randomUUID() } })
  const fr = await R.foto(vr.saleId)
  const er = await err(R.devolver(vr.saleId, [{ saleItemId: iR.id, quantity: 2 }]))
  const fr2 = await R.foto(vr.saleId)
  check('>>> el fallo llegó DESPUÉS de reducir la deuda y emitir la nota; deshace TODO: la venta COMPLETADA, el tope de la línea, el stock, la deuda, la cuenta, sin nota ni líneas de nota ni reembolso, sin gastar el correlativo', !!er && fr2.estado === 'COMPLETADA' && JSON.stringify({ ...fr2, devoluciones: 0 }) === JSON.stringify({ ...fr, devoluciones: 0 }), `${er?.message ?? 'no falló'}`)
  await prisma.saleReturn.deleteMany({ where: { number: 'D001-00000007', tenantId: R.t.id } })
  const rOk = await R.devolver(vr.saleId, [{ saleItemId: iR.id, quantity: 2 }])
  check('…y una vez libre el número, la misma devolución procede entera: toma el número que no se gastó, cancela la deuda (200, sin dinero que sacar), emite la nota con su línea y repone 2', rOk.number === 'D001-00000007' && rOk.receivableReducedAmount === 200 && rOk.refunds.length === 0 && rOk.creditNote !== null && (await R.stock(R.P1.id)) === 98 && (await prisma.taxDocumentItem.count({ where: { tenantId: R.t.id } })) === 1, JSON.stringify({ n: rOk.number, d: rOk.receivableReducedAmount, r: rOk.refunds }))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
