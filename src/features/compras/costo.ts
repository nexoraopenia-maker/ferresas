/**
 * Costo promedio ponderado móvil de un producto. PURO y EXACTO: todo en enteros (BigInt) con escala fija, sin un solo decimal de coma
 * flotante, y redondeo «mitad hacia arriba» al final. Sin dependencias: lo usan el servidor (al recibir) y el formulario de compra (los
 * totales que se ven antes de guardar), así lo que se ve es lo que se registra.
 *
 * ─── LA FÓRMULA ──────────────────────────────────────────────────────────
 *
 *   al RECIBIR una compra:   nuevo = (stock × costo + valorDeLaCompra) / (stock + cantidad)
 *   al ANULARLA (devolución): nuevo = (stock × costo − valorDeLaCompra) / (stock − cantidad)
 *
 * Es el tratamiento contable estándar: una devolución a proveedor saca del inventario las unidades valoradas AL COSTO DE LA FACTURA
 * (no al promedio de ese momento), y por eso la fórmula inversa usa el valor de la compra. Es el promedio del conjunto, sin importar el
 * orden en que llegaron las compras.
 *
 * ─── DECISIONES ──────────────────────────────────────────────────────────
 *
 *  · El COSTO es siempre SIN IGV (valor de compra): el IGV de las compras es crédito fiscal, no costo de la mercadería.
 *  · Un stock negativo o cero NO pesa en el promedio (no hay unidades que valorar): el costo pasa a ser el de la compra.
 *  · Un costo actual de 0 significa «todavía sin costo» (el producto nace con 0): tampoco pesa, o el promedio quedaría diluido por
 *    unidades que nadie valoró. El costo cargado a mano, si existe (> 0), SÍ pesa y no se pisa.
 *  · Si la devolución deja el stock en 0 (o la fórmula sale negativa por costos editados a mano) NO se toca el costo: `null`.
 */

const ESC_CANT = 4   // Stock.quantity: 4 decimales
const ESC_COSTO = 4  // Product.costPrice: 4 decimales
const ESC_VALOR = 2  // dinero: 2 decimales
const ESC_TASA = 4   // taxRate: 4 decimales

const DIEZ = (n: number): bigint => 10n ** BigInt(n)

/**
 * Un número decimal (texto o número) como entero escalado: «60.005» a escala 2 → 6001n. Redondea mitad hacia arriba (lejos del cero),
 * como `ROUND_HALF_UP`. Un número de JS se lee por su representación decimal más corta, no por sus bits.
 */
export function aEscala(v: string | number, escala: number): bigint {
  const texto = typeof v === 'number' ? numeroATexto(v) : v.trim()
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(texto)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new RangeError(`Número inválido: ${String(v)}`)
  const negativo = m[1] === '-'
  const entero = m[2] || '0', frac = m[3] ?? ''
  const cortada = (frac + '0'.repeat(escala + 1)).slice(0, escala + 1)
  let n = BigInt(entero + cortada.slice(0, escala))
  if (Number(cortada[escala]) >= 5) n += 1n
  return negativo ? -n : n
}

function numeroATexto(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`Número inválido: ${n}`)
  const t = String(n)
  if (!/e/i.test(t)) return t
  // Notación científica (1e-7, 1e21): se reescribe en decimal sin perder dígitos.
  const [mant, expTxt] = t.toLowerCase().split('e') as [string, string]
  const exp = Number(expTxt)
  const neg = mant.startsWith('-')
  const [i, f = ''] = mant.replace('-', '').split('.') as [string, string?]
  const digitos = i + f
  const punto = i.length + exp
  const r = punto <= 0 ? `0.${'0'.repeat(-punto)}${digitos}` : punto >= digitos.length ? digitos + '0'.repeat(punto - digitos.length) : `${digitos.slice(0, punto)}.${digitos.slice(punto)}`
  return (neg ? '-' : '') + r
}

const desescalar = (n: bigint, escala: number): number => Number(n) / Number(DIEZ(escala))
/** Cociente redondeado «mitad hacia arriba» (para numerador ≥ 0 y denominador > 0). */
const dividir = (num: bigint, den: bigint): bigint => (num * 2n + den) / (2n * den)
/** Lleva un entero de escala `de` a escala `a` (< de), redondeando mitad hacia arriba lejos del cero. */
const reescalar = (n: bigint, de: number, a: number): bigint => (n < 0n ? -dividir(-n, DIEZ(de - a)) : dividir(n, DIEZ(de - a)))

