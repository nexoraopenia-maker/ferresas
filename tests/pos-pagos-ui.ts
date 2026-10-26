import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { configurarCredito, infoCreditoCliente, validarFiado } from '../src/features/credito/credito-service'
import { configurarCreditoSchema } from '../src/features/credito/schemas'
import { construirInfoCredito, motivoNoCabe, resumenVencido, type ClienteCredito } from '../src/features/credito/reglas'
import { openCashSession } from '../src/features/branches/cash-service'
import { openCashSchema } from '../src/features/branches/cash-schemas'
import { resolverPagos, MENSAJE_FIADO_CLIENTE, MENSAJE_FIADO_EXACTO, MENSAJE_FIADO_FACTURA, MENSAJE_FIADO_UNA_LINEA, type MetodoPago } from '../src/features/pos/pagos'
import { conFiadoPorElSaldo, disponibilidadFiado, evaluarPagos, lineaUnica, lineasConImporte, saldoPorCobrar, type LineaPago } from '../src/features/pos/pagos-ui'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 3, subpaso 4.1: el módulo puro de pagos de la pantalla y la ficha de crédito del cliente (solo lectura).
 * Lo que más importa: la pantalla decide con la MISMA función que el servidor (nunca "listo" para que el servidor rechace),
 * "Fiado por el saldo" calcula al céntimo, y la ficha de crédito no se ve sin permiso ni cruza de negocio.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (f: () => unknown): string | null => { try { f(); return null } catch (e) { return (e as Error).message } }

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: { slug: `pu-${tag}-${randomUUID().slice(0, 6)}`, name: `PosUi ${tag}`, legalName: `POSUI ${tag.toUpperCase()} SAC`, taxId, planId: plan.id } })
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
  const abrir = (fondo: number) => openCashSession(db, O, openCashSchema.parse({ openingAmount: fondo }))
  const ctxDe = (u: { id: string }, role: Role, extra: TenantContext['permisosExtra'] = []): TenantContext =>
    ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: extra })
  const almU = await mk('ALMACENERO'), cajU = await mk('CAJERO')
  return { t, b1, owner, O, db, prod, cliente, vender, abrir, Alm: ctxDe(almU, 'ALMACENERO'), Caj: ctxDe(cajU, 'CAJERO'), Caj2: ctxDe(cajU, 'CAJERO', ['credito.otorgar']) }
}



