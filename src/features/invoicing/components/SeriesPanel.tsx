'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setArranqueSerie } from '../actions'

export interface SerieRow {
  scope: 'TAX_BOLETA' | 'TAX_FACTURA'
  series: string
  next: number
  startNumber: number
  emitidos: number
  editable: boolean
  ultimoEmitido: number | null
}

const ETIQUETA: Record<string, string> = {
  TAX_BOLETA: 'Boletas',
  TAX_FACTURA: 'Facturas',
}

const num8 = (n: number) => String(n).padStart(8, '0')

/**
 * Correlativo inicial por serie.
 *
 * ─── POR QUÉ LA CONFIRMACIÓN ES EXPLÍCITA Y NO UN `confirm()` ────────────
 *
 * Fijar el arranque es irreversible en cuanto la serie emite su primer
 * comprobante: subirlo deja un hueco, bajarlo produce un número duplicado, y
 * ninguna de las dos se puede deshacer porque el comprobante ya salió
 * impreso y declarado.
 *
 * Un `confirm()` del navegador se cierra por reflejo. Aquí hay que escribir
 * el número Y marcar una casilla que dice qué va a pasar, con el número
 * concreto delante — «el primero será B001-00004533» — para que lo que se
 * confirma sea algo legible y no un «¿seguro?».
 */
export function SeriesPanel({
  series,
  branchId,
  sucursal,
  puedeGestionar,
}: {
  series: SerieRow[]
  branchId: string
  sucursal: string
  puedeGestionar: boolean
}) {
  const router = useRouter()
  const [abierta, setAbierta] = useState<SerieRow | null>(null)
  const [valor, setValor] = useState('')
  const [confirmado, setConfirmado] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const abrir = (s: SerieRow) => {
    setAbierta(s)
    setValor(String(s.startNumber))
    setConfirmado(false)
    setError(null)
  }

  const guardar = () => {
    if (!abierta) return
    setError(null)
    const n = Number(valor)
    if (!Number.isInteger(n) || n < 1) {
      setError('Escribe un número entero mayor que cero.')
      return
    }
    startTransition(async () => {
      const res = await setArranqueSerie({
        branchId,
        scope: abierta.scope,
        startNumber: n,
        confirmado: true,
      })
      if (!res.ok) { setError(res.message); return }
      setAbierta(null)
      router.refresh()
    })
  }

  return (
    <section className="rounded-2xl border border-hairline bg-surface p-4">
      <h2 className="font-bold text-ink">Series de {sucursal}</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Si este negocio ya facturaba con otro sistema, fija aquí el número por
        el que iba cada serie <strong>antes de emitir el primer comprobante</strong>.
      </p>

      <ul className="mt-4 flex flex-col gap-3">
        {series.map((s) => (
          <li key={s.scope} className="rounded-xl border border-hairline p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-ink">
                  {ETIQUETA[s.scope]}{' '}
                  <span className="font-mono text-ink-muted">· {s.series}</span>
                </p>
                <p className="mt-1 font-mono text-sm text-ink">
                  siguiente: {s.series}-{num8(s.next)}
                </p>
                <p className="text-xs text-ink-muted">
                  {s.emitidos === 0
                    ? 'Sin emitir todavía'
                    : `${s.emitidos} ${s.emitidos === 1 ? 'emitido' : 'emitidos'} desde el ${num8(s.startNumber)}`}
                  {s.ultimoEmitido !== null && ` · último: ${num8(s.ultimoEmitido)}`}
                </p>
              </div>

              {puedeGestionar && (
                s.editable ? (
                  <button
                    type="button"
                    onClick={() => abrir(s)}
                    className="h-touch shrink-0 rounded-lg border border-hairline px-4 text-sm font-semibold text-ink"
                  >
                    Fijar inicio
                  </button>
                ) : (
                  <span
                    className="shrink-0 rounded-full bg-surface-sunken px-3 py-1 text-xs font-bold text-ink-muted"
                    title="Ya emitió comprobantes: mover el arranque dejaría un hueco o un duplicado"
                  >
                    Bloqueado
                  </span>
                )
              )}
            </div>
          </li>
        ))}
      </ul>

      {abierta && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <div className="absolute inset-0 bg-graphite-950/70" onClick={() => setAbierta(null)} aria-hidden />
          <div role="dialog" aria-modal="true"
            className="relative w-full max-w-md rounded-2xl bg-surface p-5 shadow-2xl">
            <h3 className="text-lg font-bold text-ink">
              Correlativo inicial de {abierta.series}
            </h3>

            <p className="mt-2 text-sm text-ink">
              Escribe el <strong>primer número que emitirá</strong> esta serie.
              Si el último comprobante del sistema anterior fue el 4 532,
              aquí va <span className="font-mono font-bold">4533</span>.
            </p>

            <label className="mt-4 flex flex-col gap-1">
              <span className="text-sm font-medium text-ink-muted">Primer número</span>
              <input
                inputMode="numeric"
                value={valor}
                onChange={(e) => setValor(e.target.value.replace(/\D/g, ''))}
                className="h-touch-xl rounded-xl border border-hairline bg-surface px-4 text-2xl font-bold text-ink focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
              />
            </label>

            {/* El riesgo, con el número concreto delante. */}
            <div className="mt-4 rounded-xl border border-stock-low/40 bg-stock-low-soft p-3">
              <p className="text-sm font-bold text-stock-low">
                Esto no se puede cambiar después
              </p>
              <ul className="mt-2 flex flex-col gap-1 text-xs text-ink">
                <li>
                  · El primer comprobante será{' '}
                  <span className="font-mono font-bold">
                    {abierta.series}-{num8(Number(valor) || 0)}
                  </span>
                </li>
                <li>
                  · En cuanto se emita, el arranque queda <strong>bloqueado</strong>:
                  subirlo dejaría un hueco en la numeración y bajarlo produciría un
                  número duplicado ante SUNAT.
                </li>
                <li>
                  · Si te pasas, los comprobantes saldrán con números que el negocio
                  nunca usó. Si te quedas corto, repetirás números ya declarados.
                </li>
              </ul>

              <label className="mt-3 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={confirmado}
                  onChange={(e) => setConfirmado(e.target.checked)}
                  className="mt-0.5 size-5 accent-stock-low"
                />
                <span className="text-xs font-semibold text-ink">
                  Confirmo que {abierta.series}-{num8(Number(valor) || 0)} es el
                  número correcto y que esto no se podrá cambiar.
                </span>
              </label>
            </div>

            {error && (
              <p role="alert" className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setAbierta(null)}
                className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink">
                Cancelar
              </button>
              <button
                type="button"
                onClick={guardar}
                disabled={pending || !confirmado || !valor}
                className="h-touch-lg flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40"
              >
                {pending ? 'Guardando…' : 'Fijar inicio'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
