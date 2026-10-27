import type { ParametrosVentas, TipoReporteVentas } from './schemas'

/**
 * Direcciones de los reportes de ventas. PURO. Solo se escribe lo que NO es el valor por defecto, para que la dirección limpia sea la del
 * periodo por defecto y las demás se puedan compartir. El periodo, la agrupación y la atribución viajan juntos al cambiar de pestaña.
 */
function consulta(p: Partial<ParametrosVentas>, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra)
  if (p.p && p.p !== 'MES') q.set('p', p.p)
  if (p.p === 'RANGO') { if (p.desde) q.set('desde', p.desde); if (p.hasta) q.set('hasta', p.hasta) }
  if (p.agrupar && p.agrupar !== 'auto') q.set('agrupar', p.agrupar)
  if (p.atrib && p.atrib !== 'VENDEDOR') q.set('atrib', p.atrib)
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function enlaceVentas(tab: TipoReporteVentas, p: Partial<ParametrosVentas>): string {
  return `/reportes/ventas${consulta(p, tab === 'periodo' ? {} : { t: tab })}`
}

export function enlaceCsvVentas(tipo: TipoReporteVentas, p: Partial<ParametrosVentas>): string {
  return `/api/reportes/ventas/${tipo}${consulta(p)}`
}
