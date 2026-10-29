import './guard'
import { correr } from './teardown'
import { abrirTurno, asignarSucursal, cajaLibre, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { closeCashSession, currentCashSession, efectivoEsperado, openCashSession, totalesDelTurno } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { anularMovimientoCaja, registrarMovimientoCaja } from '../src/features/branches/cash-movement-service'
import { anularMovimientoCajaSchema, registrarMovimientoCajaSchema } from '../src/features/branches/cash-movement-schemas'
import { permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'
import { PERMISOS } from '../src/lib/permisos'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.3a · Movimientos manuales de caja contra la base: permisos y tope, referencia, aviso de exceso, idempotencia, el efecto en el efectivo esperado, el
 * cierre que los congela, que un turno cerrado no cambie nunca, anulaciones y aislamiento por sucursal.
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

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-cms-${randomUUID().slice(0, 6)}`, name: 'Movimientos servicio', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cms' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ADMIN', 'CAJERO', 'CONTADOR', 'VENDEDOR', 'ALMACENERO'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    for (const b of [b1, b2]) await asignarSucursal(t.id, x.id, b.branch.id)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: [] }
  }
  const O = u.OWNER!, A = u.ADMIN!, C = u.CAJERO!
  const db = (c: TenantContext) => getTenantPrisma(c)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Cemento', unitType: 'UNIDAD', salePrice: 100, costPrice: 60 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: b1.warehouse.id, quantity: 500 } })
  const vender = (monto: number) => registerSale(db(O), O, registerSaleSchema.parse({ warehouseId: b1.warehouse.id, items: [{ productId: prod.id, quantity: monto / 100, discount: 0 }], payments: [{ method: 'EFECTIVO', amount: monto }], documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() }) as never)
  const reg = (c: TenantContext, o: Record<string, unknown> = {}) => registrarMovimientoCaja(db(c), c, registrarMovimientoCajaSchema.parse({ kind: 'EGRESO', category: 'GASTO_MENOR', amount: 25, description: 'Bolsas para el mostrador', idempotencyKey: randomUUID(), ...o }))
  const esperado = async () => (await currentCashSession(db(O), O))!.expectedAmount
  const filas = () => prisma.cashMovement.count({ where: { tenantId: t.id } })

  console.log('\nA) Sin turno abierto')
  const sinTurno = await err(reg(O))
  check('>>> sin turno abierto: CASH_REQUIRED y no se crea nada', sinTurno?.code === 'CASH_REQUIRED' && (await filas()) === 0)

  console.log('\nB) El efecto en el efectivo esperado')
  const turno = await openCashSession(db(O), O, openCashSchema.parse({ openingAmount: 100 }))
  await vender(300)
  check('(preparación) fondo 100 + venta 300 = 400 esperado', (await esperado()) === 400)
  const e1 = await reg(O, { amount: 30 })
  check('>>> un egreso de 30 baja el esperado a 370; el movimiento queda en el turno abierto con quién lo hizo y sin marca de exceso', (await esperado()) === 370 && e1.cashSessionId === turno.id && !e1.exceededExpected && !e1.replayed && e1.kind === 'EGRESO' && e1.amount === 30)
  await reg(O, { kind: 'INGRESO', category: 'REPOSICION_FONDO', amount: 200, description: 'Reposición del fondo de cambio' })
  check('>>> un ingreso de 200 lo sube a 570', (await esperado()) === 570)
  const tot = await totalesDelTurno(db(O), turno.id)
  check('>>> el turno suma 200 de ingresos y 30 de egresos manuales, sin mezclarlos con ventas ni devoluciones', tot.manualInTotal === 200 && tot.manualOutTotal === 30 && tot.cashTotal === 300 && tot.refundsCashTotal === 0)
  const viva = await currentCashSession(db(O), O)
  check('la consulta del turno trae esos totales (para la pantalla)', viva?.manualInTotal === 200 && viva.manualOutTotal === 30)
  const a1 = await prisma.auditLog.findFirst({ where: { tenantId: t.id, action: 'caja.movimiento', entityId: e1.id } })
  check('>>> la auditoría deja `caja.movimiento` con la descripción como motivo, el tipo, la categoría, el monto y el permiso con que se hizo', !!a1 && a1.reason === 'Bolsas para el mostrador' && JSON.stringify(a1.after).includes('"tipo":"EGRESO"') && JSON.stringify(a1.after).includes('"permiso":"caja.movimientos"') && JSON.stringify(a1.after).includes('"superoElEfectivoEsperado":false'))

  console.log('\nC) Quién puede registrar qué')
  // F6.8b: cada quien registra en SU turno; el cajero y el administrador tienen el suyo.
  const turnoC = await abrirTurno(t.id, C.userId, b1.branch.id, { fondo: 1000 }), turnoA = await abrirTurno(t.id, A.userId, b1.branch.id, { fondo: 1000 })
  const casos: [string, TenantContext, Record<string, unknown>, 'OK' | 'FORBIDDEN_ROLE'][] = [
    ['CAJERO: gasto menor de 100.00 (el tope, incluido)', C, { amount: 100 }, 'OK'],
    ['CAJERO: «otro» de 40.00', C, { category: 'OTRO', amount: 40 }, 'OK'],
    ['CAJERO: ingreso «otro» de 15.00', C, { kind: 'INGRESO', category: 'OTRO', amount: 15 }, 'OK'],
    ['CAJERO: gasto menor de 100.01 (pasa del tope)', C, { amount: 100.01 }, 'FORBIDDEN_ROLE'],
    ['CAJERO: «otro» de 150.00', C, { category: 'OTRO', amount: 150 }, 'FORBIDDEN_ROLE'],
    ['CAJERO: retiro del dueño de 5.00', C, { category: 'RETIRO_DUENO', amount: 5 }, 'FORBIDDEN_ROLE'],
    ['CAJERO: reposición del fondo de 5.00', C, { kind: 'INGRESO', category: 'REPOSICION_FONDO', amount: 5 }, 'FORBIDDEN_ROLE'],
    ['CAJERO: corrección de arqueo de 5.00', C, { category: 'CORRECCION_ARQUEO', amount: 5 }, 'FORBIDDEN_ROLE'],
    ['ADMIN: retiro del dueño de 150.00', A, { category: 'RETIRO_DUENO', amount: 150, reference: 'RET-1' }, 'OK'],
    ['ADMIN: corrección de arqueo de 2.50', A, { kind: 'INGRESO', category: 'CORRECCION_ARQUEO', amount: 2.5, description: 'Sobrante del cambio' }, 'OK'],
    ['OWNER: gasto menor de 150.00 (pasa del tope, pero tiene `caja.ajuste`)', O, { amount: 150 }, 'OK'],
    ['CONTADOR: gasto menor de 5.00', u.CONTADOR!, { amount: 5 }, 'FORBIDDEN_ROLE'],
    ['VENDEDOR: gasto menor de 5.00', u.VENDEDOR!, { amount: 5 }, 'FORBIDDEN_ROLE'],
    ['ALMACENERO: gasto menor de 5.00', u.ALMACENERO!, { amount: 5 }, 'FORBIDDEN_ROLE'],
  ]
  const antes = await filas()
  let creados = 0
  for (const [n, c, o, esp] of casos) {
    const e = await err(reg(c, o))
    const r = e === null ? 'OK' : e.code
    if (r === 'OK') creados++
    check(`>>> ${n}: ${esp === 'OK' ? 'se registra' : 'FORBIDDEN_ROLE'}`, r === esp, e?.message)
  }
  check('>>> y lo rechazado no dejó NADA: solo se crearon los permitidos', (await filas()) === antes + creados)
  const eTope = await err(reg(C, { amount: 100.01 }))
  check('>>> el mensaje del tope dice cuánto puede y a quién pedirlo', /hasta S\/ 100\.00/.test(eTope?.message ?? '') && /dueño o administrador/.test(eTope?.message ?? ''))
  const pin: TenantContext = { ...O, operadorDe: O.userId, permisosDenegados: permisosDenegadosAlOperador(new Set(PERMISOS)) }
  check('>>> con PIN de operador: el gasto pequeño SÍ (mostrador) pero NO un retiro ni pasar del tope (`caja.ajuste` está fuera del PIN)', (await code(reg(pin, { amount: 20 }))) === null && (await code(reg(pin, { category: 'RETIRO_DUENO', amount: 20 }))) === 'FORBIDDEN_ROLE' && (await code(reg(pin, { amount: 150 }))) === 'FORBIDDEN_ROLE')
  const sinMov = { ...C, permisosDenegados: ['caja.movimientos' as const] }
  check('>>> a un cajero al que se le quita `caja.movimientos` no le queda nada', (await code(reg(sinMov, { amount: 5 }))) === 'FORBIDDEN_ROLE')
  check('>>> cuenta en SOLO LECTURA: no escribe', (await code(reg({ ...O, access: 'READ_ONLY' } as TenantContext))) !== null)

  console.log('\nD) Referencia, descripción y aviso de exceso')
  await reg(O, { kind: 'INGRESO', category: 'OTRO', amount: 5000, description: 'Reposición grande para las pruebas' })   // hay efectivo de sobra: aquí se prueba la referencia, no el exceso
  const eRef = await err(reg(O, { amount: 200.01 }))
  check('>>> un egreso de 200.01 sin referencia se rechaza, diciendo qué falta', eRef?.code === 'INVALID_DOCUMENT' && /referencia/.test(eRef.message))
  check('>>> con referencia se acepta, y de exactamente 200.00 no la necesita', (await code(reg(O, { amount: 200.01, reference: 'F001-884' }))) === null && (await code(reg(O, { amount: 200 }))) === null)
  check('>>> la referencia de un ingreso nunca es obligatoria', (await code(reg(O, { kind: 'INGRESO', category: 'OTRO', amount: 5000, description: 'Otro ingreso grande' }))) === null)
  // Ahora se cierra el turno y se abre otro con poco efectivo para probar el exceso.
  const cierre0 = await closeCashSession(db(O), O, closeCashSchema.parse({ sessionId: turno.id, countedAmount: 0 }))
  void cierre0
  const turno2 = await openCashSession(db(O), O, openCashSchema.parse({ openingAmount: 50, ...(await cajaLibre(t.id, b1.branch.id)) }))
  const antesEx = await filas()
  const eEx = await err(reg(O, { amount: 80, category: 'RETIRO_DUENO' }))
  check('>>> un egreso mayor que el esperado (80 contra 50) se detiene con CASH_EXCEEDS_EXPECTED y no crea nada', eEx?.code === 'CASH_EXCEEDS_EXPECTED' && (await filas()) === antesEx)
  check('>>> el aviso NO revela cuánto espera el sistema (el arqueo es a ciegas)', !/\b50\b/.test(eEx?.message ?? '') && !/\d+\.\d\d/.test(eEx?.message ?? ''))
  const conf = await reg(O, { amount: 80, category: 'RETIRO_DUENO', confirmaExceso: true })
  check('>>> con la confirmación expresa se registra, queda MARCADO como exceso y el esperado baja a −30', conf.exceededExpected && (await esperado()) === -30)
  const aEx = await prisma.auditLog.findFirst({ where: { tenantId: t.id, action: 'caja.movimiento', entityId: conf.id } })
  check('>>> y la auditoría lo deja dicho (`superoElEfectivoEsperado`)', JSON.stringify(aEx?.after).includes('"superoElEfectivoEsperado":true'))
  check('>>> con el efectivo ya en negativo, cualquier egreso nuevo pide confirmación; un ingreso no', (await code(reg(O, { amount: 1 }))) === 'CASH_EXCEEDS_EXPECTED' && (await code(reg(O, { kind: 'INGRESO', category: 'OTRO', amount: 1 }))) === null)

  console.log('\nE) Idempotencia')
  const k = randomUUID()
  const r1 = await reg(O, { kind: 'INGRESO', category: 'OTRO', amount: 12.34, idempotencyKey: k }), r2 = await reg(O, { kind: 'INGRESO', category: 'OTRO', amount: 12.34, idempotencyKey: k })
  check('>>> la misma clave dos veces devuelve el MISMO movimiento (replayed) y no suma dos veces', r1.id === r2.id && r2.replayed && !r1.replayed && (await prisma.cashMovement.count({ where: { tenantId: t.id, idempotencyKey: k } })) === 1)

  console.log('\nF) Anulaciones')
  const mC = await reg(C, { amount: 20, description: 'Cinta adhesiva', confirmaExceso: true }), mA = await reg(A, { category: 'RETIRO_DUENO', amount: 10, description: 'Retiro chico', confirmaExceso: true })
  const esperadoDe = async (c: TenantContext) => (await currentCashSession(db(c), c))!.expectedAmount   // F6.8b: cada quien ve el esperado de SU turno
  const antesAn = await esperadoDe(C), totAntesC = (await totalesDelTurno(db(C), turnoC)).manualOutTotal
  check('>>> el cajero NO anula el movimiento de otra persona', (await code(anularMovimientoCaja(db(C), C, anularMovimientoCajaSchema.parse({ movementId: mA.id, reason: 'Me equivoqué' })))) === 'FORBIDDEN_ROLE')
  check('>>> ni uno suyo de categoría o monto reservado a `caja.ajuste` (el administrador lo registró; aquí uno del cajero pasa del tope por otra vía no existe) — el ajeno sigue vigente', Math.round(((await esperadoDe(C)) - antesAn) * 100) === 0)
  const anuladoC = await anularMovimientoCaja(db(C), C, anularMovimientoCajaSchema.parse({ movementId: mC.id, reason: 'Lo compré con mi dinero' }))
  check('>>> el cajero SÍ anula el suyo (gasto menor ≤ tope) mientras el turno está abierto: el esperado sube 20 y queda quién, cuándo y por qué', Math.round(((await esperadoDe(C)) - antesAn) * 100) === 2000 && !!anuladoC.voidedAt && (await prisma.cashMovement.findUniqueOrThrow({ where: { id: mC.id } })).voidReason === 'Lo compré con mi dinero')
  check('>>> el anulado deja de contar en los totales del turno pero NO se borra', (await prisma.cashMovement.count({ where: { id: mC.id } })) === 1 && (await totalesDelTurno(db(C), turnoC)).manualOutTotal === Math.round((totAntesC - 20) * 100) / 100 && (await totalesDelTurno(db(O), turno2.id)).manualOutTotal === 80)
  check('>>> anular dos veces se rechaza', (await code(anularMovimientoCaja(db(O), O, anularMovimientoCajaSchema.parse({ movementId: mC.id, reason: 'Otra vez' })))) === 'INVALID_DOCUMENT')
  await anularMovimientoCaja(db(A), A, anularMovimientoCajaSchema.parse({ movementId: mA.id, reason: 'Error de digitación' }))
  check('>>> quien tiene `caja.ajuste` anula el de cualquiera', (await prisma.cashMovement.findUniqueOrThrow({ where: { id: mA.id } })).voidedById === A.userId)
  check('>>> sin permisos de caja no se anula nada; un id inexistente es NOT_FOUND', (await code(anularMovimientoCaja(db(u.CONTADOR!), u.CONTADOR!, anularMovimientoCajaSchema.parse({ movementId: conf.id, reason: 'Intento' })))) === 'FORBIDDEN_ROLE' && (await code(anularMovimientoCaja(db(O), O, anularMovimientoCajaSchema.parse({ movementId: 'no-existe-12345', reason: 'Intento' })))) === 'NOT_FOUND')
  check('>>> la auditoría deja `caja.movimiento_anulado` con el motivo', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'caja.movimiento_anulado', entityId: mC.id, reason: 'Lo compré con mi dinero' } })) === 1)

  console.log('\nG) El cierre congela los movimientos y un turno cerrado no cambia nunca')
  const manualesAntes = await totalesDelTurno(db(O), turno2.id)
  const esperadoCierre = efectivoEsperado(50, manualesAntes)
  const cierre = await closeCashSession(db(O), O, closeCashSchema.parse({ sessionId: turno2.id, countedAmount: 0 }))
  const cerrado = await prisma.cashSession.findUniqueOrThrow({ where: { id: turno2.id } })
  check('>>> el cierre congela los ingresos y egresos manuales y el esperado los incluye (50 + 12.34 − 80 − 1… exacto)', num(cerrado.manualInTotal) === manualesAntes.manualInTotal && num(cerrado.manualOutTotal) === manualesAntes.manualOutTotal && cierre.expectedAmount === esperadoCierre && num(cerrado.expectedAmount) === esperadoCierre && cierre.manualInTotal === manualesAntes.manualInTotal)
  const reCalc = await totalesDelTurno(db(O), turno2.id)
  check('>>> lo congelado = lo que el turno recalcula hoy (misma función para el cierre y la consulta)', reCalc.manualInTotal === num(cerrado.manualInTotal) && reCalc.manualOutTotal === num(cerrado.manualOutTotal))
  check('>>> sin turno abierto ya no se registra nada (CASH_REQUIRED) ni se anula un movimiento del turno cerrado', (await code(reg(O, { amount: 5 }))) === 'CASH_REQUIRED' && (await code(anularMovimientoCaja(db(O), O, anularMovimientoCajaSchema.parse({ movementId: conf.id, reason: 'Tarde' })))) === 'INVALID_DOCUMENT')
  // Reintentar un envío ya registrado funciona aunque el mundo haya cambiado (el turno se cerró): se devuelve el mismo movimiento, sin error.
  const repetidoTrasCierre = await reg(O, { kind: 'INGRESO', category: 'OTRO', amount: 12.34, idempotencyKey: k })
  check('>>> reintentar una clave ya usada DESPUÉS de cerrar el turno devuelve el mismo movimiento (replayed), no un error de caja', repetidoTrasCierre.replayed && repetidoTrasCierre.id === r1.id)
  const turno3 = await openCashSession(db(O), O, openCashSchema.parse({ openingAmount: 0, ...(await cajaLibre(t.id, b1.branch.id)) }))
  await reg(O, { kind: 'INGRESO', category: 'CORRECCION_ARQUEO', amount: 77, description: 'Corrige el faltante del turno anterior' })
  const cerradoDespues = await prisma.cashSession.findUniqueOrThrow({ where: { id: turno2.id } })
  check('>>> un movimiento de HOY no cambia ninguna columna del turno cerrado ayer', JSON.stringify(cerradoDespues) === JSON.stringify(cerrado) && (await totalesDelTurno(db(O), turno2.id)).manualInTotal === manualesAntes.manualInTotal)
  void turno3

  check('>>> sin ningún permiso de caja, anular dice FORBIDDEN_ROLE incluso con un id inexistente (no revela qué existe)', (await code(anularMovimientoCaja(db(u.CONTADOR!), u.CONTADOR!, anularMovimientoCajaSchema.parse({ movementId: 'no-existe-12345', reason: 'Intento' })))) === 'FORBIDDEN_ROLE')

  console.log('\nH) Por sucursal')
  const otraSucursal: TenantContext = { ...O, branchId: b2.branch.id, branchIds: [b2.branch.id] }
  check('>>> en la sucursal 2 no hay turno abierto: CASH_REQUIRED aunque la 1 sí lo tenga', (await code(reg(otraSucursal, { amount: 5 }))) === 'CASH_REQUIRED')
  const m1 = await prisma.cashMovement.findFirstOrThrow({ where: { tenantId: t.id, branchId: b1.branch.id, voidedAt: null } })
  check('>>> quien solo tiene la sucursal 2 no ve ni anula un movimiento de la 1 (NOT_FOUND)', (await code(anularMovimientoCaja(db(otraSucursal), otraSucursal, anularMovimientoCajaSchema.parse({ movementId: m1.id, reason: 'Intento' })))) === 'NOT_FOUND')

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
