import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { registerSale } from '../src/features/pos/sale-service'
import { anularAbono, configurarCredito, registrarAbono } from '../src/features/credito/credito-service'
import { anularAbonoSchema, configurarCreditoSchema, registrarAbonoSchema } from '../src/features/credito/schemas'
import { registrarPagoProveedor } from '../src/features/por-pagar/pagos'
import { registrarPagoSchema } from '../src/features/por-pagar/schemas'
import { crearBorrador, recibirCompra } from '../src/features/compras/service'
import { crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { crearProveedor } from '../src/features/proveedores/service'
import { crearProveedorSchema } from '../src/features/proveedores/schemas'
import { registrarMovimientoCaja } from '../src/features/branches/cash-movement-service'
import { registrarMovimientoCajaSchema } from '../src/features/branches/cash-movement-schemas'
import { anularOdevolverVenta } from '../src/features/devoluciones/service'
import { anularOdevolverVentaSchema, devolverProductosSchema } from '../src/features/devoluciones/schemas'
import { devolverProductosVenta } from '../src/features/devoluciones/parcial-service'
import { closeCashSession, currentCashSession, openCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { crearCaja, darDeBajaCaja } from '../src/features/branches/cajas-service'
import { createBranch } from '../src/features/branches/branch-service'
import { completarRuc } from '../src/lib/documentos'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.8b · El turno PROPIO es obligatorio. Toda operación que mueve dinero (cobros de cualquier medio, abonos, pagos a proveedor, movimientos manuales, devoluciones que sacan dinero y
 * compensaciones) entra al turno abierto de QUIEN la ejecuta, en la sucursal donde la ejecuta, o se niega con `CASH_REQUIRED` sin escribir nada. El turno de otra persona no sirve; el propio
 * en otra sucursal tampoco. Además: abrir con una caja elegida, cierre que congela el desglose, y la carrera entre cobrar y cerrar.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '').catch((e) => String(e.message ?? e))
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `tp-${randomUUID().slice(0, 8)}`, name: 'Turno propio', taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_tp' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { seriesNumber: 2, branchCode: 'S2', almacenCode: 'A2', establishmentCode: '0002' })
  const mk = async (role: Role, nombre: string) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${nombre}-${randomUUID()}@x.com`.toLowerCase(), name: nombre, role } })
    for (const b of [b1.branch.id, b2.branch.id]) await asignarSucursal(t.id, u.id, b)
    return u
  }
  const [owner, ana, beto, sin] = [await mk('OWNER', 'Dueño'), await mk('CAJERO', 'Ana'), await mk('CAJERO', 'Beto'), await mk('CAJERO', 'Sin turno')]
  const ctx = (u: { id: string }, role: Role, branchId: string): TenantContext => ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: ['credito.cobrar', 'credito.otorgar', 'proveedores.pagar', 'ventas.anular', 'caja.movimientos'] as never })
  const O = ctx(owner, 'OWNER', b1.branch.id), A = ctx(ana, 'CAJERO', b1.branch.id), B = ctx(beto, 'CAJERO', b1.branch.id), S = ctx(sin, 'CAJERO', b1.branch.id)
  const db = (c: TenantContext) => getTenantPrisma(c)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Producto', salePrice: 100, costPrice: 40, taxRate: 0 } })
  for (const w of [b1.warehouse, b2.warehouse]) await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: w.id, quantity: 1000 } })
  const cliente = await prisma.customer.create({ data: { tenantId: t.id, name: 'Cliente fiado', docType: 'DNI', docNumber: '41300001', creditLimit: 5000 } })
  await configurarCredito(db(O), O, configurarCreditoSchema.parse({ customerId: cliente.id, creditLimit: 5000, creditTermDays: 30, bloqueado: false }))

  const vender = (c: TenantContext, method: string, monto = 100, over: Record<string, unknown> = {}, wh = b1.warehouse.id) =>
    registerSale(db(c), c, { warehouseId: wh, customerId: method === 'CREDITO' ? cliente.id : null, items: [{ productId: prod.id, quantity: monto / 100, discount: 0 }], payments: [{ method, amount: monto }], documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID(), ...over } as never)
  const abrir = (c: TenantContext, fondo = 100, over: Record<string, unknown> = {}) => openCashSession(db(c), c, openCashSchema.parse({ openingAmount: fondo, ...over }))
  const cerrar = (c: TenantContext, sessionId: string, contado: number) => closeCashSession(db(c), c, closeCashSchema.parse({ sessionId, countedAmount: contado }))
  const cajaLibreDe = async () => { const c = await prisma.cashRegister.findFirst({ where: { branchId: b1.branch.id, deletedAt: null, isActive: true, sessions: { none: { status: 'ABIERTA' } } }, select: { id: true } }); return c ? { registerId: c.id } : {} }
  const foto = async () => ({
    ventas: await prisma.sale.count({ where: { tenantId: t.id } }), abonos: await prisma.customerPayment.count({ where: { tenantId: t.id } }),
    pagos: await prisma.supplierPayment.count({ where: { tenantId: t.id } }), movs: await prisma.cashMovement.count({ where: { tenantId: t.id } }),
    devs: await prisma.saleReturn.count({ where: { tenantId: t.id } }), stock: num((await prisma.stock.findMany({ where: { tenantId: t.id }, select: { quantity: true } })).reduce((s, x) => s + num(x.quantity), 0) as never),
  })

  console.log('\n1) Sin turno propio no se cobra, con ningún medio (ni a fiado)')
  const f0 = await foto()
  const medios = ['EFECTIVO', 'YAPE', 'PLIN', 'TARJETA_DEBITO', 'TRANSFERENCIA', 'CREDITO']
  const r1 = await Promise.all(medios.map((m) => code(vender(S, m))))
  check('>>> efectivo, Yape, Plin, tarjeta, transferencia y FIADO sin turno → CASH_REQUIRED', r1.every((r) => r === 'CASH_REQUIRED'), JSON.stringify(r1))
  check('>>> y no dejan venta, pago, deuda ni cambio de stock', JSON.stringify(await foto()) === JSON.stringify(f0) && num((await prisma.customer.findUniqueOrThrow({ where: { id: cliente.id } })).creditBalance) === 0)
  check('>>> el mensaje dice qué hacer y no muestra costos', /propio turno de caja/.test(await msg(vender(S, 'EFECTIVO'))) && !/costo|40/.test(await msg(vender(S, 'EFECTIVO'))))

  console.log('\n2) El turno de OTRA persona no sirve; el propio en otra sucursal tampoco')
  const turnoAna = await abrir(A, 200)
  check('>>> Beto, con el turno de Ana abierto en SU sucursal, no puede cobrar', await code(vender(B, 'EFECTIVO')) === 'CASH_REQUIRED' && await code(vender(B, 'YAPE')) === 'CASH_REQUIRED')
  const A2 = { ...A, branchId: b2.branch.id }
  const rOtra = await msg(vender(A2, 'EFECTIVO', 100, {}, b2.warehouse.id))
  check('>>> Ana, con su turno en la sucursal 1, no cobra en la sucursal 2 y el mensaje se lo explica', /otra sucursal/.test(rOtra) && await code(vender(A2, 'EFECTIVO', 100, {}, b2.warehouse.id)) === 'CASH_REQUIRED')

  console.log('\n3) El dinero va al turno de QUIEN lo ejecuta')
  const turnoBeto = await abrir(B, 50, { registerId: (await prisma.cashRegister.create({ data: { tenantId: t.id, branchId: b1.branch.id, name: 'Caja 2' } })).id })
  const vA = await vender(A, 'EFECTIVO', 300), vB = await vender(B, 'YAPE', 500)
  const sA = await prisma.sale.findUniqueOrThrow({ where: { id: vA.saleId } }), sB = await prisma.sale.findUniqueOrThrow({ where: { id: vB.saleId } })
  check('>>> la venta de Ana cae en el turno de Ana y la de Beto en el de Beto', sA.cashSessionId === turnoAna.id && sB.cashSessionId === turnoBeto.id)
  const fiada = await vender(A, 'CREDITO', 200)
  check('>>> el fiado también queda en el turno de quien lo vende', (await prisma.sale.findUniqueOrThrow({ where: { id: fiada.saleId } })).cashSessionId === turnoAna.id)
  const curA = await currentCashSession(db(A), A), curB = await currentCashSession(db(B), B), curS = await currentCashSession(db(S), S)
  check('>>> cada uno ve SU turno en vivo (Ana: 200+300 de efectivo; Beto: 50 de fondo y Yape no entra al cajón); quien no tiene, nada', curA?.id === turnoAna.id && curA.expectedAmount === 500 && curB?.id === turnoBeto.id && curB.expectedAmount === 50 && curS === null)

  console.log('\n4) Abonos, pagos a proveedor y movimientos: turno propio con cualquier medio')
  const abonar = (c: TenantContext, method: string, amount = 50) => registrarAbono(db(c), c, registrarAbonoSchema.parse({ customerId: cliente.id, method, amount, idempotencyKey: randomUUID() }))
  const f1 = await foto()
  const r4 = await Promise.all(['EFECTIVO', 'YAPE', 'TRANSFERENCIA'].map((m) => code(abonar(S, m))))
  check('>>> abonos de cliente sin turno propio (efectivo, Yape, transferencia) → CASH_REQUIRED', r4.every((r) => r === 'CASH_REQUIRED'), JSON.stringify(r4))
  const ab = await abonar(B, 'YAPE', 60)
  check('>>> el abono por Yape de Beto queda en el turno de Beto', (await prisma.customerPayment.findFirstOrThrow({ where: { id: ab.paymentId } })).cashSessionId === turnoBeto.id)
  const abMal = await abonar(B, 'YAPE', 10)
  await anularAbono(db(O), O, anularAbonoSchema.parse({ paymentId: abMal.paymentId, motivo: 'Error de digitación' }))   // anulado en su turno abierto: no cuenta

  const proveedor = await crearProveedor(db(O), O, crearProveedorSchema.parse({ name: 'Proveedor TP', taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`) }))
  const pe = await prisma.product.create({ data: { tenantId: t.id, sku: 'P2', name: 'Para compra', unitType: 'UNIDAD', salePrice: 20, costPrice: 0, taxRate: 0 } })
  const compra = await crearBorrador(db(O), O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: b1.warehouse.id, supplierId: proveedor.id, paymentCondition: 'CREDITO', vence: '2027-06-01', items: [{ productId: pe.id, enteredQuantity: 1, unitCost: 400 }] }))
  await recibirCompra(db(O), O, recibirCompraSchema.parse({ purchaseId: compra.id }))
  const pagar = (c: TenantContext, method: string, amount = 30) => registrarPagoProveedor(db(c), c, registrarPagoSchema.parse({ supplierId: proveedor.id, amount, method, idempotencyKey: randomUUID() }))
  const r5 = await Promise.all(['EFECTIVO', 'TRANSFERENCIA', 'YAPE'].map((m) => code(pagar(S, m))))
  check('>>> pagos a proveedor sin turno propio (efectivo, transferencia, Yape) → CASH_REQUIRED', r5.every((r) => r === 'CASH_REQUIRED'), JSON.stringify(r5))
  const pp = await pagar(A, 'TRANSFERENCIA', 100)
  check('>>> el pago por transferencia de Ana queda en el turno de Ana (y no en el de Beto)', (await prisma.supplierPayment.findFirstOrThrow({ where: { id: pp.paymentId } })).cashSessionId === turnoAna.id)

  const mov = (c: TenantContext, o: Record<string, unknown> = {}) => registrarMovimientoCaja(db(c), c, registrarMovimientoCajaSchema.parse({ kind: 'EGRESO', category: 'GASTO_MENOR', amount: 10, description: 'Bolsas', idempotencyKey: randomUUID(), ...o }))
  check('>>> un movimiento manual sin turno propio → CASH_REQUIRED; con él, entra a ese turno', await code(mov(S)) === 'CASH_REQUIRED' && (await prisma.cashMovement.findFirstOrThrow({ where: { id: (await mov(B)).id } })).cashSessionId === turnoBeto.id)
  check('>>> nada de lo rechazado dejó filas (abonos, pagos, movimientos nuevos son solo los válidos)', (await foto()).abonos === f1.abonos + 2 && (await foto()).pagos === f1.pagos + 1 && (await foto()).movs === f1.movs + 1)

  console.log('\n5) Devoluciones que sacan dinero')
  const devolver = (c: TenantContext, saleId: string, refunds?: unknown) => anularOdevolverVenta(db(c), c, anularOdevolverVentaSchema.parse({ saleId, kind: 'DEVOLUCION', reason: 'El cliente devolvió la mercadería', idempotencyKey: randomUUID(), ...(refunds ? { refunds } : {}) }))
  const f2 = await foto()
  check('>>> devolver una venta en efectivo sin turno propio → CASH_REQUIRED y la venta sigue completa', await code(devolver(S, vA.saleId)) === 'CASH_REQUIRED' && (await prisma.sale.findUniqueOrThrow({ where: { id: vA.saleId } })).status === 'COMPLETADA')
  check('>>> devolver lo pagado con Yape por el mismo medio (externo) sin turno propio → también CASH_REQUIRED', await code(devolver(S, vB.saleId)) === 'CASH_REQUIRED')
  check('>>> sin cambios en devoluciones ni stock tras los rechazos', JSON.stringify(await foto()) === JSON.stringify(f2))
  check('>>> devolver una venta TODA fiada (no mueve dinero) no exige turno propio', (await code(devolver(S, fiada.saleId))) !== 'CASH_REQUIRED')
  // El efectivo sale de la caja de QUIEN devuelve, no de la de quien vendió: Beto devuelve la venta en efectivo de Ana y sale de SU turno.
  const dev = await devolver(B, vA.saleId)
  const reembolso = await prisma.saleReturnRefund.findFirstOrThrow({ where: { returnId: dev.returnId } })
  check('>>> el efectivo de la devolución sale del turno de quien devuelve (Beto), no del de quien vendió (Ana)', reembolso.cashSessionId === turnoBeto.id && reembolso.mode === 'CAJA' && num(reembolso.amount) === 300)
  const devA = await devolver(A, vB.saleId)
  check('>>> y la devolución por Yape de la venta de Beto se anota en el turno de Ana, que la ejecutó', (await prisma.saleReturnRefund.findFirstOrThrow({ where: { returnId: devA.returnId } })).cashSessionId === turnoAna.id)

  console.log('\n6) Abrir turno: la caja, una por persona y una por caja')
  const cajaPrincipal = await prisma.cashRegister.findFirstOrThrow({ where: { branchId: b1.branch.id, name: 'Caja principal' } })
  check('>>> el turno de Ana está en la caja principal y el de Beto en «Caja 2»', (await prisma.cashSession.findUniqueOrThrow({ where: { id: turnoAna.id } })).registerId === cajaPrincipal.id)
  check('>>> una persona con turno abierto no abre otro (aunque sea en otra caja o sucursal)', await code(abrir(A)) === 'DUPLICATE_CODE' && /Ya tienes un turno/.test(await msg(abrir(A2, 10))))
  check('>>> una caja con turno abierto no abre otro turno', /Esa caja ya tiene/.test(await msg(abrir(S, 10, { registerId: cajaPrincipal.id }))))
  check('>>> con dos cajas en la sucursal hay que elegir cuál', /elige en cuál/.test(await msg(abrir(S, 10))))
  const cajaOtraSuc = await prisma.cashRegister.create({ data: { tenantId: t.id, branchId: b2.branch.id, name: 'Caja de la 2' } })
  check('>>> una caja de OTRA sucursal, una inexistente o una dada de baja se rechazan', await code(abrir(S, 10, { registerId: cajaOtraSuc.id })) === 'NOT_FOUND' && await code(abrir(S, 10, { registerId: 'no-existe' })) === 'NOT_FOUND')
  const cajaTres = await crearCaja(db(O), O, { branchId: b1.branch.id, name: 'Caja 3' })
  await darDeBajaCaja(db(O), O, { registerId: cajaTres.id })
  check('>>> (la dada de baja)', await code(abrir(S, 10, { registerId: cajaTres.id })) === 'NOT_FOUND')
  const cajaInactiva = await prisma.cashRegister.create({ data: { tenantId: t.id, branchId: b1.branch.id, name: 'Inactiva', isActive: false } })
  const cajaBorrada = await prisma.cashRegister.create({ data: { tenantId: t.id, branchId: b1.branch.id, name: 'Borrada', deletedAt: new Date() } })
  check('>>> una caja inactiva, o con baja lógica aunque siga «activa», tampoco sirve para abrir', await code(abrir(S, 10, { registerId: cajaInactiva.id })) === 'NOT_FOUND' && await code(abrir(S, 10, { registerId: cajaBorrada.id })) === 'NOT_FOUND')
  const cajaLibre = await crearCaja(db(O), O, { branchId: b1.branch.id, name: 'Caja 4' })
  const turnoSin = await abrir(S, 10, { registerId: cajaLibre.id })
  check('>>> en una caja libre, con la caja elegida, abre y puede cobrar enseguida', (await prisma.cashSession.findUniqueOrThrow({ where: { id: turnoSin.id } })).registerId === cajaLibre.id && await code(vender(S, 'PLIN')) === null)
  const auditoriaAbrir = await prisma.auditLog.findFirst({ where: { tenantId: t.id, action: 'cash.open', entityId: turnoSin.id } })
  check('>>> la apertura queda auditada con la caja', JSON.stringify(auditoriaAbrir?.after ?? {}).includes(cajaLibre.id))

  console.log('\n7) Cerrar: cada turno cuadra solo con lo suyo y el desglose queda congelado')
  const cierreA = await cerrar(A, turnoAna.id, 0)
  const filaA = await prisma.cashSession.findUniqueOrThrow({ where: { id: turnoAna.id } })
  const desgl = filaA.closingBreakdown as Record<string, any> | null
  check('>>> el cierre de Ana cuenta sus 2 ventas (no las de Beto), con el desglose guardado', cierreA.salesCount === 2 && desgl?.version === 1 && desgl.ventas.cantidad === 2, JSON.stringify(desgl?.ventas))
  check('>>> el desglose de Ana separa el fiado y la devolución por otro medio que ella ejecutó', desgl?.ventasPorMetodo.CREDITO.monto === 200 && desgl.ventasPorMetodo.EFECTIVO.monto === 300 && desgl.devoluciones.delCajon === 0 && desgl.devoluciones.porOtroMedio === 500)
  check('>>> y no trae costos ni márgenes', !/costPrice|unitCost|margen|ganancia/i.test(JSON.stringify(desgl)))
  const congelado = JSON.stringify(desgl)
  await vender(B, 'EFECTIVO', 100)
  check('>>> un turno cerrado no cambia: lo que pase después en otros turnos no toca su desglose', JSON.stringify((await prisma.cashSession.findUniqueOrThrow({ where: { id: turnoAna.id } })).closingBreakdown) === congelado)
  const cierreB = await cerrar(B, turnoBeto.id, 0)
  const desB = (await prisma.cashSession.findUniqueOrThrow({ where: { id: turnoBeto.id } })).closingBreakdown as Record<string, any>
  check('>>> el desglose de Beto muestra el Yape aparte y la devolución que salió de SU cajón', desB.ventasPorMetodo.YAPE.monto === 500 && desB.abonosPorMetodo.YAPE.monto === 60 && desB.abonosPorMetodo.YAPE.operaciones === 1 && desB.devoluciones.delCajon === 300 && cierreB.salesCount === 2)

  console.log('\n8) Cobrar justo mientras se cierra: nunca queda dinero en un turno cerrado')
  const t2 = await abrir(A, 0, { registerId: cajaPrincipal.id })
  const choque = await Promise.all([
    cerrar(A, t2.id, 0).then(() => 'cerro').catch((e) => e.code),
    ...Array.from({ length: 6 }, () => vender(A, 'EFECTIVO', 100).then(() => 'vendio').catch((e) => e.code)),
  ])
  const fila2 = await prisma.cashSession.findUniqueOrThrow({ where: { id: t2.id } })
  const ventasEn = await prisma.sale.count({ where: { cashSessionId: t2.id } })
  check('>>> cada venta aceptada quedó contada en el cierre; las demás se negaron con CASH_REQUIRED', fila2.status === 'CERRADA' && fila2.salesCount === ventasEn && choque.filter((r) => r === 'vendio').length === ventasEn && choque.filter((r) => r !== 'cerro' && r !== 'vendio').every((r) => r === 'CASH_REQUIRED'), JSON.stringify([choque, ventasEn, fila2.salesCount]))
  check('>>> y tras el cierre, Ana ya no puede cobrar', await code(vender(A, 'YAPE')) === 'CASH_REQUIRED')

  console.log('\n9) Reintento idempotente: no pide turno para devolver lo ya hecho')
  const clave = randomUUID()
  const t3 = await abrir(A, 0, { registerId: cajaPrincipal.id })
  const v1 = await vender(A, 'EFECTIVO', 100, { idempotencyKey: clave })
  await cerrar(A, t3.id, 100)
  const v2 = await vender(A, 'EFECTIVO', 100, { idempotencyKey: clave })
  check('>>> repetir un cobro ya registrado devuelve la misma venta aunque el turno ya cerró', v1.saleId === v2.saleId && v2.replayed === true)

  console.log('\n9b) Devolución PARCIAL: el dinero sale del turno de quien la ejecuta')
  const t4 = await abrir(A, 0, { registerId: cajaPrincipal.id })
  const tB4 = await abrir(B, 0, { ...(await cajaLibreDe()) })
  const vB2 = await vender(B, 'YAPE', 100)
  const itemB2 = await prisma.saleItem.findFirstOrThrow({ where: { saleId: vB2.saleId } })
  const parcial = await devolverProductosVenta(db(A), A, devolverProductosSchema.parse({ saleId: vB2.saleId, reason: 'Devolución parcial', lines: [{ saleItemId: itemB2.id, quantity: 1 }], idempotencyKey: randomUUID(), refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 100 }] }))
  const refP = await prisma.saleReturnRefund.findFirstOrThrow({ where: { returnId: parcial.returnId } })
  check('>>> el reembolso de la devolución parcial se anota en el turno de Ana, que la ejecutó, no en el de Beto que vendió', refP.cashSessionId === t4.id && refP.cashSessionId !== tB4.id)

  console.log('\n10) Sucursales nuevas nacen con su «Caja principal»')
  const OT = { ...O, branchIds: undefined as never }
  const nueva = await createBranch(db(OT), OT, { code: 'NUEVA', name: 'Nueva', establishmentCode: '0009', crearAlmacen: true } as never)
  const cajas = await prisma.cashRegister.findMany({ where: { branchId: nueva.id } })
  check('>>> la sucursal creada trae exactamente una caja llamada «Caja principal»', cajas.length === 1 && cajas[0]!.name === 'Caja principal')
}

async function main() {
  try { await cuerpo() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? e.message.slice(0, 300) : e}`, false) }
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
