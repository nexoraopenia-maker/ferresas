import { listQuotes } from '@/features/pos/actions'
import { QuoteList } from '@/features/pos/components/QuoteList'

export const dynamic = 'force-dynamic'

export default async function CotizacionesPage() {
  const res = await listQuotes()
  const quotes = res.ok ? res.data : []

  const pendientes = quotes.filter((q) => q.status !== 'CONVERTIDA' && !q.vencida).length
  const vencidas = quotes.filter((q) => q.vencida && q.status !== 'CONVERTIDA').length
  const vendidas = quotes.filter((q) => q.status === 'CONVERTIDA').length

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-4">
      <header className="print:mb-4">
        <h1 className="text-2xl font-bold text-ink">Cotizaciones</h1>
        <p className="text-sm text-ink-muted print:hidden">
          Guardadas desde el punto de venta. Se convierten en venta con los
          precios cotizados, no con los de hoy.
        </p>
      </header>

      {!res.ok && (
        <p role="alert" className="rounded-xl bg-stock-out-soft px-4 py-3 text-sm font-semibold text-stock-out">
          {res.message}
        </p>
      )}

      <section className="grid grid-cols-3 gap-3 print:hidden">
        <Contador label="Pendientes" value={pendientes} tono="info" />
        <Contador label="Vencidas" value={vencidas} tono="warn" />
        <Contador label="Vendidas" value={vendidas} tono="ok" />
      </section>

      <QuoteList quotes={quotes} />
    </main>
  )
}

function Contador({
  label, value, tono,
}: { label: string; value: number; tono: 'ok' | 'info' | 'warn' }) {
  const acento =
    tono === 'ok' ? 'text-stock-ok'
    : tono === 'warn' ? 'text-stock-low'
    : 'text-industrial-600'
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${acento}`}>{value}</p>
    </div>
  )
}
