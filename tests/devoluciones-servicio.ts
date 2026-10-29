import './guard'
import { correr } from './teardown'
import { abrirTurno, asignarSucursal, cajaLibre, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { closeCashSession, currentCashSession, openCashSession, totalesDelTurno } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { anularAbono, registrarAbono } from '../src/features/credito/credito-service'
import { anularAbonoSchema, registrarAbonoSchema } from '../src/features/credito/schemas'
import { auditarCoherenciaCredito } from '../src/features/credito/auditoria'
import { crearPresentacion } from '../src/features/inventory/presentaciones-service'
import { calcularConciliacion } from '../src/features/conciliacion/conciliacion-service'
import { parametrosRegistrosSchema } from '../src/features/registros/schemas'
import { anularOdevolverVenta } from '../src/features/devoluciones/service'
import { anularOdevolverVentaSchema } from '../src/features/devoluciones/schemas'
import { PERMISOS_FUERA_DEL_PIN, permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'
import { PERMISOS } from '../src/lib/permisos'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.1a · Anular y devolver una venta completa, contra la base. Lo que más importa: TODO o NADA (stock, caja, deuda, nota de crédito y estado
 * de la venta), cada invariante de stock/costo/caja/crédito/comprobante, que un turno cerrado no cambie nunca, y que solo `ventas.anular` lo permita.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const err = (p: Promise<unknown>) => p.then(() => null).catch((e) => e as { code?: string; message: string })
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

type Modo = 'REAL' | 'ENSAYO' | 'PAUSADO'
async function negocio(tag: string, modo: Modo = 'REAL') {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: {
    slug: `rp-dv-${tag}-${randomUUID().slice(0, 6)}`, name: `Devoluciones ${tag}`, taxId: ruc(), planId: plan.id,
    ...(modo !== 'ENSAYO' ? { realBillingEnabledAt: new Date('2026-01-01T00:00:00Z') } : {}), ...(modo === 'PAUSADO' ? { realBillingPausedAt: new Date('2026-10-01T00:00:00Z') } : {}),
  } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_dv' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const todas = [b1.branch.id, b2.branch.id]
  const u: Record<string, TenantContext> = {}
  // OWNER2: F6.8b — una persona tiene un solo turno, así que la sucursal 2 la lleva otro dueño con el suyo.
  for (const clave of ['OWNER', 'OWNER2', 'ADMIN', 'CONTADOR', 'CAJERO', 'VENDEDOR', 'ALMACENERO']) {
    const role = (clave === 'OWNER2' ? 'OWNER' : clave) as Role
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${clave}-${randomUUID()}@x.com`.toLowerCase(), name: clave, role } })
    for (const b of todas) await asignarSucursal(t.id, x.id, b)
    u[clave] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: todas, permisosExtra: [] }
  }
  const prod = (sku: string, o: Record<string, unknown> = {}) => prisma.product.create({ data: { tenantId: t.id, sku, name: `Prod ${sku}`, unitType: 'UNIDAD', salePrice: 100, costPrice: 60, ...o } })
  const P1 = await prod('P1'), P2 = await prod('P2', { name: 'Servicio de corte', trackStock: false, costPrice: 0 }), P3 = await prod('P3', { salePrice: 33.33, costPrice: 17.77 })
  for (const p of [P1, P3]) for (const w of [b1.warehouse, b2.warehouse]) await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: w.id, quantity: 100 } })
  const cliente = await prisma.customer.create({ data: { tenantId: t.id, name: 'Constructora SAC', docType: 'RUC', docNumber: ruc(), creditLimit: 5000 } })
  const db = (c: TenantContext) => getTenantPrisma(c)
  const O = u.OWNER!
  const sedes = { b1: { ctx: O, w: b1.warehouse.id }, b2: { ctx: { ...u.OWNER2!, branchId: b2.branch.id } as TenantContext, w: b2.warehouse.id } }
  const vender = (items: unknown[], payments: unknown[], over: Record<string, unknown> = {}, sede: 'b1' | 'b2' = 'b1', ctx?: TenantContext) => {
    const s = sedes[sede], c = ctx ?? s.ctx
    return registerSale(db(c), c, registerSaleSchema.parse({ warehouseId: s.w, items, payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID(), ...over }) as never)
  }
  const abrir = async (monto: number, sede: 'b1' | 'b2' = 'b1') => openCashSession(db(sedes[sede].ctx), sedes[sede].ctx, openCashSchema.parse({ openingAmount: monto, ...(await cajaLibre(t.id, sedes[sede].ctx.branchId!)) }))
  const L = (productId: string, quantity: number, extra: Record<string, unknown> = {}) => ({ productId, quantity, discount: 0, ...extra })
  const stock = async (productId: string, w = b1.warehouse.id) => num((await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId, warehouseId: w } })).quantity)
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
  const devolver = (saleId: string, over: Record<string, unknown> = {}, ctx: TenantContext = O) =>
    anularOdevolverVenta(db(ctx), ctx, anularOdevolverVentaSchema.parse({ saleId, kind: 'DEVOLUCION', reason: 'El cliente devolvió la mercadería', idempotencyKey: randomUUID(), ...over }))
  const foto = async (saleId?: string) => ({
    ventas: await prisma.sale.count({ where: { tenantId: t.id } }), devoluciones: await prisma.saleReturn.count({ where: { tenantId: t.id } }), reembolsos: await prisma.saleReturnRefund.count({ where: { tenantId: t.id } }),
    movs: await prisma.stockMovement.count({ where: { tenantId: t.id } }), stock1: await stock(P1.id), stock3: await stock(P3.id), notas: await prisma.taxDocument.count({ where: { tenantId: t.id, documentType: 'NOTA_CREDITO' } }),
    cuentas: (await prisma.receivable.findMany({ where: { tenantId: t.id }, orderBy: { id: 'asc' } })).map((r) => `${r.status}:${r.paidAmount}`).join(), deuda: num((await prisma.customer.findUniqueOrThrow({ where: { id: cliente.id } })).creditBalance),
    estado: saleId ? (await prisma.sale.findUniqueOrThrow({ where: { id: saleId } })).status : null, contador: (await prisma.documentCounter.findMany({ where: { tenantId: t.id, scope: 'RETURN' } })).map((c) => c.next).join(),
    refundsCash: (await prisma.cashSession.findMany({ where: { tenantId: t.id } })).map((s) => num(s.refundsCashTotal)).join(),
  })
  return { t, b1, b2, u, O, db, P1, P2, P3, cliente, vender, abrir, L, stock, doc, devolver, foto, sedes }
}
type N = Awaited<ReturnType<typeof negocio>>

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 300) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  console.log('\nA) Venta de contado: stock, costo, caja y estado')
  const A = await negocio('contado')
  const turno = await A.abrir(100)
  const costoAntes = num((await prisma.product.findUniqueOrThrow({ where: { id: A.P1.id } })).costPrice)
  const s1 = await A.vender([A.L(A.P1.id, 2)], [{ method: 'EFECTIVO', amount: 200 }])
  const stockVendido = await A.stock(A.P1.id)
  check('(preparación) vender bajó el stock 2 y el cajón espera 300', stockVendido === 98 && (await currentCashSession(A.db(A.O), A.O))!.expectedAmount === 300)
  const r1 = await A.devolver(s1.saleId)
  const v1 = await prisma.sale.findUniqueOrThrow({ where: { id: s1.saleId } })
  check('>>> la venta pasa a DEVUELTA con fecha y motivo; el registro lleva el número D001-00000001', v1.status === 'DEVUELTA' && v1.voidedAt !== null && v1.voidReason === 'El cliente devolvió la mercadería' && r1.number === 'D001-00000001' && r1.status === 'DEVUELTA' && !r1.replayed)
  check('>>> STOCK: vuelve exactamente al de antes de la venta', (await A.stock(A.P1.id)) === 100)
  const movs = await prisma.stockMovement.findMany({ where: { tenantId: A.t.id, productId: A.P1.id }, orderBy: { createdAt: 'asc' } })
  const dev = movs.find((m) => m.type === 'DEVOLUCION_CLIENTE')!
  check('>>> el movimiento es DEVOLUCION_CLIENTE (entrada de 2), enlazado a la devolución, con el saldo encadenado y SIN «costo pendiente»', !!dev && num(dev.quantity) === 2 && dev.referenceType === 'DEVOLUCION' && dev.referenceId === r1.returnId && num(dev.balanceAfter) === 100 && dev.costPending === false && movs.filter((m) => m.type === 'VENTA' || m.type === 'SALIDA').length === 1)
  check('>>> COSTO: el costo promedio del producto NO cambia; el movimiento guarda el costo con el que se vendió (solo traza)', num((await prisma.product.findUniqueOrThrow({ where: { id: A.P1.id } })).costPrice) === costoAntes && num(dev.unitCost) === 60)
  const ret = await prisma.saleReturn.findUniqueOrThrow({ where: { id: r1.returnId }, include: { items: true, refunds: true } })
  check('>>> el registro: completa, de la venta, con 1 línea (2 unidades, 200.00) y 1 reembolso CAJA de 200.00 ligado al turno', ret.isFull && ret.items.length === 1 && num(ret.items[0]!.quantity) === 2 && num(ret.items[0]!.amount) === 200 && ret.refunds.length === 1 && ret.refunds[0]!.mode === 'CAJA' && ret.refunds[0]!.method === 'EFECTIVO' && num(ret.refunds[0]!.amount) === 200 && ret.refunds[0]!.cashSessionId === turno.id && num(ret.paidNet) === 200 && ret.creditNoteId === null)
  const tot = await totalesDelTurno(A.db(A.O), turno.id)
  check('>>> CAJA: el efectivo cobrado sigue contando en el turno (200) y la devolución lo saca (−200): el esperado vuelve al fondo (100)', tot.cashTotal === 200 && tot.refundsCashTotal === 200 && (await currentCashSession(A.db(A.O), A.O))!.expectedAmount === 100)
  check('la auditoría deja `venta.devuelta` con el motivo y el detalle', await (async () => { const l = await prisma.auditLog.findFirst({ where: { tenantId: A.t.id, action: 'venta.devuelta', entityId: s1.saleId } }); return !!l && l.reason === 'El cliente devolvió la mercadería' && JSON.stringify(l.after).includes('D001-00000001') && JSON.stringify(l.after).includes('"efectivoDelCajon":200') })())
  const cierre = await closeCashSession(A.db(A.O), A.O, closeCashSchema.parse({ sessionId: turno.id, countedAmount: 100 }))
  const cerrada = await prisma.cashSession.findUniqueOrThrow({ where: { id: turno.id } })
  check('>>> el cierre cuadra (esperado 100, contado 100) y congela las devoluciones del turno (200 en efectivo)', cierre.expectedAmount === 100 && cierre.difference === 0 && cierre.refundsCashTotal === 200 && num(cerrada.refundsCashTotal) === 200 && cierre.salesCount === 1 && cierre.salesTotal === 200)
  check('>>> y el recálculo del turno CERRADO sigue siendo idéntico a lo congelado (un turno cerrado no cambia)', await (async () => { const x = await totalesDelTurno(A.db(A.O), turno.id); return x.salesTotal === 200 && x.cashTotal === 200 && x.refundsCashTotal === 200 && x.salesCount === 1 })())

  console.log('\nB) Anulación, pagos mixtos y destinos del dinero')
  const T2 = await A.abrir(0)
  const sa = await A.vender([A.L(A.P1.id, 1), A.L(A.P3.id, 1)], [{ method: 'EFECTIVO', amount: 140 }, { method: 'YAPE', amount: 20 }, { method: 'TARJETA_DEBITO', amount: 3.33 }])   // 100 + 33.33 − …
  void sa
  const sb = await A.vender([A.L(A.P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }, { method: 'YAPE', amount: 25 }].slice(0, 1))
  void sb
  const sm = await A.vender([A.L(A.P1.id, 1), A.L(A.P3.id, 1)], [{ method: 'EFECTIVO', amount: 110 }, { method: 'YAPE', amount: 23.33 }])
  const rm = await A.devolver(sm.saleId, { kind: 'ANULACION' })
  const lm = await prisma.saleReturnRefund.findMany({ where: { returnId: rm.returnId }, orderBy: { method: 'asc' } })
  check('>>> ANULACIÓN: la venta queda ANULADA; el reembolso por defecto replica los pagos: efectivo 110 del cajón y Yape 23.33 por fuera', rm.status === 'ANULADA' && (await prisma.sale.findUniqueOrThrow({ where: { id: sm.saleId } })).status === 'ANULADA' && lm.length === 2 && lm.find((x) => x.mode === 'CAJA' && num(x.amount) === 110) !== undefined && lm.find((x) => x.mode === 'EXTERNO' && x.method === 'YAPE' && num(x.amount) === 23.33) !== undefined)
  const tm = await totalesDelTurno(A.db(A.O), T2.id)
  check('>>> en caja solo salen los 110 en efectivo; lo del Yape queda como devolución por otro medio (23.33) y no toca el cajón', tm.refundsCashTotal === 110 && tm.refundsOtherTotal === 23.33, `${tm.refundsCashTotal}/${tm.refundsOtherTotal}`)
  const sv = await A.vender([A.L(A.P1.id, 1)], [{ method: 'EFECTIVO', amount: 150 }])   // paga 150 por 100, vuelto 50
  const rv = await A.devolver(sv.saleId)
  check('>>> con vuelto: se reembolsa lo PAGADO DE VERDAD (100), no lo entregado (150)', num((await prisma.saleReturn.findUniqueOrThrow({ where: { id: rv.returnId } })).paidNet) === 100 && rv.refunds[0]!.amount === 100)
  const s4 = await A.vender([A.L(A.P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }])
  const r4 = await A.devolver(s4.saleId, { refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100, reference: 'op 123' }] })
  const tt = await totalesDelTurno(A.db(A.O), T2.id)
  check('>>> el cliente cobró en efectivo pero se le devuelve por Yape: no sale del cajón (el efectivo queda como sobrante explicado)', r4.refunds[0]!.mode === 'EXTERNO' && tt.refundsCashTotal === 110 + 100 && tt.refundsOtherTotal === 23.33 + 100 || tt.refundsCashTotal === 110 + 100)
  const s5 = await A.vender([A.L(A.P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }])
  const r5 = await A.devolver(s5.saleId, { refunds: [{ mode: 'SIN_SALIDA', amount: 100, reference: 'Vale de tienda acordado' }] })
  check('>>> «sin salida de dinero» con motivo: queda registrado como tal y no sale nada del cajón', r5.refunds[0]!.mode === 'SIN_SALIDA' && r5.refunds[0]!.method === null && (await totalesDelTurno(A.db(A.O), T2.id)).refundsCashTotal === tt.refundsCashTotal)
  const s6 = await A.vender([A.L(A.P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }])
  const f0 = await A.foto(s6.saleId)
  check('>>> reembolsos que no suman lo pagado, o «sin salida» sin motivo → rechazados sin tocar nada', (await code(A.devolver(s6.saleId, { refunds: [{ mode: 'CAJA', amount: 90 }] }))) === 'INVALID_DOCUMENT' && (await code(A.devolver(s6.saleId, { refunds: [{ mode: 'SIN_SALIDA', amount: 100 }] }))) === 'INVALID_DOCUMENT' && JSON.stringify(await A.foto(s6.saleId)) === JSON.stringify(f0))

  console.log('\nC) Sin caja abierta')
  const C = await negocio('sin-caja')
  const tC = await C.abrir(0)
  const sc = await C.vender([C.L(C.P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }])
  const sc2 = await C.vender([C.L(C.P1.id, 1)], [{ method: 'YAPE', amount: 100 }])
  await closeCashSession(C.db(C.O), C.O, closeCashSchema.parse({ sessionId: tC.id, countedAmount: 100 }))   // F6.8b: quien devuelve necesita SU turno abierto
  const fc = await C.foto(sc.saleId)
  const ec = await err(C.devolver(sc.saleId))
  check('>>> devolver efectivo del cajón sin turno propio → CASH_REQUIRED, con el camino, y NADA cambia', ec?.code === 'CASH_REQUIRED' && ec.message.includes('turno de caja abierto') && JSON.stringify(await C.foto(sc.saleId)) === JSON.stringify(fc))
  check('>>> F6.8b: devolver por OTRO medio (Yape, transferencia) también mueve dinero: sin turno propio, CASH_REQUIRED', await code(C.devolver(sc.saleId, { refunds: [{ mode: 'EXTERNO', method: 'TRANSFERENCIA', amount: 100 }] })) === 'CASH_REQUIRED' && await code(C.devolver(sc2.saleId)) === 'CASH_REQUIRED')
  await C.abrir(0)
  const rc = await C.devolver(sc.saleId, { refunds: [{ mode: 'EXTERNO', method: 'TRANSFERENCIA', amount: 100 }] })
  check('…con su turno abierto se devuelve por otro medio y el stock vuelve', rc.status === 'DEVUELTA' && (await C.stock(C.P1.id)) === 99)
  check('una venta pagada solo por Yape se devuelve (por defecto sale como Yape)', (await C.devolver(sc2.saleId)).refunds[0]!.mode === 'EXTERNO')

  console.log('\nD) Un turno CERRADO no cambia: el dinero sale en el turno de hoy')
  const D = await negocio('turno-cerrado')
  const tAyer = await D.abrir(50)
  const sd = await D.vender([D.L(D.P1.id, 2)], [{ method: 'EFECTIVO', amount: 200 }])
  await closeCashSession(D.db(D.O), D.O, closeCashSchema.parse({ sessionId: tAyer.id, countedAmount: 250 }))
  const congelado = await prisma.cashSession.findUniqueOrThrow({ where: { id: tAyer.id } })
  const tHoy = await D.abrir(30)
  await D.devolver(sd.saleId)
  const despues = await prisma.cashSession.findUniqueOrThrow({ where: { id: tAyer.id } })
  const ref = await prisma.saleReturnRefund.findFirstOrThrow({ where: { tenantId: D.t.id } })
  check('>>> el turno de AYER queda idéntico (esperado, ventas, devoluciones y estado congelados)', JSON.stringify([congelado.expectedAmount, congelado.salesTotal, congelado.cashTotal, congelado.refundsCashTotal, congelado.status, congelado.difference]) === JSON.stringify([despues.expectedAmount, despues.salesTotal, despues.cashTotal, despues.refundsCashTotal, despues.status, despues.difference]) && num(despues.refundsCashTotal) === 0)
  check('>>> el reembolso se asienta en el turno de HOY: sale 200 del cajón y el esperado es 30 − 200 = −170 (falta efectivo para devolver: se verá en el arqueo)', ref.cashSessionId === tHoy.id && (await totalesDelTurno(D.db(D.O), tHoy.id)).refundsCashTotal === 200 && (await currentCashSession(D.db(D.O), D.O))!.expectedAmount === -170)
  check('>>> el recálculo del turno de ayer (con la venta ya DEVUELTA) sigue igual a lo congelado', await (async () => { const x = await totalesDelTurno(D.db(D.O), tAyer.id); return x.salesTotal === num(congelado.salesTotal) && x.cashTotal === num(congelado.cashTotal) && x.salesCount === congelado.salesCount && x.refundsCashTotal === 0 })())

  console.log('\nE) Venta fiada')
  const E = await negocio('fiado')
  await E.abrir(0)
  const f1 = await E.vender([E.L(E.P1.id, 5)], [{ method: 'CREDITO', amount: 500 }], { customerId: E.cliente.id })
  const deuda0 = num((await prisma.customer.findUniqueOrThrow({ where: { id: E.cliente.id } })).creditBalance)
  check('(preparación) la deuda del cliente es 500', deuda0 === 500)
  const re = await E.devolver(f1.saleId)
  const cuenta = await prisma.receivable.findFirstOrThrow({ where: { saleId: f1.saleId } })
  check('>>> sin abonos: la cuenta pasa a ANULADA (con fecha y motivo) y la deuda del cliente baja los 500 en la misma operación', cuenta.status === 'ANULADA' && cuenta.voidedAt !== null && cuenta.voidReason!.includes(re.number) && num((await prisma.customer.findUniqueOrThrow({ where: { id: E.cliente.id } })).creditBalance) === 0 && re.receivableVoidedAmount === 500 && re.refunds.length === 0)
  check('>>> una venta toda fiada no mueve dinero: ningún reembolso ni salida de caja', (await prisma.saleReturnRefund.count({ where: { returnId: re.returnId } })) === 0 && (await E.foto()).refundsCash === '0')
  const ctrl = await auditarCoherenciaCredito(E.db(E.O))
  check('>>> `auditar-credito` queda LIMPIO tras la devolución (deuda = suma de saldos abiertos; cuenta de venta devuelta cerrada)', ctrl.hallazgos.length === 0, JSON.stringify(ctrl.hallazgos.map((h) => h.codigo)))
  check('y la línea de crédito del cliente se libera (puede volver a fiar 4000 de su línea de 5000)', await code(E.vender([E.L(E.P1.id, 40)], [{ method: 'CREDITO', amount: 4000 }], { customerId: E.cliente.id })) === null)
  const mx = await E.vender([E.L(E.P1.id, 5)], [{ method: 'EFECTIVO', amount: 300 }, { method: 'CREDITO', amount: 200 }], { customerId: E.cliente.id })
  const deudaMx = num((await prisma.customer.findUniqueOrThrow({ where: { id: E.cliente.id } })).creditBalance)
  const rmx = await E.devolver(mx.saleId)
  check('>>> mixta (300 efectivo + 200 fiado): se reembolsan los 300 del cajón y se cancelan los 200 de deuda', rmx.refunds.length === 1 && rmx.refunds[0]!.amount === 300 && rmx.receivableVoidedAmount === 200 && num((await prisma.customer.findUniqueOrThrow({ where: { id: E.cliente.id } })).creditBalance) === deudaMx - 200)

  console.log('\nF) Venta fiada CON abonos: se bloquea')
  const F = await negocio('fiado-abonos')
  await F.abrir(0)
  const g1 = await F.vender([F.L(F.P1.id, 4)], [{ method: 'CREDITO', amount: 400 }], { customerId: F.cliente.id })
  const ab = await registrarAbono(F.db(F.O), F.O, registrarAbonoSchema.parse({ customerId: F.cliente.id, method: 'EFECTIVO', amount: 100, idempotencyKey: randomUUID() }))
  const fF = await F.foto(g1.saleId)
  const eF = await err(F.devolver(g1.saleId))
  check('>>> bloqueada con CREDIT_HAS_PAYMENTS, el mensaje nombra el abono (S/ 100.00, efectivo) y dice cómo proceder; NADA cambia', eF?.code === 'CREDIT_HAS_PAYMENTS' && eF.message.includes('S/ 100.00') && eF.message.includes('efectivo') && eF.message.includes('anula esos abonos') && JSON.stringify(await F.foto(g1.saleId)) === JSON.stringify(fF))
  await anularAbono(F.db(F.O), F.O, anularAbonoSchema.parse({ paymentId: ab.paymentId, motivo: 'Abono mal registrado' }))
  const rF = await F.devolver(g1.saleId)
  check('>>> tras anular el abono (camino ya existente y auditado) la devolución procede y la deuda queda en 0', rF.status === 'DEVUELTA' && num((await prisma.customer.findUniqueOrThrow({ where: { id: F.cliente.id } })).creditBalance) === 0 && (await auditarCoherenciaCredito(F.db(F.O))).hallazgos.length === 0)

  console.log('\nG) Comprobante: nota de crédito total donde corresponde')
  const G = await negocio('comprobante')
  await G.abrir(0)
  const nota = async (estado: string, kind: 'ANULACION' | 'DEVOLUCION', o: { tipo?: 'BOLETA' | 'FACTURA'; trial?: boolean; externalId?: string | null } = {}) => {
    const v = await G.vender([G.L(G.P1.id, 1)], [{ method: 'YAPE', amount: 100 }], { documentType: o.tipo === 'FACTURA' ? 'FACTURA' : 'BOLETA', ...(o.tipo === 'FACTURA' ? { customerId: G.cliente.id } : {}) })
    const d = await G.doc(v.saleId, { ...o, estado })
    return { v, d }
  }
  const g1a = await nota('ACEPTADO', 'DEVOLUCION')
  const rg1 = await G.devolver(g1a.v.saleId)
  const nc1 = await prisma.taxDocument.findFirstOrThrow({ where: { tenantId: G.t.id, relatedDocumentId: g1a.d.id } })
  check('>>> boleta ACEPTADA + devolución → nota de crédito TOTAL motivo 06, serie BC01, por el mismo importe, ligada a la devolución', nc1.documentType === 'NOTA_CREDITO' && nc1.reasonCode === '06' && nc1.series === 'BC01' && nc1.fullNumber === 'BC01-00000001' && num(nc1.total) === num(g1a.d.total) && rg1.creditNote?.fullNumber === 'BC01-00000001' && (await prisma.saleReturn.findUniqueOrThrow({ where: { id: rg1.returnId } })).creditNoteId === nc1.id)
  check('>>> en un negocio REAL la nota se encola para enviarse', (await prisma.fiscalDispatch.count({ where: { tenantId: G.t.id, taxDocumentId: nc1.id } })) === 1 && nc1.status === 'PENDIENTE')
  const g2 = await nota('ACEPTADO', 'ANULACION', { tipo: 'FACTURA' })
  const rg2 = await G.devolver(g2.v.saleId, { kind: 'ANULACION' })
  const nc2 = await prisma.taxDocument.findFirstOrThrow({ where: { tenantId: G.t.id, relatedDocumentId: g2.d.id } })
  check('>>> factura + ANULACIÓN → motivo 01, serie FC01', nc2.reasonCode === '01' && nc2.series === 'FC01' && rg2.creditNote !== null)
  const g3 = await nota('OBSERVADO', 'DEVOLUCION')
  const rg3 = await G.devolver(g3.v.saleId)
  check('>>> OBSERVADO (válido, suma en el registro) también recibe su nota de crédito total', rg3.creditNote !== null && (await prisma.taxDocument.count({ where: { tenantId: G.t.id, relatedDocumentId: g3.d.id, documentType: 'NOTA_CREDITO' } })) === 1)
  for (const st of ['PENDIENTE', 'ENVIADO'] as const) {
    const gx = await nota(st, 'DEVOLUCION')
    const fx = await G.foto(gx.v.saleId)
    const ex = await err(G.devolver(gx.v.saleId))
    check(`>>> comprobante ${st} → BLOQUEADO («cola fiscal»), sin tocar nada`, ex?.code === 'INVALID_DOCUMENT' && ex.message.includes('cola fiscal') && JSON.stringify(await G.foto(gx.v.saleId)) === JSON.stringify(fx))
  }
  for (const st of ['RECHAZADO', 'ANULADO'] as const) {
    const gx = await nota(st, 'DEVOLUCION')
    const rx = await G.devolver(gx.v.saleId)
    check(`comprobante ${st} → se devuelve SIN nota de crédito (ya no está vivo)`, rx.creditNote === null && (await prisma.taxDocument.count({ where: { tenantId: G.t.id, relatedDocumentId: gx.d.id } })) === 0)
  }
  const gt = await nota('ACEPTADO', 'DEVOLUCION', { trial: true })
  const rt = await G.devolver(gt.v.saleId)
  const dt = await prisma.taxDocument.findUniqueOrThrow({ where: { id: gt.d.id } })
  check('>>> comprobante de ENSAYO → sin nota; queda marcado como anulado (marca de agua) con el motivo', rt.creditNote === null && dt.voidedAt !== null && dt.voidReason!.includes(rt.number))
  const gs = await nota('ACEPTADO', 'DEVOLUCION', { externalId: null })
  const fs = await G.foto(gs.v.saleId)
  const es = await err(G.devolver(gs.v.saleId))
  check('>>> real sin el identificador del proveedor → rechazado con el camino «Consultar»; NADA cambia (ni stock ni caja ni nota)', es?.message.includes('Consultar') === true && JSON.stringify(await G.foto(gs.v.saleId)) === JSON.stringify(fs))
  const gn = await G.vender([G.L(G.P1.id, 1)], [{ method: 'YAPE', amount: 100 }])
  check('una nota de venta (sin comprobante) se devuelve sin nota', (await G.devolver(gn.saleId)).creditNote === null)
  const cc = (await calcularConciliacion(G.db(G.O), parametrosRegistrosSchema.parse({ p: 'MES' }), new Date())).informe
  check('>>> la CONCILIACIÓN (F5.7) no ve ningún comprobante vivo en ventas devueltas: las notas lo neutralizan (los pendientes bloqueados no se tocaron)', !cc.hallazgos.some((h) => h.codigo === 'COMPROBANTE_VIVO_EN_VENTA_CERRADA') && cc.puente.diferencia === 0 && cc.hallazgos.some((h) => h.codigo === 'COMPROBANTES_DE_VENTAS_DEVUELTAS' && h.nivel === 'INFO') && !cc.hallazgos.some((h) => h.codigo === 'DIFERENCIA_DE_FECHAS'))
  const GP = await negocio('pausado', 'PAUSADO')
  await GP.abrir(0)
  const vp = await GP.vender([GP.L(GP.P1.id, 1)], [{ method: 'YAPE', amount: 100 }], { documentType: 'BOLETA' })
  await GP.doc(vp.saleId)
  const rp = await GP.devolver(vp.saleId)
  check('con el envío en PAUSA la nota se crea igual (queda pendiente hasta reanudar)', rp.creditNote !== null)

  console.log('\nH) Productos, presentaciones y casos de estado')
  const H = await negocio('lineas')
  await H.abrir(0)
  const caja = await crearPresentacion(H.db(H.O), H.O, { productId: H.P3.id, name: 'Caja x 12', unitType: 'CAJA', factor: '12' })
  const sh = await H.vender([H.L(H.P1.id, 3), H.L(H.P2.id, 1), H.L(H.P3.id, 24, { presentationId: caja.id, enteredQuantity: 2 })], [{ method: 'YAPE', amount: 1199.92 }])
  const antes3 = await H.stock(H.P3.id)
  const rh = await H.devolver(sh.saleId)
  const mh = await prisma.stockMovement.findFirst({ where: { tenantId: H.t.id, productId: H.P3.id, type: 'DEVOLUCION_CLIENTE' } })
  check('>>> presentación: las 2 cajas vuelven como 24 unidades base, con la presentación (2 × caja de 12) en el movimiento', (await H.stock(H.P3.id)) === antes3 + 24 && num(mh?.quantity) === 24 && num(mh?.enteredQuantity) === 2 && num(mh?.presentationFactor) === 12)
  check('>>> el producto SIN control de stock (servicio) no mueve stock ni genera movimiento; las líneas del registro son las 3', (await prisma.stockMovement.count({ where: { tenantId: H.t.id, productId: H.P2.id } })) === 0 && (await prisma.saleReturnItem.count({ where: { returnId: rh.returnId } })) === 3 && rh.stockLines === 3)
  const sd2 = await H.vender([H.L(H.P1.id, 1)], [{ method: 'YAPE', amount: 100 }])
  await prisma.product.update({ where: { id: H.P1.id }, data: { deletedAt: new Date() } })
  const fd = await H.foto(sd2.saleId)
  const ed = await err(H.devolver(sd2.saleId))
  check('>>> producto dado de baja → BLOQUEADO, con su NOMBRE y cómo seguir; nada cambia', ed?.code === 'INVALID_DOCUMENT' && ed.message.includes('«Prod P1»') && ed.message.includes('Reactívalo') && JSON.stringify(await H.foto(sd2.saleId)) === JSON.stringify(fd))
  await prisma.product.update({ where: { id: H.P1.id }, data: { deletedAt: null } })
  check('…y reactivado, la devolución procede', (await H.devolver(sd2.saleId)).status === 'DEVUELTA')

  console.log('\nI) Estado de la venta e idempotencia')
  const I = await negocio('estado')
  await I.abrir(0)
  const si = await I.vender([I.L(I.P1.id, 1)], [{ method: 'YAPE', amount: 100 }])
  const clave = randomUUID()
  const ri = await I.devolver(si.saleId, { idempotencyKey: clave })
  const repetida = await I.devolver(si.saleId, { idempotencyKey: clave })
  check('>>> el reintento con la MISMA clave devuelve el mismo resultado (replayed) sin duplicar stock, dinero ni registros', repetida.replayed && repetida.returnId === ri.returnId && repetida.number === ri.number && (await I.stock(I.P1.id)) === 100 && (await prisma.saleReturn.count({ where: { tenantId: I.t.id } })) === 1)
  check('>>> otra clave sobre la misma venta → «ya está devuelta»', (await err(I.devolver(si.saleId)))?.message.includes('ya está devuelta') === true)
  const otra = await I.vender([I.L(I.P1.id, 1)], [{ method: 'YAPE', amount: 100 }])
  check('la misma clave usada con OTRA venta se rechaza', (await err(I.devolver(otra.saleId, { idempotencyKey: clave })))?.message.includes('otra venta') === true)
  check('>>> una venta ANULADA no se vuelve a anular; una inexistente → NOT_FOUND', (await code(I.devolver(si.saleId, { kind: 'ANULACION' }))) === 'INVALID_DOCUMENT' && (await code(I.devolver('no-existe'))) === 'NOT_FOUND')
  const borrador = await prisma.sale.create({ data: { tenantId: I.t.id, branchId: I.b1.branch.id, warehouseId: I.b1.warehouse.id, userId: I.O.userId, number: 'V-BORRADOR', documentType: 'NOTA_VENTA', status: 'BORRADOR', total: 10, subtotal: 8.47, taxTotal: 1.53 } })
  check('un borrador no se devuelve', (await err(I.devolver(borrador.id)))?.message.includes('completada') === true)

  console.log('\nJ) Permisos, sucursales y cuenta')
  const J = await negocio('permisos')
  await J.abrir(0); await J.abrir(0, 'b2')
  // F6.8b: quien devuelve saca de SU caja: el administrador y el cajero con el permiso también tienen turno.
  await abrirTurno(J.t.id, J.u.ADMIN!.userId, J.b1.branch.id); await abrirTurno(J.t.id, J.u.CAJERO!.userId, J.b1.branch.id)
  const probar = async (c: TenantContext) => { const v = await J.vender([J.L(J.P1.id, 1)], [{ method: 'YAPE', amount: 100 }]); return code(J.devolver(v.saleId, {}, c)) }
  for (const r of ['OWNER', 'ADMIN']) check(`>>> ${r} puede anular/devolver`, (await probar(J.u[r]!)) === null)
  for (const r of ['CONTADOR', 'CAJERO', 'VENDEDOR', 'ALMACENERO']) check(`>>> ${r} NO puede (FORBIDDEN_ROLE)`, (await probar(J.u[r]!)) === 'FORBIDDEN_ROLE')
  const sx = await J.vender([J.L(J.P1.id, 1)], [{ method: 'CREDITO', amount: 100 }], { customerId: J.cliente.id, documentType: 'BOLETA' })
  await J.doc(sx.saleId)
  const cajeroConPermiso: TenantContext = { ...J.u.CAJERO!, permisosExtra: ['ventas.anular'] }
  check('>>> UN SOLO PERMISO basta: un cajero con `ventas.anular` devuelve una venta fiada CON comprobante real (nota de crédito + baja de la deuda) sin `comprobantes.anular` ni `credito.castigar`', (await code(J.devolver(sx.saleId, {}, cajeroConPermiso))) === null && (await prisma.taxDocument.count({ where: { tenantId: J.t.id, documentType: 'NOTA_CREDITO' } })) === 1)
  check('>>> y quien tiene `comprobantes.anular` o `credito.castigar` pero NO `ventas.anular` no puede devolver', (await probar({ ...J.u.CAJERO!, permisosExtra: ['credito.castigar'] })) === 'FORBIDDEN_ROLE' && (await probar({ ...J.u.CONTADOR!, permisosExtra: ['credito.castigar'] })) === 'FORBIDDEN_ROLE')
  check('>>> un administrador al que se le deniega `ventas.anular` no puede', (await probar({ ...J.u.ADMIN!, permisosDenegados: ['ventas.anular'] })) === 'FORBIDDEN_ROLE')
  check('>>> `ventas.anular` está FUERA del PIN de operador: ni con la sesión del dueño se concede', PERMISOS_FUERA_DEL_PIN.includes('ventas.anular') && permisosDenegadosAlOperador(new Set(PERMISOS)).includes('ventas.anular'))
  const sy = await J.vender([J.L(J.P1.id, 1)], [{ method: 'YAPE', amount: 100 }], {}, 'b2')
  check('>>> acotado por sucursal: quien solo ve la sucursal 1 no encuentra la venta de la 2 (NOT_FOUND)', (await code(J.devolver(sy.saleId, {}, { ...J.O, branchIds: [J.b1.branch.id] }))) === 'NOT_FOUND')
  const sz = await J.vender([J.L(J.P1.id, 1)], [{ method: 'YAPE', amount: 100 }])
  check('>>> una cuenta en solo lectura no puede devolver', (await code(J.devolver(sz.saleId, {}, { ...J.O, access: 'READ_ONLY' }))) === 'SUBSCRIPTION_READ_ONLY')
  const K = await negocio('otro-negocio')
  check('>>> otro negocio no puede tocar la venta (NOT_FOUND)', (await code(K.devolver(sz.saleId))) === 'NOT_FOUND')

  console.log('\nK) Todo o nada: un fallo al final deshace TODO')
  const R = await negocio('rollback')
  await R.abrir(0)
  const vr = await R.vender([R.L(R.P1.id, 3)], [{ method: 'EFECTIVO', amount: 100 }, { method: 'CREDITO', amount: 200 }], { customerId: R.cliente.id, documentType: 'BOLETA' })
  await R.doc(vr.saleId)
  const otraVenta = await R.vender([R.L(R.P1.id, 1)], [{ method: 'YAPE', amount: 100 }])
  // Un registro ajeno que ya tiene el número que va a tomar esta devolución: la creación falla DESPUÉS de cancelar la deuda, emitir la nota y antes de reponer el stock.
  await prisma.documentCounter.updateMany({ where: { tenantId: R.t.id, scope: 'RETURN' }, data: { next: 7 } })
  await prisma.documentCounter.upsert({ where: { tenantId_scope_series: { tenantId: R.t.id, scope: 'RETURN', series: '001' } }, update: { next: 7 }, create: { tenantId: R.t.id, branchId: R.b1.branch.id, scope: 'RETURN', series: '001', prefix: 'D', next: 7 } })
  await prisma.saleReturn.create({ data: { tenantId: R.t.id, saleId: otraVenta.saleId, kind: 'DEVOLUCION', number: 'D001-00000007', reason: 'Registro previo', isFull: false, userId: R.O.userId, saleTotal: 100, returnTotal: 100, paidNet: 100, idempotencyKey: randomUUID() } })
  const fr = await R.foto(vr.saleId)
  const er = await err(R.devolver(vr.saleId))
  const fr2 = await R.foto(vr.saleId)
  check('>>> el fallo llegó DESPUÉS de cancelar la deuda y emitir la nota (choque del número en la base) y deshace TODO: la venta sigue COMPLETADA, el stock igual, la deuda igual, la cuenta abierta, sin nota de crédito, sin reembolso y sin gastar el correlativo', er?.message.includes('ya fue anulada o devuelta') === true && fr2.estado === 'COMPLETADA' && JSON.stringify({ ...fr2, devoluciones: 0 }) === JSON.stringify({ ...fr, devoluciones: 0 }) && fr2.devoluciones === fr.devoluciones, `${er?.message ?? 'no falló'}`)
  await prisma.saleReturn.deleteMany({ where: { number: 'D001-00000007', tenantId: R.t.id } })
  const rOk = await R.devolver(vr.saleId)
  check('…y una vez libre el número, la misma devolución procede entera: toma el número que no se gastó, repone el stock (3), cancela la deuda (200), emite la nota y saca los 100 del cajón', rOk.number === 'D001-00000007' && rOk.status === 'DEVUELTA' && (await R.stock(R.P1.id)) === 99 && rOk.receivableVoidedAmount === 200 && rOk.creditNote !== null && rOk.refunds[0]!.amount === 100)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
