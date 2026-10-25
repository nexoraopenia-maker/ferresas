import { redondearCentimos as cent } from '@/lib/dinero'
import { redondear } from '@/lib/quantity'
import type { PosProduct } from './actions'

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
 * Importe bruto de una línea, igual que el servidor: con precio propio manda precio × lo ingresado (redondeado una vez);
 * si no, el precio base × la cantidad base.
 */
export const brutoDe = (l: LineaCarrito) =>
  l.presentacion?.precioPropio && l.ingresada != null
    ? cent(l.presentacion.precio * l.ingresada)
    : cent(l.producto.salePrice * l.quantity)

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
