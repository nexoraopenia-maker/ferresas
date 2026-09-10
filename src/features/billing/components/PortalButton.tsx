'use client'

import { useState, useTransition } from 'react'
import { openBillingPortal } from '../actions'

export function PortalButton() {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null)
            const res = await openBillingPortal()
            if (!res.ok) {
              setError(res.message)
              return
            }
            window.location.assign(res.data.url)
          })
        }
        className="h-touch-lg w-full rounded-xl border border-hairline font-semibold text-ink transition active:scale-95 disabled:opacity-50"
      >
        {pending ? 'Abriendo…' : 'Cambiar tarjeta o cancelar'}
      </button>
      {error && (
        <span role="alert" className="text-xs font-semibold text-stock-out">
          {error}
        </span>
      )}
    </div>
  )
}
