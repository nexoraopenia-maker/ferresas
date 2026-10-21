'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { loginAction } from '../actions'

const campo =
  'h-14 w-full rounded-2xl border border-white/20 bg-black/30 px-4 text-base text-white placeholder:text-white/45 ' +
  'transition focus:border-sky-400 focus:bg-black/40 focus:outline-none focus:ring-2 focus:ring-sky-400/50'

export function LoginForm({ callbackUrl }: { callbackUrl?: string }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [verClave, setVerClave] = useState(false)
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
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-white/80">Correo</span>
        <input
          type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          autoComplete="username" placeholder="tu@correo.com" required className={campo}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-white/80">Contraseña</span>
        <div className="relative">
          <input
            type={verClave ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" placeholder="••••••••" required className={`${campo} pr-20`}
          />
          <button
            type="button" onClick={() => setVerClave((v) => !v)} aria-pressed={verClave}
            className="absolute inset-y-0 right-2 my-auto h-10 rounded-xl px-3 text-sm font-semibold text-sky-300 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-sky-400/50"
          >
            {verClave ? 'Ocultar' : 'Ver'}
          </button>
        </div>
      </label>

      {error && (
        <p role="alert" className="rounded-xl border border-rose-300/40 bg-rose-500/20 px-3 py-2 text-sm font-semibold text-rose-100">
          {error}
        </p>
      )}

      <button
        type="submit" disabled={pending}
        className="mt-1 h-14 rounded-2xl bg-gradient-to-r from-blue-600 to-sky-500 text-lg font-bold text-white shadow-lg shadow-blue-900/40 transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-sky-300 active:scale-[0.98] disabled:opacity-50"
      >
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  )
}
