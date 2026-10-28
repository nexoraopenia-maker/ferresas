import { existsSync, readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { FormularioDevolucionParcial } from '../src/features/ventas/components/FormularioDevolucionParcial'
import { DetalleVenta } from '../src/features/ventas/components/DetalleVenta'
import { TablaVentas } from '../src/features/ventas/components/TablaVentas'
import { TablaPorPeriodo } from '../src/features/reportes/components/TablasVentas'
import { cantidadValida, calcularDevolucionParcial as calcularReal, equivalenciaPresentacion, pendienteComoTexto, sePuedeEnviar, type EstadoEnvio, type LineaPantalla } from '../src/features/ventas/devolucion-parcial'
import { parametrosVentasListaSchema } from '../src/features/ventas/schemas'
import type { DiagnosticoParcial } from '../src/features/devoluciones/parcial-service'
import type { DetalleVenta as Detalle, PaginaVentas } from '../src/features/ventas/service'
import type { VentasPorPeriodo } from '../src/features/reportes/ventas-calculo'

/**
 * F6.2c · Las pantallas de la devolución parcial, renderizadas AISLADAS, el cálculo en vivo (puro) y las páginas leídas como código.
 * Lo que más importa: lo que se ve en pantalla es lo que calcula el servidor; «Anular» desaparece tras una parcial; el aviso de 30 días no bloquea;
 * ni un costo en ninguna de estas pantallas.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const src = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const codigo = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const M = 10_000
// Una excepción en el cálculo cuenta como fallo de la prueba (✗), no como un aborto sin veredicto.
const calcularDevolucionParcial = (...a: Parameters<typeof calcularReal>): ReturnType<typeof calcularReal> => { try { return calcularReal(...a) } catch (e) { return { estado: 'ERROR', mensaje: `EXCEPCIÓN: ${(e as Error).message}` } } }

const l1: LineaPantalla = { saleItemId: 'li1', nombre: 'Cemento Sol', controlaStock: true, calculo: { totalCent: 11_800, vendidaM: 3 * M, tasa: 0.18, yaDevueltaM: 0, yaDevueltoImporteCent: 0 } }
const l2: LineaPantalla = { saleItemId: 'li2', nombre: 'Servicio de corte', controlaStock: false, calculo: { totalCent: 5_000, vendidaM: 1 * M, tasa: 0, yaDevueltaM: 0, yaDevueltoImporteCent: 0 } }
const contado = [{ method: 'EFECTIVO', cent: 10_000 }, { method: 'YAPE', cent: 6_800 }]
const diag = (o: Partial<DiagnosticoParcial> = {}): DiagnosticoParcial => ({
  puede: true, bloqueo: null, topeDevolvible: 168, saldoDeuda: 0, contadoSinDevolver: [{ method: 'EFECTIVO', amount: 100 }, { method: 'YAPE', amount: 68 }], cuenta: null, contadoPorMedioCent: contado,
  hayTurnoAbierto: true, tieneDevoluciones: false, comprobante: { numero: 'B001-00000012', estado: 'ACEPTADO', esEnsayo: false }, antiguedad: { dias: 3, avisar: false },
  lineas: [
    { saleItemId: 'li1', nombre: 'Cemento Sol', sku: 'CEM-1', vendida: 3, devuelta: 0, pendiente: 3, importePendiente: 118, controlaStock: true, presentacion: { nombre: 'Caja x 12', factor: 12 }, calculo: l1.calculo },
    { saleItemId: 'li2', nombre: 'Servicio de corte', sku: 'SRV', vendida: 1, devuelta: 0, pendiente: 1, importePendiente: 50, controlaStock: false, presentacion: null, calculo: l2.calculo },
  ], ...o,
})
const form = (d: DiagnosticoParcial, ini?: Record<string, { cantidad: string; destino?: 'STOCK' | 'MERMA' }>, puedeOperar = true) =>
  html(createElement(FormularioDevolucionParcial, { saleId: 'venta0001abc', numero: 'B001-00000007', diagnostico: d, puedeOperar, pedidosIniciales: ini }))

console.log('\nA) El cálculo en vivo (el mismo que el servidor)')
const c0 = calcularDevolucionParcial([l1, l2], [{ saleItemId: 'li1', cantidad: '', destino: 'STOCK' }], null, contado)
check('sin cantidades escritas no hay nada que calcular', c0.estado === 'VACIO')
const c1 = calcularDevolucionParcial([l1, l2], [{ saleItemId: 'li1', cantidad: '1', destino: 'STOCK' }], null, contado)
check('>>> 1 de 3 unidades de S/ 118.00: se devuelve 39.33, todo en dinero (sin deuda), sugerido en proporción a lo pagado y sin completar la venta', c1.estado === 'OK' && c1.totalCent === 3_933 && c1.reparto.deudaCent === 0 && c1.reparto.dineroCent === 3_933 && !c1.completaVenta && c1.sugerencia.reduce((a, x) => a + x.cent, 0) === 3_933)
check('>>> devolver TODO (3 + el servicio) completa la venta: 118.00 + 50.00 = 168.00', (() => { const c = calcularDevolucionParcial([l1, l2], [{ saleItemId: 'li1', cantidad: '3', destino: 'STOCK' }, { saleItemId: 'li2', cantidad: '1', destino: 'STOCK' }], null, contado); return c.estado === 'OK' && c.totalCent === 16_800 && c.completaVenta })())
check('>>> con dañado: cuenta una merma', (() => { const c = calcularDevolucionParcial([l1, l2], [{ saleItemId: 'li1', cantidad: '1', destino: 'MERMA' }], null, contado); return c.estado === 'OK' && c.mermas === 1 && c.lineas[0]!.destino === 'MERMA' })())
check('>>> el servicio nunca va a merma aunque se pida: queda SIN_STOCK o se rechaza', (() => { const c = calcularDevolucionParcial([l1, l2], [{ saleItemId: 'li2', cantidad: '1', destino: 'MERMA' }], null, contado); return c.estado === 'ERROR' && /no controla stock/.test(c.mensaje) })())
check('>>> más de lo que queda: error claro con lo que queda', (() => { const c = calcularDevolucionParcial([l1, l2], [{ saleItemId: 'li1', cantidad: '4', destino: 'STOCK' }], null, contado); return c.estado === 'ERROR' && /solo quedan 3 por devolver/.test(c.mensaje) })())
check('cantidad con coma decimal, y con 5 decimales se rechaza', calcularDevolucionParcial([l1], [{ saleItemId: 'li1', cantidad: '0,5', destino: 'STOCK' }], null, contado).estado === 'OK' && calcularDevolucionParcial([l1], [{ saleItemId: 'li1', cantidad: '0.00001', destino: 'STOCK' }], null, contado).estado === 'ERROR')
const fiado = { status: 'ABIERTA' as const, amountCent: 20_000, paidCent: 5_000 }
check('>>> fiado con abonos: lo devuelto baja primero el saldo (150.00) y si cabe no hay dinero', (() => { const c = calcularDevolucionParcial([{ ...l1, calculo: { ...l1.calculo, totalCent: 30_000 } }], [{ saleItemId: 'li1', cantidad: '1', destino: 'STOCK' }], fiado, []); return c.estado === 'OK' && c.totalCent === 10_000 && c.reparto.deudaCent === 10_000 && c.reparto.dineroCent === 0 && c.reparto.accion === 'REDUCIR' })())
check('>>> fiado con abonos que excede el saldo: BLOQUEADO con el tope exacto (150.00)', (() => { const c = calcularDevolucionParcial([{ ...l1, calculo: { ...l1.calculo, totalCent: 30_000 } }], [{ saleItemId: 'li1', cantidad: '3', destino: 'STOCK' }], fiado, []); return c.estado === 'BLOQUEADO' && c.code === 'CREDIT_HAS_PAYMENTS' && c.topeCent === 15_000 && /150\.00/.test(c.mensaje) })())
check('cantidadValida acepta vacío, enteros y decimales; rechaza texto y negativos', cantidadValida('') && cantidadValida('2') && cantidadValida('0,25') && !cantidadValida('abc') && !cantidadValida('-1'))
check('«devolver lo que falta» escribe el pendiente de cada línea', pendienteComoTexto({ calculo: { vendidaM: 3 * M, yaDevueltaM: 1 * M } }) === '2' && pendienteComoTexto({ calculo: { vendidaM: 25_000, yaDevueltaM: 0 } }) === '2.5')
check('>>> equivalencia en cajas: 3 sueltas de una caja ×12 = 0.25 × Caja x 12; sin presentación, nada', equivalenciaPresentacion(3, { nombre: 'Caja x 12', factor: 12 }) === '0.25 × Caja x 12' && equivalenciaPresentacion(3, null) === null && equivalenciaPresentacion(0, { nombre: 'x', factor: 12 }) === null)

const ok: EstadoEnvio = { puedeOperar: true, calculoOk: true, sinCaja: false, faltaMotivoSinSalida: false, motivo: 'Una bolsa rota', confirmo: true, pendiente: false }
check('>>> se puede enviar cuando TODO está en orden', sePuedeEnviar(ok))
for (const [n, cambio] of [['cuenta en solo lectura', { puedeOperar: false }], ['cálculo con error o bloqueado', { calculoOk: false }], ['efectivo sin turno abierto', { sinCaja: true }], ['«sin salida» sin motivo', { faltaMotivoSinSalida: true }], ['motivo de 2 letras', { motivo: 'ab' }], ['motivo en blanco', { motivo: '   ' }], ['sin marcar la confirmación', { confirmo: false }], ['envío en curso', { pendiente: true }]] as const) {
  check(`>>> NO se puede enviar: ${n}`, !sePuedeEnviar({ ...ok, ...cambio }))
}

console.log('\nB) El formulario de devolución parcial')
const f0 = form(diag())
check('>>> muestra cada producto con lo vendido, lo devuelto y lo que queda, y la casilla de cantidad en unidades', f0.includes('data-form="devolucion-parcial"') && f0.includes('Cemento Sol') && f0.includes('Vendido 3 · devuelto 0 · queda 3') && f0.includes('caja de 12') && f0.includes('name="cant-0"'))
check('>>> permite elegir el destino: «Reingresa a stock vendible» o «Dañado (pasa a merma)»; el servicio (sin stock) no tiene destino', f0.includes('Reingresa a stock vendible') && f0.includes('Dañado (pasa a merma)') && f0.includes('Servicio sin control de stock'))
check('>>> el botón de confirmar nace DESHABILITADO (sin cantidades, sin motivo, sin confirmar) y hay «Devolver lo que falta»', /<button[^>]*data-boton="confirmar-devolucion-parcial"[^>]*disabled/.test(f0) && f0.includes('data-boton="devolver-lo-que-falta"'))
check('sin cantidades no hay resumen ni reembolso que decidir', !f0.includes('data-devolucion="resumen"') && !f0.includes('data-reembolso-linea'))
const f1 = form(diag(), { li1: { cantidad: '1' } })
check('>>> con 1 unidad: el resumen dice 39.33 a reembolsar, propone el dinero según lo pagado (efectivo y Yape) y avisa de la nota de crédito parcial 07', f1.includes('data-resumen="total"') && f1.includes('S/ 39.33') && f1.includes('data-resumen="dinero"') && f1.includes('data-reembolso-linea="EFECTIVO"') && f1.includes('data-reembolso-linea="YAPE"') && f1.includes('nota de crédito parcial (07)') && f1.includes('B001-00000012'))
check('>>> con una unidad fraccionada de una presentación, muestra a cuánto equivale (0.25 × Caja x 12 para 3)', form(diag(), { li1: { cantidad: '3' } }).includes('0.25 × Caja x 12'))
const f2 = form(diag(), { li1: { cantidad: '1', destino: 'MERMA' } })
check('>>> dañado: el resumen avisa que pasa a merma y que el stock vendible no sube', f2.includes('a <b>merma</b>') && f2.includes('el stock vendible no sube'))
check('>>> reembolso en CAJA sin turno abierto: alerta clara y botón deshabilitado', (() => { const h = form(diag({ hayTurnoAbierto: false }), { li1: { cantidad: '1' } }); return h.includes('data-devolucion="sin-caja"') && /<button[^>]*data-boton="confirmar-devolucion-parcial"[^>]*disabled/.test(h) })())
check('con turno abierto no sale esa alerta', !f1.includes('data-devolucion="sin-caja"'))
check('>>> al devolver todo se avisa que la venta queda devuelta por completo', form(diag(), { li1: { cantidad: '3' }, li2: { cantidad: '1' } }).includes('devuelta por completo'))
const fFiado = form(diag({ cuenta: { status: 'ABIERTA', amountCent: 20_000, paidCent: 5_000 }, contadoPorMedioCent: [], saldoDeuda: 150, lineas: [{ ...diag().lineas[0]!, calculo: { ...l1.calculo, totalCent: 30_000 } }] }), { li1: { cantidad: '1' } })
check('>>> fiado: se enseña cuánto baja la deuda (100.00) y que no hay dinero que reembolsar (sin selector de reembolso)', fFiado.includes('data-resumen="deuda"') && fFiado.includes('S/ 100.00') && fFiado.includes('data-resumen="dinero"') && !fFiado.includes('data-reembolso-linea'))
check('>>> fiado con abonos que se pasa del saldo: el aviso bloqueante lleva el tope y el botón queda deshabilitado', (() => { const h = form(diag({ cuenta: { status: 'ABIERTA', amountCent: 20_000, paidCent: 5_000 }, contadoPorMedioCent: [], lineas: [{ ...diag().lineas[0]!, calculo: { ...l1.calculo, totalCent: 30_000 } }] }), { li1: { cantidad: '3' } }); return h.includes('data-devolucion="bloqueado"') && h.includes('data-codigo="CREDIT_HAS_PAYMENTS"') && h.includes('150.00') && /<button[^>]*data-boton="confirmar-devolucion-parcial"[^>]*disabled/.test(h) })())
check('>>> línea ya devuelta por completo: lo dice y no ofrece casilla', (() => { const h = form(diag({ lineas: [{ ...diag().lineas[0]!, devuelta: 3, pendiente: 0 }, diag().lineas[1]!] })); return h.includes('Ya se devolvió por completo') && !h.includes('name="cant-0"') && h.includes('name="cant-1"') })())
check('>>> más de 30 días: AVISO informativo (⚠️ operativo) y el formulario sigue disponible', (() => { const h = form(diag({ antiguedad: { dias: 45, avisar: true } })); return h.includes('data-devolucion="aviso-antiguedad"') && h.includes('45 días') && h.includes('data-form="devolucion-parcial"') })())
check('con 30 días o menos no hay aviso', !f0.includes('data-devolucion="aviso-antiguedad"'))
check('>>> si ya tiene parciales lo dice y explica que ya no se anula entera (con nota 07)', form(diag({ tieneDevoluciones: true })).includes('ya no se puede anular entera') && form(diag({ tieneDevoluciones: true })).includes('nota de crédito 07'))
check('cuenta en solo lectura: lo dice', form(diag(), undefined, false).includes('data-devolucion="solo-lectura"'))
const fuente = src('src/features/ventas/components/FormularioDevolucionParcial.tsx')
check('>>> la clave de idempotencia nace UNA vez (useState con crypto.randomUUID) y la acción es `devolverProductos`', /useState\(\(\) => \(typeof crypto/.test(fuente) && fuente.includes('crypto.randomUUID()') && fuente.includes('await devolverProductos('))

console.log('\nC) Estado, progreso e historial en el detalle')
const base: Detalle = {
  id: 'venta0001abc', numero: 'B001-00000007', estado: 'COMPLETADA', cuando: '2026-10-26T20:15:00.000Z', sucursal: { id: 's1', nombre: 'Central' }, cobro: 'Rosa',
  cliente: null, notas: null, subtotal: 100, igv: 18, descuento: 0, total: 118,
  lineas: [{ id: 'li1', devuelta: 1, importeDevuelto: 39.33, pendiente: 2, nombre: 'Cemento Sol', sku: 'CEM-1', unidad: 'UNIDAD', cantidad: 3, presentacion: null, precio: 39.33, descuento: 0, total: 118 }],
  pagos: [{ metodo: 'EFECTIVO', monto: 118, vuelto: 0, referencia: null }], cuenta: null, comprobantes: [], guias: [], zona: 'America/Lima', parcial: true,
  devoluciones: [{
    id: 'r1', numero: 'D001-00000001', tipo: 'DEVOLUCION', cuando: '2026-10-27T15:00:00.000Z', autorizo: 'Dueño', motivo: 'Una bolsa rota', pagadoNeto: 118, deudaCancelada: 0, notaDeCredito: 'BC01-00000002',
    turno: { id: 'turno0001', abiertoEn: '2026-10-27T13:00:00.000Z' }, lineas: 1, esTotal: false,
    detalle: [{ nombre: 'Cemento Sol', cantidad: 1, importe: 39.33, destino: 'MERMA' }], notaLineas: [{ descripcion: 'Cemento Sol', cantidad: 1, total: 39.33 }],
    reembolsos: [{ modo: 'CAJA', medio: 'EFECTIVO', monto: 39.33, referencia: null }],
  }],
}
const dp = html(createElement(DetalleVenta, { venta: base }))
check('>>> una venta COMPLETADA con una devolución parcial se rotula «Devolución parcial» (además de «Completada»)', dp.includes('data-insignia="estado-COMPLETADA"') && dp.includes('data-insignia="devolucion-parcial"') && dp.includes('Devolución parcial'))
check('>>> y su devolución en el historial dice «Devolución parcial D001-…» (no «total»)', /Devolución parcial <span[^>]*data-devolucion-numero[^>]*>D001-00000001/.test(dp) && !/Devolución total <span[^>]*data-devolucion-numero/.test(dp))
check('>>> sin devoluciones NO lleva esa insignia; una DEVUELTA tampoco (ya no es parcial)', !html(createElement(DetalleVenta, { venta: { ...base, parcial: false, devoluciones: [] } })).includes('data-insignia="devolucion-parcial"') && !html(createElement(DetalleVenta, { venta: { ...base, estado: 'DEVUELTA', parcial: false } })).includes('data-insignia="devolucion-parcial"'))
check('>>> la tabla de líneas muestra lo vendido, lo devuelto (1 u. y su importe) y lo que queda (2)', dp.includes('<th scope="col" className="px-3 py-2 text-right">Devuelto</th>') || (dp.includes('Devuelto') && dp.includes('Por devolver')) && dp.includes('data-linea-devuelto') && dp.includes('S/ 39.33') && dp.includes('data-linea-pendiente'))
check('sin devoluciones esas dos columnas no estorban', !html(createElement(DetalleVenta, { venta: { ...base, parcial: false, devoluciones: [], lineas: [{ ...base.lineas[0]!, devuelta: 0, importeDevuelto: 0, pendiente: 3 }] } })).includes('data-linea-devuelto'))
check('>>> el historial dice «Devolución parcial D001-…», autorizó, motivo y turno afectado', dp.includes('Devolución parcial') && dp.includes('D001-00000001') && dp.includes('Dueño') && dp.includes('Una bolsa rota') && dp.includes('data-devolucion-campo="turno"'))
check('>>> lista las líneas devueltas con su destino (dañado, pasó a merma) y su importe', dp.includes('data-linea-devuelta="MERMA"') && dp.includes('dañado, pasó a merma') && dp.includes('S/ 39.33'))
check('>>> enlaza la nota de crédito y muestra SUS líneas propias', dp.includes('BC01-00000002') && dp.includes('data-devolucion-nota-lineas') && dp.includes('Cemento Sol × 1 = S/ 39.33'))
check('el reembolso muestra su modo; el título de la sección es «Devoluciones de esta venta»', dp.includes('data-reembolso="CAJA"') && dp.includes('Devoluciones de esta venta'))
const fiadoD = html(createElement(DetalleVenta, { venta: { ...base, devoluciones: [{ ...base.devoluciones[0]!, deudaCancelada: 100, reembolsos: [] }] } }))
check('con deuda reducida y sin dinero: «Deuda del cliente reducida» y «no hubo reembolso»', fiadoD.includes('Deuda del cliente reducida') && fiadoD.includes('Todo se descontó de la deuda'))
check('una devolución total muestra «Devolución total» (la de F6.1) y «cancelada»', (() => { const h = html(createElement(DetalleVenta, { venta: { ...base, estado: 'DEVUELTA', parcial: false, devoluciones: [{ ...base.devoluciones[0]!, esTotal: true, deudaCancelada: 50 }] } })); return /Devolución total <span[^>]*data-devolucion-numero/.test(h) && h.includes('Deuda del cliente cancelada') })())
check('>>> NINGÚN costo, utilidad ni margen en el detalle con devoluciones (ni siquiera de lo que fue a merma)', !/costo|utilidad|margen|ganancia/i.test(dp))

console.log('\nD) Listado y reporte')
const fila = (o: Partial<PaginaVentas['filas'][number]> = {}): PaginaVentas['filas'][number] => ({ id: 'venta0001abc', numero: 'B001-00000007', cuando: '2026-10-26T20:15:00.000Z', sucursal: 'Central', cliente: null, total: 118, estado: 'COMPLETADA', cobro: 'Rosa', comprobante: null, conDevolucionParcial: false, ...o })
const pg = (filas: PaginaVentas['filas']): PaginaVentas => ({ filas, siguiente: null, textoPeriodo: null, zona: 'America/Lima', sucursales: [] })
const tabla = html(createElement(TablaVentas, { pagina: pg([fila(), fila({ id: 'venta0002abc', conDevolucionParcial: true }), fila({ id: 'venta0003abc', estado: 'DEVUELTA' })]), params: parametrosVentasListaSchema.parse({}) }))
check('>>> el listado distingue COMPLETADA, COMPLETADA con «Devolución parcial» y DEVUELTA', (tabla.match(/data-estado="PARCIAL"/g) ?? []).length === 1 && (tabla.match(/data-estado="COMPLETADA"/g) ?? []).length === 2 && tabla.includes('data-estado="DEVUELTA"'))
const rep = (devuelto: number): VentasPorPeriodo => ({ granularidad: 'dia', filas: [{ clave: 'a', etiqueta: '21/10', ventas: 1, total: 100, igv: 15.25, descuentos: 0, ticketPromedio: 100, devuelto }], totales: { ventas: 1, total: 100, igv: 15.25, descuentos: 0, ticketPromedio: 100, devuelto } })
check('>>> /reportes/ventas muestra la línea «Devoluciones parciales descontadas» con el importe cuando hay', html(createElement(TablaPorPeriodo, { r: rep(60) })).includes('data-reporte="devoluciones-parciales"') && html(createElement(TablaPorPeriodo, { r: rep(60) })).includes('S/ 60.00'))
check('y no sale cuando no hubo devoluciones', !html(createElement(TablaPorPeriodo, { r: rep(0) })).includes('data-reporte="devoluciones-parciales"'))

console.log('\nE) Las páginas (código)')
const det = src('src/app/(dashboard)/ventas/[id]/page.tsx'), dc = codigo('src/app/(dashboard)/ventas/[id]/page.tsx')
check('>>> el formulario parcial solo se arma con `ventas.anular`; sin ese permiso queda el mensaje (y el del PIN de operador)', /puede\(ctx, 'ventas\.anular'\)/.test(det) && det.includes('FormularioDevolucionParcial') && det.includes('operadorDe') && det.indexOf("puede(ctx, 'ventas.anular')") < det.indexOf('diagnosticarDevolucionParcial('))
check('>>> «Anular / devolver todo» solo si la venta NO tiene parciales (`venta.parcial ? null : …`)', /const d = venta\.parcial \? null : await diagnosticarDevolucion\(/.test(det) && /\{d && \(/.test(det))
check('>>> si no se puede devolver, la página dice por qué (bloqueo del diagnóstico) en lugar de un formulario', det.includes('dp.bloqueo') && det.includes('No se pueden devolver productos de esta venta todavía'))
check('>>> ni la página, ni el formulario, ni el cálculo ni el detalle nombran costos/utilidad/margen en código', ['src/app/(dashboard)/ventas/[id]/page.tsx', 'src/app/(dashboard)/ventas/page.tsx', 'src/features/ventas/components/FormularioDevolucionParcial.tsx', 'src/features/ventas/components/DetalleVenta.tsx', 'src/features/ventas/components/TablaVentas.tsx', 'src/features/ventas/devolucion-parcial.ts', 'src/features/ventas/service.ts'].every((f) => !/unitCost|costPrice|utilidad|margen|ver_costo/i.test(codigo(f))))
void dc
check('el diagnóstico que viaja al navegador no lleva costos (lo comprueba su servicio de lectura)', !/unitCost|costPrice/.test(codigo('src/features/devoluciones/parcial-service.ts').replace(/unitCost: i\.unitCost/g, '').replace(/unitCostApplied: i\.unitCost/g, '').replace(/unitCost: true,/g, '')))
check('la lista de comprobantes ya no ofrece una nota total sobre un comprobante con notas parciales vivas', codigo('src/app/(dashboard)/comprobantes/page.tsx').includes('...CODIGOS_NOTA_CREDITO_PARCIAL'))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
