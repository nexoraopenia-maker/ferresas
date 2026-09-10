/**
 * Semáforo de stock (§5.1). Función pura y testeable sin BD.
 *
 * El color NUNCA viaja solo: cada estado trae su etiqueta de texto, porque
 * un porcentaje nada despreciable de los usuarios de una ferretería no
 * distingue rojo de verde.
 */
export type StockStatus = 'OK' | 'LOW' | 'OUT'

export interface StockStatusView {
  status: StockStatus
  label: string
  /** Clases Tailwind del token semántico correspondiente. */
  className: string
  dotClassName: string
}

export function getStockStatus(
  quantity: number,
  minStock: number,
): StockStatus {
  if (quantity <= 0) return 'OUT'
  // `<=` y no `<`: estar justo en el mínimo YA es señal de reponer.
  if (quantity <= minStock) return 'LOW'
  return 'OK'
}

const VIEWS: Record<StockStatus, Omit<StockStatusView, 'status'>> = {
  OK: {
    label: 'Stock óptimo',
    className: 'bg-stock-ok-soft text-stock-ok border-stock-ok/30',
    dotClassName: 'bg-stock-ok',
  },
  LOW: {
    label: 'Stock crítico',
    className: 'bg-stock-low-soft text-stock-low border-stock-low/40',
    dotClassName: 'bg-stock-low',
  },
  OUT: {
    label: 'Sin stock',
    className: 'bg-stock-out-soft text-stock-out border-stock-out/40',
    dotClassName: 'bg-stock-out',
  },
}

export function getStockStatusView(
  quantity: number,
  minStock: number,
): StockStatusView {
  const status = getStockStatus(quantity, minStock)
  return { status, ...VIEWS[status] }
}
