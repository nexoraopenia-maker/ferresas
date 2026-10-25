import { readFileSync } from 'node:fs'
import { Prisma } from '../src/generated/prisma/client'
import {
  aPresentacion, calcularLinea, ConversionInvalida, DECIMALES_POR_UNIDAD, descomponer, validarCantidad,
  type CodigoConversion, type EntradaLinea,
} from '../src/features/inventory/conversion'

/** Matemática de presentaciones: exactitud, fracciones por unidad, redondeo explícito e idempotencia. Pura: sin base. */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const D = Prisma.Decimal
const error = (f: () => unknown): CodigoConversion | null => { try { f(); return null } catch (e) { return e instanceof ConversionInvalida ? e.codigo : (`otro:${String(e)}` as never) } }
const L = (o: Partial<EntradaLinea>): EntradaLinea => ({ precioPresentacion: '118', cantidadIngresada: '3', factor: '12', unidadPresentacion: 'CAJA', unidadBase: 'UNIDAD', ...o })

console.log('\n1) Casos de ferretería')
const caja = calcularLinea(L({}))
check('>>> 3 cajas × 12 = 36 unidades; total 3 × S/ 118 = S/ 354.00', caja.cantidadBase === '36' && caja.totalLinea === '354.00' && caja.cantidadIngresada === '3' && caja.factor === '12')
check('el precio por unidad base es derivado (118 ÷ 12 = 9.8333), el total NO sale de él', caja.precioBase === '9.8333' && caja.totalLinea === '354.00')
const saco = calcularLinea(L({ unidadPresentacion: 'BOLSA', unidadBase: 'KILOGRAMO', factor: '42.5', cantidadIngresada: '4', precioPresentacion: '31.5' }))
check('4 sacos de 42,5 kg = 170 kg; total S/ 126.00', saco.cantidadBase === '170' && saco.totalLinea === '126.00')
const medio = calcularLinea(L({ unidadPresentacion: 'KILOGRAMO', unidadBase: 'KILOGRAMO', factor: '1', cantidadIngresada: '1.5', precioPresentacion: '8.5' }))
check('>>> 1,5 kg se admite (hasta 3 decimales) y cuesta 1,5 × 8,50 = 12.75', medio.cantidadBase === '1.5' && medio.totalLinea === '12.75')
const metros = calcularLinea(L({ unidadPresentacion: 'METRO', unidadBase: 'METRO', factor: '1', cantidadIngresada: '2.375', precioPresentacion: '4.2' }))
check('2,375 m × S/ 4,20 = S/ 9.975 → 9.98 (mitad hacia arriba)', metros.cantidadBase === '2.375' && metros.totalLinea === '9.98')
const rollo = calcularLinea(L({ unidadPresentacion: 'ROLLO', unidadBase: 'METRO', factor: '100', cantidadIngresada: '2', precioPresentacion: '380' }))
check('2 rollos de 100 m = 200 m', rollo.cantidadBase === '200' && rollo.totalLinea === '760.00')
const gratis = calcularLinea(L({ precioPresentacion: '0' }))
check('una línea sin costo (muestra, bonificación) es válida: total 0.00', gratis.totalLinea === '0.00')

console.log('\n2) Redondeo: explícito, mitad hacia arriba, sin errores de coma flotante')
const total = (precio: string, cant: string, u: EntradaLinea['unidadPresentacion'] = 'UNIDAD') => calcularLinea(L({ precioPresentacion: precio, cantidadIngresada: cant, factor: '1', unidadPresentacion: u, unidadBase: u })).totalLinea
check('>>> 0.145 → 0.15 (en coma flotante da 0.14)', total('0.145', '1') === '0.15')
check('>>> 1.005 × 100 = 100.50 exacto (en coma flotante 100.49999…)', total('1.005', '100') === '100.50')
check('2.675 → 2.68; 33.3333 × 3 = 99.9999 → 100.00; 0.1 × 3 = 0.30', total('2.675', '1') === '2.68' && total('33.3333', '3') === '100.00' && total('0.1', '3') === '0.30')
check('un céntimo justo: 0.004 → 0.00; 0.005 → 0.01', total('0.004', '1') === '0.00' && total('0.005', '1') === '0.01')
check('importes grandes sin perder un céntimo: 99999999 × 999 = 99899999001.00', total('99999999', '999') === '99899999001.00')

