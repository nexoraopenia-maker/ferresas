'use client'

import { useState, useTransition } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { fechaDiaCorta } from '@/lib/fecha-local'

const money = (n: number) => `S/ ${n.toFixed(2)}`

/** Lo que el recibo necesita de la venta recién cobrada. `credito` solo si se fió (monto, vencimiento AAAA-MM-DD, deuda total). */
export interface ReciboVenta {
  saleId: string
  number: string
  total: number
  credito?: { monto: number; vence: string; deudaCliente: number } | null
}

export const MENSAJE_FACTURA_FIADO = 'La factura de una venta fiada todavía no está disponible: emite boleta.'

/** Tras cobrar: emitir comprobante o seguir vendiendo. */
export function ReciboEmitido({
  recibo,
  onCerrar,
  puedeVerVenta = false,
}: {
  recibo: ReciboVenta
  onCerrar: () => void
  /** Puede ver el historial de ventas (`ventas.cobrar`, `ventas.anular` o `reportes.ver`). */
  puedeVerVenta?: boolean
}) {
  const [doc, setDoc] = useState<{ id: string; fullNumber: string; status: string; isTrial: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendiente, startTransition] = useTransition()
  const enLinea = useEnLinea()

  const emitir = (documentType: 'BOLETA' | 'FACTURA') => {
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    setError(null)
    startTransition(async () => {
      const res = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ saleId: recibo.saleId, documentType }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok) {
        setError(d?.message ?? 'No se pudo emitir el comprobante.')
        return
      }
      setDoc({ id: d.id, fullNumber: d.fullNumber, status: d.status, isTrial: d.isTrial === true })
    })
  }

  return (
    <div className="rounded-2xl border-2 border-stock-ok bg-stock-ok-soft p-4">
      <p className="font-bold text-stock-ok">Venta registrada</p>
      <p className="mt-1 text-sm text-ink">
        <span className="font-mono font-semibold">{recibo.number}</span> ·{' '}
        {money(recibo.total)}
      </p>
      {recibo.credito && (
        <p data-recibo="fiado" className="mt-1 rounded-lg bg-stock-low-soft px-2 py-1 text-sm font-semibold text-stock-low">
          Fiado {money(recibo.credito.monto)} · vence {fechaDiaCorta(recibo.credito.vence)} · deuda total {money(recibo.credito.deudaCliente)}
        </p>
      )}

      {/*
        * El ticket se puede imprimir siempre, incluso antes de decidir si la
        * venta lleva comprobante: en el mostrador el cliente se va con un
        * papel en la mano, y esperar a emitir la boleta lo retiene.
        */}
      <a
        href={`/imprimir/venta/${recibo.saleId}?auto=1`}
        target="_blank"
        rel="noopener"
        className="mt-3 flex h-touch-lg items-center justify-center rounded-xl bg-graphite-900 px-4 font-bold text-white dark:bg-graphite-50 dark:text-graphite-900"
      >
        Imprimir ticket 80 mm
      </a>

      {doc ? (
        <div className="mt-3 rounded-xl bg-surface px-3 py-2">
          {doc.isTrial ? (
            <p className="text-sm text-ink">
              Documento de <b>prueba</b> <span className="font-mono font-bold">{doc.fullNumber}</span>.{' '}
              <span className="font-semibold">Sin valor tributario:</span> no es una boleta ni una factura y no se envía a SUNAT.
            </p>
          ) : (
            <p className="text-sm text-ink">
              Comprobante <span className="font-mono font-bold">{doc.fullNumber}</span>{' '}
              — estado <span className="font-semibold">{doc.status}</span>
            </p>
          )}
          <a
            href={`/imprimir/comprobante/${doc.id}?auto=1`}
            target="_blank"
            rel="noopener"
            className="mt-2 flex h-touch items-center justify-center rounded-lg border border-hairline text-sm font-semibold text-ink"
          >
            Imprimir {doc.fullNumber}
          </a>
        </div>
      ) : (
        <>
          <p className="mt-3 text-sm text-ink-muted">¿Emitir comprobante?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => emitir('BOLETA')} disabled={pendiente || !enLinea}
              className="h-touch-lg flex-1 rounded-xl bg-graphite-900 px-4 font-bold text-white disabled:opacity-40 dark:bg-graphite-50 dark:text-graphite-900">
              {pendiente ? '…' : 'Boleta'}
            </button>
            <button type="button" onClick={() => emitir('FACTURA')} disabled={pendiente || !enLinea || !!recibo.credito}
              title={recibo.credito ? MENSAJE_FACTURA_FIADO : undefined}
              className="h-touch-lg flex-1 rounded-xl border border-graphite-900 px-4 font-bold text-ink disabled:opacity-40 dark:border-graphite-50">
              Factura
            </button>
          </div>
          {recibo.credito && <p data-recibo="sin-factura" className="mt-1 text-xs text-ink-muted">{MENSAJE_FACTURA_FIADO}</p>}
        </>
      )}

      {error && (
        <p role="alert" className="mt-2 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
          {error}
        </p>
      )}

      {puedeVerVenta && (
        <a href={`/ventas/${recibo.saleId}`} data-recibo="ver-venta" className="mt-2 flex h-touch items-center justify-center rounded-lg text-sm font-semibold text-industrial-600 underline">
          Ver esta venta
        </a>
      )}

      <button type="button" onClick={onCerrar}
        className="mt-3 h-touch w-full rounded-xl text-sm font-semibold text-ink-muted">
        Nueva venta
      </button>
    </div>
  )
}
