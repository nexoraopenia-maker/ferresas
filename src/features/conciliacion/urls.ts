import type { ParametrosRegistros } from '@/features/registros/schemas'

/** Solo se escribe lo que NO es el valor por defecto (este mes). */
function consulta(p: Partial<ParametrosRegistros>): string {
  const q = new URLSearchParams()
  if (p.p && p.p !== 'MES') q.set('p', p.p)
  if (p.p === 'RANGO') { if (p.desde) q.set('desde', p.desde); if (p.hasta) q.set('hasta', p.hasta) }
  const s = q.toString()
  return s ? `?${s}` : ''
}
export const enlaceCsvConciliacion = (p: Partial<ParametrosRegistros>) => `/api/reportes/conciliacion${consulta(p)}`
