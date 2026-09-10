'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { loginAction } from '../actions'

export function LoginForm({ callbackUrl }: { callbackUrl?: string }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const res = await loginAction({ email, password, callbackUrl })
      if (!res.ok) {
        setError(res.message)
        return
      }
      router.push(res.data.redirectTo)
      router.refresh()
    })
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-muted">Correo</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
          className="h-touch-lg rounded-xl border border-hairline bg-surface px-4 text-base text-ink focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-muted">Contraseña</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          className="h-touch-lg rounded-xl border border-hairline bg-surface px-4 text-base text-ink focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
        />
      </label>

      {error && (
        <p role="alert" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="h-touch-xl rounded-2xl bg-industrial-600 text-lg font-bold text-white transition active:scale-95 disabled:opacity-40"
      >
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  )
}
