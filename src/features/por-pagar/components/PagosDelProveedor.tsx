'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { fechaDiaCorta } from '@/lib/fecha-local'
import { anularPagoProveedor } from '../actions'
import type { PagoDeProveedor } from '../informes'

const money = (n: number) => `S/ ${n.toFixed(2)}`
const METODO: Record<string, string> = {
  EFECTIVO: 'Efectivo', TRANSFERENCIA: 'Transferencia', YAPE: 'Yape', PLIN: 'Plin', TARJETA_DEBITO: 'T. débito', TARJETA_CREDITO: 'T. crédito', OTRO: 'Otro',
}

export const MENSAJE_PAGO_TURNO_CERRADO = 'Su turno de caja ya cerró: un turno cerrado no se modifica.'

/**
 * Los últimos pagos a un proveedor: cuánto, con qué, quién, el voucher y —solo con `proveedores.pagar`— anularlos con motivo. Un pago de
 * un turno ya cerrado no se ofrece para anular (el servidor lo rechazaría: el arqueo firmado no se reescribe) y la pantalla lo dice.
 */
export function PagosDelProveedor({ pagos, puedePagar, puedeOperar }: { pagos: readonly PagoDeProveedor[]; puedePagar: boolean; puedeOperar: boolean }) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [anulando, setAnulando] = useState<string | null>(null)
  const [motivo, setMotivo] = useState('')
  const [error, setError] = useState<string | null>(null)

  const confirmar = (paymentId: string) => {
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    setError(null)
    startTransition(async () => {
      const r = await anularPagoProveedor({ paymentId, motivo })
      if (!r.ok) { setError(r.message); return }
      setAnulando(null); setMotivo(''); router.refresh()
    })
  }

  return (
    <section aria-label="Pagos" className="flex flex-col gap-2">
      <h2 className="text-lg font-bold text-ink">Pagos</h2>
      {pagos.length === 0 ? (
        <p data-lista="sin-pagos" className="text-sm text-ink-muted">Todavía no le has pagado a este proveedor.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {pagos.map((p) => (
            <li key={p.id} data-pago={p.id} className="flex flex-col gap-2 rounded-2xl border border-hairline bg-surface px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className={`font-semibold ${p.anulado ? 'text-ink-muted line-through' : 'text-ink'}`}>{METODO[p.metodo] ?? p.metodo}{p.referencia ? ` · ${p.referencia}` : ''}</p>
                  <p className="text-xs text-ink-muted">{fechaDiaCorta(p.fecha)} · {p.pagadoPor}{p.anulado ? ` · ANULADO: ${p.motivoAnulacion ?? ''}` : ''}</p>
                </div>
                <p className={`font-bold tabular-nums ${p.anulado ? 'text-ink-muted line-through' : 'text-ink'}`}>{money(p.monto)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a href={`/imprimir/pago-proveedor/${p.id}`} target="_blank" rel="noopener" data-enlace="voucher" className="inline-flex h-10 items-center rounded-xl border border-hairline px-3 text-sm font-semibold text-ink">Voucher</a>
                {puedePagar && !p.anulado && p.anulable && (
                  <button type="button" data-boton="anular-pago" onClick={() => setAnulando(anulando === p.id ? null : p.id)} disabled={!puedeOperar}
                    className="h-10 rounded-xl border border-hairline px-3 text-sm font-semibold text-ink disabled:opacity-40">Anular pago</button>
                )}
                {puedePagar && !p.anulado && !p.anulable && <span data-aviso="turno-cerrado" className="self-center text-xs text-ink-muted">{MENSAJE_PAGO_TURNO_CERRADO}</span>}
              </div>
              {anulando === p.id && (
                <form data-form="anular-pago" onSubmit={(e) => { e.preventDefault(); confirmar(p.id) }} className="flex flex-col gap-2 rounded-xl border-2 border-stock-low p-3">
                  <p className="text-sm text-ink">Anular el pago de {money(p.monto)} devuelve la deuda al proveedor{p.metodo === 'EFECTIVO' ? ' y el efectivo vuelve al cajón' : ''}. No se borra: queda registrado.</p>
                  <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} maxLength={300} required minLength={3} placeholder="Motivo"
                    className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink" aria-label="Motivo de la anulación del pago" />
                  <div className="flex gap-2">
                    <button type="submit" data-boton="confirmar-anular-pago" disabled={pendiente || !enLinea || motivo.trim().length < 3} className="h-touch flex-1 rounded-xl bg-stock-out font-bold text-white disabled:opacity-40">{pendiente ? 'Anulando…' : 'Confirmar'}</button>
                    <button type="button" onClick={() => setAnulando(null)} className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Cancelar</button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" data-form="error" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
    </section>
  )
}
