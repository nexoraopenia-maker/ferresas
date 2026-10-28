import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { anularAbono, anularCuenta, configurarCredito, registrarAbono } from '../src/features/credito/credito-service'
import { anularAbonoSchema, anularCuentaSchema, configurarCreditoSchema, registrarAbonoSchema } from '../src/features/credito/schemas'
import { closeCashSession, currentCashSession, efectivoEsperado, openCashSession, totalesDelTurno } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { rendimientoDeCaja } from '../src/features/dashboard/service'
import { getDocumentoImprimible } from '../src/features/printing/queries'
import { TicketTermico } from '../src/features/printing/components/TicketTermico'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 3, subpaso 3.4: el cierre de caja y los reportes con el crédito.
 * Lo que más importa: el fiado NO entra al cajón, el abono en efectivo SÍ, el abono anulado no cuenta, nada se cuela en un turno
 * que ya se está cerrando, y lo congelado al cerrar no se mueve.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: { slug: `cc-${tag}-${randomUUID().slice(0, 6)}`, name: `CajaCred ${tag}`, legalName: `CAJACRED ${tag.toUpperCase()} SAC`, taxId, planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cc' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const mk = async (role: Role) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, u.id, b1.branch.id)
    return u
  }
  const owner = await mk('OWNER')
  const O: TenantContext = { tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  const db = getTenantPrisma(O)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Producto', salePrice: 100 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: b1.warehouse.id, quantity: 10000 } })
  let dni = 41400000
  const cliente = (over: Record<string, unknown> = {}) => prisma.customer.create({ data: { tenantId: t.id, name: `Cliente ${dni}`, docType: 'DNI', docNumber: String(dni++), creditLimit: 5000, ...over } })
  const vender = (monto: number, payments: { method: string; amount: number }[], customerId?: string) =>
    registerSale(db, O, { warehouseId: b1.warehouse.id, ...(customerId ? { customerId } : {}), items: [{ productId: prod.id, quantity: monto / 100, discount: 0 }], payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() } as never)
  const abonar = (customerId: string, amount: number, method = 'EFECTIVO') =>
    registrarAbono(db, O, registrarAbonoSchema.parse({ customerId, method, amount, idempotencyKey: randomUUID() }))
  const abrir = (fondo: number) => openCashSession(db, O, openCashSchema.parse({ openingAmount: fondo }))
  const cerrar = (sessionId: string, contado: number) => closeCashSession(db, O, closeCashSchema.parse({ sessionId, countedAmount: contado }))
  const sesion = (id: string) => prisma.cashSession.findUniqueOrThrow({ where: { id } })
  return { t, b1, owner, O, db, prod, cliente, vender, abonar, abrir, cerrar, sesion }
}

