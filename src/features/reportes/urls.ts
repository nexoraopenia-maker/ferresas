import type { ParametrosCostos, ParametrosVentas, TipoReporteCostos, TipoReporteVentas } from './schemas'

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

/** Direcciones de margen, inventario y ABC. Igual que las de ventas: solo se escribe lo que NO es el valor por defecto. */
function consultaCostos(p: Partial<ParametrosCostos>, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra)
  if (p.p && p.p !== 'MES') q.set('p', p.p)
  if (p.p === 'RANGO') { if (p.desde) q.set('desde', p.desde); if (p.hasta) q.set('hasta', p.hasta) }
  if (p.base && p.base !== 'VENTAS') q.set('base', p.base)
  if (p.a !== undefined && p.a !== 80) q.set('a', String(p.a))
  if (p.b !== undefined && p.b !== 95) q.set('b', String(p.b))
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function enlaceRentabilidad(tab: TipoReporteCostos, p: Partial<ParametrosCostos>): string {
  return `/reportes/rentabilidad${consultaCostos(p, tab === 'margen' ? {} : { t: tab })}`
}

export function enlaceCsvRentabilidad(tipo: TipoReporteCostos, p: Partial<ParametrosCostos>): string {
  return `/api/reportes/rentabilidad/${tipo}${consultaCostos(p)}`
}
