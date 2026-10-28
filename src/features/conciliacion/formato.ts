import { ETIQUETA_MODO } from '@/features/invoicing/modo-fiscal'
import { ETIQUETA_PUENTE, type InformeConciliacion } from './conciliacion-calculo'

const money = (n: number) => `${n < 0 ? '-' : ''}S/ ${Math.abs(n).toFixed(2)}`

/** El informe como texto para la consola (script `auditar-fiscal`). Con `detalle`, todos los items de cada hallazgo; sin él, los tres primeros. */
export function formatearInformeFiscal(slug: string, texto: string, i: InformeConciliacion, detalle = false): string {
  const l: string[] = [`── ${slug} · ${texto} · modo ${ETIQUETA_MODO[i.modo]} ──`, `   ${i.mensaje}`]
  const p = i.puente
  l.push(`   Puente: ${p.ventasCompletadas.documentos} ventas (${money(p.ventasCompletadas.total)}) = ${p.notasDeVenta.documentos} notas de venta + ${p.conComprobante.documentos} con comprobante (${money(p.conComprobante.total)}); diferencia sin explicar ${money(p.diferencia)}`)
  for (const k of ['valido', 'pendiente', 'rechazado', 'anulado', 'ensayo', 'sinComprobante'] as const) {
    if (p.clasificacion[k].documentos > 0) l.push(`     · ${ETIQUETA_PUENTE[k]}: ${p.clasificacion[k].documentos} (${money(p.clasificacion[k].total)})`)
  }
  l.push(`   Cuadre: ventas ${money(i.cuadreVentas.diferencia)} · compras ${money(i.cuadreCompras.diferencia)}`)
  for (const h of i.hallazgos) {
    l.push(`   [${h.nivel}] ${h.titulo}${h.cantidad > 0 ? ` — ${h.cantidad}` : ''}${h.importe !== 0 ? ` (${money(h.importe)})` : ''}`)
    for (const it of h.items.slice(0, detalle ? h.items.length : 3)) l.push(`       ${it.referencia}: ${it.detalle}`)
    if (!detalle && h.items.length > 3) l.push(`       … y ${h.items.length - 3} más (usa --detalle)`)
  }
  return l.join('\n')
}
