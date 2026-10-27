import type { CeldaCsv } from '@/lib/csv-export'
import type { CobrosPorMedio, VentasPorMedio, VentasPorPeriodo, VentasPorVendedor } from './ventas-calculo'

/**
 * Las tablas de cada reporte de ventas como cabecera + filas de CSV. PURO. Los importes van como `{ monto }` (dos decimales, punto
 * decimal) y los textos —nombres de vendedores incluidos— pasan por la protección de fórmulas de `generarCsv`.
 */
export interface TablaCsv { cabecera: string[]; filas: CeldaCsv[][] }
const m = (monto: number): CeldaCsv => ({ monto })

export function csvVentasPorPeriodo(r: VentasPorPeriodo): TablaCsv {
  return {
    cabecera: ['Periodo', 'Ventas', 'Total (S/)', 'IGV (S/)', 'Descuentos (S/)', 'Ticket promedio (S/)'],
    filas: [
      ...r.filas.map((f) => [f.etiqueta, f.ventas, m(f.total), m(f.igv), m(f.descuentos), m(f.ticketPromedio)]),
      ['TOTAL', r.totales.ventas, m(r.totales.total), m(r.totales.igv), m(r.totales.descuentos), m(r.totales.ticketPromedio)],
    ],
  }
}

export function csvVentasPorVendedor(r: VentasPorVendedor): TablaCsv {
  return {
    cabecera: [r.atribucion === 'VENDEDOR' ? 'Vendedor' : 'Cobró en caja', 'Ventas', 'Total (S/)', 'Ticket promedio (S/)', 'Participación (%)'],
    filas: [
      ...r.filas.map((f) => [f.nombre, f.ventas, m(f.total), m(f.ticketPromedio), m(f.participacion)]),
      ['TOTAL', r.totales.ventas, m(r.totales.total), m(r.totales.ticketPromedio), m(r.filas.length > 0 ? 100 : 0)],
    ],
  }
}

export function csvVentasPorMedio(r: VentasPorMedio): TablaCsv {
  const filas: CeldaCsv[][] = [
    ...r.filas.map((f) => [f.etiqueta, f.ventas, m(f.monto), m(f.participacion)]),
    ['TOTAL DE LOS MEDIOS', '', m(r.totalMedios), m(r.filas.length > 0 ? 100 : 0)],
    ['TOTAL DE LAS VENTAS', '', m(r.totalVentas), ''],
  ]
  if (r.descuadradas.ventas > 0) filas.push([`DIFERENCIA (${r.descuadradas.ventas} venta(s) cuyos pagos no suman su total)`, r.descuadradas.ventas, m(r.descuadradas.diferencia), ''])
  return { cabecera: ['Medio de pago', 'Ventas', 'Monto (S/)', 'Participación (%)'], filas }
}

export function csvCobros(r: CobrosPorMedio): TablaCsv {
  return {
    cabecera: ['Medio de pago', 'Cobrado en ventas (S/)', 'Abonos de deuda (S/)', 'Total (S/)', 'Operaciones de venta', 'Operaciones de abono', 'Participación (%)'],
    filas: [
      ...r.filas.map((f) => [f.etiqueta, m(f.contado), m(f.abonos), m(f.total), f.operacionesContado, f.operacionesAbono, m(f.participacion)]),
      ['TOTAL', m(r.totales.contado), m(r.totales.abonos), m(r.totales.total), r.totales.operacionesContado, r.totales.operacionesAbono, m(r.filas.length > 0 ? 100 : 0)],
    ],
  }
}
