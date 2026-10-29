import './guard'
import { correr } from './teardown'
import { abrirTurno, asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import {
  anularAbono, anularCuenta, configurarCredito, descartarRevision, registrarAbono,
} from '../src/features/credito/credito-service'
import {
  anularAbonoSchema, anularCuentaSchema, configurarCreditoSchema, descartarRevisionSchema, registrarAbonoSchema,
} from '../src/features/credito/schemas'
import { closeCashSession, openCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { emitirNotaCreditoTotal, issueTaxDocument } from '../src/features/invoicing/service'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 3, subpaso 3.3: abonos idempotentes, anulaciones, castigo y la marca por nota de crédito.
 * Lo que más importa: un abono nunca se cobra dos veces, nunca supera la deuda, reparte primero lo más antiguo, y TODO cambio de deuda
 * deja la caché del cliente igual a la suma de sus cuentas abiertas.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const dia = (d: Date) => d.toISOString().slice(0, 10)

async function negocio(tag: string, o: { real?: boolean } = {}) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: {
    slug: `ca-${tag}-${randomUUID().slice(0, 6)}`, name: `Abonos ${tag}`, legalName: `ABONOS ${tag.toUpperCase()} SAC`, taxId, planId: plan.id,
    ...(o.real ? { pseConfiguredAt: new Date(), realBillingEnabledAt: new Date(Date.now() - 86_400_000) } : {}),
  } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_ca' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { seriesNumber: 2, branchCode: 'S2', almacenCode: 'A2', establishmentCode: '0002' })
  await prisma.branch.update({ where: { id: b1.branch.id }, data: { address: 'Av. Prueba 123, Lima', ubigeo: '150101' } })
  const mk = async (role: Role) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    for (const b of [b1.branch.id, b2.branch.id]) await asignarSucursal(t.id, u.id, b)
    return u
  }
  const owner = await mk('OWNER'), owner2 = await mk('OWNER'), cajeroU = await mk('CAJERO'), almU = await mk('ALMACENERO'), vendU = await mk('VENDEDOR')
  const ctxDe = (u: { id: string }, role: Role, branchId: string, extra: TenantContext['permisosExtra'] = []): TenantContext =>
    ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: extra })
  // F6.8: una persona tiene como mucho UN turno abierto en toda la cuenta: la sucursal 2 la lleva otra persona.
  const O1 = ctxDe(owner, 'OWNER', b1.branch.id), O2 = ctxDe(owner2, 'OWNER', b2.branch.id)
  const Caj = ctxDe(cajeroU, 'CAJERO', b1.branch.id), Alm = ctxDe(almU, 'ALMACENERO', b1.branch.id), Vend = ctxDe(vendU, 'VENDEDOR', b1.branch.id)
  const dbOf = (c: TenantContext) => getTenantPrisma(c)
  if (o.real) await abrirTurno(t.id, owner.id, b1.branch.id)   // F6.8b: el negocio «real» cobra con el turno propio del dueño
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Producto', salePrice: 100 } })
  for (const w of [b1.warehouse, b2.warehouse]) await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: w.id, quantity: 1000 } })
  let dni = 41300000
  const cliente = (over: Record<string, unknown> = {}) => prisma.customer.create({ data: { tenantId: t.id, name: `Cliente ${dni}`, docType: 'DNI', docNumber: String(dni++), creditLimit: 5000, ...over } })
  type Sede = { ctx: TenantContext; w: string }
  const S1: Sede = { ctx: O1, w: b1.warehouse.id }, S2: Sede = { ctx: O2, w: b2.warehouse.id }
  const fiar = (s: Sede, customerId: string, monto: number, over: Record<string, unknown> = {}) =>
    registerSale(dbOf(s.ctx), s.ctx, { warehouseId: s.w, customerId, items: [{ productId: prod.id, quantity: monto / 100, discount: 0 }], payments: [{ method: 'CREDITO', amount: monto }], documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID(), ...over } as never)
  const plazo = (customerId: string, dias: number) => configurarCredito(dbOf(O1), O1, configurarCreditoSchema.parse({ customerId, creditLimit: 5000, creditTermDays: dias, bloqueado: false }))
  const abonar = (ctx: TenantContext, customerId: string, amount: number, over: Record<string, unknown> = {}) =>
    registrarAbono(dbOf(ctx), ctx, registrarAbonoSchema.parse({ customerId, method: 'YAPE', amount, idempotencyKey: randomUUID(), ...over }))
  const deuda = async (id: string) => num((await prisma.customer.findUniqueOrThrow({ where: { id } })).creditBalance)
  const cuentaDe = (saleId: string) => prisma.receivable.findFirstOrThrow({ where: { saleId } })
  const foto = async () => ({
    pagos: await prisma.customerPayment.count({ where: { tenantId: t.id } }), reparto: await prisma.paymentAllocation.count({ where: { tenantId: t.id } }),
    saldo: (await prisma.customer.findMany({ where: { tenantId: t.id }, orderBy: { id: 'asc' }, select: { creditBalance: true } })).map((c) => num(c.creditBalance)).join(','),
    pagado: (await prisma.receivable.findMany({ where: { tenantId: t.id }, orderBy: { id: 'asc' }, select: { paidAmount: true, status: true } })).map((c) => `${c.paidAmount}${c.status}`).join(','),
  })
  const coherencia = async () => {
    const cs = await prisma.customer.findMany({ where: { tenantId: t.id } })
    const abiertas = await prisma.receivable.findMany({ where: { tenantId: t.id, status: 'ABIERTA' } })
    return cs.filter((c) => Math.abs(num(c.creditBalance) - abiertas.filter((r) => r.customerId === c.id).reduce((s, r) => s + num(r.amount) - num(r.paidAmount), 0)) > 1e-9).length
  }
  return { t, taxId, b1, b2, owner, O1, O2, Caj, Alm, Vend, dbOf, prod, cliente, S1, S2, fiar, plazo, abonar, deuda, cuentaDe, foto, coherencia }
}