console.log('\n3) Fracciones según la unidad')
check('>>> las piezas y los empaques son ENTEROS: 2.5 unidades, 1.5 cajas, 0.5 bolsas → FRACCION_PRESENTACION',
  ['UNIDAD', 'CAJA', 'BOLSA', 'ROLLO', 'PLANCHA', 'DOCENA', 'PAR', 'JUEGO'].every((u) => error(() => validarCantidad(u as never, '2.5')) === 'FRACCION_PRESENTACION'))
check('>>> kilos, metros, litros y galones admiten hasta 3 decimales; 4 no', ['KILOGRAMO', 'METRO', 'LITRO', 'GALON'].every((u) => validarCantidad(u as never, '1.125') === '1.125' && error(() => validarCantidad(u as never, '1.1255')) === 'FRACCION_PRESENTACION'))
check('la tabla de fracciones cubre todas las unidades', Object.keys(DECIMALES_POR_UNIDAD).length === 17)
check('>>> la cantidad BASE también respeta su unidad: media caja de 12 es 6 unidades (ok); 0.5 kg en base UNIDAD no', calcularLinea(L({ cantidadIngresada: '1', factor: '12' })).cantidadBase === '12' && error(() => calcularLinea(L({ unidadPresentacion: 'KILOGRAMO', cantidadIngresada: '0.5', factor: '1', unidadBase: 'UNIDAD' }))) === 'FRACCION_BASE')
check('>>> un producto a granel en gramos: 0.250 kg × 1000 = 250 g entero → válido', calcularLinea(L({ unidadPresentacion: 'KILOGRAMO', cantidadIngresada: '0.25', factor: '1000', unidadBase: 'GRAMO', precioPresentacion: '12' })).cantidadBase === '250')

console.log('\n4) Lo que se rechaza (nunca se redondea en silencio)')
const casos: Array<[string, Partial<EntradaLinea>, CodigoConversion]> = [
  ['factor cero', { factor: '0' }, 'FACTOR'], ['factor negativo', { factor: '-12' }, 'FACTOR'], ['factor con 7 decimales', { factor: '0.1234567' }, 'FACTOR'],
  ['cantidad cero', { cantidadIngresada: '0' }, 'CANTIDAD'], ['cantidad negativa', { cantidadIngresada: '-1' }, 'CANTIDAD'],
  ['precio negativo', { precioPresentacion: '-1' }, 'PRECIO'], ['precio con 5 decimales', { precioPresentacion: '1.00001' }, 'PRECIO'],
  ['texto', { cantidadIngresada: 'dos' }, 'CANTIDAD'], ['coma decimal', { precioPresentacion: '1,5' }, 'PRECIO'], ['vacío', { factor: '' }, 'FACTOR'],
  ['factor gigante', { factor: '999999999' }, 'FUERA_DE_RANGO'], ['cantidad base gigante', { cantidadIngresada: '99999999', factor: '99999' }, 'FUERA_DE_RANGO'],
]
for (const [nombre, o, codigo] of casos) check(`>>> ${nombre} → ${codigo}`, error(() => calcularLinea(L(o))) === codigo)
check('>>> una base que NO cabe en 4 decimales se rechaza (0.333 kg × 0.123456 = 0.041111…): se perdería mercadería',
  error(() => calcularLinea(L({ unidadPresentacion: 'KILOGRAMO', unidadBase: 'KILOGRAMO', cantidadIngresada: '0.333', factor: '0.123456' }))) === 'BASE_NO_REPRESENTABLE')
