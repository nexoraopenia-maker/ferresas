import { generarCsv } from '../src/lib/csv-export'
import { gruposDelPeriodo, resolverPeriodo } from '../src/features/reportes/periodo'
import {
  cobrosPorMedio, ETIQUETA_METODO, etiquetaMetodo, netoDePagoCentimos, ventasPorMedio, ventasPorPeriodo, ventasPorVendedor, type PagoFila, type VentaFila,
} from '../src/features/reportes/ventas-calculo'
import { csvCobros, csvVentasPorMedio, csvVentasPorPeriodo, csvVentasPorVendedor } from '../src/features/reportes/ventas-csv'
import { enlaceCsvVentas, enlaceVentas } from '../src/features/reportes/urls'
import { parametrosVentasSchema } from '../src/features/reportes/schemas'

/**
 * F5.2 · El cálculo de los reportes de ventas. PURO: sin base. Lo que más importa: todo se suma en céntimos (0.1 + 0.2 = 0.30), los
 * medios de una venta suman su total (el vuelto se descuenta), lo fiado no es dinero cobrado, y los reportes se CONCILIAN entre sí.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const LIMA = 'America/Lima'
const c = (n: number) => Math.round(n * 100)

let seq = 0
const venta = (o: Partial<VentaFila> & { pagos?: PagoFila[] } = {}): VentaFila => {
  const total = o.total ?? 100
  return { id: `v${++seq}`, numero: `V-${seq}`, completedAt: new Date('2026-10-26T15:00:00Z'), total, igv: 0, descuentos: 0, vendedorId: 'u1', cobroId: 'u1', pagos: [{ metodo: 'EFECTIVO', monto: total, vuelto: 0 }], ...o }
}
const periodo = (desde: string, hasta: string) => resolverPeriodo({ preset: 'RANGO', desde, hasta }, new Date('2026-12-01T12:00:00Z'), LIMA)

console.log('\nA) Céntimos exactos')
const dec = [venta({ total: 0.1 }), venta({ total: 0.2 })]
check('>>> 0.10 + 0.20 = 0.30 exacto (con decimales de coma flotante daría 0.30000000000000004)', ventasPorPeriodo(dec, 'dia', LIMA, gruposDelPeriodo(periodo('2026-10-26', '2026-10-26'), 'dia')).totales.total === 0.3 && 0.1 + 0.2 !== 0.3)
const tres = Array.from({ length: 3 }, () => venta({ total: 0.1 }))
check('>>> 3 × 0.10 = 0.30, ticket promedio 0.10', ventasPorPeriodo(tres, 'dia', LIMA, gruposDelPeriodo(periodo('2026-10-26', '2026-10-26'), 'dia')).totales.total === 0.3 && ventasPorPeriodo(tres, 'dia', LIMA, []).totales.ticketPromedio === 0.1)
check('>>> importes que en coma flotante NO son exactos: 1.15 × 3 = 3.45, 0.57 + 8.2 = 8.77, 4.35 × 100 sin deriva', ventasPorPeriodo([venta({ total: 1.15 }), venta({ total: 1.15 }), venta({ total: 1.15 })], 'dia', LIMA, []).totales.total === 3.45 && ventasPorPeriodo([venta({ total: 0.57 }), venta({ total: 8.2 })], 'dia', LIMA, []).totales.total === 8.77 && ventasPorPeriodo([venta({ total: 4.35 })], 'dia', LIMA, []).totales.total === 4.35 && 1.15 * 100 !== 115)
check('el ticket promedio se redondea al céntimo (100.00 / 3 = 33.33; 100.01 / 2 = 50.01 hacia arriba)', ventasPorPeriodo([venta({ total: 50 }), venta({ total: 30 }), venta({ total: 20 })], 'dia', LIMA, []).totales.ticketPromedio === 33.33 && ventasPorPeriodo([venta({ total: 50 }), venta({ total: 50.01 })], 'dia', LIMA, []).totales.ticketPromedio === 50.01)

console.log('\nB) Por periodo')
const g = (a: string, b: string, gr: 'dia' | 'semana' | 'mes' = 'dia') => gruposDelPeriodo(periodo(a, b), gr)
const vs = [
  venta({ total: 118, igv: 18, descuentos: 5, completedAt: new Date('2026-10-26T04:59:59Z') }),   // Lima: 25/10 23:59:59
  venta({ total: 59, igv: 9, completedAt: new Date('2026-10-26T05:00:00Z') }),                    // Lima: 26/10 00:00:00
  venta({ total: 10, completedAt: new Date('2026-10-27T04:59:59Z') }),                            // Lima: 26/10 23:59:59
]
const p1 = ventasPorPeriodo(vs, 'dia', LIMA, g('2026-10-25', '2026-10-27'))
check('>>> la frontera de medianoche es la de LIMA: 23:59:59 del 25 y 00:00:00 del 26 van a días distintos', p1.filas[0]!.ventas === 1 && p1.filas[0]!.total === 118 && p1.filas[1]!.ventas === 2 && p1.filas[1]!.total === 69)
check('>>> los días sin ventas aparecen en cero (la serie no tiene huecos): el 27 existe y está vacío', p1.filas.length === 3 && p1.filas[2]!.ventas === 0 && p1.filas[2]!.total === 0 && p1.filas[2]!.ticketPromedio === 0)
check('totales: 3 ventas, 187.00, IGV 27.00, descuentos 5.00', p1.totales.ventas === 3 && p1.totales.total === 187 && p1.totales.igv === 27 && p1.totales.descuentos === 5)
check('por semana: la semana se llama por su lunes', ventasPorPeriodo(vs, 'semana', LIMA, g('2026-10-20', '2026-10-30', 'semana')).filas.map((f) => f.clave).join() === '2026-10-19,2026-10-26')
check('por mes: una venta del 31/10 23:30 de Lima va a octubre', ventasPorPeriodo([venta({ completedAt: new Date('2026-11-01T04:30:00Z') })], 'mes', LIMA, g('2026-10-01', '2026-11-05', 'mes')).filas[0]!.ventas === 1)
check('>>> una venta fuera de los grupos no se pierde: se cuenta (el total no miente)', ventasPorPeriodo([venta({ completedAt: new Date('2026-12-15T15:00:00Z'), total: 7 })], 'dia', LIMA, g('2026-10-25', '2026-10-26')).totales.total === 7)
check('sin ventas: todo en cero y sin NaN', JSON.stringify(ventasPorPeriodo([], 'dia', LIMA, g('2026-10-25', '2026-10-26')).totales) === JSON.stringify({ ventas: 0, total: 0, igv: 0, descuentos: 0, ticketPromedio: 0, devuelto: 0 }))

console.log('\nC) Por vendedor')
const nombres = new Map([['u1', 'Ana'], ['u2', 'Beto'], ['u3', '=HYPERLINK("http://x","clic")']])
const vv = [venta({ total: 100, vendedorId: 'u1', cobroId: 'u2' }), venta({ total: 300, vendedorId: 'u2', cobroId: 'u2' }), venta({ total: 100, vendedorId: 'u1', cobroId: 'u2' }), venta({ total: 0.5, vendedorId: 'u9', cobroId: 'u3' })]
const pv = ventasPorVendedor(vv, 'VENDEDOR', nombres)
check('>>> atribuido al VENDEDOR: Beto 300, Ana 200 (2 ventas), el usuario borrado aparece como tal', pv.filas.map((f) => `${f.nombre}:${f.total}:${f.ventas}`).join('|') === 'Beto:300:1|Ana:200:2|(usuario eliminado):0.5:1')
const pc = ventasPorVendedor(vv, 'COBRO', nombres)
check('>>> atribuido a QUIEN COBRÓ: Beto cobró 500; el otro cobró 0.50', pc.filas[0]!.nombre === 'Beto' && pc.filas[0]!.total === 500 && pc.filas[0]!.ventas === 3)
check('ordenado por total descendente y, a igual total, por nombre', ventasPorVendedor([venta({ total: 10, vendedorId: 'u2' }), venta({ total: 10, vendedorId: 'u1' })], 'VENDEDOR', nombres).filas.map((f) => f.nombre).join() === 'Ana,Beto')
check('participación: 300 de 500.50 = 59.94 %; 0.50 → 0.10 %', pv.filas[0]!.participacion === 59.94 && pv.filas[2]!.participacion === 0.1)
check('ticket promedio por vendedor', pv.filas.find((f) => f.nombre === 'Ana')!.ticketPromedio === 100)

console.log('\nD) Por medio de pago')
const mixta = venta({ total: 100, pagos: [{ metodo: 'EFECTIVO', monto: 70, vuelto: 0 }, { metodo: 'YAPE', monto: 30, vuelto: 0 }] })
const conVuelto = venta({ total: 47.5, pagos: [{ metodo: 'EFECTIVO', monto: 50, vuelto: 2.5 }] })
const fiado = venta({ total: 200, pagos: [{ metodo: 'EFECTIVO', monto: 50, vuelto: 0 }, { metodo: 'CREDITO', monto: 150, vuelto: 0 }] })
const pm = ventasPorMedio([mixta, conVuelto, fiado])
const mont = Object.fromEntries(pm.filas.map((f) => [f.metodo, f.monto]))
check('>>> el efectivo es lo cobrado MENOS el vuelto: 70 + (50 − 2.50) + 50 = 167.50', mont.EFECTIVO === 167.5, JSON.stringify(mont)) ; check('el neto de una línea con vuelto, en céntimos: 50.00 − 2.50 = 4750', netoDePagoCentimos({ metodo: 'EFECTIVO', monto: 50, vuelto: 2.5 }) === 4750)
check('Yape 30 y el fiado 150 aparece como un medio más («Fiado (a crédito)»)', mont.YAPE === 30 && mont.CREDITO === 150 && pm.filas.find((f) => f.metodo === 'CREDITO')!.etiqueta === 'Fiado (a crédito)')
check('>>> los medios suman EXACTAMENTE lo vendido (347.50) y no hay descuadre', pm.totalMedios === 347.5 && pm.totalVentas === 347.5 && pm.descuadradas.ventas === 0 && pm.descuadradas.diferencia === 0)
check('cuántas ventas usaron cada medio (una venta mixta cuenta en los dos)', pm.filas.find((f) => f.metodo === 'EFECTIVO')!.ventas === 3 && pm.filas.find((f) => f.metodo === 'YAPE')!.ventas === 1)
const desc = ventasPorMedio([venta({ total: 100, pagos: [{ metodo: 'EFECTIVO', monto: 90, vuelto: 0 }] }), venta({ total: 50, pagos: [] }), mixta])
check('>>> una venta cuyos pagos NO suman su total se DETECTA (no se esconde): 2 ventas, diferencia 60.00', desc.descuadradas.ventas === 2 && desc.descuadradas.diferencia === 60 && desc.totalVentas === 250 && desc.totalMedios === 190)
check('>>> una venta con DOS líneas del mismo medio cuenta UNA vez en ese medio, pero suma las dos líneas', (() => { const r = ventasPorMedio([venta({ total: 100, pagos: [{ metodo: 'YAPE', monto: 60, vuelto: 0 }, { metodo: 'YAPE', monto: 40, vuelto: 0 }] })]); const y = r.filas.find((f) => f.metodo === 'YAPE')!; return y.ventas === 1 && y.monto === 100 })())
check('participaciones suman 100 (± redondeo)', Math.abs(pm.filas.reduce((a, f) => a + f.participacion, 0) - 100) < 0.05)
check('todas las formas de pago tienen etiqueta en español', Object.keys(ETIQUETA_METODO).length === 8 && etiquetaMetodo('EFECTIVO') === 'Efectivo' && etiquetaMetodo('XYZ') === 'XYZ')

console.log('\nE) Cobros (el dinero que ENTRÓ)')
const pagosVentas: PagoFila[] = [{ metodo: 'EFECTIVO', monto: 50, vuelto: 2.5 }, { metodo: 'YAPE', monto: 30, vuelto: 0 }, { metodo: 'CREDITO', monto: 150, vuelto: 0 }]
const co = cobrosPorMedio(pagosVentas, [{ metodo: 'EFECTIVO', monto: 20 }, { metodo: 'TRANSFERENCIA', monto: 100 }, { metodo: 'YAPE', monto: 5 }])
const cm = Object.fromEntries(co.filas.map((f) => [f.metodo, f]))
check('>>> lo FIADO no es un cobro: no hay fila de crédito', !cm.CREDITO && co.filas.length === 3)
check('>>> efectivo: 47.50 de ventas (neto de vuelto) + 20.00 de abonos = 67.50', cm.EFECTIVO!.contado === 47.5 && cm.EFECTIVO!.abonos === 20 && cm.EFECTIVO!.total === 67.5)
check('Yape suma venta y abono; la transferencia es solo abono', cm.YAPE!.total === 35 && cm.TRANSFERENCIA!.contado === 0 && cm.TRANSFERENCIA!.abonos === 100)
check('>>> totales: cobrado 202.50 = 77.50 en ventas + 125.00 en abonos, y 3 + 3 operaciones', co.totales.total === 202.5 && co.totales.contado === 77.5 && co.totales.abonos === 125 && co.totales.operacionesContado === 2 && co.totales.operacionesAbono === 3)
check('un abono marcado «CREDITO» (imposible) se ignora por seguridad', cobrosPorMedio([], [{ metodo: 'CREDITO', monto: 99 }]).filas.length === 0)
check('sin cobros: vacío y en cero', cobrosPorMedio([], []).totales.total === 0)

console.log('\nF) Conciliación sobre 3000 ventas al azar')
const metodos = ['EFECTIVO', 'YAPE', 'PLIN', 'TRANSFERENCIA', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'CREDITO', 'OTRO']
const azar: VentaFila[] = Array.from({ length: 3000 }, () => {
  const totalC = 1 + Math.floor(Math.random() * 500_000)
  const n = 1 + Math.floor(Math.random() * 3)
  const cortes = Array.from({ length: n - 1 }, () => Math.floor(Math.random() * totalC)).sort((a, b) => a - b)
  const partes = [...cortes, totalC].map((x, i, a) => x - (i === 0 ? 0 : a[i - 1]!))
  const pagos: PagoFila[] = partes.map((p, i) => {
    const metodo = metodos[Math.floor(Math.random() * metodos.length)]!
    const vuelto = metodo === 'EFECTIVO' && i === partes.length - 1 ? Math.floor(Math.random() * 500) : 0
    return { metodo, monto: (p + vuelto) / 100, vuelto: vuelto / 100 }
  })
  return venta({ total: totalC / 100, igv: Math.floor(totalC * 0.15) / 100, descuentos: Math.floor(Math.random() * 300) / 100, vendedorId: `u${1 + Math.floor(Math.random() * 7)}`, cobroId: `u${1 + Math.floor(Math.random() * 3)}`,
    completedAt: new Date(Date.UTC(2026, 9, 1) + Math.floor(Math.random() * 40 * 86_400_000)), pagos })
})
const totalAzarC = azar.reduce((a, v) => a + c(v.total), 0)
const per = periodo('2026-09-30', '2026-11-10')
const rd = ventasPorPeriodo(azar, 'dia', LIMA, gruposDelPeriodo(per, 'dia')), rs = ventasPorPeriodo(azar, 'semana', LIMA, gruposDelPeriodo(per, 'semana')), rm = ventasPorPeriodo(azar, 'mes', LIMA, gruposDelPeriodo(per, 'mes'))
check('>>> y SIN redondear: el total mostrado es exactamente la suma de céntimos entre 100 (sin deriva de coma flotante), en las tres granularidades', rd.totales.total === totalAzarC / 100 && rs.totales.total === totalAzarC / 100 && rm.totales.total === totalAzarC / 100)
check('>>> la suma de los días = la de las semanas = la de los meses = el total de ventas (al céntimo)', c(rd.totales.total) === totalAzarC && c(rs.totales.total) === totalAzarC && c(rm.totales.total) === totalAzarC && rd.totales.ventas === 3000)
check('>>> y la suma de las FILAS coincide con la fila de totales (cada granularidad)', [rd, rs, rm].every((r) => r.filas.reduce((a, f) => a + c(f.total), 0) === c(r.totales.total) && r.filas.reduce((a, f) => a + f.ventas, 0) === 3000))
const rv = ventasPorVendedor(azar, 'VENDEDOR', new Map()), rc = ventasPorVendedor(azar, 'COBRO', new Map())
check('>>> la suma por vendedor y la suma por quien cobró = el total de ventas', rv.filas.reduce((a, f) => a + c(f.total), 0) === totalAzarC && rc.filas.reduce((a, f) => a + c(f.total), 0) === totalAzarC && rv.filas.reduce((a, f) => a + f.ventas, 0) === 3000)
const rmed = ventasPorMedio(azar)
check('>>> la suma por medio de pago = el total de ventas, sin descuadre (cada venta se pagó completa)', c(rmed.totalMedios) === totalAzarC && rmed.descuadradas.ventas === 0 && rmed.filas.reduce((a, f) => a + c(f.monto), 0) === totalAzarC)
const pagosAzar = azar.flatMap((v) => v.pagos)
const rcob = cobrosPorMedio(pagosAzar, [])
const fiadoC = pagosAzar.filter((p) => p.metodo === 'CREDITO').reduce((a, p) => a + netoDePagoCentimos(p), 0)
check('>>> cobros de ventas = ventas − lo fiado (lo que no se fió es lo que entró)', c(rcob.totales.contado) === totalAzarC - fiadoC)
check('>>> el orden de las ventas no cambia ningún total', (() => { const m = [...azar].sort(() => Math.random() - 0.5); return c(ventasPorPeriodo(m, 'dia', LIMA, gruposDelPeriodo(per, 'dia')).totales.total) === totalAzarC && JSON.stringify(ventasPorMedio(m).filas.map((f) => [f.metodo, f.monto])) === JSON.stringify(rmed.filas.map((f) => [f.metodo, f.monto])) })())

console.log('\nG) CSV')
const tp = csvVentasPorPeriodo(p1)
check('periodo: cabecera de 6 columnas, una fila por día más TOTAL con los mismos importes', tp.cabecera.length === 6 && tp.filas.length === 4 && tp.filas[3]![0] === 'TOTAL' && JSON.stringify(tp.filas[3]![2]) === JSON.stringify({ monto: 187 }))
const csv = generarCsv(tp.cabecera, tp.filas)
check('BOM, separador «;» y dos decimales con punto', csv.startsWith('﻿') && csv.split('\r\n')[1]!.includes('118.00') && csv.split('\r\n')[0]!.split(';').length === 6)
const tv = csvVentasPorVendedor(pc)   // en este reporte el usuario u3 (nombre con fórmula) cobró una venta
const csvV = generarCsv(tv.cabecera, tv.filas)
check('>>> un vendedor llamado «=HYPERLINK(…)» sale como TEXTO (con apóstrofo), no como fórmula de Excel', csvV.includes("'=HYPERLINK") && !/(^|;)=HYPERLINK/m.test(csvV))
check('vendedor: la cabecera dice a quién se atribuye', csvVentasPorVendedor(pv).cabecera[0] === 'Vendedor' && csvVentasPorVendedor(pc).cabecera[0] === 'Cobró en caja')
check('>>> medios: incluye el total de los medios, el de las ventas y, si hay, la DIFERENCIA', csvVentasPorMedio(pm).filas.some((f) => f[0] === 'TOTAL DE LAS VENTAS') && !csvVentasPorMedio(pm).filas.some((f) => String(f[0]).startsWith('DIFERENCIA')) && csvVentasPorMedio(desc).filas.some((f) => String(f[0]).includes('DIFERENCIA (2 venta(s)')))
check('cobros: 7 columnas, TOTAL al final', csvCobros(co).cabecera.length === 7 && csvCobros(co).filas.at(-1)![0] === 'TOTAL')
check('sin ventas el CSV solo trae el TOTAL en cero', csvVentasPorVendedor(ventasPorVendedor([], 'VENDEDOR', nombres)).filas.length === 1 && csvCobros(cobrosPorMedio([], [])).filas.length === 1)

console.log('\nH) Direcciones y parámetros')
check('el periodo por defecto da la dirección limpia', enlaceVentas('periodo', {}) === '/reportes/ventas' && enlaceVentas('periodo', { p: 'MES' }) === '/reportes/ventas')
check('>>> cada pestaña conserva el periodo, la agrupación y la atribución', enlaceVentas('vendedor', { p: 'SEMANA', atrib: 'COBRO' }) === '/reportes/ventas?t=vendedor&p=SEMANA&atrib=COBRO' && enlaceVentas('periodo', { p: 'ULTIMOS_30', agrupar: 'semana' }) === '/reportes/ventas?p=ULTIMOS_30&agrupar=semana')
check('las fechas del rango solo viajan con «RANGO»', enlaceVentas('medios', { p: 'RANGO', desde: '2026-10-01', hasta: '2026-10-05' }) === '/reportes/ventas?t=medios&p=RANGO&desde=2026-10-01&hasta=2026-10-05' && !enlaceVentas('medios', { p: 'HOY', desde: '2026-10-01' }).includes('desde'))
check('el enlace del CSV usa la ruta de la API con los mismos parámetros', enlaceCsvVentas('cobros', { p: 'MES_PASADO' }) === '/api/reportes/ventas/cobros?p=MES_PASADO' && enlaceCsvVentas('periodo', {}) === '/api/reportes/ventas/periodo')
check('>>> parámetros: sin nada, este mes automático al vendedor; un preset inventado o una fecha mal escrita se rechazan', parametrosVentasSchema.parse({}).p === 'MES' && parametrosVentasSchema.parse({}).agrupar === 'auto' && parametrosVentasSchema.parse({}).atrib === 'VENDEDOR' && !parametrosVentasSchema.safeParse({ p: 'SIEMPRE' }).success && !parametrosVentasSchema.safeParse({ p: 'RANGO', desde: '1/10/2026' }).success && !parametrosVentasSchema.safeParse({ atrib: 'TODOS' }).success)

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
