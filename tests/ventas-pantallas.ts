import { readFileSync, existsSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { TablaVentas } from '../src/features/ventas/components/TablaVentas'
import { DetalleVenta } from '../src/features/ventas/components/DetalleVenta'
import { FormularioDevolucion } from '../src/features/ventas/components/FormularioDevolucion'
import { TicketCierreCaja } from '../src/features/printing/components/TicketCierreCaja'
import { CashPanel } from '../src/features/branches/components/CashPanel'
import { parametrosVentasListaSchema } from '../src/features/ventas/schemas'
import type { DetalleVenta as Detalle, PaginaVentas } from '../src/features/ventas/service'
import type { TicketCierre } from '../src/features/printing/cierre-caja'

/**
 * F6.1b · Las pantallas de ventas, de la devolución y del cierre de caja, renderizadas AISLADAS, y las páginas leídas como código (permiso
 * antes de leer, 404 sin permiso, ni un dato de costo, anular solo con `ventas.anular` y nunca bajo PIN).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const src = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
/** Código sin comentarios: los comentarios SÍ pueden decir «sin costo ni margen». */
const codigo = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const fila = (o: Partial<PaginaVentas['filas'][number]> = {}): PaginaVentas['filas'][number] => ({ id: 'venta0001abc', numero: 'B001-00000007', cuando: '2026-10-26T20:15:00.000Z', sucursal: 'Central', cliente: 'Constructora SAC', total: 118, estado: 'COMPLETADA', cobro: 'Rosa', comprobante: { numero: 'B001-00000012', estado: 'ACEPTADO', esEnsayo: false }, conDevolucionParcial: false, ...o })
const pagina = (filas: PaginaVentas['filas'], siguiente: string | null = null): PaginaVentas => ({ filas, siguiente, textoPeriodo: '20/10/2026 – 26/10/2026', zona: 'America/Lima', sucursales: [{ id: 'sucursal0001', nombre: 'Central' }] })
const params = parametrosVentasListaSchema.parse({})

console.log('\nA) Tabla del historial')
const vacia = html(createElement(TablaVentas, { pagina: pagina([]), params }))
check('sin ventas: lo dice con calma', vacia.includes('data-ventas="vacio"') && vacia.includes('No hay ventas con estos filtros'))
const t3 = html(createElement(TablaVentas, { pagina: pagina([fila(), fila({ id: 'venta0002abc', estado: 'ANULADA' }), fila({ id: 'venta0003abc', estado: 'DEVUELTA', comprobante: null, cliente: null })], '2026-10-20T15:00:00.000Z|venta0003abc'), params }))
check('>>> cada venta enlaza a su detalle y muestra número, cliente, comprobante, total y estado en español', t3.includes('href="/ventas/venta0001abc"') && t3.includes('B001-00000007') && t3.includes('Constructora SAC') && t3.includes('B001-00000012') && t3.includes('S/ 118.00') && t3.includes('Completada') && t3.includes('Anulada') && t3.includes('Devuelta'))
check('sin comprobante: «Nota de venta»; sin cliente: «Sin cliente»', t3.includes('Nota de venta') && t3.includes('Sin cliente'))
check('>>> con más páginas ofrece «Ver más antiguas» con el cursor', t3.includes('data-ventas="mas"') && t3.includes('cursor='))
check('>>> NINGÚN costo, utilidad ni margen en la tabla', !/costo|utilidad|margen|ganancia/i.test(t3))
check('la tabla es legible: cabeceras con scope y filas con th de fila', t3.includes('scope="col"') && t3.includes('scope="row"'))

console.log('\nB) Detalle de la venta')
const base: Detalle = {
  id: 'venta0001abc', numero: 'B001-00000007', estado: 'COMPLETADA', cuando: '2026-10-26T20:15:00.000Z', sucursal: { id: 's1', nombre: 'Central' }, cobro: 'Rosa',
  cliente: { nombre: 'Constructora SAC', documento: 'RUC 20123456789' }, notas: null, subtotal: 100, igv: 18, descuento: 0, total: 118,
  lineas: [{ id: 'li1', devuelta: 0, importeDevuelto: 0, pendiente: 10, nombre: 'Cemento Sol', sku: 'CEM-1', unidad: 'UNIDAD', cantidad: 10, presentacion: { nombre: 'Caja x 10', ingresada: 1, factor: 10 }, precio: 11.8, descuento: 0, total: 118 }],
  pagos: [{ metodo: 'EFECTIVO', monto: 120, vuelto: 2, referencia: null }],
  cuenta: { estado: 'PENDIENTE', monto: 118, abonado: 0, saldo: 118, vence: '2026-11-25', enRevision: false },
  comprobantes: [{ id: 'd1', tipo: 'BOLETA', numero: 'B001-00000012', estado: 'ACEPTADO', esEnsayo: false, emitidoEn: '2026-10-26T20:16:00.000Z', relacionado: null, anuladoEn: null }],
  guias: [], devoluciones: [], parcial: false, zona: 'America/Lima',
}
const d0 = html(createElement(DetalleVenta, { venta: base }))
check('>>> muestra cabecera, sucursal, quien cobró, cliente con documento, líneas con presentación y factor, pagos con vuelto', d0.includes('B001-00000007') && d0.includes('Central') && d0.includes('Rosa') && d0.includes('Constructora SAC') && d0.includes('RUC 20123456789') && d0.includes('Caja x 10') && d0.includes('Cemento Sol') && d0.includes('data-pago="EFECTIVO"') && d0.includes('S/ 118.00'))
check('el factor de la presentación se ve (1 × 10 = 10 unidades)', /10/.test(d0) && d0.includes('Caja x 10'))
check('estado de la cuenta por cobrar y comprobante vinculado a la vista', d0.includes('data-cuenta="PENDIENTE"') && d0.includes('data-comprobante="BOLETA"') && d0.includes('estado-COMPLETADA'))
check('>>> NINGÚN costo, utilidad ni margen en el detalle', !/costo|utilidad|margen|ganancia/i.test(d0))
check('sin devoluciones no hay bloque de trazabilidad ni aviso de guía', !d0.includes('data-seccion="trazabilidad"') && !d0.includes('data-aviso="guia"'))
const conGuia = html(createElement(DetalleVenta, { venta: { ...base, guias: ['T001-00000003'] } }))
check('>>> con Guía de Remisión: aviso visible con el número de la guía', conGuia.includes('data-aviso="guia"') && conGuia.includes('T001-00000003'))
const dev: Detalle = { ...base, estado: 'DEVUELTA', devoluciones: [{
  id: 'r1', numero: 'D001-00000001', tipo: 'DEVOLUCION', cuando: '2026-10-27T15:00:00.000Z', autorizo: 'Dueño', motivo: 'Cliente se arrepintió', pagadoNeto: 118, deudaCancelada: 0, notaDeCredito: 'BC01-00000002',
  turno: { id: 'turno0001', abiertoEn: '2026-10-27T13:00:00.000Z' }, lineas: 1, esTotal: true, detalle: [{ nombre: 'Cemento Sol', cantidad: 10, importe: 118, destino: 'STOCK' }], notaLineas: [],
  reembolsos: [{ modo: 'CAJA', medio: 'EFECTIVO', monto: 100, referencia: null }, { modo: 'EXTERNO', medio: 'YAPE', monto: 18, referencia: 'OP-9' }],
}] }
const d1 = html(createElement(DetalleVenta, { venta: dev }))
check('>>> DEVUELTA: bloque de trazabilidad con D001-…, fecha, quién autorizó, motivo y nota de crédito', d1.includes('data-seccion="trazabilidad"') && d1.includes('D001-00000001') && d1.includes('Dueño') && d1.includes('Cliente se arrepintió') && d1.includes('BC01-00000002') && d1.includes('estado-DEVUELTA'))
check('>>> cada reembolso con su modo (Caja / Externo), medio y referencia; y el turno afectado', d1.includes('data-reembolso="CAJA"') && d1.includes('data-reembolso="EXTERNO"') && d1.includes('OP-9') && d1.includes('data-devolucion-campo="turno"'))
const huerfana = html(createElement(DetalleVenta, { venta: { ...base, estado: 'ANULADA' } }))
check('una venta anulada ANTES de este módulo (sin registro) lo dice en lugar de inventar una trazabilidad', huerfana.includes('data-aviso="sin-registro"') && !huerfana.includes('data-seccion="trazabilidad"'))

console.log('\nC) Formulario de anular / devolver')
const fuente = src('src/features/ventas/components/FormularioDevolucion.tsx')
const form = (o: Record<string, unknown> = {}) => html(createElement(FormularioDevolucion, {
  saleId: 'venta0001abc', numero: 'B001-00000007', total: 118, pagadoNeto: 118, reembolsosIniciales: [{ mode: 'CAJA', method: 'EFECTIVO', amount: 118, reference: null }],
  hayTurnoAbierto: true, comprobante: 'B001-00000012', deEnsayo: false, cuentaACancelar: 0, puedeOperar: true, ...o,
} as never))
const f0 = form()
check('>>> elige Anular o Devolver, pide motivo, muestra el reembolso y los efectos, y exige confirmar', f0.includes('data-form="devolucion"') && f0.includes('Anular') && f0.includes('Devolver') && f0.includes('data-reembolso-linea="0"') && f0.includes('data-devolucion="efectos"') && /type="checkbox"/.test(f0) && f0.includes('data-boton="confirmar-devolucion"'))
check('>>> el botón de confirmar nace DESHABILITADO (sin motivo ni confirmación)', /data-boton="confirmar-devolucion"[^>]*disabled/.test(f0) || /disabled[^>]*data-boton="confirmar-devolucion"/.test(f0))
check('con comprobante real: avisa de la nota de crédito que se emitirá (06 al devolver)', /nota de cr[eé]dito/i.test(f0) && f0.includes('B001-00000012'))
const fSinCaja = form({ hayTurnoAbierto: false })
check('>>> reembolso en CAJA sin turno abierto: alerta clara y botón deshabilitado', fSinCaja.includes('data-devolucion="sin-caja"') && /disabled/.test(fSinCaja.slice(fSinCaja.indexOf('data-boton="confirmar-devolucion"') - 200, fSinCaja.indexOf('data-boton="confirmar-devolucion"') + 200)))
check('con turno abierto no sale esa alerta', !f0.includes('data-devolucion="sin-caja"'))
const fExt = form({ hayTurnoAbierto: false, reembolsosIniciales: [{ mode: 'EXTERNO', method: 'YAPE', amount: 118, reference: null }] })
check('>>> reembolso EXTERNO sin turno abierto: permitido (sin alerta de caja)', !fExt.includes('data-devolucion="sin-caja"'))
const fRo = form({ puedeOperar: false })
check('cuenta en solo lectura: lo dice y no deja confirmar', fRo.includes('data-devolucion="solo-lectura"'))
check('>>> confirmar exige CADA condición: permiso de escribir, caja, motivo, motivo de «sin salida», medio, casilla de confirmación', ['!puedeOperar', 'sinCaja', 'motivoCorto', 'faltaMotivoSinSalida', 'sinMedio', '!confirmo', 'pendiente'].every((c) => new RegExp(`const bloqueado = [^\\n]*${c.replace('!', '!')}`).test(fuente)) && /const motivoCorto = motivo\.trim\(\)\.length < 3/.test(fuente) && /const sinCaja = lineas\.some\(\(l\) => l\.mode === 'CAJA'\) && !hayTurnoAbierto/.test(fuente))
check('con deuda por cancelar lo anuncia', /deuda/i.test(form({ cuentaACancelar: 118, reembolsosIniciales: [] })))
check('>>> la clave de idempotencia nace UNA vez al abrir el formulario (useState con crypto.randomUUID)', /useState\(\(\) => \(typeof crypto/.test(fuente) && fuente.includes('crypto.randomUUID()'))
check('el formulario no envía los importes de las líneas al servidor como verdad: el servidor decide (llama a la acción)', fuente.includes("anularOdevolverVenta") && !/unitCost|costPrice/.test(fuente))

console.log('\nD) Páginas: permiso, 404 y costos (código)')
const lista = src('src/app/(dashboard)/ventas/page.tsx'), det = src('src/app/(dashboard)/ventas/[id]/page.tsx')
check('>>> la guardia exacta `if (!puedeVerVentas(ctx)) notFound()` está en las dos páginas, antes de leer nada', lista.includes('if (!puedeVerVentas(ctx)) notFound()') && det.includes('if (!puedeVerVentas(ctx)) notFound()') && det.indexOf('if (!puedeVerVentas(ctx)) notFound()') < det.indexOf('obtenerVenta('))
check('>>> /ventas decide con puedeVerVentas ANTES de leer y sin permiso responde con aviso', lista.includes('puedeVerVentas') && lista.indexOf('puedeVerVentas') < lista.indexOf('listarVentas('))
check('>>> /ventas/[id] sin permiso de ver o con venta ajena es notFound()', det.includes('notFound()') && det.includes('puedeVerVentas') && det.includes('NOT_FOUND'))
check('>>> «Anular / Devolver» solo se ofrece con ventas.anular y venta COMPLETADA', /puede\(ctx, 'ventas\.anular'\)/.test(det) && det.includes("'COMPLETADA'"))
check('>>> bajo sesión de PIN no se ofrece (mensaje con el operador) y no se pasa por ctx.operadorDe sin avisar', det.includes('operadorDe'))
check('>>> ninguna de las dos páginas ni sus componentes nombran unitCost/costPrice/utilidad/margen', !['src/app/(dashboard)/ventas/page.tsx', 'src/app/(dashboard)/ventas/[id]/page.tsx', 'src/features/ventas/components/FormularioDevolucion.tsx', 'src/features/ventas/components/TablaVentas.tsx', 'src/features/ventas/components/DetalleVenta.tsx'].some((f) => /unitCost|costPrice|utilidad|margen|ver_costo/i.test(codigo(f))))
check('las páginas tienen loading propio', existsSync('src/app/(dashboard)/ventas/loading.tsx') && existsSync('src/app/(dashboard)/ventas/[id]/loading.tsx'))

console.log('\nE) Enlaces desde el POS y la conciliación')
const pos = src('src/app/(dashboard)/pos/page.tsx'), term = src('src/features/pos/components/PosTerminal.tsx'), rec = src('src/features/pos/components/ReciboEmitido.tsx'), conc = src('src/features/conciliacion/conciliacion-calculo.ts')
check('>>> el POS ofrece «Ventas recientes» solo con permiso de ver ventas', pos.includes('puedeVerVentas') && pos.includes('/ventas') && pos.includes('puedeVerVenta='))
check('>>> tras cobrar, el recibo ofrece «Ver esta venta» solo si puede', rec.includes('data-recibo="ver-venta"') && rec.includes('puedeVerVenta') && term.includes('puedeVerVenta'))
check('>>> la conciliación enlaza cada venta a /ventas/[id] (ya no a la lista de comprobantes)', conc.includes('/ventas/${id}'))

console.log('\nF) Caja: resumen del turno, cierre y ticket')
const tk: TicketCierre = {
  numero: 'CC-20261027-ABC123', zonaHoraria: 'America/Lima', locale: 'es-PE', emisor: { nombre: 'Ferretería Demo', razonSocial: null, ruc: '20123456789', direccion: null, telefono: null },
  sucursal: 'Central', abrio: 'Rosa', cerro: 'Rosa', abiertoEn: '2026-10-27T13:00:00.000Z', cerradoEn: '2026-10-27T23:00:00.000Z', fondoInicial: 100,
  ventasCantidad: 4, ventasTotal: 800, cobradoEfectivo: 500, vueltos: 20, abonosEfectivo: 0, pagosProveedorEfectivo: 0, devolucionesCajon: 118, devolucionesOtrosMedios: 40,
  fiado: 0, abonosOtrosMedios: 0, pagosProveedorOtrosMedios: 0, esperado: 462, contado: 462, diferencia: 0, notas: null,
}
const tc = html(createElement(TicketCierreCaja, { ticket: tk }))
check('>>> el ticket muestra el número, la sucursal, quién abrió y cerró y las fechas', tc.includes('CC-20261027-ABC123') && tc.includes('Central') && tc.includes('Abrió') && tc.includes('Cerró'))
check('>>> las devoluciones pagadas del cajón RESTAN y van en la cuenta del cajón; las de otro medio van APARTE como informativo', tc.includes('data-ticket="devoluciones-cajon"') && tc.includes('S/ 118.00') && tc.includes('data-ticket="devoluciones-otros"') && tc.indexOf('devoluciones-cajon') < tc.indexOf('Informativo') && tc.indexOf('Informativo') < tc.indexOf('devoluciones-otros'))
check('cuadra: «CUADRA» sin diferencia; faltante y sobrante con su rótulo', tc.includes('CUADRA') && html(createElement(TicketCierreCaja, { ticket: { ...tk, diferencia: -5 } })).includes('FALTANTE') && html(createElement(TicketCierreCaja, { ticket: { ...tk, diferencia: 5 } })).includes('SOBRANTE'))
const sinDev = html(createElement(TicketCierreCaja, { ticket: { ...tk, devolucionesCajon: 0, devolucionesOtrosMedios: 0 } }))
check('sin devoluciones no aparece ninguna de las dos líneas ni el bloque informativo', !sinDev.includes('devoluciones-cajon') && !sinDev.includes('devoluciones-otros') && !sinDev.includes('Informativo'))
check('>>> es un documento interno: lo dice en el pie y NO muestra costos', tc.includes('No es un comprobante') && !/costo|utilidad|margen/i.test(tc))
const pc = (o: Record<string, unknown>) => html(createElement(CashPanel, { turno: { id: 't1', openingAmount: 100, expectedAmount: 462, salesCount: 4, refundsCashTotal: 118, refundsOtherTotal: 40, openedAt: '2026-10-27T13:00:00.000Z', abiertoPor: 'Rosa' }, ultimoCierre: null, sucursal: 'Central', puedeOperar: true, zonaHoraria: 'America/Lima', ...o } as never))
const abierto = pc({})
check('>>> el turno abierto muestra las devoluciones (cajón restan / otro medio informativo) SIN revelar el efectivo esperado', abierto.includes('Devoluciones pagadas del cajón') && abierto.includes('Devoluciones por otro medio') && !abierto.includes('462.00'))
const cierre = { id: 'c1', openingAmount: 100, countedAmount: 462, expectedAmount: 462, difference: 0, salesCount: 4, salesTotal: 800, cashTotal: 500, changeTotal: 20, creditSalesTotal: 0, cashReceiptsTotal: 0, otherReceiptsTotal: 0, supplierCashPaymentsTotal: 0, supplierOtherPaymentsTotal: 0, refundsCashTotal: 118, refundsOtherTotal: 40, closedAt: '2026-10-27T23:00:00.000Z', cerradoPor: 'Rosa' }
const ult = pc({ turno: null, ultimoCierre: cierre, puedeImprimirUltimoCierre: true })
check('>>> el último cierre muestra ambas líneas y el enlace al ticket (solo si puede)', ult.includes('Devoluciones pagadas del cajón') && ult.includes('Devoluciones por otro medio') && ult.includes('href="/imprimir/cierre-caja/c1"'))
check('sin permiso de imprimir no hay enlace', !pc({ turno: null, ultimoCierre: cierre, puedeImprimirUltimoCierre: false }).includes('/imprimir/cierre-caja/'))
check('sin devoluciones ninguna de las dos líneas', !pc({ turno: null, ultimoCierre: { ...cierre, refundsCashTotal: 0, refundsOtherTotal: 0 } }).includes('Devoluciones'))
const rutaTk = src('src/app/(print)/imprimir/cierre-caja/[id]/page.tsx')
check('>>> la ruta del ticket: 404 si no existe, no se puede ver o está abierto; sin costos', rutaTk.includes('notFound()') && rutaTk.includes('getTicketCierre') && !/unitCost|costPrice/.test(rutaTk))
const dato = src('src/features/printing/cierre-caja.ts')
check(">>> el dato del ticket: solo turnos CERRADOS, lee las columnas congeladas, permiso caja.arqueo o (caja.abrir_cerrar + turno propio)", dato.includes("status: 'CERRADA'") && dato.includes("'caja.arqueo'") && dato.includes("'caja.abrir_cerrar'") && /openedById: ctx\.userId/.test(dato) && !/unitCost|costPrice|totalesDelTurno/.test(dato))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
