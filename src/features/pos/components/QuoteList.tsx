'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { convertQuote, type QuoteListRow } from '../actions'

const ESTADO: Record<string, { texto: string; cls: string }> = {
  BORRADOR: { texto: 'Pendiente', cls: 'bg-surface-sunken text-ink-muted' },
  ENVIADA: { texto: 'Enviada', cls: 'bg-industrial-100 text-industrial-800 dark:bg-industrial-950 dark:text-industrial-300' },
  ACEPTADA: { texto: 'Aceptada', cls: 'bg-stock-ok-soft text-stock-ok' },
  RECHAZADA: { texto: 'Rechazada', cls: 'bg-stock-out-soft text-stock-out' },
  VENCIDA: { texto: 'Vencida', cls: 'bg-stock-low-soft text-stock-low' },
  CONVERTIDA: { texto: 'Vendida', cls: 'bg-stock-ok-soft text-stock-ok' },
}

/**
 * Cotizaciones guardadas, para retomarlas.
 *
 * Convertir se hace desde aquí y no desde el POS a propósito: el carrito del
 * POS pertenece al cliente que está en el mostrador AHORA, y cargarle encima
 * una cotización de la semana pasada mezclaría las dos ventas.
 */
export function QuoteList({ quotes }: { quotes: QuoteListRow[] }) {
  const router = useRouter()
  const [cobrando, setCobrando] = useState<QuoteListRow | null>(null)
  const [metodo, setMetodo] = useState('EFECTIVO')
  const [forzar, setForzar] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const convertir = () => {
    if (!cobrando) return
    setError(null)
    startTransition(async () => {
      const res = await convertQuote({
        quoteId: cobrando.id,
        payments: [{ method: metodo as 'EFECTIVO', amount: Number(cobrando.total) }],
        documentType: 'NOTA_VENTA',
        allowNegativeStock: forzar,
      })

      if (!res.ok) {
        setError(res.message)
        if (res.code === 'INSUFFICIENT_STOCK' && !forzar) {
          setError(`${res.message} Marca «vender sin stock» si el producto está disponible.`)
        }
        return
      }

      setCobrando(null)
      setForzar(false)
      router.refresh()
    })
  }

  if (quotes.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-hairline px-4 py-10 text-center text-sm text-ink-muted">
        Todavía no hay cotizaciones. Se guardan desde el punto de venta con
        el botón «Cotizar».
      </p>
    )
  }

  return (
    <>
      <ul className="flex flex-col gap-2">
        {quotes.map((q) => {
          const e = ESTADO[q.vencida && q.status === 'BORRADOR' ? 'VENCIDA' : q.status]
            ?? { texto: q.status, cls: '' }
          return (
            <li
              key={q.id}
              className="rounded-xl border border-hairline bg-surface p-3 print:break-inside-avoid"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono font-bold text-ink">{q.number}</p>
                  <p className="text-sm text-ink">
                    {q.customerName ?? 'Sin cliente'}
                    {q.customerDoc && (
                      <span className="font-mono text-xs text-ink-muted"> · {q.customerDoc}</span>
                    )}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {q.lineas} línea{q.lineas === 1 ? '' : 's'} ·{' '}
                    {new Date(q.createdAt).toLocaleDateString('es-PE')}
                    {q.validUntil && (
                      <> · válida hasta {new Date(q.validUntil).toLocaleDateString('es-PE')}</>
                    )}
                  </p>
                  {q.saleNumber && (
                    <p className="text-xs font-semibold text-stock-ok">
                      Vendida como {q.saleNumber}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  <p className="text-lg font-bold text-ink">S/ {q.total}</p>
                  <span className={`rounded-full px-2 py-1 text-xs font-bold ${e.cls}`}>
                    {e.texto}
                  </span>
                </div>
              </div>

              {q.status !== 'CONVERTIDA' && (
                <div className="mt-3 flex flex-wrap gap-2 print:hidden">
                  <button
                    type="button"
                    onClick={() => { setCobrando(q); setError(null); setForzar(false) }}
                    disabled={q.vencida}
                    title={q.vencida ? 'Vencida: vuelve a cotizar con los precios de hoy' : undefined}
                    className="h-touch rounded-lg bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-40"
                  >
                    Convertir en venta
                  </button>
                  {/*
                    * Antes esto era `window.print()`, que imprimía la PÁGINA
                    * entera: el listado de todas las cotizaciones, con las
                    * tarjetas de contadores y el menú. Ahora abre la vista de
                    * 80 mm de ESTA cotización.
                    */}
                  <a
                    href={`/imprimir/cotizacion/${q.id}?auto=1`}
                    target="_blank"
                    rel="noopener"
                    className="h-touch inline-flex items-center rounded-lg border border-hairline px-4 text-sm font-semibold text-ink"
                  >
                    Imprimir
                  </a>
                  {q.vencida && (
                    <p className="w-full text-xs font-semibold text-stock-low">
                      Vencida. Los precios son de otro momento: vuelve a
                      cotizar en lugar de convertirla.
                    </p>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {/* Cobro de la cotización */}
      {cobrando && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4 print:hidden">
          <div className="absolute inset-0 bg-graphite-950/70" onClick={() => setCobrando(null)} aria-hidden />
          <div role="dialog" aria-modal="true" className="relative w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl">
            <h2 className="text-lg font-bold text-ink">Convertir en venta</h2>
            <p className="mt-1 font-mono text-sm text-ink-muted">{cobrando.number}</p>
            <p className="mt-3 text-2xl font-bold text-industrial-700 dark:text-industrial-400">
              S/ {cobrando.total}
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              Se cobran los precios de la cotización, no los de hoy.
            </p>

            <label className="mt-4 flex flex-col gap-1">
              <span className="text-sm font-medium text-ink-muted">Medio de pago</span>
              <select
                value={metodo}
                onChange={(ev) => setMetodo(ev.target.value)}
                className="h-touch-lg rounded-xl border border-hairline bg-surface px-3 text-base text-ink"
              >
                {['EFECTIVO', 'YAPE', 'PLIN', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'TRANSFERENCIA'].map((m) => (
                  <option key={m} value={m}>{m.replace('_', ' ').toLowerCase()}</option>
                ))}
              </select>
            </label>

            <label className="mt-3 flex items-start gap-2">
              <input
                type="checkbox"
                checked={forzar}
                onChange={(ev) => setForzar(ev.target.checked)}
                className="mt-0.5 size-5 accent-stock-low"
              />
              <span className="text-xs font-semibold text-ink">
                Vender sin stock suficiente
                <span className="mt-0.5 block font-normal text-ink-muted">
                  El inventario quedará en negativo y se registrará.
                </span>
              </span>
            </label>

            {error && (
              <p role="alert" className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setCobrando(null)}
                className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink">
                Cancelar
              </button>
              <button type="button" onClick={convertir} disabled={pending}
                className="h-touch-lg flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">
                {pending ? 'Cobrando…' : 'Cobrar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
