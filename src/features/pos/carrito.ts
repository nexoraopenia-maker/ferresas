import { redondearCentimos as cent } from '@/lib/dinero'
import { redondear } from '@/lib/quantity'
import type { PosProduct } from './actions'
import { precioDeLinea, type DatosDePrecio, type PrecioDeLinea } from './precios-reglas'

export interface LineaCarrito {
  key: string
  producto: PosProduct
  quantity: number
  discount: number
  /** Descuento en % de la línea. El importe (`discount`) se recalcula si cambia la cantidad. */
  pct?: number
  /**
   * Línea escaneada como presentación (caja, bulto…). `quantity` sigue siendo la cantidad BASE (la que mueve el stock) y
   * `ingresada` lo que el cajero cuenta (3 cajas). El servidor recalcula ambas y el precio: esto es solo lo que se muestra.
   */
  presentacion?: { id: string; name: string; unitType: string; factor: number; precio: number; precioPropio: boolean }
  ingresada?: number
}

/**
 * Lo que el motor necesita para esta línea: lo que trajo la búsqueda con la lista elegida, o —en un pedido tomado, con sus precios congelados— solo el precio de la línea, sin tramos.
 */
export const datosDePrecioDe = (l: LineaCarrito): DatosDePrecio => l.producto.precios ?? { salePrice: l.producto.salePrice, baseTiers: [], entrada: null }

/**
 * Precio, importe bruto y fuente de una línea, con EL MISMO motor (`precioDeLinea`) que usa el servidor al cobrar: lista elegida y volumen según la cantidad BASE de la línea; una
 * presentación con precio propio lo conserva solo si manda la Base sin tramo. Lo que se muestra y lo que se cobra salen de la misma función.
 */
export const precioDe = (l: LineaCarrito): PrecioDeLinea => {
  const propio = l.presentacion?.precioPropio && l.ingresada != null
    ? { precio: l.presentacion.precio / l.presentacion.factor, bruto: cent(l.presentacion.precio * l.ingresada) }
    : null
  return precioDeLinea(datosDePrecioDe(l), l.quantity, propio)
}

/** Importe bruto de una línea, igual que el servidor. */
export const brutoDe = (l: LineaCarrito) => precioDe(l).bruto

/** Cambian los datos de precio de una línea (otra lista): el descuento en % se recalcula sobre el importe nuevo y uno fijo nunca pasa del importe. */
export const conPrecios = (l: LineaCarrito, precios: DatosDePrecio | undefined): LineaCarrito => {
  if (!precios) return l
  const nueva: LineaCarrito = { ...l, producto: { ...l.producto, precios } }
  return { ...nueva, discount: l.pct !== undefined ? descuentoDe(nueva) : Math.min(l.discount, brutoDe(nueva)) }
}

/** Importe del descuento de una línea (ya con su cantidad nueva): mismo redondeo que el servidor. */
export const descuentoDe = (l: LineaCarrito) => cent(brutoDe(l) * ((l.pct ?? 0) / 100))

/** Mismo producto y misma presentación (o ambos sueltos): se suman en una sola línea. */
export const mismaLinea = (l: LineaCarrito, p: PosProduct) =>
  l.producto.productId === p.productId && (l.presentacion?.id ?? null) === (p.presentation?.id ?? null)

/** Cuenta de la línea en la unidad que ve el cajero (cajas si es presentación, base si no). */
export const contadaDe = (l: LineaCarrito) => l.ingresada ?? l.quantity
export const unidadDe = (l: LineaCarrito) => l.presentacion?.unitType ?? l.producto.unitType

/** Fija lo contado y deriva la cantidad base (y el descuento, que depende del importe). */
export const conContada = (l: LineaCarrito, contada: number): LineaCarrito => {
  const c = redondear(contada)
  const nueva = l.presentacion ? { ...l, ingresada: c, quantity: redondear(c * l.presentacion.factor) } : { ...l, quantity: c }
  return { ...nueva, discount: descuentoDe(nueva) }
}

/** Lo que `registerSale` espera por línea. */
export const itemDe = (l: LineaCarrito) => ({
  productId: l.producto.productId,
  variantId: l.producto.variantId,
  quantity: l.quantity,
  discount: l.discount,
  ...(l.presentacion ? { presentationId: l.presentacion.id, enteredQuantity: String(l.ingresada) } : {}),
})

/**
 * Lo que se le dice al cajero de dónde salió el precio de una línea: el nombre de la lista si el precio es de la lista, «Volumen desde N» si se aplicó un tramo, nada si es el precio normal.
 * `nombreLista` es la lista elegida del carrito (solo se nombra si el precio realmente salió de ella).
 */
export const etiquetaDePrecio = (l: LineaCarrito, nombreLista: string | null): string | null => {
  const p = precioDe(l)
  if (p.fuente === 'VOLUMEN') return `Volumen desde ${p.tramo}`
  if (p.fuente === 'LISTA') return nombreLista ? `Lista ${nombreLista}` : 'Precio de lista'
  return null
}
