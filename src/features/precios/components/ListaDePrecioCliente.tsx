'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { asignarListaClienteAccion } from '../actions'

/**
 * La lista de precios por defecto de un cliente, en su ficha (F6.7c): al asociarlo a un carrito del POS esa lista se aplica sola (el cajero puede cambiarla). Cambiarla es un poder de
 * precios: solo con `precios.gestionar`; sin él se ve la lista pero no se edita.
 */
export function ListaDePrecioCliente({
  customerId, actual, listas, editable,
}: { customerId: string; actual: string | null; listas: { id: string; name: string }[]; editable: boolean }) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [valor, setValor] = useState(actual ?? '')
  const [error, setError] = useState<string | null>(null)
  const [hecho, setHecho] = useState(false)
  const nombreActual = actual ? listas.find((l) => l.id === actual)?.name ?? null : null
  // La lista que el cliente tenía puede haberse dado de baja: se dice, y en el POS se le vende a precio Base.
  const deBaja = actual !== null && nombreActual === null

  const guardar = () => {
    setError(null); setHecho(false)
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    startTransition(async () => {
      const r = await asignarListaClienteAccion({ customerId, priceListId: valor === '' ? null : valor })
      if (!r.ok) { setError(r.message); return }
      setHecho(true)
      router.refresh()
    })
  }

  return (
    <section data-cliente="lista-precios" className="rounded-2xl border border-hairline bg-surface p-4">
      <h2 className="font-bold text-ink">Lista de precios</h2>
      <p className="text-sm text-ink-muted">La que se aplica sola al venderle en el POS. Sin lista, paga el precio Base.</p>
      {editable ? (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Lista por defecto
            <select value={valor} onChange={(e) => { setValor(e.target.value); setHecho(false) }} aria-label="Lista de precios por defecto" className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base font-normal text-ink">
              <option value="">Base (minorista)</option>
              {listas.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <button type="button" disabled={pendiente || valor === (actual ?? '')} onClick={guardar} className="h-touch rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-50">{pendiente ? 'Guardando…' : 'Guardar'}</button>
          {hecho && <p role="status" className="text-sm font-semibold text-stock-ok">Guardado.</p>}
        </div>
      ) : (
        <p data-cliente="lista-solo-lectura" className="mt-2 text-base font-semibold text-ink">{nombreActual ?? 'Base (minorista)'}</p>
      )}
      {deBaja && <p data-cliente="lista-de-baja" className="mt-2 text-sm font-semibold text-stock-low">La lista que tenía se dio de baja: se le vende a precio Base.</p>}
      {error && <p role="alert" className="mt-2 text-sm font-semibold text-stock-out">{error}</p>}
    </section>
  )
}
