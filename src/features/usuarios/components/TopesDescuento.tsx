'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { fijarTopeDescuento } from '../actions'

interface Fila { role: 'ADMIN' | 'VENDEDOR' | 'CAJERO'; maxPercent: number; editable: boolean; soloDueno: boolean }
const ETIQUETA = { ADMIN: 'Administrador', VENDEDOR: 'Vendedor', CAJERO: 'Cajero' } as const

/** Descuento máximo por rol, en % de cada línea. Un tope > 0 activa el descuento para ese rol. */
export function TopesDescuento({ filas, puedeOperar }: { filas: Fila[]; puedeOperar: boolean }) {
  const router = useRouter()
  const [valores, setValores] = useState<Record<string, string>>(() => Object.fromEntries(filas.map((f) => [f.role, String(f.maxPercent)])))
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const guardar = (f: Fila) => {
    setError(null); setOk(null)
    const n = Number((valores[f.role] ?? '').replace(',', '.'))
    startTransition(async () => {
      const r = await fijarTopeDescuento({ role: f.role, maxPercent: n })
      if (!r.ok) { setError(r.message); return }
      setOk(`Guardado: ${ETIQUETA[f.role]} ${n}%. Rige desde su próxima pantalla.`)
      router.refresh()
    })
  }

  return (
    <section className="rounded-2xl border border-hairline bg-surface p-4 shadow-sm">
      <h2 className="font-bold text-ink">Descuento máximo por rol</h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        Como % de cada línea. En 0 el rol no puede dar descuentos. El dueño no tiene tope. Todo descuento queda anotado en la auditoría.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {filas.map((f) => (
          <li key={f.role} className="flex items-center gap-3">
            <span className="w-32 shrink-0 text-sm font-semibold text-ink">{ETIQUETA[f.role]}</span>
            <div className="relative w-28">
              <input
                inputMode="decimal" disabled={!f.editable || !puedeOperar} value={valores[f.role] ?? ''}
                onChange={(e) => setValores((v) => ({ ...v, [f.role]: e.target.value }))}
                aria-label={`Tope de descuento de ${ETIQUETA[f.role]}`}
                className="h-touch w-full rounded-xl border border-hairline bg-surface px-3 pr-7 text-right text-base font-bold text-ink disabled:opacity-60"
              />
              <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-muted">%</span>
            </div>
            {f.editable && puedeOperar ? (
              <button type="button" disabled={pending} onClick={() => guardar(f)} className="h-touch rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-50">Guardar</button>
            ) : (
              <span className="text-xs text-ink-muted">{f.soloDueno ? 'Solo el dueño' : ''}</span>
            )}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
      {ok && <p role="status" className="mt-3 rounded-xl bg-stock-ok-soft px-3 py-2 text-sm font-semibold text-stock-ok">{ok}</p>}
    </section>
  )
}
