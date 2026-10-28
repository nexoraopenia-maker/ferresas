import type { ParametrosVentasLista } from './schemas'

/** Dirección de una venta. */
export const enlaceVenta = (id: string) => `/ventas/${id}`

/** Dirección del historial con sus filtros: solo se escribe lo que NO es el valor por defecto (la última semana). `cursor` pide la página siguiente. */
export function enlaceVentas(p: Partial<ParametrosVentasLista>, cursor?: string | null): string {
  const q = new URLSearchParams()
  if (p.p && p.p !== 'SEMANA') q.set('p', p.p)
  if (p.p === 'RANGO') { if (p.desde) q.set('desde', p.desde); if (p.hasta) q.set('hasta', p.hasta) }
  if (p.sucursal) q.set('sucursal', p.sucursal)
  if (p.estado) q.set('estado', p.estado)
  if (p.comprobante) q.set('comprobante', p.comprobante)
  if (p.q) q.set('q', p.q)
  if (cursor) q.set('cursor', cursor)
  const s = q.toString()
  return s ? `/ventas?${s}` : '/ventas'
}
