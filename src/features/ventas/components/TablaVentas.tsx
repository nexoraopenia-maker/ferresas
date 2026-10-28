import Link from 'next/link'
import { formatearFechaLocal } from '@/lib/fecha-local'
import { ETIQUETA_ESTADO_VENTA, type EstadoVenta, type ParametrosVentasLista } from '../schemas'
import type { FilaVenta, PaginaVentas } from '../service'
import { enlaceVenta, enlaceVentas } from '../urls'

const money = (n: number) => `S/ ${n.toFixed(2)}`
const th = 'px-3 py-2 text-right'
export const ESTILO_ESTADO_VENTA: Record<EstadoVenta | 'BORRADOR', string> = {
  COMPLETADA: 'bg-stock-ok-soft text-stock-ok', ANULADA: 'bg-stock-out-soft text-stock-out', DEVUELTA: 'bg-stock-low-soft text-stock-low', BORRADOR: 'bg-surface-sunken text-ink-muted',
}

function Estado({ e, parcial }: { e: EstadoVenta; parcial?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span data-estado={e} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ESTILO_ESTADO_VENTA[e]}`}>{ETIQUETA_ESTADO_VENTA[e]}</span>
      {parcial && <span data-estado="PARCIAL" className="rounded-full bg-stock-low-soft px-2 py-0.5 text-xs font-semibold text-stock-low">Devolución parcial</span>}
    </span>
  )
}

/** El historial de ventas. Sin costos, utilidad ni margen: solo lo que vio el cliente. */
export function TablaVentas({ pagina, params }: { pagina: PaginaVentas; params: ParametrosVentasLista }) {
  if (pagina.filas.length === 0) {
    return <p data-ventas="vacio" className="rounded-2xl border border-hairline bg-surface p-6 text-center text-sm text-ink-muted">No hay ventas con estos filtros.</p>
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
        <table data-ventas="tabla" className="w-full min-w-[46rem] text-sm">
          <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted">
            <th scope="col" className="px-3 py-2 text-left">Venta</th><th scope="col" className="px-3 py-2 text-left">Cuándo</th><th scope="col" className="px-3 py-2 text-left">Cliente</th>
            <th scope="col" className="px-3 py-2 text-left">Comprobante</th><th scope="col" className={th}>Total</th><th scope="col" className="px-3 py-2 text-left">Estado</th>
          </tr></thead>
          <tbody>
            {pagina.filas.map((f: FilaVenta) => (
              <tr key={f.id} data-fila={f.id} className="border-b border-hairline last:border-0">
                <th scope="row" className="px-3 py-2 text-left font-semibold">
                  <Link href={enlaceVenta(f.id)} data-enlace="venta" className="text-industrial-600 underline">{f.numero}</Link>
                  <span className="block text-xs font-normal text-ink-muted">{f.sucursal} · {f.cobro}</span>
                </th>
                <td className="px-3 py-2 tabular-nums">{formatearFechaLocal(f.cuando, pagina.zona)}</td>
                <td className="px-3 py-2">{f.cliente ?? <span className="text-ink-muted">Sin cliente</span>}</td>
                <td className="px-3 py-2">{f.comprobante ? <>{f.comprobante.numero}{f.comprobante.esEnsayo && <span className="ml-1 rounded-full bg-surface-sunken px-1.5 text-xs text-ink-muted">ensayo</span>}</> : <span className="text-ink-muted">Nota de venta</span>}</td>
                <td className="px-3 py-2 text-right font-bold tabular-nums">{money(f.total)}</td>
                <td className="px-3 py-2"><Estado e={f.estado} parcial={f.conDevolucionParcial} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pagina.siguiente && <Link href={enlaceVentas(params, pagina.siguiente)} data-ventas="mas" className="inline-flex h-touch items-center justify-center rounded-xl border border-hairline px-4 font-semibold text-ink">Ver más antiguas</Link>}
    </div>
  )
}
