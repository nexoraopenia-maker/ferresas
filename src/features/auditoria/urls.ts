import type { ParametrosAuditoria } from './schemas'

/** La dirección del registro con sus filtros. Solo se escribe lo que NO es el valor por defecto; `cursor` pide la página siguiente. */
export function enlaceAuditoria(p: Partial<ParametrosAuditoria>, cursor?: string | null): string {
  const q = new URLSearchParams()
  if (p.p && p.p !== 'SEMANA') q.set('p', p.p)
  if (p.p === 'RANGO') { if (p.desde) q.set('desde', p.desde); if (p.hasta) q.set('hasta', p.hasta) }
  if (p.categoria && p.categoria !== 'TODAS') q.set('categoria', p.categoria)
  if (p.actor) q.set('actor', p.actor)
  if (p.entidad) q.set('entidad', p.entidad)
  if (cursor) q.set('cursor', cursor)
  const s = q.toString()
  return s ? `/auditoria?${s}` : '/auditoria'
}
