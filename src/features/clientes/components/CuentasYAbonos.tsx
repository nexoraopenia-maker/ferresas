'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { fechaDiaCorta } from '@/lib/fecha-local'
import { anularAbono, anularCuenta, descartarRevision } from '@/features/credito/actions'
import type { AbonoFicha, CuentaFicha } from '../service'

const money = (n: number) => `S/ ${n.toFixed(2)}`
const ESTADO: Record<CuentaFicha['status'], string> = { ABIERTA: 'Abierta', PAGADA: 'Pagada', ANULADA: 'Dada de baja' }
const METODO: Record<string, string> = {
  EFECTIVO: 'Efectivo', YAPE: 'Yape', PLIN: 'Plin', TRANSFERENCIA: 'Transferencia', TARJETA_DEBITO: 'T. débito', TARJETA_CREDITO: 'T. crédito', OTRO: 'Otro',
}

type Accion = { tipo: 'castigar' | 'descartar' | 'anular'; id: string }
const PIDE: Record<Accion['tipo'], { titulo: string; etiqueta: string; boton: string }> = {
  castigar: { titulo: 'Dar de baja esta deuda', etiqueta: 'Motivo (queda registrado)', boton: 'Dar de baja la deuda' },
  descartar: { titulo: 'Mantener la deuda y cerrar la revisión', etiqueta: 'Nota (queda registrada)', boton: 'Mantener la deuda' },
  anular: { titulo: 'Anular este abono', etiqueta: 'Motivo (queda registrado)', boton: 'Anular el abono' },
}

/**
 * Cuentas por cobrar y abonos del cliente. Castigar una deuda, resolver la revisión de una nota de crédito y anular un abono son
 * decisiones del dueño (`credito.castigar`): sin ese permiso los botones no aparecen. El servidor lo vuelve a comprobar, y un abono
 * en efectivo de un turno ya cerrado se rechaza ahí con su explicación.
 */
