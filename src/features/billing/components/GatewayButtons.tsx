'use client'

import { useState, useTransition } from 'react'
import { startCheckout, startMercadoPagoCheckout } from '../actions'

/**
 * Elige pasarela. Solo se renderizan las que el SaaS tiene configuradas —
 * mostrar un botón de MercadoPago sin access token es prometer algo que
 * fallará con "no disponible" justo cuando el cliente quiere pagar.
 */
export function GatewayButtons({
  planCode,
  gateways,
  label = 'Pagar',
}: {
  planCode: string
  gateways: { stripe: boolean; mercadopago: boolean }
  label?: string
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const ir = (pasarela: 'stripe' | 'mp') => {
    setError(null)
    startTransition(async () => {
      const res =
        pasarela === 'stripe'
          ? await startCheckout(planCode)
          : await startMercadoPagoCheckout(planCode)

      if (!res.ok) {
        setError(res.message)
        return
      }
      window.location.assign(res.data.url)
    })
  }

  const ninguna = !gateways.stripe && !gateways.mercadopago

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {gateways.stripe && (
          <button
            type="button"
            onClick={() => ir('stripe')}
            disabled={pending}
            className="h-touch-lg rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white transition active:scale-95 disabled:opacity-40"
          >
            {pending ? '…' : `${label} con tarjeta`}
          </button>
        )}
        {gateways.mercadopago && (
          <button
            type="button"
            onClick={() => ir('mp')}
            disabled={pending}
            className="h-touch-lg rounded-xl border border-industrial-600 px-4 text-sm font-bold text-industrial-700 transition active:scale-95 disabled:opacity-40 dark:text-industrial-400"
          >
            {pending ? '…' : 'MercadoPago'}
          </button>
        )}
      </div>
      {ninguna && (
        <span className="text-xs text-ink-muted">Pago en línea no configurado.</span>
      )}
      {error && (
        <span role="alert" className="max-w-xs text-right text-xs font-semibold text-stock-out">
          {error}
        </span>
      )}
    </div>
  )
}
