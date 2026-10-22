'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { confirmarMfaAction, iniciarMfaAction } from '../mfa-actions'

const boton = 'h-11 rounded-xl bg-primary px-4 font-bold text-white disabled:opacity-50'
const campo = 'h-12 w-full rounded-xl border border-line bg-surface px-3 text-center text-xl tracking-[0.3em]'

/** Flujo de activación: escanear QR → confirmar con un código → guardar los códigos de recuperación. */
export function ActivarMfa({ destino }: { destino: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [qr, setQr] = useState<{ secreto: string; qr: string } | null>(null)
  const [codigo, setCodigo] = useState('')
  const [codigos, setCodigos] = useState<string[] | null>(null)
  const [guardados, setGuardados] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const empezar = () => start(async () => {
    setError(null)
    const r = await iniciarMfaAction()
    if (!r.ok) return setError(r.message)
    setQr(r.data)
  })
  const confirmar = () => start(async () => {
    setError(null)
    const r = await confirmarMfaAction({ codigo })
    if (!r.ok) return setError(r.message)
    setCodigos(r.data.codigosRecuperacion)
  })

  if (codigos) {
    return (
      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-bold text-ink">Guarda tus códigos de recuperación</h2>
        <p className="text-sm text-ink-muted">
          Cada uno sirve una sola vez si pierdes el teléfono. No se vuelven a mostrar: anótalos o imprímelos y guárdalos aparte.
        </p>
        <ul className="grid grid-cols-2 gap-2 font-mono text-sm text-ink">
          {codigos.map((c) => <li key={c} className="rounded-lg bg-black/5 px-2 py-1 text-center">{c}</li>)}
        </ul>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={guardados} onChange={(e) => setGuardados(e.target.checked)} />
          Ya los guardé en un lugar seguro
        </label>
        <button className={boton} disabled={!guardados} onClick={() => { router.push(destino); router.refresh() }}>
          Continuar
        </button>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      {!qr ? (
        <>
          <p className="text-sm text-ink-muted">
            Necesitas una app autenticadora (Google Authenticator, Authy o Microsoft Authenticator).
          </p>
          <button className={boton} disabled={pending} onClick={empezar}>Empezar</button>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-muted">1. Escanea este QR con tu app autenticadora.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr.qr} alt="Código QR para la app autenticadora" width={240} height={240} className="mx-auto rounded-lg bg-white" />
          <p className="text-xs text-ink-muted">
            ¿No puedes escanear? Escribe esta clave a mano: <span className="select-all font-mono">{qr.secreto}</span>
          </p>
          <p className="text-sm text-ink-muted">2. Escribe el código de 6 dígitos que muestra la app.</p>
          <input
            inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={codigo}
            onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))} className={campo} aria-label="Código de 6 dígitos"
          />
          <button className={boton} disabled={pending || codigo.length !== 6} onClick={confirmar}>Activar</button>
        </>
      )}
      {error && <p role="alert" className="text-sm font-semibold text-rose-600">{error}</p>}
    </section>
  )
}
