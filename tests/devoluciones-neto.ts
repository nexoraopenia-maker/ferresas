import './guard'
import { pagosTrasDevoluciones, type DevolucionesDeVenta } from '../src/features/devoluciones/neto'
import { margenPorProducto, type LineaVentaCosto } from '../src/features/reportes/rentabilidad-calculo'
import { ventasPorMedio, ventasPorPeriodo, type VentaFila } from '../src/features/reportes/ventas-calculo'
import { hallazgosDeNotasParciales, hallazgosInformativos, puenteVentas, type VentaConc } from '../src/features/conciliacion/conciliacion-calculo'

/**
 * F6.2b · Las funciones puras que restan lo devuelto: pagos netos, margen por producto (stock vs merma), ventas por periodo, el puente de
 * conciliación y las comprobaciones de notas parciales. Sin base.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const cent = (n: number) => Math.round(n * 100)
const dev = (o: Partial<DevolucionesDeVenta>): DevolucionesDeVenta => ({ totalCent: 0, baseCent: 0, igvCent: 0, descuentoCent: 0, deudaCent: 0, dineroCent: 0, operaciones: 1, lineas: new Map(), ...o })

console.log('\nA) Los pagos de una venta tras sus devoluciones')
const neto = (ps: { metodo: string; monto: number; vuelto: number }[]) => ps.reduce((a, p) => a + cent(p.monto) - cent(p.vuelto), 0)
const mixta = [{ metodo: 'EFECTIVO', monto: 120, vuelto: 20 }, { metodo: 'YAPE', monto: 100, vuelto: 0 }, { metodo: 'CREDITO', monto: 200, vuelto: 0 }]   // 100 + 100 + 200 = 400
check('sin devoluciones los pagos quedan igual (copias, no la misma lista)', JSON.stringify(pagosTrasDevoluciones(mixta, undefined)) === JSON.stringify(mixta) && pagosTrasDevoluciones(mixta, undefined) !== mixta)
const a = pagosTrasDevoluciones(mixta, dev({ totalCent: 25_000, deudaCent: 15_000, dineroCent: 10_000 }))
check('>>> devolver 250 = deuda 150 + dinero 100: el fiado baja 150 (a 50) y el dinero se reparte en proporción entre efectivo y Yape (50 y 50)', neto(a) === 40_000 - 25_000 && cent(a[2]!.monto) === 5_000 && neto([a[0]!]) === 5_000 && neto([a[1]!]) === 5_000)
check('>>> el vuelto se conserva: lo reducido sale del neto, no del vuelto', a[0]!.vuelto === 20 && cent(a[0]!.monto) === cent(70))
check('>>> la suma neta de los medios = total de la venta − lo devuelto, con CUALQUIER reparto (500 casos al azar)', (() => { for (let i = 1; i <= 500; i++) { const dd = (i * 37) % 15_001, mm = (i * 91) % 20_001; const r = pagosTrasDevoluciones(mixta, dev({ totalCent: dd + mm, deudaCent: dd, dineroCent: mm })); if (neto(r) !== 40_000 - dd - mm) return false } return true })())
check('nunca deja un pago negativo aunque lo devuelto sea todo', pagosTrasDevoluciones(mixta, dev({ totalCent: 40_000, deudaCent: 20_000, dineroCent: 20_000 })).every((p) => cent(p.monto) - cent(p.vuelto) >= 0) && neto(pagosTrasDevoluciones(mixta, dev({ totalCent: 40_000, deudaCent: 20_000, dineroCent: 20_000 }))) === 0)
check('varias filas del mismo medio se reducen en orden y conservan una fila por pago', (() => { const r = pagosTrasDevoluciones([{ metodo: 'EFECTIVO', monto: 30, vuelto: 0 }, { metodo: 'EFECTIVO', monto: 70, vuelto: 0 }], dev({ totalCent: 5_000, dineroCent: 5_000 })); return r.length === 2 && cent(r[0]!.monto) === 0 && cent(r[1]!.monto) === 5_000 })())

console.log('\nB) Ventas por periodo, medio y vendedor con filas netas')
const v = (id: string, total: number, igv: number, devuelto: number, pagos: VentaFila['pagos']): VentaFila => ({ id, numero: id, completedAt: new Date('2026-10-21T15:00:00Z'), total, igv, descuentos: 0, devuelto, vendedorId: 'u', cobroId: 'u', pagos })
const filas = [v('a', 300, 45.76, 100, [{ metodo: 'EFECTIVO', monto: 300, vuelto: 0 }]), v('b', 50, 7.63, 0, [{ metodo: 'YAPE', monto: 50, vuelto: 0 }])]
const vp = ventasPorPeriodo(filas, 'dia', 'America/Lima', [{ clave: '2026-10-21', etiqueta: '21/10' }])
check('>>> ventas por periodo: el total es el de las filas netas, cuenta cada venta una vez y suma lo devuelto aparte', vp.totales.total === 350 && vp.totales.ventas === 2 && vp.totales.devuelto === 100 && vp.filas[0]!.devuelto === 100)
check('>>> ventas por medio: lo pagado neto = total neto, sin ventas descuadradas', ventasPorMedio(filas).totalMedios === 350 && ventasPorMedio(filas).descuadradas.ventas === 0)
check('una fila sin `devuelto` (datos de antes) cuenta 0 devuelto', ventasPorPeriodo([{ ...filas[1]!, devuelto: undefined }], 'dia', 'America/Lima', [{ clave: '2026-10-21', etiqueta: '21' }]).totales.devuelto === 0)

console.log('\nC) Margen por producto: lo devuelto a stock vs lo dañado')
const linea = (o: Partial<LineaVentaCosto>): LineaVentaCosto => ({ productId: 'p', nombre: 'P', sku: 'P', unidad: 'UNIDAD', cantidad: 4, costoUnitario: 60, totalConIgv: 400, tasaIgv: 0.18, ...o })
const base1 = 8_474   // base de 1 unidad de 4 vendidas a 400.00 (importe 100.00)
const sinDev = margenPorProducto([linea({})]).totales
const aStock = margenPorProducto([linea({ devuelta: { cantidadM: 10_000, cantidadStockM: 10_000, baseCent: base1 } })]).totales
const danada = margenPorProducto([linea({ devuelta: { cantidadM: 10_000, cantidadStockM: 0, baseCent: base1 } })]).totales
check('sin devolución: venta 338.98, costo 240.00, utilidad 98.98', sinDev.ventaSinIgv === 338.98 && sinDev.costo === 240 && sinDev.utilidad === 98.98)
check('>>> devuelta A STOCK: resta el ingreso (254.24) y el costo (180.00) → utilidad 74.24', aStock.ventaSinIgv === 254.24 && aStock.costo === 180 && aStock.utilidad === 74.24)
check('>>> devuelta DAÑADA: resta el mismo ingreso (254.24) pero CONSERVA el costo (240.00) → utilidad 14.24', danada.ventaSinIgv === 254.24 && danada.costo === 240 && danada.utilidad === 14.24)
check('>>> las unidades vendidas netas bajan en ambos casos (3), y la cobertura no cambia', margenPorProducto([linea({ devuelta: { cantidadM: 10_000, cantidadStockM: 0, baseCent: base1 } })]).filas[0]!.unidades === 3 && danada.cobertura === 100)
check('una línea sin costo no suma costo aunque se devuelva, y su venta neta va a «sin costo»', (() => { const t = margenPorProducto([linea({ costoUnitario: 0, devuelta: { cantidadM: 10_000, cantidadStockM: 10_000, baseCent: base1 } })]).totales; return t.costo === 0 && t.ventaSinCosto === 254.24 && t.ventaConCosto === 0 })())
check('devolver todas las unidades de una línea sana: venta 0, costo 0 (no hay pérdida)', (() => { const t = margenPorProducto([linea({ devuelta: { cantidadM: 40_000, cantidadStockM: 40_000, baseCent: 33_898 } })]).totales; return t.ventaSinIgv === 0 && t.costo === 0 })())
check('devolver todas las unidades de una línea dañada: venta 0 y toda la pérdida del costo (−240.00)', (() => { const t = margenPorProducto([linea({ devuelta: { cantidadM: 40_000, cantidadStockM: 0, baseCent: 33_898 } })]).totales; return t.ventaSinIgv === 0 && t.costo === 240 && t.utilidad === -240 })())

console.log('\nD) El puente y sus desfases')
const doc = (estado: 'ACEPTADO' | 'PENDIENTE', total: number) => ({ id: 'd', tipo: 'BOLETA' as const, numero: 'B001-1', estado, isTrial: false, base: 0, igv: 0, total, receptorTipo: 'SIN_DOCUMENTO', receptorNumero: null, emitidoMs: 0 })
const vc = (id: string, total: number, devuelto: number, d: ReturnType<typeof doc> | null, pide = 'BOLETA'): VentaConc => ({ id, numero: id, pide, total, base: 0, igv: 0, devuelto, completadaMs: 0, doc: d })
const ventas = [vc('a', 400, 100, doc('ACEPTADO', 400)), vc('b', 200, 0, doc('ACEPTADO', 200)), vc('c', 100, 40, null, 'NOTA_VENTA'), vc('d', 150, 50, doc('PENDIENTE', 150))]
const pu = puenteVentas(ventas, { documentos: 0, total: 0 }, { documentos: 0, total: 0 }, { deVentasDelPeriodo: 60, deOtrasVentas: 25 })
check('>>> el puente cuenta cada venta por su NETO: 300 + 200 + 60 + 100 = 660 y cuadra', pu.ventasCompletadas.total === 660 && pu.diferencia === 0 && pu.clasificacion.valido.total === 500 && pu.notasDeVenta.total === 60 && pu.clasificacion.pendiente.total === 100)
check('>>> informa las devoluciones parciales: 3 ventas, 190.00 (y 100.00 en comprobantes válidos)', pu.devolucionesParciales.documentos === 3 && pu.devolucionesParciales.total === 190 && pu.devolucionesParciales.enValidos === 100)
check('>>> DESFASE 1 = devuelto en válidos − notas válidas emitidas en el periodo = 100 − 60 = 40; DESFASE 2 = 25', pu.desfaseParciales.notaFueraDelPeriodo === 40 && pu.desfaseParciales.notasDeOtrasVentas === 25)
const info = hallazgosInformativos(pu, 'REAL', 700, { documentos: 0, total: 0 })
check('>>> la diferencia de fechas compara el comprobante emitido (BRUTO) con el válido bruto: 700 − (500 + 100) = 100', info.find((h) => h.codigo === 'DIFERENCIA_DE_FECHAS')?.items[0]?.importe === 100)
check('>>> los dos desfases salen como INFORMACIÓN (nunca alarma) con sus importes (+40 y −25)', (() => { const h = info.find((x) => x.codigo === 'DEVOLUCIONES_PARCIALES_ENTRE_PERIODOS'); return !!h && h.nivel === 'INFO' && h.items[0]!.importe === 40 && h.items[1]!.importe === -25 })())
check('sin devoluciones parciales no hay hallazgo de desfases', !hallazgosInformativos(puenteVentas([vc('x', 100, 0, doc('ACEPTADO', 100))], { documentos: 0, total: 0 }, { documentos: 0, total: 0 }), 'REAL', 100).some((h) => h.codigo === 'DEVOLUCIONES_PARCIALES_ENTRE_PERIODOS'))
const np = hallazgosDeNotasParciales([{ id: 'a', numero: 'V-1', devuelto: 100, notas: 100, comprobante: 'B001-1' }, { id: 'b', numero: 'V-2', devuelto: 100, notas: 60, comprobante: 'B001-2' }, { id: 'c', numero: 'V-3', devuelto: 0, notas: 10, comprobante: 'B001-3' }], 'REAL')
check('>>> notas parciales: la que suma lo devuelto no es hallazgo; faltante (−40) y sobrante sin respaldo (+10) sí, como ERROR', np.length === 1 && np[0]!.nivel === 'ERROR' && np[0]!.cantidad === 2 && np[0]!.items[0]!.importe === -40 && np[0]!.items[1]!.importe === 10)
check('en modo ensayo ese hallazgo nunca pasa de INFO', hallazgosDeNotasParciales([{ id: 'b', numero: 'V-2', devuelto: 100, notas: 60, comprobante: 'B001-2' }], 'ENSAYO')[0]!.nivel === 'INFO')

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