check('...pero la que sí cabe, sí: 0.5 kg × 0.2 = 0.1 kg', calcularLinea(L({ unidadPresentacion: 'KILOGRAMO', unidadBase: 'KILOGRAMO', cantidadIngresada: '0.5', factor: '0.2' })).cantidadBase === '0.1')
check('>>> un número de coma flotante con ruido (0.1 + 0.2) no entra: obliga a escribir el valor exacto', error(() => calcularLinea(L({ precioPresentacion: 0.1 + 0.2 }))) === 'PRECIO')
check('números limpios (118, 0.5) y NaN/Infinity/notación científica', calcularLinea(L({ precioPresentacion: 118, cantidadIngresada: 3 })).totalLinea === '354.00' && error(() => calcularLinea(L({ precioPresentacion: NaN }))) === 'PRECIO' && error(() => calcularLinea(L({ precioPresentacion: Infinity }))) === 'PRECIO' && error(() => calcularLinea(L({ precioPresentacion: 1e21 }))) === 'PRECIO')

console.log('\n5) De la base a la presentación')
const d = descomponer('30', '12')
check('>>> 30 unidades con factor 12 = 2 cajas y sobran 6', d.completas === '2' && d.resto === '6')
check('descomponer decimales: 170 kg con sacos de 42.5 = 4 sacos, resto 0; 100.1 con factor 42.5 = 2 y 15.1', descomponer('170', '42.5').completas === '4' && descomponer('170', '42.5').resto === '0' && descomponer('100.1', '42.5').resto === '15.1')
check('menos que una presentación: 5 con factor 12 = 0 cajas, resto 5', descomponer('5', '12').completas === '0' && descomponer('5', '12').resto === '5')
check('>>> aPresentacion solo si es EXACTA: 6 unidades = 0.5 de una caja (la caja es entera → null); 24 = 2', aPresentacion('6', '12', 'CAJA') === null && aPresentacion('24', '12', 'CAJA') === '2' && aPresentacion('6', '12', 'KILOGRAMO') === '0.5')
check('factor o cantidad inválidos', error(() => descomponer('5', '0')) === 'FACTOR' && error(() => descomponer('-1', '12')) === 'CANTIDAD' && aPresentacion('5', '0', 'CAJA') === null)

