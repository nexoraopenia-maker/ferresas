'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setCajaObligatoria } from '../actions'

/** Interruptor de la política «sin caja abierta no se cobra en efectivo». */
export function CajaObligatoria({ inicial, puedeOperar }: { inicial: boolean; puedeOperar: boolean }) {
  const router = useRouter()
  const [activo, setActivo] = useState(inicial)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const cambiar = () => {
    const siguiente = !activo
    setError(null)
    startTransition(async () => {
      const res = await setCajaObligatoria(siguiente)
      if (!res.ok) { setError(res.message); return }
      setActivo(siguiente)
      router.refresh()
    })
  }

  return (
    <section className="rounded-2xl border border-hairline bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-ink">Caja obligatoria</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            {activo
              ? 'Activa: no se cobra en efectivo sin un turno abierto, así todo el efectivo entra en un arqueo.'
              : 'Desactivada: se puede cobrar sin abrir caja, y ese efectivo no entra en ningún arqueo.'}
          </p>
        </div>
        <button
          type="button" role="switch" aria-checked={activo} aria-label="Caja obligatoria"
          disabled={pending || !puedeOperar} onClick={cambiar}
          className={`relative h-8 w-14 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            activo ? 'bg-industrial-600' : 'bg-graphite-300 dark:bg-graphite-600'
          }`}
        >
          <span className={`absolute top-1 size-6 rounded-full bg-white shadow transition-all ${activo ? 'left-7' : 'left-1'}`} />
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm font-semibold text-stock-out">{error}</p>}
    </section>
  )
}
