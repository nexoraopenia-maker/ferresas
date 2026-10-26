import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { anularAbono, configurarCredito, hoyEnZona, registrarAbono, sumarDias } from '../src/features/credito/credito-service'
import { anularAbonoSchema, configurarCreditoSchema, registrarAbonoSchema } from '../src/features/credito/schemas'
import { openCashSession } from '../src/features/branches/cash-service'
import { openCashSchema } from '../src/features/branches/cash-schemas'
import { crearCliente, puedeVerClientes } from '../src/features/clientes/service'
import { crearClienteSchema } from '../src/features/clientes/schemas'
import { estadoDeCuenta, informeDeCobranza, puedeVerCobranza, resumenPorCobrar, type EstadoDeCuenta, type InformeCobranza, type ResumenPorCobrar } from '../src/features/clientes/cobranza'
import { PERMISOS_VER_CLIENTES, PERMISOS_VER_COBRANZA } from '../src/features/clientes/permisos'
import { TablaCobranza } from '../src/features/clientes/components/TablaCobranza'
import { PorCobrarWidget } from '../src/features/clientes/components/PorCobrarWidget'
import { EstadoCuentaImprimible } from '../src/features/clientes/components/EstadoCuentaImprimible'
import { visibleItems } from '../src/features/shell/nav-items'
import { permisosDe } from '../src/lib/puede'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 3, subpaso 5.4: la pantalla de cobranza, la tarjeta «Por cobrar» del panel y el estado de cuenta imprimible (A4),
 * renderizados AISLADOS, sin navegador. Lo que más importa: las cifras en pantalla son las del informe (nada se recalcula en la
 * vista), «Vigente» no se mezcla con la mora, una cifra que no cuadra se AVISA, el contador ve la cobranza pero no la ficha, y
 * lo que se imprime son datos del negocio de quien lo pide.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const html = (el: ReactElement) => renderToStaticMarkup(el)

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: { slug: `cb-${tag}-${randomUUID().slice(0, 6)}`, name: `CobPant ${tag}`, legalName: `COBPANT ${tag.toUpperCase()} SAC`, taxId, planId: plan.id } })
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
  const filaC = (o: Partial<InformeCobranza['filas'][number]> = {}): InformeCobranza['filas'][number] => ({
    customerId: 'c1', nombre: 'Álvaro Antigüedad', docType: 'DNI', docNumber: '43000001', telefono: '987654321',
    vigente: 100, mora1a30: 200, mora31a60: 300, mora61a90: 400, mora91omas: 450, total: 1450, vencido: 1350, cuentas: 5, masAtrasada: 120, ...o,
  })
  const totales = { vigente: 180, mora1a30: 200, mora31a60: 300, mora61a90: 400, mora91omas: 450, total: 1530, vencido: 1350 }
  const informe = (o: Partial<InformeCobranza> = {}): InformeCobranza => ({
    fecha: '2026-10-25', filas: [filaC(), filaC({ customerId: 'c2', nombre: 'Beatriz Vigente', docNumber: null, docType: 'SIN_DOCUMENTO', telefono: null, vigente: 80, mora1a30: 0, mora31a60: 0, mora61a90: 0, mora91omas: 0, total: 80, vencido: 0, cuentas: 1, masAtrasada: 0 })],
    totales, clientesConDeuda: 2, clientesMorosos: 1, deudaEnClientes: 1530, coherente: true, ...o,
  })
  const tabla = (o: Partial<InformeCobranza> = {}, enlazarFicha = true) => html(createElement(TablaCobranza, { informe: informe(o), enlazarFicha }))

  console.log('\nA) La pantalla de cobranza')
  const hT = tabla()
  check('>>> las cinco columnas: «Vigente» APARTE y luego la mora 1-30, 31-60, 61-90 y más de 90 días, más el total', ['Vigente', '1-30 días', '31-60 días', '61-90 días', 'Más de 90 días', 'Total'].every((c) => hT.includes(`>${c}<`)) && hT.indexOf('>Vigente<') < hT.indexOf('>1-30 días<') && hT.indexOf('>61-90 días<') < hT.indexOf('>Más de 90 días<'))
  const filaA = hT.slice(hT.indexOf('data-cliente="c1"'), hT.indexOf('data-cliente="c2"'))
  check('>>> la fila de Álvaro trae cada tramo con su monto y el total; documento, teléfono, cuentas y días de atraso', ['S/ 100.00', 'S/ 200.00', 'S/ 300.00', 'S/ 400.00', 'S/ 450.00', 'S/ 1450.00', 'DNI 43000001', '987654321', '5 cuentas', '120 días de atraso'].every((x) => filaA.includes(x)))
  const filaB = hT.slice(hT.indexOf('data-cliente="c2"'), hT.indexOf('</tbody>'))
  check('>>> los tramos vacíos van con guion (no «S/ 0.00»); un cliente al día no dice «días de atraso»; sin documento se dice', (filaB.match(/—/g) ?? []).length === 4 && !filaB.includes('días de atraso') && filaB.includes('Sin documento') && filaB.includes('1 cuenta'))
  check('>>> la fila de TOTAL son los totales del informe; las tarjetas: por cobrar, vencido, vigente y «1 de 2» morosos', hT.slice(hT.indexOf('data-cobranza="total"')).includes('S/ 1530.00') && hT.includes('S/ 1350.00') && hT.includes('S/ 180.00') && hT.includes('1 de 2'))
  const filaTotal = hT.slice(hT.indexOf('data-cobranza="total"'), hT.indexOf('</tfoot>'))
  check('>>> la fila de TOTAL trae el total de CADA tramo (180 · 200 · 300 · 400 · 450) y el general, en ese orden — no solo el general', ['S/ 180.00', 'S/ 200.00', 'S/ 300.00', 'S/ 400.00', 'S/ 450.00', 'S/ 1530.00'].every((x) => filaTotal.includes(x)) && (filaTotal.match(/S\/ /g) ?? []).length === 6 && filaTotal.indexOf('S/ 180.00') < filaTotal.indexOf('S/ 200.00') && filaTotal.indexOf('S/ 450.00') < filaTotal.indexOf('S/ 1530.00'), filaTotal.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
  check('>>> la mora sube de tono: 1-30 y 31-60 naranja, 61-90 y más de 90 rojo (más de 90 además en negrita); lo vigente, neutro', filaA.includes('text-stock-low') && filaA.includes('text-stock-out') && filaA.includes('font-bold text-stock-out'))
  check('>>> el nombre lleva a la ficha SOLO si quien mira puede abrirla (el contador no)', hT.includes('href="/clientes/c1"') && !tabla({}, false).includes('href="/clientes/c1"') && tabla({}, false).includes('Álvaro Antigüedad'))
  check('el botón de descarga CSV apunta a la ruta de cobranza', hT.includes('href="/api/clientes/cobranza"') && hT.includes('download'))
  check('>>> si la deuda guardada NO cuadra con las cuentas, lo dice con alerta y las dos cifras; si cuadra, no hay alerta', tabla({ coherente: false, deudaEnClientes: 1540 }).includes('data-cobranza="incoherente"') && tabla({ coherente: false, deudaEnClientes: 1540 }).includes('S/ 1540.00') && !hT.includes('data-cobranza="incoherente"'))
  check('sin deudas: «Nadie te debe nada» y sin tabla', tabla({ filas: [], clientesConDeuda: 0, clientesMorosos: 0, totales: { vigente: 0, mora1a30: 0, mora31a60: 0, mora61a90: 0, mora91omas: 0, total: 0, vencido: 0 }, deudaEnClientes: 0 }).includes('Nadie te debe nada') && !tabla({ filas: [] }).includes('data-cobranza="tabla"'))

  console.log('\nB) La tarjeta «Por cobrar» del panel')
  const res = (o: Partial<ResumenPorCobrar> = {}): ResumenPorCobrar => ({
    total: 1530, vencido: 1350, vigente: 180, clientesConDeuda: 2, clientesMorosos: 1,
    masUrgentes: [{ customerId: 'c1', nombre: 'Álvaro Antigüedad', vencido: 1350, masAtrasada: 120 }], coherente: true, ...o,
  })
  const w = (o: Partial<ResumenPorCobrar> = {}, enlazar = true) => html(createElement(PorCobrarWidget, { resumen: res(o), enlazarFichas: enlazar }))
  const hW = w()
  check('>>> muestra lo que te deben (1530, 2 clientes) y lo vencido (1350, 1 moroso) en NARANJA, y enlaza a la cobranza', hW.includes('S/ 1530.00') && hW.includes('2 clientes') && hW.includes('S/ 1350.00') && hW.includes('1 moroso') && hW.includes('bg-stock-low-soft') && hW.includes('href="/cobranza"'))
  check('>>> los más urgentes con su deuda vencida y días de atraso; el nombre enlaza a la ficha solo si se puede', hW.includes('data-por-cobrar="urgentes"') && hW.includes('120 días') && hW.includes('href="/clientes/c1"') && !w({}, false).includes('href="/clientes/c1"'))
  check('>>> sin mora: «Todo al día» en verde y sin lista de urgentes', w({ vencido: 0, clientesMorosos: 0, masUrgentes: [] }).includes('Todo al día') && w({ vencido: 0, clientesMorosos: 0, masUrgentes: [] }).includes('bg-stock-ok-soft') && !w({ vencido: 0, masUrgentes: [] }).includes('data-por-cobrar="urgentes"'))
  check('>>> plural/singular correctos (1 cliente / 2 morosos) y la alerta de incoherencia solo cuando no cuadra', w({ clientesConDeuda: 1 }).includes('1 cliente<') && w({ clientesMorosos: 2 }).includes('2 morosos') && w({ coherente: false }).includes('data-por-cobrar="incoherente"') && !hW.includes('data-por-cobrar="incoherente"'))

  console.log('\nC) El estado de cuenta imprimible (A4)')
  const est: EstadoDeCuenta = {
    cliente: { id: 'c1', nombre: 'Gaby Estado', docType: 'DNI', docNumber: '43000009', telefono: '911222333' },
    desde: '2026-09-01', hasta: '2026-10-25', fecha: '2026-10-25', deudaActual: 400,
    cuentas: [
      { venta: 'V001-00000001', fecha: '2026-09-20', monto: 300, abonado: 100, saldo: 200, vence: '2026-10-05', estado: 'ABIERTA', diasMora: 20 },
      { venta: 'V001-00000002', fecha: '2026-10-25', monto: 200, abonado: 0, saldo: 200, vence: '2026-11-24', estado: 'ABIERTA', diasMora: 0 },
      { venta: 'V001-00000003', fecha: '2026-09-02', monto: 50, abonado: 50, saldo: 0, vence: '2026-09-30', estado: 'PAGADA', diasMora: 0 },
    ],
    abonos: [
      { fecha: '2026-10-01', metodo: 'EFECTIVO', monto: 100, referencia: null, cobradoPor: 'Rosa', anulado: false, motivoAnulacion: null },
      { fecha: '2026-10-25', metodo: 'YAPE', monto: 40, referencia: 'OP-123', cobradoPor: 'Rosa', anulado: true, motivoAnulacion: 'se digitó mal' },
    ],
    totales: { fiadoEnElPeriodo: 550, abonadoEnElPeriodo: 100, anuladoEnElPeriodo: 40 },
  }
  const emisor = { nombre: 'Ferretería Demo', razonSocial: 'FERRETERÍA DEMO SAC', ruc: '20123456789', direccion: 'Av. Principal 123' }
  const ec = (e: Partial<EstadoDeCuenta> = {}, acciones = true) => html(createElement(EstadoCuentaImprimible, { estado: { ...est, ...e }, emisor, conAcciones: acciones }))
  const hE = ec()
  check('>>> cabecera: razón social y RUC del NEGOCIO, el cliente con documento y teléfono, el periodo y la fecha de emisión (DD/MM/AAAA)', hE.includes('FERRETERÍA DEMO SAC') && hE.includes('RUC 20123456789') && hE.includes('Gaby Estado') && hE.includes('DNI 43000009') && hE.includes('Tel. 911222333') && hE.includes('Periodo: 01/09/2026 al 25/10/2026') && hE.includes('emitido el 25/10/2026'))
  check('>>> resumen: deuda actual 400, fiado del periodo 550, abonado 100 (el anulado NO suma)', hE.includes('data-a4="deuda-actual">S/ 400.00') && hE.includes('S/ 550.00') && hE.includes('S/ 100.00'))
  check('>>> ventas: monto, abonado, saldo (solo si está abierta; «—» si no), vencimiento y estado con los días de atraso', hE.includes('V001-00000001') && hE.includes('20 días de atraso') && hE.includes('Pagada') && hE.includes('05/10/2026'))
  const filaPagada = hE.slice(hE.indexOf('V001-00000003'), hE.indexOf('</tr>', hE.indexOf('V001-00000003')))
  const filaAbierta = hE.slice(hE.indexOf('V001-00000001'), hE.indexOf('</tr>', hE.indexOf('V001-00000001')))
  check('>>> una cuenta PAGADA no muestra saldo (guion), una ABIERTA sí (S/ 200.00): un saldo en «S/ 0.00» de una cuenta cerrada confunde', filaPagada.includes('—') && !filaPagada.includes('S/ 0.00') && filaAbierta.includes('S/ 200.00') && !filaAbierta.includes('—'))
  check('>>> abonos: método en español, referencia, quién cobró; el ANULADO tachado con su motivo', hE.includes('Efectivo') && hE.includes('Yape') && hE.includes('OP-123') && hE.includes('Rosa') && hE.includes('tachado') && hE.includes('anulado: se digitó mal'))
  check('el pie dice el saldo pendiente y en cuántas cuentas, y que los anulados no se descuentan', hE.includes('Saldo pendiente: S/ 400.00 en 2 cuentas') && hE.includes('abonos anulados no se descuentan'))
  check('>>> las acciones (solo en pantalla): filtro de fechas con los valores actuales, imprimir, CSV CON el mismo periodo y volver a la ficha', hE.includes('class="a4-acciones no-imprimir"') && hE.includes('value="2026-09-01"') && hE.includes('value="2026-10-25"') && hE.includes('Imprimir / guardar PDF') && hE.includes('href="/api/clientes/c1/estado-cuenta?desde=2026-09-01&amp;hasta=2026-10-25"') && hE.includes('href="/clientes/c1"'))
  check('sin acciones (vista limpia) no hay botones; sin periodo dice «Todo el historial» y el CSV no lleva fechas', !ec({}, false).includes('a4-acciones') && ec({ desde: null, hasta: null }).includes('Todo el historial') && ec({ desde: null, hasta: null }).includes('href="/api/clientes/c1/estado-cuenta"'))
  check('vacíos con mensaje; sin cuentas abiertas el pie dice que no hay pendiente', ec({ cuentas: [], abonos: [], deudaActual: 0 }).includes('data-a4="sin-cuentas"') && ec({ cuentas: [], abonos: [], deudaActual: 0 }).includes('data-a4="sin-abonos"') && ec({ cuentas: [], abonos: [], deudaActual: 0 }).includes('No tiene cuentas pendientes'))
  check('>>> una cuenta con UN solo pendiente dice «1 cuenta» (singular)', ec({ cuentas: [est.cuentas[0]!] }).includes('en 1 cuenta.'))

  console.log('\nD) Hoja A4 y aislamiento del formato de ticket')
  const css = readFileSync('src/app/(print-a4)/a4.css', 'utf8'), tkt = readFileSync('src/app/(print)/ticket.css', 'utf8')
  const lay4 = readFileSync('src/app/(print-a4)/layout.tsx', 'utf8'), lay80 = readFileSync('src/app/(print)/layout.tsx', 'utf8')
  check('>>> la hoja A4 define @page A4, oculta lo `no-imprimir` al imprimir y fija colores (tinta negra sobre blanco, sin tokens que se invierten en modo oscuro)', /@page\s*\{\s*size:\s*A4/.test(css) && /@media print[\s\S]*\.no-imprimir\s*\{\s*display:\s*none/.test(css) && !/var\(--color-/.test(css))
  check('>>> el @page de A4 vive SOLO en el layout de (print-a4) y el del ticket de 80 mm SOLO en el de (print): ninguno contamina al otro', lay4.includes("./a4.css") && !lay4.includes('ticket.css') && lay80.includes('./ticket.css') && !lay80.includes('a4.css') && /size:\s*80mm/.test(tkt) && !/size:\s*80mm/.test(css))

  const E = await negocio('a')
  const { O, ctxs, dbOf, vender, linea, abrirCaja, t: tn } = E
  const db = dbOf(O)
  const tz = (await prisma.tenant.findUniqueOrThrow({ where: { id: tn.id } })).timezone
  const hoyN = hoyEnZona(tz)
  let dn = 45000000
  const cli = (name: string) => crearCliente(db, O, crearClienteSchema.parse({ name, docNumber: String(dn++) }))
  const vence = (saleId: string, dias: number) => prisma.receivable.updateMany({ where: { saleId }, data: { dueDate: sumarDias(hoyN, -dias) } })

  console.log('\nE) Con datos reales')
  const vacioAntes = await resumenPorCobrar(db, O)
  check('>>> un negocio SIN deudas: el resumen dice 0 clientes con deuda (el panel no muestra tarjeta de ceros)', vacioAntes.clientesConDeuda === 0 && vacioAntes.total === 0 && vacioAntes.masUrgentes.length === 0)
  const A = await cli('Álvaro Real'), B = await cli('Beatriz Real'), Z = await cli('Zacarías Real')
  for (const c of [A, B, Z]) await linea(c.id, 9000)
  await abrirCaja()
  const montos = [100, 200, 300, 400, 500], dias = [-5, 10, 45, 75, 120]
  for (let i = 0; i < 5; i++) { const v = await vender(montos[i]!, [{ method: 'CREDITO', amount: montos[i]! }], A.id); await vence(v.saleId, dias[i]!) }
  const vb = await vender(80, [{ method: 'CREDITO', amount: 80 }], B.id); await vence(vb.saleId, -3)
  const vz = await vender(3000, [{ method: 'CREDITO', amount: 3000 }], Z.id); await vence(vz.saleId, 100)
  await registrarAbono(db, O, registrarAbonoSchema.parse({ customerId: A.id, method: 'YAPE', amount: 50, idempotencyKey: randomUUID() }))
  const inf = await informeDeCobranza(db, O)
  const hReal = html(createElement(TablaCobranza, { informe: inf, enlazarFicha: true }))
  check('>>> la tabla real muestra EXACTAMENTE las cifras del informe: cada fila (los 5 tramos y el total) y la fila de TOTAL', inf.filas.every((f) => { const t = hReal.slice(hReal.indexOf(`data-cliente="${f.customerId}"`)); const fila = t.slice(0, t.indexOf('</tr>')); return [f.vigente, f.mora1a30, f.mora31a60, f.mora61a90, f.mora91omas].every((m) => m === 0 || fila.includes(`S/ ${m.toFixed(2)}`)) && fila.includes(`S/ ${f.total.toFixed(2)}`) }) && hReal.slice(hReal.indexOf('data-cobranza="total"')).includes(`S/ ${inf.totales.total.toFixed(2)}`))
  const totReal = hReal.slice(hReal.indexOf('data-cobranza="total"'), hReal.indexOf('</tfoot>'))
  check('>>> la fila de TOTAL real trae el total de cada tramo del informe (los que tienen deuda) y el general', (['vigente', 'mora1a30', 'mora31a60', 'mora61a90', 'mora91omas'] as const).every((k) => inf.totales[k] === 0 || totReal.includes(`S/ ${inf.totales[k].toFixed(2)}`)) && totReal.includes(`S/ ${inf.totales.total.toFixed(2)}`) && (totReal.match(/S\/ /g) ?? []).length === 6)
  check('>>> el orden en pantalla es por urgencia (Zacarías 3000 vencido primero, aunque su nombre sea el último), no alfabético', inf.filas[0]!.customerId === Z.id && hReal.indexOf('Zacarías Real') < hReal.indexOf('Álvaro Real') && hReal.indexOf('Álvaro Real') < hReal.indexOf('Beatriz Real'))
  const r = await resumenPorCobrar(db, O)
  check('>>> el resumen del panel sale del MISMO informe: total, vencido, vigente y morosos coinciden; los urgentes son los de más deuda vencida, en ese orden', r.total === inf.totales.total && r.vencido === inf.totales.vencido && r.vigente === inf.totales.vigente && r.clientesMorosos === inf.clientesMorosos && r.masUrgentes.map((u) => u.customerId).join(',') === [Z.id, A.id].join(',') && r.masUrgentes[0]!.masAtrasada === 100 && r.coherente)
  check('y el resumen NO lista como urgente a quien no tiene mora (Beatriz)', !r.masUrgentes.some((u) => u.customerId === B.id))
  const hRes = html(createElement(PorCobrarWidget, { resumen: r, enlazarFichas: true }))
  check('>>> la tarjeta real muestra lo que te deben y lo vencido', hRes.includes(`S/ ${r.total.toFixed(2)}`) && hRes.includes(`S/ ${r.vencido.toFixed(2)}`) && hRes.includes('Zacarías Real'))
  const eReal = await estadoDeCuenta(db, O, { customerId: A.id })
  const hEReal = html(createElement(EstadoCuentaImprimible, { estado: eReal, emisor: { nombre: 'x', razonSocial: 'ESTADO REAL SAC', ruc: '20111111111', direccion: null } }))
  check('>>> el estado de cuenta real renderizado: las 5 ventas, el abono y la deuda actual coinciden con el servicio', eReal.cuentas.length === 5 && eReal.abonos.length === 1 && hEReal.includes(`data-a4="deuda-actual">S/ ${eReal.deudaActual.toFixed(2)}`) && eReal.cuentas.every((c) => hEReal.includes(c.venta)) && hEReal.includes('Álvaro Real'))
  check('>>> el contador: ve la cobranza y el resumen, pero el estado de cuenta (ficha de un cliente) le dice que no; el vendedor ni la cobranza', (await informeDeCobranza(dbOf(ctxs.CONTADOR!), ctxs.CONTADOR!).catch(() => null))?.filas.length === 3 && await code(estadoDeCuenta(dbOf(ctxs.CONTADOR!), ctxs.CONTADOR!, { customerId: A.id })) === 'FORBIDDEN_ROLE' && await code(resumenPorCobrar(dbOf(ctxs.VENDEDOR!), ctxs.VENDEDOR!)) === 'FORBIDDEN_ROLE')
  const E2 = await negocio('b')
  const ajeno = await crearCliente(E2.dbOf(E2.O), E2.O, crearClienteSchema.parse({ name: 'Cliente Ajeno', docNumber: String(dn++) }))
  await E2.linea(ajeno.id, 900); await E2.abrirCaja(); await E2.vender(900, [{ method: 'CREDITO', amount: 900 }], ajeno.id)
  const r2 = await resumenPorCobrar(db, O)
  check('>>> el panel y la cobranza NO mezclan negocios: ni el total ni los urgentes cambian por la deuda de otro negocio', r2.total === r.total && !r2.masUrgentes.some((u) => u.nombre === 'Cliente Ajeno') && (await estadoDeCuenta(db, O, { customerId: ajeno.id }).then(() => 'visible').catch((e) => e.code)) === 'NOT_FOUND')
  const antes = JSON.stringify(await prisma.customer.findMany({ where: { tenantId: tn.id }, orderBy: { id: 'asc' }, select: { id: true, creditBalance: true, updatedAt: true } }))
  await resumenPorCobrar(db, O); await informeDeCobranza(db, O); await estadoDeCuenta(db, O, { customerId: A.id })
  check('>>> todo es de SOLO LECTURA: los clientes quedan idénticos (también su fecha de modificación)', JSON.stringify(await prisma.customer.findMany({ where: { tenantId: tn.id }, orderBy: { id: 'asc' }, select: { id: true, creditBalance: true, updatedAt: true } })) === antes)
  void anularAbono; void anularAbonoSchema; void configurarCredito; void configurarCreditoSchema; void num

  console.log('\nF) Páginas, panel y menú')
  const pCob = readFileSync('src/app/(dashboard)/cobranza/page.tsx', 'utf8'), pEst = readFileSync('src/app/(print-a4)/estado-de-cuenta/[id]/page.tsx', 'utf8'), pPan = readFileSync('src/app/(dashboard)/panel/page.tsx', 'utf8')
  check('>>> /cobranza da 404 a quien no puede verla ANTES de consultar nada, y el enlace a la ficha depende de poder verla', /if \(!puedeVerCobranza\(ctx\)\) notFound\(\)/.test(pCob) && pCob.indexOf('notFound()') < pCob.indexOf('informeDeCobranza(') && pCob.includes('enlazarFicha={puedeVerClientes(ctx)}'))
  check('>>> el estado de cuenta: 404 sin permiso, 404 si el cliente no existe o es de otro negocio, fechas mal escritas se EXPLICAN en pantalla, y el id se acota', /if \(!puedeVerClientes\(ctx\)\) notFound\(\)/.test(pEst) && /NOT_FOUND/.test(pEst) && /INVALID_DOCUMENT/.test(pEst) && pEst.includes('id.slice(0, 64)') && pEst.includes('data-a4="error"'))
  check('>>> el panel calcula «Por cobrar» solo para quien puede verlo y muestra la tarjeta solo si hay deuda', pPan.includes('puedeVerCobranza(ctx) ? resumenPorCobrar(db, ctx) : Promise.resolve(null)') && /porCobrar && porCobrar\.clientesConDeuda > 0/.test(pPan) && pPan.includes('enlazarFichas={puedeVerClientes(ctx)}'))
  const rolCtx = (rol: Role) => ({ tenantId: 't', userId: 'u', role: rol, access: 'FULL', branchId: 'b', permisosExtra: [] } as TenantContext)
  const enMenu = (rol: Role, href: string) => visibleItems([...permisosDe(rolCtx(rol))]).some((i) => i.href === href)
  check('>>> menú «Por cobrar»: dueño, admin, cajero Y CONTADOR lo ven; vendedor y almacenero no', (['OWNER', 'ADMIN', 'CAJERO', 'CONTADOR'] as Role[]).every((r) => enMenu(r, '/cobranza')) && !enMenu('VENDEDOR', '/cobranza') && !enMenu('ALMACENERO', '/cobranza'))
  check('>>> el contador ve «Por cobrar» pero NO «Clientes» (revisa la cartera, no la edita)', enMenu('CONTADOR', '/cobranza') && !enMenu('CONTADOR', '/clientes') && !puedeVerClientes(rolCtx('CONTADOR')) && puedeVerCobranza(rolCtx('CONTADOR')))
  check('>>> menú, página, panel y servicio comparten la lista pura de permisos', (['OWNER', 'ADMIN', 'CAJERO', 'VENDEDOR', 'ALMACENERO', 'CONTADOR'] as Role[]).every((r) => enMenu(r, '/cobranza') === puedeVerCobranza(rolCtx(r))) && PERMISOS_VER_COBRANZA.length === PERMISOS_VER_CLIENTES.length + 1 && PERMISOS_VER_COBRANZA[0] === 'reportes.ver')
  const ficha = readFileSync('src/features/clientes/components/AccionesCliente.tsx', 'utf8')
  check('la ficha ofrece el estado de cuenta imprimible (pestaña nueva) y el CSV', ficha.includes('href={`/estado-de-cuenta/${customerId}`}') && ficha.includes('target="_blank"') && ficha.includes('/api/clientes/${customerId}/estado-cuenta'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
