'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { registerAction } from './actions'

export interface PlanOption {
  code: string
  name: string
  description: string | null
  priceMonthly: string
  currency: string
  trialDays: number
  maxProducts: number | null
}

export function RegisterForm({ plans }: { plans: PlanOption[] }) {
  const router = useRouter()
  const [businessName, setBusinessName] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [planCode, setPlanCode] = useState(plans[0]?.code ?? '')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setFieldErrors({})

    startTransition(async () => {
      const res = await registerAction({
        businessName, ownerName, email, password, planCode,
      })

      if (!res.ok) {
        if (res.code === 'VALIDATION') {
          setFieldErrors((res.details ?? {}) as Record<string, string[]>)
        }
        setError(res.message)
        return
      }

      router.push(res.data.redirectTo)
      router.refresh()
    })
  }

  const err = (c: string) => fieldErrors[c]?.[0]

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field label="Nombre de tu ferretería" error={err('businessName')}>
        <input
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          placeholder="Ferretería El Sol"
          required
          className={inputClass(err('businessName'))}
        />
      </Field>

      <Field label="Tu nombre" error={err('ownerName')}>
        <input
          value={ownerName}
          onChange={(e) => setOwnerName(e.target.value)}
          autoComplete="name"
          required
          className={inputClass(err('ownerName'))}
        />
      </Field>

      <Field label="Correo" error={err('email')}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
          className={inputClass(err('email'))}
        />
      </Field>

      <Field label="Contraseña (mínimo 8 caracteres)" error={err('password')}>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          className={inputClass(err('password'))}
        />
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-ink-muted">Plan</legend>
        {plans.map((p) => (
          <label
            key={p.code}
            className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
              planCode === p.code
                ? 'border-industrial-600 bg-industrial-50 dark:bg-industrial-950'
                : 'border-hairline bg-surface'
            }`}
          >
            <input
              type="radio"
              name="plan"
              value={p.code}
              checked={planCode === p.code}
              onChange={() => setPlanCode(p.code)}
              className="mt-1 size-5 accent-industrial-600"
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="font-bold text-ink">{p.name}</span>
                <span className="shrink-0 text-sm font-bold text-ink">
                  {p.currency} {p.priceMonthly}/mes
                </span>
              </span>
              {p.description && (
                <span className="mt-0.5 block text-sm text-ink-muted">{p.description}</span>
              )}
              <span className="mt-1 block text-xs font-semibold text-industrial-700 dark:text-industrial-400">
                {p.trialDays} días de prueba gratis · sin tarjeta
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {error && (
        <p role="alert" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || !planCode}
        className="h-touch-xl rounded-2xl bg-industrial-600 text-lg font-bold text-white transition active:scale-95 disabled:opacity-40"
      >
        {pending ? 'Creando tu cuenta…' : 'Crear cuenta gratis'}
      </button>
    </form>
  )
}

function inputClass(error?: string) {
  return [
    'h-touch-lg w-full rounded-xl border bg-surface px-4 text-base text-ink',
    'focus:outline-none focus:ring-2',
    error
      ? 'border-stock-out focus:border-stock-out focus:ring-stock-out/40'
      : 'border-hairline focus:border-industrial-600 focus:ring-industrial-600/40',
  ].join(' ')
}

function Field({
  label, error, children,
}: {
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-ink-muted">{label}</span>
      {children}
      {error && <span className="text-xs font-semibold text-stock-out">{error}</span>}
    </label>
  )
}