async function main() {
  const L = (method: MetodoPago, amount: number): LineaPago => ({ method, amount })
  const lim = (n: number) => Math.round(n * 100) / 100

  console.log('\nA) El cobro de un toque sigue igual')
  check('>>> efectivo sin teclear «recibido» → el total exacto; con recibido mayor → ese monto (habrá vuelto)', lineaUnica('EFECTIVO', 63.3)[0]!.amount === 63.3 && lineaUnica('EFECTIVO', 63.3, 100)[0]!.amount === 100)
  check('efectivo con recibido MENOR que el total → se cobra el total (no queda corto)', lineaUnica('EFECTIVO', 63.3, 50)[0]!.amount === 63.3)
  check('>>> Yape o tarjeta: siempre el total, aunque hubiera un «recibido» tecleado antes', lineaUnica('YAPE', 63.3, 100)[0]!.amount === 63.3 && lineaUnica('TARJETA_DEBITO', 63.3, 100)[0]!.amount === 63.3)

  console.log('\nB) Estado de los pagos: la pantalla decide con la función del servidor')
  const e0 = evaluarPagos(100, [])
  check('sin líneas → falta todo', e0.estado === 'FALTA' && e0.falta === 100)
  check('>>> una fila recién añadida (importe 0 o vacío) no cuenta', evaluarPagos(100, [L('EFECTIVO', 40), L('YAPE', 0), L('PLIN', NaN)]).estado === 'FALTA' && lineasConImporte([L('YAPE', 0), L('PLIN', NaN), L('EFECTIVO', 5)]).length === 1)
  const e1 = evaluarPagos(100, [L('EFECTIVO', 0.1), L('YAPE', 0.2)])
  check('>>> falta al céntimo: 100 − (0.10 + 0.20) = 99.70 (sin ruido de flotantes)', e1.estado === 'FALTA' && e1.falta === 99.7, JSON.stringify(e1))
  const e2 = evaluarPagos(63.3, [L('EFECTIVO', 100)])
  check('>>> efectivo 100 sobre 63.30 → LISTO con vuelto 36.70', e2.estado === 'LISTO' && e2.vuelto === 36.7 && e2.fiado === 0)
  const e3 = evaluarPagos(100, [L('YAPE', 50), L('EFECTIVO', 60)])
  check('>>> [Yape 50, efectivo 60] sobre 100 → vuelto 10 repartido en el efectivo (el caso del bug histórico)', e3.estado === 'LISTO' && e3.vuelto === 10 && e3.resueltos.find((p) => p.method === 'EFECTIVO')!.change === 10 && e3.resueltos.find((p) => p.method === 'YAPE')!.change === 0)
  const e4 = evaluarPagos(100, [L('YAPE', 120)])
  check('>>> Yape de más → ERROR con el mismo mensaje del servidor (solo el efectivo da vuelto)', e4.estado === 'ERROR' && e4.mensaje === msg(() => resolverPagos(100, [L('YAPE', 120)])))
  const e5 = evaluarPagos(100, [L('CREDITO', 50), L('CREDITO', 50)], { conCliente: true })
  check('dos líneas de fiado → ERROR «una sola línea»', e5.estado === 'ERROR' && e5.mensaje === MENSAJE_FIADO_UNA_LINEA)
  const e6 = evaluarPagos(100, [L('CREDITO', 100)])
  check('>>> fiado sin cliente → ERROR con el mensaje y el código del servidor (CREDIT_CUSTOMER)', e6.estado === 'ERROR' && e6.mensaje === MENSAJE_FIADO_CLIENTE && e6.codigo === 'CREDIT_CUSTOMER')
  check('fiado con factura → ERROR', (() => { const e = evaluarPagos(100, [L('CREDITO', 100)], { conCliente: true, documentType: 'FACTURA' }); return e.estado === 'ERROR' && e.mensaje === MENSAJE_FIADO_FACTURA })())
  check('>>> fiado con sobrepago en efectivo → ERROR «cuadrar exacto»', (() => { const e = evaluarPagos(100, [L('EFECTIVO', 60), L('CREDITO', 50)], { conCliente: true }); return e.estado === 'ERROR' && e.mensaje === MENSAJE_FIADO_EXACTO })())
  check('>>> efectivo 30 + fiado 70 sobre 100 → LISTO, fiado 70, sin vuelto', (() => { const e = evaluarPagos(100, [L('EFECTIVO', 30), L('CREDITO', 70)], { conCliente: true }); return e.estado === 'LISTO' && e.fiado === 70 && e.vuelto === 0 })())
  check('un importe con 3 decimales → ERROR (no se redondea en silencio)', evaluarPagos(100, [L('EFECTIVO', 100.005)]).estado === 'ERROR')

  console.log('\nC) «Fiado por el saldo»')
  check('>>> total 100 con efectivo 30 → una línea de fiado por 70', JSON.stringify(conFiadoPorElSaldo(100, [L('EFECTIVO', 30)])) === JSON.stringify([L('EFECTIVO', 30), L('CREDITO', 70)]))
  check('sin otras líneas → fiado por el total', JSON.stringify(conFiadoPorElSaldo(100, [])) === JSON.stringify([L('CREDITO', 100)]))
  check('>>> reemplaza el fiado anterior (nunca dos líneas) y recalcula si cambió el efectivo', JSON.stringify(conFiadoPorElSaldo(100, [L('EFECTIVO', 45), L('CREDITO', 70)])) === JSON.stringify([L('EFECTIVO', 45), L('CREDITO', 55)]))
  check('>>> si ya está todo cobrado (o sobrecobrado) no deja una línea de fiado en cero: la quita', JSON.stringify(conFiadoPorElSaldo(100, [L('EFECTIVO', 100), L('CREDITO', 5)])) === JSON.stringify([L('EFECTIVO', 100)]) && JSON.stringify(conFiadoPorElSaldo(100, [L('EFECTIVO', 120)])) === JSON.stringify([L('EFECTIVO', 120)]))
  check('>>> al céntimo: total 100, cobrado 0.10 + 0.20 → saldo 99.70', saldoPorCobrar(100, [L('EFECTIVO', 0.1), L('YAPE', 0.2)]) === 99.7 && conFiadoPorElSaldo(100, [L('EFECTIVO', 0.1), L('YAPE', 0.2)]).at(-1)!.amount === 99.7)
  check('el saldo no cuenta la propia línea de fiado', saldoPorCobrar(100, [L('EFECTIVO', 30), L('CREDITO', 70)]) === 70)

  console.log('\nD) Cuándo se ofrece el fiado')
  check('>>> sin permiso → no se ofrece y no explica nada; sin cliente, con factura y desde un pedido → no, con su motivo',
    !disponibilidadFiado({ puedeFiar: false, conCliente: true }).ofrece && disponibilidadFiado({ puedeFiar: false, conCliente: true }).motivo === null
    && /Asigna un cliente/.test(disponibilidadFiado({ puedeFiar: true, conCliente: false })!.motivo!) && /factura/i.test(disponibilidadFiado({ puedeFiar: true, conCliente: true, documentType: 'FACTURA' })!.motivo!)
    && /POS/.test(disponibilidadFiado({ puedeFiar: true, conCliente: true, enPedido: true })!.motivo!)
    && disponibilidadFiado({ puedeFiar: true, conCliente: true, documentType: 'BOLETA' }).ofrece)

  console.log('\nE) Propiedad: la pantalla y el servidor nunca discrepan (2 000 casos al azar)')
  let n = 0, malos = 0, ejemplo = ''
  const metodos: MetodoPago[] = ['EFECTIVO', 'YAPE', 'PLIN', 'TARJETA_DEBITO', 'TRANSFERENCIA', 'CREDITO']
  for (let i = 0; i < 2000; i++) {
    const total = (1 + Math.floor(Math.random() * 50000)) / 100
    const k = 1 + Math.floor(Math.random() * 3)
    const lineas: LineaPago[] = Array.from({ length: k }, () => L(metodos[Math.floor(Math.random() * metodos.length)]!, (Math.floor(Math.random() * (Math.round(total * 100) + 3000))) / 100))
    const op = { conCliente: Math.random() < 0.7, documentType: Math.random() < 0.2 ? 'FACTURA' : 'NOTA_VENTA' }
    const ui = evaluarPagos(total, lineas, op)
    const v = lineasConImporte(lineas)
    let srv: 'OK' | string = 'OK'
    try { if (v.length) resolverPagos(total, v, op); else srv = 'vacio' } catch (e) { srv = (e as Error).message }
    const suma = v.reduce((a, l) => a + Math.round(l.amount * 100), 0)
    const esperado = v.length === 0 || suma < Math.round(total * 100) ? 'FALTA' : srv === 'OK' ? 'LISTO' : 'ERROR'
    n++
    if (ui.estado !== esperado || (ui.estado === 'ERROR' && ui.mensaje !== srv) || (ui.estado === 'LISTO' && lim(ui.pagado - ui.vuelto) !== lim(total))) { malos++; ejemplo ||= JSON.stringify({ total, lineas, op, ui, srv }) }
  }
  check(`>>> en ${n} casos: FALTA/LISTO/ERROR coinciden con lo que haría resolverPagos, con su mismo mensaje, y siempre Σ pagos − vuelto = total`, malos === 0, ejemplo)
  let nFiado = 0, rotos = 0
  for (let i = 0; i < 1000; i++) {
    const total = (1 + Math.floor(Math.random() * 50000)) / 100
    const lineas: LineaPago[] = Array.from({ length: Math.floor(Math.random() * 3) }, () => L(metodos.filter((m) => m !== 'CREDITO')[Math.floor(Math.random() * 5)]!, Math.floor(Math.random() * Math.round(total * 100)) / 100))
    const r = evaluarPagos(total, conFiadoPorElSaldo(total, lineas), { conCliente: true, documentType: 'NOTA_VENTA' })
    const cobrado = lineasConImporte(lineas).reduce((a, l) => a + Math.round(l.amount * 100), 0)
    nFiado++
    if (cobrado < Math.round(total * 100)) { if (!(r.estado === 'LISTO' && r.vuelto === 0 && lim(r.fiado) === lim(total - cobrado / 100))) rotos++ }
    else if (r.estado === 'ERROR' && /fiado|cuadrar|línea de fiado/i.test(r.mensaje)) rotos++
  }
  check(`>>> en ${nFiado} cobros parciales, «Fiado por el saldo» SIEMPRE da un cobro válido que cuadra al céntimo, sin vuelto`, rotos === 0, `${rotos} rotos`)

  console.log('\nF) La ficha de crédito (reglas puras)')
  const cli = (o: Partial<ClienteCredito> = {}): ClienteCredito => ({ name: 'Ana', docType: 'DNI', docNumber: '41300001', isActive: true, deletedAt: null, creditLimit: 500, creditBalance: 200, creditBlockedAt: null, creditTermDays: 20, ...o })
  const info = (o: Partial<ClienteCredito> = {}, cuentas: Parameters<typeof construirInfoCredito>[2] = [], hoy = '2026-10-25') => construirInfoCredito('c', cli(o), cuentas, hoy)
  const i1 = info()
  check('>>> línea 500, deuda 200 → disponible 300, plazo 20 → vencería el 14/11/2026, se puede fiar', i1.limite === 500 && i1.deuda === 200 && i1.disponible === 300 && i1.venceSiFia === '2026-11-14' && i1.puedeFiar && i1.motivo === null, JSON.stringify(i1))
  check('>>> con la línea agotada: disponible 0 y puedeFiar = false con el mensaje del servidor', (() => { const i = info({ creditBalance: 500 }); return i.disponible === 0 && !i.puedeFiar && i.motivo === msg(() => validarFiado(cli({ creditBalance: 500 }), 0.01)) })())
  check('sin línea, bloqueado, sin documento y de baja: cada uno con su motivo (los mismos del servidor)', [{ creditLimit: 0 }, { creditBlockedAt: new Date() }, { docType: 'SIN_DOCUMENTO', docNumber: null }, { deletedAt: new Date() }].every((o) => { const i = info(o as Partial<ClienteCredito>); return !i.puedeFiar && i.motivo === msg(() => validarFiado(cli(o as Partial<ClienteCredito>), 0.01)) }))
  check('>>> deuda VENCIDA: suma los saldos de las cuentas abiertas con vencimiento anterior a hoy; la que vence hoy NO está vencida',
    (() => { const r = resumenVencido([{ amount: 100, paidAmount: 30, dueDate: '2026-10-01' }, { amount: 50, paidAmount: 0, dueDate: '2026-10-24' }, { amount: 80, paidAmount: 0, dueDate: '2026-10-25' }, { amount: 40, paidAmount: 0, dueDate: '2026-11-01' }], '2026-10-25'); return r.vencido === 120 && r.cuentas === 2 })())
  check('>>> la mora NO bloquea: con deuda vencida y línea libre, puedeFiar sigue en true (decisión aprobada: aviso, no bloqueo)', (() => { const i = info({}, [{ amount: 200, paidAmount: 0, dueDate: '2026-09-01' }]); return i.vencido === 200 && i.cuentasVencidas === 1 && i.puedeFiar })())
  check('>>> motivoNoCabe: dentro de la línea → null; pasada → el MISMO texto con que el servidor rechazaría', motivoNoCabe(i1, 300) === null && motivoNoCabe(i1, 300.01) === msg(() => validarFiado(cli(), 300.01)))

  console.log('\nG) La ficha desde la base de datos: permisos, negocio y solo lectura')
  const E = await negocio('a')
  const { O, db, cliente, vender, abrir } = E
  const hoyMasUno = new Date(Date.now() + 86_400_000)
  void hoyMasUno
  const A = await cliente({ creditLimit: 500 })
  await configurarCredito(db, O, configurarCreditoSchema.parse({ customerId: A.id, creditLimit: 500, creditTermDays: 20, bloqueado: false }))
  await abrir(0)
  const v1 = await vender(200, [{ method: 'CREDITO', amount: 200 }], A.id)
  const fichaA = await infoCreditoCliente(db, O, A.id)
  check('>>> ficha real: línea 500, deuda 200, disponible 300, plazo 20, sin mora, se puede fiar', fichaA.limite === 500 && fichaA.deuda === 200 && fichaA.disponible === 300 && fichaA.plazoDias === 20 && fichaA.vencido === 0 && fichaA.puedeFiar, JSON.stringify(fichaA))
  await prisma.receivable.updateMany({ where: { saleId: v1.saleId }, data: { dueDate: new Date('2026-01-10T00:00:00Z') } })
  const fichaMora = await infoCreditoCliente(db, O, A.id)
  check('>>> con la cuenta vencida: vencido 200, 1 cuenta, y SIGUE pudiendo fiar (aviso, no bloqueo)', fichaMora.vencido === 200 && fichaMora.cuentasVencidas === 1 && fichaMora.puedeFiar)
  const B = await cliente({ creditLimit: 0 }), C = await cliente({ creditLimit: 300 }), D = await cliente({ creditLimit: 300, docType: 'SIN_DOCUMENTO', docNumber: null })
  await prisma.customer.update({ where: { id: C.id }, data: { creditBlockedAt: new Date() } })
  const [fB, fC, fD] = await Promise.all([infoCreditoCliente(db, O, B.id), infoCreditoCliente(db, O, C.id), infoCreditoCliente(db, O, D.id)])
  check('>>> sin línea / bloqueado / sin documento: no se puede fiar, cada uno con su motivo', !fB.puedeFiar && /línea/.test(fB.motivo!) && !fC.puedeFiar && fC.bloqueado && /bloqueado/.test(fC.motivo!) && !fD.puedeFiar && !fD.documentoValido && /DNI o RUC/.test(fD.motivo!))
  check('>>> un usuario SIN ningún permiso de crédito (almacenero) no ve la ficha → FORBIDDEN_ROLE', await code(infoCreditoCliente(getTenantPrisma(E.Alm), E.Alm, A.id)) === 'FORBIDDEN_ROLE')
  check('el cajero con el permiso opcional «credito.otorgar» sí la ve', (await infoCreditoCliente(getTenantPrisma(E.Caj2), E.Caj2, A.id)).limite === 500)
  const X = await negocio('b')
  const ajeno = await X.cliente({ creditLimit: 900 })
  check('>>> el cliente de OTRO negocio no se ve: error, no datos', await code(infoCreditoCliente(db, O, ajeno.id)) !== null)
  const antes = JSON.stringify(await prisma.customer.findUniqueOrThrow({ where: { id: A.id } }))
  await infoCreditoCliente(db, O, A.id); await infoCreditoCliente(db, O, A.id)
  check('>>> es de SOLO LECTURA: el cliente queda idéntico (incluida su fecha de modificación)', JSON.stringify(await prisma.customer.findUniqueOrThrow({ where: { id: A.id } })) === antes)

  console.log('\nH) La pantalla y el servidor, juntos')
  const F = await cliente({ creditLimit: 100 })
  await configurarCredito(db, O, configurarCreditoSchema.parse({ customerId: F.id, creditLimit: 100, creditTermDays: 10, bloqueado: false }))
  const fichaF = await infoCreditoCliente(db, O, F.id)
  const lin = conFiadoPorElSaldo(150, [L('EFECTIVO', 30)])
  const aviso = motivoNoCabe(fichaF, lin.find((l) => l.method === 'CREDITO')!.amount)
  const real = await vender(150, lin, F.id).then(() => null).catch((e) => e.message as string)
  check('>>> fiar 120 a quien tiene 100 de línea: la ficha lo advierte con el MISMO texto con que el servidor rechaza la venta', aviso !== null && aviso === real, `${aviso} | ${real}`)
  const ok = conFiadoPorElSaldo(150, [L('EFECTIVO', 60)])
  const ev = evaluarPagos(150, ok, { conCliente: true, documentType: 'NOTA_VENTA' })
  const venta = await vender(150, ok, F.id)
  const rec = await prisma.receivable.findFirstOrThrow({ where: { saleId: venta.saleId } })
  check('>>> efectivo 60 + «fiado por el saldo» 90: la pantalla dice LISTO y el servidor lo cobra: cuenta por 90, deuda 90', ev.estado === 'LISTO' && ev.fiado === 90 && Number(rec.amount) === 90 && Number((await prisma.customer.findUniqueOrThrow({ where: { id: F.id } })).creditBalance) === 90)

  console.log('\nI) Estructura')
  const act = readFileSync('src/features/credito/actions.ts', 'utf8')
  check('>>> las server actions de crédito son "use server", pasan por la sesión del servidor y SOLO exportan funciones async (infoCreditoCliente entre ellas)', act.startsWith("'use server'") && act.includes('requireTenantContext') && !/export (const|let|class|default|type|interface)/.test(act) && (act.match(/export /g) ?? []).length === (act.match(/export async function /g) ?? []).length && /export async function infoCreditoCliente/.test(act))
  const imp = (f: string) => (readFileSync(f, 'utf8').match(/^import .* from '(.*)'/gm) ?? []).join('\n')
  check('>>> reglas.ts y pagos-ui.ts son PUROS (sin Prisma, sin base de datos, sin servidor): los puede importar el navegador', !/prisma|tenant-prisma|session|server-only|next\//.test(imp('src/features/credito/reglas.ts') + imp('src/features/pos/pagos-ui.ts')))
  check('credito-service sigue exponiendo validarFiado y compañía (re-exportados desde reglas)', /export \{[\s\S]*validarFiado[\s\S]*\} from '\.\/reglas'/.test(readFileSync('src/features/credito/credito-service.ts', 'utf8')))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
