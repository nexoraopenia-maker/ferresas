'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { aceptarInvitacion } from '../actions'

export function AceptarForm({ token }: { token: string }) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [listo, setListo] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const enviar = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const res = await aceptarInvitacion({ token, name, password })
      if (!res.ok) { setError(res.message); return }
      setListo(res.data.email)
    })
  }

  if (listo) {
    return (
      <div className="rounded-2xl border border-hairline bg-surface p-5">
        <p className="font-semibold text-ink">Cuenta creada.</p>
        <p className="mt-1 text-sm text-ink-muted">Ya puedes entrar con {listo}.</p>
        <Link
          href="/login"
          className="mt-4 flex h-touch-lg items-center justify-center rounded-xl bg-industrial-600 font-bold text-white"
        >
          Iniciar sesión
        </Link>
      </div>
    )
  }

  const campo = 'h-touch-lg rounded-xl border border-hairline bg-surface px-3 text-base text-ink'
  return (
    <form onSubmit={enviar} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-muted">Tu nombre</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={campo} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-muted">Contraseña (mínimo 8 caracteres)</span>
        <input
          type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password" className={campo}
        />
      </label>
      {error && (
        <p role="alert" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
          {error}
        </p>
      )}
      <button
        type="submit" disabled={pending || name.trim().length < 2 || password.length < 8}
        className="h-touch-lg rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40"
      >
        {pending ? 'Creando…' : 'Crear mi cuenta'}
      </button>
    </form>
  )
}
