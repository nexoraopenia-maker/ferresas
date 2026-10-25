import type { UnitType } from '@/generated/prisma/enums'

/**
 * Matemática de presentaciones: de lo que teclea la persona (3 cajas) a lo que mueve el stock (36 unidades) y a lo que se cobra.
 *
 * ─── POR QUÉ DECIMALES EXACTOS ───────────────────────────────────────────
 * Con números de coma flotante, 0.1 + 0.2 ≠ 0.3 y 1.005 × 100 ≠ 100.5. En stock y dinero eso se traduce en unidades que
 * aparecen o desaparecen y en céntimos que descuadran el comprobante. Aquí cada valor es un entero grande (`bigint`) con su
 * escala: la multiplicación es exacta y el único redondeo que existe es el que se decide explícitamente (mitad hacia arriba,
 * la convención con la que se emiten comprobantes en Perú).
 *
 * Reglas (todas con su error propio, nunca un redondeo silencioso):
 *  · `cantidadBase = cantidadIngresada × factor` EXACTA. Si no cabe en 4 decimales (la escala del stock) se rechaza: perder
 *    una fracción de unidad en silencio es perder mercadería.
 *  · La cantidad ingresada respeta las fracciones de la unidad de la PRESENTACIÓN (enteros para piezas, hasta 3 decimales para
 *    kilos, metros y litros), y la cantidad base las de la unidad BASE del producto.
 *  · `totalLinea = precio de presentación × cantidad ingresada`, redondeado a céntimos UNA vez. Es la cifra que manda; el precio
 *    por unidad base es derivado y solo informativo.
 *
 * Todo es puro y determinista: la misma entrada da siempre la misma salida, y volver a calcular con sus propias salidas
 * normalizadas da el mismo resultado (idempotencia).
 */

// ─── Fracciones por tipo de unidad ──────────────────────────────────────────────────────────────

/** Decimales que admite una cantidad según su unidad. Las piezas, cajas y bolsas son enteras; lo que se mide, hasta 3. */
export const DECIMALES_POR_UNIDAD: Record<UnitType, number> = {
  UNIDAD: 0, KILOGRAMO: 3, GRAMO: 0, METRO: 3, CENTIMETRO: 0, LITRO: 3, GALON: 3,
  CAJA: 0, PAQUETE: 0, DOCENA: 0, MILLAR: 0, ROLLO: 0, PLANCHA: 0, BOLSA: 0, JUEGO: 0, PAR: 0, SERVICIO: 0,
}

export const decimalesPermitidos = (u: UnitType): number => DECIMALES_POR_UNIDAD[u]

/** Escalas de la base de datos. */
export const ESCALA_STOCK = 4
export const ESCALA_FACTOR = 6
export const ESCALA_PRECIO = 4
export const ESCALA_TOTAL = 2

// ─── Decimal exacto mínimo ─────────────────────────────────────────────────────────────────────────

export type CodigoConversion =
  | 'NUMERO' | 'FACTOR' | 'CANTIDAD' | 'PRECIO'
  | 'FRACCION_PRESENTACION' | 'FRACCION_BASE' | 'BASE_NO_REPRESENTABLE' | 'FUERA_DE_RANGO'

export class ConversionInvalida extends Error {
  constructor(readonly codigo: CodigoConversion, mensaje: string) {
    super(mensaje)
    this.name = 'ConversionInvalida'
  }
}

/** valor = n / 10^e, normalizado (sin ceros a la derecha del punto). */
interface Dec { n: bigint; e: number }

const POTENCIAS = new Map<number, bigint>()
const diez = (k: number): bigint => {
  let p = POTENCIAS.get(k)
  if (p === undefined) { p = 10n ** BigInt(k); POTENCIAS.set(k, p) }
  return p
}

function normalizar(n: bigint, e: number): Dec {
  while (e > 0 && n % 10n === 0n) { n /= 10n; e-- }
  return n === 0n ? { n: 0n, e: 0 } : { n, e }
}

const MAX_DECIMALES_ENTRADA = 10

/** Texto o número → decimal. Estricto: un número de coma flotante con "ruido" (0.30000000000000004) se rechaza. */
function dec(valor: string | number, que: CodigoConversion = 'NUMERO'): Dec {
  let t: string
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) throw new ConversionInvalida(que, 'El número no es finito.')
    t = String(valor)
  } else t = valor.trim()
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new ConversionInvalida(que, `«${t}» no es un número decimal válido.`)
  const [ent, frac = ''] = t.replace('-', '').split('.')
  if (frac.length > MAX_DECIMALES_ENTRADA) throw new ConversionInvalida(que, `«${t}» tiene demasiados decimales.`)
  const n = BigInt(ent! + frac)
  return normalizar(t.startsWith('-') ? -n : n, frac.length)
}