export function CuentasYAbonos({ abiertas, cerradas, abonos, puedeCastigar, puedeOperar }: {
  abiertas: readonly CuentaFicha[]
  cerradas: readonly CuentaFicha[]
  abonos: readonly AbonoFicha[]
  puedeCastigar: boolean
  puedeOperar: boolean
}) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [accion, setAccion] = useState<Accion | null>(null)
  const [texto, setTexto] = useState('')
  const [error, setError] = useState<string | null>(null)

  const abrir = (a: Accion) => { setAccion(a); setTexto(''); setError(null) }
  const ejecutar = () => {
    if (!accion) return
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    setError(null)
    startTransition(async () => {
      const r = accion.tipo === 'castigar' ? await anularCuenta({ receivableId: accion.id, motivo: texto })
        : accion.tipo === 'descartar' ? await descartarRevision({ receivableId: accion.id, nota: texto })
        : await anularAbono({ paymentId: accion.id, motivo: texto })
      if (!r.ok) { setError(r.message); return }
      setAccion(null)
      router.refresh()
    })
  }

  const puede = puedeCastigar && puedeOperar
  const boton = 'h-9 rounded-lg border border-hairline px-3 text-xs font-semibold text-ink disabled:opacity-40'

  const fila = (x: CuentaFicha) => (
    <li key={x.id} data-cuenta={x.id} className="rounded-xl border border-hairline px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{x.venta} <span className="font-normal text-ink-muted">· {fechaDiaCorta(x.fecha.slice(0, 10))}</span></p>
          <p className="text-xs text-ink-muted">
            Monto {money(x.monto)} · abonado {money(x.abonado)} · vence {fechaDiaCorta(x.vence)}
          </p>
        </div>
        <div className="text-right">
          <p className="font-bold tabular-nums text-ink">{x.status === 'ABIERTA' ? `Saldo ${money(x.saldo)}` : ESTADO[x.status]}</p>
          <p className="flex flex-wrap justify-end gap-1">
            {x.vencida && <span data-insignia="vencida" className="rounded-full bg-stock-low-soft px-2 py-0.5 text-xs font-semibold text-stock-low">Vencida</span>}
            {x.enRevision && <span data-insignia="revision" className="rounded-full bg-stock-out-soft px-2 py-0.5 text-xs font-semibold text-stock-out">Por revisar</span>}
          </p>
        </div>
      </div>
      {x.enRevision && x.motivoRevision && <p data-revision="motivo" className="mt-1 text-xs text-ink-muted">Nota de crédito: {x.motivoRevision}</p>}
      {puede && x.status === 'ABIERTA' && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" data-boton="castigar" className={boton} onClick={() => abrir({ tipo: 'castigar', id: x.id })}>Dar de baja la deuda</button>
          {x.enRevision && <button type="button" data-boton="descartar" className={boton} onClick={() => abrir({ tipo: 'descartar', id: x.id })}>Mantener la deuda</button>}
        </div>
      )}
    </li>
  )

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Cuentas por cobrar" className="flex flex-col gap-2">
        <h3 className="font-bold text-ink">Cuentas por cobrar ({abiertas.length})</h3>
        {abiertas.length === 0 ? <p data-vacio="cuentas" className="text-sm text-ink-muted">No tiene deudas abiertas.</p> : <ul className="flex flex-col gap-2">{abiertas.map(fila)}</ul>}
        {cerradas.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer font-semibold text-ink-muted">Cuentas cerradas ({cerradas.length})</summary>
            <ul className="mt-2 flex flex-col gap-2">{cerradas.map(fila)}</ul>
          </details>
        )}
      </section>

      <section aria-label="Abonos" className="flex flex-col gap-2">
        <h3 className="font-bold text-ink">Abonos ({abonos.length})</h3>
        {abonos.length === 0 ? <p data-vacio="abonos" className="text-sm text-ink-muted">Todavía no hay abonos.</p> : (
          <ul className="flex flex-col gap-2">
            {abonos.map((a) => (
              <li key={a.id} data-abono={a.id} className={`rounded-xl border border-hairline px-3 py-2 text-sm ${a.anulado ? 'opacity-70' : ''}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className={`font-semibold text-ink ${a.anulado ? 'line-through' : ''}`}>{METODO[a.metodo] ?? a.metodo} · {money(a.monto)}</p>
                    <p className="text-xs text-ink-muted">{fechaDiaCorta(a.fecha.slice(0, 10))} · cobró {a.cobradoPor}{a.referencia ? ` · ref. ${a.referencia}` : ''}</p>
                  </div>
                  <a href={`/imprimir/abono/${a.id}`} target="_blank" rel="noopener" data-enlace="recibo" className="text-xs font-semibold text-industrial-700 underline dark:text-industrial-300">Recibo</a>
                  {a.anulado
                    ? <span data-insignia="anulado" className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-semibold text-ink-muted">Anulado</span>
                    : puede && <button type="button" data-boton="anular" className={boton} onClick={() => abrir({ tipo: 'anular', id: a.id })}>Anular</button>}
                </div>
                {a.anulado && a.motivoAnulacion && <p data-anulacion="motivo" className="mt-1 text-xs text-ink-muted">Motivo: {a.motivoAnulacion}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {accion && (
        <form data-form="accion" onSubmit={(e) => { e.preventDefault(); ejecutar() }} className="flex flex-col gap-2 rounded-2xl border-2 border-stock-low bg-surface p-4" role="group" aria-label={PIDE[accion.tipo].titulo}>
          <h4 className="font-bold text-ink">{PIDE[accion.tipo].titulo}</h4>
          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">{PIDE[accion.tipo].etiqueta}
            <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={2} maxLength={300} required minLength={3}
              className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink" />
          </label>
          {error && <p role="alert" data-form="error" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={pendiente || !enLinea || texto.trim().length < 3} className="h-touch flex-1 rounded-xl bg-stock-out font-bold text-white disabled:opacity-40">{pendiente ? 'Guardando…' : PIDE[accion.tipo].boton}</button>
            <button type="button" onClick={() => setAccion(null)} className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Cancelar</button>
          </div>
        </form>
      )}
    </div>
  )
}
