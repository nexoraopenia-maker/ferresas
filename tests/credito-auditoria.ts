import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { anularAbono, anularCuenta, configurarCredito, registrarAbono } from '../src/features/credito/credito-service'
import { anularAbonoSchema, anularCuentaSchema, configurarCreditoSchema, registrarAbonoSchema } from '../src/features/credito/schemas'
import { closeCashSession, currentCashSession, efectivoEsperado, openCashSession, totalesDelTurno } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { spawnSync } from 'node:child_process'
import { auditarCoherenciaCredito, auditarDatosCredito, formatearInformeCredito, GRAVEDAD, type DatosCredito } from '../src/features/credito/auditoria'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'


/**
 * Fase 3, subpaso 3.5: la auditoría de coherencia del crédito (módulo + script, SOLO LECTURA).
 * Lo que más importa: encuentra cada tipo de descuadre, no da falsas alarmas sobre un negocio sano, no mezcla negocios y no escribe nada.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))
void code; void esperar

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: { slug: `au-${tag}-${randomUUID().slice(0, 6)}`, name: `Audit ${tag}`, legalName: `AUDIT ${tag.toUpperCase()} SAC`, taxId, planId: plan.id } })
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
  const base: DatosCredito = {
    clientes: [{ id: 'c1', name: 'Ana', creditBalance: 70 }, { id: 'c2', name: 'Beto', creditBalance: 0 }],
    cuentas: [
      { id: 'r1', customerId: 'c1', saleId: 'v1', amount: 100, paidAmount: 30, status: 'ABIERTA', enRevision: false },
      { id: 'r2', customerId: 'c2', saleId: 'v2', amount: 50, paidAmount: 50, status: 'PAGADA', enRevision: false },
    ],
    abonos: [
      { id: 'a1', customerId: 'c1', amount: 30, method: 'EFECTIVO', anulado: false, cashSessionId: 't1' },
      { id: 'a2', customerId: 'c2', amount: 50, method: 'YAPE', anulado: false, cashSessionId: 't1' },
      { id: 'a3', customerId: 'c1', amount: 20, method: 'EFECTIVO', anulado: true, cashSessionId: 't1' },
    ],
    repartos: [
      { paymentId: 'a1', receivableId: 'r1', amount: 30 }, { paymentId: 'a2', receivableId: 'r2', amount: 50 },
      { paymentId: 'a3', receivableId: 'r1', amount: 20 },           // anulado: se conserva pero no cuenta
    ],
    ventas: [
      { id: 'v1', number: 'V001-1', status: 'COMPLETADA', customerId: 'c1', cashSessionId: 't1', fiado: 100 },
      { id: 'v2', number: 'V001-2', status: 'COMPLETADA', customerId: 'c2', cashSessionId: 't1', fiado: 50 },
    ],
    turnosCerrados: [{ id: 't1', cashReceiptsTotal: 30, otherReceiptsTotal: 50, creditSalesTotal: 150 }],
  }
  const con = (cambio: (d: DatosCredito) => void) => { const d = structuredClone(base); cambio(d); return auditarDatosCredito(d) }
  const codigos = (i: ReturnType<typeof auditarDatosCredito>) => i.hallazgos.map((h) => h.codigo).sort().join(',')

  console.log('\nA) Las reglas, con datos fabricados')
  const limpio = auditarDatosCredito(base)
  check('>>> datos coherentes (con un abono anulado conservado) → ningún hallazgo', limpio.hallazgos.length === 0 && limpio.errores === 0, codigos(limpio))
  check('>>> la deuda guardada distinta de la suma de saldos → DEUDA_CLIENTE (ERROR) con lo esperado y lo encontrado', (() => { const i = con((d) => { d.clientes[0]!.creditBalance = 90 }); const h = i.hallazgos[0]!; return codigos(i) === 'DEUDA_CLIENTE' && h.gravedad === 'ERROR' && h.esperado === 70 && h.encontrado === 90 })())
  check('>>> lo abonado de una cuenta ≠ sus repartos vigentes → ABONADO_CUENTA', codigos(con((d) => { d.cuentas[0]!.paidAmount = 40; d.clientes[0]!.creditBalance = 60 })) === 'ABONADO_CUENTA')
  check('>>> un abono anulado que SIGUE contando en la cuenta se detecta', codigos(con((d) => { d.cuentas[0]!.paidAmount = 50; d.clientes[0]!.creditBalance = 50 })) === 'ABONADO_CUENTA')
  check('>>> un abono cuyos repartos no suman su monto → REPARTO_ABONO', codigos(con((d) => { d.abonos[0]!.amount = 35; d.turnosCerrados[0]!.cashReceiptsTotal = 35 })) === 'REPARTO_ABONO')
  check('>>> un reparto que cae en la cuenta de OTRO cliente → REPARTO_CLIENTE', codigos(con((d) => { d.abonos[0]!.customerId = 'c2' })) === 'REPARTO_CLIENTE')
  check('>>> venta COMPLETADA con fiado y sin cuenta → VENTA_FIADA_SIN_CUENTA', (() => { const i = con((d) => { d.ventas.push({ id: 'v3', number: 'V001-3', status: 'COMPLETADA', customerId: 'c1', cashSessionId: null, fiado: 25 }) }); return codigos(i) === 'VENTA_FIADA_SIN_CUENTA' })())
  check('una venta ANULADA con fiado y sin cuenta no es hallazgo (no hay deuda que cobrar)', con((d) => { d.ventas.push({ id: 'v3', number: 'V001-3', status: 'ANULADA', customerId: 'c1', cashSessionId: null, fiado: 25 }) }).hallazgos.length === 0)
  check('>>> cuenta cuya venta no tiene línea a crédito → CUENTA_SIN_FIADO_EN_VENTA; cuya venta no existe también', codigos(con((d) => { d.ventas[0]!.fiado = 0; d.turnosCerrados[0]!.creditSalesTotal = 50 })) === 'CUENTA_SIN_FIADO_EN_VENTA' && codigos(con((d) => { d.ventas.splice(0, 1); d.turnosCerrados[0]!.creditSalesTotal = 50 })) === 'CUENTA_SIN_FIADO_EN_VENTA')
  check('>>> el monto de la cuenta ≠ lo fiado en la venta → MONTO_CUENTA_VENTA', codigos(con((d) => { d.ventas[0]!.fiado = 120; d.turnosCerrados[0]!.creditSalesTotal = 170 })) === 'MONTO_CUENTA_VENTA')
  check('>>> F6.2: una cuenta REDUCIDA por devoluciones parciales (100 fiado, 40 devueltos → cuenta de 60) es coherente; sin declarar lo reducido, se detecta', con((d) => { d.ventas[0]!.reducido = 40; d.cuentas[0]!.amount = 60; d.cuentas[0]!.paidAmount = 30; d.clientes[0]!.creditBalance = 30 }).hallazgos.length === 0 && codigos(con((d) => { d.cuentas[0]!.amount = 60; d.cuentas[0]!.paidAmount = 30; d.clientes[0]!.creditBalance = 30 })) === 'MONTO_CUENTA_VENTA')
  check('>>> F6.2: una reducción que no cuadra con lo devuelto (cuenta de 70 cuando se devolvieron 40) → MONTO_CUENTA_VENTA', codigos(con((d) => { d.ventas[0]!.reducido = 40; d.cuentas[0]!.amount = 70; d.cuentas[0]!.paidAmount = 30; d.clientes[0]!.creditBalance = 40 })) === 'MONTO_CUENTA_VENTA')
  check('>>> F6.2: una cuenta dada de baja por la ÚLTIMA devolución conserva el monto previo (entre fiado − reducido y fiado) y es coherente; fuera de ese rango, no', con((d) => { d.ventas[0]!.status = 'DEVUELTA'; d.ventas[0]!.reducido = 100; d.cuentas[0]!.status = 'ANULADA'; d.cuentas[0]!.amount = 60; d.cuentas[0]!.paidAmount = 0; d.abonos = d.abonos.filter((a) => a.customerId !== 'c1'); d.repartos = d.repartos.filter((r) => r.receivableId !== 'r1'); d.clientes[0]!.creditBalance = 0; d.turnosCerrados[0]!.cashReceiptsTotal = 0 }).hallazgos.every((h) => h.codigo !== 'MONTO_CUENTA_VENTA') && codigos(con((d) => { d.ventas[0]!.status = 'DEVUELTA'; d.ventas[0]!.reducido = 10; d.cuentas[0]!.status = 'ANULADA'; d.cuentas[0]!.amount = 50; d.clientes[0]!.creditBalance = 0 })).includes('MONTO_CUENTA_VENTA'))
  check('>>> la cuenta de un cliente distinto al de la venta → CLIENTE_CUENTA_VENTA', codigos(con((d) => { d.ventas[0]!.customerId = 'c2' })) === 'CLIENTE_CUENTA_VENTA')
  check('>>> turno cerrado con abonos congelados ≠ enlazados → CIERRE_ABONOS (ERROR)', (() => { const i = con((d) => { d.turnosCerrados[0]!.cashReceiptsTotal = 0 }); return codigos(i) === 'CIERRE_ABONOS' && i.errores === 1 })())
  check('>>> el abono anulado NO cuenta en el cierre; contarlo se detecta', codigos(con((d) => { d.turnosCerrados[0]!.cashReceiptsTotal = 50 })) === 'CIERRE_ABONOS')
  check('el fiado congelado distinto del vigente → CIERRE_FIADO es AVISO, no ERROR', (() => { const i = con((d) => { d.turnosCerrados[0]!.creditSalesTotal = 0 }); return codigos(i) === 'CIERRE_FIADO' && i.errores === 0 && i.avisos === 1 })())
  check('>>> venta ANULADA o DEVUELTA con cuenta ABIERTA → VENTA_ANULADA_CUENTA_VIVA (AVISO); el fiado del turno cerrado NO cambia (cuenta por lo recibido)', ['ANULADA', 'DEVUELTA'].every((st) => { const i = con((d) => { d.ventas[0]!.status = st }); return codigos(i) === 'VENTA_ANULADA_CUENTA_VIVA' && i.errores === 0 }))
  check('>>> una venta anulada con su cuenta ANULADA y el turno intacto → limpio (el caso normal tras una devolución de F6.1)', con((d) => { d.ventas[0]!.status = 'DEVUELTA'; d.cuentas[0]!.status = 'ANULADA'; d.clientes[0]!.creditBalance = 0 }).hallazgos.length === 0)
  check('>>> y si el fiado del turno cerrado se calculara SIN las devueltas, se detectaría (CIERRE_FIADO)', codigos(con((d) => { d.ventas[0]!.status = 'DEVUELTA'; d.cuentas[0]!.status = 'ANULADA'; d.clientes[0]!.creditBalance = 0; d.turnosCerrados[0]!.creditSalesTotal = 0 })) === 'CIERRE_FIADO')
  check('cuenta marcada por nota de crédito sin resolver → REVISION_PENDIENTE (AVISO); una ANULADA ya no', codigos(con((d) => { d.cuentas[0]!.enRevision = true })) === 'REVISION_PENDIENTE' && con((d) => { d.cuentas[0]!.enRevision = true; d.cuentas[0]!.status = 'ANULADA'; d.clientes[0]!.creditBalance = 0 }).hallazgos.length === 0)
  {
    // F6.3b · Un abono anulado DESPUÉS del cierre de su turno sigue contando en lo congelado de ese turno y exige su compensación en caja.
    const mini = (o: Partial<DatosCredito> & { anuladoMs?: number | null; congelado?: number } = {}): DatosCredito => ({
      clientes: [{ id: 'c1', name: 'Ana', creditBalance: 100 }],
      cuentas: [{ id: 'r1', customerId: 'c1', saleId: 'v1', amount: 100, paidAmount: 0, status: 'ABIERTA', enRevision: false }],
      abonos: [{ id: 'a1', customerId: 'c1', amount: 30, method: 'EFECTIVO', anulado: true, cashSessionId: 't1', anuladoMs: o.anuladoMs === undefined ? 2000 : o.anuladoMs }],
      repartos: [{ paymentId: 'a1', receivableId: 'r1', amount: 30 }],
      ventas: [{ id: 'v1', number: 'V-1', status: 'COMPLETADA', customerId: 'c1', cashSessionId: 't1', fiado: 100 }],
      turnosCerrados: [{ id: 't1', cashReceiptsTotal: o.congelado ?? 30, otherReceiptsTotal: 0, creditSalesTotal: 100, cerradoMs: 1000 }],
      ...(o.compensaciones !== undefined ? { compensaciones: o.compensaciones } : {}),
    })
    check('>>> abono anulado DESPUÉS del cierre, con su compensación: limpio (lo congelado de 30 sigue cuadrando con el abono aunque esté anulado)', auditarDatosCredito(mini({ compensaciones: ['a1'] })).hallazgos.length === 0)
    const sinComp = auditarDatosCredito(mini({ compensaciones: [] }))
    check('>>> el mismo abono SIN compensación → ERROR `ABONO_CERRADO_SIN_COMPENSACION` (y solo ese)', sinComp.hallazgos.length === 1 && sinComp.hallazgos[0]!.codigo === 'ABONO_CERRADO_SIN_COMPENSACION' && sinComp.errores === 1)
    check('sin la lista de compensaciones (datos anteriores a F6.3b) no se exige', auditarDatosCredito(mini()).hallazgos.length === 0)
    check('>>> anulado ANTES del cierre: ya no está en lo congelado (0) y no pide compensación; si el cierre lo congeló igual → CIERRE_ABONOS', auditarDatosCredito(mini({ anuladoMs: 500, congelado: 0, compensaciones: [] })).hallazgos.length === 0 && auditarDatosCredito(mini({ anuladoMs: 500, congelado: 30, compensaciones: [] })).hallazgos.map((h) => h.codigo).join() === 'CIERRE_ABONOS')
    check('>>> anulado después del cierre pero con lo congelado en 0 (alguien reescribió el turno) → CIERRE_ABONOS', auditarDatosCredito(mini({ congelado: 0, compensaciones: ['a1'] })).hallazgos.map((h) => h.codigo).join() === 'CIERRE_ABONOS')
  }
  check('>>> se compara en céntimos: 0.1 + 0.2 = 0.3 NO es un descuadre', auditarDatosCredito({ ...base,
    clientes: [{ id: 'c1', name: 'Ana', creditBalance: 0.3 }, base.clientes[1]!],
    cuentas: [{ id: 'r1', customerId: 'c1', saleId: 'v1', amount: 0.3, paidAmount: 0, status: 'ABIERTA', enRevision: false }],
    abonos: [], repartos: [], ventas: [{ id: 'v1', number: 'V', status: 'COMPLETADA', customerId: 'c1', cashSessionId: null, fiado: 0.1 + 0.2 }], turnosCerrados: [] }).hallazgos.length === 0)
  check('todos los códigos tienen gravedad definida y los de dinero que no cuadra son ERROR', Object.keys(GRAVEDAD).length === 13 && GRAVEDAD.ABONO_CERRADO_SIN_COMPENSACION === 'ERROR' && GRAVEDAD.DEUDA_CLIENTE === 'ERROR' && GRAVEDAD.CIERRE_ABONOS === 'ERROR' && GRAVEDAD.REVISION_PENDIENTE === 'AVISO')

  console.log('\nB) Contra la base de datos: un negocio sano pasa limpio')
  const E = await negocio('a')
  const { O, db, cliente, vender, abonar, abrir, cerrar } = E
  const ids = { c1: (await cliente()).id, c2: (await cliente()).id, c3: (await cliente()).id }
  const turno = await abrir(100)
  const f1 = await vender(300, [{ method: 'CREDITO', amount: 300 }], ids.c1)
  await vender(200, [{ method: 'EFECTIVO', amount: 80 }, { method: 'CREDITO', amount: 120 }], ids.c2)
  const f3 = await vender(90, [{ method: 'CREDITO', amount: 90 }], ids.c3)
  await abonar(ids.c1, 100)
  const ab = await abonar(ids.c1, 40, 'YAPE')
  const anul = await abonar(ids.c2, 20)
  await anularAbono(db, O, anularAbonoSchema.parse({ paymentId: anul.paymentId, motivo: 'error de digitación' }))
  await anularCuenta(db, O, anularCuentaSchema.parse({ receivableId: (await prisma.receivable.findFirstOrThrow({ where: { saleId: f3.saleId } })).id, motivo: 'incobrable' }))
  await cerrar(turno.id, 180)
  await vender(50, [{ method: 'EFECTIVO', amount: 50 }])
  const limpioBd = await auditarCoherenciaCredito(db)
  check('>>> tras fiar, abonar, anular un abono, castigar una deuda y cerrar el turno: 0 errores y 0 avisos', limpioBd.errores === 0 && limpioBd.avisos === 0, formatearInformeCredito('a', limpioBd, true))
  check('revisó lo que había: 3 clientes, 3 cuentas, 3 abonos, 1 turno cerrado', limpioBd.clientes === 3 && limpioBd.cuentas === 3 && limpioBd.abonos === 3 && limpioBd.turnosCerrados === 1)
  const salida = spawnSync('npx', ['tsx', 'scripts/auditar-credito.ts', '--negocio', E.t.slug], { encoding: 'utf8', timeout: 180000 })
  check('>>> el script sobre un negocio sano: sale con 0 y dice SOLO LECTURA', salida.status === 0 && /SOLO LECTURA/.test(salida.stdout) && /0 error\(es\)/.test(salida.stdout), `${salida.status} ${salida.stdout.slice(-200)}`)

  console.log('\nC) Se estropea la base a propósito y cada daño se encuentra')
  const O2 = await negocio('b')   // otro negocio, sano: no debe ver nada de lo del primero
  const c2s = await O2.cliente(); await O2.vender(100, [{ method: 'CREDITO', amount: 100 }], c2s.id)
  const cuentaC1 = await prisma.receivable.findFirstOrThrow({ where: { saleId: f1.saleId } })
  const rep = await prisma.paymentAllocation.findFirstOrThrow({ where: { receivable: { id: cuentaC1.id } } })
  const foto = async () => JSON.stringify([
    await prisma.customer.count({ where: { tenantId: E.t.id } }), await prisma.receivable.findMany({ where: { tenantId: E.t.id }, orderBy: { id: 'asc' }, select: { id: true, paidAmount: true, updatedAt: true } }),
    await prisma.customerPayment.count({ where: { tenantId: E.t.id } }), await prisma.paymentAllocation.count({ where: { tenantId: E.t.id } }),
    (await prisma.customer.findMany({ where: { tenantId: E.t.id }, orderBy: { id: 'asc' }, select: { creditBalance: true, updatedAt: true } })),
    (await prisma.cashSession.findMany({ where: { tenantId: E.t.id }, orderBy: { id: 'asc' }, select: { updatedAt: true, cashReceiptsTotal: true } })),
  ])
  const antes = await foto()
  await prisma.customer.update({ where: { id: ids.c3 }, data: { creditBalance: 55 } })                       // deuda inventada
  await prisma.receivable.update({ where: { id: cuentaC1.id }, data: { paidAmount: 150 } })                  // abonado ≠ repartos
  await prisma.paymentAllocation.update({ where: { id: rep.id }, data: { amount: 90 } })                     // reparto ≠ abono
  await prisma.cashSession.update({ where: { id: turno.id }, data: { cashReceiptsTotal: 7 } })               // cierre alterado
  const sucio = await auditarCoherenciaCredito(db)
  const cod = new Set(sucio.hallazgos.map((h) => h.codigo))
  check('>>> encuentra la deuda inventada, lo abonado alterado, el reparto alterado y el cierre alterado', ['DEUDA_CLIENTE', 'ABONADO_CUENTA', 'REPARTO_ABONO', 'CIERRE_ABONOS'].every((x) => cod.has(x as never)), [...cod].join(','))
  check('>>> y señala a quién: la deuda inventada es del cliente 3, el cierre es el del turno', sucio.hallazgos.some((h) => h.codigo === 'DEUDA_CLIENTE' && h.id === ids.c3 && h.encontrado === 55 && h.esperado === 0) && sucio.hallazgos.some((h) => h.codigo === 'CIERRE_ABONOS' && h.id === turno.id))
  const salida2 = spawnSync('npx', ['tsx', 'scripts/auditar-credito.ts', '--negocio', E.t.slug], { encoding: 'utf8', timeout: 180000 })
  check('>>> el script sobre un negocio dañado: sale con código 3 y lista los códigos', salida2.status === 3 && /DEUDA_CLIENTE/.test(salida2.stdout) && /CIERRE_ABONOS/.test(salida2.stdout), `${salida2.status}`)
  const limpioB = await auditarCoherenciaCredito(O2.db)
  check('>>> el otro negocio sigue limpio: la auditoría no mezcla negocios', limpioB.errores === 0 && limpioB.cuentas === 1 && limpioB.hallazgos.length === 0)
  await prisma.receivable.delete({ where: { id: (await prisma.receivable.findFirstOrThrow({ where: { customerId: c2s.id } })).id } })
  check('>>> una venta fiada a la que le borran su cuenta → VENTA_FIADA_SIN_CUENTA (en su negocio)', (await auditarCoherenciaCredito(O2.db)).hallazgos.some((h) => h.codigo === 'VENTA_FIADA_SIN_CUENTA'))
  const fotoDespuesDeAuditar = await foto()
  await auditarCoherenciaCredito(db); await auditarCoherenciaCredito(db)
  check('>>> auditar es de SOLO LECTURA: la base queda idéntica (ni filas ni fechas de modificación) tras auditar dos veces más', (await foto()) === fotoDespuesDeAuditar && antes !== fotoDespuesDeAuditar)
  void ab

  console.log('\nD) Estructura')
  const mod = readFileSync('src/features/credito/auditoria.ts', 'utf8')
  const scr = readFileSync('scripts/auditar-credito.ts', 'utf8')
  check('>>> el módulo y el script NO escriben: ni create/update/delete/upsert, ni SQL crudo, ni transacciones', !/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(|\$executeRaw|\$queryRaw|\$transaction/.test(mod + scr))
  check('el script usa solo el cliente aislado por negocio y avisa que es solo lectura', scr.includes('getTenantPrisma') && scr.includes('SOLO LECTURA'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