async function main() {
  const E = await negocio('a')
  const { O, db, cliente, vender, abonar, abrir, cerrar, sesion } = E

  console.log('\nA) El cierre separa lo que entra al cajón de lo que no')
  const turno = await abrir(100)
  const C1 = await cliente(), C2 = await cliente()
  check('(preparación) un turno abierto nace con los tres totales de crédito en 0', await (async () => { const s = await sesion(turno.id); return num(s.creditSalesTotal) === 0 && num(s.cashReceiptsTotal) === 0 && num(s.otherReceiptsTotal) === 0 })())
  await vender(50, [{ method: 'EFECTIVO', amount: 60 }])                                   // paga 60, vuelto 10 → entra 50 neto
  const f1 = await vender(200, [{ method: 'CREDITO', amount: 200 }], C1.id)                  // fiado puro: no entra
  await vender(100, [{ method: 'EFECTIVO', amount: 30 }, { method: 'CREDITO', amount: 70 }], C2.id)   // mixto
  await abonar(C1.id, 80)                                                                  // efectivo: entra
  await abonar(C1.id, 40, 'YAPE')                                                          // Yape: no entra al cajón
  const anulable = await abonar(C2.id, 25)                                                 // efectivo, se anula: no cuenta
  await anularAbono(db, O, anularAbonoSchema.parse({ paymentId: anulable.paymentId, motivo: 'se cobró de más' }))
  const antes = await prisma.customerPayment.count({ where: { tenantId: E.t.id } })
  const vivo = await currentCashSession(db, O)
  check('>>> el esperado EN VIVO = fondo 100 + efectivo vendido 60+30 + abono en efectivo 80 − vuelto 10 = 260 (el fiado, el Yape y el abono anulado NO suman)', vivo?.expectedAmount === 260, String(vivo?.expectedAmount))
  const tot = await totalesDelTurno(db, turno.id)
  check('>>> los totales del turno: ventas 3 · 350; fiado 270; abonos en efectivo 80; abonos por otros medios 40; vuelto 10',
    tot.salesCount === 3 && tot.salesTotal === 350 && tot.creditSalesTotal === 270 && tot.cashReceiptsTotal === 80 && tot.otherReceiptsTotal === 40 && tot.changeTotal === 10 && tot.cashTotal === 90)
  const cierre = await cerrar(turno.id, 260)
  check('>>> contando 260 el arqueo CUADRA (diferencia 0): los abonos en efectivo entran al esperado y el fiado no', cierre.expectedAmount === 260 && cierre.difference === 0)
  check('el resultado del cierre informa las tres cifras de crédito', cierre.creditSalesTotal === 270 && cierre.cashReceiptsTotal === 80 && cierre.otherReceiptsTotal === 40)
  const s = await sesion(turno.id)
  check('>>> las TRES columnas quedan congeladas en la fila del turno', num(s.creditSalesTotal) === 270 && num(s.cashReceiptsTotal) === 80 && num(s.otherReceiptsTotal) === 40 && num(s.expectedAmount) === 260 && s.status === 'CERRADA')
  check('el esperado = fondo + efectivo + abonos en efectivo − vueltos, sin contar el fiado (misma función que usa la pantalla)', efectivoEsperado(100, { cashTotal: 90, cashReceiptsTotal: 80, changeTotal: 10, supplierCashPaymentsTotal: 0, refundsCashTotal: 0 }) === 260 && efectivoEsperado(100, { cashTotal: 90, cashReceiptsTotal: 80, changeTotal: 10, supplierCashPaymentsTotal: 0, refundsCashTotal: 60 }) === 200)
  const log = await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'cash.close', entityId: turno.id } })
  check('>>> la auditoría del cierre deja fiado y abonos', JSON.stringify(log?.after).includes('"fiado":270') && JSON.stringify(log?.after).includes('"abonosEfectivo":80'), JSON.stringify(log?.after))
  check('el sobrante y el faltante siguen igual: contar 250 → faltante 10 (en otro turno)', await (async () => { const t2 = await abrir(0); await abonar(C2.id, 10); const r = await cerrar(t2.id, 0); return r.expectedAmount === 10 && r.difference === -10 })())

  console.log('\nB) Un turno cerrado es inmutable')
  const fotoAntes = JSON.stringify(await sesion(turno.id))
  const pagos = await prisma.customerPayment.findMany({ where: { cashSessionId: turno.id, voidedAt: null, method: 'EFECTIVO' } })
  check('>>> el abono en efectivo de un turno cerrado NO se anula (ajuste manual de la administración)', await code(anularAbono(db, O, anularAbonoSchema.parse({ paymentId: pagos[0]!.id, motivo: 'intento tardío' }))) === 'INVALID_DOCUMENT')
  const otroPago = await prisma.customerPayment.findFirstOrThrow({ where: { cashSessionId: turno.id, method: 'YAPE' } })
  check('el abono por Yape enlazado a un turno cerrado tampoco (el arqueo congelado no se reescribe)', await code(anularAbono(db, O, anularAbonoSchema.parse({ paymentId: otroPago.id, motivo: 'intento tardío' }))) === 'INVALID_DOCUMENT')
  await anularCuenta(db, O, anularCuentaSchema.parse({ receivableId: (await prisma.receivable.findFirstOrThrow({ where: { saleId: f1.saleId } })).id, motivo: 'castigo de prueba' }))
  check('>>> castigar una deuda o abonar después NO mueve lo congelado del turno cerrado', JSON.stringify(await sesion(turno.id)) === fotoAntes)
  check('un abono nuevo sin turno abierto en efectivo → rechazado; con otro medio se registra sin turno', await code(abonar(C2.id, 5)) === 'INVALID_DOCUMENT' && (await abonar(C2.id, 5, 'YAPE')).replayed === false)
  check('y ese abono por Yape no está enlazado a ningún turno', (await prisma.customerPayment.count({ where: { tenantId: E.t.id, method: 'YAPE', cashSessionId: null } })) === 1)

  console.log('\nC) Nada se cuela en un turno que se está cerrando (bloqueo del turno)')
  // Simula un cierre EN MARCHA: otra transacción tiene bloqueado el turno y lo cerrará en 1.5 s.
  const T = await abrir(0)
  const D = await cliente()
  await vender(300, [{ method: 'CREDITO', amount: 300 }], D.id)
  const cerrando = prisma.$transaction(async (tx) => {
    await tx.cashSession.update({ where: { id: T.id }, data: { updatedAt: new Date() } })
    await esperar(1500)
    await tx.cashSession.update({ where: { id: T.id }, data: { status: 'CERRADA', closedAt: new Date(), closedById: E.owner.id, countedAmount: 0, expectedAmount: 0, difference: 0 } })
  }, { timeout: 20_000 })
  await esperar(400)
  const colado = await code(abonar(D.id, 50))
  await cerrando
  check('>>> un abono en EFECTIVO que llega mientras el turno se cierra espera, ve el turno cerrado y se RECHAZA (no queda un abono fuera del arqueo)', colado === 'INVALID_DOCUMENT', String(colado))
  check('y no dejó rastro: ningún abono enlazado a ese turno ni deuda movida', (await prisma.customerPayment.count({ where: { cashSessionId: T.id } })) === 0 && num((await prisma.customer.findUniqueOrThrow({ where: { id: D.id } })).creditBalance) === 300)
  // Lo mismo con ANULAR un abono: se abre un turno, se cobra, y mientras "se cierra" la anulación espera y se rechaza.
  const T2 = await abrir(0)
  const ab = await abonar(D.id, 40)
  const cerrando2 = prisma.$transaction(async (tx) => {
    await tx.cashSession.update({ where: { id: T2.id }, data: { updatedAt: new Date() } })
    await esperar(1500)
    await tx.cashSession.update({ where: { id: T2.id }, data: { status: 'CERRADA', closedAt: new Date(), closedById: E.owner.id, countedAmount: 40, expectedAmount: 40, difference: 0 } })
  }, { timeout: 20_000 })
  await esperar(400)
  const anulacionTardia = await code(anularAbono(db, O, anularAbonoSchema.parse({ paymentId: ab.paymentId, motivo: 'a destiempo' })))
  await cerrando2
  check('>>> anular un abono mientras su turno se cierra espera y se RECHAZA: el abono sigue vigente y la deuda no se reabre', anulacionTardia === 'INVALID_DOCUMENT' && (await prisma.customerPayment.findUniqueOrThrow({ where: { id: ab.paymentId } })).voidedAt === null && num((await prisma.customer.findUniqueOrThrow({ where: { id: D.id } })).creditBalance) === 260)

  console.log('\nD) Cierres y abonos simultáneos: la cuenta siempre cuadra')
  let huerfanos = 0, rondas = 0
  for (let i = 0; i < 4; i++) {
    const X = await abrir(0)
    const R = await Promise.allSettled([abonar(D.id, 10), abonar(D.id, 10), cerrar(X.id, 0), abonar(D.id, 10, 'YAPE')])
    rondas++
    const cerrado = await sesion(X.id)
    const reales = await prisma.customerPayment.findMany({ where: { cashSessionId: X.id, voidedAt: null } })
    const ef = reales.filter((p) => p.method === 'EFECTIVO').reduce((a, p) => a + num(p.amount), 0)
    const ot = reales.filter((p) => p.method !== 'EFECTIVO').reduce((a, p) => a + num(p.amount), 0)
    if (R[2]!.status === 'fulfilled' && (Math.abs(num(cerrado.cashReceiptsTotal) - ef) > 1e-9 || Math.abs(num(cerrado.otherReceiptsTotal) - ot) > 1e-9)) huerfanos++
  }
  check(`>>> en ${rondas} rondas de cierre + 3 abonos a la vez, lo congelado = lo enlazado al turno (ningún abono "huérfano" fuera del arqueo)`, huerfanos === 0, `${huerfanos} descuadres`)
  const Y = await abrir(0)
  const R2 = await Promise.allSettled([cerrar(Y.id, 0), cerrar(Y.id, 0)])
  check('>>> dos cierres simultáneos del mismo turno: exactamente uno lo cierra y el otro lo ve cerrado', R2.filter((r) => r.status === 'fulfilled').length === 1
    && (await prisma.auditLog.count({ where: { tenantId: E.t.id, entityId: Y.id, action: { in: ['cash.close', 'cash.close.descuadre'] } } })) === 1)

  console.log('\nE) Sin crédito, el cierre es el de siempre')
  const N = await cliente()
  void N
  const L = await abrir(50)
  await vender(100, [{ method: 'EFECTIVO', amount: 120 }])      // vuelto 20
  await vender(100, [{ method: 'YAPE', amount: 100 }])
  const rl = await cerrar(L.id, 130)
  check('>>> fondo 50 + efectivo 120 − vuelto 20 = 150 esperado; contando 130 → faltante 20; las columnas de crédito en 0', rl.expectedAmount === 150 && rl.difference === -20 && rl.creditSalesTotal === 0 && rl.cashReceiptsTotal === 0 && rl.otherReceiptsTotal === 0)

  console.log('\nF) Base de datos: los totales de crédito nunca son negativos')
  for (const col of ['creditSalesTotal', 'cashReceiptsTotal', 'otherReceiptsTotal']) {
    check(`>>> ${col} = -1 → la base lo rechaza`, await prisma.cashSession.update({ where: { id: L.id }, data: { [col]: -1 } }).then(() => false).catch((e) => /cash_sessions_credito_chk/.test(String(e.message) + JSON.stringify(e.meta ?? '') + String(e.cause?.message ?? ''))))
  }

  console.log('\nG) Reporte del panel: el rendimiento de caja trae lo de crédito')
  const rend = await rendimientoDeCaja(db, O)
  const mio = rend.cerradosHoy.find((x) => x.id === turno.id)
  check('>>> el turno cerrado del reporte muestra fiado 270, abonos en efectivo 80 y por otros medios 40', mio?.fiado === 270 && mio?.abonosEfectivo === 80 && mio?.abonosOtros === 40, JSON.stringify(mio))

  console.log('\nH) El ticket: «Crédito» con su vencimiento')
  await configurarCredito(db, O, configurarCreditoSchema.parse({ customerId: C1.id, creditLimit: 5000, creditTermDays: 15, bloqueado: false }))
  const venta = await vender(150, [{ method: 'EFECTIVO', amount: 50 }, { method: 'CREDITO', amount: 100 }], C1.id)
  const cuenta = await prisma.receivable.findFirstOrThrow({ where: { saleId: venta.saleId } })
  const vence = cuenta.dueDate.toISOString().slice(0, 10)
  const doc = await getDocumentoImprimible(db, 'venta', venta.saleId)
  const lin = doc.pagos.find((p) => p.metodo === 'CREDITO')
  check('>>> la línea de crédito del ticket lleva la fecha de vencimiento de la cuenta; la de efectivo no', lin?.vence === vence && doc.pagos.find((p) => p.metodo === 'EFECTIVO')?.vence === null, JSON.stringify(doc.pagos))
  const html = renderToStaticMarkup(createElement(TicketTermico, { doc }))
  const [a, m, d] = vence.split('-')
  check('>>> impreso: "Crédito" y "Vence el DD/MM/AAAA"', html.includes('Crédito') && html.includes(`Vence el ${d}/${m}/${a}`))
  const sinFiado = await vender(100, [{ method: 'EFECTIVO', amount: 100 }])
  const htmlSin = renderToStaticMarkup(createElement(TicketTermico, { doc: await getDocumentoImprimible(db, 'venta', sinFiado.saleId) }))
  check('una venta sin fiado no imprime vencimiento', !htmlSin.includes('Vence el'))
  await anularCuenta(db, O, anularCuentaSchema.parse({ receivableId: cuenta.id, motivo: 'baja de prueba' }))
  const docBaja = await getDocumentoImprimible(db, 'venta', venta.saleId)
  check('una cuenta dada de baja ya no imprime vencimiento (no vence)', docBaja.pagos.find((p) => p.metodo === 'CREDITO')?.vence === null)

  console.log('\nI) Estructura')
  const cs = readFileSync('src/features/branches/cash-service.ts', 'utf8')
  const cierreSrc = cs.slice(cs.indexOf('export async function closeCashSession'), cs.indexOf('export async function currentCashSession'))
  check('>>> el cierre BLOQUEA el turno antes de sumar', cierreSrc.indexOf('bloquearTurno(') > 0 && cierreSrc.indexOf('bloquearTurno(') < cierreSrc.indexOf('totalesDelTurno('))
  check('>>> cierre y consulta en vivo usan los MISMOS totales y el MISMO esperado', cierreSrc.includes('efectivoEsperado(') && cs.slice(cs.indexOf('export async function currentCashSession')).includes('efectivoEsperado(') && cs.slice(cs.indexOf('export async function currentCashSession')).includes('totalesDelTurno('))
  const cr = readFileSync('src/features/credito/credito-service.ts', 'utf8')
  const abonoSrc = cr.slice(cr.indexOf('export async function registrarAbono'), cr.indexOf('export async function anularAbono'))
  check('>>> el abono bloquea al cliente y DESPUÉS al turno', abonoSrc.indexOf('bloquearCliente(') > 0 && abonoSrc.indexOf('bloquearCliente(') < abonoSrc.indexOf('bloquearTurno('))
  check('>>> anular un abono también bloquea el turno antes de decidir', cr.slice(cr.indexOf('export async function anularAbono'), cr.indexOf('export async function anularCuenta')).includes('bloquearTurno('))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
