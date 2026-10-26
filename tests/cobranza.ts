import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { anularAbono, anularCuenta, configurarCredito, hoyEnZona, registrarAbono, sumarDias } from '../src/features/credito/credito-service'
import { anularAbonoSchema, anularCuentaSchema, configurarCreditoSchema, registrarAbonoSchema } from '../src/features/credito/schemas'
import { openCashSession } from '../src/features/branches/cash-service'
import { openCashSchema } from '../src/features/branches/cash-schemas'
import { crearCliente } from '../src/features/clientes/service'
import { crearClienteSchema } from '../src/features/clientes/schemas'
import { estadoDeCuenta, exportarCobranzaCsv, exportarEstadoDeCuentaCsv, informeDeCobranza, puedeVerCobranza } from '../src/features/clientes/cobranza'
import { clasificarAntiguedad, diasDeMora, repartirAbono, tramoDeMora } from '../src/features/credito/reglas'
import { celdaCsv, generarCsv } from '../src/lib/csv-export'
import { respuestaCsv } from '../src/lib/respuesta-csv'
import { parseCsv } from '../src/features/inventory/csv'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 3, subpaso 5.2: reparto FIFO compartido, antigüedad de la cobranza, estado de cuenta y descargas CSV.
 * Lo que más importa: la vista previa del abono es EXACTAMENTE lo que se registra, cada tramo de mora cae donde debe (los bordes),
 * la cobranza cuadra con la deuda de los clientes, el CSV no deja pasar fórmulas, y todo respeta permisos y negocio.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: { slug: `co-${tag}-${randomUUID().slice(0, 6)}`, name: `Cobranza ${tag}`, legalName: `COBRANZA ${tag.toUpperCase()} SAC`, taxId, planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cl' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const mk = async (role: Role) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, u.id, b1.branch.id)
    return u
  }
  const ctxs: Record<string, TenantContext> = {}
  for (const r of ['OWNER', 'ADMIN', 'CAJERO', 'VENDEDOR', 'ALMACENERO', 'CONTADOR'] as Role[]) {
    const u = await mk(r)
    ctxs[r] = { tenantId: t.id, userId: u.id, role: r, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: r === 'CAJERO' ? ['credito.otorgar'] : [] }
  }
  const dbOf = (c: TenantContext) => getTenantPrisma(c)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Producto', salePrice: 100 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: b1.warehouse.id, quantity: 10000 } })
  const O = ctxs.OWNER!
  const vender = (monto: number, payments: { method: string; amount: number }[], customerId: string, c: TenantContext = O) =>
    registerSale(dbOf(c), c, { warehouseId: b1.warehouse.id, customerId, items: [{ productId: prod.id, quantity: monto / 100, discount: 0 }], payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() } as never)
  const linea = (customerId: string, limite: number, dias = 30) => configurarCredito(dbOf(O), O, configurarCreditoSchema.parse({ customerId, creditLimit: limite, creditTermDays: dias, bloqueado: false }))
  const abrirCaja = () => openCashSession(dbOf(O), O, openCashSchema.parse({ openingAmount: 0 }))
  return { t, b1, ctxs, dbOf, prod, vender, linea, abrirCaja, O }
}


