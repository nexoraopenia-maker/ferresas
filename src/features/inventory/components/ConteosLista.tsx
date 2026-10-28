import { formatearFechaLocal } from '@/lib/fecha-local'
import type { InventoryCountStatus } from '@/generated/prisma/enums'
import type { FilaConteo } from '../conteo-lista'
import { ETIQUETA_ALCANCE, ETIQUETA_ESTADO, ETIQUETA_MODO, enlaceConteo } from '../conteo-ui'

/** El listado de tomas de inventario (F6.5c): las abiertas y las históricas, con su estado, avance, fechas y responsables. Presentacional. */

const ESTILO_ESTADO: Record<InventoryCountStatus, string> = {
  BORRADOR: 'bg-surface-sunken text-ink-muted',
  EN_CONTEO: 'bg-industrial-50 text-industrial-700',
  EN_REVISION: 'bg-stock-low-soft text-stock-low',
  APLICADO: 'bg-stock-ok-soft text-stock-ok',
  CANCELADO: 'bg-stock-out-soft text-stock-out',
}

export function InsigniaEstado({ estado }: { estado: InventoryCountStatus }) {
  return <span data-conteo-estado={estado} className={`inline-block rounded-full px-2.5 py-1 text-xs font-bold ${ESTILO_ESTADO[estado]}`}>{ETIQUETA_ESTADO[estado]}</span>
}

export function ConteosLista({ filas, zona }: { filas: FilaConteo[]; zona: string }) {
  if (filas.length === 0) {
    return <p data-conteos="vacio" className="rounded-xl bg-surface-sunken px-3 py-4 text-sm text-ink-muted">Todavía no hay tomas de inventario. Cuando crees una, aparecerá aquí.</p>
  }
  return (
    <div data-conteos="lista" className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
      <table className="w-full min-w-[44rem] text-sm">
        <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-ink-muted">
          <tr>
            <th className="px-3 py-2">Número</th>
            <th className="px-3 py-2">Almacén</th>
            <th className="px-3 py-2">Alcance</th>
            <th className="px-3 py-2">Estado</th>
            <th className="px-3 py-2 text-right">Avance</th>
            <th className="px-3 py-2">Fechas</th>
            <th className="px-3 py-2">Responsables</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {filas.map((f) => (
            <tr key={f.id} data-conteo={f.id} data-estado={f.status}>
              <td className="whitespace-nowrap px-3 py-2"><a href={enlaceConteo(f.id)} className="font-semibold text-industrial-700 underline dark:text-industrial-300">{f.number}</a></td>
              <td className="px-3 py-2">{f.warehouse.name}</td>
              <td className="px-3 py-2">{ETIQUETA_ALCANCE[f.scope]}<span className="block text-xs text-ink-muted">Conteo {ETIQUETA_MODO[f.mode].toLowerCase()}</span></td>
              <td className="px-3 py-2"><InsigniaEstado estado={f.status} /></td>
              <td className="whitespace-nowrap px-3 py-2 text-right">{f.lineas === 0 ? '—' : `${f.contadas} de ${f.lineas}`}</td>
              <td className="px-3 py-2 text-xs text-ink-muted">
                <span className="block">Creada {formatearFechaLocal(f.createdAt, zona)}</span>
                {f.closedAt && <span className="block">Cerrada {formatearFechaLocal(f.closedAt, zona)}</span>}
                {f.aplicadoEn && <span className="block">Aplicada {formatearFechaLocal(f.aplicadoEn, zona)}</span>}
                {f.canceladoEn && <span className="block">Cancelada {formatearFechaLocal(f.canceladoEn, zona)}</span>}
              </td>
              <td className="px-3 py-2 text-xs text-ink-muted">
                <span className="block">Creó {f.creadoPor}</span>
                {f.cerradoPor && <span className="block">Cerró {f.cerradoPor}</span>}
                {f.aplicadoPor && <span className="block">Aplicó {f.aplicadoPor}</span>}
                {f.canceladoPor && <span className="block">Canceló {f.canceladoPor}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
