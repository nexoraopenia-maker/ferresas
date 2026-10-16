'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatQuantity, unitLabel } from '@/lib/quantity'
import { formatearFechaLocal } from '@/lib/fecha-local'
import {
  approveTransfer, receiveTransfer, rejectTransfer, shipTransfer,
} from '../actions'

export interface TransferItemRow {
  id: string
  nombre: string
  sku: string
  unitType: string
  enviado: number
  recibido: number | null
}

export interface TransferRow {
  id: string
  number: string
  status: string
  origen: string
  destino: string
  esMiOrigen: boolean
  esMiDestino: boolean
  solicitadaPor: string
  requestedAt: string
  notes: string | null
  rejectReason: string | null
  items: TransferItemRow[]
}

const ESTADO: Record<string, { texto: string; cls: string }> = {
  BORRADOR: { texto: 'Borrador', cls: 'bg-surface-sunken text-ink-muted' },
  SOLICITADA: { texto: 'Solicitada', cls: 'bg-stock-low-soft text-stock-low' },
  APROBADA: { texto: 'Aprobada', cls: 'bg-industrial-100 text-industrial-800 dark:bg-industrial-950 dark:text-industrial-300' },
  EN_TRANSITO: { texto: 'En camino', cls: 'bg-industrial-100 text-industrial-800 dark:bg-industrial-950 dark:text-industrial-300' },
  RECIBIDA: { texto: 'Recibida', cls: 'bg-stock-ok-soft text-stock-ok' },
  RECHAZADA: { texto: 'Rechazada', cls: 'bg-stock-out-soft text-stock-out' },
  CANCELADA: { texto: 'Cancelada', cls: 'bg-surface-sunken text-ink-muted' },
}

/**
 * Transferencias entre sucursales.
 *
 * Los botones dependen del estado Y de si el usuario está en el origen o en
 * el destino: despachar desde un local en el que no estás es cómo se declara
 * enviada mercadería que nadie subió a la camioneta.
 */
