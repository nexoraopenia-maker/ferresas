/**
 * Las reglas PURAS de precio (F6.7): qué precio manda para una línea según la lista y la cantidad, cómo se validan los tramos y el piso de margen. Sin base de datos ni React: las
 * usan el servidor (que SIEMPRE recalcula), el carrito del POS y la pantalla de gestión, para que lo que se muestra y lo que se cobra salgan de la misma función.
 *
 *  · Fuente del precio. Si la lista elegida tiene una ENTRADA para el producto (un precio plano y/o tramos), manda esa entrada. Si no la tiene —o la lista elegida es la Base—, manda la
 *    Base completa: `Product.salePrice` y los tramos de la Base. Nunca se bloquea la venta por falta de precio. Una entrada con solo tramos usa de plano el `salePrice` base.
 *  · Volumen. La cantidad que se evalúa es la BASE de la MISMA línea (una caja de 50 vale 50). Manda el tramo de mayor `minQuantity` que no la supere, y su precio unitario fijo REEMPLAZA
 *    al plano. Los tramos de una lista nunca se mezclan con los de la Base.
 *  · Todo se compara en enteros de diezmilésimas: ni 0,1 + 0,2 ni un 11,9999999 que se cuele en el tramo de 12.
 *  · Los precios incluyen IGV, como `Product.salePrice`. Quien cobra extrae el IGV por línea (no se hace aquí).
 */

export type FuentePrecio = 'BASE' | 'LISTA' | 'VOLUMEN'

export const MAX_LISTAS_POR_NEGOCIO = 20
export const MAX_TRAMOS_POR_ENTRADA = 10

const DIEZMIL = 10_000
const aEntero = (n: number): bigint => BigInt(Math.round(n * DIEZMIL))
const r4 = (n: number): number => Math.round(n * DIEZMIL) / DIEZMIL
const cent = (n: number): number => Math.round(n * 100) / 100

export interface Tramo {
  /** Cantidad mínima en unidades BASE (> 0). */
  minQuantity: number
  /** Precio unitario por unidad base a partir de esa cantidad, con IGV. */
  unitPrice: number
}

export interface EntradaDeLista {
  /** Precio plano de la lista para el producto; `null` = solo tramos (el plano es el `salePrice` base). */
  price: number | null
  tiers: readonly Tramo[]
}

export interface DatosDePrecio {
  /** `Product.salePrice`: el precio Base. */
  salePrice: number
  /** Los tramos de la lista Base para el producto. */
  baseTiers: readonly Tramo[]
  /** La entrada de la lista elegida para el producto; `null` si no tiene (o si se eligió la Base): se usa la Base completa. */
  entrada: EntradaDeLista | null
}

export interface PrecioResuelto {
  /** Precio unitario por unidad base, con IGV. */
  precio: number
  fuente: FuentePrecio
  /** La `minQuantity` del tramo aplicado; `null` si no se aplicó ninguno. */
  tramo: number | null
  /** ¿El precio salió de una entrada de la lista elegida (precio plano o tramo de ella)? */
  deLista: boolean
}

/** El tramo que corresponde a una cantidad base: el de mayor `minQuantity` que no la supere. `null` si no alcanza ninguno. */
export function tramoParaCantidad(tramos: readonly Tramo[], cantidadBase: number): Tramo | null {
  const q = aEntero(cantidadBase)
  let mejor: Tramo | null = null
  for (const t of tramos) {
    if (aEntero(t.minQuantity) <= q && (mejor === null || aEntero(t.minQuantity) > aEntero(mejor.minQuantity))) mejor = t
  }
  return mejor
}

export function resolverPrecio(datos: DatosDePrecio, cantidadBase: number): PrecioResuelto {
  const e = datos.entrada
  const deLista = e !== null
  const plano = e && e.price !== null ? e.price : datos.salePrice
  const fuentePlana: FuentePrecio = e && e.price !== null ? 'LISTA' : 'BASE'
  const tramos = e ? e.tiers : datos.baseTiers
  const t = tramoParaCantidad(tramos, cantidadBase)
  if (t) return { precio: r4(t.unitPrice), fuente: 'VOLUMEN', tramo: r4(t.minQuantity), deLista }
  return { precio: r4(plano), fuente: fuentePlana, tramo: null, deLista }
}

/**
 * ¿Una presentación con precio propio conserva ese precio? Solo si manda la Base y no se aplicó ningún tramo (el comportamiento de siempre). Con una lista o un tramo, la línea
 * se cobra por unidad base × el factor de la presentación y el precio propio se ignora, porque describe el precio Base.
 */
export const conservaPrecioPropioDePresentacion = (r: PrecioResuelto): boolean => r.fuente === 'BASE'

/** Importe bruto de una línea sin precio propio de presentación: precio × cantidad base, a céntimos (igual que `registerSale`). */
export const brutoDeLinea = (precio: number, cantidadBase: number): number => cent(precio * cantidadBase)

