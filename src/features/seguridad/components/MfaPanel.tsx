'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { desactivarMfaAction, regenerarCodigosAction } from '../mfa-actions'
import { ActivarMfa } from './ActivarMfa'

const boton = 'h-10 rounded-xl border border-line px-3 text-sm font-semibold disabled:opacity-50'

/** Estado del segundo factor de mi cuenta, en /seguridad. */
export function MfaPanel(p: { activo: boolean; obligatorio: boolean; codigosRestantes: number }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [codigo, setCodigo] = useState('')
  const [nuevos, setNuevos] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!p.activo) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="font-bold text-ink">Verificación en dos pasos</h2>
        <ActivarMfa destino="/seguridad" />
      </section>
    )
  }
  const accion = (fn: () => Promise<void>) => start(async () => { setError(null); await fn() })
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <h2 className="font-bold text-ink">Verificación en dos pasos: activa</h2>
      <p className="text-sm text-ink-muted">Te quedan {p.codigosRestantes} códigos de recuperación.</p>
      <input
        inputMode="numeric" value={codigo} onChange={(e) => setCodigo(e.target.value)} maxLength={12}
        placeholder="Código actual" aria-label="Código actual" className="h-10 rounded-xl border border-line px-3"
      />
      <div className="flex flex-wrap gap-2">
        <button className={boton} disabled={pending || !codigo} onClick={() => accion(async () => {
          const r = await regenerarCodigosAction({ codigo })
          if (!r.ok) return setError(r.message)
          setNuevos(r.data.codigosRecuperacion); setCodigo('')
        })}>Generar códigos nuevos</button>
        {!p.obligatorio && (
          <button className={boton} disabled={pending || !codigo} onClick={() => accion(async () => {
            const r = await desactivarMfaAction({ codigo })
            if (!r.ok) return setError(r.message)
            router.refresh()
          })}>Desactivar</button>
        )}
      </div>
      {p.obligatorio && <p className="text-xs text-ink-muted">Tu rol lo exige: no se puede desactivar.</p>}
      {nuevos && (
        <ul className="grid grid-cols-2 gap-2 font-mono text-sm text-ink">
          {nuevos.map((c) => <li key={c} className="rounded-lg bg-black/5 px-2 py-1 text-center">{c}</li>)}
        </ul>
      )}
      {error && <p role="alert" className="text-sm font-semibold text-rose-600">{error}</p>}
    </section>
  )
}