console.log('\n6) Propiedades contra decimal.js (4000 casos aleatorios, semilla fija)')
let semilla = 20261109
const azar = () => { semilla = (semilla + 0x6d2b79f5) | 0; let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const entero = (max: number) => Math.floor(azar() * max)
const numero = (maxEnteros: number, decimales: number) => { const dd = entero(decimales + 1); const ent = entero(maxEnteros); return dd === 0 ? String(ent) : `${ent}.${String(entero(10 ** dd)).padStart(dd, '0')}` }
const UNIDADES = Object.keys(DECIMALES_POR_UNIDAD) as Array<keyof typeof DECIMALES_POR_UNIDAD>
let n = 0, rechazadas = 0, divergencias = 0, noIdempotentes = 0, exceso = 0, descuadra = 0, ejemplo = ''
for (let i = 0; i < 4000; i++) {
  const e: EntradaLinea = {
    precioPresentacion: numero(5000, 4),
    // Sesgo hacia casos válidos (enteros y pocos decimales) para que ambos lados se ejerciten de verdad.
    cantidadIngresada: azar() < 0.6 ? String(1 + entero(300)) : numero(300, 4),
    factor: azar() < 0.6 ? String(1 + entero(300)) : numero(300, azar() < 0.5 ? 1 : 6),
    unidadPresentacion: azar() < 0.5 ? 'CAJA' : UNIDADES[entero(UNIDADES.length)]!,
    unidadBase: azar() < 0.5 ? 'UNIDAD' : UNIDADES[entero(UNIDADES.length)]!,
  }
  // Referencia con decimal.js: dice si la entrada es válida y qué debe salir.
  const q = new D(e.cantidadIngresada as string), f = new D(e.factor as string), p = new D(e.precioPresentacion as string)
  const base = q.times(f)
  const valida = f.gt(0) && q.gt(0) && q.decimalPlaces() <= DECIMALES_POR_UNIDAD[e.unidadPresentacion] && base.decimalPlaces() <= 4 && base.decimalPlaces() <= DECIMALES_POR_UNIDAD[e.unidadBase]
  let r: ReturnType<typeof calcularLinea> | null = null, cod: string | null = null
  try { r = calcularLinea(e) } catch (x) { cod = x instanceof ConversionInvalida ? x.codigo : `otro:${String(x)}` }
  n++
  if (!valida) { rechazadas++; if (r || (cod ?? '').startsWith('otro')) { divergencias++; ejemplo ||= `debía rechazar ${JSON.stringify(e)} y dio ${cod ?? 'ok'}` } continue }
  if (!r) { divergencias++; ejemplo ||= `debía aceptar ${JSON.stringify(e)} y dio ${cod}`; continue }
  const esperadoTotal = p.times(q).toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2)
  const esperadoPrecioBase = p.div(f).toDecimalPlaces(4, D.ROUND_HALF_UP)
  if (r.cantidadBase !== base.toString() || r.totalLinea !== esperadoTotal || !new D(r.precioBase).eq(esperadoPrecioBase)) { divergencias++; ejemplo ||= `distinto en ${JSON.stringify(e)}: ${JSON.stringify(r)} vs base ${base} total ${esperadoTotal}` }
  // Idempotencia: recalcular con las propias salidas normalizadas da lo mismo.
  const otra = calcularLinea({ ...e, precioPresentacion: r.precioPresentacion, cantidadIngresada: r.cantidadIngresada, factor: r.factor })
  if (JSON.stringify(otra) !== JSON.stringify(r)) noIdempotentes++
  // Nunca más decimales de los que caben.
  if (new D(r.cantidadBase).decimalPlaces() > 4 || r.totalLinea.split('.')[1]!.length !== 2) exceso++
  // Volver de la base a la presentación recupera lo ingresado o dice que no es exacto; y descomponer cuadra.
  const vuelta = aPresentacion(r.cantidadBase, r.factor, e.unidadPresentacion)
  if (vuelta !== null && !new D(vuelta).eq(q)) descuadra++
  const dc = descomponer(r.cantidadBase, r.factor)
  if (!new D(dc.completas).times(f).plus(dc.resto).eq(base) || new D(dc.resto).gte(f) || new D(dc.resto).lt(0)) descuadra++
}
check(`>>> acepta y rechaza EXACTAMENTE lo que decimal.js (${n - rechazadas} aceptadas, ${rechazadas} rechazadas)`, divergencias === 0, ejemplo)
check('>>> cantidad base, total (mitad hacia arriba) y precio base coinciden con decimal.js en todas', divergencias === 0)
check('>>> idempotente: recalcular con sus propias salidas da exactamente lo mismo', noIdempotentes === 0)
check('>>> nunca produce más de 4 decimales de stock ni un total que no sea de céntimos', exceso === 0)
check('>>> ida y vuelta: aPresentacion recupera lo ingresado cuando es exacta, y descomponer siempre cuadra', descuadra === 0)
check('(el generador cubrió ambos lados: hubo casos aceptados y rechazados)', n - rechazadas > 1000 && rechazadas > 300)

console.log('\n7) Es puro')
const fuente = readFileSync('src/features/inventory/conversion.ts', 'utf8')
const imports = [...fuente.matchAll(/^import .* from '(.*)'/gm)].map((m) => m[1])
check('>>> el módulo solo importa tipos del enum: sin base, sin red, sin reloj, sin azar', JSON.stringify(imports) === JSON.stringify(['@/generated/prisma/enums']) && !/Date\.now|new Date|Math\.random|process\.|fetch\(/.test(fuente))
check('>>> no usa aritmética de coma flotante para el dinero ni la cantidad (todo bigint)', !/Math\.(round|floor|ceil)|toFixed\(/.test(fuente) && fuente.includes('bigint'))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
