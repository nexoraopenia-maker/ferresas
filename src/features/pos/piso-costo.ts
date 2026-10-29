/**
 * El piso de margen en el SERVIDOR (F6.7b): ninguna línea se vende por debajo del costo promedio sin `ventas.bajo_costo`.
 *
 * Lo comparten la venta y la cotización (y por ellas el pedido y la conversión de una cotización: el piso se vuelve a comprobar con el costo de HOY aunque el precio esté congelado).
 * El flag `descuentosYaAutorizados` exime del tope de descuento del rol, NO de esto.
 *
 * SEGURIDAD: el cajero no ve costos. Por eso el mensaje de `BELOW_COST` solo nombra los productos: ni el costo, ni el margen, ni cuánto falta, ni el precio mínimo. Tampoco van en los
 * `details`. Quien SÍ tiene `ventas.bajo_costo` vende y la auditoría guarda producto y precio neto, nunca el costo.
 */
import { BusinessError } from '@/lib/errors'
import { puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import { pisoDeCosto } from './precios-reglas'

export interface LineaParaPiso {
  nombre: string
  /** Importe neto de la línea CON IGV y ya con el descuento manual. */
  netoLinea: number
  tasaIgv: number
  /** Cantidad en unidades BASE. */
  cantidadBase: number
  /** Costo promedio por unidad base, SIN IGV (`Product.costPrice`). Solo se lee aquí, en el servidor. */
  costoUnitario: number
}

export interface LineaBajoCosto {
  producto: string
  /** El importe neto de la línea con IGV: lo que se cobra. Nunca el costo. */
  precioNeto: number
}

const MAX_NOMBRES_EN_MENSAJE = 3

/**
 * Comprueba todas las líneas. Si alguna queda bajo el costo y la persona no tiene `ventas.bajo_costo`, lanza `BELOW_COST`. Si lo tiene, devuelve las líneas bajo costo para que quien
 * llama las deje en la auditoría. Un producto sin costo conocido queda exento.
 */
export function exigirPisoDeCosto(ctx: TenantContext, lineas: readonly LineaParaPiso[]): LineaBajoCosto[] {
  const bajo = lineas.filter((l) => {
    const r = pisoDeCosto({ netoLinea: l.netoLinea, tasaIgv: l.tasaIgv, cantidadBase: l.cantidadBase, costoUnitario: l.costoUnitario })
    return !r.exento && !r.cumple
  })
  if (bajo.length === 0) return []
  if (!puede(ctx, 'ventas.bajo_costo')) {
    const nombres = [...new Set(bajo.map((l) => l.nombre))]
    const lista = nombres.slice(0, MAX_NOMBRES_EN_MENSAJE).map((n) => `«${n}»`).join(', ') + (nombres.length > MAX_NOMBRES_EN_MENSAJE ? ` y ${nombres.length - MAX_NOMBRES_EN_MENSAJE} más` : '')
    throw new BusinessError(
      'BELOW_COST',
      `${lista} ${nombres.length === 1 ? 'quedaría' : 'quedarían'} por debajo del costo. Sube el precio o quita el descuento; si hace falta venderlo así, pídeselo a un administrador.`,
      { producto: nombres[0]!, lineas: bajo.length },
    )
  }
  return bajo.map((l) => ({ producto: l.nombre, precioNeto: l.netoLinea }))
}
