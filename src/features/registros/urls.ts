import type { ParametrosRegistros, TipoRegistro } from './schemas'

function consulta(p: Partial<ParametrosRegistros>, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra)
  if (p.p && p.p !== 'MES') q.set('p', p.p)
  if (p.p === 'RANGO') { if (p.desde) q.set('desde', p.desde); if (p.hasta) q.set('hasta', p.hasta) }
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** Solo se escribe lo que NO es el valor por defecto (ventas, este mes). */
export const enlaceRegistros = (tab: TipoRegistro, p: Partial<ParametrosRegistros>) => `/reportes/registros${consulta(p, tab === 'ventas' ? {} : { t: tab })}`
export const enlaceCsvRegistro = (tipo: TipoRegistro, p: Partial<ParametrosRegistros>) => `/api/reportes/registros/${tipo}${consulta(p)}`
