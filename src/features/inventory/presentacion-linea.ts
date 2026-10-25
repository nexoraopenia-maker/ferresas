import type { UnitType } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { calcularLinea, ConversionInvalida, convertirCantidad, type CantidadConvertida, type LineaCalculada } from './conversion'

/**
 * Líneas de venta y movimientos con presentación: lo que el SERVIDOR calcula y verifica.
 *
 * El cliente manda `presentationId` y `enteredQuantity` (lo que tecleó) y, como siempre, la cantidad en unidad base. El
 * servidor NO la cree: la recalcula desde la presentación guardada y la compara. Si no coincide, rechaza. Así una pantalla
 * con un error (o un cliente manipulado) no puede mover stock ni cobrar distinto de lo que dice la presentación, y lo que se
 * escribe cumple el CHECK de la base `quantity = enteredQuantity × presentationFactor`.
 */

export interface PresentacionCargada {
  id: string
  productId: string
  name: string
  unitType: UnitType
  factor: string
  salePrice: string | null
}

export async function cargarPresentaciones(t: TenantPrismaClient, ids: readonly string[]): Promise<Map<string, PresentacionCargada>> {
  const unicos = [...new Set(ids)]
  if (unicos.length === 0) return new Map()
  const filas = await t.productPresentation.findMany({
    where: { id: { in: unicos }, isActive: true, deletedAt: null },
    select: { id: true, productId: true, name: true, unitType: true, factor: true, salePrice: true },
  })
  return new Map(filas.map((f) => [f.id, { id: f.id, productId: f.productId, name: f.name, unitType: f.unitType, factor: f.factor.toString(), salePrice: f.salePrice?.toString() ?? null }]))
}

const invalida = (m: string) => new BusinessError('INVALID_DOCUMENT', m)

/** Valida que la presentación exista, esté activa y sea de ESE producto (sin variante). */
function exigirPresentacion(p: PresentacionCargada | undefined, productId: string, variantId: string | null | undefined): PresentacionCargada {
  if (!p || p.productId !== productId) throw new BusinessError('TENANT_MISMATCH', 'La presentación no existe o no es de ese producto.')
  if (variantId) throw invalida('Las presentaciones se venden sobre el producto, no sobre una variante.')
  return p
}

function traducir(e: unknown): never {
  if (e instanceof ConversionInvalida) throw invalida(e.message)
  throw e
}

/** Compara lo que mandó el cliente (unidad base) con lo que el servidor calcula. Iguales o error. */
function exigirCoincidencia(base: string, enviada: number): void {
  if (Number(base) !== enviada) {
    throw invalida(`La cantidad (${enviada}) no coincide con la presentación: ${base} en la unidad base. Vuelve a ingresar la cantidad.`)
  }
}

export interface LineaPresentacion {
  presentacion: PresentacionCargada
  conversion: LineaCalculada | CantidadConvertida
  /** La presentación tiene precio propio (si no, manda precio base × cantidad base). */
  precioPropio: boolean
}

/** Para una línea de VENTA: valida, convierte y, si la presentación tiene precio propio, calcula su total. */
export function resolverLineaDeVenta(
  input: { productId: string; variantId?: string | null; presentationId: string; enteredQuantity: string | number; quantity: number },
  presentacion: PresentacionCargada | undefined,
  unidadBase: UnitType,
): LineaPresentacion {
  const p = exigirPresentacion(presentacion, input.productId, input.variantId)
  try {
    const c = { cantidadIngresada: input.enteredQuantity, factor: p.factor, unidadPresentacion: p.unitType, unidadBase }
    if (p.salePrice !== null) {
      const l = calcularLinea({ ...c, precioPresentacion: p.salePrice })
      exigirCoincidencia(l.cantidadBase, input.quantity)
      return { presentacion: p, conversion: l, precioPropio: true }
    }
    const q = convertirCantidad(c)
    exigirCoincidencia(q.cantidadBase, input.quantity)
    return { presentacion: p, conversion: q, precioPropio: false }
  } catch (e) { return traducir(e) }
}

/** Para un MOVIMIENTO de stock: valida y convierte (sin precios). */
export function resolverMovimiento(
  input: { productId: string; variantId?: string | null; presentationId: string; enteredQuantity: string | number; quantity: number },
  presentacion: PresentacionCargada | undefined,
  unidadBase: UnitType,
): { presentacion: PresentacionCargada; conversion: CantidadConvertida } {
  const p = exigirPresentacion(presentacion, input.productId, input.variantId)
  try {
    const q = convertirCantidad({ cantidadIngresada: input.enteredQuantity, factor: p.factor, unidadPresentacion: p.unitType, unidadBase })
    exigirCoincidencia(q.cantidadBase, input.quantity)
    return { presentacion: p, conversion: q }
  } catch (e) { return traducir(e) }
}

/** Los datos de trazabilidad que se escriben en SaleItem / StockMovement. */
export interface Traza {
  presentationId: string
  /** Positiva: el signo del movimiento lo pone quien escribe. */
  enteredQuantity: string
  factor: string
  name: string
}

export const trazaDe = (p: PresentacionCargada, c: CantidadConvertida): Traza => ({ presentationId: p.id, enteredQuantity: c.cantidadIngresada, factor: c.factor, name: p.name })