async function main() {
  const E = await negocio('a')
  const { O1, O2, Caj, Alm, Vend, dbOf, cliente, S1, S2, fiar, plazo, abonar, deuda, cuentaDe, foto, coherencia } = E

  console.log('\nA) Esquemas')
  const base = { customerId: 'c', method: 'YAPE', amount: 10, idempotencyKey: randomUUID() }
  check('>>> un abono nunca es CREDITO, ni cero, ni negativo, ni con 3 decimales; la clave es obligatoria y las cuentas elegidas no se repiten',
    !registrarAbonoSchema.safeParse({ ...base, method: 'CREDITO' }).success && !registrarAbonoSchema.safeParse({ ...base, amount: 0 }).success
    && !registrarAbonoSchema.safeParse({ ...base, amount: -5 }).success && !registrarAbonoSchema.safeParse({ ...base, amount: 1.005 }).success
    && !registrarAbonoSchema.safeParse({ ...base, idempotencyKey: undefined }).success && !registrarAbonoSchema.safeParse({ ...base, idempotencyKey: 'no-uuid' }).success
    && !registrarAbonoSchema.safeParse({ ...base, receivableIds: ['a', 'a'] }).success && registrarAbonoSchema.safeParse({ ...base, receivableIds: ['a', 'b'] }).success)
  check('anular exige motivo (3+ caracteres)', !anularAbonoSchema.safeParse({ paymentId: 'p', motivo: 'ab' }).success && !anularCuentaSchema.safeParse({ receivableId: 'r', motivo: '' }).success && !descartarRevisionSchema.safeParse({ receivableId: 'r', nota: ' ' }).success)

  console.log('\nB) Reparto: lo más antiguo primero')
  const caja1 = await openCashSession(dbOf(O1), O1, openCashSchema.parse({ openingAmount: 100 }))   // F6.8b: fiar y abonar exigen el turno propio
  const A = await cliente()
  await plazo(A.id, 60); const v1 = await fiar(S1, A.id, 300)    // creada primero, vence MÁS TARDE
  await plazo(A.id, 10); const v2 = await fiar(S1, A.id, 200)    // vence primero
  await plazo(A.id, 30); const v3 = await fiar(S1, A.id, 100)
  check('(preparación) deuda 600 en tres cuentas con vencimientos distintos', (await deuda(A.id)) === 600 && dia((await cuentaDe(v2.saleId)).dueDate) < dia((await cuentaDe(v3.saleId)).dueDate) && dia((await cuentaDe(v3.saleId)).dueDate) < dia((await cuentaDe(v1.saleId)).dueDate))
  const ab1 = await abonar(O1, A.id, 250)
  const [c1, c2, c3] = [await cuentaDe(v1.saleId), await cuentaDe(v2.saleId), await cuentaDe(v3.saleId)]
  check('>>> abono de 250: paga primero la que VENCE antes (200, queda PAGADA), luego la siguiente (50 de 100); la que vence más tarde no se toca (aunque se creó primero)',
    c2.status === 'PAGADA' && num(c2.paidAmount) === 200 && c2.closedAt !== null && c3.status === 'ABIERTA' && num(c3.paidAmount) === 50 && num(c1.paidAmount) === 0)
  check('>>> el resultado informa el reparto, qué cuentas quedaron pagadas y la deuda: 600 → 350', ab1.reparto.length === 2 && ab1.reparto[0]!.pagada && !ab1.reparto[1]!.pagada && ab1.reparto[1]!.saldoDespues === 50 && ab1.deudaAntes === 600 && ab1.deudaDespues === 350 && !ab1.replayed)
  check('la deuda del cliente en la base quedó en 350', (await deuda(A.id)) === 350)
  const pago1 = await prisma.customerPayment.findUniqueOrThrow({ where: { id: ab1.paymentId }, include: { allocations: true } })
  check('el abono y su reparto quedan registrados: Σ repartos = monto del abono', num(pago1.amount) === 250 && pago1.allocations.reduce((s, a) => s + num(a.amount), 0) === 250 && pago1.userId === E.owner.id && pago1.branchId === E.b1.branch.id)
  check('>>> auditado: quién cobró, a quién, el reparto y la deuda antes y después', !!(await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'credito.abono', entityId: ab1.paymentId } }))
    && ((await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'credito.abono', entityId: ab1.paymentId } }))?.after as { deudaDespues: number }).deudaDespues === 350)
  const ab2 = await abonar(O1, A.id, 350)
  check('>>> el abono que salda todo: todas PAGADA y la deuda en 0', ab2.deudaDespues === 0 && (await deuda(A.id)) === 0 && (await prisma.receivable.count({ where: { customerId: A.id, status: 'PAGADA' } })) === 3)
  check('sin deuda, un abono más → rechazado', await code(abonar(O1, A.id, 1)) === 'INVALID_DOCUMENT')

  console.log('\nC) Elegir a qué cuentas se aplica')
  const D = await cliente()
  const dA = await fiar(S1, D.id, 100), dB = await fiar(S1, D.id, 200), dC = await fiar(S1, D.id, 300)
  const idB = (await cuentaDe(dB.saleId)).id, idC = (await cuentaDe(dC.saleId)).id, idA = (await cuentaDe(dA.saleId)).id
  const ec = await abonar(O1, D.id, 250, { receivableIds: [idC, idB] })
  check('>>> eligiendo [C, B] con 250: se paga C (300) hasta 250 y NO se toca B ni A… y el orden elegido manda', num((await cuentaDe(dC.saleId)).paidAmount) === 250 && num((await cuentaDe(dB.saleId)).paidAmount) === 0 && ec.reparto.length === 1)
  check('>>> un abono que supera lo adeudado en las cuentas ELEGIDAS → rechazado (aunque el cliente deba más en otras)', await code(abonar(O1, D.id, 100, { receivableIds: [idC] })) === 'INVALID_DOCUMENT')
  const otro = await cliente(); const oV = await fiar(S1, otro.id, 100)
  check('>>> una cuenta de OTRO cliente → rechazada', await code(abonar(O1, D.id, 10, { receivableIds: [(await cuentaDe(oV.saleId)).id] })) === 'INVALID_DOCUMENT')
  check('una cuenta que no existe → rechazada', await code(abonar(O1, D.id, 10, { receivableIds: ['no-existe'] })) === 'INVALID_DOCUMENT')
  void idA
  check('>>> el abono mayor que TODA la deuda → rechazado, sin tocar nada', await (async () => { const a = await foto(); const c = await code(abonar(O1, D.id, 99999)); return c === 'INVALID_DOCUMENT' && JSON.stringify(a) === JSON.stringify(await foto()) })())

  console.log('\nD) Efectivo y caja')
  const F = await cliente(); const fV = await fiar(S1, F.id, 400)
  check('>>> F6.8b: un abono, en efectivo o por Yape, de quien NO tiene turno propio (la sucursal 2 aún no abrió) → CASH_REQUIRED con un mensaje claro', await code(abonar(O2, F.id, 50, { method: 'EFECTIVO' })) === 'CASH_REQUIRED' && await code(abonar(O2, F.id, 50)) === 'CASH_REQUIRED')
  const efe = await abonar(O1, F.id, 50, { method: 'EFECTIVO' })
  check('>>> con turno abierto, el efectivo se enlaza a ESE turno', (await prisma.customerPayment.findUniqueOrThrow({ where: { id: efe.paymentId } })).cashSessionId === caja1.id)
  const yape = await abonar(O1, F.id, 50)
  check('un abono por Yape con turno abierto también queda enlazado (para el reporte del turno)', (await prisma.customerPayment.findUniqueOrThrow({ where: { id: yape.paymentId } })).cashSessionId === caja1.id)
  check('y desde una sucursal SIN turno abierto el Yape ya NO se acepta sin turno: la deuda no se movió', (await deuda(F.id)) === 300)

  console.log('\nE) Permisos')
  const G = await cliente(); await fiar(S1, G.id, 200)
  await abrirTurno(E.t.id, Caj.userId, E.b1.branch.id)   // F6.8b: el cajero abona en SU turno
  const cajA = await abonar(Caj, G.id, 20)
  check('>>> el CAJERO registra abonos (credito.cobrar viene de fábrica)', cajA.monto === 20)
  check('>>> el ALMACENERO y el VENDEDOR no', await code(abonar(Alm, G.id, 10)) === 'FORBIDDEN_ROLE' && await code(abonar(Vend, G.id, 10)) === 'FORBIDDEN_ROLE')
  check('>>> el CAJERO NO anula abonos, ni da de baja cuentas, ni resuelve revisiones (credito.castigar es del dueño)',
    await code(anularAbono(dbOf(Caj), Caj, anularAbonoSchema.parse({ paymentId: cajA.paymentId, motivo: 'error' }))) === 'FORBIDDEN_ROLE'
    && await code(anularCuenta(dbOf(Caj), Caj, anularCuentaSchema.parse({ receivableId: 'x', motivo: 'error' }))) === 'FORBIDDEN_ROLE'
    && await code(descartarRevision(dbOf(Caj), Caj, descartarRevisionSchema.parse({ receivableId: 'x', nota: 'ok ok' }))) === 'FORBIDDEN_ROLE')

  console.log('\nF) Idempotencia: el mismo abono enviado dos veces no se cobra dos veces')
  const H = await cliente(); await fiar(S1, H.id, 500)
  const kH = randomUUID()
  const h1 = await abonar(O1, H.id, 100, { idempotencyKey: kH })
  const h2 = await abonar(O1, H.id, 100, { idempotencyKey: kH })
  check('>>> el reintento devuelve el MISMO abono con su reparto y avisa replayed; la deuda bajó una sola vez (500 → 400)', h2.replayed && h2.paymentId === h1.paymentId && h2.reparto.length === h1.reparto.length && (await deuda(H.id)) === 400 && (await prisma.customerPayment.count({ where: { customerId: H.id } })) === 1)
  const simult = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => abonar(i % 2 ? O1 : O2, H.id, 100, { idempotencyKey: kH })))
  check('>>> 6 envíos SIMULTÁNEOS de ese mismo abono: todos reciben el original y no se cobra de más', simult.every((r) => r.status === 'fulfilled' && r.value.paymentId === h1.paymentId) && (await deuda(H.id)) === 400 && (await prisma.customerPayment.count({ where: { customerId: H.id } })) === 1)
  const nuevo = randomUUID()
  const simult2 = await Promise.allSettled([1, 2, 3, 4].map(() => abonar(O1, H.id, 50, { idempotencyKey: nuevo })))
  check('>>> y con una clave NUEVA enviada 4 veces a la vez: se cobra una sola vez (400 → 350)', simult2.every((r) => r.status === 'fulfilled') && (await deuda(H.id)) === 350 && (await prisma.customerPayment.count({ where: { customerId: H.id } })) === 2)

  console.log('\nG) CONCURRENCIA: varios abonos y un fiado a la vez sobre la misma deuda')
  const caja2 = await openCashSession(dbOf(O2), O2, openCashSchema.parse({ openingAmount: 50 }))   // F6.8b: la sucursal 2 cobra con su propio turno
  const J = await cliente({ creditLimit: 5000 })
  await Promise.all([fiar(S1, J.id, 100), fiar(S1, J.id, 100), fiar(S1, J.id, 100)])
  const rs = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => abonar(i % 2 ? O1 : O2, J.id, 100)))
  const okA = rs.filter((r) => r.status === 'fulfilled'), koA = rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  check('>>> 6 abonos de 100 a la vez sobre una deuda de 300 (desde dos sucursales): exactamente 3 pasan', okA.length === 3, `${okA.length} pasaron / ${koA.length} rechazados`)
  check('>>> los otros 3 se rechazan por falta de deuda (no por un fallo raro) y la deuda queda en 0, nunca negativa', koA.length === 3 && koA.every((r) => (r.reason as { code?: string }).code === 'INVALID_DOCUMENT') && (await deuda(J.id)) === 0)
  const K = await cliente({ creditLimit: 500 })
  await Promise.all([fiar(S1, K.id, 100), fiar(S1, K.id, 100), fiar(S1, K.id, 100)])
  const mixto = await Promise.allSettled([fiar(S2, K.id, 200), abonar(O1, K.id, 300)])
  check('>>> un fiado de 200 y un abono de 300 a la vez (deuda 300, línea 500): CUALQUIER orden da deuda 200 y los dos pasan, sin interbloqueos', mixto.every((r) => r.status === 'fulfilled') && (await deuda(K.id)) === 200, JSON.stringify(mixto.map((r) => r.status)))

  console.log('\nH) Anular un abono')
  const L = await cliente(); const lV = await fiar(S1, L.id, 300)
  const lAb = await abonar(O1, L.id, 300)
  check('(preparación) la cuenta quedó PAGADA y la deuda en 0', (await cuentaDe(lV.saleId)).status === 'PAGADA' && (await deuda(L.id)) === 0)
  const sinMotivo = anularAbonoSchema.safeParse({ paymentId: lAb.paymentId, motivo: '' })
  check('anular sin motivo no pasa el esquema', !sinMotivo.success)
  const an = await anularAbono(dbOf(O1), O1, anularAbonoSchema.parse({ paymentId: lAb.paymentId, motivo: 'Yape que no llegó al banco' }))
  const lc = await cuentaDe(lV.saleId)
  check('>>> anular el abono REABRE la cuenta (PAGADA → ABIERTA, sin fecha de cierre, abonado 0) y devuelve la deuda: 0 → 300', lc.status === 'ABIERTA' && num(lc.paidAmount) === 0 && lc.closedAt === null && an.deudaDespues === 300 && (await deuda(L.id)) === 300)
  const pv = await prisma.customerPayment.findUniqueOrThrow({ where: { id: lAb.paymentId } })
  check('>>> el abono NO se borra: queda anulado con quién, cuándo y por qué', pv.voidedAt !== null && pv.voidedById === E.owner.id && pv.voidReason === 'Yape que no llegó al banco')
  check('anularlo otra vez → rechazado', await code(anularAbono(dbOf(O1), O1, anularAbonoSchema.parse({ paymentId: lAb.paymentId, motivo: 'otra vez' }))) === 'INVALID_DOCUMENT')
  check('un abono que no existe, o de otro negocio → no existe', await code(anularAbono(dbOf(O1), O1, anularAbonoSchema.parse({ paymentId: 'no-existe', motivo: 'xxx' }))) === 'TENANT_MISMATCH')
  const re = await abonar(O1, L.id, 300)
  check('y la cuenta se puede volver a cobrar', re.deudaDespues === 0 && (await cuentaDe(lV.saleId)).status === 'PAGADA')

  console.log('\nI) UN TURNO CERRADO ES INMUTABLE')
  const M = await cliente(); const mV = await fiar(S2, M.id, 200)
  const mAb = await abonar(O2, M.id, 80, { method: 'EFECTIVO' })
  const aun = await anularAbono(dbOf(O2), O2, anularAbonoSchema.parse({ paymentId: mAb.paymentId, motivo: 'Me equivoqué de cliente' }))
  check('>>> con el turno ABIERTO el abono en efectivo sí se anula (deuda 120 → 200)', aun.deudaDespues === 200)
  const mAb2 = await abonar(O2, M.id, 80, { method: 'EFECTIVO' })
  await closeCashSession(dbOf(O2), O2, closeCashSchema.parse({ sessionId: caja2.id, countedAmount: 130 }))
  const antes = await foto()
  const cerrado = await anularAbono(dbOf(O2), O2, anularAbonoSchema.parse({ paymentId: mAb2.paymentId, motivo: 'Ya cerré caja' })).then(() => null, (e) => e)
  check('>>> con el turno CERRADO y SIN caja abierta hoy no se anula: CASH_REQUIRED que dice que la compensación sale de TU caja abierta, y no se escribe nada', cerrado?.code === 'CASH_REQUIRED' && /tu caja/.test(cerrado.message) && JSON.stringify(antes) === JSON.stringify(await foto()))
  const caja3 = await openCashSession(dbOf(O2), O2, openCashSchema.parse({ openingAmount: 20 }))
  const okTarde = await anularAbono(dbOf(O2), O2, anularAbonoSchema.parse({ paymentId: mAb2.paymentId, motivo: 'Ya cerré caja' }))
  check('>>> con caja abierta SÍ se anula: la deuda vuelve (120 → 200) y el dinero sale de la caja de hoy como compensación', okTarde.deudaDespues === 200 && okTarde.compensacion?.cashSessionId === caja3.id && okTarde.compensacion.efectivo)
  await closeCashSession(dbOf(O2), O2, closeCashSchema.parse({ sessionId: caja3.id, countedAmount: 0 }))   // el resto de la prueba sigue sin caja abierta
  void mV

  console.log('\nJ) Dar de baja una cuenta (castigo)')
  const N = await cliente(); const nV = await fiar(S1, N.id, 200); const nV2 = await fiar(S1, N.id, 100)
  await abonar(O1, N.id, 50, { receivableIds: [(await cuentaDe(nV.saleId)).id] })
  const bj = await anularCuenta(dbOf(O1), O1, anularCuentaSchema.parse({ receivableId: (await cuentaDe(nV.saleId)).id, motivo: 'Deuda incobrable: el cliente se mudó' }))
  const nc = await cuentaDe(nV.saleId)
  check('>>> el castigo quita SOLO el saldo (150) de la deuda: 250 → 100; lo ya abonado (50) se conserva en el historial', bj.saldoCastigado === 150 && bj.deudaDespues === 100 && (await deuda(N.id)) === 100 && num(nc.paidAmount) === 50)
  check('>>> la cuenta queda ANULADA con fecha de baja, de cierre y motivo', nc.status === 'ANULADA' && nc.voidedAt !== null && nc.closedAt !== null && nc.voidReason === 'Deuda incobrable: el cliente se mudó')
  check('>>> auditado con el saldo castigado', ((await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'credito.cuenta_anulada', entityId: nc.id } }))?.after as { saldoCastigado: number })?.saldoCastigado === 150)
  check('dar de baja otra vez, o una cuenta ya PAGADA → rechazado', await code(anularCuenta(dbOf(O1), O1, anularCuentaSchema.parse({ receivableId: nc.id, motivo: 'otra vez' }))) === 'INVALID_DOCUMENT'
    && await code(anularCuenta(dbOf(O1), O1, anularCuentaSchema.parse({ receivableId: (await cuentaDe(lV.saleId)).id, motivo: 'pagada ya' }))) === 'INVALID_DOCUMENT')
  check('>>> a una cuenta dada de baja ya no se le puede aplicar un abono', await code(abonar(O1, N.id, 100, { receivableIds: [nc.id] })) === 'INVALID_DOCUMENT')
  check('el cliente castigado puede seguir pagando la que sí debe', (await abonar(O1, N.id, 100)).deudaDespues === 0)
  void nV2
  const abAnulada = await anularAbono(dbOf(O1), O1, anularAbonoSchema.parse({ paymentId: (await prisma.customerPayment.findFirstOrThrow({ where: { customerId: N.id }, orderBy: { createdAt: 'asc' } })).id, motivo: 'Probar abono de cuenta castigada' }))
  check('>>> anular un abono cuyo reparto cayó en una cuenta YA dada de baja le devuelve lo abonado a esa cuenta pero NO reabre la deuda (el saldo del cliente no sube)', abAnulada.deudaDespues === 0 && (await deuda(N.id)) === 0 && (await cuentaDe(nV.saleId)).status === 'ANULADA' && num((await cuentaDe(nV.saleId)).paidAmount) === 0)

  console.log('\nK) Cliente dado de baja')
  const P = await cliente(); await fiar(S1, P.id, 100)
  const pAb = await abonar(O1, P.id, 100)
  await prisma.customer.update({ where: { id: P.id }, data: { deletedAt: new Date() } })
  check('>>> no se puede anular un abono si el cliente ya está de baja (reabrir su deuda es imposible): mensaje claro, no un error de la base', await code(anularAbono(dbOf(O1), O1, anularAbonoSchema.parse({ paymentId: pAb.paymentId, motivo: 'cliente dado de baja' }))) === 'CREDIT_BLOCKED')

  console.log('\nL) Factura a crédito')
  const Q = await cliente(); const qV = await fiar(S1, Q.id, 100)
  const f = await issueTaxDocument(dbOf(O1), O1, { saleId: qV.saleId, documentType: 'FACTURA' } as never).then(() => null, (e) => e)
  check('>>> emitir FACTURA de una venta fiada → rechazado con mensaje claro', f?.code === 'INVALID_DOCUMENT' && /se fió/.test(f.message) && (await prisma.taxDocument.count({ where: { saleId: qV.saleId } })) === 0)
  const bol = await issueTaxDocument(dbOf(O1), O1, { saleId: qV.saleId, documentType: 'BOLETA' } as never).then((d) => d, (e) => e)
  check('>>> y la BOLETA de esa misma venta SÍ se emite (solo la factura está vedada)', !(bol instanceof Error) && (bol as { documentType?: string }).documentType === 'BOLETA', bol instanceof Error ? bol.message : '')
  const conRuc = await cliente({ docType: 'RUC', docNumber: completarRuc('2055555555'), name: 'EMPRESA SAC', address: 'Jr. Cliente 1' })
  const normal = await registerSale(dbOf(O1), O1, { warehouseId: E.b1.warehouse.id, customerId: conRuc.id, items: [{ productId: E.prod.id, quantity: 1, discount: 0 }], payments: [{ method: 'EFECTIVO', amount: 100 }], documentType: 'NOTA_VENTA', allowNegativeStock: false } as never)
  const fn = await issueTaxDocument(dbOf(O1), O1, { saleId: normal.saleId, documentType: 'FACTURA' } as never).then(() => null, (e) => e as Error)
  check('>>> una venta que NO se fió no recibe ese bloqueo: la factura se emite (o, si faltara otro requisito fiscal, falla por ESE motivo, nunca por «se fió»)', fn === null || !/se fió/.test(fn.message), fn?.message ?? 'emitida')

  console.log('\nM) Nota de crédito sobre una venta fiada → pendiente de revisión')
  const R = await negocio('real', { real: true })
  const rc = await R.cliente()
  const rV = await R.fiar(R.S1, rc.id, 300)
  const rP = await R.fiar(R.S1, rc.id, 200)
  await R.abonar(R.O1, rc.id, 200, { receivableIds: [(await R.cuentaDe(rP.saleId)).id] })          // esta queda PAGADA
  const orig = async (saleId: string) => prisma.taxDocument.create({ data: {
    tenantId: R.t.id, saleId, documentType: 'BOLETA', series: 'B001', correlativo: Math.floor(Math.random() * 1e6), fullNumber: `B001-${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    status: 'ACEPTADO', isTrial: false, externalId: `ext-${randomUUID().slice(0, 8)}`, receiverDocType: 'DNI', receiverDocNumber: '41300000', receiverName: 'CLIENTE', receiverAddress: '-',
    issuerTaxId: R.taxId, issuerLegalName: 'ABONOS REAL SAC', subtotal: 100, taxTotal: 18, discountTotal: 0, total: 118,
  } })
  await orig(rV.saleId); await orig(rP.saleId)
  const deudaAntes = await R.deuda(rc.id)
  const nc1 = await emitirNotaCreditoTotal(R.dbOf(R.O1), R.O1, { saleId: rV.saleId, reasonCode: '01', reasonDescription: 'Anulación de la operación' })
  const cr = await R.cuentaDe(rV.saleId)
  check('>>> la nota de crédito marca la cuenta fiada como PENDIENTE DE REVISIÓN con el número de la nota y su sustento', cr.reviewRequestedAt !== null && !!cr.reviewReason?.includes(nc1.fullNumber) && !!cr.reviewReason?.includes('Anulación de la operación'))
  check('>>> y NO toca la deuda ni la cuenta: sigue ABIERTA y el cliente debe lo mismo (decide el dueño)', cr.status === 'ABIERTA' && (await R.deuda(rc.id)) === deudaAntes)
  check('queda auditado', !!(await prisma.auditLog.findFirst({ where: { tenantId: R.t.id, action: 'credito.revision_marcada', entityId: cr.id } })))
  await emitirNotaCreditoTotal(R.dbOf(R.O1), R.O1, { saleId: rP.saleId, reasonCode: '01', reasonDescription: 'Devolución total' })
  check('>>> una cuenta ya PAGADA también se marca (el reembolso, si procede, es manual)', (await R.cuentaDe(rP.saleId)).reviewRequestedAt !== null && (await R.cuentaDe(rP.saleId)).status === 'PAGADA')
  const mant = await descartarRevision(R.dbOf(R.O1), R.O1, descartarRevisionSchema.parse({ receivableId: (await R.cuentaDe(rP.saleId)).id, nota: 'El cliente ya había pagado: se mantiene' }))
  check('>>> el dueño puede MANTENER la deuda: quita la marca y deja la nota en la auditoría', (await R.cuentaDe(rP.saleId)).reviewRequestedAt === null && (await prisma.auditLog.findFirst({ where: { tenantId: R.t.id, action: 'credito.revision_descartada', entityId: mant.receivableId } }))?.reason === 'El cliente ya había pagado: se mantiene')
  check('descartar una cuenta que no está marcada → rechazado', await code(descartarRevision(R.dbOf(R.O1), R.O1, descartarRevisionSchema.parse({ receivableId: (await R.cuentaDe(rP.saleId)).id, nota: 'otra vez' }))) === 'INVALID_DOCUMENT')
  await anularCuenta(R.dbOf(R.O1), R.O1, anularCuentaSchema.parse({ receivableId: cr.id, motivo: 'Nota de crédito aceptada: se perdona la deuda' }))
  check('>>> o dar de baja la deuda: la deuda del cliente baja en el saldo de esa cuenta (300)', (await R.deuda(rc.id)) === deudaAntes - 300 && (await R.cuentaDe(rV.saleId)).status === 'ANULADA')
  const vSin = await registerSale(R.dbOf(R.O1), R.O1, { warehouseId: R.b1.warehouse.id, customerId: null, items: [{ productId: R.prod.id, quantity: 1, discount: 0 }], payments: [{ method: 'EFECTIVO', amount: 100 }], documentType: 'NOTA_VENTA', allowNegativeStock: false } as never)
  await orig(vSin.saleId)
  check('una nota de crédito sobre una venta que NO se fió funciona igual que siempre (sin marca ni error)', !(await emitirNotaCreditoTotal(R.dbOf(R.O1), R.O1, { saleId: vSin.saleId, reasonCode: '01', reasonDescription: 'Anulación de la operación' }).then(() => null, (e) => e)))
  check('la coherencia del segundo negocio se mantiene', (await R.coherencia()) === 0)

  console.log('\nN) Coherencia global')
  check('>>> en TODO el negocio de pruebas: la deuda de cada cliente = Σ (monto − abonado) de sus cuentas abiertas', (await coherencia()) === 0)
  const todas = await prisma.receivable.findMany({ where: { tenantId: E.t.id } })
  const pagosVivos = await prisma.paymentAllocation.findMany({ where: { tenantId: E.t.id, customerPayment: { voidedAt: null } } })
  const porCuenta = new Map<string, number>(); for (const a of pagosVivos) porCuenta.set(a.receivableId, (porCuenta.get(a.receivableId) ?? 0) + num(a.amount))
  check('>>> lo abonado de cada cuenta = Σ de los repartos de abonos NO anulados', todas.every((r) => Math.abs(num(r.paidAmount) - (porCuenta.get(r.id) ?? 0)) < 1e-9))
  const abonosVivos = await prisma.customerPayment.findMany({ where: { tenantId: E.t.id, voidedAt: null }, include: { allocations: true } })
  check('>>> cada abono vigente reparte EXACTAMENTE su monto (Σ repartos = monto)', abonosVivos.every((p) => Math.abs(p.allocations.reduce((s, a) => s + num(a.amount), 0) - num(p.amount)) < 1e-9))

  console.log('\nO) Estructura')
  const svc = readFileSync('src/features/credito/credito-service.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const cuerpoDe = (fn: string) => {
    const i = svc.indexOf(`export async function ${fn}`)
    const j = svc.indexOf('\nexport ', i + 10)
    return j > 0 ? svc.slice(i, j) : svc.slice(i)
  }
  check('>>> abonar, anular abono y dar de baja una cuenta (el núcleo de anularCuenta, que también usa la devolución de una venta) BLOQUEAN al cliente antes de leer o escribir cuentas, y anularCuenta delega en el núcleo', cuerpoDe('anularCuenta').includes('darDeBajaCuentaEn(') && ['registrarAbono', 'anularAbono', 'darDeBajaCuentaEn'].every((fn) => { const c = cuerpoDe(fn); return c.indexOf('bloquearCliente(') > 0 && c.indexOf('bloquearCliente(') < c.indexOf('receivable.update') }))
  check('el servicio sigue sin SQL crudo', !/\$queryRaw|\$executeRaw/.test(svc))
  const inv = readFileSync('src/features/invoicing/service.ts', 'utf8')
  check('>>> la marca por nota de crédito corre DENTRO de la transacción de la nota (nacen juntas o no nacen)', /claimNextNumber\(t[\s\S]{0,2500}marcarRevisionPorNota\(t, ctx,[\s\S]{0,1200}return \{\s*id: nota\.id/.test(inv))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
