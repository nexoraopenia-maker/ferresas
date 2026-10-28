'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatearFechaLocal } from '@/lib/fecha-local'
import { anularMovimiento, registrarMovimiento } from '../cash-movement-actions'
import { categoriasOfrecidas, evaluarFormulario, type PermisosDeCaja } from '../cash-movement-formulario'
import { ETIQUETA_CATEGORIA, ETIQUETA_TIPO, REFERENCIA_OBLIGATORIA_DESDE, TOPE_MOVIMIENTO_SIN_AJUSTE, type CategoriaMovimiento, type TipoMovimiento } from '../cash-movement-reglas'
import type { FilaMovimiento } from '../cash-movement-service'

const money = (n: number) => `S/ ${new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`
const nuevaClave = () => globalThis.crypto.randomUUID()

/**
 * Movimientos manuales del turno abierto (F6.3c): formulario para registrarlos y lista con anulación.
 *
 * Arqueo a ciegas: la pantalla NUNCA enseña el efectivo esperado. Si un egreso excede lo que el sistema espera, el aviso lo dice sin la cifra y pide
 * una segunda confirmación explícita (se reenvía con la MISMA clave de idempotencia, así un doble clic no duplica el movimiento).
 */
export function MovimientosCaja({ movimientos, tiene, puedeOperar, zonaHoraria }: {
  movimientos: FilaMovimiento[]
  tiene: PermisosDeCaja
  puedeOperar: boolean
  zonaHoraria: string
}) {
  const router = useRouter()
  const puedeRegistrar = tiene.movimientos || tiene.ajuste
  const [tipo, setTipo] = useState<TipoMovimiento>('EGRESO')
  const [categoria, setCategoria] = useState<CategoriaMovimiento>('GASTO_MENOR')
  const [monto, setMonto] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [referencia, setReferencia] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [exceso, setExceso] = useState(false)
  const clave = useRef(nuevaClave())
  const [anulando, setAnulando] = useState<string | null>(null)
  const [motivo, setMotivo] = useState('')
  const [pending, startTransition] = useTransition()

  const ofrecidas = categoriasOfrecidas(tipo, tiene)
  const ev = evaluarFormulario({ tipo, categoria, monto, descripcion, referencia }, tiene)

  const cambiarTipo = (t: TipoMovimiento) => {
    setTipo(t); setExceso(false); setError(null)
    setCategoria(categoriasOfrecidas(t, tiene)[0]?.valor ?? 'OTRO')
  }

  const enviar = (confirmaExceso: boolean) => {
    setError(null)
    if (!ev.ok || ev.montoCent === null) { setError(ev.errores[0] ?? 'Revisa los datos.'); return }
    startTransition(async () => {
      const res = await registrarMovimiento({
        kind: tipo, category: categoria, amount: ev.montoCent! / 100, description: descripcion.trim(),
        reference: referencia.trim() || undefined, confirmaExceso, idempotencyKey: clave.current,
      })
      if (!res.ok) {
        if (res.code === 'CASH_EXCEEDS_EXPECTED') { setExceso(true); return }
        setError(res.message); return
      }
      clave.current = nuevaClave()
      setMonto(''); setDescripcion(''); setReferencia(''); setExceso(false)
      router.refresh()
    })
  }

  const anular = (id: string) => {
    setError(null)
    if (motivo.trim().length < 3) { setError('Escribe el motivo de la anulación (mínimo 3 caracteres).'); return }
    startTransition(async () => {
      const res = await anularMovimiento({ movementId: id, reason: motivo.trim() })
      if (!res.ok) { setError(res.message); return }
      setAnulando(null); setMotivo('')
      router.refresh()
    })
  }

  return (
    <section data-movimientos="panel" className="rounded-2xl border border-hairline bg-surface p-5">
      <h3 className="font-bold text-ink">Movimientos manuales</h3>
      <p className="mt-1 text-sm text-ink-muted">
        Gastos menores, retiros y reposiciones de efectivo del cajón. Un egreso de más de {money(REFERENCIA_OBLIGATORIA_DESDE)} lleva referencia.
        {!tiene.ajuste && ` Como cajero puedes registrar gastos menores y «otro» hasta ${money(TOPE_MOVIMIENTO_SIN_AJUSTE)}; lo demás lo registra un administrador.`}
      </p>

      {puedeRegistrar && (
        <div data-movimientos="formulario" className="mt-4 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Tipo de movimiento">
            {(['EGRESO', 'INGRESO'] as const).map((t) => (
              <button key={t} type="button" onClick={() => cambiarTipo(t)} aria-pressed={tipo === t}
                className={`h-touch rounded-xl border text-sm font-semibold ${tipo === t ? 'border-industrial-600 bg-industrial-600 text-white' : 'border-hairline text-ink'}`}>
                {ETIQUETA_TIPO[t]}
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">Categoría</span>
            <select value={categoria} onChange={(e) => { setCategoria(e.target.value as CategoriaMovimiento); setExceso(false) }}
              className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base text-ink">
              {ofrecidas.map((c) => <option key={c.valor} value={c.valor}>{c.etiqueta}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">Monto</span>
            <input inputMode="decimal" value={monto} onChange={(e) => { setMonto(e.target.value); setExceso(false) }} placeholder="0.00"
              className="h-touch rounded-xl border border-hairline bg-surface px-3 text-lg font-bold text-ink" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">Descripción</span>
            <input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} maxLength={200} placeholder="Ej.: movilidad para entrega"
              className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base text-ink" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">
              Referencia {ev.referenciaObligatoria ? <strong className="text-stock-out">(obligatoria)</strong> : <span className="font-normal">(opcional)</span>}
            </span>
            <input value={referencia} onChange={(e) => setReferencia(e.target.value)} maxLength={80} placeholder="N.º de comprobante o recibo"
              className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base text-ink" />
          </label>

          {(monto !== '' || descripcion !== '') && !ev.ok && (
            <ul data-movimientos="ayuda" className="list-disc pl-5 text-sm text-ink-muted">
              {ev.errores.map((m) => <li key={m}>{m}</li>)}
            </ul>
          )}
          {error && <p role="alert" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}

          {exceso ? (
            <div data-movimientos="exceso" role="alertdialog" className="rounded-xl border-2 border-stock-low bg-stock-low-soft p-3">
              <p className="text-sm font-semibold text-stock-low">
                Este egreso es mayor que el efectivo que el sistema espera en el cajón. Puede ser un error de monto. ¿Confirmas que quieres registrarlo?
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setExceso(false)} disabled={pending} className="h-touch rounded-xl border border-hairline text-sm font-semibold">Revisar</button>
                <button type="button" data-movimientos="confirmar-exceso" onClick={() => enviar(true)} disabled={pending || !puedeOperar}
                  className="h-touch rounded-xl bg-stock-low text-sm font-bold text-white disabled:opacity-40">Sí, registrar</button>
              </div>
            </div>
          ) : (
            <button type="button" data-movimientos="registrar" onClick={() => enviar(false)} disabled={pending || !puedeOperar || !ev.ok}
              className="h-touch-xl w-full rounded-xl bg-industrial-600 text-base font-bold text-white disabled:opacity-40">
              {pending ? 'Guardando…' : `Registrar ${ETIQUETA_TIPO[tipo].toLowerCase()}`}
            </button>
          )}
        </div>
      )}

      <ul data-movimientos="lista" className="mt-5 flex flex-col gap-2">
        {movimientos.length === 0 && <li className="text-sm text-ink-muted">Todavía no hay movimientos manuales en este turno.</li>}
        {movimientos.map((m) => (
          <li key={m.id} data-movimiento={m.id} data-anulado={m.anulado ? 'si' : 'no'} className="rounded-xl border border-hairline p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className={m.anulado ? 'line-through opacity-60' : ''}>
                <p className="font-semibold text-ink">{m.kind === 'INGRESO' ? '+' : '−'} {money(m.amount)} · {ETIQUETA_CATEGORIA[m.category]}</p>
                <p className="text-ink-muted">{m.description}{m.reference ? ` · Ref. ${m.reference}` : ''}</p>
              </div>
              {m.puedeAnular && anulando !== m.id && (
                <button type="button" data-movimientos="anular" onClick={() => { setAnulando(m.id); setMotivo(''); setError(null) }} className="text-xs font-semibold underline">Anular</button>
              )}
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              {formatearFechaLocal(m.createdAt, zonaHoraria)} · {m.autor}
              {m.esCompensacion && ' · Automático: abono anulado de un turno cerrado'}
              {m.method !== 'EFECTIVO' && ' · No movió el cajón (informativo)'}
              {m.anulado && ` · Anulado: ${m.motivoAnulacion ?? ''}`}
            </p>
            {anulando === m.id && (
              <div className="mt-2 flex flex-col gap-2">
                <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo de la anulación" aria-label="Motivo de la anulación"
                  className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base text-ink" />
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setAnulando(null)} className="h-touch rounded-xl border border-hairline text-sm font-semibold">Cancelar</button>
                  <button type="button" data-movimientos="confirmar-anulacion" onClick={() => anular(m.id)} disabled={pending || !puedeOperar}
                    className="h-touch rounded-xl bg-stock-out text-sm font-bold text-white disabled:opacity-40">Anular movimiento</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
