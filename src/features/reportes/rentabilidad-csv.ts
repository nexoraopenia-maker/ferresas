import type { CeldaCsv } from '@/lib/csv-export'
import type { InventarioValorizado, Margenes, ResultadoAbc } from './rentabilidad-calculo'
import type { TablaCsv } from './ventas-csv'

/** Las tablas del margen, el inventario valorizado y el ABC como cabecera + filas de CSV. PURO. Un margen sin datos sale VACÍO, no como 0 ni 100. */
const m = (monto: number): CeldaCsv => ({ monto })

export function csvMargen(r: Margenes): TablaCsv {
  const t = r.totales
  return {
    cabecera: ['Producto', 'SKU', 'Unidad', 'Unidades', 'Venta sin IGV (S/)', 'Venta con costo (S/)', 'Venta sin costo (S/)', 'Costo (S/)', 'Utilidad (S/)', 'Margen (%)', 'Cobertura de costo (%)'],
    filas: [
      ...r.filas.map((f) => [f.nombre, f.sku, f.unidad, f.unidades, m(f.ventaSinIgv), m(f.ventaConCosto), m(f.ventaSinCosto), m(f.costo), m(f.utilidad), f.margen === null ? '' : m(f.margen), m(f.cobertura)]),
      ['TOTAL', '', '', '', m(t.ventaSinIgv), m(t.ventaConCosto), m(t.ventaSinCosto), m(t.costo), m(t.utilidad), t.margen === null ? '' : m(t.margen), m(t.cobertura)],
    ],
  }
}

export function csvInventario(r: InventarioValorizado): TablaCsv {
  const nota = (p: InventarioValorizado['productos'][number]) => [p.sinCosto ? 'SIN COSTO: no valorizado' : '', p.eliminado ? 'Producto dado de baja' : '', p.conSaldoNegativo ? 'Saldo negativo excluido' : ''].filter(Boolean).join('; ')
  return {
    cabecera: ['Producto', 'SKU', 'Unidad', 'Cantidad', 'Costo unitario (S/)', 'Valor (S/)', 'Observación'],
    filas: [
      ...r.productos.filter((p) => p.cantidad > 0 || p.conSaldoNegativo).map((p) => [p.nombre, p.sku, p.unidad, p.cantidad, p.sinCosto ? '' : m(p.costoUnitario), p.valor === null ? '' : m(p.valor), nota(p)]),
      ['TOTAL VALORIZADO', '', '', '', '', m(r.totales.valor), `${r.totales.productosValorizados} de ${r.totales.productosConStock} productos con stock`],
      ...(r.totales.productosSinCosto > 0 ? [['SIN COSTO (no valorizados)', '', '', r.totales.unidadesSinCosto, '', '', `${r.totales.productosSinCosto} producto(s)`] as CeldaCsv[]] : []),
    ],
  }
}

export function csvAbc(r: ResultadoAbc, base: 'VENTAS' | 'UTILIDAD'): TablaCsv {
  return {
    cabecera: ['Posición', 'Producto', 'SKU', base === 'VENTAS' ? 'Venta sin IGV (S/)' : 'Utilidad (S/)', 'Participación (%)', 'Acumulado (%)', 'Clase'],
    filas: [
      ...r.filas.map((f) => [f.posicion, f.nombre, f.sku, m(f.valor), m(f.participacion), m(f.acumulado), f.clase]),
      ['TOTAL', '', '', m(r.total), m(r.filas.length > 0 && r.total > 0 ? 100 : 0), '', ''],
    ],
  }
}
