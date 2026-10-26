'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { configurarCredito } from '@/features/credito/actions'

const campo = 'h-touch w-full rounded-xl border border-hairline bg-surface px-3 text-base text-ink disabled:bg-surface-sunken disabled:text-ink-muted'

/**
 * Línea, plazo y bloqueo de crédito de un cliente. Solo con `credito.limite`; sin él se ve el valor pero no se edita. Dar línea a un
 * cliente sin DNI o RUC válido lo rechaza el servidor (y aquí se avisa antes).
 */
export function ConfigCredito({ customerId, limite, plazoDias, bloqueado, documentoValido, puedeEditar }: {
  customerId: string
  limite: number
  plazoDias: number
  bloqueado: boolean
  documentoValido: boolean
  puedeEditar: boolean
}) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const [v, setV] = useState({ limite: String(limite), plazo: String(plazoDias), bloqueado })

  const guardar = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    setError(null); setOk(false)
    startTransition(async () => {
      const r = await configurarCredito({
        customerId, creditLimit: Number(v.limite.replace(',', '.')), creditTermDays: Number(v.plazo), bloqueado: v.bloqueado,
      })
      if (!r.ok) { setError(r.message); return }
      setOk(true)
      router.refresh()
    })
  }

  return (
    <form onSubmit={guardar} data-form="credito" className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4">
      <h3 className="font-bold text-ink">Línea de crédito</h3>
      {!documentoValido && puedeEditar && (
        <p data-aviso="sin-documento" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
          Este cliente no tiene un DNI o RUC válido: no se le puede dar línea de crédito. Agrega su documento primero.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Línea (S/)
          <input name="creditLimit" type="number" inputMode="decimal" min="0" step="0.01" value={v.limite} disabled={!puedeEditar}
            onChange={(e) => setV((x) => ({ ...x, limite: e.target.value }))} className={campo} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Plazo (días)
          <input name="creditTermDays" type="number" inputMode="numeric" min="0" max="365" step="1" value={v.plazo} disabled={!puedeEditar}
            onChange={(e) => setV((x) => ({ ...x, plazo: e.target.value }))} className={campo} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm font-semibold text-ink">
        <input name="bloqueado" type="checkbox" checked={v.bloqueado} disabled={!puedeEditar}
          onChange={(e) => setV((x) => ({ ...x, bloqueado: e.target.checked }))} className="size-5 accent-stock-out" />
        Bloquear el crédito de este cliente (no se le fía aunque tenga línea)
      </label>
      {error && <p role="alert" data-form="error" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
      {ok && <p role="status" data-form="ok" className="text-sm font-semibold text-stock-ok">Guardado.</p>}
      {puedeEditar
        ? <button type="submit" disabled={pendiente || !enLinea} className="h-touch rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">{pendiente ? 'Guardando…' : 'Guardar crédito'}</button>
        : <p data-aviso="solo-lectura" className="text-xs text-ink-muted">Solo quien administra el crédito puede cambiar la línea, el plazo o el bloqueo.</p>}
    </form>
  )
}
