'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatearFechaLocal } from '@/lib/fecha-local'

export interface TaxDocRow {
  id: string
  fullNumber: string
  documentType: string
  status: string
  statusMessage: string | null
  receiverDocNumber: string | null
  receiverName: string | null
  currency: string
  subtotal: string
  taxTotal: string
  total: string
  issuedAt: string
  saleNumber: string
}

const ESTADO: Record<string, { texto: string; cls: string }> = {
  PENDIENTE: { texto: 'Pendiente', cls: 'bg-stock-low-soft text-stock-low' },
  ENVIADO: { texto: 'Enviado', cls: 'bg-industrial-100 text-industrial-800 dark:bg-industrial-950 dark:text-industrial-300' },
  ACEPTADO: { texto: 'Aceptado', cls: 'bg-stock-ok-soft text-stock-ok' },
  RECHAZADO: { texto: 'Rechazado', cls: 'bg-stock-out-soft text-stock-out' },
  ANULADO: { texto: 'Anulado', cls: 'bg-surface-sunken text-ink-muted' },
}

/** Transiciones permitidas; deben coincidir con las del servicio. */
const SIGUIENTES: Record<string, string[]> = {
  PENDIENTE: ['ENVIADO', 'ACEPTADO', 'RECHAZADO'],
  ENVIADO: ['ACEPTADO', 'RECHAZADO'],
  RECHAZADO: ['ENVIADO', 'ACEPTADO'],
  ACEPTADO: [],
  ANULADO: [],
}

export function TaxDocumentList({
  docs,
  canManage,
  zonaHoraria,
}: {
  docs: TaxDocRow[]
  canManage: boolean
  /** Zona del negocio: ver la nota en CashPanel. */
  zonaHoraria: string
}) {
  const router = useRouter()
  const [editando, setEditando] = useState<TaxDocRow | null>(null)
  const [nuevoEstado, setNuevoEstado] = useState('')
  const [mensaje, setMensaje] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendiente, startTransition] = useTransition()

  const guardar = () => {
    if (!editando) return
    setError(null)
    startTransition(async () => {
      const res = await fetch('/api/invoices/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          taxDocumentId: editando.id,
          status: nuevoEstado,
          statusMessage: mensaje.trim() || undefined,
        }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok) {
        setError(d?.message ?? 'No se pudo actualizar el estado.')
        return
      }
      setEditando(null)
      setMensaje('')
      router.refresh()
    })
  }

  if (docs.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-hairline px-4 py-10 text-center text-sm text-ink-muted">
        Todavía no has emitido comprobantes. Se emiten desde el punto de venta,
        al terminar una venta.
      </p>
    )
  }

  return (
    <>
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="bg-surface-sunken text-left text-ink-muted">
              <tr>
                <th className="px-3 py-2 font-semibold">Comprobante</th>
                <th className="px-3 py-2 font-semibold">Cliente</th>
                <th className="px-3 py-2 font-semibold">Importes</th>
                <th className="px-3 py-2 font-semibold">Estado</th>
                <th className="px-3 py-2 font-semibold">Imprimir</th>
                {canManage && <th className="px-3 py-2 font-semibold">Acción</th>}
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => {
                const e = ESTADO[d.status] ?? { texto: d.status, cls: '' }
                return (
                  <tr key={d.id} className="border-t border-hairline align-top">
                    <td className="px-3 py-3">
                      <p className="font-mono font-bold text-ink">{d.fullNumber}</p>
                      <p className="text-xs text-ink-muted">
                        {d.documentType === 'FACTURA' ? 'Factura' : 'Boleta'} · venta {d.saleNumber}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {formatearFechaLocal(d.issuedAt, zonaHoraria)}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <p className="text-ink">{d.receiverName ?? 'Sin cliente'}</p>
                      {d.receiverDocNumber && (
                        <p className="font-mono text-xs text-ink-muted">{d.receiverDocNumber}</p>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-bold text-ink">{d.currency} {d.total}</p>
                      <p className="text-xs text-ink-muted">
                        base {d.subtotal} · IGV {d.taxTotal}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`rounded-full px-2 py-1 text-xs font-bold ${e.cls}`}>
                        {e.texto}
                      </span>
                      {d.statusMessage && (
                        <p className="mt-1 max-w-[16rem] text-xs text-ink-muted">{d.statusMessage}</p>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {/*
                        * Reimprimir no es una escritura, así que está abierto
                        * a cualquier rol: el cliente que vuelve con el ticket
                        * perdido lo atiende quien esté en el mostrador.
                        */}
                      <a
                        href={`/imprimir/comprobante/${d.id}?auto=1`}
                        target="_blank"
                        rel="noopener"
                        className="h-touch inline-flex items-center rounded-lg border border-hairline px-3 text-sm font-semibold text-ink"
                      >
                        80 mm
                      </a>
                    </td>
                    {canManage && (
                      <td className="px-3 py-3">
                        {SIGUIENTES[d.status]?.length ? (
                          <button
                            type="button"
                            onClick={() => {
                              setEditando(d)
                              setNuevoEstado(SIGUIENTES[d.status]![0]!)
                              setError(null)
                            }}
                            className="h-touch rounded-lg border border-hairline px-3 text-sm font-semibold text-ink"
                          >
                            Cambiar
                          </button>
                        ) : (
                          <span className="text-xs text-ink-muted">Final</span>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editando && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <div className="absolute inset-0 bg-graphite-950/70" onClick={() => setEditando(null)} aria-hidden />
          <div role="dialog" aria-modal="true" className="relative w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl">
            <h2 className="text-lg font-bold text-ink">Estado tributario</h2>
            <p className="mt-1 font-mono text-sm text-ink-muted">{editando.fullNumber}</p>

            <label className="mt-4 flex flex-col gap-1">
              <span className="text-sm font-medium text-ink-muted">Nuevo estado</span>
              <select value={nuevoEstado} onChange={(e) => setNuevoEstado(e.target.value)}
                className="h-touch-lg rounded-xl border border-hairline bg-surface px-4 text-base text-ink">
                {SIGUIENTES[editando.status]!.map((s) => (
                  <option key={s} value={s}>{ESTADO[s]?.texto ?? s}</option>
                ))}
              </select>
            </label>

            <label className="mt-3 flex flex-col gap-1">
              <span className="text-sm font-medium text-ink-muted">
                Observación {nuevoEstado === 'RECHAZADO' ? '(el motivo del rechazo)' : '(opcional)'}
              </span>
              <textarea value={mensaje} onChange={(e) => setMensaje(e.target.value)} rows={2}
                className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink" />
            </label>

            {error && (
              <p role="alert" className="mt-2 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setEditando(null)}
                className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink">
                Cancelar
              </button>
              <button type="button" onClick={guardar} disabled={pendiente}
                className="h-touch-lg flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">
                {pendiente ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
