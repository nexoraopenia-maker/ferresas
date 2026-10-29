import { formatearFechaLocal } from '@/lib/fecha-local'
import { ETIQUETA_METODO, METODOS_REPORTE, type DesgloseCierre } from '../cierre-desglose'
import type { ConsolidadoDelDia } from '../consolidado-caja'

const money = (n: number) => `S/ ${new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`

function PorMedio({ d }: { d: DesgloseCierre }) {
  const usados = METODOS_REPORTE.filter((m) => d.ventasPorMetodo[m].operaciones > 0)
  if (usados.length === 0) return <p className="text-sm text-ink-muted">Sin ventas con detalle por medio de pago.</p>
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4" data-consolidado="por-medio">
      {usados.map((m) => (
        <div key={m} className="rounded-lg bg-surface-sunken px-3 py-2">
          <dt className="text-ink-muted">{ETIQUETA_METODO[m]} ({d.ventasPorMetodo[m].operaciones})</dt>
          <dd className="font-bold text-ink">{money(d.ventasPorMetodo[m].monto)}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * El consolidado del día por sucursal (F6.8c): cada caja con su turno y, debajo, lo que sumaron todas. Sirve solo para leer; el permiso lo decide quien arma la página (`caja.consolidado`).
 * Un turno abierto lleva lo que va y NO enseña arqueo (el arqueo es a ciegas hasta que se cuenta). Sin costos.
 */
export function ConsolidadoCajaVista({ c }: { c: ConsolidadoDelDia }) {
  if (c.sucursales.length === 0) {
    return <p data-consolidado="vacio" className="rounded-xl border border-hairline bg-surface px-4 py-6 text-center text-sm text-ink-muted">No se abrió ningún turno de caja el {c.fecha}.</p>
  }
  return (
    <div className="flex flex-col gap-5" data-consolidado="vista">
      {c.sucursales.map((s) => (
        <section key={s.branchId} className="rounded-2xl border border-hairline bg-surface p-4 shadow-sm" data-consolidado="sucursal">
          <h2 className="text-lg font-bold text-ink">{s.sucursal}</h2>
          <p className="text-sm text-ink-muted">
            {s.cerrados} turno(s) cerrado(s){s.abiertos > 0 ? `, ${s.abiertos} abierto(s) todavía` : ''}. Vendido: <b>{money(s.total.ventas.total)}</b> en {s.total.ventas.cantidad} venta(s).
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase text-ink-muted"><th className="py-1 pr-3">Caja</th><th className="pr-3">Cajero(a)</th><th className="pr-3">Estado</th><th className="pr-3 text-right">Ventas</th><th className="pr-3 text-right">Esperado</th><th className="pr-3 text-right">Contado</th><th className="text-right">Diferencia</th></tr>
              </thead>
              <tbody>
                {s.turnos.map((t) => (
                  <tr key={t.id} className="border-t border-hairline" data-consolidado="turno">
                    <td className="py-1 pr-3">{t.caja}</td>
                    <td className="pr-3">{t.cajero}</td>
                    <td className="pr-3">{t.estado === 'ABIERTA' ? 'Abierto' : `Cerrado ${t.cerradoEn ? formatearFechaLocal(t.cerradoEn, c.zonaHoraria) : ''}`}</td>
                    <td className="pr-3 text-right">{t.ventas.cantidad} · {money(t.ventas.total)}</td>
                    <td className="pr-3 text-right">{t.esperado === null ? '—' : money(t.esperado)}</td>
                    <td className="pr-3 text-right">{t.contado === null ? '—' : money(t.contado)}</td>
                    <td className="text-right">{t.diferencia === null ? '—' : t.diferencia === 0 ? 'Cuadra' : money(t.diferencia)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-hairline font-bold"><td colSpan={4} className="py-1">Total de arqueos cerrados</td><td className="pr-3 text-right">{money(s.arqueo.esperado)}</td><td className="pr-3 text-right">{money(s.arqueo.contado)}</td><td className="text-right">{s.arqueo.diferencia === 0 ? 'Cuadra' : money(s.arqueo.diferencia)}</td></tr>
              </tfoot>
            </table>
          </div>
          <h3 className="mt-3 text-sm font-semibold text-ink">Ventas por medio de pago (todas las cajas)</h3>
          <PorMedio d={s.total} />
          {s.sinDesglose > 0 && <p className="mt-2 text-xs text-ink-muted">{s.sinDesglose} turno(s) se cerraron antes del detalle por medio de pago: figuran con sus totales, pero no entran en el detalle de arriba.</p>}
        </section>
      ))}
      {c.sucursales.length > 1 && (
        <section className="rounded-2xl border-2 border-industrial-600 bg-surface p-4" data-consolidado="general">
          <h2 className="text-lg font-bold text-ink">Todas las sucursales</h2>
          <p className="text-sm text-ink-muted">Vendido: <b>{money(c.general.total.ventas.total)}</b> en {c.general.total.ventas.cantidad} venta(s). Arqueo cerrado: esperado {money(c.general.arqueo.esperado)}, contado {money(c.general.arqueo.contado)}.</p>
          <PorMedio d={c.general.total} />
        </section>
      )}
    </div>
  )
}