export function TransferList({
  transferencias,
  puedeAprobar,
  puedeOperar,
  zonaHoraria,
}: {
  transferencias: TransferRow[]
  puedeAprobar: boolean
  puedeOperar: boolean
  /** Zona del negocio: ver la nota en CashPanel. */
  zonaHoraria: string
}) {
  const router = useRouter()
  const [recibiendo, setRecibiendo] = useState<TransferRow | null>(null)
  const [rechazando, setRechazando] = useState<TransferRow | null>(null)
  const [conteo, setConteo] = useState<Record<string, string>>({})
  const [motivo, setMotivo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const correr = (fn: () => Promise<{ ok: boolean; message?: string }>, alCerrar?: () => void) => {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) { setError(res.message ?? 'No se pudo completar.'); return }
      alCerrar?.()
      router.refresh()
    })
  }

  const abrirRecepcion = (t: TransferRow) => {
    setRecibiendo(t)
    setError(null)
    // Se precarga con lo despachado: lo normal es que llegue todo, y obligar
    // a teclear cada línea desde cero invitaría a confirmar sin contar.
    setConteo(Object.fromEntries(t.items.map((i) => [i.id, String(i.enviado)])))
  }

  if (transferencias.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-hairline px-4 py-10 text-center text-sm text-ink-muted">
        No hay transferencias. Se crean desde el inventario, pidiendo
        mercadería a otra sucursal.
      </p>
    )
  }

  return (
    <>
      {error && !recibiendo && !rechazando && (
        <p role="alert" className="rounded-xl bg-stock-out-soft px-4 py-3 text-sm font-semibold text-stock-out">
          {error}
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {transferencias.map((t) => {
          const e = ESTADO[t.status] ?? { texto: t.status, cls: '' }
          return (
            <li key={t.id} className="rounded-2xl border border-hairline bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono font-bold text-ink">{t.number}</p>
                  <p className="text-sm text-ink">
                    {t.origen} <span className="text-ink-muted">→</span> {t.destino}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {t.items.length} {t.items.length === 1 ? 'línea' : 'líneas'} ·{' '}
                    {t.solicitadaPor} ·{' '}
                    {formatearFechaLocal(t.requestedAt, zonaHoraria, 'es-PE', { conHora: false })}
                  </p>
                  {t.rejectReason && (
                    <p className="mt-1 text-xs font-semibold text-stock-out">
                      Rechazada: {t.rejectReason}
                    </p>
                  )}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-bold ${e.cls}`}>
                  {e.texto}
                </span>
              </div>

              <ul className="mt-3 flex flex-col gap-1 border-t border-hairline pt-2">
                {t.items.map((i) => (
                  <li key={i.id} className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-ink">{i.nombre}</span>
                    <span className="shrink-0 font-mono text-ink-muted">
                      {formatQuantity(i.enviado, i.unitType)} {unitLabel(i.unitType)}
                      {i.recibido !== null && i.recibido !== i.enviado && (
                        <span className="font-bold text-stock-out">
                          {' '}→ llegó {formatQuantity(i.recibido, i.unitType)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              {puedeOperar && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {t.status === 'SOLICITADA' && puedeAprobar && (
                    <button
                      type="button"
                      onClick={() => correr(() => approveTransfer({ transferId: t.id }))}
                      disabled={pending}
                      className="h-touch rounded-lg bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-40"
                    >
                      Aprobar
                    </button>
                  )}
                  {t.status === 'APROBADA' && t.esMiOrigen && (
                    <button
                      type="button"
                      onClick={() => correr(() => shipTransfer({ transferId: t.id }))}
                      disabled={pending}
                      className="h-touch rounded-lg bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-40"
                    >
                      Despachar
                    </button>
                  )}
                  {t.status === 'EN_TRANSITO' && t.esMiDestino && (
                    <>
                      <button
                        type="button"
                        onClick={() => abrirRecepcion(t)}
                        className="h-touch rounded-lg bg-industrial-600 px-4 text-sm font-bold text-white"
                      >
                        Recibir y contar
                      </button>
                      <button
                        type="button"
                        onClick={() => { setRechazando(t); setMotivo(''); setError(null) }}
                        className="h-touch rounded-lg border border-stock-out/40 px-4 text-sm font-semibold text-stock-out"
                      >
                        Rechazar
                      </button>
                    </>
                  )}
                  {t.status === 'APROBADA' && !t.esMiOrigen && (
                    <p className="text-xs text-ink-muted">
                      Pendiente de que {t.origen} la despache.
                    </p>
                  )}
                  {t.status === 'EN_TRANSITO' && !t.esMiDestino && (
                    <p className="text-xs text-ink-muted">
                      En camino a {t.destino}. La recibe quien esté allí.
                    </p>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {/* ───────── Recepción con conteo ───────── */}
      {recibiendo && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <div className="absolute inset-0 bg-graphite-950/70" onClick={() => setRecibiendo(null)} aria-hidden />
          <div role="dialog" aria-modal="true"
            className="relative max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-2xl bg-surface p-5 shadow-2xl">
            <h2 className="text-lg font-bold text-ink">Recibir {recibiendo.number}</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Cuenta lo que llegó de verdad. Si falta algo, déjalo registrado
              aquí: el faltante queda trazado contra esta transferencia en vez
              de aparecer semanas después como un descuadre sin origen.
            </p>

            <ul className="mt-4 flex flex-col gap-3">
              {recibiendo.items.map((i) => (
                <li key={i.id}>
                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-ink">{i.nombre}</span>
                    <span className="text-xs text-ink-muted">
                      Despachado: {formatQuantity(i.enviado, i.unitType)} {unitLabel(i.unitType)}
                    </span>
                    <input
                      inputMode="decimal"
                      value={conteo[i.id] ?? ''}
                      onChange={(ev) => setConteo((p) => ({ ...p, [i.id]: ev.target.value }))}
                      className="h-touch-lg rounded-xl border border-hairline bg-surface px-3 text-base font-bold text-ink"
                    />
                  </label>
                </li>
              ))}
            </ul>

            {error && (
              <p role="alert" className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setRecibiendo(null)}
                className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink">
                Cancelar
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  correr(
                    () => receiveTransfer({
                      transferId: recibiendo.id,
                      items: recibiendo.items.map((i) => ({
                        itemId: i.id,
                        quantityReceived: Number((conteo[i.id] ?? '0').replace(',', '.')),
                      })),
                    }),
                    () => setRecibiendo(null),
                  )
                }
                className="h-touch-lg flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40"
              >
                {pending ? 'Recibiendo…' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ───────── Rechazo ───────── */}
      {rechazando && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <div className="absolute inset-0 bg-graphite-950/70" onClick={() => setRechazando(null)} aria-hidden />
          <div role="dialog" aria-modal="true"
            className="relative w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl">
            <h2 className="text-lg font-bold text-ink">Rechazar {rechazando.number}</h2>
            <p className="mt-1 text-sm text-ink-muted">
              La mercadería vuelve al stock de {rechazando.origen}.
            </p>

            <label className="mt-4 flex flex-col gap-1">
              <span className="text-sm font-medium text-ink-muted">Motivo</span>
              <textarea
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                rows={3}
                placeholder="Llegó el producto equivocado"
                className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink"
              />
            </label>

            {error && (
              <p role="alert" className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setRechazando(null)}
                className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink">
                Cancelar
              </button>
              <button
                type="button"
                disabled={pending || motivo.trim().length < 5}
                onClick={() =>
                  correr(
                    () => rejectTransfer({ transferId: rechazando.id, reason: motivo }),
                    () => setRechazando(null),
                  )
                }
                className="h-touch-lg flex-1 rounded-xl bg-stock-out font-bold text-white disabled:opacity-40"
              >
                {pending ? 'Rechazando…' : 'Rechazar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