const mul = (a: Dec, b: Dec): Dec => normalizar(a.n * b.n, a.e + b.e)
const signo = (a: Dec): -1 | 0 | 1 => (a.n === 0n ? 0 : a.n < 0n ? -1 : 1)
const decimales = (a: Dec): number => a.e

/** Redondea a `d` decimales, mitad hacia arriba (lejos de cero). Exacto. */
function redondear(a: Dec, d: number): Dec {
  if (a.e <= d) return a
  const k = diez(a.e - d)
  const neg = a.n < 0n
  const abs = neg ? -a.n : a.n
  let q = abs / k
  if ((abs % k) * 2n >= k) q += 1n
  return normalizar(neg ? -q : q, d)
}

/** a / b con `d` decimales, mitad hacia arriba. `b` no puede ser cero. */
function dividir(a: Dec, b: Dec, d: number): Dec {
  // a/b = (a.n / 10^a.e) / (b.n / 10^b.e) = a.n × 10^b.e / (b.n × 10^a.e); se escala por 10^d para tener d decimales.
  let num = a.n * diez(b.e + d)
  let den = b.n * diez(a.e)
  const neg = (num < 0n) !== (den < 0n)
  if (num < 0n) num = -num
  if (den < 0n) den = -den
  let q = num / den
  if ((num % den) * 2n >= den) q += 1n
  return normalizar(neg ? -q : q, d)
}

function aTexto(a: Dec, minDecimales = 0): string {
  const neg = a.n < 0n
  const abs = (neg ? -a.n : a.n).toString().padStart(a.e + 1, '0')
  const ent = a.e === 0 ? abs : abs.slice(0, abs.length - a.e)
  let frac = a.e === 0 ? '' : abs.slice(abs.length - a.e)
  frac = frac.padEnd(minDecimales, '0')
  return `${neg ? '-' : ''}${ent}${frac ? `.${frac}` : ''}`
}

const menorQue = (a: Dec, limiteEntero: bigint): boolean => (a.n < 0n ? -a.n : a.n) < limiteEntero * diez(a.e)

// ─── Validaciones ──────────────────────────────────────────────────────────────────────────────────

/** Valida que `cantidad` sea positiva y respete las fracciones de la unidad. Devuelve el texto normalizado. */
export function validarCantidad(unidad: UnitType, cantidad: string | number): string {
  const c = dec(cantidad, 'CANTIDAD')
  if (signo(c) <= 0) throw new ConversionInvalida('CANTIDAD', 'La cantidad debe ser mayor que cero.')
  if (decimales(c) > decimalesPermitidos(unidad)) {
    throw new ConversionInvalida('FRACCION_PRESENTACION', decimalesPermitidos(unidad) === 0
      ? `Una cantidad en ${unidad} debe ser un número entero.`
      : `Una cantidad en ${unidad} admite hasta ${decimalesPermitidos(unidad)} decimales.`)
  }
  return aTexto(c)
}

// ─── Cálculo de una línea ──────────────────────────────────────────────────────────────────────────

export interface EntradaLinea {
  /** Precio de UNA presentación (S/ por caja). */
  precioPresentacion: string | number
  /** Lo que se tecleó, en unidades de la presentación (3 cajas, 1.5 kg). */
  cantidadIngresada: string | number
  /** Unidades base por presentación. */
  factor: string | number
  unidadPresentacion: UnitType
  unidadBase: UnitType
}

export interface LineaCalculada {
  cantidadIngresada: string
  factor: string
  precioPresentacion: string
  /** Lo que mueve el stock: exacta, a lo sumo 4 decimales. */
  cantidadBase: string
  /** precio ÷ factor, a 4 decimales: derivado e informativo (el total no sale de aquí). */
  precioBase: string
  /** precio de presentación × cantidad ingresada, a céntimos. Es la cifra que manda. */
  totalLinea: string
}

