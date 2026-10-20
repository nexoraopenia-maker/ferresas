'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { limitarDecimales, parseQuantity, unitLabel } from '@/lib/quantity'
import { createStockMovement } from '@/features/inventory/actions'

/** Registra una ENTRADA de mercadería sin salir de la lista de alertas. */
export function ReposicionRapida({
  productId, warehouseId, unitType,
}: { productId: string; warehouseId: string; unitType: string }) {
  const router = useRouter()
  const [abierto, setAbierto] = useState(false)
  const [cantidad, setCantidad] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const guardar = () => {
    setError(null)
    const q = parseQuantity(cantidad)
    if (!q || q <= 0) { setError('Escribe cuánto llegó.'); return }
    startTransition(async () => {
      const res = await createStockMovement({
        type: 'ENTRADA', source: 'MANUAL', productId, warehouseId, quantity: q,
        idempotencyKey: crypto.randomUUID(),
      })
      if (!res.ok) { setError(res.message); return }
      setAbierto(false); setCantidad('')
      router.refresh()
    })
  }

  if (!abierto) {
    return (
      <button
        type="button" onClick={() => setAbierto(true)}
        className="h-touch rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white shadow-sm hover:bg-industrial-700"
      >
        Registrar entrada
      </button>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        inputMode="decimal" autoFocus value={cantidad} placeholder={`Cantidad (${unitLabel(unitType)})`}
        onChange={(e) => setCantidad(limitarDecimales(e.target.value))}
        className="h-touch w-36 rounded-xl border border-hairline bg-surface px-3 text-base font-bold text-ink"
      />
      <button
        type="button" disabled={pending} onClick={guardar}
        className="h-touch rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-50"
      >
        {pending ? 'Guardando…' : 'Guardar'}
      </button>
      <button type="button" onClick={() => { setAbierto(false); setError(null) }} className="text-sm font-semibold text-ink-muted">
        Cancelar
      </button>
      {error && <p role="alert" className="w-full text-sm font-semibold text-stock-out">{error}</p>}
    </div>
  )
}
