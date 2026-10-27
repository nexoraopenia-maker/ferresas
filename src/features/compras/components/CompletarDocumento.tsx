'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { completarDocumento } from '../actions'
import { CamposDocumento, DOCUMENTO_VACIO, type ValorDocumento } from './CamposDocumento'

/**
 * «Completar documento» / «Corregir documento» de una compra ya RECIBIDA: solo tipo, serie, número y fecha de emisión. No reabre la compra:
 * no toca costos, stock ni deuda. El servidor exige `compras.registrar` y deja constancia en la auditoría.
 */
export function CompletarDocumento({ purchaseId, actual, hoy, puedeOperar }: { purchaseId: string; actual: ValorDocumento | null; hoy: string; puedeOperar: boolean }) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [abierto, setAbierto] = useState(false)
  const [valor, setValor] = useState<ValorDocumento>(actual ?? DOCUMENTO_VACIO)
  const [error, setError] = useState<string | null>(null)

  const guardar = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    setError(null)
    startTransition(async () => {
      const r = await completarDocumento({ purchaseId, ...valor })
      if (!r.ok) { setError(r.message); return }
      setAbierto(false)
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" data-boton="documento" onClick={() => setAbierto(!abierto)} disabled={!puedeOperar}
        className="h-touch self-start rounded-xl border border-hairline px-4 font-semibold text-ink disabled:opacity-40">{actual ? 'Corregir documento' : 'Completar documento'}</button>
      {abierto && (
        <form data-form="documento" onSubmit={guardar} className="flex flex-col gap-3 rounded-2xl border-2 border-industrial-600 bg-surface p-4 text-sm text-ink">
          <p className="text-xs text-ink-muted">Solo cambia los datos del documento del proveedor. No toca los productos, los costos, el stock ni la deuda.</p>
          <CamposDocumento valor={valor} onChange={setValor} hoy={hoy} disabled={pendiente} />
          {error && <p role="alert" data-error className="rounded-lg bg-stock-out-soft px-3 py-2 font-semibold text-stock-out">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={pendiente} className="h-touch rounded-xl bg-industrial-600 px-4 font-bold text-white disabled:opacity-40">{pendiente ? 'Guardando…' : 'Guardar documento'}</button>
            <button type="button" onClick={() => setAbierto(false)} className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Cancelar</button>
          </div>
        </form>
      )}
    </div>
  )
}
