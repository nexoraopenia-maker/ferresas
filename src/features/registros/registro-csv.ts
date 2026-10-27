import type { CeldaCsv } from '@/lib/csv-export'
import type { TablaCsv } from '@/features/reportes/ventas-csv'
import type { RegistroCompras, RegistroVentas } from './registro-calculo'

/** Los registros como cabecera + filas de CSV. PURO. Los importes salen CON SU SIGNO (la nota de crédito resta): una suma en Excel da el total. */
const m = (monto: number): CeldaCsv => ({ monto })
const ETIQUETA_TIPO: Record<string, string> = { FACTURA: 'Factura', BOLETA: 'Boleta', NOTA_CREDITO: 'Nota de crédito', NOTA_DEBITO: 'Nota de débito' }

export function csvRegistroVentas(r: RegistroVentas): TablaCsv {
  const t = r.totales
  return {
    cabecera: ['Fecha', 'Tipo', 'Número', 'Documento relacionado', 'Tipo de documento del cliente', 'N.º de documento del cliente', 'Cliente', 'Base imponible (S/)', 'IGV (S/)', 'Total (S/)', 'Moneda', 'Estado', 'Suma al total', 'Alertas'],
    filas: [
      ...r.filas.map((f) => [f.fecha, ETIQUETA_TIPO[f.tipo] ?? f.tipo, f.numero, f.relacionado ?? '', f.receptorTipo, f.receptorNumero ?? '', f.receptorNombre ?? '', m(f.signo * f.base), m(f.signo * f.igv), m(f.signo * f.total), f.moneda, f.estado, f.suma ? 'SÍ' : 'NO', f.alertas.join('; ')]),
      ['TOTAL (aceptados y observados)', '', `${t.documentos} documentos`, '', '', '', '', m(t.base), m(t.igv), m(t.total), '', '', '', ''],
      ...r.control.map((k) => [`CONTROL: ${k.estado} (no suma)`, '', `${k.documentos} documentos`, '', '', '', '', '', '', m(k.total), '', k.estado, 'NO', '']),
    ],
  }
}

export function csvRegistroCompras(r: RegistroCompras): TablaCsv {
  const t = r.totales
  return {
    cabecera: ['Fecha', 'Fecha provisional', 'Tipo de documento', 'Serie-Número', 'RUC del proveedor', 'Proveedor', 'Base (S/)', 'IGV (S/)', 'Total (S/)', 'Condición', 'Compra', 'Alertas'],
    filas: [
      ...r.filas.map((f) => [f.fecha, f.provisional ? 'SÍ' : 'NO', f.tipoEtiqueta, f.documento, f.proveedorRuc ?? '', f.proveedorNombre ?? '', m(f.signo * f.base), m(f.signo * f.igv), m(f.signo * f.total), f.condicion === 'CREDITO' ? 'Crédito' : 'Contado', f.compra, f.alertas.join('; ')]),
      ['TOTAL', '', `${t.documentos} documentos`, '', '', '', m(t.base), m(t.igv), m(t.total), '', '', ''],
      ['CONTROL: con fecha provisional', '', `${r.control.provisionales} compras`, '', '', '', '', '', m(r.control.importeProvisional), '', '', ''],
      ['CONTROL: proveedor sin RUC', '', `${r.control.proveedorSinRuc} compras`, '', '', '', '', '', '', '', '', ''],
      ['CONTROL: sin proveedor', '', `${r.control.sinProveedor} compras`, '', '', '', '', '', '', '', '', ''],
    ],
  }
}
