'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

export interface PlanOpcion {
  code: string
  name: string
  priceMonthly: string
  currency: string
}

export interface BillingData {
  tenantId: string
  tenantName: string
  planCode: string | null
  planName: string | null
  priceMonthly: string | null
  currency: string
  status: string
  provider: string | null
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  pastDueSince: string | null
  graceDays: number | null
  lastPaymentAt: string | null
  lastPaymentAmount: string | null
  cancelAtPeriodEnd: boolean
  gatewayLinked: boolean
}

/**
 * Detalle y gestión de la suscripción de un cliente.
 *
 * Deja claro de dónde sale cada cifra: lo que el cliente PUEDE hacer lo
 * gobierna el plan de nuestra base; lo que se le COBRA vive en la pasarela y
 * lo mueve su webhook. Cambiar el plan aquí no mueve el cobro, y la UI lo
 * dice en vez de dejar que el operador lo suponga.
 */
export function BillingPanel({
  data,
  plans,
  onClose,
}: {
  data: BillingData
  plans: PlanOpcion[]
  onClose: () => void
}) {
  const router = useRouter()
  const [modo, setModo] = useState<'ver' | 'plan' | 'trial'>('ver')
  const [planCode, setPlanCode] = useState(data.planCode ?? plans[0]?.code ?? '')
  const [dias, setDias] = useState(14)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const ejecutar = () => {
    setError(null)
    setAviso(null)
    startTransition(async () => {
      const cuerpo =
        modo === 'plan'
          ? { action: 'change-plan', tenantId: data.tenantId, planCode, reason }
          : { action: 'extend-trial', tenantId: data.tenantId, days: dias, reason }

      const res = await fetch('/api/tenants/billing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(cuerpo),
      })

      const d = await res.json().catch(() => null)
      if (!res.ok) {
        setError(d?.message ?? 'No se pudo aplicar el cambio.')
        return
      }

      if (d?.gatewaySyncPending) {
        setAviso(
          `Plan cambiado a ${d.planName}. OJO: el cobro en ${data.provider ?? 'la pasarela'} ` +
            'sigue siendo el anterior — ajústalo allí o el cliente pagará lo viejo.',
        )
      }
      setModo('ver')
      setReason('')
      router.refresh()
    })
  }

  const fecha = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

  const diasMora =
    data.pastDueSince && data.graceDays !== null
      ? Math.max(
          Math.ceil(
            (new Date(data.pastDueSince).getTime() + data.graceDays * 86400000 - Date.now()) / 86400000,
          ),
          0,
        )
      : null

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
      <div className="absolute inset-0 bg-graphite-950/70" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className="relative my-8 w-full max-w-lg rounded-2xl bg-surface p-5 shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold text-ink">{data.tenantName}</h2>
            <p className="text-sm text-ink-muted">Suscripción y cobro</p>
          </div>
          <EstadoChip status={data.status} />
        </header>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-surface-sunken p-4 text-sm">
          <Fila label="Plan" value={data.planName ?? '—'} />
          <Fila
            label="Pago mensual"
            value={data.priceMonthly ? `${data.currency} ${data.priceMonthly}` : '—'}
            destacado
          />
          <Fila label="Pasarela" value={data.gatewayLinked ? (data.provider ?? '—') : 'Alta manual'} />
          <Fila
            label="Último pago"
            value={
              data.lastPaymentAmount
                ? `${data.currency} ${data.lastPaymentAmount} · ${fecha(data.lastPaymentAt)}`
                : 'Sin pagos'
            }
          />
          {data.status === 'TRIALING' && (
            <Fila label="Prueba hasta" value={fecha(data.trialEndsAt)} />
          )}
          {data.status === 'ACTIVE' && (
            <Fila label="Renueva el" value={fecha(data.currentPeriodEnd)} />
          )}
          {data.status === 'PAST_DUE' && (
            <Fila
              label="En mora desde"
              value={`${fecha(data.pastDueSince)}${diasMora !== null ? ` · ${diasMora} d de gracia` : ''}`}
            />
          )}
          {data.cancelAtPeriodEnd && (
            <Fila label="Cancelación" value={`Al terminar el período (${fecha(data.currentPeriodEnd)})`} />
          )}
        </dl>

        {!data.gatewayLinked && (
          <p className="mt-3 rounded-xl bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
            Esta cuenta no está ligada a ninguna pasarela: se dio de alta a mano
            y no se le cobra automáticamente.
          </p>
        )}

        {aviso && (
          <p role="status" className="mt-3 rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
            {aviso}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
            {error}
          </p>
        )}

        {modo === 'ver' ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => setModo('plan')}
              className="h-touch-lg flex-1 rounded-xl bg-graphite-900 px-4 text-sm font-bold text-white dark:bg-graphite-50 dark:text-graphite-900">
              Cambiar plan
            </button>
            {data.status !== 'ACTIVE' && (
              <button type="button" onClick={() => setModo('trial')}
                className="h-touch-lg flex-1 rounded-xl border border-hairline px-4 text-sm font-bold text-ink">
                Extender prueba
              </button>
            )}
            <button type="button" onClick={onClose}
              className="h-touch-lg rounded-xl px-4 text-sm font-semibold text-ink-muted">
              Cerrar
            </button>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3 border-t border-hairline pt-4">
            {modo === 'plan' ? (
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-ink-muted">Plan nuevo</span>
                <select value={planCode} onChange={(e) => setPlanCode(e.target.value)}
                  className="h-touch-lg rounded-xl border border-hairline bg-surface px-4 text-base text-ink">
                  {plans.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.name} — {p.currency} {p.priceMonthly}/mes
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-ink-muted">Días a añadir (1–90)</span>
                <input type="number" min={1} max={90} value={dias}
                  onChange={(e) => setDias(Number(e.target.value) || 1)}
                  className="h-touch-lg rounded-xl border border-hairline bg-surface px-4 text-base text-ink" />
              </label>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-ink-muted">
                Motivo (obligatorio, queda auditado)
              </span>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
                placeholder={modo === 'plan'
                  ? 'Ej. Negoció plan Pro al precio de Básico hasta enero'
                  : 'Ej. Tuvo caída de internet toda la semana de prueba'}
                className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink" />
            </label>

            <div className="flex gap-2">
              <button type="button" onClick={() => { setModo('ver'); setReason(''); setError(null) }}
                className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink">
                Volver
              </button>
              <button type="button" onClick={ejecutar}
                disabled={pending || reason.trim().length < 10 || (modo === 'plan' && !planCode)}
                className="h-touch-lg flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">
                {pending ? 'Aplicando…' : 'Aplicar'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const ESTADO: Record<string, { texto: string; cls: string }> = {
  ACTIVE: { texto: 'Activo', cls: 'bg-stock-ok-soft text-stock-ok' },
  TRIALING: { texto: 'En prueba', cls: 'bg-industrial-100 text-industrial-800 dark:bg-industrial-950 dark:text-industrial-300' },
  PAST_DUE: { texto: 'En mora', cls: 'bg-stock-low-soft text-stock-low' },
  CANCELED: { texto: 'Cancelado', cls: 'bg-stock-out-soft text-stock-out' },
}

export function EstadoChip({ status }: { status: string }) {
  const e = ESTADO[status] ?? { texto: status, cls: 'bg-surface-sunken text-ink-muted' }
  return (
    <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${e.cls}`}>
      {e.texto}
    </span>
  )
}

function Fila({ label, value, destacado }: { label: string; value: string; destacado?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className={`truncate font-semibold ${destacado ? 'text-industrial-700 dark:text-industrial-400' : 'text-ink'}`}>
        {value}
      </dd>
    </div>
  )
}