export interface PrecioDeLinea {
  /** Precio unitario por unidad base que se guarda en la línea (con IGV). Con precio propio de presentación es el de UNA unidad base derivado de él. */
  precio: number
  /** Importe bruto de la línea, antes del descuento manual. */
  bruto: number
  fuente: FuentePrecio
  /** La `minQuantity` del tramo aplicado, o `null`. */
  tramo: number | null
}

/**
 * El precio y el importe bruto de UNA línea: lo que `registerSale`, `registerQuote` y el carrito calculan igual. `propio` es el precio de la presentación (ya convertido: precio por
 * unidad base y bruto = precio propio × lo ingresado, redondeado una vez) cuando la línea es una presentación con precio propio; solo se respeta si manda la Base sin tramo.
 */
export function precioDeLinea(datos: DatosDePrecio, cantidadBase: number, propio: { precio: number; bruto: number } | null = null): PrecioDeLinea {
  const r = resolverPrecio(datos, cantidadBase)
  if (propio && conservaPrecioPropioDePresentacion(r)) return { precio: propio.precio, bruto: propio.bruto, fuente: 'BASE', tramo: null }
  return { precio: r.precio, bruto: brutoDeLinea(r.precio, cantidadBase), fuente: r.fuente, tramo: r.tramo }
}

// ─── Validación de los tramos de una entrada ─────────────────────────────────────────────────────

const tieneMaxDecimales = (n: number, d: number): boolean => Math.abs(Math.round(n * 10 ** d) / 10 ** d - n) < 1e-9

/**
 * El primer problema de los tramos de UNA entrada, o `null` si están bien. `plano` es el precio plano efectivo de la entrada (el suyo o, si solo tiene tramos, el `salePrice` base);
 * ningún tramo puede costar más que él. Más cantidad nunca cuesta más por unidad: ordenados por `minQuantity`, el precio no puede subir.
 */
export function validarTramos(tramos: readonly Tramo[], plano: number | null): string | null {
  if (tramos.length > MAX_TRAMOS_POR_ENTRADA) return `Hasta ${MAX_TRAMOS_POR_ENTRADA} tramos por producto.`
  for (const t of tramos) {
    if (!Number.isFinite(t.minQuantity) || !(t.minQuantity > 0)) return 'La cantidad mínima de un tramo debe ser mayor que cero.'
    if (!tieneMaxDecimales(t.minQuantity, 4)) return 'La cantidad mínima admite hasta 4 decimales.'
    if (!Number.isFinite(t.unitPrice) || t.unitPrice < 0) return 'El precio de un tramo no puede ser negativo.'
    if (!tieneMaxDecimales(t.unitPrice, 4)) return 'El precio de un tramo admite hasta 4 decimales.'
  }
  const orden = [...tramos].sort((a, b) => (aEntero(a.minQuantity) < aEntero(b.minQuantity) ? -1 : aEntero(a.minQuantity) > aEntero(b.minQuantity) ? 1 : 0))
  for (let i = 0; i < orden.length; i++) {
    const t = orden[i]!
    if (i > 0 && aEntero(orden[i - 1]!.minQuantity) === aEntero(t.minQuantity)) return `Hay dos tramos desde la misma cantidad (${r4(t.minQuantity)}).`
    if (i > 0 && aEntero(t.unitPrice) > aEntero(orden[i - 1]!.unitPrice)) return `Más cantidad no puede costar más por unidad: el tramo desde ${r4(t.minQuantity)} sube el precio.`
    if (plano !== null && aEntero(t.unitPrice) > aEntero(plano)) return `El tramo desde ${r4(t.minQuantity)} cuesta más que el precio plano.`
  }
  return null
}

// ─── Piso de margen ──────────────────────────────────────────────────────────────────────────────

export interface EntradaPiso {
  /** Importe neto de la línea CON IGV y ya con el descuento manual (`lineTotal`). */
  netoLinea: number
  /** Tasa de IGV de la línea (0,18). */
  tasaIgv: number
  /** Cantidad en unidades BASE. */
  cantidadBase: number
  /** Costo promedio por unidad base, SIN IGV. */
  costoUnitario: number
}

export interface ResultadoPiso {
  /** Sin costo conocido (0 o inválido) no hay contra qué comparar: el piso no aplica. */
  exento: boolean
  cumple: boolean
}

/** Medio céntimo: el neto se redondea a céntimos, así que un precio EXACTAMENTE igual al costo no debe fallar por ese redondeo. */
export const TOLERANCIA_PISO = 0.005

/**
 * ¿La línea se vende a no menos del costo? Compara el neto SIN IGV de la línea con costo × cantidad. Un producto sin costo conocido (≤ 0) queda exento. Solo devuelve si cumple:
 * nunca el costo ni el margen, porque quien llama puede ser un cajero que no ve costos.
 */
export function pisoDeCosto(e: EntradaPiso): ResultadoPiso {
  if (!Number.isFinite(e.costoUnitario) || !(e.costoUnitario > 0)) return { exento: true, cumple: true }
  const sinIgv = e.netoLinea / (1 + e.tasaIgv)
  return { exento: false, cumple: sinIgv + TOLERANCIA_PISO >= e.costoUnitario * e.cantidadBase }
}
