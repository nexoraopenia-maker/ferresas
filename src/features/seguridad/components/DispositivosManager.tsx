'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { cerrarMiDispositivo, cerrarMisOtrosDispositivos } from '../actions'

interface Fila {
  id: string
  descripcion: string
  ip: string | null
  actual: boolean
  creadaEn: string
  vistaEn: string
}

const fmt = (iso: string) =>
  new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Lima' }).format(new Date(iso))

export function DispositivosManager({ dispositivos }: { dispositivos: Fila[] }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const cerrar = (id: string) => {
    setError(null)
    startTransition(async () => {
      const r = await cerrarMiDispositivo(id)
      if (!r.ok) { setError(r.message); return }
      router.refresh()
    })
  }
  const cerrarOtros = () => {
    setError(null)
    startTransition(async () => {
      const r = await cerrarMisOtrosDispositivos()
      if (!r.ok) { setError(r.message); return }
      router.refresh()
    })
  }

  const otros = dispositivos.filter((d) => !d.actual).length

  return (
    <div className="flex flex-col gap-3">
      {error && <p role="alert" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
      <ul className="flex flex-col gap-2">
        {dispositivos.map((d) => (
          <li key={d.id} className={`flex items-center justify-between gap-3 rounded-2xl border bg-surface p-3 shadow-sm ${d.actual ? 'border-industrial-600/50' : 'border-hairline'}`}>
            <div className="min-w-0">
              <p className="truncate font-semibold text-ink">
                {d.descripcion}
                {d.actual && <span className="ml-2 rounded-full bg-industrial-100 px-2 py-0.5 text-xs font-bold text-industrial-800 dark:bg-industrial-950 dark:text-industrial-300">Este dispositivo</span>}
              </p>
              <p className="text-xs text-ink-muted">
                {d.ip ?? 'IP desconocida'} · entró {fmt(d.creadaEn)} · visto {fmt(d.vistaEn)}
              </p>
            </div>
            {!d.actual && (
              <button type="button" disabled={pending} onClick={() => cerrar(d.id)} className="h-touch shrink-0 rounded-xl border border-hairline px-3 text-sm font-semibold text-stock-out">
                Cerrar
              </button>
            )}
          </li>
        ))}
        {dispositivos.length === 0 && <li className="rounded-xl bg-surface-sunken px-3 py-6 text-center text-sm text-ink-muted">No hay sesiones registradas.</li>}
      </ul>
      {otros > 0 && (
        <button type="button" disabled={pending} onClick={cerrarOtros} className="h-touch-lg rounded-xl bg-stock-out px-4 font-bold text-white disabled:opacity-50">
          Cerrar las otras {otros} {otros === 1 ? 'sesión' : 'sesiones'}
        </button>
      )}
      <p className="text-xs text-ink-muted">Una sesión cerrada se queda sin acceso en cuanto esa persona abre otra pantalla o intenta cobrar.</p>
    </div>
  )
}
