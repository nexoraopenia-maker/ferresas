import Link from 'next/link'
import { formatearFechaLocal } from '@/lib/fecha-local'
import type { FilaAuditoria } from '../service'
import type { ParametrosAuditoria } from '../schemas'
import { enlaceAuditoria } from '../urls'

function Detalle({ titulo, v }: { titulo: string; v: FilaAuditoria['antes'] }) {
  if (!v) return null
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{titulo}</p>
      <pre data-auditoria="json" className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-sunken p-2 text-xs text-ink">{v.texto}</pre>
      {v.truncado && <p className="text-xs text-ink-muted">Se recortó por tamaño.</p>}
    </div>
  )
}

export function ListaAuditoria({ filas, zona, params, siguiente }: { filas: FilaAuditoria[]; zona: string; params: ParametrosAuditoria; siguiente: string | null }) {
  if (filas.length === 0) {
    return <p data-reporte="vacio" className="rounded-2xl border border-hairline bg-surface p-6 text-center text-sm text-ink-muted">No hay registros con estos filtros.</p>
  }
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Registros de auditoría" className="flex flex-col gap-2">
        {filas.map((f) => (
          <li key={f.id} data-registro={f.id} className="rounded-2xl border border-hairline bg-surface">
            <details className="group">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-ink">{f.etiqueta}
                    {f.soporte && <span data-auditoria="soporte" className="ml-2 rounded-full bg-stock-low-soft px-2 py-0.5 text-xs font-bold text-stock-low">Soporte</span>}
                  </span>
                  <span className="block text-xs text-ink-muted">{f.actor}{f.rol ? ` · ${f.rol.toLowerCase()}` : ''}{f.entidad ? ` · ${f.entidad}` : ''}</span>
                </span>
                <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">{f.categoria}</span>
                <time dateTime={f.cuando} className="shrink-0 text-xs tabular-nums text-ink-muted">{formatearFechaLocal(f.cuando, zona)}</time>
              </summary>
              <div className="flex flex-col gap-3 border-t border-hairline px-3 py-3">
                <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                  <div><dt className="inline text-ink-muted">Acción: </dt><dd className="inline font-mono text-ink">{f.accion}</dd></div>
                  {f.ip && <div><dt className="inline text-ink-muted">Desde: </dt><dd className="inline text-ink">{f.ip}</dd></div>}
                  {f.motivo && <div className="sm:col-span-2"><dt className="inline text-ink-muted">Motivo: </dt><dd className="inline text-ink">{f.motivo}</dd></div>}
                </dl>
                {!f.antes && !f.despues && <p className="text-xs text-ink-muted">Este registro no guardó detalle.</p>}
                <div className="grid gap-3 sm:grid-cols-2"><Detalle titulo="Antes" v={f.antes} /><Detalle titulo="Después" v={f.despues} /></div>
              </div>
            </details>
          </li>
        ))}
      </ul>
      {siguiente && (
        <Link href={enlaceAuditoria(params, siguiente)} data-auditoria="mas" className="inline-flex h-touch items-center justify-center rounded-xl border border-hairline px-4 font-semibold text-ink">Ver más antiguos</Link>
      )}
    </div>
  )
}