async function main() {
  const L = (monto: number) => ({ monto })
  void L
  console.log('\nA) Reparto de un abono (puro)')
  const r1 = repartirAbono([200, 100, 50], 250)
  check('>>> 250 sobre saldos [200, 100, 50]: 200 (saldada) + 50 de la segunda (quedan 50); la tercera no se toca', r1.partes.length === 2 && r1.partes[0]!.monto === 200 && r1.partes[0]!.pagada && r1.partes[1]!.monto === 50 && r1.partes[1]!.saldoDespues === 50 && !r1.partes[1]!.pagada && r1.sobrante === 0)
  const r2 = repartirAbono([30, 20], 80)
  check('>>> un abono mayor que lo adeudado devuelve el sobrante (el servicio lo rechaza; la pantalla lo avisa)', r2.partes.length === 2 && r2.sobrante === 30)
  check('cuentas con saldo 0 se saltan; abono 0 no reparte nada; al céntimo: 0.1 + 0.2', repartirAbono([0, 10], 5).partes[0]!.indice === 1 && repartirAbono([10], 0).partes.length === 0 && repartirAbono([0.1, 0.2], 0.3).sobrante === 0 && repartirAbono([0.1, 0.2], 0.3).partes.every((p) => p.pagada))
  let malos = 0
  for (let i = 0; i < 1500; i++) {
    const saldos = Array.from({ length: 1 + Math.floor(Math.random() * 6) }, () => Math.floor(Math.random() * 50000) / 100)
    const total = Math.round(saldos.reduce((a, b) => a + Math.round(b * 100), 0))
    const monto = Math.floor(Math.random() * (total + 2000)) / 100
    const { partes, sobrante } = repartirAbono(saldos, monto)
    const sumaPartes = partes.reduce((a, p) => a + Math.round(p.monto * 100), 0)
    const ok = sumaPartes + Math.round(sobrante * 100) === Math.round(monto * 100)
      && partes.every((p) => p.monto > 0 && p.monto <= saldos[p.indice]! + 1e-9)
      && partes.every((p, k) => k === partes.length - 1 || p.pagada)
      && partes.every((p, k) => k === 0 || p.indice > partes[k - 1]!.indice)
      && (sobrante === 0 || partes.every((p) => p.pagada))
    if (!ok) malos++
  }
  check('>>> 1500 casos al azar: Σ partes + sobrante = monto; ninguna parte pasa de su saldo; solo la última puede quedar a medias; sin sobrante salvo que todo quede saldado', malos === 0, `${malos} incoherentes`)

  console.log('\nB) Antigüedad (puro): los bordes de cada tramo')
  const hoy = '2026-10-25'
  const en = (dias: number) => sumarDias(hoy, -dias).toISOString().slice(0, 10)
  const tramo = (dias: number) => tramoDeMora(diasDeMora(en(dias), hoy))
  check('>>> vence mañana → vigente; vence HOY → vigente (aún no está vencida); hace 1 día → 1-30', tramo(-1) === 'vigente' && tramo(0) === 'vigente' && tramo(1) === 'mora1a30')
  check('>>> bordes: 30 → 1-30 · 31 → 31-60 · 60 → 31-60 · 61 → 61-90 · 90 → 61-90 · 91 → +90', tramo(30) === 'mora1a30' && tramo(31) === 'mora31a60' && tramo(60) === 'mora31a60' && tramo(61) === 'mora61a90' && tramo(90) === 'mora61a90' && tramo(91) === 'mora91omas' && tramo(400) === 'mora91omas')
  const cl = clasificarAntiguedad([
    { amount: 100, paidAmount: 0, dueDate: en(-5) }, { amount: 200, paidAmount: 50, dueDate: en(10) }, { amount: 300, paidAmount: 0, dueDate: en(45) },
    { amount: 400, paidAmount: 0, dueDate: en(75) }, { amount: 500, paidAmount: 0, dueDate: en(120) }, { amount: 70, paidAmount: 70, dueDate: en(200) },
  ], hoy)
  check('>>> se suma el SALDO (lo que falta), no el monto; la cuenta ya saldada no cuenta; vencido = total − vigente', cl.vigente === 100 && cl.mora1a30 === 150 && cl.mora31a60 === 300 && cl.mora61a90 === 400 && cl.mora91omas === 500 && cl.total === 1450 && cl.vencido === 1350)
  check('al céntimo: 0.1 + 0.2 en el mismo tramo = 0.30', clasificarAntiguedad([{ amount: 0.1, paidAmount: 0, dueDate: en(5) }, { amount: 0.2, paidAmount: 0, dueDate: en(6) }], hoy).mora1a30 === 0.3)

  console.log('\nC) CSV (puro)')
  check('>>> texto que empieza por = + - @ tab o retorno se vuelve texto inofensivo (apóstrofo delante)', ['=1+1', '+54', '-10', '@SUM(A1)', '\tX', '\rX'].every((t) => celdaCsv(t).replace(/^"/, '').startsWith("'")))
  check('>>> =HYPERLINK con el separador dentro: neutralizado Y entrecomillado', celdaCsv('=HYPERLINK("http://x";"clic")') === `"'=HYPERLINK(""http://x"";""clic"")"`, celdaCsv('=HYPERLINK("http://x";"clic")'))
  check('>>> un NÚMERO negativo o un monto negativo NO se neutraliza (-5 sigue siendo -5; -5.00)', celdaCsv(-5) === '-5' && celdaCsv(L(-5)) === '-5.00' && celdaCsv(L(1234.5)) === '1234.50' && celdaCsv(L(3)) === '3.00')
  check('separador, comillas y saltos de línea → entrecomillado y comillas duplicadas; nulos vacíos; NaN vacío', celdaCsv('a;b') === '"a;b"' && celdaCsv('di "hola"') === '"di ""hola"""' && celdaCsv('l1\nl2') === '"l1\nl2"' && celdaCsv(null) === '' && celdaCsv(undefined) === '' && celdaCsv(Number.NaN) === '')
  const csv = generarCsv(['Cliente', 'Monto'], [['Ñusta Pérez', L(10)], ['Ana; "la jefa"', L(2.5)]])
  check('>>> BOM UTF-8 al inicio, separador «;», saltos CRLF y termina en salto de línea', csv.startsWith('﻿') && csv.includes(';') && csv.split('\r\n').length === 4 && csv.endsWith('\r\n') && !csv.replace(/\r\n/g, '').includes('\n'))
  const t = parseCsv(csv)
  check('>>> viaje de ida y vuelta con el lector del catálogo: separador detectado, tildes y ñ intactas, comillas y «;» recuperados', t.delimiter === ';' && t.headers.join('|') === 'cliente|monto' && t.rows[0]![0] === 'Ñusta Pérez' && t.rows[1]![0] === 'Ana; "la jefa"' && t.rows[1]![1] === '2.50', JSON.stringify(t.rows))
  const resp = respuestaCsv({ nombre: 'cobranza ../../etc/passwd 2026.csv', contenido: csv })
  check('>>> la respuesta HTTP: descarga (attachment), sin caché, sin sniffing, UTF-8, y el nombre del archivo limpio (sin ../ ni espacios)', resp.headers.get('Content-Type') === 'text/csv; charset=utf-8' && /^attachment; filename="[A-Za-z0-9._-]+"$/.test(resp.headers.get('Content-Disposition')!) && !resp.headers.get('Content-Disposition')!.includes('/') && resp.headers.get('Cache-Control') === 'no-store' && resp.headers.get('X-Content-Type-Options') === 'nosniff')

  const E = await negocio('a')
  const { t: tn, ctxs, dbOf, vender, linea, abrirCaja, O } = E
  const db = dbOf(O)
  const tz = (await prisma.tenant.findUniqueOrThrow({ where: { id: tn.id } })).timezone
  const hoyN = hoyEnZona(tz)
  const cli = async (name: string, doc?: string) => crearCliente(db, O, crearClienteSchema.parse({ name, docNumber: doc }))
  const vence = (saleId: string, dias: number) => prisma.receivable.updateMany({ where: { saleId }, data: { dueDate: sumarDias(hoyN, -dias) } })
  let dn = 43000000
  await abrirCaja()

  console.log('\nD) El reparto previsto es el que se registra')
  const D = await cli('Cliente Reparto', String(dn++))
  await linea(D.id, 5000)
  const ds = [await vender(300, [{ method: 'CREDITO', amount: 300 }], D.id), await vender(200, [{ method: 'CREDITO', amount: 200 }], D.id), await vender(100, [{ method: 'CREDITO', amount: 100 }], D.id)]
  await vence(ds[0]!.saleId, 5); await vence(ds[1]!.saleId, 40); await vence(ds[2]!.saleId, 20)   // orden FIFO por vencimiento: ds1 (40), ds2 (20), ds0 (5)
  const abiertas = await prisma.receivable.findMany({ where: { customerId: D.id, status: 'ABIERTA' }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })
  const previsto = repartirAbono(abiertas.map((a) => num(a.amount) - num(a.paidAmount)), 270)
  const ab = await registrarAbono(db, O, registrarAbonoSchema.parse({ customerId: D.id, method: 'EFECTIVO', amount: 270, idempotencyKey: randomUUID() }))
  const reales = await prisma.paymentAllocation.findMany({ where: { customerPaymentId: ab.paymentId } })
  check('>>> lo que la vista previa anunciaba (200 a la más antigua, 70 a la siguiente) es EXACTAMENTE lo escrito en la base', previsto.partes.length === 2 && previsto.partes.every((p) => reales.find((r) => r.receivableId === abiertas[p.indice]!.id && num(r.amount) === p.monto)) && reales.length === previsto.partes.length)
  check('y el resultado del servicio coincide parte por parte (monto, saldo después, pagada)', ab.reparto.every((x, k) => x.monto === previsto.partes[k]!.monto && x.saldoDespues === previsto.partes[k]!.saldoDespues && x.pagada === previsto.partes[k]!.pagada))
  const elegidas = await prisma.receivable.findMany({ where: { customerId: D.id, status: 'ABIERTA' }, orderBy: { dueDate: 'desc' } })
  const prev2 = repartirAbono(elegidas.map((a) => num(a.amount) - num(a.paidAmount)), 60)
  const ab2 = await registrarAbono(db, O, registrarAbonoSchema.parse({ customerId: D.id, method: 'YAPE', amount: 60, receivableIds: elegidas.map((a) => a.id), idempotencyKey: randomUUID() }))
  check('>>> eligiendo las cuentas en otro orden, también coincide', ab2.reparto.length === prev2.partes.length && ab2.reparto.every((x, k) => x.receivableId === elegidas[prev2.partes[k]!.indice]!.id && x.monto === prev2.partes[k]!.monto))

  console.log('\nE) Informe de cobranza')
  const A = await cli('Álvaro Antigüedad', String(dn++)), B = await cli('Beatriz Vigente', String(dn++)), C = await cli('Carlos Sin Deuda', String(dn++))
  await linea(A.id, 5000); await linea(B.id, 5000); await linea(C.id, 5000)
  const va = [100, 200, 300, 400, 500].map(() => 0)
  void va
  const montos = [100, 200, 300, 400, 500], dias = [-5, 10, 45, 75, 120]
  for (let i = 0; i < 5; i++) { const v = await vender(montos[i]!, [{ method: 'CREDITO', amount: montos[i]! }], A.id); await vence(v.saleId, dias[i]!) }
  const vb = await vender(80, [{ method: 'CREDITO', amount: 80 }], B.id); await vence(vb.saleId, -3)
  // Un moroso fuerte cuyo nombre queda ÚLTIMO en el alfabeto: el orden por urgencia no puede coincidir con el alfabético.
  const Z = await cli('Zacarías Moroso Fuerte', String(dn++)); await linea(Z.id, 5000)
  const vz = await vender(3000, [{ method: 'CREDITO', amount: 3000 }], Z.id); await vence(vz.saleId, 100)
  await abrirCaja().catch(() => undefined)
  await registrarAbono(db, O, registrarAbonoSchema.parse({ customerId: A.id, method: 'YAPE', amount: 50, idempotencyKey: randomUUID() }))   // FIFO: se la lleva la de 120 días
  const inf = await informeDeCobranza(db, O)
  const fa = inf.filas.find((f) => f.customerId === A.id)!, fb = inf.filas.find((f) => f.customerId === B.id)!
  check('>>> Álvaro: vigente 100 · 1-30 200 · 31-60 300 · 61-90 400 · +90 450 (el abono de 50 se llevó lo más viejo); total 1450, vencido 1350, 5 cuentas, la más atrasada 120 días',
    fa.vigente === 100 && fa.mora1a30 === 200 && fa.mora31a60 === 300 && fa.mora61a90 === 400 && fa.mora91omas === 450 && fa.total === 1450 && fa.vencido === 1350 && fa.cuentas === 5 && fa.masAtrasada === 120, JSON.stringify(fa))
  check('Beatriz: solo vigente (80), sin mora, no es morosa; Carlos (sin deuda) no aparece', fb.vigente === 80 && fb.vencido === 0 && fb.masAtrasada === 0 && !inf.filas.some((f) => f.customerId === C.id))
  check('>>> lo más urgente primero (por deuda vencida, NO por alfabeto): Zacarías 3000, luego Álvaro 1350, y Beatriz (sin mora) detrás', inf.filas[0]!.customerId === Z.id && inf.filas[1]!.customerId === A.id && inf.filas.findIndex((f) => f.customerId === A.id) < inf.filas.findIndex((f) => f.customerId === B.id))
  const sumaFilas = Math.round(inf.filas.reduce((a, f) => a + f.total, 0) * 100) / 100
  check('>>> los totales son la suma de las filas, y COINCIDEN con la deuda guardada en los clientes (coherente)', inf.totales.total === sumaFilas && inf.coherente && inf.deudaEnClientes === inf.totales.total && inf.clientesConDeuda === inf.filas.length && inf.clientesMorosos === inf.filas.filter((f) => f.vencido > 0).length)
  await prisma.customer.update({ where: { id: C.id }, data: { creditBalance: 10 } })
  const inc = await informeDeCobranza(db, O)
  check('>>> si la deuda guardada de un cliente no cuadra con sus cuentas, el informe lo DICE (coherente = false)', inc.coherente === false && inc.deudaEnClientes === inc.totales.total + 10)
  await prisma.customer.update({ where: { id: C.id }, data: { creditBalance: 0 } })
  const E2 = await negocio('b')
  const ajeno = await crearCliente(E2.dbOf(E2.O), E2.O, crearClienteSchema.parse({ name: 'De Otro Negocio', docNumber: String(dn++) }))
  await E2.linea(ajeno.id, 900); await E2.abrirCaja(); await E2.vender(900, [{ method: 'CREDITO', amount: 900 }], ajeno.id)
  const inf2 = await informeDeCobranza(db, O)
  check('>>> el informe NO mezcla negocios (ni sus clientes ni sus totales)', !inf2.filas.some((f) => f.nombre === 'De Otro Negocio') && inf2.totales.total === inf.totales.total)
  check('>>> VEN la cobranza: dueño, admin, cajero y contador; NO vendedor ni almacenero', (await Promise.all(['OWNER', 'ADMIN', 'CAJERO', 'CONTADOR'].map((r) => informeDeCobranza(dbOf(ctxs[r]!), ctxs[r]!).then(() => 'ok').catch((e) => e.code)))).every((x) => x === 'ok') && (await Promise.all(['VENDEDOR', 'ALMACENERO'].map((r) => code(informeDeCobranza(dbOf(ctxs[r]!), ctxs[r]!))))).every((c) => c === 'FORBIDDEN_ROLE') && puedeVerCobranza(ctxs.CONTADOR!) && !puedeVerCobranza(ctxs.VENDEDOR!))
  const antesInf = JSON.stringify(await prisma.customer.findMany({ where: { tenantId: tn.id }, orderBy: { id: 'asc' }, select: { id: true, creditBalance: true, updatedAt: true } }))
  await informeDeCobranza(db, O); await informeDeCobranza(db, O)
  check('>>> el informe es de SOLO LECTURA (los clientes quedan idénticos, también su fecha de modificación)', JSON.stringify(await prisma.customer.findMany({ where: { tenantId: tn.id }, orderBy: { id: 'asc' }, select: { id: true, creditBalance: true, updatedAt: true } })) === antesInf)

  console.log('\nF) Estado de cuenta')
  const G = await cli('Gaby Estado', String(dn++))
  await linea(G.id, 5000)
  const gv1 = await vender(300, [{ method: 'CREDITO', amount: 300 }], G.id), gv2 = await vender(200, [{ method: 'CREDITO', amount: 200 }], G.id)
  const gAb1 = await registrarAbono(db, O, registrarAbonoSchema.parse({ customerId: G.id, method: 'EFECTIVO', amount: 100, idempotencyKey: randomUUID() }))
  const gAb2 = await registrarAbono(db, O, registrarAbonoSchema.parse({ customerId: G.id, method: 'YAPE', amount: 40, idempotencyKey: randomUUID() }))
  await anularAbono(db, O, anularAbonoSchema.parse({ paymentId: gAb2.paymentId, motivo: 'se digitó mal' }))
  const hace = (d: number) => sumarDias(hoyN, -d)
  await prisma.receivable.updateMany({ where: { saleId: gv1.saleId }, data: { createdAt: hace(30) } })
  await prisma.customerPayment.update({ where: { id: gAb1.paymentId }, data: { receivedAt: hace(25) } })
  const todo = await estadoDeCuenta(db, O, { customerId: G.id })
  check('>>> sin periodo: las dos cuentas y los dos abonos; deuda actual 360 (500 − 100 − 40 anulado devuelto = 440? no: 500 − 100 = 400, el anulado se restituyó)', todo.cuentas.length === 2 && todo.abonos.length === 2 && todo.deudaActual === 400, JSON.stringify({ d: todo.deudaActual, c: todo.cuentas.length, a: todo.abonos.length }))
  check('>>> el abono anulado aparece MARCADO con su motivo y no suma como abonado: abonado 100, anulado 40, fiado 500', todo.abonos.some((a) => a.anulado && a.motivoAnulacion === 'se digitó mal') && todo.totales.abonadoEnElPeriodo === 100 && todo.totales.anuladoEnElPeriodo === 40 && todo.totales.fiadoEnElPeriodo === 500)
  const ult = await estadoDeCuenta(db, O, { customerId: G.id, desde: hoyN })
  check('>>> periodo «desde hoy»: solo lo de hoy (la venta de hace 30 días y el abono de hace 25 quedan fuera) — pero la cuenta ABIERTA vieja se muestra siempre', ult.abonos.length === 1 && ult.abonos[0]!.anulado && ult.totales.fiadoEnElPeriodo === 200 && ult.cuentas.length === 2)
  const ayer = await estadoDeCuenta(db, O, { customerId: G.id, hasta: sumarDias(hoyN, -1).toISOString().slice(0, 10) })
  check('>>> «hasta ayer»: no incluye lo de hoy (el límite es el FIN del día indicado, no el inicio)', ayer.abonos.length === 1 && ayer.abonos[0]!.monto === 100 && ayer.totales.fiadoEnElPeriodo === 300)
  const hoyIncl = await estadoDeCuenta(db, O, { customerId: G.id, hasta: hoyN })
  check('«hasta hoy» sí incluye lo de hoy', hoyIncl.abonos.length === 2 && hoyIncl.totales.fiadoEnElPeriodo === 500)
  check('>>> fechas mal escritas o invertidas → error claro', await code(estadoDeCuenta(db, O, { customerId: G.id, desde: '25/10/2026' })) === 'INVALID_DOCUMENT' && await code(estadoDeCuenta(db, O, { customerId: G.id, desde: '2026-10-25', hasta: '2026-10-01' })) === 'INVALID_DOCUMENT')
  check('>>> el cajero ve el estado de cuenta; el contador y el vendedor no; el cliente de OTRO negocio no existe', (await estadoDeCuenta(dbOf(ctxs.CAJERO!), ctxs.CAJERO!, { customerId: G.id })).cliente.nombre === 'Gaby Estado' && (await Promise.all(['CONTADOR', 'VENDEDOR'].map((r) => code(estadoDeCuenta(dbOf(ctxs[r]!), ctxs[r]!, { customerId: G.id }))))).every((c) => c === 'FORBIDDEN_ROLE') && await code(estadoDeCuenta(db, O, { customerId: ajeno.id })) === 'NOT_FOUND')
  void gv2

  console.log('\nG) Descargas: contenido, auditoría y permisos')
  const peligro = await cli('=HYPERLINK("http://malo.example";"gana un premio")', String(dn++))
  await linea(peligro.id, 500); await vender(60, [{ method: 'CREDITO', amount: 60 }], peligro.id)
  const antesAud = await prisma.auditLog.count({ where: { tenantId: tn.id, action: 'cobranza.exportada' } })
  const x = await exportarCobranzaCsv(db, O)
  const tx = parseCsv(x.contenido)
  check('>>> el CSV de cobranza: nombre con fecha, BOM, una fila por cliente con deuda más la de TOTAL, y los tramos en columnas', x.nombre === `cobranza-${hoyN}.csv` && x.contenido.startsWith('﻿') && tx.rows.length === x.filas + 1 && tx.headers.includes('vigente') && tx.headers.includes('más de 90 días') && tx.rows.at(-1)![0] === 'TOTAL')
  const colTotal = tx.headers.indexOf('total adeudado')
  const totalCsv = tx.rows.slice(0, -1).reduce((a, f) => a + Math.round(Number(f[colTotal]) * 100), 0) / 100
  check('>>> el TOTAL del archivo es la suma de sus filas y coincide con el informe', Number(tx.rows.at(-1)![colTotal]) === totalCsv && totalCsv === (await informeDeCobranza(db, O)).totales.total)
  const filaPeligro = tx.rows.find((f) => f[0]!.includes('HYPERLINK'))!
  check('>>> el cliente con nombre de FÓRMULA queda como texto (empieza por apóstrofo) y ninguna celda de texto del archivo empieza por = + - @', filaPeligro[0]!.startsWith("'=HYPERLINK") && tx.rows.every((f) => f.slice(0, 3).every((c) => !/^[=+\-@]/.test(c))))
  check('>>> la descarga queda AUDITADA: quién, cuándo, cuántas filas y el total', (await prisma.auditLog.count({ where: { tenantId: tn.id, action: 'cobranza.exportada' } })) === antesAud + 1 && ((await prisma.auditLog.findFirst({ where: { tenantId: tn.id, action: 'cobranza.exportada' }, orderBy: { createdAt: 'desc' } }))?.after as { filas: number }).filas === x.filas)
  const ex = await exportarEstadoDeCuentaCsv(db, O, { customerId: G.id })
  const te = parseCsv(ex.contenido)
  check('>>> el CSV del estado de cuenta: cuentas y abonos (el anulado marcado), cierra con la DEUDA ACTUAL, nombre con el documento del cliente', ex.nombre.startsWith('estado-de-cuenta-') && ex.nombre.endsWith('.csv') && te.rows.filter((f) => f[0] === 'Venta a crédito').length === 2 && te.rows.filter((f) => f[0] === 'Abono').length === 2 && te.rows.some((f) => f[0] === 'Abono' && f[8] === 'ANULADO') && te.rows.at(-1)![0] === 'DEUDA ACTUAL' && Number(te.rows.at(-1)![6]) === 400)
  check('y también queda auditado', !!(await prisma.auditLog.findFirst({ where: { tenantId: tn.id, action: 'estado_cuenta.exportado', entityId: G.id } })))
  const antesDen = await prisma.auditLog.count({ where: { tenantId: tn.id, action: { in: ['cobranza.exportada', 'estado_cuenta.exportado'] } } })
  const den = await Promise.all([code(exportarCobranzaCsv(dbOf(ctxs.VENDEDOR!), ctxs.VENDEDOR!)), code(exportarCobranzaCsv(dbOf(ctxs.ALMACENERO!), ctxs.ALMACENERO!)), code(exportarEstadoDeCuentaCsv(dbOf(ctxs.CONTADOR!), ctxs.CONTADOR!, { customerId: G.id })), code(exportarEstadoDeCuentaCsv(db, O, { customerId: ajeno.id }))])
  check('>>> sin permiso (vendedor, almacenero; contador al estado de cuenta) o con un cliente ajeno: rechazado y SIN auditoría de descarga ni datos', den.join(',') === 'FORBIDDEN_ROLE,FORBIDDEN_ROLE,FORBIDDEN_ROLE,NOT_FOUND' && (await prisma.auditLog.count({ where: { tenantId: tn.id, action: { in: ['cobranza.exportada', 'estado_cuenta.exportado'] } } })) === antesDen)
  check('el contador SÍ descarga la cobranza (su trabajo es revisar la cartera)', (await exportarCobranzaCsv(dbOf(ctxs.CONTADOR!), ctxs.CONTADOR!)).filas > 0)

  console.log('\nH) Acciones y rutas')
  const act = readFileSync('src/features/credito/actions.ts', 'utf8')
  const nombres = ['infoCreditoCliente', 'cajaAbiertaParaAbonos', 'registrarAbono', 'anularAbono', 'anularCuenta', 'descartarRevision', 'configurarCredito']
  check('>>> acciones de crédito: "use server", exactamente estas 7, todas async, y SOLO delegan (sin permisos ni dinero aquí)', act.startsWith("'use server'") && nombres.every((n) => new RegExp(`export async function ${n}\\(`).test(act)) && (act.match(/export /g) ?? []).length === nombres.length && !/puede\(|exigir\(|\$transaction|\.update\(|\.create\(/.test(act))
  // Se corta el archivo POR FUNCIÓN: una expresión que cruzara a la función siguiente daría por buena una acción sin validar.
  const cuerpoAccion = (n: string) => { const i = act.indexOf(`export async function ${n}(`); const j = act.indexOf('export async function', i + 10); return act.slice(i, j < 0 ? undefined : j) }
  check('>>> cada acción valida con SU esquema de Zod ANTES de tocar nada (y rechaza si no pasa)', ['registrarAbono', 'anularAbono', 'anularCuenta', 'descartarRevision', 'configurarCredito'].every((n) => { const c = cuerpoAccion(n); return /Schema\.safeParse\(raw\)/.test(c) && c.indexOf('safeParse(raw)') < c.indexOf('conTenant(') && /if \(!p\.success\) return invalida\(p\.error\)/.test(c) }))
  check('el abono llega al servicio con su clave de idempotencia obligatoria (el esquema la exige)', !registrarAbonoSchema.safeParse({ customerId: 'c', method: 'YAPE', amount: 10 }).success)
  const r1f = readFileSync('src/app/api/clientes/cobranza/route.ts', 'utf8'), r2f = readFileSync('src/app/api/clientes/[id]/estado-cuenta/route.ts', 'utf8')
  check('>>> las rutas de descarga exigen sesión (401), dejan el permiso al servicio (403), usan la respuesta CSV común y no hacen consultas propias', [r1f, r2f].every((r) => r.includes('requireTenantContext') && r.includes('status: 401') && r.includes('respuestaCsv(') && r.includes('FORBIDDEN_ROLE') && !/db\.\w+\.find/.test(r)))
  check('la ruta del estado de cuenta acota el id y pasa las fechas al servicio, que las valida', r2f.includes('id.slice(0, 64)') && r2f.includes("q.get('desde')") && r2f.includes("q.get('hasta')"))
  check('esquemas de anular y configurar siguen exigiendo motivo / límites (nadie castiga sin escribir por qué)', !anularCuentaSchema.safeParse({ receivableId: 'r', motivo: '' }).success && !configurarCreditoSchema.safeParse({ customerId: 'c', creditLimit: -1, creditTermDays: 30, bloqueado: false }).success)
  void anularCuenta

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
