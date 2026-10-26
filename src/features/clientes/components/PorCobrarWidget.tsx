import Link from 'next/link'
import type { ResumenPorCobrar } from '../cobranza'

const money = (n: number) => `S/ ${n.toFixed(2)}`

/**
 * La tarjeta «Por cobrar» del panel: cuánto te deben, cuánto de eso ya venció y quiénes están más atrasados. Solo se muestra si hay
 * deuda (un negocio que no fía no ve una tarjeta de ceros). La cifra sale del mismo informe que la pantalla de cobranza.
 *
 * `enlazarFichas`: los nombres llevan a la ficha solo si quien mira puede verla.
 */
export function PorCobrarWidget({ resumen, enlazarFichas }: { resumen: ResumenPorCobrar; enlazarFichas: boolean }) {
  return (
    <section aria-label="Por cobrar" data-widget="por-cobrar" className="rounded-2xl border border-hairline bg-surface p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-bold text-ink">Por cobrar</h2>
        <Link href="/cobranza" className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">Ver cobranza →</Link>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-industrial-50 p-3 dark:bg-graphite-800">
          <p className="text-xs font-bold uppercase tracking-wide text-industrial-800 dark:text-industrial-200">Te deben</p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums text-industrial-800 dark:text-industrial-200">{money(resumen.total)}</p>
          <p className="text-xs font-semibold text-ink-muted">{resumen.clientesConDeuda} {resumen.clientesConDeuda === 1 ? 'cliente' : 'clientes'}</p>
        </div>
        <div data-por-cobrar="vencido" className={`rounded-xl p-3 ${resumen.vencido > 0 ? 'bg-stock-low-soft text-stock-low' : 'bg-stock-ok-soft text-stock-ok'}`}>
          <p className="text-xs font-bold uppercase tracking-wide">Vencido</p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums">{money(resumen.vencido)}</p>
          <p className="text-xs font-semibold">{resumen.vencido > 0 ? `${resumen.clientesMorosos} ${resumen.clientesMorosos === 1 ? 'moroso' : 'morosos'}` : 'Todo al día'}</p>
        </div>
      </div>
      {resumen.masUrgentes.length > 0 && (
        <ul data-por-cobrar="urgentes" className="mt-3 flex flex-col gap-1.5">
          {resumen.masUrgentes.map((u) => (
            <li key={u.customerId} className="flex items-center justify-between gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                {enlazarFichas ? <Link href={`/clientes/${u.customerId}`} className="font-semibold text-ink hover:underline">{u.nombre}</Link> : <span className="font-semibold text-ink">{u.nombre}</span>}
                <span className="text-ink-muted"> · {u.masAtrasada} días</span>
              </span>
              <span className="shrink-0 font-bold tabular-nums text-stock-low">{money(u.vencido)}</span>
            </li>
          ))}
        </ul>
      )}
      {!resumen.coherente && <p role="alert" data-por-cobrar="incoherente" className="mt-3 text-xs font-semibold text-stock-out">La deuda guardada no cuadra con las cuentas: revisa la cobranza.</p>}
    </section>
  )
}