export function calcularLinea(e: EntradaLinea): LineaCalculada {
  const factor = dec(e.factor, 'FACTOR')
  if (signo(factor) <= 0) throw new ConversionInvalida('FACTOR', 'El factor debe ser mayor que cero.')
  if (decimales(factor) > ESCALA_FACTOR) throw new ConversionInvalida('FACTOR', `El factor admite hasta ${ESCALA_FACTOR} decimales.`)
  if (!menorQue(factor, 100_000_000n)) throw new ConversionInvalida('FUERA_DE_RANGO', 'El factor es demasiado grande.')

  const precio = dec(e.precioPresentacion, 'PRECIO')
  if (signo(precio) < 0) throw new ConversionInvalida('PRECIO', 'El precio no puede ser negativo.')
  if (decimales(precio) > ESCALA_PRECIO) throw new ConversionInvalida('PRECIO', `El precio admite hasta ${ESCALA_PRECIO} decimales.`)
  if (!menorQue(precio, 100_000_000n)) throw new ConversionInvalida('FUERA_DE_RANGO', 'El precio es demasiado grande.')

  const ingresada = dec(validarCantidad(e.unidadPresentacion, e.cantidadIngresada), 'CANTIDAD')

  const base = mul(ingresada, factor)
  if (decimales(base) > ESCALA_STOCK) {
    throw new ConversionInvalida('BASE_NO_REPRESENTABLE', `${aTexto(ingresada)} × ${aTexto(factor)} = ${aTexto(base)} no cabe en ${ESCALA_STOCK} decimales: se perdería una fracción de la mercadería.`)
  }
  if (decimales(base) > decimalesPermitidos(e.unidadBase)) {
    throw new ConversionInvalida('FRACCION_BASE', `Eso son ${aTexto(base)} en ${e.unidadBase}, que no admite esa fracción.`)
  }
  if (!menorQue(base, 10_000_000_000n)) throw new ConversionInvalida('FUERA_DE_RANGO', 'La cantidad es demasiado grande.')

  const total = redondear(mul(precio, ingresada), ESCALA_TOTAL)
  if (!menorQue(total, 1_000_000_000_000n)) throw new ConversionInvalida('FUERA_DE_RANGO', 'El total es demasiado grande.')

  return {
    cantidadIngresada: aTexto(ingresada),
    factor: aTexto(factor),
    precioPresentacion: aTexto(precio),
    cantidadBase: aTexto(base),
    precioBase: aTexto(dividir(precio, factor, ESCALA_PRECIO)),
    totalLinea: aTexto(total, ESCALA_TOTAL),
  }
}

// ─── De la unidad base a la presentación ───────────────────────────────────────────────────────────

/**
 * 30 unidades con factor 12 → «2 cajas y sobran 6 unidades». Para mostrar existencias en presentaciones. Exacto:
 * `completas × factor + resto === cantidadBase`.
 */
export function descomponer(cantidadBase: string | number, factor: string | number): { completas: string; resto: string } {
  const b = dec(cantidadBase, 'CANTIDAD'), f = dec(factor, 'FACTOR')
  if (signo(f) <= 0) throw new ConversionInvalida('FACTOR', 'El factor debe ser mayor que cero.')
  if (signo(b) < 0) throw new ConversionInvalida('CANTIDAD', 'La cantidad no puede ser negativa.')
  // Se llevan ambos a la misma escala entera para dividir sin pérdida.
  const e = Math.max(b.e, f.e)
  const bn = b.n * diez(e - b.e), fn = f.n * diez(e - f.e)
  const completas = bn / fn
  const resto = normalizar(bn - completas * fn, e)
  return { completas: completas.toString(), resto: aTexto(resto) }
}

/** La cantidad base expresada EXACTAMENTE en la presentación (6 unidades = 0.5 caja), o `null` si no es exacta o no es válida en esa unidad. */
export function aPresentacion(cantidadBase: string | number, factor: string | number, unidadPresentacion: UnitType): string | null {
  const b = dec(cantidadBase, 'CANTIDAD'), f = dec(factor, 'FACTOR')
  if (signo(f) <= 0 || signo(b) < 0) return null
  const q = dividir(b, f, decimalesPermitidos(unidadPresentacion))
  // Exacta solo si volver a multiplicar da la cantidad de origen.
  const vuelta = mul(q, f)
  return vuelta.n === b.n && vuelta.e === b.e ? aTexto(q) : null
}

/** Para entregar a los servicios que hoy trabajan con `number`: el texto ya validado, sin pérdida a 2-4 decimales. */
export const aNumero = (texto: string): number => Number(texto)
