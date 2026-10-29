import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { anularAbono, registrarAbono } from '../src/features/credito/credito-service'
import { anularAbonoSchema, registrarAbonoSchema } from '../src/features/credito/schemas'
import { auditarCoherenciaCredito } from '../src/features/credito/auditoria'
import { closeCashSession, openCashSession, totalesDelTurno, currentCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { anularMovimientoCaja } from '../src/features/branches/cash-movement-service'
import { anularMovimientoCajaSchema, registrarMovimientoCajaSchema } from '../src/features/branches/cash-movement-schemas'
import { anularOdevolverVenta } from '../src/features/devoluciones/service'
import { anularOdevolverVentaSchema, devolverProductosSchema } from '../src/features/devoluciones/schemas'
import { devolverProductosVenta } from '../src/features/devoluciones/parcial-service'
import { permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'
import { PERMISOS } from '../src/lib/permisos'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.3b · Anular un abono de un turno YA CERRADO, con su compensación en la caja abierta de hoy. Lo que más importa: el turno cerrado no cambia NADA,
 * el dinero sale de donde corresponde (cajón si fue efectivo; solo registro si fue otro medio), solo `credito.castigar` puede, no hay compensación sin
 * caja abierta, `auditar-credito` reconoce el abono anulado después del cierre, y las devoluciones que esto destraba se completan.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const err = (p: Promise<unknown>) => p.then(() => null).catch((e) => e as { code?: string; message: string })
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 400) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-cc3-${tag}-${randomUUID().slice(0, 6)}`, name: `Compensación ${tag}`, taxId: ruc(), planId: plan.id, realBillingEnabledAt: new Date('2026-01-01T00:00:00Z') } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cc3' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ADMIN', 'CAJERO', 'CONTADOR', 'VENDEDOR'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    for (const b of [b1, b2]) await asignarSucursal(t.id, x.id, b.branch.id)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: [] }
  }
  const O = u.OWNER!
  const db = (c: TenantContext) => getTenantPrisma(c)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Cemento', unitType: 'UNIDAD', salePrice: 100, costPrice: 60 } })
  for (const w of [b1.warehouse, b2.warehouse]) await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: w.id, quantity: 1000 } })
  let dni = 52200000
  const cliente = () => prisma.customer.create({ data: { tenantId: t.id, name: `Cliente ${dni}`, docType: 'DNI', docNumber: String(dni++), creditLimit: 9000 } })
  const fiar = (monto: number, customerId: string) => registerSale(db(O), O, registerSaleSchema0(b1.warehouse.id, prod.id, monto, customerId))
  const abonar = (customerId: string, amount: number, method = 'EFECTIVO', ctx: TenantContext = O) => registrarAbono(db(ctx), ctx, registrarAbonoSchema.parse({ customerId, method, amount, idempotencyKey: randomUUID() }))
  const abrir = (fondo: number, ctx: TenantContext = O) => openCashSession(db(ctx), ctx, openCashSchema.parse({ openingAmount: fondo }))
  const cerrar = (id: string, contado = 0) => closeCashSession(db(O), O, closeCashSchema.parse({ sessionId: id, countedAmount: contado }))
  const anular = (paymentId: string, ctx: TenantContext = O, motivo = 'El cliente pagó dos veces') => anularAbono(db(ctx), ctx, anularAbonoSchema.parse({ paymentId, motivo }))
  const sesion = (id: string) => prisma.cashSession.findUniqueOrThrow({ where: { id } })
  const deuda = async (id: string) => num((await prisma.customer.findUniqueOrThrow({ where: { id } })).creditBalance)
  return { t, b1, b2, u, O, db, prod, cliente, fiar, abonar, abrir, cerrar, anular, sesion, deuda }
}
const registerSaleSchema0 = (warehouseId: string, productId: string, monto: number, customerId: string) =>
  ({ warehouseId, customerId, items: [{ productId, quantity: monto / 100, discount: 0 }], payments: [{ method: 'CREDITO', amount: monto }], documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() }) as never

async function cuerpo() {
  console.log('\nA) Preparación: abonos en un turno que luego se cierra')
  const E = await negocio('a')
  const { O, db } = E
  const C1 = await E.cliente()
  await E.fiar(500, C1.id)
  const T1 = await E.abrir(100)
  const efe = await E.abonar(C1.id, 120, 'EFECTIVO'), yape = await E.abonar(C1.id, 80, 'YAPE')
  await E.cerrar(T1.id, 220)
  const congelado = JSON.stringify(await E.sesion(T1.id))
  check('(preparación) deuda 300, turno 1 cerrado con 120 en efectivo y 80 por Yape congelados', (await E.deuda(C1.id)) === 300 && num((await E.sesion(T1.id)).cashReceiptsTotal) === 120 && num((await E.sesion(T1.id)).otherReceiptsTotal) === 80)
  const antes = async () => ({ deuda: await E.deuda(C1.id), abonos: await prisma.customerPayment.count({ where: { tenantId: E.t.id, voidedAt: null } }), movs: await prisma.cashMovement.count({ where: { tenantId: E.t.id } }), turno: JSON.stringify(await E.sesion(T1.id)) })
  const f0 = await antes()

  console.log('\nB) Quién puede: solo `credito.castigar`, con motivo')
  const pin: TenantContext = { ...O, operadorDe: O.userId, permisosDenegados: permisosDenegadosAlOperador(new Set(PERMISOS)) }
  for (const [n, c] of [['CAJERO', E.u.CAJERO!], ['CONTADOR', E.u.CONTADOR!], ['VENDEDOR', E.u.VENDEDOR!], ['OWNER con PIN de operador', pin]] as const) {
    check(`>>> ${n}: NO puede anular un abono de un turno cerrado (FORBIDDEN_ROLE) y no cambia nada`, (await code(E.anular(efe.paymentId, c))) === 'FORBIDDEN_ROLE' && JSON.stringify(await antes()) === JSON.stringify(f0))
  }
  check('>>> sin motivo (o de 2 letras) el esquema lo rechaza antes de tocar nada', !anularAbonoSchema.safeParse({ paymentId: efe.paymentId, motivo: '' }).success && !anularAbonoSchema.safeParse({ paymentId: efe.paymentId, motivo: 'ab' }).success)
  check('>>> cuenta en SOLO LECTURA: no escribe', (await code(E.anular(efe.paymentId, { ...O, access: 'READ_ONLY' } as TenantContext))) !== null && JSON.stringify(await antes()) === JSON.stringify(f0))

  console.log('\nC) Sin caja abierta en la sucursal del abono no hay compensación posible')
  const eSin = await err(E.anular(efe.paymentId))
  check('>>> sin ninguna caja abierta: CASH_REQUIRED, con el mensaje que dice qué hacer, y no se anula NADA (el abono, la deuda y el turno quedan igual)', eSin?.code === 'CASH_REQUIRED' && /Abre la caja/.test(eSin.message) && JSON.stringify(await antes()) === JSON.stringify(f0))
  const T2b = await E.abrir(50, { ...O, branchId: E.b2.branch.id })
  check('>>> una caja abierta en OTRA sucursal no sirve, ni siquiera anulando desde ahí: la compensación va en la sucursal DEL ABONO', (await code(E.anular(efe.paymentId))) === 'CASH_REQUIRED' && (await code(E.anular(efe.paymentId, { ...O, branchId: E.b2.branch.id }))) === 'CASH_REQUIRED' && JSON.stringify(await antes()) === JSON.stringify(f0))
  await E.cerrar(T2b.id, 50)

  console.log('\nD) Abono en EFECTIVO: sale del cajón de hoy')
  const T2 = await E.abrir(300)
  const esperado0 = (await currentCashSession(db(O), O))!.expectedAmount
  const r = await E.anular(efe.paymentId)
  const mov = await prisma.cashMovement.findFirstOrThrow({ where: { relatedPaymentId: efe.paymentId } })
  check('>>> el abono queda anulado (con quién, cuándo y por qué) y la deuda vuelve (300 → 420)', (await E.deuda(C1.id)) === 420 && r.deudaDespues === 420 && (await prisma.customerPayment.findUniqueOrThrow({ where: { id: efe.paymentId } })).voidReason === 'El cliente pagó dos veces')
  check('>>> nace UN egreso `COMPENSACION_ABONO` de 120.00 en el turno de HOY, en efectivo, ligado al abono y al turno cerrado, hecho por quien anuló', mov.kind === 'EGRESO' && mov.category === 'COMPENSACION_ABONO' && mov.method === 'EFECTIVO' && num(mov.amount) === 120 && mov.cashSessionId === T2.id && mov.relatedSessionId === T1.id && mov.userId === O.userId && !mov.exceededExpected && r.compensacion?.movementId === mov.id && r.compensacion.efectivo)
  check('>>> el cajón de hoy esperaba 300 y ahora 300 − 120 = 180 (el efectivo salió)', esperado0 === 300 && (await currentCashSession(db(O), O))!.expectedAmount === 180)
  check('>>> el turno CERRADO no cambió NADA: ni una columna ni su marca de modificación', JSON.stringify(await E.sesion(T1.id)) === congelado)
  const a1 = await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'credito.abono_anulado', entityId: efe.paymentId } })
  const a2 = await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'caja.movimiento', entityId: mov.id } })
  check('>>> la auditoría deja la anulación del abono (con su compensación y el turno cerrado) y el movimiento de caja (con `credito.castigar` como permiso)', !!a1 && JSON.stringify(a1.after).includes(mov.id) && JSON.stringify(a1.after).includes('"salioDelCajon":true') && !!a2 && JSON.stringify(a2.after).includes('"permiso":"credito.castigar"') && a2.reason === 'El cliente pagó dos veces')

  console.log('\nE) Abono por YAPE: se registra pero no mueve el efectivo')
  const rY = await E.anular(yape.paymentId, E.u.ADMIN!, 'Yape duplicado')
  const movY = await prisma.cashMovement.findFirstOrThrow({ where: { relatedPaymentId: yape.paymentId } })
  check('>>> compensación con SU medio (YAPE), 80.00, en el turno de hoy; no cuenta como efectivo', movY.method === 'YAPE' && num(movY.amount) === 80 && movY.category === 'COMPENSACION_ABONO' && !rY.compensacion!.efectivo && movY.userId === E.u.ADMIN!.userId)
  const tot = await totalesDelTurno(db(O), T2.id)
  check('>>> el turno de hoy suma SOLO los 120 en efectivo como egreso manual; el efectivo esperado sigue en 180', tot.manualOutTotal === 120 && tot.manualInTotal === 0 && (await currentCashSession(db(O), O))!.expectedAmount === 180)
  check('>>> la deuda vuelve también por el Yape (420 → 500) y el turno cerrado sigue intacto', (await E.deuda(C1.id)) === 500 && JSON.stringify(await E.sesion(T1.id)) === congelado)

  console.log('\nF) Efectivo esperado insuficiente: se marca, NO se bloquea')
  const C2 = await E.cliente(); await E.fiar(400, C2.id)
  // Otro turno de la sucursal 2 con poco efectivo y otra anulación de un abono de turno cerrado de esa sucursal.
  // F6.8: una persona tiene como mucho UN turno abierto en toda la cuenta; la caja de la sucursal 2 es de otra persona.
  const dueno2 = await prisma.user.create({ data: { tenantId: E.t.id, email: `dueno2-${randomUUID()}@x.com`.toLowerCase(), name: 'Dueño 2', role: 'OWNER' } })
  for (const b of [E.b1, E.b2]) await asignarSucursal(E.t.id, dueno2.id, b.branch.id)
  const O2: TenantContext = { ...O, userId: dueno2.id, branchId: E.b2.branch.id }
  const Tb = await E.abrir(0, O2)
  const abB = await registrarAbono(db(O2), O2, registrarAbonoSchema.parse({ customerId: C2.id, method: 'EFECTIVO', amount: 90, idempotencyKey: randomUUID() }))
  await closeCashSession(db(O2), O2, closeCashSchema.parse({ sessionId: Tb.id, countedAmount: 90 }))
  const Tb2 = await E.abrir(10, O2)
  const rB = await anularAbono(db(O2), O2, anularAbonoSchema.parse({ paymentId: abB.paymentId, motivo: 'Abono mal cobrado' }))
  const movB = await prisma.cashMovement.findFirstOrThrow({ where: { relatedPaymentId: abB.paymentId } })
  check('>>> compensar 90 con solo 10 en el cajón NO bloquea la anulación: queda marcado `exceededExpected` y el esperado en −80', !!rB.compensacion && movB.exceededExpected && (await currentCashSession(db(O2), O2))!.expectedAmount === -80)
  check('>>> y la auditoría lo deja dicho', JSON.stringify((await prisma.auditLog.findFirstOrThrow({ where: { tenantId: E.t.id, action: 'caja.movimiento', entityId: movB.id } })).after).includes('"superoElEfectivoEsperado":true'))

  console.log('\nG) Un abono de un turno ABIERTO sigue anulándose sin compensación')
  const C3 = await E.cliente(); await E.fiar(200, C3.id)
  const abA = await E.abonar(C3.id, 50, 'EFECTIVO')
  const rA = await E.anular(abA.paymentId)
  check('>>> mismo turno abierto: se anula como siempre, sin movimiento de compensación (el abono anulado deja de contar en el turno)', rA.compensacion === null && (await prisma.cashMovement.count({ where: { relatedPaymentId: abA.paymentId } })) === 0)

  console.log('\nH) La compensación es del sistema: no se registra ni se anula a mano, y solo hay una por abono')
  check('>>> el esquema de registro NO admite la categoría `COMPENSACION_ABONO`', !registrarMovimientoCajaSchema.safeParse({ kind: 'EGRESO', category: 'COMPENSACION_ABONO', amount: 10, description: 'Intento manual', idempotencyKey: randomUUID() }).success)
  const eAn = await err(anularMovimientoCaja(db(O), O, anularMovimientoCajaSchema.parse({ movementId: mov.id, reason: 'Quiero deshacerla' })))
  check('>>> anular la compensación a mano se rechaza (el abono ya está anulado y el dinero salió)', eAn?.code === 'INVALID_DOCUMENT' && /no se anula a mano/.test(eAn.message) && (await prisma.cashMovement.findUniqueOrThrow({ where: { id: mov.id } })).voidedAt === null)
  check('>>> la base impide una SEGUNDA compensación del mismo abono', (await prisma.cashMovement.create({ data: { tenantId: E.t.id, branchId: E.b1.branch.id, cashSessionId: T2.id, kind: 'EGRESO', category: 'COMPENSACION_ABONO', method: 'EFECTIVO', amount: 120, description: 'Duplicada', relatedSessionId: T1.id, relatedPaymentId: efe.paymentId, userId: O.userId, idempotencyKey: randomUUID() } }).then(() => false, () => true)))
  check('>>> y rechaza una compensación sin abono, o un movimiento común con medio distinto del efectivo', (await prisma.cashMovement.create({ data: { tenantId: E.t.id, branchId: E.b1.branch.id, cashSessionId: T2.id, kind: 'EGRESO', category: 'COMPENSACION_ABONO', amount: 5, description: 'Sin abono', userId: O.userId, idempotencyKey: randomUUID() } }).then(() => false, () => true)) && (await prisma.cashMovement.create({ data: { tenantId: E.t.id, branchId: E.b1.branch.id, cashSessionId: T2.id, kind: 'EGRESO', category: 'OTRO', method: 'YAPE', amount: 5, description: 'Yape a mano', userId: O.userId, idempotencyKey: randomUUID() } }).then(() => false, () => true)))
  const f1 = await anularAbonoOtraVez(E, efe.paymentId)
  check('>>> anular el mismo abono otra vez se rechaza (ya está anulado) y no crea otra compensación', f1 === 'INVALID_DOCUMENT' && (await prisma.cashMovement.count({ where: { relatedPaymentId: efe.paymentId } })) === 1)

  console.log('\nI) El cierre del turno de hoy congela la compensación en efectivo (y solo esa)')
  const cierre = await E.cerrar(T2.id, 0)
  const cerrado = await E.sesion(T2.id)
  check('>>> congela 120.00 de egresos manuales (el Yape no cuenta) y su esperado incluye la compensación: 300 − 120 = 180', num(cerrado.manualOutTotal) === 120 && cierre.expectedAmount === 180 && num(cerrado.expectedAmount) === 180)
  check('>>> y lo congelado = lo que el turno recalcula', (await totalesDelTurno(db(O), T2.id)).manualOutTotal === 120)

  console.log('\nJ) auditar-credito reconoce el abono anulado después del cierre')
  await E.cerrar(Tb2.id, 0).catch(() => undefined)
  const informe = await auditarCoherenciaCredito(db(O))
  check('>>> sin falsos errores: el turno 1 cerrado conserva sus abonos congelados (120 + 80) aunque estén anulados, y todos tienen su compensación', informe.hallazgos.filter((h) => h.gravedad === 'ERROR').length === 0, JSON.stringify(informe.hallazgos.slice(0, 3)))
  await prisma.cashMovement.deleteMany({ where: { relatedPaymentId: yape.paymentId } })
  const informe2 = await auditarCoherenciaCredito(db(O))
  check('>>> si falta la compensación de un abono anulado tras el cierre → ERROR `ABONO_CERRADO_SIN_COMPENSACION` (y solo ese)', informe2.hallazgos.some((h) => h.codigo === 'ABONO_CERRADO_SIN_COMPENSACION' && h.id === yape.paymentId) && informe2.hallazgos.filter((h) => h.gravedad === 'ERROR').every((h) => h.codigo === 'ABONO_CERRADO_SIN_COMPENSACION'))
  await prisma.cashMovement.create({ data: { tenantId: E.t.id, branchId: E.b1.branch.id, cashSessionId: T2.id, kind: 'EGRESO', category: 'COMPENSACION_ABONO', method: 'YAPE', amount: 80, description: 'Restituida por la prueba', relatedSessionId: T1.id, relatedPaymentId: yape.paymentId, userId: O.userId, idempotencyKey: randomUUID() } })

  // Una compensación ANULADA (por la base: el servicio no lo permite) es como si no existiera.
  await prisma.cashMovement.updateMany({ where: { relatedPaymentId: yape.paymentId }, data: { voidedAt: new Date(), voidedById: O.userId, voidReason: 'Anulada a mano en la base' } })
  check('>>> una compensación anulada ya no cuenta como respaldo: `ABONO_CERRADO_SIN_COMPENSACION`', (await auditarCoherenciaCredito(db(O))).hallazgos.some((h) => h.codigo === 'ABONO_CERRADO_SIN_COMPENSACION' && h.id === yape.paymentId))
  await prisma.cashMovement.updateMany({ where: { relatedPaymentId: yape.paymentId }, data: { voidedAt: null, voidedById: null, voidReason: null } })

  console.log('\nK) Las devoluciones bloqueadas por abonos quedan destrabadas')
  const K = await negocio('k')
  const cliente = await K.cliente()
  const venta = await K.fiar(300, cliente.id)
  const TK1 = await K.abrir(0)
  const abK = await K.abonar(cliente.id, 100, 'EFECTIVO')
  await K.cerrar(TK1.id, 100)
  const itemK = await prisma.saleItem.findFirstOrThrow({ where: { saleId: venta.saleId } })
  const devTotal = () => anularOdevolverVenta(K.db(K.O), K.O, anularOdevolverVentaSchema.parse({ saleId: venta.saleId, kind: 'DEVOLUCION', reason: 'Devolución completa', idempotencyKey: randomUUID() }))
  const bloqueada = await err(devTotal())
  check('>>> devolver la venta fiada con un abono de un turno cerrado: CREDIT_HAS_PAYMENTS, y el mensaje explica cómo seguir', bloqueada?.code === 'CREDIT_HAS_PAYMENTS' && /compensación/.test(bloqueada.message) && /caja abierta/.test(bloqueada.message))
  const parcialBloq = await err(devolverProductosVenta(K.db(K.O), K.O, devolverProductosSchema.parse({ saleId: venta.saleId, reason: 'Devuelve todo', lines: [{ saleItemId: itemK.id, quantity: 3 }], idempotencyKey: randomUUID() })))
  check('>>> y la devolución parcial que excede el saldo, también: con el tope exacto (200.00) y el camino para seguir', parcialBloq?.code === 'CREDIT_HAS_PAYMENTS' && /200\.00/.test(parcialBloq.message) && /anula primero ese abono/.test(parcialBloq.message))
  await K.abrir(0)
  await K.anular(abK.paymentId, K.O, 'Se devolverá la venta')
  const ok = await devTotal()
  check('>>> anulado el abono (con su compensación), la MISMA devolución total prospera: cuenta cancelada y deuda 0', ok.status === 'DEVUELTA' && (await K.deuda(cliente.id)) === 0 && ok.receivableVoidedAmount === 300)
  const K2 = await negocio('k2')
  const cli2 = await K2.cliente(); const v2 = await K2.fiar(300, cli2.id)
  const Tk = await K2.abrir(0); const ab2 = await K2.abonar(cli2.id, 100, 'EFECTIVO'); await K2.cerrar(Tk.id, 100)
  await K2.abrir(0); await K2.anular(ab2.paymentId, K2.O, 'Para devolver')
  const i2 = await prisma.saleItem.findFirstOrThrow({ where: { saleId: v2.saleId } })
  const parcialOk = await devolverProductosVenta(K2.db(K2.O), K2.O, devolverProductosSchema.parse({ saleId: v2.saleId, reason: 'Devuelve todo', lines: [{ saleItemId: i2.id, quantity: 3 }], idempotencyKey: randomUUID() }))
  check('>>> y la parcial que completa la venta también prospera tras anular el abono (deuda 300 reducida a 0)', parcialOk.status === 'DEVUELTA' && parcialOk.receivableReducedAmount === 300 && (await K2.deuda(cli2.id)) === 0)
  check('>>> `auditar-credito` queda sin errores tras todo ese camino', (await auditarCoherenciaCredito(K.db(K.O))).hallazgos.filter((h) => h.gravedad === 'ERROR').length === 0 && (await auditarCoherenciaCredito(K2.db(K2.O))).hallazgos.filter((h) => h.gravedad === 'ERROR').length === 0)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

async function anularAbonoOtraVez(E: Awaited<ReturnType<typeof negocio>>, paymentId: string) { return code(E.anular(paymentId)) }

correr(main)
