'use client'

import { useState, useTransition } from 'react'
import { suspendTenant, reactivateTenant, startImpersonation } from '../actions'

type Modo = 'suspender' | 'reactivar' | 'soporte'

const COPY: Record<Modo, { titulo: string; boton: string; placeholder: string }> = {
  suspender: {
    titulo: 'Suspender cuenta',
    boton: 'Suspender',
    placeholder: 'Ej. Fraude confirmado en el ticket #4821',
  },
  reactivar: {
    titulo: 'Reactivar cuenta',
    boton: 'Reactivar',
    placeholder: 'Ej. Cliente aportó documentación; falso positivo',
  },
  soporte: {
    titulo: 'Entrar como soporte',
    boton: 'Entrar',
    placeholder: 'Ej. Ticket #1290: no le aparece el stock del almacén 2',
  },
}

/**
 * Las tres acciones exigen motivo escrito antes de ejecutarse (§6.6). El
 * diálogo no es adorno: obliga a pensar qué se va a escribir en el AuditLog
 * ANTES de tocar la cuenta de un cliente.
 */
export function TenantActions({
  tenantId,
  tenantName,
  isActive,
}: {
  tenantId: string
  tenantName: string
  isActive: boolean
}) {
  const [modo, setModo] = useState<Modo | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const cerrar = () => {
    setModo(null)
    setReason('')
    setError(null)
  }

  const ejecutar = () => {
    if (!modo) return
    setError(null)

    startTransition(async () => {
      const res =
        modo === 'suspender'
          ? await suspendTenant({ tenantId, reason })
          : modo === 'reactivar'
            ? await reactivateTenant({ tenantId, reason })
            : await startImpersonation({ tenantId, reason })

      if (!res.ok) {
        setError(res.message)
        return
      }

      if (modo === 'soporte') {
        // Recarga completa: la cookie de soporte acaba de cambiar quién es el
        // usuario efectivo, y el router de Next serviría caché del superadmin.
        window.location.assign('/inventario')
        return
      }

      cerrar()
    })
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setModo('soporte')}
          className="h-touch rounded-lg border border-hairline px-3 text-sm font-semibold text-ink"
        >
          Soporte
        </button>
        {isActive ? (
          <button
            type="button"
            onClick={() => setModo('suspender')}
            className="h-touch rounded-lg bg-stock-out px-3 text-sm font-bold text-white"
          >
            Suspender
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setModo('reactivar')}
            className="h-touch rounded-lg bg-stock-ok px-3 text-sm font-bold text-white"
          >
            Reactivar
          </button>
        )}
      </div>

      {modo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-graphite-950/70" onClick={cerrar} aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-md rounded-2xl bg-surface p-5 shadow-2xl"
          >
            <h2 className="text-lg font-bold text-ink">{COPY[modo].titulo}</h2>
            <p className="mt-1 text-sm text-ink-muted">{tenantName}</p>

            {modo === 'soporte' && (
              <p className="mt-3 rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
                Verás la cuenta en modo solo lectura. Todo queda registrado.
              </p>
            )}

            <label className="mt-4 flex flex-col gap-1">
              <span className="text-sm font-medium text-ink-muted">
                Motivo (obligatorio, queda auditado)
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                autoFocus
                placeholder={COPY[modo].placeholder}
                className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
              />
            </label>

            {error && (
              <p role="alert" className="mt-2 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={cerrar}
                className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={ejecutar}
                disabled={pending || reason.trim().length < 10}
                className="h-touch-lg flex-1 rounded-xl bg-graphite-900 font-bold text-white disabled:opacity-40 dark:bg-graphite-50 dark:text-graphite-900"
              >
                {pending ? 'Aplicando…' : COPY[modo].boton}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
