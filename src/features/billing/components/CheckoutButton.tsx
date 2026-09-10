'use client'

import { useState, useTransition } from 'react'
import { startCheckout } from '../actions'

/**
 * Lleva al usuario a Stripe. La redirección ocurre en el CLIENTE con la URL
 * que devuelve la Server Action: así, si Stripe falla, el usuario ve un
 * mensaje en su sitio en vez de aterrizar en una pantalla en blanco.
 */
export function CheckoutButton({
  planCode,
  label,
  className,
}: {
  planCode: string
  label: string
  className?: string
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const ir = () => {
    setError(null)
    startTransition(async () => {
      const res = await startCheckout(planCode)
      if (!res.ok) {
        setError(res.message)
        return
      }
      // `assign` y no `replace`: si el usuario vuelve atrás desde Stripe,
      // debe encontrar su dashboard, no un bucle hacia la pasarela.
      window.location.assign(res.data.url)
    })
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={ir}
        disabled={pending}
        className={
          className ??
          'h-touch rounded-xl bg-graphite-900 px-4 text-sm font-bold text-white transition active:scale-95 disabled:opacity-50 dark:bg-graphite-50 dark:text-graphite-900'
        }
      >
        {pending ? 'Abriendo pago…' : label}
      </button>
      {error && (
        <span role="alert" className="text-xs font-semibold text-stock-out">
          {error}
        </span>
      )}
    </span>
  )
}
