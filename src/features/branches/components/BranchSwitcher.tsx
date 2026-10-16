'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { switchBranch } from '../actions'

export interface BranchOptionUI {
  id: string
  code: string
  name: string
  seriesNumber: number
}

/**
 * Selector de sucursal activa.
 *
 * Solo se renderiza cuando el usuario tiene MÁS DE UNA asignada: con una
 * sola, un desplegable de un elemento es ruido que ocupa sitio en el sidebar
 * y hace dudar al cajero de si está en el local correcto.
 *
 * Muestra el número de serie junto al nombre a propósito. Es el dato que
 * permite al cajero confirmar de un vistazo que va a emitir con la serie que
 * toca, y el que explica por qué sus boletas empiezan por B002.
 */
export function BranchSwitcher({
  sucursales,
  activa,
}: {
  sucursales: BranchOptionUI[]
  activa: string | undefined
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (sucursales.length <= 1) {
    const unica = sucursales[0]
    return unica ? (
      <p className="truncate text-xs text-ink-muted">
        {unica.name}{' '}
        <span className="font-mono">
          · serie {String(unica.seriesNumber).padStart(3, '0')}
        </span>
      </p>
    ) : (
      <p className="text-xs font-semibold text-stock-low">Sin sucursal asignada</p>
    )
  }

  const cambiar = (id: string) => {
    setError(null)
    startTransition(async () => {
      const res = await switchBranch(id)
      if (!res.ok) {
        setError(res.message)
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold uppercase tracking-wide text-ink-muted" htmlFor="sucursal-activa">
        Sucursal
      </label>
      <select
        id="sucursal-activa"
        value={activa ?? ''}
        disabled={pending}
        onChange={(e) => cambiar(e.target.value)}
        className="h-touch w-full rounded-lg border border-hairline bg-surface px-2 text-sm font-semibold text-ink disabled:opacity-50"
      >
        {!activa && <option value="">Elige una…</option>}
        {sucursales.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} ({String(s.seriesNumber).padStart(3, '0')})
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="text-xs font-semibold text-stock-out">
          {error}
        </p>
      )}
    </div>
  )
}
