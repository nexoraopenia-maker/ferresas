'use client'

import { useState } from 'react'
import { TenantActions } from './TenantActions'
import { BillingPanel, EstadoChip, type BillingData, type PlanOpcion } from './BillingPanel'

export interface TenantTableRow extends BillingData {
  slug: string
  ownerEmail: string | null
  ownerName: string | null
  billingEmail: string | null
  phone: string | null
  taxId: string | null
  access: string
  isActive: boolean
  suspendedReason: string | null
  users: number
  products: number
  createdAt: string
}

const ACCESO: Record<string, string> = {
  FULL: 'bg-stock-ok-soft text-stock-ok',
  WARN: 'bg-stock-low-soft text-stock-low',
  READ_ONLY: 'bg-stock-out-soft text-stock-out',
  BLOCKED: 'bg-graphite-900 text-graphite-50',
}

/**
 * Tabla de gestión de clientes.
 *
 * Se renderiza en el cliente porque el panel de facturación necesita estado
 * local (qué fila está abierta). Los datos llegan ya resueltos del servidor:
 * aquí no hay ninguna consulta.
 *
 * El contacto va en la misma celda que el nombre y no en columnas propias:
 * con ocho columnas más tres de contacto, la tabla deja de leerse incluso en
 * escritorio, y el caso de uso real —"necesito llamar a este cliente"— se
 * resuelve igual de bien con el dato debajo del nombre.
 */
export function TenantTable({
  rows,
  plans,
}: {
  rows: TenantTableRow[]
  plans: PlanOpcion[]
}) {
  const [facturacion, setFacturacion] = useState<TenantTableRow | null>(null)

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[60rem] text-sm">
          <thead className="bg-surface-sunken text-left text-ink-muted">
            <tr>
              <Th>Ferretería y contacto</Th>
              <Th>Plan y cobro</Th>
              <Th>Suscripción</Th>
              <Th>Acceso</Th>
              <Th>Uso</Th>
              <Th>Acciones</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.tenantId} className="border-t border-hairline align-top">
                {/* --- Contacto --- */}
                <td className="px-3 py-3">
                  <p className="font-semibold text-ink">{t.tenantName}</p>
                  <p className="font-mono text-xs text-ink-muted">{t.slug}</p>
                  <dl className="mt-1.5 flex flex-col gap-0.5 text-xs">
                    {t.ownerEmail && (
                      <Contacto etiqueta="Dueño">
                        <a href={`mailto:${t.ownerEmail}`} className="underline decoration-dotted">
                          {t.ownerEmail}
                        </a>
                        {t.ownerName && <span className="text-ink-muted"> · {t.ownerName}</span>}
                      </Contacto>
                    )}
                    {t.phone && (
                      <Contacto etiqueta="Tel">
                        <a href={`tel:${t.phone}`} className="underline decoration-dotted">{t.phone}</a>
                      </Contacto>
                    )}
                    {t.taxId && <Contacto etiqueta="RUC">{t.taxId}</Contacto>}
                    {t.billingEmail && t.billingEmail !== t.ownerEmail && (
                      <Contacto etiqueta="Facturación">{t.billingEmail}</Contacto>
                    )}
                    {!t.phone && !t.taxId && (
                      <span className="text-ink-muted">Sin teléfono ni RUC</span>
                    )}
                  </dl>
                  {!t.isActive && t.suspendedReason && (
                    <p className="mt-1.5 max-w-xs rounded bg-stock-out-soft px-2 py-1 text-xs font-semibold text-stock-out">
                      Suspendida: {t.suspendedReason}
                    </p>
                  )}
                </td>

                {/* --- Plan y cobro --- */}
                <td className="px-3 py-3">
                  <p className="font-semibold text-ink">{t.planName ?? '—'}</p>
                  <p className="text-base font-bold text-industrial-700 dark:text-industrial-400">
                    {t.priceMonthly ? `${t.currency} ${t.priceMonthly}` : '—'}
                    <span className="text-xs font-normal text-ink-muted">/mes</span>
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {t.gatewayLinked ? (t.provider ?? '—') : 'Alta manual'}
                  </p>
                  {t.lastPaymentAmount && (
                    <p className="text-xs text-ink-muted">
                      Último: {t.currency} {t.lastPaymentAmount}
                    </p>
                  )}
                </td>

                {/* --- Suscripción --- */}
                <td className="px-3 py-3">
                  <EstadoChip status={t.status} />
                  <p className="mt-1.5 text-xs text-ink-muted">{detalleEstado(t)}</p>
                </td>

                <td className="px-3 py-3">
                  <span className={`rounded-full px-2 py-1 text-xs font-bold ${ACCESO[t.access] ?? ''}`}>
                    {t.access}
                  </span>
                </td>

                <td className="px-3 py-3 text-xs text-ink">
                  <p>{t.users} usuario{t.users === 1 ? '' : 's'}</p>
                  <p>{t.products} producto{t.products === 1 ? '' : 's'}</p>
                  <p className="mt-0.5 text-ink-muted">
                    Alta {new Date(t.createdAt).toLocaleDateString('es-PE')}
                  </p>
                </td>

                <td className="px-3 py-3">
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => setFacturacion(t)}
                      className="h-touch rounded-lg bg-industrial-600 px-3 text-sm font-bold text-white"
                    >
                      Facturación
                    </button>
                    <TenantActions
                      tenantId={t.tenantId}
                      tenantName={t.tenantName}
                      isActive={t.isActive}
                    />
                  </div>
                </td>
              </tr>
            ))}

            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-ink-muted">
                  Todavía no hay ferreterías registradas. Usa «Nueva ferretería»
                  para dar de alta la primera.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {facturacion && (
        <BillingPanel
          data={facturacion}
          plans={plans}
          onClose={() => setFacturacion(null)}
        />
      )}
    </>
  )
}

/** Una línea que explique el estado sin tener que abrir el panel. */
function detalleEstado(t: TenantTableRow): string {
  const f = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('es-PE', { day: '2-digit', month: 'short' }) : '—'

  if (t.status === 'TRIALING' && t.trialEndsAt) {
    const dias = Math.ceil((new Date(t.trialEndsAt).getTime() - Date.now()) / 86400000)
    return dias > 0 ? `Quedan ${dias} d (hasta ${f(t.trialEndsAt)})` : `Vencida el ${f(t.trialEndsAt)}`
  }
  if (t.status === 'ACTIVE') {
    return t.cancelAtPeriodEnd
      ? `Cancela el ${f(t.currentPeriodEnd)}`
      : `Renueva el ${f(t.currentPeriodEnd)}`
  }
  if (t.status === 'PAST_DUE' && t.pastDueSince && t.graceDays !== null) {
    const limite = new Date(t.pastDueSince).getTime() + t.graceDays * 86400000
    const quedan = Math.ceil((limite - Date.now()) / 86400000)
    return quedan > 0
      ? `Desde ${f(t.pastDueSince)} · ${quedan} d de gracia`
      : `Desde ${f(t.pastDueSince)} · gracia agotada`
  }
  if (t.status === 'CANCELED') return 'Sin suscripción activa'
  return '—'
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-semibold">{children}</th>
}

function Contacto({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1">
      <dt className="shrink-0 text-ink-muted">{etiqueta}:</dt>
      <dd className="min-w-0 truncate text-ink">{children}</dd>
    </div>
  )
}
