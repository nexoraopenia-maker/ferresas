import { NOMBRE_SIN_PROVEEDOR, agruparPorProveedor, cantidadAPedir, entraAlReporte, esBajoPedido } from '../src/features/inventory/reposicion-pedido'
import { aplicarUmbralesSchema, cambioUmbralSchema, MAX_CAMBIOS_UMBRALES } from '../src/features/inventory/umbrales-schemas'
import { leerCeldaUmbral } from '../src/features/inventory/umbrales-service'
import { textoPedir } from '../src/features/inventory/components/ReposicionReporte'

/**
 * F6.6b · Lo PURO del reporte de reposición: el redondeo hacia arriba a la presentación de compra (y a los decimales de la unidad), la convención «bajo pedido», la agrupación por
 * proveedor, el texto de lo que se pide y el esquema de los cambios de mínimos y máximos.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const caja12 = { id: 'p1', name: 'Caja', unitType: 'UNIDAD', factor: 12 }

console.log('\nA) Redondeo hacia ARRIBA a la presentación de compra')
check('>>> sugerir 14 con cajas de 12 pide 2 cajas (24 unidades), no 1', (() => { const r = cantidadAPedir(14, 'UNIDAD', caja12); return r.cantidad === 2 && r.unidadesBase === 24 && r.sobrante === 10 })())
check('>>> un múltiplo exacto no pide una caja de más (24 → 2 cajas, sobrante 0)', (() => { const r = cantidadAPedir(24, 'UNIDAD', caja12); return r.cantidad === 2 && r.unidadesBase === 24 && r.sobrante === 0 })())
check('>>> una unidad sobre el múltiplo sí pide otra caja (25 → 3 cajas)', cantidadAPedir(25, 'UNIDAD', caja12).cantidad === 3)
check('>>> sugerir 1 con cajas de 12 pide 1 caja entera', cantidadAPedir(1, 'UNIDAD', caja12).cantidad === 1)
check('>>> 0.0001 también pide una caja (nunca se pide de menos)', cantidadAPedir(0.0001, 'UNIDAD', caja12).cantidad === 1)
check('>>> sin nada que pedir (0 o negativo) no pide nada', cantidadAPedir(0, 'UNIDAD', caja12).cantidad === 0 && cantidadAPedir(-5, 'UNIDAD', caja12).unidadesBase === 0)
check('>>> exactitud: 12.0000 con cajas de 12 es 1 caja (sin flotante que pida 2)', cantidadAPedir(12.0000, 'UNIDAD', caja12).cantidad === 1 && cantidadAPedir(0.1 + 0.2 + 11.7, 'UNIDAD', caja12).cantidad === 1)
check('>>> factor con decimales: sacos de 42.5 kg, sugerir 100 kg → 3 sacos (127.5 kg)', (() => { const r = cantidadAPedir(100, 'KILOGRAMO', { id: 's', name: 'Saco', unitType: 'KILOGRAMO', factor: 42.5 }); return r.cantidad === 3 && r.unidadesBase === 127.5 && r.sobrante === 27.5 })())
check('>>> factor enorme y sugerida pequeña: un solo bulto', cantidadAPedir(3, 'UNIDAD', { id: 'x', name: 'Pallet', unitType: 'UNIDAD', factor: 1000 }).cantidad === 1)
check('>>> sin presentación, unidades enteras: 2.3 → 3', (() => { const r = cantidadAPedir(2.3, 'UNIDAD'); return r.cantidad === 3 && r.unidadesBase === 3 && r.presentacion === null })())
check('>>> sin presentación, unidades enteras: 2 se queda en 2', cantidadAPedir(2, 'UNIDAD').cantidad === 2)
check('>>> sin presentación, a granel conserva sus decimales (kilos: 2.3 → 2.3)', cantidadAPedir(2.3, 'KILOGRAMO').cantidad === 2.3)
check('>>> un factor inválido (0) cae a la unidad base', cantidadAPedir(14, 'UNIDAD', { ...caja12, factor: 0 }).presentacion === null && cantidadAPedir(14, 'UNIDAD', { ...caja12, factor: 0 }).cantidad === 14)

console.log('\nB) «Bajo pedido»: sin proveedor y sin umbrales')
check('>>> sin proveedor, mínimo 0 y sin máximo: bajo pedido', esBajoPedido({ supplierId: null, minimo: 0, maximo: null }))
check('>>> máximo 0 cuenta como sin máximo', esBajoPedido({ supplierId: null, minimo: 0, maximo: 0 }))
check('>>> con proveedor habitual NO es bajo pedido', !esBajoPedido({ supplierId: 's1', minimo: 0, maximo: null }))
check('>>> con mínimo NO es bajo pedido', !esBajoPedido({ supplierId: null, minimo: 5, maximo: null }))
check('>>> con máximo NO es bajo pedido', !esBajoPedido({ supplierId: null, minimo: 0, maximo: 20 }))
const fila = (o: Partial<Parameters<typeof entraAlReporte>[0]>) => ({ supplierId: 's1' as string | null, minimo: 10, maximo: null as number | null, dispara: true, sugerida: 5, posicion: 5, ...o })
check('>>> una fila normal que dispara entra', entraAlReporte(fila({})))
check('>>> si no dispara, no entra', !entraAlReporte(fila({ dispara: false })))
check('>>> si no hay nada que pedir (sugerida 0), no entra', !entraAlReporte(fila({ sugerida: 0 })))
check('>>> bajo pedido agotado (posición 0) NO entra', !entraAlReporte(fila({ supplierId: null, minimo: 0, posicion: 0, sugerida: 0 })))
check('>>> bajo pedido con posición POSITIVA no entra', !entraAlReporte(fila({ supplierId: null, minimo: 0, posicion: 3, sugerida: 1 })))
check('>>> >>> bajo pedido con posición NEGATIVA (vendido sin existencias) SÍ entra', entraAlReporte(fila({ supplierId: null, minimo: 0, posicion: -3, sugerida: 3 })))
check('>>> bajo pedido con posición exactamente 0 NO entra aunque algo sugiriera pedir', !entraAlReporte(fila({ supplierId: null, minimo: 0, posicion: 0, sugerida: 1 })))
check('>>> un producto con proveedor y posición negativa entra', entraAlReporte(fila({ posicion: -3, sugerida: 23 })))

console.log('\nC) Agrupar por proveedor')
const L = (nombre: string, supplierId: string | null, estado: 'OK' | 'LOW' | 'OUT' = 'LOW') => ({ nombre, supplierId, estado })
const nombres = new Map([['s1', 'Aceros SAC'], ['s2', 'Bisagras SRL'], ['s3', 'Ñandú EIRL']])
const g = agruparPorProveedor([L('Z', 's2'), L('B', null), L('A', 's1', 'OK'), L('C', 's1', 'OUT'), L('M', 's1', 'LOW'), L('Y', 's3')], nombres)
check('>>> un grupo por proveedor, por nombre, y «Otros / Sin proveedor» AL FINAL', g.map((x) => x.nombre).join('|') === `Aceros SAC|Bisagras SRL|Ñandú EIRL|${NOMBRE_SIN_PROVEEDOR}`, g.map((x) => x.nombre).join('|'))
check('>>> los sin proveedor van a «Otros / Sin proveedor» con supplierId null', g[g.length - 1]!.supplierId === null && g[g.length - 1]!.lineas.length === 1)
check('>>> dentro de un grupo, lo agotado primero, luego lo crítico, luego por nombre', g[0]!.lineas.map((l) => l.nombre).join('') === 'CMA')
check('>>> un proveedor sin nombre conocido (dado de baja) no pierde la línea: va a «Otros»', (() => { const x = agruparPorProveedor([L('Q', 'fantasma')], nombres); return x.length === 1 && x[0]!.supplierId === null && x[0]!.nombre === NOMBRE_SIN_PROVEEDOR })())
check('>>> sin líneas no hay grupos', agruparPorProveedor([], nombres).length === 0)
check('>>> ninguna línea se pierde ni se duplica', g.reduce((s, x) => s + x.lineas.length, 0) === 6)

console.log('\nD) Lo que se pide, en palabras')
check('>>> con presentación: «2 × Caja de 12 (24 u)»', textoPedir({ unitType: 'UNIDAD', pedir: cantidadAPedir(14, 'UNIDAD', caja12) }).startsWith('2 × Caja de 12 (24 '))
check('>>> sin presentación: «3 u» (unidad base hacia arriba)', /^3 /.test(textoPedir({ unitType: 'UNIDAD', pedir: cantidadAPedir(2.3, 'UNIDAD') })))

console.log('\nE) Esquema de los cambios de mínimos y máximos')
const ok = (c: unknown) => cambioUmbralSchema.safeParse(c).success
check('>>> almacén exige warehouseId', !ok({ nivel: 'ALMACEN', productId: 'p', minimo: 1 }) && ok({ nivel: 'ALMACEN', productId: 'p', warehouseId: 'w', minimo: 1 }))
check('>>> variante exige variantId; producto no admite variante ni almacén', !ok({ nivel: 'VARIANTE', productId: 'p', minimo: 1 }) && ok({ nivel: 'VARIANTE', productId: 'p', variantId: 'v', minimo: 1 }) && !ok({ nivel: 'PRODUCTO', productId: 'p', variantId: 'v', minimo: 1 }) && !ok({ nivel: 'PRODUCTO', productId: 'p', warehouseId: 'w', minimo: 1 }))
check('>>> sin mínimo ni máximo no hay nada que cambiar', !ok({ nivel: 'PRODUCTO', productId: 'p' }))
check('>>> null = quitar el valor propio (válido); undefined = no tocar', ok({ nivel: 'PRODUCTO', productId: 'p', minimo: null }) && ok({ nivel: 'PRODUCTO', productId: 'p', maximo: null }))
check('>>> negativos, NaN y más de 4 decimales se rechazan', !ok({ nivel: 'PRODUCTO', productId: 'p', minimo: -1 }) && !ok({ nivel: 'PRODUCTO', productId: 'p', minimo: Number.NaN }) && !ok({ nivel: 'PRODUCTO', productId: 'p', minimo: 1.00001 }) && !ok({ nivel: 'PRODUCTO', productId: 'p', minimo: 1e12 }))
check('>>> el máximo no puede ser menor que el mínimo del mismo cambio (el igual sí)', !ok({ nivel: 'PRODUCTO', productId: 'p', minimo: 10, maximo: 5 }) && ok({ nivel: 'PRODUCTO', productId: 'p', minimo: 10, maximo: 10 }))
check('>>> un lote vacío o de más de 1000 cambios se rechaza', !aplicarUmbralesSchema.safeParse({ cambios: [] }).success && !aplicarUmbralesSchema.safeParse({ cambios: Array.from({ length: MAX_CAMBIOS_UMBRALES + 1 }, () => ({ nivel: 'PRODUCTO', productId: 'p', minimo: 1 })) }).success)

console.log('\nF) Celdas del CSV de umbrales')
const c = (s?: string) => leerCeldaUmbral(s)
check('>>> vacía = no tocar', 'vacia' in c('') && (c('  ') as { vacia: boolean }).vacia === true && (c(undefined) as { vacia: boolean }).vacia === true)
check('>>> «-» = quitar el valor propio', (() => { const x = c('-') as { vacia: boolean; quitar?: boolean }; return x.vacia === false && x.quitar === true })())
check('>>> número con punto o con coma decimal', (c('12.5') as { valor: number }).valor === 12.5 && (c('12,5') as { valor: number }).valor === 12.5 && (c('0') as { valor: number }).valor === 0)
check('>>> texto, negativos, notación científica y más de 4 decimales son errores', ['abc', '-3', '1e3', '1.00001', '12 unidades', '1,2,3'].every((s) => 'error' in c(s)))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
