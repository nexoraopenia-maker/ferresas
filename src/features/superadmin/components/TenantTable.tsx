'use client'

import { useMemo, useState } from 'react'
import { describirAntiguedad } from '@/features/invoicing/alarma-envio'
import { ETIQUETA_MODO, type ModoFiscal } from '@/features/invoicing/modo-fiscal'
import { TenantActions } from './TenantActions'
import { BillingPanel, EstadoChip, type BillingData, type PlanOpcion } from './BillingPanel'

export interface TenantTableRow extends BillingData {
  slug: string
  ownerEmail: string | null
  ownerName: string | null
  billingEmail: string | null
  phone: string | null
  taxId: string | null
  legalName: string | null
  access: string
  isActive: boolean
  suspendedReason: string | null
  modoFiscal: ModoFiscal
  isDemo: boolean
  envioFiscal: { sinEnviar: number; agotados: number; masAntiguoHoras: number | null; nivel: 'ok' | 'aviso' | 'critico'; avisoHoras: number; criticoHoras: number; avisoPropio: number | null; criticoPropio: number | null }
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

/** Filtros rápidos. El predicado vive junto a la etiqueta para que no divergan. */
const FILTROS = [
  { id: 'todas', label: 'Todas', test: () => true },
  { id: 'trial', label: 'En prueba', test: (t: TenantTableRow) => t.status === 'TRIALING' },
  { id: 'activas', label: 'Activas', test: (t: TenantTableRow) => t.status === 'ACTIVE' && t.isActive },
  { id: 'mora', label: 'En mora', test: (t: TenantTableRow) => t.status === 'PAST_DUE' },
  { id: 'solo-lectura', label: 'Solo lectura', test: (t: TenantTableRow) => t.access === 'READ_ONLY' },
  { id: 'suspendidas', label: 'Suspendidas', test: (t: TenantTableRow) => !t.isActive },
  { id: 'sin-pasarela', label: 'Sin pasarela', test: (t: TenantTableRow) => !t.gatewayLinked },
] as const

type FiltroId = (typeof FILTROS)[number]['id']

/**
 * Normaliza para buscar: minúsculas y sin tildes.
 *
 * Sin esto, buscar "ferreteria" no encontraría "Ferretería" — y nadie teclea
 * las tildes en un buscador.
 */
function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

/**
 * Tabla de gestión de clientes.
 *
 * El filtrado es en CLIENTE, sobre los datos que la página ya cargó. Con
 * decenas o unos cientos de ferreterías es instantáneo y no cuesta un viaje
 * a Neon por cada tecla. Cuando la lista pase del millar habrá que moverlo al
 * servidor con parámetros en la URL; mientras tanto, esto es más rápido para
 * quien lo usa y más simple de mantener.
 */
export function TenantTable({
  rows,
  plans,
}: {
  rows: TenantTableRow[]
  plans: PlanOpcion[]
}) {
  const [facturacion, setFacturacion] = useState<TenantTableRow | null>(null)
  const [busqueda, setBusqueda] = useState('')
  const [filtro, setFiltro] = useState<FiltroId>('todas')

  // Conteo por filtro, para que las pastillas muestren cuántas hay en cada
  // estado sin tener que aplicarlas una por una.
  const conteos = useMemo(() => {
    const m = {} as Record<FiltroId, number>
    for (const f of FILTROS) m[f.id] = rows.filter((r) => f.test(r)).length
    return m
  }, [rows])

  const visibles = useMemo(() => {
    const q = normalizar(busqueda.trim())
    const predicado = FILTROS.find((f) => f.id === filtro)!.test

    return rows.filter((t) => {
      if (!predicado(t)) return false
      if (!q) return true

      // Se busca en todo lo que alguien usaría para identificar a un cliente
      // al teléfono: nombre, razón social, slug, correo del dueño, correo de
      // facturación, RUC y teléfono.
      return [
        t.tenantName, t.legalName, t.slug, t.ownerEmail,
        t.ownerName, t.billingEmail, t.taxId, t.phone,
      ].some((campo) => campo && normalizar(campo).includes(q))
    })
  }, [rows, busqueda, filtro])

  return (
    <>
      {/* --- Buscador y filtros ----------------------------------------- */}
      <div className="flex flex-col gap-3 border-b border-hairline p-4">
        <div className="relative">
          <input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre, correo, RUC o teléfono…"
            aria-label="Buscar ferreterías"
            className="h-touch-lg w-full rounded-xl border border-hairline bg-surface pl-4 pr-20 text-base text-ink placeholder:text-ink-muted focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
          />
          {busqueda && (
            <button
              type="button"
              onClick={() => setBusqueda('')}
              className="absolute right-2 top-1/2 h-touch -translate-y-1/2 rounded-lg px-3 text-sm font-semibold text-ink-muted"
            >
              Limpiar
            </button>
          )}
        </div>

        <div role="group" aria-label="Filtros rápidos" className="flex flex-wrap gap-2">
          {FILTROS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filtro === f.id}
              onClick={() => setFiltro(f.id)}
              // Un filtro con cero resultados se deshabilita en vez de
              // ocultarse: desaparecer haría dudar de si existe.
              disabled={conteos[f.id] === 0 && f.id !== 'todas'}
              className={`h-touch rounded-full px-3 text-sm font-bold transition disabled:opacity-30 ${
                filtro === f.id
                  ? 'bg-graphite-900 text-white dark:bg-graphite-50 dark:text-graphite-900'
                  : 'border border-hairline text-ink'
              }`}
            >
              {f.label}
              <span className={filtro === f.id ? 'ml-1.5 opacity-70' : 'ml-1.5 text-ink-muted'}>
                {conteos[f.id]}
              </span>
            </button>
          ))}
        </div>

        {(busqueda || filtro !== 'todas') && (
          <p className="text-sm text-ink-muted">
            {visibles.length} de {rows.length} ferreterías
            {busqueda && <> · búsqueda «{busqueda}»</>}
          </p>
        )}
      </div>

      {/* --- Tabla ------------------------------------------------------- */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="bg-surface-sunken text-left text-ink-muted">
            <tr>
              <Th>Ferretería y contacto</Th>
              <Th>Plan y cobro</Th>
              <Th>Suscripción</Th>
              <Th>Acceso</Th>
              <Th>Uso</Th>
              <Th>Gestión</Th>
            </tr>
          </thead>
          <tbody>
            {visibles.map((t) => (
              <tr key={t.tenantId} className="border-t border-hairline align-top">
                <td className="px-3 py-3">
                  <p className="font-semibold text-ink">{t.tenantName}</p>
                  {t.legalName && (
                    <p className="text-xs text-ink-muted">{t.legalName}</p>
                  )}
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
                  {t.modoFiscal !== 'DEMO' && (
                    <p className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-bold ${
                      t.envioFiscal.nivel === 'critico' ? 'bg-stock-out-soft text-stock-out'
                      : t.envioFiscal.nivel === 'aviso' ? 'bg-stock-low-soft text-stock-low'
                      : t.modoFiscal === 'ENSAYO' ? 'bg-surface-sunken text-ink-muted' : 'bg-stock-ok-soft text-stock-ok'}`}>
                      Facturación: {ETIQUETA_MODO[t.modoFiscal]}
                      {t.envioFiscal.sinEnviar > 0 && t.envioFiscal.masAntiguoHoras !== null &&
                        ` · ${t.envioFiscal.sinEnviar} sin enviar, el más antiguo ${describirAntiguedad(t.envioFiscal.masAntiguoHoras)}`}
                      {t.envioFiscal.agotados > 0 && ` · ${t.envioFiscal.agotados} AGOTADO${t.envioFiscal.agotados === 1 ? '' : 'S'}`}
                    </p>
                  )}
                  {!t.isActive && t.suspendedReason && (
                    <p className="mt-1.5 max-w-xs rounded bg-stock-out-soft px-2 py-1 text-xs font-semibold text-stock-out">
                      Suspendida: {t.suspendedReason}
                    </p>
                  )}
                </td>

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
                  <TenantActions
                    tenantId={t.tenantId}
                    tenantName={t.tenantName}
                    isActive={t.isActive}
                    modoFiscal={t.modoFiscal}
                    umbrales={t.envioFiscal}
                    perfil={{
                      name: t.tenantName,
                      legalName: t.legalName,
                      taxId: t.taxId,
                      phone: t.phone,
                      email: t.billingEmail,
                    }}
                    onFacturacion={() => setFacturacion(t)}
                  />
                </td>
              </tr>
            ))}

            {visibles.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-ink-muted">
                  {rows.length === 0 ? (
                    <>Todavía no hay ferreterías. Usa «Nueva ferretería».</>
                  ) : (
                    <>
                      Ninguna coincide con el filtro.{' '}
                      <button
                        type="button"
                        onClick={() => { setBusqueda(''); setFiltro('todas') }}
                        className="font-semibold text-industrial-700 underline dark:text-industrial-400"
                      >
                        Ver todas
                      </button>
                    </>
                  )}
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

/** Una línea que explique el estado sin tener que abrir nada. */
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
