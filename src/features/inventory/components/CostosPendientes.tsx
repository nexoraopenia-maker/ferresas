'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatQuantity, unitLabel } from '@/lib/quantity'
import { completarCostoAction } from '../actions'

interface Fila {
  movementId: string; producto: string; sku: string; unitType: string
  cantidad: number; almacen: string; registradaPor: string; fecha: string
}

const fecha = (iso: string) =>
  new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Lima' }).format(new Date(iso))

export function CostosPendientes({ filas, puedeOperar }: { filas: Fila[]; puedeOperar: boolean }) {
  const router = useRouter()
  const [valores, setValores] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const guardar = (id: string) => {
    const n = Number((valores[id] ?? '').replace(',', '.'))
    if (!Number.isFinite(n) || n < 0 || (valores[id] ?? '').trim() === '') { setError('Escribe el costo unitario (0 o más).'); return }
    setError(null)
    startTransition(async () => {
      const r = await completarCostoAction({ movementId: id, unitCost: n })
      if (!r.ok) { setError(r.message); return }
      router.refresh()
    })
  }

  if (filas.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-hairline bg-stock-ok-soft/40 px-4 py-10 text-center text-sm font-semibold text-stock-ok">
        No hay costos pendientes. Todo lo que entró tiene su costo.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <p role="alert" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
      <ul className="flex flex-col gap-2">
        {filas.map((f) => (
          <li key={f.movementId} className="rounded-2xl border border-hairline bg-surface p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink">{f.producto}</p>
                <p className="font-mono text-xs text-ink-muted">{f.sku}</p>
              </div>
              <p className="shrink-0 text-sm font-bold text-ink">
                {formatQuantity(f.cantidad, f.unitType)} {unitLabel(f.unitType)}
              </p>
            </div>
            <p className="mt-1 text-xs text-ink-muted">{f.almacen} · {f.registradaPor} · {fecha(f.fecha)}</p>
            {puedeOperar && (
              <div className="mt-3 flex items-center gap-2">
                <input
                  inputMode="decimal" placeholder={`Costo por ${unitLabel(f.unitType)} (S/)`} value={valores[f.movementId] ?? ''}
                  onChange={(e) => setValores((v) => ({ ...v, [f.movementId]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') guardar(f.movementId) }}
                  className="h-touch min-w-0 flex-1 rounded-xl border border-hairline bg-surface px-3 text-base font-bold text-ink"
                />
                <button
                  type="button" disabled={pending} onClick={() => guardar(f.movementId)}
                  className="h-touch shrink-0 rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-50"
                >
                  Guardar
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
