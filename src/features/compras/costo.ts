import { Prisma } from '@/generated/prisma/client'

/**
 * Costo promedio ponderado móvil de un producto. PURO y EXACTO: todo en enteros (BigInt) con escala fija, sin un solo decimal de coma
 * flotante, y redondeo «mitad hacia arriba» al final.
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

const escalar = (v: string | number, escala: number): bigint =>
  BigInt(new Prisma.Decimal(v).mul(new Prisma.Decimal(10).pow(escala)).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0))
const desescalar = (n: bigint, escala: number): number => Number(new Prisma.Decimal(n.toString()).div(new Prisma.Decimal(10).pow(escala)).toString())
/** Cociente redondeado «mitad hacia arriba» (para numerador y denominador positivos). */
const dividir = (num: bigint, den: bigint): bigint => (num * 2n + den) / (2n * den)

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
  const q = escalar(e.cantidad, ESC_CANT)
  const v = escalar(e.valor, ESC_VALOR)
  if (q <= 0n) throw new RangeError('La cantidad de la compra debe ser mayor que cero.')
  let s = escalar(e.stock, ESC_CANT)
  const c = escalar(e.costo, ESC_COSTO)
  if (s < 0n || c <= 0n) s = 0n   // lo que no tiene valor no pesa
  // resultado en escala de costo: (S·C + V·10^6) / (S + Q)   [S, Q en 1e4; C en 1e4; V en 1e2]
  return desescalar(dividir(s * c + v * 1_000_000n, s + q), ESC_COSTO)
}

/** Costo tras ANULAR (devolver) una compra, o `null` si no corresponde tocarlo (stock restante 0 o resultado negativo). */
export function costoTrasDevolucion(e: EntradaCosto): number | null {
  const q = escalar(e.cantidad, ESC_CANT)
  const v = escalar(e.valor, ESC_VALOR)
  const s = escalar(e.stock, ESC_CANT)
  const c = escalar(e.costo, ESC_COSTO)
  const restante = s - q
  if (restante <= 0n || c <= 0n) return null
  const num = s * c - v * 1_000_000n
  if (num < 0n) return null
  return desescalar(dividir(num, restante), ESC_COSTO)
}

/** Importe de una línea (sin IGV) = cantidad de compra × costo por unidad de compra, a 2 decimales. */
export function totalDeLinea(cantidadIngresada: string | number, costoPorUnidad: string | number): number {
  const t = new Prisma.Decimal(cantidadIngresada).mul(new Prisma.Decimal(costoPorUnidad))
  return Number(t.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toString())
}

/** Costo por unidad BASE = total de la línea / unidades base, a 4 decimales (el total manda: lo que se paga es exacto). */
export function costoBase(total: string | number, cantidadBase: string | number): number {
  const q = new Prisma.Decimal(cantidadBase)
  if (q.lte(0)) throw new RangeError('La cantidad base debe ser mayor que cero.')
  return Number(new Prisma.Decimal(total).div(q).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toString())
}

/** IGV de una compra: se calcula sobre la BASE de cada tasa (no línea a línea), como en la factura del proveedor. */
export function igvDeCompra(lineas: readonly { total: number; tasa: number }[]): { subtotal: number; igv: number; total: number } {
  const porTasa = new Map<number, Prisma.Decimal>()
  let sub = new Prisma.Decimal(0)
  for (const l of lineas) {
    sub = sub.plus(l.total)
    porTasa.set(l.tasa, (porTasa.get(l.tasa) ?? new Prisma.Decimal(0)).plus(l.total))
  }
  let igv = new Prisma.Decimal(0)
  for (const [tasa, base] of porTasa) igv = igv.plus(base.mul(tasa).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP))
  const subtotal = Number(sub.toDecimalPlaces(2).toString()), impuesto = Number(igv.toString())
  return { subtotal, igv: impuesto, total: Number(new Prisma.Decimal(subtotal).plus(impuesto).toDecimalPlaces(2).toString()) }
}
