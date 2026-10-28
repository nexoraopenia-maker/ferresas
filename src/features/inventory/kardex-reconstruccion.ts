import { costoTrasCompra, costoTrasDevolucion } from '../compras/costo'

/**
 * Reconstrucción del costo de los movimientos de stock ANTERIORES al kardex valorizado (F6.4a). PURA: sin base de datos, para poder probarla a fondo.
 *
 * Repite la historia de UN producto en orden cronológico con la misma fórmula que usan las compras (costo promedio ponderado móvil, sin IGV) y deja,
 * para cada movimiento que aún no tiene costo, el costo con el que se valoró y el promedio vigente justo después. Dice de dónde sale cada dato:
 *
 *  · EXACTO       una venta guarda el costo del producto en ese instante (`SaleItem.unitCost`): es el promedio REAL de ese momento. Además, ancla la
 *                 repetición: cualquier deriva por costos editados a mano se corrige ahí.
 *  · RECONSTRUIDO calculado repitiendo compras y anulaciones desde el último dato firme. Es una estimación honesta, no una certeza.
 *  · SIN_DATO     todavía no hay con qué valorar (el producto no tuvo costo): no se inventan cifras.
 *
 * Los movimientos que YA traen costo (`EXACTO`, escritos por el sistema desde F6.4a) no se reescriben, pero SÍ fijan el promedio con el que continúa la historia.
 */

export type OrigenCosto = 'EXACTO' | 'RECONSTRUIDO' | 'SIN_DATO'

export interface MovimientoHistorico {
  id: string
  /** Fila de stock a la que pertenece su `balanceAfter` (almacén + variante). */
  filaStock: string
  type: string
  source: string
  /** Con signo: entradas positivas, salidas negativas. */
  quantity: number
  balanceAfter: number
  /** `unitCost` guardado en el movimiento (entradas con costo, devoluciones de cliente). */
  unitCost: number | null
  referenceType: string | null
  costPending: boolean
  /** Origen ya guardado: solo se reescriben los `SIN_DATO`. */
  origenGuardado: OrigenCosto
  /** Si ya trae costo guardado (origen distinto de SIN_DATO), el promedio con el que quedó. */
  costAfterGuardado: number | null
  /** Costo de la línea de venta (`SaleItem.unitCost`) cuando este movimiento es una venta con línea conocida. */
  costoVenta: number | null
  /** Costo por unidad de la línea de la compra anulada, cuando este movimiento es la anulación de una compra. */
  costoCompra: number | null
}

export interface CostoReconstruido {
  id: string
  unitCostApplied: number | null
  costAfter: number | null
  costOrigin: OrigenCosto
}

const redondear4 = (n: number): number => Math.round(n * 10_000) / 10_000
const esEntrada = (m: MovimientoHistorico): boolean => m.quantity > 0

/**
 * `movimientos`: TODOS los del producto (de todos los almacenes y variantes), en orden cronológico (`createdAt`, `id`).
 * Devuelve solo los que estaban `SIN_DATO` (los demás se respetan).
 */
export function reconstruirCostos(movimientos: readonly MovimientoHistorico[]): CostoReconstruido[] {
  const salida: CostoReconstruido[] = []
  const stockPorFila = new Map<string, number>()
  let costo = 0

  for (const m of movimientos) {
    // El stock total ANTES de este movimiento (todas las filas del producto): lo que pesa en el promedio. Una fila vista por primera vez arrancó en
    // `balanceAfter − quantity` (puede haber stock anterior al primer movimiento registrado).
    if (!stockPorFila.has(m.filaStock)) stockPorFila.set(m.filaStock, m.balanceAfter - m.quantity)
    const stockAntes = [...stockPorFila.values()].reduce((a, b) => a + b, 0)
    stockPorFila.set(m.filaStock, m.balanceAfter)

    // Lo que el sistema ya escribió con certeza no se toca: solo fija el promedio de aquí en adelante.
    if (m.origenGuardado !== 'SIN_DATO' && m.costAfterGuardado !== null) { costo = m.costAfterGuardado; continue }

    let unitCostApplied: number | null
    let exacto = false

    if (m.costoVenta !== null) {
      // Ancla: el costo REAL que tenía el producto cuando se vendió.
      costo = m.costoVenta
      unitCostApplied = m.costoVenta
      exacto = true
    } else if (esEntrada(m) && m.referenceType === 'COMPRA' && m.unitCost !== null) {
      unitCostApplied = m.unitCost
      costo = costoTrasCompra({ stock: stockAntes, costo, cantidad: m.quantity, valor: redondear4(m.quantity * m.unitCost) })
    } else if (m.type === 'DEVOLUCION_PROVEEDOR' && m.referenceType === 'COMPRA' && m.costoCompra !== null && m.quantity < 0) {
      unitCostApplied = m.costoCompra
      const nuevo = costoTrasDevolucion({ stock: stockAntes, costo, cantidad: -m.quantity, valor: redondear4(-m.quantity * m.costoCompra) })
      if (nuevo !== null) costo = nuevo
    } else if (esEntrada(m) && m.unitCost !== null) {
      // Stock inicial o entrada manual con costo, o devolución de cliente (al costo de la venta): su costo, sin mover el promedio. El stock inicial de un
      // producto que aún no tenía costo es el que se lo da.
      unitCostApplied = m.unitCost
      if (m.type === 'INICIAL' && costo === 0) costo = m.unitCost
    } else if (esEntrada(m) && (m.costPending || m.type === 'ENTRADA') && m.unitCost === null && m.referenceType !== 'COMPRA') {
      unitCostApplied = null   // entrada manual sin costo: no tiene con qué valorarse
    } else {
      unitCostApplied = costo
    }

    if (costo === 0 && !exacto) {
      // Sin ningún costo conocido todavía: no se inventan cifras.
      salida.push({ id: m.id, unitCostApplied: null, costAfter: null, costOrigin: 'SIN_DATO' })
      continue
    }
    salida.push({ id: m.id, unitCostApplied, costAfter: costo, costOrigin: exacto ? 'EXACTO' : 'RECONSTRUIDO' })
  }
  return salida
}
