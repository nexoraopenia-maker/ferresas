import Link from 'next/link'
import { fechaDiaCorta } from '@/lib/fecha-local'
import { ETIQUETAS_TRAMO, TRAMOS_ANTIGUEDAD } from '@/features/credito/reglas'
import type { InformeCobranza } from '../cobranza'

const money = (n: number) => `S/ ${n.toFixed(2)}`

/** Cada tramo con su énfasis: lo vigente es neutro y la mora sube de tono a medida que envejece. */
const TONO: Record<(typeof TRAMOS_ANTIGUEDAD)[number], string> = {
  vigente: 'text-ink', mora1a30: 'text-stock-low', mora31a60: 'text-stock-low', mora61a90: 'text-stock-out', mora91omas: 'font-bold text-stock-out',
}

/**
 * Cobranza: cuánto se debe y qué tan atrasado está, por cliente. «Vigente» (aún no vence) va aparte de la mora real (1-30, 31-60,
 * 61-90 y más de 90 días). Solo presenta lo que calculó `informeDeCobranza`; no recalcula nada.
 *
 * `enlazarFicha`: el nombre lleva a la ficha solo si quien mira puede verla (el contador ve la cobranza pero no los clientes).
 */
export function TablaCobranza({ informe, enlazarFicha }: { informe: InformeCobranza; enlazarFicha: boolean }) {
  const t = informe.totales
  const nombre = (f: InformeCobranza['filas'][number]) => enlazarFicha
    ? <Link href={`/clientes/${f.customerId}`} className="font-semibold text-ink hover:underline">{f.nombre}</Link>
    : <span className="font-semibold text-ink">{f.nombre}</span>

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Resumen" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tarjeta k="Por cobrar" v={money(t.total)} fuerte />
        <Tarjeta k="Vencido" v={money(t.vencido)} alerta={t.vencido > 0} />
        <Tarjeta k="Vigente" v={money(t.vigente)} />
        <Tarjeta k="Clientes morosos" v={`${informe.clientesMorosos} de ${informe.clientesConDeuda}`} />
      </section>

      {!informe.coherente && (
        <p role="alert" data-cobranza="incoherente" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
          La deuda guardada en los clientes ({money(informe.deudaEnClientes)}) no coincide con la suma de sus cuentas ({money(t.total)}). Avisa a soporte antes de confiar en estas cifras.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-muted">Al {fechaDiaCorta(informe.fecha)}. Los tramos son días de mora desde el vencimiento.</p>
        <a href="/api/clientes/cobranza" download data-enlace="cobranza-csv" className="inline-flex h-touch items-center rounded-xl border border-hairline px-4 font-semibold text-ink">Descargar CSV</a>
      </div>

      {informe.filas.length === 0 ? (
        <p data-cobranza="vacia" className="rounded-2xl border border-hairline bg-surface p-6 text-center text-sm text-ink-muted">Nadie te debe nada ahora mismo.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
          <table data-cobranza="tabla" className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-xs uppercase tracking-wide text-ink-muted">
                <th scope="col" className="px-3 py-2">Cliente</th>
                {TRAMOS_ANTIGUEDAD.map((x) => <th key={x} scope="col" className="px-3 py-2 text-right">{ETIQUETAS_TRAMO[x]}</th>)}
                <th scope="col" className="px-3 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {informe.filas.map((f) => (
                <tr key={f.customerId} data-cliente={f.customerId} className="border-b border-hairline last:border-0">
                  <td className="px-3 py-2">
                    {nombre(f)}
                    <p className="text-xs text-ink-muted">
                      {f.docNumber ? `${f.docType} ${f.docNumber}` : 'Sin documento'}{f.telefono ? ` · ${f.telefono}` : ''} · {f.cuentas} {f.cuentas === 1 ? 'cuenta' : 'cuentas'}{f.masAtrasada > 0 ? ` · ${f.masAtrasada} días de atraso` : ''}
                    </p>
                  </td>
                  {TRAMOS_ANTIGUEDAD.map((x) => (
                    <td key={x} className={`px-3 py-2 text-right tabular-nums ${f[x] > 0 ? TONO[x] : 'text-ink-muted'}`}>{f[x] > 0 ? money(f[x]) : '—'}</td>
                  ))}
                  <td className="px-3 py-2 text-right font-bold tabular-nums text-ink">{money(f.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr data-cobranza="total" className="border-t-2 border-hairline font-bold">
                <th scope="row" className="px-3 py-2 text-left">Total</th>
                {TRAMOS_ANTIGUEDAD.map((x) => <td key={x} className="px-3 py-2 text-right tabular-nums text-ink">{money(t[x])}</td>)}
                <td className="px-3 py-2 text-right tabular-nums text-ink">{money(t.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

function Tarjeta({ k, v, fuerte, alerta }: { k: string; v: string; fuerte?: boolean; alerta?: boolean }) {
  return (
    <div className={`rounded-2xl border px-3 py-2 ${alerta ? 'border-stock-low/40 bg-stock-low-soft' : 'border-hairline bg-surface'}`}>
      <p className="text-xs text-ink-muted">{k}</p>
      <p className={`tabular-nums ${fuerte ? 'text-xl font-extrabold' : 'text-lg font-bold'} ${alerta ? 'text-stock-low' : 'text-ink'}`}>{v}</p>
    </div>
  )
}
