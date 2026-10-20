'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { cambiarOperador, listarOperadoresDeLaSucursal, volverAlUsuarioDeLaSesion } from '../actions'
import type { OperadorVista } from '../pin-service'

/**
 * Cambio de operador con PIN, en un dispositivo cuya sesión ya está abierta.
 * Identifica quién cobra; no da más permisos que los de la sesión.
 */
export function OperadorSwitcher({ operadorActual }: { operadorActual: string | null }) {
  const router = useRouter()
  const [abierto, setAbierto] = useState(false)
  const [operadores, setOperadores] = useState<OperadorVista[] | null>(null)
  const [userId, setUserId] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const abrir = () => {
    setAbierto(true); setError(null); setPin('')
    startTransition(async () => {
      const r = await listarOperadoresDeLaSucursal()
      if (!r.ok) { setError(r.message); return }
      setOperadores(r.data)
      setUserId(r.data.find((o) => !o.bloqueado)?.id ?? '')
    })
  }

  const entrar = () => {
    setError(null)
    startTransition(async () => {
      const r = await cambiarOperador({ userId, pin })
      if (!r.ok) { setError(r.message); setPin(''); return }
      setAbierto(false); setPin('')
      router.refresh()
    })
  }

  const volver = () => {
    startTransition(async () => {
      await volverAlUsuarioDeLaSesion()
      router.refresh()
    })
  }

  return (
    <div className="text-sm">
      {operadorActual ? (
        <div className="flex items-center justify-between gap-2 rounded-xl bg-accent-100 px-3 py-2 text-accent-900">
          <span className="min-w-0 truncate font-semibold">Operador: {operadorActual}</span>
          <button type="button" onClick={volver} disabled={pending} className="shrink-0 font-bold underline">Salir</button>
        </div>
      ) : (
        <button
          type="button" onClick={abrir}
          className="h-touch w-full rounded-xl border border-white/40 bg-white/10 px-3 text-left font-semibold text-white lg:border-hairline lg:bg-transparent lg:text-ink"
        >
          Cambiar de operador (PIN)
        </button>
      )}

      {abierto && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Cambiar de operador">
          <div className="absolute inset-0 bg-graphite-950/70" onClick={() => setAbierto(false)} aria-hidden />
          <div className="relative w-full max-w-sm rounded-t-3xl bg-surface p-5 shadow-xl sm:rounded-3xl">
            <h2 className="text-lg font-bold text-ink">¿Quién va a cobrar?</h2>
            <p className="mt-0.5 text-xs text-ink-muted">Solo ves a quien trabaja en esta sucursal y tiene PIN.</p>

            {operadores && operadores.length === 0 && (
              <p className="mt-4 rounded-xl bg-surface-sunken px-3 py-4 text-center text-sm text-ink-muted">
                Nadie tiene PIN en esta sucursal. Un administrador puede ponerlo en Equipo.
              </p>
            )}

            {operadores && operadores.length > 0 && (
              <>
                <ul className="mt-3 flex max-h-48 flex-col gap-1.5 overflow-y-auto">
                  {operadores.map((o) => (
                    <li key={o.id}>
                      <button
                        type="button" disabled={o.bloqueado} onClick={() => setUserId(o.id)}
                        className={`flex h-touch w-full items-center justify-between rounded-xl border px-3 text-left font-semibold ${
                          userId === o.id ? 'border-industrial-600 bg-industrial-50 text-industrial-800 dark:bg-graphite-800 dark:text-industrial-200' : 'border-hairline text-ink'
                        } disabled:opacity-50`}
                      >
                        <span className="truncate">{o.nombre}</span>
                        {o.bloqueado && <span className="text-xs font-bold text-stock-out">Bloqueado</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                <input
                  type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={6}
                  value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && pin.length >= 4 && userId) entrar() }}
                  placeholder="PIN"
                  className="mt-3 h-touch-lg w-full rounded-xl border border-hairline bg-surface px-4 text-center text-2xl font-bold tracking-[0.5em] text-ink"
                />
              </>
            )}

            {error && <p role="alert" className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}

            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setAbierto(false)} className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink">Cancelar</button>
              <button
                type="button" onClick={entrar} disabled={pending || pin.length < 4 || !userId}
                className="h-touch-lg flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40"
              >
                {pending ? 'Comprobando…' : 'Entrar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
