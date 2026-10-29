import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { permisosDe } from '../src/lib/puede'
import { hoyEnZona } from '../src/features/credito/reglas'
import {
  leerMontoPago, MENSAJE_PAGO_ELIGE_CUENTA, MENSAJE_PAGO_SIN_CAJA, MENSAJE_PAGO_SIN_DEUDA, mensajePagoExcede, METODOS_PAGO, previsualizarPagoUi, type CuentaPagable,
} from '../src/features/por-pagar/pago-ui'
import { anularPagoProveedor, previsualizarPago, registrarPagoProveedor } from '../src/features/por-pagar/pagos'
import { anularPagoSchema, previsualizarPagoSchema, registrarPagoSchema } from '../src/features/por-pagar/schemas'
import { informeDePorPagar, resumenPorPagar, ultimosPagosDeProveedor, type PagoDeProveedor } from '../src/features/por-pagar/informes'
import { PERMISOS_VER_POR_PAGAR } from '../src/features/por-pagar/permisos'
import { VistaPago } from '../src/features/por-pagar/components/ModalPago'
import { TablaPorPagar } from '../src/features/por-pagar/components/TablaPorPagar'
import { PorPagarWidget } from '../src/features/por-pagar/components/PorPagarWidget'
import { MENSAJE_PAGO_TURNO_CERRADO, PagosDelProveedor } from '../src/features/por-pagar/components/PagosDelProveedor'
import { AccionesProveedor } from '../src/features/proveedores/components/AccionesProveedor'
import { AccionesCompra, type PermisosCompra } from '../src/features/compras/components/AccionesCompra'
import { anularCompra, crearBorrador, recibirCompra } from '../src/features/compras/service'
import { anularCompraSchema, crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { crearProveedor } from '../src/features/proveedores/service'
import { crearProveedorSchema } from '../src/features/proveedores/schemas'
import { closeCashSession, openCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { CashPanel } from '../src/features/branches/components/CashPanel'
import { getVoucherPago, numeroDeVoucher } from '../src/features/printing/voucher-pago'
import { TicketPagoProveedor } from '../src/features/printing/components/TicketPagoProveedor'
import { visibleItems } from '../src/features/shell/nav-items'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 4, subpaso F4.6: las pantallas de cuentas por pagar (lista, modal de pago, pagos del proveedor, tarjeta del panel, caja con pagos a
 * proveedores, voucher) y «pagar al recibir», renderizadas AISLADAS y con datos reales.
 * Lo que más importa: lo que la pantalla muestra al pagar es lo que el servidor registra (y dice lo mismo cuando lo rechaza), un pago de
 * un turno cerrado no se ofrece anular, el contador ve la deuda pero no puede pagar, y el voucher conserva lo que quedaba al pagar.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => null).catch((e) => (e as Error).message)
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const etiqueta = (h: string, marca: string): string => { const i = h.indexOf(marca); if (i < 0) return ''; const a = h.lastIndexOf('<', i); return h.slice(a, h.indexOf('>', i) + 1) }
const deshabilitado = (h: string, marca: string) => /\sdisabled=""/.test(etiqueta(h, marca))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const rolCtx = (r: Role, extra: TenantContext['permisosExtra'] = []): TenantContext => ({ tenantId: 't', userId: 'u', role: r, access: 'FULL', branchId: 'b', permisosExtra: extra })
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')

const cuentas: CuentaPagable[] = [
  { id: 'a', compra: 'C-1', saldo: 100, vence: '2026-09-01', vencida: true },
  { id: 'b', compra: 'C-2', saldo: 50, vence: '2027-01-01', vencida: false },
]

async function main() {
  console.log('\nA) La lógica del modal de pago (pura)')
  check('>>> leerMontoPago: coma decimal, vacío = null, letras/cero/3 decimales = NaN', leerMontoPago('12,5') === 12.5 && leerMontoPago(' ') === null && ['abc', '0', '1.005', '-3'].every((t) => Number.isNaN(leerMontoPago(t)!)))
  check('>>> «CREDITO» no es un método de pago (pagar es dinero que sale) y efectivo es el primero', !METODOS_PAGO.some((m) => (m.value as string) === 'CREDITO') && METODOS_PAGO[0].value === 'EFECTIVO')
  const v1 = previsualizarPagoUi({ cuentas, elegidas: null, texto: '120', metodo: 'TRANSFERENCIA', cajaAbierta: null, deudaTotal: 150 })
  check('>>> 120 se reparte: la más antigua (100) saldada y 20 a la siguiente; le deberás 30', v1.listo && v1.partes.length === 2 && v1.partes[0]!.pagada && v1.partes[1]!.monto === 20 && v1.partes[1]!.saldoDespues === 30 && v1.deudaDespues === 30)
  check('>>> cuentas elegidas: solo esas y en el orden elegido', previsualizarPagoUi({ cuentas, elegidas: ['b'], texto: '50', metodo: 'YAPE', cajaAbierta: null, deudaTotal: 150 }).partes.map((p) => p.id).join() === 'b')
  check('>>> sin cuentas elegidas, sin deuda, monto inválido o efectivo sin caja → no se puede enviar, con el mensaje del servidor',
    previsualizarPagoUi({ cuentas, elegidas: [], texto: '10', metodo: 'YAPE', cajaAbierta: null, deudaTotal: 150 }).error === MENSAJE_PAGO_ELIGE_CUENTA &&
    previsualizarPagoUi({ cuentas: [], elegidas: null, texto: '10', metodo: 'YAPE', cajaAbierta: null, deudaTotal: 0 }).error === MENSAJE_PAGO_SIN_DEUDA &&
    previsualizarPagoUi({ cuentas, elegidas: null, texto: 'x', metodo: 'YAPE', cajaAbierta: null, deudaTotal: 150 }).error?.includes('mayor que cero') === true &&
    previsualizarPagoUi({ cuentas, elegidas: null, texto: '10', metodo: 'EFECTIVO', cajaAbierta: false, deudaTotal: 150 }).error === MENSAJE_PAGO_SIN_CAJA)
  check('>>> efectivo con la caja sin comprobar (null) NO bloquea: lo decide el servidor', previsualizarPagoUi({ cuentas, elegidas: null, texto: '10', metodo: 'EFECTIVO', cajaAbierta: null, deudaTotal: 150 }).listo)
  const ex = previsualizarPagoUi({ cuentas, elegidas: null, texto: '150.01', metodo: 'YAPE', cajaAbierta: null, deudaTotal: 150 })
  check('>>> pagar de más: no se envía y dice cuánto se debe', !ex.listo && ex.error === mensajePagoExcede(150.01, 150, false) && mensajePagoExcede(10, 5, true).includes('cuentas elegidas'))
  check('>>> pagar EXACTO lo debido es válido y deja la deuda en 0', previsualizarPagoUi({ cuentas, elegidas: null, texto: '150', metodo: 'YAPE', cajaAbierta: null, deudaTotal: 150 }).deudaDespues === 0)

  console.log('\nB) La vista del modal')
  const vp = (o: Record<string, unknown> = {}) => {
    const base = { nombre: 'Aceros', cuentas, metodo: 'TRANSFERENCIA', texto: '120', referencia: '', elegirManual: false, elegidas: [] as string[], cajaAbierta: null as boolean | null, enviando: false, errorServidor: null as string | null, resultado: null, enLinea: true, onMetodo: noop, onTexto: noop, onReferencia: noop, onElegirManual: noop, onAlternarCuenta: noop, onEnviar: noop, onCerrar: noop }
    const merged = { ...base, ...o } as typeof base & { vista?: unknown }
    return html(createElement(VistaPago, { ...merged, vista: previsualizarPagoUi({ cuentas, elegidas: merged.elegirManual ? merged.elegidas : null, texto: merged.texto, metodo: merged.metodo, cajaAbierta: merged.cajaAbierta, deudaTotal: 150 }) } as never))
  }
  const h1 = vp()
  check('>>> es un diálogo accesible con la vista previa, la deuda restante y el botón con el monto', h1.includes('role="dialog"') && h1.includes('data-pago="vista-previa"') && h1.includes('Le deberás después: S/ 30.00') && h1.includes('Pagar S/ 120.00') && !deshabilitado(h1, 'data-boton="registrar-pago"'))
  check('>>> los métodos son los de pago y el elegido está marcado', METODOS_PAGO.every((m) => h1.includes(`>${m.label}</button>`)) && etiqueta(h1, '>Transferencia<').includes('aria-pressed="true"'))
  check('>>> efectivo: avisa que sale del cajón y que no puede superar lo que hay', vp({ metodo: 'EFECTIVO', cajaAbierta: true }).includes('no puede superar el efectivo que debería haber') && !vp({ metodo: 'EFECTIVO', cajaAbierta: true }).includes('role="alert" data-pago="error"'))
  const sc = vp({ metodo: 'EFECTIVO', cajaAbierta: false })
  check('>>> F6.8c: con transferencia o Yape y sin turno propio también se bloquea, con el mismo mensaje del servidor; con turno, no', previsualizarPagoUi({ cuentas, elegidas: null, texto: '10', metodo: 'TRANSFERENCIA', cajaAbierta: false, deudaTotal: 150 }).error === MENSAJE_PAGO_SIN_CAJA && previsualizarPagoUi({ cuentas, elegidas: null, texto: '10', metodo: 'YAPE', cajaAbierta: false, deudaTotal: 150 }).error === MENSAJE_PAGO_SIN_CAJA && previsualizarPagoUi({ cuentas, elegidas: null, texto: '10', metodo: 'TRANSFERENCIA', cajaAbierta: true, deudaTotal: 150 }).error === null)
  check('>>> efectivo sin caja abierta: lo dice, ofrece transferencia y el botón queda deshabilitado', sc.includes('No tienes tu turno de caja abierto') && deshabilitado(sc, 'data-boton="registrar-pago"') && sc.includes(MENSAJE_PAGO_SIN_CAJA))
  check('>>> pagar de más: error visible y botón deshabilitado', deshabilitado(vp({ texto: '999' }), 'data-boton="registrar-pago"') && vp({ texto: '999' }).includes('data-pago="error"'))
  check('>>> elegir cuentas: lista con orden y saldo; el servidor devuelve su error tal cual', vp({ elegirManual: true, elegidas: ['b', 'a'], texto: '10' }).includes('data-pago="cuentas"') && vp({ elegirManual: true, elegidas: ['b', 'a'], texto: '10' }).includes('aria-label="Orden 1"') && vp({ errorServidor: 'No hay suficiente efectivo en la caja: debería haber S/ 80.00' }).includes('debería haber S/ 80.00'))
  check('>>> sin red o enviando: no se puede pulsar', deshabilitado(vp({ enLinea: false }), 'data-boton="registrar-pago"') && vp({ enLinea: false }).includes('data-pago="sin-red"') && deshabilitado(vp({ enviando: true }), 'data-boton="registrar-pago"'))
  const hecho = vp({ resultado: { paymentId: 'pg1', monto: 120, deudaDespues: 30, reparto: [{ compra: 'C-1', monto: 100, saldoDespues: 0, pagada: true }, { compra: 'C-2', monto: 20, saldoDespues: 30, pagada: false }] } })
  check('>>> tras pagar: resumen, deuda restante y el voucher de 80 mm en una pestaña nueva', hecho.includes('data-pago="hecho"') && hecho.includes('C-1 · saldada') && hecho.includes('Le debes ahora: S/ 30.00') && hecho.includes('href="/imprimir/pago-proveedor/pg1?auto=1"') && etiqueta(hecho, 'data-enlace="voucher-pago"').includes('rel="noopener"'))

  console.log('\nC) Cuentas por pagar (tabla)')
  const inf = { fecha: '2026-10-26', filas: [
    { supplierId: 's1', nombre: 'Aceros', ruc: '20111111111', telefono: '999', cuentas: 2, masAtrasada: 45, vigente: 100, mora1a30: 0, mora31a60: 300, mora61a90: 0, mora91omas: 0, total: 400, vencido: 300 },
    { supplierId: 's2', nombre: 'Bravo', ruc: null, telefono: null, cuentas: 1, masAtrasada: 0, vigente: 50, mora1a30: 0, mora31a60: 0, mora61a90: 0, mora91omas: 0, total: 50, vencido: 0 },
  ], totales: { vigente: 150, mora1a30: 0, mora31a60: 300, mora61a90: 0, mora91omas: 0, total: 450, vencido: 300 }, proveedoresConDeuda: 2, proveedoresVencidos: 1, deudaEnProveedores: 450, coherente: true }
  const tp = (o: Record<string, unknown> = {}) => html(createElement(TablaPorPagar, { informe: inf, enlazarFicha: true, ...o } as never))
  const ht = tp()
  check('>>> resumen (por pagar, vencido, vigente, proveedores vencidos) y una fila por proveedor con sus tramos y días de atraso', ht.includes('S/ 450.00') && ht.includes('1 de 2') && ht.includes('data-proveedor="s1"') && ht.includes('45 días de atraso') && ht.includes('31-60 días') && ht.includes('data-por-pagar="total"'))
  check('>>> el nombre lleva a la ficha solo si quien mira puede abrirla (el contador no)', ht.includes('href="/proveedores/s1"') && !tp({ enlazarFicha: false }).includes('href="/proveedores/s1"') && tp({ enlazarFicha: false }).includes('Aceros'))
  check('>>> descarga CSV desde la ruta de proveedores', etiqueta(ht, 'data-enlace="por-pagar-csv"').includes('href="/api/proveedores/por-pagar"') && etiqueta(ht, 'data-enlace="por-pagar-csv"').includes('download'))
  check('>>> si la deuda guardada no cuadra con las cuentas lo grita; vacío lo dice', tp({ informe: { ...inf, coherente: false, deudaEnProveedores: 460 } }).includes('data-por-pagar="incoherente"') && !ht.includes('data-por-pagar="incoherente"') && tp({ informe: { ...inf, filas: [] } }).includes('data-por-pagar="vacia"'))

  console.log('\nD) Tarjeta del panel')
  const res = { total: 450, vencido: 300, vigente: 150, proveedoresConDeuda: 2, proveedoresVencidos: 1, masUrgentes: [{ supplierId: 's1', nombre: 'Aceros', vencido: 300, masAtrasada: 45 }], coherente: true }
  const hw = html(createElement(PorPagarWidget, { resumen: res, enlazarFichas: true }))
  check('>>> debes, vencido, proveedores y el más urgente con sus días; enlaza a /por-pagar', hw.includes('S/ 450.00') && hw.includes('S/ 300.00') && hw.includes('2 proveedores') && hw.includes('1 proveedor') && hw.includes('Aceros') && hw.includes('45 días') && hw.includes('href="/por-pagar"'))
  const vencEtiq = (r: typeof res) => etiqueta(html(createElement(PorPagarWidget, { resumen: r, enlazarFichas: true })), 'data-por-pagar="vencido"')
  check('>>> con vencido el bloque va en ámbar y avisa; sin vencido, en verde: el color no puede mentir', vencEtiq(res).includes('bg-stock-low-soft') && !vencEtiq(res).includes('bg-stock-ok-soft') && vencEtiq({ ...res, vencido: 0, proveedoresVencidos: 0 }).includes('bg-stock-ok-soft') && !vencEtiq({ ...res, vencido: 0, proveedoresVencidos: 0 }).includes('bg-stock-low-soft'))
  check('>>> sin vencido dice «Todo al día»; el nombre solo enlaza con permiso; incoherente avisa', html(createElement(PorPagarWidget, { resumen: { ...res, vencido: 0, proveedoresVencidos: 0, masUrgentes: [] }, enlazarFichas: true })).includes('Todo al día') && !html(createElement(PorPagarWidget, { resumen: res, enlazarFichas: false })).includes('href="/proveedores/s1"') && html(createElement(PorPagarWidget, { resumen: { ...res, coherente: false }, enlazarFichas: true })).includes('data-por-pagar="incoherente"'))

  console.log('\nE) Pagos de un proveedor')
  const pagos: PagoDeProveedor[] = [
    { id: 'p1', fecha: '2026-10-20', metodo: 'EFECTIVO', monto: 80, referencia: null, pagadoPor: 'Ana', anulado: false, motivoAnulacion: null, anulable: true },
    { id: 'p2', fecha: '2026-10-10', metodo: 'TRANSFERENCIA', monto: 40, referencia: 'OP-1', pagadoPor: 'Ana', anulado: false, motivoAnulacion: null, anulable: false },
    { id: 'p3', fecha: '2026-10-01', metodo: 'YAPE', monto: 10, referencia: null, pagadoPor: 'Ana', anulado: true, motivoAnulacion: 'Error', anulable: false },
  ]
  const lp = (o: Record<string, unknown> = {}) => html(createElement(PagosDelProveedor, { pagos, puedePagar: true, puedeOperar: true, ...o } as never))
  const hp = lp()
  check('>>> cada pago con método, referencia, quién, fecha y su voucher', hp.includes('data-pago="p1"') && hp.includes('OP-1') && hp.includes('01/10/2026') && etiqueta(hp, 'data-enlace="voucher"').includes('href="/imprimir/pago-proveedor/p1"'))
  check('>>> «Anular pago» solo en el vigente de un turno abierto; el de un turno cerrado lo explica; el anulado se ve tachado con su motivo', (hp.match(/data-boton="anular-pago"/g) ?? []).length === 1 && hp.includes(MENSAJE_PAGO_TURNO_CERRADO) && hp.includes('ANULADO: Error') && /line-through[^>]*>S\/ 10\.00/.test(hp))
  check('>>> sin proveedores.pagar no hay anular ni aviso; en solo lectura el botón se ve apagado', !lp({ puedePagar: false }).includes('data-boton="anular-pago"') && !lp({ puedePagar: false }).includes(MENSAJE_PAGO_TURNO_CERRADO) && deshabilitado(lp({ puedeOperar: false }), 'data-boton="anular-pago"'))
  check('>>> sin pagos lo dice', html(createElement(PagosDelProveedor, { pagos: [], puedePagar: true, puedeOperar: true })).includes('data-lista="sin-pagos"'))
  const ap = (o: Record<string, unknown> = {}) => html(createElement(AccionesProveedor, { supplierId: 's1', nombre: 'Aceros', activo: true, deuda: 150, cuentas, puedePagar: true, puedeVerDeuda: true, puedeGestionar: true, puedeComprar: true, puedeOperar: true, ...o } as never))
  check('>>> «Registrar pago» solo con proveedores.pagar y con deuda; en solo lectura apagado; el contador no la ve pero sí el CSV', ap().includes('data-boton="pagar"') && !ap({ puedePagar: false }).includes('data-boton="pagar"') && !ap({ deuda: 0 }).includes('data-boton="pagar"') && deshabilitado(ap({ puedeOperar: false }), 'data-boton="pagar"') && !ap({ puedePagar: false, puedeGestionar: false, puedeComprar: false }).includes('data-boton="pagar"') && ap({ puedePagar: false }).includes('href="/api/proveedores/s1/estado-cuenta"'))
  check('>>> sin ver las cuentas por pagar, ni CSV', !ap({ puedeVerDeuda: false }).includes('data-enlace="estado-cuenta-csv"'))

  console.log('\nF) «Pagar al recibir» (visual)')
  const PC: PermisosCompra = { puedeRegistrar: true, puedeAjustar: true, puedeOperar: true, puedePagar: true }
  const ar = (o: Record<string, unknown> = {}) => html(createElement(AccionesCompra, { purchaseId: 'k1', numero: 'C-9', estado: 'BORRADOR', condicion: 'CREDITO', total: 118, lineas: 1, conPagos: false, proveedor: { id: 's1', name: 'Aceros', deudaActual: 0 }, vence: '2026-11-01', permisos: PC, ...o } as never))
  // El formulario de recibir está oculto hasta pulsar «Recibir»: se mira el código y, para el resto, el render con el panel abierto vía la estructura.
  const src = readFileSync('src/features/compras/components/AccionesCompra.tsx', 'utf8')
  check('>>> la casilla «Pagar al recibir» existe solo para una compra a crédito, con proveedor y con proveedores.pagar', /condicion === 'CREDITO' && permisos\.puedePagar && proveedor &&/.test(src) && src.includes('name="pagarAlRecibir"'))
  check('>>> al contado explica por qué no hay egreso y cómo registrarlo (a crédito con vencimiento hoy)', /condicion === 'CONTADO' && permisos\.puedePagar && proveedor &&/.test(src) && src.includes('data-aviso="contado-sin-egreso"') && src.includes('A crédito'))
  check('>>> recibir devuelve la cuenta y SOLO con la casilla marcada abre el modal de pago apuntando a ella y por su total', src.includes('if (pagarAlRecibir && cuenta && vence)') && src.includes('elegidasIniciales={aPagar.map((x) => x.id)}') && src.includes('montoInicial={total.toFixed(2)}') && src.includes('deudaTotal={proveedor.deudaActual + total}'))
  check('>>> sin la casilla (o sin permiso) recibir se comporta como siempre: refresca', /router\.refresh\(\)\s*\n\s*\}\)\s*\n\s*\}/.test(src) && ar().includes('data-boton="recibir"'))
  const fcSrc = readFileSync('src/features/compras/components/FormularioCompra.tsx', 'utf8')
  check('>>> el formulario ofrece «Vence hoy (se paga al recibir)» para compras a crédito', fcSrc.includes('data-boton="vence-hoy"') && fcSrc.includes('setVence(hoy)'))

  console.log('\nG) Con datos reales')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `pa-pant-${randomUUID().slice(0, 6)}`, name: 'Pantallas por pagar', legalName: 'PANTALLAS POR PAGAR SAC', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_pp' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const ctxs: Record<string, TenantContext> = {}
  for (const r of ['OWNER', 'CAJERO', 'CONTADOR', 'ALMACENERO'] as Role[]) {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${r}-${randomUUID()}@x.com`.toLowerCase(), name: r, role: r } })
    await asignarSucursal(t.id, u.id, b1.branch.id)
    ctxs[r] = { tenantId: t.id, userId: u.id, role: r, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  }
  const O = ctxs.OWNER!, db = getTenantPrisma(O)
  const hoy = hoyEnZona((await prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })).timezone)
  const sup = await crearProveedor(db, O, crearProveedorSchema.parse({ name: 'Aceros del Sur', taxId: ruc() }))
  const comprar = async (monto: number, vence: string, supplierId = sup.id) => {
    const p = await prisma.product.create({ data: { tenantId: t.id, sku: `P-${randomUUID().slice(0, 6)}`, name: 'Prod', unitType: 'UNIDAD', salePrice: 20, costPrice: 0, taxRate: 0 } })
    const c = await crearBorrador(db, O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: b1.warehouse.id, supplierId, paymentCondition: 'CREDITO', vence, items: [{ productId: p.id, enteredQuantity: 1, unitCost: monto }] }))
    const r = await recibirCompra(db, O, recibirCompraSchema.parse({ purchaseId: c.id }))
    return { c, cxp: r.cuentaPorPagarId! }
  }
  const x1 = await comprar(100, '2026-01-10'), x2 = await comprar(250, '2027-12-10')

  const prev = await previsualizarPago(db, O, previsualizarPagoSchema.parse({ supplierId: sup.id, amount: 120 }))
  const ui = previsualizarPagoUi({ cuentas: prev.reparto.map((r) => ({ id: r.payableId, compra: r.compra, saldo: r.saldo, vence: r.vence, vencida: false })), elegidas: null, texto: '120', metodo: 'TRANSFERENCIA', cajaAbierta: null, deudaTotal: 350 })
  check('>>> la vista previa de la PANTALLA es idéntica a la del SERVIDOR (cuentas, montos, saldos, pagadas)', JSON.stringify(ui.partes.map((p) => [p.id, p.monto, p.saldoDespues, p.pagada])) === JSON.stringify(prev.reparto.map((r) => [r.payableId, r.monto, r.saldoDespues, r.pagada])))
  const sinCaja = await msg(registrarPagoProveedor(db, O, registrarPagoSchema.parse({ supplierId: sup.id, amount: 10, method: 'EFECTIVO', idempotencyKey: randomUUID() })))
  const turno = await openCashSession(db, O, openCashSchema.parse({ openingAmount: 300 }))   // F6.8b: pagar, con cualquier medio, exige el turno propio
  const sobra = await msg(registrarPagoProveedor(db, O, registrarPagoSchema.parse({ supplierId: sup.id, amount: 400, method: 'TRANSFERENCIA', idempotencyKey: randomUUID() })))
  check('>>> y cuando pagas de más, pantalla y servidor dicen EXACTAMENTE lo mismo', sobra === previsualizarPagoUi({ cuentas: prev.reparto.map((r) => ({ id: r.payableId, compra: r.compra, saldo: r.saldo, vence: r.vence, vencida: false })), elegidas: null, texto: '400', metodo: 'TRANSFERENCIA', cajaAbierta: null, deudaTotal: 350 }).error, String(sobra))
  check('>>> el texto del rechazo es el que lee la persona: «supera lo que le debes al proveedor (S/ 350.00)»', (sobra ?? '').includes('supera lo que le debes al proveedor (S/ 350.00)') && mensajePagoExcede(10, 5, true).startsWith('El pago (S/ 10.00) supera lo que se debe en las cuentas elegidas'))
  check('>>> el efectivo sin caja: el mensaje del servidor es el de la pantalla', sinCaja === MENSAJE_PAGO_SIN_CAJA)
  const pEf = await registrarPagoProveedor(db, O, registrarPagoSchema.parse({ supplierId: sup.id, amount: 100, method: 'EFECTIVO', idempotencyKey: randomUUID() }))
  const pTr = await registrarPagoProveedor(db, O, registrarPagoSchema.parse({ supplierId: sup.id, amount: 20, method: 'TRANSFERENCIA', reference: 'OP-77', idempotencyKey: randomUUID() }))

  const lista = await ultimosPagosDeProveedor(db, O, sup.id)
  check('>>> los pagos reales: el más reciente primero, con su método, referencia, quién y «anulable» (turno abierto)', lista.length === 2 && lista[0]!.id === pTr.paymentId && lista[0]!.referencia === 'OP-77' && lista.every((p) => p.anulable && !p.anulado && p.pagadoPor === 'OWNER'))
  check('>>> la lista de pagos exige poder ver las cuentas por pagar (el cajero no; el contador sí)', await code(ultimosPagosDeProveedor(getTenantPrisma(ctxs.CAJERO!), ctxs.CAJERO!, sup.id)) === 'FORBIDDEN_ROLE' && await code(ultimosPagosDeProveedor(getTenantPrisma(ctxs.CONTADOR!), ctxs.CONTADOR!, sup.id)) === null)
  const hpr = html(createElement(PagosDelProveedor, { pagos: lista, puedePagar: true, puedeOperar: true }))
  check('>>> y la pantalla los muestra con voucher y anular', hpr.includes(`href="/imprimir/pago-proveedor/${pEf.paymentId}"`) && (hpr.match(/data-boton="anular-pago"/g) ?? []).length === 2)

  console.log('\nH) El voucher')
  const v = await getVoucherPago(db, O, pEf.paymentId)
  check('>>> número PP-AAAAMMDD-XXXXXX estable, proveedor, método, monto, a qué compra se aplicó y la deuda restante de ese momento', /^PP-\d{8}-[0-9A-Z]{6}$/.test(v.numero) && v.numero === numeroDeVoucher(pEf.paymentId, hoy) && v.numero.endsWith(pEf.paymentId.slice(-6).toUpperCase()) && v.numero.includes(hoy.replaceAll('-', '')) && v.proveedor.nombre === 'Aceros del Sur' && v.monto === 100 && v.reparto.length === 1 && v.reparto[0]!.monto === 100 && v.deudaDespues === 250 && !v.anulado, JSON.stringify([v.numero, v.deudaDespues]))
  await registrarPagoProveedor(db, O, registrarPagoSchema.parse({ supplierId: sup.id, amount: 50, method: 'YAPE', idempotencyKey: randomUUID() }))
  check('>>> reimprimir días después sigue diciendo lo que quedaba AQUELLA tarde (no la deuda de hoy)', (await getVoucherPago(db, O, pEf.paymentId)).deudaDespues === 250)
  const ht2 = html(createElement(TicketPagoProveedor, { voucher: v }))
  check('>>> el ticket: «PAGO A PROVEEDOR», emisor, proveedor, monto, compra y deuda restante; dice que es interno y NO anulado', ht2.includes('PAGO A PROVEEDOR') && ht2.includes('PANTALLAS POR PAGAR SAC') && ht2.includes('Aceros del Sur') && ht2.includes('S/ 100.00') && ht2.includes('data-ticket="deuda"') && ht2.includes('Voucher interno de caja') && !ht2.includes('PAGO ANULADO'))
  await anularPagoProveedor(db, O, anularPagoSchema.parse({ paymentId: pTr.paymentId, motivo: 'Operación rechazada' }))
  const va = await getVoucherPago(db, O, pTr.paymentId)
  const hta = html(createElement(TicketPagoProveedor, { voucher: va }))
  check('>>> un pago anulado imprime marca de agua, «PAGO ANULADO» y el motivo', va.anulado && hta.includes('t-marca') && hta.includes('PAGO ANULADO') && hta.includes('Operación rechazada'))
  check('>>> el voucher lo ve quien ve las cuentas por pagar (dueño y contador); cajero y almacenero común no', await code(getVoucherPago(getTenantPrisma(ctxs.CONTADOR!), ctxs.CONTADOR!, pEf.paymentId)) === null && await code(getVoucherPago(getTenantPrisma(ctxs.CAJERO!), ctxs.CAJERO!, pEf.paymentId)) === 'FORBIDDEN_ROLE' && await code(getVoucherPago(getTenantPrisma(ctxs.ALMACENERO!), ctxs.ALMACENERO!, pEf.paymentId)) === 'FORBIDDEN_ROLE')
  const otro = await prisma.tenant.create({ data: { slug: `pa-pant2-${randomUUID().slice(0, 6)}`, name: 'Otro', taxId: ruc(), planId: plan.id } })
  const uo = await prisma.user.create({ data: { tenantId: otro.id, email: `o-${randomUUID()}@x.com`, name: 'O', role: 'OWNER' } })
  const Ox: TenantContext = { tenantId: otro.id, userId: uo.id, role: 'OWNER', access: 'FULL', permisosExtra: [] }
  check('>>> el voucher de OTRO negocio no existe', await code(getVoucherPago(getTenantPrisma(Ox), Ox, pEf.paymentId)) === 'NOT_FOUND')

  console.log('\nI) La caja con pagos a proveedores')
  const turnoAntes = await prisma.cashSession.findUniqueOrThrow({ where: { id: turno.id } })
  const cierre = await closeCashSession(db, O, closeCashSchema.parse({ sessionId: turno.id, countedAmount: 200 }))
  check('>>> cierre: efectivo esperado = 300 − 100 pagados a proveedores = 200 (el Yape de 50 no tocó el cajón); cuadra', cierre.expectedAmount === 200 && cierre.difference === 0 && cierre.supplierCashPaymentsTotal === 100 && cierre.supplierOtherPaymentsTotal === 50 && num(turnoAntes.openingAmount) === 300)
  const ultimo = await prisma.cashSession.findFirstOrThrow({ where: { id: turno.id } })
  const cierreUi = { id: ultimo.id, openingAmount: num(ultimo.openingAmount), countedAmount: num(ultimo.countedAmount), expectedAmount: num(ultimo.expectedAmount), difference: num(ultimo.difference), salesCount: 0, salesTotal: 0, cashTotal: 0, changeTotal: 0, creditSalesTotal: 0, cashReceiptsTotal: 0, otherReceiptsTotal: 0, refundsCashTotal: 0, refundsOtherTotal: 0, movimientos: { ingresos: 0, egresos: 0, compensacionesEfectivo: 0, compensacionesOtrosMedios: 0 }, supplierCashPaymentsTotal: num(ultimo.supplierCashPaymentsTotal), supplierOtherPaymentsTotal: num(ultimo.supplierOtherPaymentsTotal), closedAt: new Date().toISOString() }
  const hc = html(createElement(CashPanel, { turno: null, ultimoCierre: cierreUi, sucursal: 'Principal', puedeOperar: true, zonaHoraria: 'America/Lima' }))
  check('>>> el último cierre muestra los pagos a proveedores en efectivo (restan) con lo que realmente quedó congelado', hc.includes('Pagos a proveedores en efectivo') && hc.includes('- S/ 100.00') && hc.includes('S/ 200.00'))
  check('>>> sin pagos a proveedores el cierre no muestra esa línea (un negocio que no paga de caja no la ve)', !html(createElement(CashPanel, { turno: null, ultimoCierre: { ...cierreUi, supplierCashPaymentsTotal: 0, supplierOtherPaymentsTotal: 0 }, sucursal: 'P', puedeOperar: true, zonaHoraria: 'America/Lima' })).includes('Pagos a proveedores'))
  const cp = readFileSync('src/features/branches/components/CashPanel.tsx', 'utf8'), pagCaja = readFileSync('src/app/(dashboard)/caja/page.tsx', 'utf8')
  check('>>> el cierre recién hecho también lo muestra (efectivo restando y otros medios aparte), y la página de caja lee y mapea las dos columnas congeladas', cp.includes('resultado.supplierCashPaymentsTotal > 0') && cp.includes('resultado.supplierOtherPaymentsTotal > 0') && pagCaja.includes('supplierCashPaymentsTotal: true, supplierOtherPaymentsTotal: true') && pagCaja.includes('supplierCashPaymentsTotal: n(ultimo.supplierCashPaymentsTotal)'))
  check('>>> el turno abierto NO adelanta el esperado (el arqueo sigue ciego)', !/turno\.expectedAmount/.test(cp.replace(/expectedAmount: number/g, '')))
  const lista2 = await ultimosPagosDeProveedor(db, O, sup.id)
  check('>>> tras cerrar el turno, el pago en efectivo ya NO es anulable (la pantalla no lo ofrece) y el servidor lo rechazaría', lista2.find((p) => p.id === pEf.paymentId)?.anulable === false && await code(anularPagoProveedor(db, O, anularPagoSchema.parse({ paymentId: pEf.paymentId, motivo: 'Intento' }))) === 'INVALID_DOCUMENT')

  console.log('\nJ) «Pagar al recibir» de punta a punta')
  const sup2 = await crearProveedor(db, O, crearProveedorSchema.parse({ name: 'Bravo SAC', taxId: ruc() }))
  const turno2 = await openCashSession(db, O, openCashSchema.parse({ openingAmount: 500 }))
  const pp = await prisma.product.create({ data: { tenantId: t.id, sku: 'PAR', name: 'Pagar al recibir', unitType: 'UNIDAD', salePrice: 20, costPrice: 0, taxRate: 0 } })
  const bor = await crearBorrador(db, O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: b1.warehouse.id, supplierId: sup2.id, paymentCondition: 'CREDITO', vence: hoy, items: [{ productId: pp.id, enteredQuantity: 3, unitCost: 40 }] }))
  const rec = await recibirCompra(db, O, recibirCompraSchema.parse({ purchaseId: bor.id }))
  const cxpNueva = await prisma.accountPayable.findUniqueOrThrow({ where: { id: rec.cuentaPorPagarId! } })
  check('>>> recibir devuelve la cuenta recién nacida, por el total y venciendo hoy', num(cxpNueva.amount) === 120 && cxpNueva.dueDate.toISOString().slice(0, 10) === hoy && cxpNueva.status === 'ABIERTA')
  const pago = await registrarPagoProveedor(db, O, registrarPagoSchema.parse({ supplierId: sup2.id, amount: 120, method: 'EFECTIVO', payableIds: [rec.cuentaPorPagarId!], idempotencyKey: randomUUID() }))
  const cxpPag = await prisma.accountPayable.findUniqueOrThrow({ where: { id: rec.cuentaPorPagarId! } })
  const sBravo = await prisma.supplier.findUniqueOrThrow({ where: { id: sup2.id } })
  check('>>> pagar esa cuenta por su total: queda PAGADA, la deuda del proveedor en 0, y el egreso sale del cajón (500 → 380)', cxpPag.status === 'PAGADA' && num(sBravo.payableBalance) === 0 && pago.reparto[0]!.pagada && (await prisma.supplierPayment.findUniqueOrThrow({ where: { id: pago.paymentId } })).cashSessionId === turno2.id)
  const arq = await closeCashSession(db, O, closeCashSchema.parse({ sessionId: turno2.id, countedAmount: 380 }))
  check('>>> y el arqueo lo refleja: esperado 380, cuadra (el egreso de «pagar al recibir» queda en el cierre)', arq.expectedAmount === 380 && arq.difference === 0 && arq.supplierCashPaymentsTotal === 120)
  check('>>> si el pago falla (efectivo sin caja), la compra queda recibida CON su deuda y se paga después: nada se pierde', await (async () => {
    const b2 = await crearBorrador(db, O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: b1.warehouse.id, supplierId: sup2.id, paymentCondition: 'CREDITO', vence: hoy, items: [{ productId: pp.id, enteredQuantity: 1, unitCost: 10 }] }))
    const r2 = await recibirCompra(db, O, recibirCompraSchema.parse({ purchaseId: b2.id }))
    const falla = await code(registrarPagoProveedor(db, O, registrarPagoSchema.parse({ supplierId: sup2.id, amount: 10, method: 'EFECTIVO', payableIds: [r2.cuentaPorPagarId!], idempotencyKey: randomUUID() })))
    return falla === 'CASH_REQUIRED' && (await prisma.purchase.findUniqueOrThrow({ where: { id: b2.id } })).status === 'RECIBIDA' && num((await prisma.supplier.findUniqueOrThrow({ where: { id: sup2.id } })).payableBalance) === 10
  })())

  console.log('\nK) Informe, tarjeta y quién ve qué')
  const informe = await informeDePorPagar(db, O)
  const hti = html(createElement(TablaPorPagar, { informe, enlazarFicha: true }))
  const resumen = await resumenPorPagar(db, O)
  check('>>> la tabla real: Aceros del Sur con 200 (350 − 100 en efectivo − 50 por Yape; el pago de 20 se anuló) y Bravo con 10, coherente', informe.coherente && informe.filas.some((f) => f.nombre === 'Aceros del Sur' && f.total === 200) && informe.filas.some((f) => f.nombre === 'Bravo SAC' && f.total === 10) && hti.includes('href="/proveedores/'), JSON.stringify(informe.filas.map((f) => [f.nombre, f.total])))
  check('>>> la tarjeta del panel sale del mismo informe', resumen.total === informe.totales.total && resumen.vencido === informe.totales.vencido && html(createElement(PorPagarWidget, { resumen, enlazarFichas: true })).includes(`S/ ${resumen.total.toFixed(2)}`))
  void x1; void x2; void anularCompra; void anularCompraSchema

  console.log('\nL) Páginas, rutas, menú y permisos')
  const D = 'src/app/(dashboard)'
  const pg = readFileSync(`${D}/por-pagar/page.tsx`, 'utf8'), panel = readFileSync(`${D}/panel/page.tsx`, 'utf8'), ficha = readFileSync(`${D}/proveedores/[id]/page.tsx`, 'utf8')
  const rutaTotal = readFileSync('src/app/api/proveedores/por-pagar/route.ts', 'utf8'), rutaEstado = readFileSync('src/app/api/proveedores/[id]/estado-cuenta/route.ts', 'utf8')
  const rutaVoucher = readFileSync('src/app/(print)/imprimir/pago-proveedor/[id]/page.tsx', 'utf8')
  check('>>> la página exige sesión y decide con puedeVerPorPagar (404 si no); el nombre enlaza con puedeVerProveedores', pg.includes('await requireTenantContext()') && pg.includes('if (!puedeVerPorPagar(ctx)) notFound()') && pg.includes('enlazarFicha={puedeVerProveedores(ctx)}'))
  check('>>> el panel calcula «Por pagar» solo para quien lo ve y solo lo pinta si hay deuda', panel.includes('puedeVerPorPagar(ctx) ? resumenPorPagar(db, ctx) : Promise.resolve(null)') && panel.includes('porPagar && porPagar.proveedoresConDeuda > 0') && panel.includes('!porPagar'))
  check('>>> la ficha lee los pagos solo si ve las cuentas por pagar y pasa pagar/ver desde el servidor', ficha.includes('verDeuda ? ultimosPagosDeProveedor(db, ctx, ficha.id) : Promise.resolve(null)') && ficha.includes("puedePagar: puede(ctx, 'proveedores.pagar')") && !/ctx\.role/.test(ficha + pg))
  check('>>> las dos rutas CSV: sesión (401), respuestaCsv con sus cabeceras, permisos 403, no existe 404, sin cachear; el servicio decide el permiso', [rutaTotal, rutaEstado].every((s) => s.includes('requireTenantContext().catch(() => null)') && s.includes("status: 401") && s.includes('respuestaCsv(archivo)') && s.includes("e.code === 'FORBIDDEN_ROLE' ? 403") && s.includes("export const dynamic = 'force-dynamic'") && !/puede\(|exigir\(|ctx\.role/.test(s)) && rutaEstado.includes("e.code === 'NOT_FOUND' ? 404"))
  const paginaVoucher = rutaVoucher.slice(rutaVoucher.indexOf('export default'))
  check('>>> la ruta del voucher exige sesión EN LA PÁGINA, da 404 si no existe o no se puede ver, y vuelve a /por-pagar', paginaVoucher.includes('const ctx = await requireTenantContext()') && paginaVoucher.indexOf('requireTenantContext') < paginaVoucher.indexOf('getVoucherPago') && rutaVoucher.includes("e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN_ROLE'") && rutaVoucher.includes('volverA="/por-pagar"'))
  const enMenu = (r: Role, extra: TenantContext['permisosExtra'] = []) => visibleItems([...permisosDe(rolCtx(r, extra))]).some((i) => i.href === '/por-pagar')
  const enProv = (r: Role) => visibleItems([...permisosDe(rolCtx(r))]).some((i) => i.href === '/proveedores')
  check('>>> el menú muestra «Por pagar» a dueño, admin, almacenero con compras Y AL CONTADOR; a nadie más', enMenu('OWNER') && enMenu('ADMIN') && enMenu('ALMACENERO', ['compras.registrar']) && enMenu('CONTADOR') && !enMenu('CAJERO') && !enMenu('VENDEDOR') && !enMenu('ALMACENERO'))
  check('>>> pero el contador NO ve Proveedores ni Compras en el menú (solo la deuda)', !enProv('CONTADOR') && !visibleItems([...permisosDe(rolCtx('CONTADOR'))]).some((i) => i.href === '/compras'))
  check('>>> el enlace usa la MISMA lista pura que la página (PERMISOS_VER_POR_PAGAR) y el nav no arrastra el servidor', /href: '\/por-pagar',[\s\S]*?permisos: \[\.\.\.PERMISOS_VER_POR_PAGAR\]/.test(readFileSync('src/features/shell/nav-items.ts', 'utf8')) && PERMISOS_VER_POR_PAGAR.length === 4 && readFileSync('src/features/shell/nav-items.ts', 'utf8').includes("from '@/features/por-pagar/permisos'"))
  check('>>> el contador ve la antigüedad real y no puede pagar', await code(informeDePorPagar(getTenantPrisma(ctxs.CONTADOR!), ctxs.CONTADOR!)) === null && await code(registrarPagoProveedor(getTenantPrisma(ctxs.CONTADOR!), ctxs.CONTADOR!, registrarPagoSchema.parse({ supplierId: sup.id, amount: 1, method: 'YAPE', idempotencyKey: randomUUID() }))) === 'FORBIDDEN_ROLE')
  check('>>> los componentes con estado son de cliente; el modal usa la lógica pura (pago-ui) que el servidor también usa', ['ModalPago', 'PagosDelProveedor'].every((c) => readFileSync(`src/features/por-pagar/components/${c}.tsx`, 'utf8').startsWith("'use client'")) && readFileSync('src/features/por-pagar/pagos.ts', 'utf8').includes("from './pago-ui'") && readFileSync('src/features/por-pagar/components/ModalPago.tsx', 'utf8').includes('previsualizarPagoUi('))
  const modalSrc = readFileSync('src/features/por-pagar/components/ModalPago.tsx', 'utf8')
  check('>>> el modal abre con las cuentas iniciales ya elegidas (pagar al recibir) y su dependencia es el CONTENIDO de la lista, no su identidad', modalSrc.includes("setElegirManual(cuentasIniciales !== '')") && modalSrc.includes("cuentasIniciales.split('|')") && modalSrc.includes('[abierto, cuentasIniciales, montoInicial]') && modalSrc.includes('setTexto(montoInicial ?? \'\')'))
  check('>>> el modal conserva su clave de idempotencia entre reintentos y la renueva solo tras un pago hecho', /clave\.current = crypto\.randomUUID\(\)\n    setTexto/.test(readFileSync('src/features/por-pagar/components/ModalPago.tsx', 'utf8')) && readFileSync('src/features/por-pagar/components/ModalPago.tsx', 'utf8').includes('idempotencyKey: clave.current') && /clave\.current = crypto\.randomUUID\(\)\n      setResultado/.test(readFileSync('src/features/por-pagar/components/ModalPago.tsx', 'utf8')))
  check('>>> hay pantalla de carga para /por-pagar', existsSync(`${D}/por-pagar/loading.tsx`))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
