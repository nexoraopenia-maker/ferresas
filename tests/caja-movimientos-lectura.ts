import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { closeCashSession, currentCashSession, desgloseDeMovimientos, openCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { anularMovimientoCaja, listarMovimientosDelTurno, registrarMovimientoCaja } from '../src/features/branches/cash-movement-service'
import { anularMovimientoCajaSchema, registrarMovimientoCajaSchema } from '../src/features/branches/cash-movement-schemas'
import { getTicketCierre } from '../src/features/printing/cierre-caja'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.3c · Lo que la pantalla de caja y el ticket LEEN, contra la base: la lista del turno (anulados incluidos, autor, quién puede anular qué),
 * el desglose en ingresos / egresos / compensaciones, que nada de eso revele el efectivo esperado y que el ticket de cierre traiga lo congelado.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 400) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-cml-${randomUUID().slice(0, 6)}`, name: 'Movimientos lectura', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cml' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ADMIN', 'CAJERO', 'CONTADOR', 'VENDEDOR', 'ALMACENERO'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, x.id, b1.branch.id)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  }
  const O = u.OWNER!, A = u.ADMIN!, C = u.CAJERO!, K = u.CONTADOR!, V = u.VENDEDOR!
  const db = (c: TenantContext) => getTenantPrisma(c)
  const reg = (c: TenantContext, o: Record<string, unknown> = {}) => registrarMovimientoCaja(db(c), c, registrarMovimientoCajaSchema.parse({ kind: 'EGRESO', category: 'GASTO_MENOR', amount: 25, description: 'Bolsas para el mostrador', idempotencyKey: randomUUID(), ...o }))

  // Un turno anterior ya cerrado: las compensaciones apuntan a él (el turno corregido nunca es el mismo que el de la corrección).
  const antiguo = await openCashSession(db(O), O, openCashSchema.parse({ openingAmount: 0 }))
  await closeCashSession(db(O), O, closeCashSchema.parse({ sessionId: antiguo.id, countedAmount: 0 }))
  const turno = await openCashSession(db(O), O, openCashSchema.parse({ openingAmount: 1000 }))

  console.log('\nA) La lista del turno')
  const vacia = await listarMovimientosDelTurno(db(C), C, turno.id)
  check('>>> sin movimientos la lista está vacía', vacia.length === 0)
  // F6.8b: un movimiento solo se registra en el turno de quien lo ejecuta. Aquí se prueba la LECTURA de un turno con varios autores: se registran con el dueño (dueño del turno) y se fija quién fue el autor.
  const regComo = async (c: TenantContext, o: Record<string, unknown>) => { const m = await reg(O, o); await prisma.cashMovement.update({ where: { id: m.id }, data: { userId: c.userId } }); return m }
  const g = await regComo(C, { amount: 30 })
  const r = await regComo(A, { kind: 'INGRESO', category: 'REPOSICION_FONDO', amount: 200, description: 'Reposición del fondo' })
  const ajeno = await regComo(A, { kind: 'INGRESO', category: 'OTRO', amount: 10, description: 'Sobrante de caja chica' })
  const grande = await regComo(A, { category: 'RETIRO_DUENO', amount: 300, description: 'Retiro del dueño', reference: 'REC-001' })
  const lista0 = await listarMovimientosDelTurno(db(C), C, turno.id)
  const lista = lista0.filter((m) => m.id !== ajeno.id)
  check('>>> el cajero NO puede anular un gasto menor pequeño que registró otra persona (solo el suyo)', lista0.find((m) => m.id === ajeno.id)?.puedeAnular === false)
  check('>>> la lista trae los tres, del más antiguo al más reciente, con importe, tipo, categoría y autor por nombre', lista.length === 3 && lista.map((m) => m.id).join() === [g.id, r.id, grande.id].join() && lista[0]!.autor === 'CAJERO' && lista[1]!.autor === 'ADMIN' && lista[1]!.kind === 'INGRESO' && lista[2]!.amount === 300 && lista[2]!.reference === 'REC-001')
  check('>>> el cajero puede anular SU gasto menor, pero no el ingreso ni el retiro del administrador', lista[0]!.puedeAnular && !lista[1]!.puedeAnular && !lista[2]!.puedeAnular)
  const listaAdmin = await listarMovimientosDelTurno(db(A), A, turno.id)
  check('>>> el administrador (caja.ajuste) puede anular los tres', listaAdmin.every((m) => m.puedeAnular))
  const listaCont = await listarMovimientosDelTurno(db(K), K, turno.id).then((x) => x.length, (e) => e.code)
  check('>>> el contador (caja.arqueo) puede VER la lista pero no anular nada', listaCont === 4 && (await listarMovimientosDelTurno(db(K), K, turno.id)).every((m) => !m.puedeAnular))
  check('>>> un vendedor sin permisos de caja no la ve (FORBIDDEN_ROLE)', (await code(listarMovimientosDelTurno(db(V), V, turno.id))) === 'FORBIDDEN_ROLE')
  check('>>> un turno que no existe es NOT_FOUND', (await code(listarMovimientosDelTurno(db(O), O, randomUUID()))) === 'NOT_FOUND')
  const llaves = Object.keys(lista[0]!).filter((k) => k !== 'exceededExpected').join()
  check('>>> la lista NO lleva efectivo esperado ni nada que lo revele (el arqueo sigue a ciegas): solo la marca de que ese egreso excedió, sin cifra', !/esperad|expected/i.test(llaves) && typeof lista[0]!.exceededExpected === 'boolean')

  console.log('\nB) Anulados: siguen en la lista, tachados, y ya no suman')
  await anularMovimientoCaja(db(C), C, anularMovimientoCajaSchema.parse({ movementId: g.id, reason: 'Me equivoqué de monto' }))
  const tras = await listarMovimientosDelTurno(db(C), C, turno.id)
  check('>>> el movimiento anulado sigue en la lista con su motivo y sin opción de anular otra vez', tras.length === 4 && tras[0]!.anulado && tras[0]!.motivoAnulacion === 'Me equivoqué de monto' && !tras[0]!.puedeAnular)

  console.log('\nC) El desglose')
  const d1 = await desgloseDeMovimientos(db(O), turno.id)
  check('>>> ingresos 210, egresos 300 (el anulado de 30 no cuenta) y sin compensaciones', d1.ingresos === 210 && d1.egresos === 300 && d1.compensacionesEfectivo === 0 && d1.compensacionesOtrosMedios === 0)
  const viva = await currentCashSession(db(O), O)
  check('>>> el turno abierto trae el mismo desglose y coincide con los totales de la caja (ingresos = manualIn; egresos + compensaciones = manualOut)', !!viva && viva.movimientos.ingresos === viva.manualInTotal && viva.movimientos.egresos + viva.movimientos.compensacionesEfectivo === viva.manualOutTotal)

  console.log('\nD) Compensaciones: en efectivo restan, por otro medio son informativas y no se anulan a mano')
  // Se insertan las compensaciones tal como las deja F6.3b (su comportamiento completo lo prueban credito-compensacion*.ts): cada una apunta a un abono y a su turno.
  const cli = await prisma.customer.create({ data: { tenantId: t.id, name: 'Cliente', docType: 'DNI', docNumber: '12345678' } })
  const abono = (method: 'EFECTIVO' | 'YAPE', amount: number) => prisma.customerPayment.create({ data: { tenantId: t.id, customerId: cli.id, branchId: b1.branch.id, cashSessionId: antiguo.id, userId: O.userId, method, amount, voidedAt: new Date(), voidedById: O.userId, voidReason: 'prueba' } })
  const abEf = await abono('EFECTIVO', 15), abYape = await abono('YAPE', 7)
  const compId = randomUUID()
  await prisma.cashMovement.create({ data: { id: compId, tenantId: t.id, branchId: b1.branch.id, cashSessionId: turno.id, userId: O.userId, kind: 'EGRESO', category: 'COMPENSACION_ABONO', method: 'EFECTIVO', amount: 15, description: 'Compensación de abono anulado', relatedPaymentId: abEf.id, relatedSessionId: antiguo.id, idempotencyKey: `compensacion-abono:${abEf.id}` } })
  await prisma.cashMovement.create({ data: { tenantId: t.id, branchId: b1.branch.id, cashSessionId: turno.id, userId: O.userId, kind: 'EGRESO', category: 'COMPENSACION_ABONO', method: 'YAPE', amount: 7, description: 'Compensación de abono anulado', relatedPaymentId: abYape.id, relatedSessionId: antiguo.id, idempotencyKey: `compensacion-abono:${abYape.id}` } })
  const d2 = await desgloseDeMovimientos(db(O), turno.id)
  check('>>> compensación en efectivo 15 (resta) y por Yape 7 (informativa, aparte); los egresos manuales siguen en 300', d2.compensacionesEfectivo === 15 && d2.compensacionesOtrosMedios === 7 && d2.egresos === 300 && d2.ingresos === 210)
  const l2 = await listarMovimientosDelTurno(db(O), O, turno.id)
  const comp = l2.find((m) => m.id === compId)!
  check('>>> la compensación sale marcada como automática y NADIE puede anularla a mano (ni el dueño)', comp.esCompensacion && !comp.puedeAnular)
  check('>>> y el servicio también la rechaza', (await code(anularMovimientoCaja(db(O), O, anularMovimientoCajaSchema.parse({ movementId: compId, reason: 'quiero anularla' })))) !== null)

  console.log('\nE) Cierre y ticket: lo congelado')
  const viva2 = await currentCashSession(db(O), O)
  const esperado = viva2!.expectedAmount
  const cierre = await closeCashSession(db(O), O, closeCashSchema.parse({ sessionId: turno.id, countedAmount: esperado }))
  check('>>> el cierre trae el desglose y el esperado = 1000 + 210 − 300 − 15 (la compensación por Yape no mueve el cajón)', cierre.movimientos.ingresos === 210 && cierre.movimientos.egresos === 300 && cierre.movimientos.compensacionesEfectivo === 15 && cierre.movimientos.compensacionesOtrosMedios === 7 && cierre.expectedAmount === 895 && cierre.difference === 0)
  const tk = await getTicketCierre(db(O), O, turno.id)
  check('>>> el ticket separa ingresos 210, egresos 300, compensaciones en efectivo 15 e informativas 7; y el esperado congelado es 895', tk.ingresosManuales === 210 && tk.egresosManuales === 300 && tk.compensacionesEfectivo === 15 && tk.compensacionesOtrosMedios === 7 && tk.esperado === 895)
  check('>>> la cuenta del ticket cuadra: fondo + ingresos − egresos − compensaciones = esperado (sin ventas)', Math.round((tk.fondoInicial + tk.ingresosManuales - tk.egresosManuales - tk.compensacionesEfectivo) * 100) === Math.round(tk.esperado * 100))
  const reimpreso = await getTicketCierre(db(O), O, turno.id)
  check('>>> reimprimir da exactamente lo mismo', JSON.stringify(reimpreso) === JSON.stringify(tk))
  const lc = await listarMovimientosDelTurno(db(O), O, turno.id)
  check('>>> con el turno CERRADO nadie puede anular ya (puedeAnular falso en todo) y el servicio lo rechaza', lc.every((m) => !m.puedeAnular) && (await code(anularMovimientoCaja(db(O), O, anularMovimientoCajaSchema.parse({ movementId: r.id, reason: 'tarde' })))) !== null)
  const d3 = await desgloseDeMovimientos(db(O), turno.id)
  check('>>> el desglose del turno cerrado es el mismo de antes', JSON.stringify(d3) === JSON.stringify(cierre.movimientos))
  void grande

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
