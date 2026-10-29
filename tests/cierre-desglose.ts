import { readFileSync } from 'node:fs'
import { ETIQUETA_METODO, METODOS_REPORTE, VERSION_DESGLOSE, construirDesglose, type EntradaDesglose } from '../src/features/branches/cierre-desglose'

/**
 * F6.8a · El desglose del cierre, puro: Yape y Plin explícitos y separados, el vuelto solo del efectivo, el fiado aparte, lo devuelto por método y por dónde sale, descuentos, anuladas,
 * ventas bajo costo (sin costos), movimientos por categoría y que el total cuadra. Sin base de datos.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const vacia = (): EntradaDesglose => ({ ventas: [], pagos: [], devoluciones: [], abonos: [], pagosProveedor: [], movimientos: [] })
const venta = (numero: string, total: number, extra: Partial<EntradaDesglose['ventas'][number]> = {}) => ({ numero, status: 'COMPLETADA' as const, total, discountTotal: 0, bajoCosto: false, ...extra })

console.log('\nA) Ventas por método de pago')
const e1: EntradaDesglose = {
  ...vacia(),
  ventas: [venta('V1', 100), venta('V2', 50), venta('V3', 30), venta('V4', 20), venta('V5', 60)],
  pagos: [
    { method: 'EFECTIVO', amount: 100, change: 0 }, { method: 'YAPE', amount: 50, change: 0 }, { method: 'PLIN', amount: 30, change: 0 },
    { method: 'TARJETA_DEBITO', amount: 20, change: 0 }, { method: 'EFECTIVO', amount: 50, change: 20 }, { method: 'CREDITO', amount: 30, change: 0 },
  ],
}
const d1 = construirDesglose(e1)
check('>>> >>> Yape y Plin tienen su propia línea, separadas del efectivo y de las tarjetas', d1.ventasPorMetodo.YAPE.monto === 50 && d1.ventasPorMetodo.PLIN.monto === 30 && d1.ventasPorMetodo.EFECTIVO.monto !== 50 + 30 && d1.ventasPorMetodo.TARJETA_DEBITO.monto === 20)
check('>>> cada método cuenta sus operaciones', d1.ventasPorMetodo.YAPE.operaciones === 1 && d1.ventasPorMetodo.EFECTIVO.operaciones === 2 && d1.ventasPorMetodo.TARJETA_CREDITO.operaciones === 0)
check('>>> >>> el vuelto sale SOLO del efectivo: 100 + (50 − 20) = 130', d1.ventasPorMetodo.EFECTIVO.monto === 130 && d1.vueltos === 20)
check('>>> el fiado va aparte y no entra en lo cobrado', d1.ventasPorMetodo.CREDITO.monto === 30 && d1.cobradoNeto === 130 + 50 + 30 + 20)
check('>>> los métodos sin movimiento existen con cero (el reporte siempre trae todas las líneas)', METODOS_REPORTE.every((m) => d1.ventasPorMetodo[m] !== undefined) && d1.ventasPorMetodo.OTRO.monto === 0 && d1.ventasPorMetodo.TRANSFERENCIA.operaciones === 0)
check('>>> todos los métodos tienen etiqueta en español, con «Yape» y «Plin» por su nombre', METODOS_REPORTE.every((m) => ETIQUETA_METODO[m].length > 2) && ETIQUETA_METODO.YAPE === 'Yape' && ETIQUETA_METODO.PLIN === 'Plin' && /Fiado/.test(ETIQUETA_METODO.CREDITO))
check('>>> exactitud en céntimos: 0.1 + 0.2 cobrados en Yape son 0.30', construirDesglose({ ...vacia(), pagos: [{ method: 'YAPE', amount: 0.1, change: 0 }, { method: 'YAPE', amount: 0.2, change: 0 }] }).ventasPorMetodo.YAPE.monto === 0.3)
check('>>> el cuadre: lo vendido = lo cobrado neto + lo fiado (con la misma base de ventas)', (() => { const d = construirDesglose({ ...e1, ventas: [venta('V1', 100), venta('V2', 50), venta('V3', 30), venta('V4', 20), venta('V5', 60)] }); return d.ventas.total === 260 && Math.abs(d.cobradoNeto + d.ventasPorMetodo.CREDITO.monto - d.ventas.total) < 0.005 })())

console.log('\nB) Descuentos, anuladas y ventas bajo costo')
const d2 = construirDesglose({ ...vacia(), ventas: [venta('A', 100, { discountTotal: 10 }), venta('B', 50), venta('C', 40, { discountTotal: 2.5 }), venta('D', 60, { status: 'ANULADA' }), venta('E', 25, { status: 'DEVUELTA' }), venta('G', 10, { bajoCosto: true }), venta('F', 70, { bajoCosto: true })] })
check('>>> descuentos: total y cuántas ventas lo llevaron', d2.ventas.descuentos.total === 12.5 && d2.ventas.descuentos.ventasConDescuento === 2)
check('>>> anuladas y devueltas: cantidad y monto', d2.ventas.anuladas.cantidad === 2 && d2.ventas.anuladas.monto === 85)
check('>>> >>> ventas bajo costo: cuántas y cuáles (por número), ordenadas, SIN ninguna cifra de costo', d2.ventas.bajoCosto.cantidad === 2 && d2.ventas.bajoCosto.ventas.join() === 'F,G' && !/costPrice|unitCost|margen|"costo"/i.test(JSON.stringify(d2)))
check('>>> la cantidad y el total de ventas incluyen las anuladas (es lo cobrado en el turno)', d2.ventas.cantidad === 7 && d2.ventas.total === 355)

console.log('\nC) Devoluciones, abonos, proveedores y movimientos')
const d3 = construirDesglose({
  ...vacia(),
  devoluciones: [{ mode: 'CAJA', method: 'EFECTIVO', amount: 40 }, { mode: 'CAJA', method: null, amount: 10 }, { mode: 'EXTERNO', method: 'YAPE', amount: 25 }, { mode: 'SIN_SALIDA', method: null, amount: 99 }],
  abonos: [{ method: 'EFECTIVO', amount: 60 }, { method: 'PLIN', amount: 15 }, { method: 'EFECTIVO', amount: 5 }],
  pagosProveedor: [{ method: 'EFECTIVO', amount: 200 }, { method: 'TRANSFERENCIA', amount: 300 }],
  movimientos: [{ kind: 'EGRESO', category: 'GASTO_MENOR', amount: 12.5 }, { kind: 'EGRESO', category: 'GASTO_MENOR', amount: 7.5 }, { kind: 'EGRESO', category: 'RETIRO_DUENO', amount: 100 }, { kind: 'INGRESO', category: 'REPOSICION_FONDO', amount: 50 }],
})
check('>>> devoluciones: lo que sale del cajón, lo que sale por otro medio y lo que no mueve dinero van separados', d3.devoluciones.delCajon === 50 && d3.devoluciones.porOtroMedio === 25 && d3.devoluciones.sinSalida === 99)
check('>>> las devoluciones por método (una de caja sin método cuenta como efectivo) y «sin salida» no entra en ningún método', d3.devoluciones.porMetodo.EFECTIVO.monto === 50 && d3.devoluciones.porMetodo.YAPE.monto === 25 && Object.values(d3.devoluciones.porMetodo).reduce((s, l) => s + l.monto, 0) === 75)
check('>>> abonos cobrados por método (Plin aparte)', d3.abonosPorMetodo.EFECTIVO.monto === 65 && d3.abonosPorMetodo.EFECTIVO.operaciones === 2 && d3.abonosPorMetodo.PLIN.monto === 15)
check('>>> pagos a proveedores por método', d3.pagosProveedorPorMetodo.EFECTIVO.monto === 200 && d3.pagosProveedorPorMetodo.TRANSFERENCIA.monto === 300)
check('>>> movimientos por categoría y totales (12.5 + 7.5 = 20 de gasto menor)', d3.movimientos.egresos.GASTO_MENOR === 20 && d3.movimientos.egresos.RETIRO_DUENO === 100 && d3.movimientos.ingresos.REPOSICION_FONDO === 50 && d3.movimientos.totalEgresos === 120 && d3.movimientos.totalIngresos === 50)

console.log('\nD) Forma del resultado')
const vacio = construirDesglose(vacia())
check('>>> un turno sin movimiento da ceros, sin errores, y trae la versión del formato', vacio.version === VERSION_DESGLOSE && vacio.ventas.cantidad === 0 && vacio.cobradoNeto === 0 && vacio.movimientos.totalIngresos === 0 && vacio.ventas.bajoCosto.ventas.length === 0)
check('>>> es JSON puro (se guarda tal cual en la base y se relee igual)', JSON.stringify(JSON.parse(JSON.stringify(d3))) === JSON.stringify(d3) && JSON.stringify(JSON.parse(JSON.stringify(d1))) === JSON.stringify(d1))
check('>>> no muta lo que recibe', (() => { const antes = JSON.stringify(e1); construirDesglose(e1); return JSON.stringify(e1) === antes })())
const fuente = readFileSync('src/features/branches/cierre-desglose.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
check('>>> el módulo es puro: no importa Prisma, React ni nada del servidor, y no nombra costos', !/from '@\/(lib\/prisma|generated|lib\/tenant)|from 'react|from 'next|node:/.test(fuente) && !/costPrice|unitCost/.test(fuente))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
