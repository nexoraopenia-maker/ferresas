'use client'

import Link from 'next/link'
import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { cancelarPedido, soltarPedido, type PedidoColaRow } from '../actions'

const money = (n: number) => `S/ ${n.toFixed(2)}`
const hora = (iso: string) =>
  new Intl.DateTimeFormat('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Lima' }).format(new Date(iso))

/** Cola de pedidos. Se refresca sola cada 15 s: un pedido nuevo aparece sin recargar. */
export function ColaPedidos({
  pedidos, puedeCobrar, puedeOperar, puedeSoltarAjenos,
}: { pedidos: PedidoColaRow[]; puedeCobrar: boolean; puedeOperar: boolean; puedeSoltarAjenos: boolean }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    const id = setInterval(() => router.refresh(), 15_000)
    return () => clearInterval(id)
  }, [router])

  const ejecutar = (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setError(null)
    startTransition(async () => {
      const r = await fn()
      if (!r.ok) { setError(r.message ?? 'No se pudo completar.'); return }
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <p role="alert" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}

      {pedidos.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-hairline px-4 py-10 text-center text-sm text-ink-muted">
          No hay pedidos pendientes. Cuando un vendedor envíe uno a caja, aparece aquí.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {pedidos.map((p) => {
            const ocupado = !!p.cobrando && !p.mio
            return (
              <li key={p.id} className={`rounded-2xl border bg-surface p-4 shadow-sm ${p.mio ? 'border-industrial-600/60' : 'border-hairline'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-bold text-ink">{p.number}</p>
                    <p className="text-xs text-ink-muted">
                      {p.creadoPor} · {hora(p.creadoEn)} · {p.lineas} {p.lineas === 1 ? 'producto' : 'productos'}
                      {p.cliente && <> · {p.cliente}</>}
                    </p>
                  </div>
                  <p className="shrink-0 text-xl font-extrabold tabular-nums text-ink">{money(p.total)}</p>
                </div>

                {p.cobrando && (
                  <p className={`mt-2 rounded-lg px-2.5 py-1 text-xs font-bold ${p.mio ? 'bg-industrial-100 text-industrial-800 dark:bg-industrial-950 dark:text-industrial-300' : 'bg-stock-low-soft text-stock-low'}`}>
                    {p.mio ? 'Lo tienes tú' : `Lo está cobrando ${p.cobrando}`}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {puedeCobrar && puedeOperar && (
                    <Link
                      href={`/pos?pedido=${p.id}`}
                      aria-disabled={ocupado}
                      className={`h-touch inline-flex items-center rounded-xl px-4 text-sm font-bold ${
                        ocupado ? 'pointer-events-none bg-surface-sunken text-ink-muted' : 'bg-industrial-600 text-white hover:bg-industrial-700'
                      }`}
                    >
                      {p.mio ? 'Continuar cobro' : 'Tomar y cobrar'}
                    </Link>
                  )}
                  {puedeOperar && p.mio && (
                    <button type="button" disabled={pending} onClick={() => ejecutar(() => soltarPedido(p.id))} className="h-touch rounded-xl border border-hairline px-3 text-sm font-semibold text-ink">
                      Devolver a la cola
                    </button>
                  )}
                  {puedeOperar && ocupado && puedeSoltarAjenos && (
                    <button type="button" disabled={pending} onClick={() => ejecutar(() => soltarPedido(p.id))} className="h-touch rounded-xl border border-hairline px-3 text-sm font-semibold text-ink">
                      Liberar
                    </button>
                  )}
                  {puedeOperar && (p.esMio || puedeCobrar) && !ocupado && (
                    <button
                      type="button" disabled={pending}
                      onClick={() => { if (window.confirm(`¿Cancelar el pedido ${p.number}?`)) ejecutar(() => cancelarPedido(p.id)) }}
                      className="h-touch rounded-xl px-3 text-sm font-semibold text-stock-out"
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
