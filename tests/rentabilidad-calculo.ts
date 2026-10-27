import { analisisAbc, inventarioValorizado, margenPorProducto, ventaSinIgvDeLinea, type FilaStock, type LineaVentaCosto } from '../src/features/reportes/rentabilidad-calculo'

/**
 * F5.3 · Margen, inventario valorizado y ABC (funciones puras). Lo central: un costo 0 es «no sé», NUNCA «gratis»; la cobertura acompaña
 * a todo margen; las sumas cuadran al céntimo; ABC no cambia con el orden de entrada.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const L = (productId: string, o: Partial<LineaVentaCosto> = {}): LineaVentaCosto => ({ productId, nombre: `P-${productId}`, sku: `S-${productId}`, unidad: 'UNIDAD', cantidad: 1, costoUnitario: 0, totalConIgv: 118, tasaIgv: 0.18, ...o })
const cerca = (a: number, b: number) => Math.abs(a - b) < 1e-9
let semilla = 7
const rnd = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648 }

console.log('\nA) Margen: costo 0 = «no sé»')
const m1 = margenPorProducto([L('a', { costoUnitario: 60 })])
check('venta 118 con IGV → 100 sin IGV; costo 60 → utilidad 40, margen 40 % (sobre venta), cobertura 100 %', cerca(m1.totales.ventaSinIgv, 100) && cerca(m1.totales.utilidad, 40) && m1.totales.margen === 40 && m1.totales.cobertura === 100)
const m2 = margenPorProducto([L('a', { costoUnitario: 0 })])
check('>>> un producto SOLO con costo 0 NO tiene margen (null), no un 100 %; su cobertura es 0 %', m2.filas[0]!.margen === null && m2.filas[0]!.cobertura === 0 && m2.totales.margen === null && m2.totales.utilidad === 0 && m2.totales.costo === 0)
check('>>> la venta sin costo no entra a la utilidad ni al costo, pero SÍ a la venta total y se lista aparte', m2.totales.ventaSinIgv === 100 && m2.totales.ventaConCosto === 0 && m2.totales.ventaSinCosto === 100 && m2.sinCosto.length === 1)
const m3 = margenPorProducto([L('a', { costoUnitario: 60 }), L('a', { costoUnitario: 0 })])
check('>>> mezcla: el margen usa solo la línea con costo (40 %) y la cobertura dice 50 %', m3.filas[0]!.margen === 40 && m3.filas[0]!.cobertura === 50 && cerca(m3.filas[0]!.utilidad, 40) && m3.filas[0]!.lineasSinCosto === 1)
check('costo negativo se trata también como sin costo', margenPorProducto([L('a', { costoUnitario: -5 })]).filas[0]!.margen === null)
check('vender a pérdida da utilidad y margen negativos (no se oculta)', (() => { const r = margenPorProducto([L('a', { costoUnitario: 150 })]); return cerca(r.totales.utilidad, -50) && r.totales.margen === -50 })())
check('sin ventas: todo en cero, sin filas ni NaN', (() => { const r = margenPorProducto([]); return r.filas.length === 0 && r.totales.ventaSinIgv === 0 && r.totales.margen === null && r.totales.cobertura === 100 && r.totales.lineas === 0 && !Object.values(r.totales).some((v) => typeof v === 'number' && Number.isNaN(v)) })())
check('cantidad fraccionaria: 2.5 × costo 10 = 25 exactos', cerca(margenPorProducto([L('a', { cantidad: 2.5, costoUnitario: 10 })]).totales.costo, 25))
check('el orden de los productos: mayor venta primero', (() => { const r = margenPorProducto([L('x', { totalConIgv: 59 }), L('y', { totalConIgv: 590 })]); return r.filas[0]!.productId === 'y' })())
check('>>> sinCosto ordena por importe sin costo, de mayor a menor', (() => { const r = margenPorProducto([L('x', { totalConIgv: 59 }), L('y', { totalConIgv: 590 }), L('z', { costoUnitario: 1 })]); return r.sinCosto.map((f) => f.productId).join() === 'y,x' })())

console.log('\nB) IGV como el POS y conciliación')
check('exento (tasa 0): venta sin IGV = total', ventaSinIgvDeLinea(50, 0) === 50)
check('redondeo del POS: 10.00 con 18 % → 8.47', ventaSinIgvDeLinea(10, 0.18) === 8.47)
check('>>> propiedad: la suma de totales == suma de filas == suma de las líneas redondeadas (400 casos aleatorios, al céntimo)', (() => {
  for (let i = 0; i < 400; i++) {
    const ls = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, k) => L(`p${Math.floor(rnd() * 5)}`, { totalConIgv: Math.round(rnd() * 100000) / 100, tasaIgv: rnd() < 0.3 ? 0 : 0.18, costoUnitario: rnd() < 0.4 ? 0 : Math.round(rnd() * 5000) / 100, cantidad: 1 + Math.floor(rnd() * 5), nombre: `n${k}` }))
    const r = margenPorProducto(ls)
    const esperadoC = ls.reduce((a, l) => a + Math.round(ventaSinIgvDeLinea(l.totalConIgv, l.tasaIgv) * 100), 0)
    const filasC = r.filas.reduce((a, f) => a + Math.round(f.ventaSinIgv * 100), 0)
    if (Math.round(r.totales.ventaSinIgv * 100) !== esperadoC || filasC !== esperadoC) return false
    if (Math.round((r.totales.ventaConCosto + r.totales.ventaSinCosto) * 100) !== esperadoC) return false
  }
  return true
})())

console.log('\nC) Inventario valorizado')
const S = (productId: string, almacenId: string, cantidad: number, costoUnitario: number, o: Partial<FilaStock> = {}): FilaStock => ({ productId, nombre: `P-${productId}`, sku: `S-${productId}`, unidad: 'UNIDAD', eliminado: false, almacenId, almacen: `A-${almacenId}`, cantidad, costoUnitario, ...o })
const i1 = inventarioValorizado([S('a', 'w1', 10, 2.5), S('a', 'w2', 4, 2.5), S('b', 'w1', 3, 10)])
check('valor = Σ cantidad × costo (10×2.5 + 4×2.5 + 3×10 = 65)', cerca(i1.totales.valor, 65) && cerca(i1.productos.find((p) => p.productId === 'a')!.valor!, 35))
check('>>> productos y almacenes suman lo mismo', cerca(i1.almacenes.reduce((a, x) => a + x.valor, 0), i1.totales.valor))
const i2 = inventarioValorizado([S('a', 'w1', 10, 0), S('b', 'w1', 2, 5)])
check('>>> stock sin costo NO se valoriza (ni vale 0 silencioso): queda marcado, con sus unidades, y baja la cobertura', i2.totales.valor === 10 && i2.totales.productosSinCosto === 1 && i2.totales.unidadesSinCosto === 10 && i2.productos.find((p) => p.productId === 'a')!.valor === null && i2.totales.coberturaProductos === 50)
const i3 = inventarioValorizado([S('a', 'w1', -4, 5), S('a', 'w2', 6, 5)])
check('>>> saldo negativo: ni suma ni resta, y se avisa', i3.totales.valor === 30 && i3.totales.productosConSaldoNegativo === 1 && i3.productos[0]!.conSaldoNegativo)
check('producto dado de baja con stock se valoriza y se marca', (() => { const r = inventarioValorizado([S('a', 'w1', 2, 5, { eliminado: true })]); return r.totales.valor === 10 && r.productos[0]!.eliminado })())
check('sin stock: vacío y sin NaN', (() => { const r = inventarioValorizado([]); return r.totales.valor === 0 && r.productos.length === 0 && r.almacenes.length === 0 && r.totales.coberturaProductos === 100 })())

console.log('\nD) ABC')
const it = (id: string, valor: number) => ({ id, nombre: id, sku: id, valor })
const abc = analisisAbc([it('a', 70), it('b', 15), it('c', 10), it('d', 5)])
check('>>> a empieza en 0 → A; b empieza en 70 (<80) y cruza el 80 → se queda en A (la clase que llena); c empieza en 85 → B; d empieza en 95 → C', abc.filas.map((f) => f.clase).join('') === 'AABC', abc.filas.map((f) => `${f.id}${f.clase}${f.acumulado}`).join(' '))
check('acumulado final = 100 y total correcto', abc.filas[abc.filas.length - 1]!.acumulado === 100 && abc.total === 100)
check('>>> el orden de entrada no cambia el resultado', (() => { const x = analisisAbc([it('d', 5), it('a', 70), it('c', 10), it('b', 15)]); return x.filas.map((f) => f.id + f.clase).join() === abc.filas.map((f) => f.id + f.clase).join() })())
check('empates: se desempata por nombre y es estable', analisisAbc([it('z', 10), it('a', 10), it('m', 10)]).filas.map((f) => f.id).join('') === 'amz')
check('>>> valores ≤ 0 van a C y NO suman al total', (() => { const r = analisisAbc([it('a', 100), it('n', -50), it('z', 0)]); return r.total === 100 && r.filas.filter((f) => f.clase === 'C').length === 2 && r.filas[0]!.acumulado === 100 && r.filas.every((f) => f.acumulado === 100) && r.filas.slice(1).every((f) => f.participacion === 0) })())
check('un solo producto: clase A, 100 %', (() => { const r = analisisAbc([it('a', 5)]); return r.filas[0]!.clase === 'A' && r.filas[0]!.participacion === 100 })())
check('vacío: sin filas y sin NaN', (() => { const r = analisisAbc([]); return r.filas.length === 0 && r.total === 0 && r.resumen.every((x) => x.productos === 0) })())
check('exactamente en el umbral (80 %): sigue siendo A', analisisAbc([it('a', 80), it('b', 20)]).filas[0]!.clase === 'A' && analisisAbc([it('a', 80), it('b', 20)]).filas[1]!.clase === 'B')
check('>>> umbrales inválidos se rechazan: a≥b, 0, 100, negativos', [{ a: 95, b: 80 }, { a: 80, b: 80 }, { a: 0, b: 50 }, { a: 50, b: 100 }, { a: -1, b: 50 }].every((u) => { try { analisisAbc([it('a', 1)], u); return false } catch (e) { return e instanceof RangeError } }))
check('umbrales propios: 50/90 cambian la clasificación', analisisAbc([it('a', 60), it('b', 40)], { a: 50, b: 90 }).filas.map((f) => f.clase).join('') === 'AB' && analisisAbc([it('a', 60), it('b', 40)], { a: 50, b: 90 }).umbrales.a === 50)
check('el resumen suma todos los productos y el 100 % del valor', (() => { const r = analisisAbc(Array.from({ length: 50 }, (_, k) => it(`p${k}`, 1 + (k * 37) % 91))); return r.resumen.reduce((a, x) => a + x.productos, 0) === 50 && Math.abs(r.resumen.reduce((a, x) => a + x.participacionValor, 0) - 100) < 0.05 })())
check('>>> la clase nunca baja al avanzar (A ≤ B ≤ C) en 200 listas aleatorias', (() => {
  for (let i = 0; i < 200; i++) {
    const r = analisisAbc(Array.from({ length: 1 + Math.floor(rnd() * 40) }, (_, k) => it(`p${k}`, Math.round((rnd() * 200 - 20) * 100) / 100)))
    for (let k = 1; k < r.filas.length; k++) { if (r.filas[k]!.clase < r.filas[k - 1]!.clase) return false; if (r.filas[k]!.acumulado < r.filas[k - 1]!.acumulado - 1e-9 && r.filas[k]!.valor > 0) return false }
  }
  return true
})())

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
