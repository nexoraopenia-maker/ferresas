'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { anularGuiaAction } from '../actions'
import { MOTIVOS, MODALIDADES } from '../reglas'

export interface FilaGuia {
  id: string
  fullNumber: string
  motive: keyof typeof MOTIVOS
  transportMode: keyof typeof MODALIDADES
  issueDate: string
  recipientName: string
  recipientDocNumber: string
  grossWeightKg: number
  status: string
  voidedAt: string | null
  voidReason: string | null
  origen: string | null
  lineas: number
}

const ESTADO: Record<string, string> = {
  PENDIENTE: 'Pendiente de envío', ENVIADO: 'Enviada', ACEPTADO: 'Aceptada', OBSERVADO: 'Aceptada con observaciones', RECHAZADO: 'Rechazada',
}

export function GuiasList({ filas, puedeAnular }: { filas: FilaGuia[]; puedeAnular: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const anular = (g: FilaGuia) => {
    const reason = window.prompt(`Motivo para anular la guía ${g.fullNumber} (5 caracteres o más):`)
    if (!reason) return
    setError(null)
    start(async () => {
      const r = await anularGuiaAction({ guideId: g.id, reason })
      if (!r.ok) setError(r.message)
      else router.refresh()
    })
  }

  if (filas.length === 0) {
    return <p className="rounded-xl border border-dashed border-hairline px-4 py-8 text-center text-sm text-ink-muted">Todavía no hay guías de remisión.</p>
  }
  return (
    <div className="flex flex-col gap-2">
      {error && <p role="alert" className="rounded-xl bg-stock-out-soft px-4 py-3 text-sm font-semibold text-stock-out">{error}</p>}
      <ul className="flex flex-col gap-3">
        {filas.map((g) => (
          <li key={g.id} className={`rounded-2xl border border-hairline bg-surface p-4 ${g.voidedAt ? 'opacity-60' : ''}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-mono text-lg font-bold text-ink">{g.fullNumber}</p>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${g.voidedAt ? 'bg-stock-out-soft text-stock-out' : 'bg-stock-low-soft text-stock-low'}`}>
                {g.voidedAt ? 'Anulada' : ESTADO[g.status] ?? g.status}
              </span>
            </div>
            <p className="mt-1 text-sm text-ink">{g.recipientName} · {g.recipientDocNumber}</p>
            <p className="text-xs text-ink-muted">
              {g.issueDate} · {MOTIVOS[g.motive].etiqueta} · {g.transportMode === 'PUBLICO' ? 'Transporte público' : 'Transporte privado'} · {g.grossWeightKg} kg · {g.lineas} línea(s)
              {g.origen ? ` · ${g.origen}` : ''}
            </p>
            {g.voidReason && <p className="mt-1 text-xs text-ink-muted">Anulada: {g.voidReason}</p>}
            {puedeAnular && !g.voidedAt && g.status === 'PENDIENTE' && (
              <button type="button" disabled={pending} onClick={() => anular(g)} className="mt-2 h-touch rounded-lg px-3 text-sm font-semibold text-stock-out">Anular</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