export interface EntradaCosto {
  /** Stock actual del producto sumando TODOS los almacenes y variantes (antes de este movimiento). */
  stock: string | number
  /** Costo actual (`Product.costPrice`). */
  costo: string | number
  /** Unidades de la compra, en unidad base. */
  cantidad: string | number
  /** Lo que se paga por esas unidades, SIN IGV (la suma de los totales de línea). */
  valor: string | number
}

/** Costo tras RECIBIR una compra. Siempre hay resultado. */
export function costoTrasCompra(e: EntradaCosto): number {
  const q = aEscala(e.cantidad, ESC_CANT)
  const v = aEscala(e.valor, ESC_VALOR)
  if (q <= 0n) throw new RangeError('La cantidad de la compra debe ser mayor que cero.')
  let s = aEscala(e.stock, ESC_CANT)
  const c = aEscala(e.costo, ESC_COSTO)
  if (s < 0n || c <= 0n) s = 0n   // lo que no tiene valor no pesa
  // resultado en escala de costo: (S·C + V·10^6) / (S + Q)   [S, Q en 1e4; C en 1e4; V en 1e2]
  return desescalar(dividir(s * c + v * 1_000_000n, s + q), ESC_COSTO)
}

/** Costo tras ANULAR (devolver) una compra, o `null` si no corresponde tocarlo (stock restante 0 o resultado negativo). */
export function costoTrasDevolucion(e: EntradaCosto): number | null {
  const q = aEscala(e.cantidad, ESC_CANT)
  const v = aEscala(e.valor, ESC_VALOR)
  const s = aEscala(e.stock, ESC_CANT)
  const c = aEscala(e.costo, ESC_COSTO)
  const restante = s - q
  if (restante <= 0n || c <= 0n) return null
  const num = s * c - v * 1_000_000n
  if (num < 0n) return null
  return desescalar(dividir(num, restante), ESC_COSTO)
}

/** Importe de una línea (sin IGV) = cantidad de compra × costo por unidad de compra, a 2 decimales. */
export function totalDeLinea(cantidadIngresada: string | number, costoPorUnidad: string | number): number {
  const t = aEscala(cantidadIngresada, ESC_CANT) * aEscala(costoPorUnidad, ESC_COSTO)   // escala 8
  return desescalar(reescalar(t, ESC_CANT + ESC_COSTO, ESC_VALOR), ESC_VALOR)
}

/** Costo por unidad BASE = total de la línea / unidades base, a 4 decimales (el total manda: lo que se paga es exacto). */
export function costoBase(total: string | number, cantidadBase: string | number): number {
  const q = aEscala(cantidadBase, ESC_CANT)
  if (q <= 0n) throw new RangeError('La cantidad base debe ser mayor que cero.')
  const t = aEscala(total, ESC_VALOR)
  if (t < 0n) throw new RangeError('El total no puede ser negativo.')
  // costo×10^4 = (t/10^2) / (q/10^4) × 10^4 = t × 10^6 / q
  return desescalar(dividir(t * DIEZ(ESC_COSTO + ESC_CANT - ESC_VALOR), q), ESC_COSTO)
}

/** IGV de una compra: se calcula sobre la BASE de cada tasa (no línea a línea), como en la factura del proveedor. */
export function igvDeCompra(lineas: readonly { total: number; tasa: number }[]): { subtotal: number; igv: number; total: number } {
  const porTasa = new Map<string, { tasa: bigint; base: bigint }>()
  let sub = 0n
  for (const l of lineas) {
    const base = aEscala(l.total, ESC_VALOR), tasa = aEscala(l.tasa, ESC_TASA)
    sub += base
    const k = tasa.toString()
    porTasa.set(k, { tasa, base: (porTasa.get(k)?.base ?? 0n) + base })
  }
  let igv = 0n
  for (const { tasa, base } of porTasa.values()) igv += reescalar(base * tasa, ESC_VALOR + ESC_TASA, ESC_VALOR)
  return { subtotal: desescalar(sub, ESC_VALOR), igv: desescalar(igv, ESC_VALOR), total: desescalar(sub + igv, ESC_VALOR) }
}
