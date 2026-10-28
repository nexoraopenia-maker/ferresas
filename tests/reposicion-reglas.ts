import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FACTOR_OBJETIVO_SIN_MAXIMO, estadoDeFila, evaluarReposicion, objetivoDeReposicion, resolverUmbrales } from '../src/features/inventory/reposicion-reglas'
import { ETIQUETAS, MATRIZ, OPCIONALES, PERMISOS, permisosDeRol } from '../src/lib/permisos'
import { PERMISOS_FUERA_DEL_PIN } from '../src/features/seguridad/pin-reglas'

/**
 * F6.6a · El criterio ÚNICO de reposición, sin base de datos: la herencia de umbrales almacén → variante → producto, la posición (disponible + en tránsito), el semáforo,
 * el disparo (con su borde), el objetivo (máximo o 2 × el mínimo), la sugerida con stock negativo y los dos permisos nuevos.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const ev = (cantidad: number, minimo: number, maximo: number | null = null, extra: { reservado?: number; enTransito?: number } = {}) =>
  evaluarReposicion({ cantidad, minimo, maximo, ...extra })

console.log('\nA) Herencia del mínimo: almacén → variante → producto')
check('>>> sin nada más, manda el del producto', (() => { const u = resolverUmbrales({ productoMin: 10 }); return u.minimo === 10 && u.origenMinimo === 'PRODUCTO' })())
check('>>> el del almacén gana a todo (aunque sea menor)', (() => { const u = resolverUmbrales({ almacenMin: 3, varianteMin: 8, productoMin: 10 }); return u.minimo === 3 && u.origenMinimo === 'ALMACEN' })())
check('>>> un 0 EXPLÍCITO en el almacén es «sin umbral aquí» y NO hereda', (() => { const u = resolverUmbrales({ almacenMin: 0, varianteMin: 8, productoMin: 10 }); return u.minimo === 0 && u.origenMinimo === 'ALMACEN' })())
check('>>> sin almacén, manda el de la variante cuando es > 0', (() => { const u = resolverUmbrales({ almacenMin: null, varianteMin: 8, productoMin: 10 }); return u.minimo === 8 && u.origenMinimo === 'VARIANTE' })())
check('>>> la variante con 0 significa «sin valor propio»: hereda el del producto (antes lo tapaba)', (() => { const u = resolverUmbrales({ almacenMin: null, varianteMin: 0, productoMin: 10 }); return u.minimo === 10 && u.origenMinimo === 'PRODUCTO' })())
check('>>> valores que llegan como texto o Decimal (toString) se entienden igual', resolverUmbrales({ almacenMin: '4.5000' }).minimo === 4.5 && resolverUmbrales({ productoMin: { toString: () => '7' } }).minimo === 7)
check('>>> un umbral negativo o ilegible no existe: 0', resolverUmbrales({ productoMin: -5 }).minimo === 0 && resolverUmbrales({ productoMin: 'abc' }).minimo === 0 && resolverUmbrales({}).minimo === 0)

console.log('\nB) Herencia del máximo: almacén → variante → producto, todos opcionales')
check('>>> sin ninguno: no hay máximo', (() => { const u = resolverUmbrales({ productoMin: 5 }); return u.maximo === null && u.origenMaximo === null })())
check('>>> el máximo del producto hereda hacia abajo', (() => { const u = resolverUmbrales({ productoMax: 50 }); return u.maximo === 50 && u.origenMaximo === 'PRODUCTO' })())
check('>>> el de la variante gana al del producto, y el del almacén a ambos', resolverUmbrales({ varianteMax: 30, productoMax: 50 }).maximo === 30 && resolverUmbrales({ almacenMax: 20, varianteMax: 30, productoMax: 50 }).origenMaximo === 'ALMACEN')
check('>>> el máximo NO sigue al mínimo: un mínimo del almacén no arrastra otro nivel', (() => { const u = resolverUmbrales({ almacenMin: 2, productoMin: 10, productoMax: 40 }); return u.minimo === 2 && u.maximo === 40 })())
check('>>> un máximo en 0 EXPLÍCITO es un máximo (no «vacío»)', resolverUmbrales({ almacenMax: 0, productoMax: 50 }).maximo === 0)

console.log('\nC) Posición = disponible + en tránsito; semáforo sobre lo disponible')
check('>>> disponible = cantidad − reservado', ev(10, 4, null, { reservado: 3 }).disponible === 7)
check('>>> posición = cantidad − reservado + en tránsito', ev(10, 4, null, { reservado: 3, enTransito: 5 }).posicion === 12)
check('>>> el semáforo juzga lo DISPONIBLE: 10 en estante pero 8 reservados con mínimo 4 → crítico', (() => { const r = ev(10, 4, null, { reservado: 8 }); return r.disponible === 2 && r.estado === 'LOW' })())
check('>>> lo que viene en camino NO apaga el semáforo físico (sigue agotado)', (() => { const r = ev(0, 10, null, { enTransito: 100 }); return r.estado === 'OUT' && r.posicion === 100 })())
check('>>> reservar todo = agotado para vender', ev(5, 2, null, { reservado: 5 }).estado === 'OUT')
check('>>> OK / LOW / OUT: sobre el mínimo, justo en el mínimo (borde) y en cero', ev(11, 10).estado === 'OK' && ev(10, 10).estado === 'LOW' && ev(0, 10).estado === 'OUT')
check('>>> mínimo 0 = sin umbral: con existencias es OK, no LOW', ev(1, 0).estado === 'OK' && ev(0, 0).estado === 'OUT')
check('>>> el en tránsito negativo no existe (se ignora)', ev(5, 2, null, { enTransito: -4 }).posicion === 5)
check('>>> exactitud decimal: 0.1 + 0.2 de posición es 0.3, y 0.3 está en el mínimo 0.3', (() => { const r = ev(0.1, 0.3, null, { enTransito: 0.2 }); return r.posicion === 0.3 && r.dispara === true })())

console.log('\nD) Cuándo dispara la reposición (sobre la POSICIÓN)')
check('>>> sobre el mínimo: no dispara', ev(11, 10).dispara === false)
check('>>> justo en el mínimo YA dispara (el borde cuenta)', ev(10, 10).dispara === true)
check('>>> por debajo: dispara', ev(3, 10).dispara === true)
check('>>> lo que ya viene en camino evita pedirlo otra vez: 3 + 20 en tránsito sobre mínimo 10 → no dispara', ev(3, 10, null, { enTransito: 20 }).dispara === false)
check('>>> pero si lo que viene no alcanza sigue disparando: 3 + 4 en tránsito, mínimo 10', ev(3, 10, null, { enTransito: 4 }).dispara === true)
check('>>> lo reservado SÍ resta de la posición: 12 con 5 reservados, mínimo 10 → dispara', ev(12, 10, null, { reservado: 5 }).dispara === true)
check('>>> sin mínimo (0): solo dispara si lo disponible se agotó', ev(5, 0).dispara === false && ev(0, 0).dispara === true && ev(-2, 0).dispara === true)
check('>>> sin mínimo y agotado pero con algo en camino: lo disponible manda → dispara, y no hay nada que pedir (sugerida 0, nunca negativa)', (() => { const r = ev(0, 0, null, { enTransito: 9 }); return r.dispara === true && r.sugerida === 0 })())

console.log('\nE) Objetivo y sugerida')
check(`>>> sin máximo el objetivo es ${FACTOR_OBJETIVO_SIN_MAXIMO} × el mínimo`, FACTOR_OBJETIVO_SIN_MAXIMO === 2 && objetivoDeReposicion(10, null) === 20 && ev(4, 10).objetivo === 20)
check('>>> sugerida = objetivo − posición: mínimo 10, hay 4 → pedir 16', ev(4, 10).sugerida === 16)
check('>>> con máximo: el objetivo es el máximo (mínimo 10, máximo 50, hay 4 → pedir 46)', ev(4, 10, 50).objetivo === 50 && ev(4, 10, 50).sugerida === 46)
check('>>> un máximo por debajo del mínimo nunca baja el objetivo del mínimo', objetivoDeReposicion(10, 6) === 10 && ev(2, 10, 6).sugerida === 8)
check('>>> restar lo reservado y sumar lo que viene: mínimo 10, hay 12, 5 reservados, 2 en camino → posición 9, pedir 11', (() => { const r = ev(12, 10, null, { reservado: 5, enTransito: 2 }); return r.posicion === 9 && r.sugerida === 11 })())
check('>>> si no dispara, la sugerida es 0 (aunque falte para llegar al objetivo)', ev(15, 10).sugerida === 0)
check('>>> en 4 decimales exactos: mínimo 0.3, hay 0.1 → objetivo 0.6, pedir 0.5', (() => { const r = ev(0.1, 0.3); return r.objetivo === 0.6 && r.sugerida === 0.5 })())

console.log('\nF) Stock NEGATIVO (se vendió sin existencias)')
check('>>> estado agotado y dispara', (() => { const r = ev(-3, 10); return r.estado === 'OUT' && r.dispara })())
check('>>> repone el objetivo MÁS lo faltante: mínimo 10, hay −3 → pedir 20 + 3 = 23', ev(-3, 10).sugerida === 23)
check('>>> con máximo: objetivo 50, hay −3 → 53', ev(-3, 10, 50).sugerida === 53)
check('>>> lo que viene en camino compensa el negativo: −3 + 8 en tránsito = posición 5 → pedir 15', (() => { const r = ev(-3, 10, null, { enTransito: 8 }); return r.posicion === 5 && r.sugerida === 15 })())
check('>>> sin mínimo y negativo: dispara pero no hay objetivo que pedir (la sugerida repone solo el faltante: 3)', (() => { const r = ev(-3, 0); return r.dispara && r.objetivo === 0 && r.sugerida === 3 })())
check('>>> negativo con reservado: −3 con 2 reservados → disponible −5', ev(-3, 10, null, { reservado: 2 }).disponible === -5)

console.log('\nG) estadoDeFila (la vía del escáner y el POS) usa la misma herencia')
check('>>> hereda: sin fila de almacén y variante en 0, juzga con el mínimo del producto', (() => { const r = estadoDeFila({ cantidad: 8, varianteMin: 0, productoMin: 10 }); return r.minimo === 10 && r.estado === 'LOW' })())
check('>>> el override del almacén manda (mínimo 3: con 8 está OK)', estadoDeFila({ cantidad: 8, almacenMin: 3, productoMin: 10 }).estado === 'OK')
check('>>> descuenta lo reservado: 8 con 6 reservados, mínimo 3 → disponible 2 → crítico', (() => { const r = estadoDeFila({ cantidad: '8', reservado: '6', almacenMin: 3 }); return r.disponible === 2 && r.estado === 'LOW' })())
check('>>> sin fila de stock (cantidad vacía) es agotado', estadoDeFila({ cantidad: undefined, productoMin: 5 }).estado === 'OUT')
check('>>> devuelve el máximo resuelto', estadoDeFila({ cantidad: 1, almacenMax: 9, productoMax: 50 }).maximo === 9)

console.log('\nH) Permisos nuevos: un permiso = un poder')
const rol = (r: Parameters<typeof permisosDeRol>[0]) => permisosDeRol(r)
check('>>> existen, con etiqueta en español', (PERMISOS as readonly string[]).includes('reposicion.ver') && (PERMISOS as readonly string[]).includes('reposicion.configurar') && ETIQUETAS['reposicion.ver'].length > 10 && ETIQUETAS['reposicion.configurar'].length > 10)
check('>>> ver: almacenero, administrador, dueño y contador', rol('ALMACENERO').has('reposicion.ver') && rol('ADMIN').has('reposicion.ver') && rol('OWNER').has('reposicion.ver') && rol('CONTADOR').has('reposicion.ver'))
check('>>> ver NO es de cajero, vendedor ni del superadmin', !rol('CAJERO').has('reposicion.ver') && !rol('VENDEDOR').has('reposicion.ver') && !rol('SUPERADMIN').has('reposicion.ver'))
check('>>> configurar: dueño y administrador de fábrica', rol('OWNER').has('reposicion.configurar') && rol('ADMIN').has('reposicion.configurar'))
check('>>> configurar NO viene de fábrica ni para el almacenero ni para el contador', !rol('ALMACENERO').has('reposicion.configurar') && !rol('CONTADOR').has('reposicion.configurar'))
check('>>> el dueño puede activárselo al almacenero (opcional) y a nadie más', (OPCIONALES.ALMACENERO ?? []).includes('reposicion.configurar') && !Object.entries(OPCIONALES).some(([r, ps]) => r !== 'ALMACENERO' && (ps ?? []).includes('reposicion.configurar')))
check('>>> configurar queda FUERA del PIN; ver, dentro', PERMISOS_FUERA_DEL_PIN.includes('reposicion.configurar') && !PERMISOS_FUERA_DEL_PIN.includes('reposicion.ver'))
check('>>> ver no incluye costos: quien tiene reposicion.ver no recibe productos.ver_costo por eso (el almacenero no lo tiene)', !rol('ALMACENERO').has('productos.ver_costo') && rol('ALMACENERO').has('reposicion.ver'))
check('>>> la matriz no se quedó con permisos huérfanos', Object.values(MATRIZ).every((ps) => ps.every((p) => (PERMISOS as readonly string[]).includes(p))))

console.log('\nI) Una sola fuente de verdad: nadie compara el mínimo por su cuenta')
const SRC = join(process.cwd(), 'src')
const archivos = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f)
  if (p.includes('/generated')) return []
  return statSync(p).isDirectory() ? archivos(p) : /\.(ts|tsx)$/.test(f) ? [p] : []
})
const todos = archivos(SRC)
// `getStockStatus(` decide el semáforo: solo el motor (y la función que lo define) pueden llamarlo; el resto pide el estado al motor.
const llamanSemaforo = todos.filter((f) => /\bgetStockStatus\(/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(SRC.length + 1)).sort()
check('>>> solo el motor y la definición del semáforo llaman a getStockStatus', JSON.stringify(llamanSemaforo) === JSON.stringify(['features/inventory/reposicion-reglas.ts', 'lib/stock-status.ts']), llamanSemaforo.join(', '))
// Nadie hereda a mano `stock?.minStock ?? variante?.minStock ?? product.minStock` (un `d.minStock ?? 0` de la importación es un valor por defecto, no una herencia).
// La importación del catálogo usa `d.minStock ?? Number(antes.minStock)` para comparar el máximo con el mínimo que el producto YA tiene: es un respaldo de un archivo, no la herencia de umbrales.
const heredanAMano = todos.filter((f) => /minStock\s*\?\?[^\n]*minStock/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(SRC.length + 1)).filter((f) => f !== 'features/inventory/import-service.ts')
check('>>> nadie repite la herencia «minStock ?? …» a mano', heredanAMano.length === 0, heredanAMano.join(', '))
const alertas = readFileSync(join(SRC, 'features/dashboard/service.ts'), 'utf8')
const lee = (f: string) => readFileSync(join(SRC, f), 'utf8')
check('>>> el escáner, el POS y el movimiento piden el estado al motor (no lo calculan)',
  /estadoDeCodigo\(r\)/.test(lee('features/inventory/actions.ts')) && /estadoDeCodigo\(r\)/.test(lee('features/pos/actions.ts')) &&
  /estadoDeFila\(/.test(lee('features/pos/busqueda.ts')) && /estadoTrasMovimiento\(/.test(lee('features/inventory/actions.ts')))
check('>>> el panel y /inventario/alertas leen las posiciones del servicio central', /posicionesDeStock\(/.test(alertas) && !/groupBy/.test(alertas.slice(alertas.indexOf('export async function alertasDeStock'))))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
