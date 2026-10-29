'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { anularOdevolverVenta } from '@/features/devoluciones/actions'
import { CODIGO_NOTA, ETIQUETA_TIPO, type ModoReembolso, type TipoDevolucion } from '@/features/devoluciones/reglas'
import type { ResultadoDevolucion } from '@/features/devoluciones/service'
import { ETIQUETA_MODO_REEMBOLSO, MEDIOS_EXTERNOS, medio } from '../etiquetas'

const money = (n: number) => `S/ ${n.toFixed(2)}`
const campo = 'h-touch w-full rounded-xl border border-hairline bg-surface px-3 text-base text-ink disabled:bg-surface-sunken disabled:text-ink-muted'

export interface LineaReembolso { mode: ModoReembolso; method: string | null; amount: number; reference: string | null }

interface Linea extends LineaReembolso { /** Por dónde entró este dinero, solo para mostrarlo. */ original: string | null }

/**
 * «Anular / devolver venta». El servidor decide TODO lo que cuenta (importes, comprobante, stock, deuda); aquí la persona elige el tipo,
 * escribe el motivo y decide adónde va el dinero. La clave de idempotencia nace al abrir el formulario: un doble clic o un reintento por red
 * lenta no devuelve dos veces. Nada se envía sin la confirmación explícita.
 */
export function FormularioDevolucion({ saleId, numero, total, pagadoNeto, reembolsosIniciales, hayTurnoAbierto, comprobante, deEnsayo, cuentaACancelar, puedeOperar }: {
  saleId: string
  numero: string
  total: number
  pagadoNeto: number
  reembolsosIniciales: LineaReembolso[]
  hayTurnoAbierto: boolean
  /** Número del comprobante real vivo: se emitirá su nota de crédito total. */
  comprobante: string | null
  deEnsayo: boolean
  cuentaACancelar: number
  /** La cuenta del negocio permite escribir (no está en solo lectura). */
  puedeOperar: boolean
}) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [clave] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000'))
  const [tipo, setTipo] = useState<TipoDevolucion>('DEVOLUCION')
  const [motivo, setMotivo] = useState('')
  const [lineas, setLineas] = useState<Linea[]>(() => reembolsosIniciales.map((r) => ({ ...r, original: r.method })))
  const [confirmo, setConfirmo] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hecho, setHecho] = useState<ResultadoDevolucion | null>(null)

  const sinCaja = lineas.some((l) => l.mode !== 'SIN_SALIDA') && !hayTurnoAbierto
  const motivoCorto = motivo.trim().length < 3
  const faltaMotivoSinSalida = lineas.some((l) => l.mode === 'SIN_SALIDA' && (l.reference ?? '').trim().length < 3)
  const sinMedio = lineas.some((l) => l.mode === 'EXTERNO' && !l.method)
  const suma = useMemo(() => Math.round(lineas.reduce((a, l) => a + Math.round(l.amount * 100), 0)) / 100, [lineas])
  const nota = comprobante ? CODIGO_NOTA[tipo] : null
  const bloqueado = !puedeOperar || sinCaja || motivoCorto || faltaMotivoSinSalida || sinMedio || !confirmo || pendiente

  const cambiar = (i: number, cambio: Partial<Linea>) => setLineas((ls) => ls.map((l, k) => (k === i ? { ...l, ...cambio } : l)))
  const cambiarModo = (i: number, mode: ModoReembolso) => cambiar(i, { mode, method: mode === 'CAJA' ? 'EFECTIVO' : mode === 'EXTERNO' ? (lineas[i]!.original && lineas[i]!.original !== 'EFECTIVO' ? lineas[i]!.original : 'YAPE') : null })

  const enviar = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    if (bloqueado) return
    setError(null)
    startTransition(async () => {
      const r = await anularOdevolverVenta({
        saleId, kind: tipo, reason: motivo.trim(), idempotencyKey: clave,
        ...(lineas.length > 0 ? { refunds: lineas.map((l) => ({ mode: l.mode, method: l.mode === 'CAJA' ? 'EFECTIVO' : l.mode === 'EXTERNO' ? l.method : null, amount: l.amount, reference: l.reference?.trim() || undefined })) } : {}),
      })
      if (!r.ok) { setError(r.message); return }
      setHecho(r.data)
      router.refresh()
    })
  }

  if (hecho) {
    return (
      <section data-devolucion-resultado={hecho.number} role="status" className="flex flex-col gap-1 rounded-2xl border-2 border-stock-ok bg-stock-ok-soft p-4 text-sm text-ink">
        <p className="text-base font-bold text-stock-ok">{hecho.kind === 'ANULACION' ? 'Venta anulada' : 'Venta devuelta'}: {hecho.number}</p>
        <p>El stock se repuso{hecho.creditNote ? ` y se emitió la nota de crédito ${hecho.creditNote.fullNumber}` : ''}{hecho.receivableVoidedAmount > 0 ? `; se canceló la deuda del cliente (${money(hecho.receivableVoidedAmount)})` : ''}.</p>
        <p><Link href="/ventas" className="font-semibold text-industrial-600 underline">Volver al historial de ventas</Link></p>
      </section>
    )
  }

  return (
    <form onSubmit={enviar} data-form="devolucion" className="flex flex-col gap-4 rounded-2xl border-2 border-industrial-600 bg-surface p-4 text-sm text-ink">
      <div>
        <h2 className="text-lg font-bold">Anular o devolver esta venta</h2>
        <p className="text-ink-muted">Venta {numero} · {money(total)}. Es la venta COMPLETA: el stock vuelve entero. Esto no se puede deshacer.</p>
      </div>

      <fieldset className="flex flex-col gap-2" disabled={pendiente}>
        <legend className="mb-1 font-semibold">¿Qué pasó?</legend>
        {(['DEVOLUCION', 'ANULACION'] as const).map((t) => (
          <label key={t} className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 ${tipo === t ? 'border-industrial-600 bg-industrial-600/5' : 'border-hairline'}`}>
            <input type="radio" name="tipo" value={t} checked={tipo === t} onChange={() => setTipo(t)} className="mt-1" />
            <span><b>{t === 'DEVOLUCION' ? 'Devolver venta' : 'Anular venta'}</b><span className="block text-xs text-ink-muted">{t === 'DEVOLUCION' ? 'El cliente devuelve la mercadería (nota de crédito código 06 si hay comprobante real).' : 'La operación no debió ocurrir: error o cancelación (nota de crédito código 01 si hay comprobante real).'}</span></span>
          </label>
        ))}
      </fieldset>

      <label className="flex flex-col gap-1 font-semibold">Motivo (obligatorio)
        <textarea name="motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={250} rows={2} disabled={pendiente} className={`${campo} h-auto py-2 font-normal`} placeholder="Ej.: el cliente devolvió las bolsas de cemento sin abrir" />
      </label>

      {lineas.length > 0 && (
        <fieldset className="flex flex-col gap-2" disabled={pendiente}>
          <legend className="mb-1 font-semibold">¿Adónde va el dinero? (el cliente pagó {money(pagadoNeto)})</legend>
          {lineas.map((l, i) => (
            <div key={i} data-reembolso-linea={i} className="flex flex-col gap-2 rounded-xl border border-hairline p-3">
              <p className="flex justify-between"><span>Pagó con <b>{l.original ? medio(l.original) : '—'}</b></span><b className="tabular-nums">{money(l.amount)}</b></p>
              <select aria-label="Destino del reembolso" name={`modo-${i}`} value={l.mode} onChange={(e) => cambiarModo(i, e.target.value as ModoReembolso)} className={campo}>
                {(['CAJA', 'EXTERNO', 'SIN_SALIDA'] as const).map((m) => <option key={m} value={m}>{ETIQUETA_MODO_REEMBOLSO[m]}</option>)}
              </select>
              {l.mode === 'EXTERNO' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <select aria-label="Medio de devolución" name={`medio-${i}`} value={l.method ?? ''} onChange={(e) => cambiar(i, { method: e.target.value })} className={campo}>
                    {MEDIOS_EXTERNOS.map((m) => <option key={m} value={m}>{medio(m)}</option>)}
                  </select>
                  <input name={`ref-${i}`} value={l.reference ?? ''} onChange={(e) => cambiar(i, { reference: e.target.value })} maxLength={120} placeholder="N.º de operación (opcional)" className={campo} />
                </div>
              )}
              {l.mode === 'SIN_SALIDA' && <input name={`ref-${i}`} value={l.reference ?? ''} onChange={(e) => cambiar(i, { reference: e.target.value })} maxLength={120} placeholder="Motivo: por qué no se devuelve dinero (obligatorio)" className={campo} />}
            </div>
          ))}
          {sinCaja && <p role="alert" data-devolucion="sin-caja" className="rounded-lg bg-stock-low-soft px-3 py-2 font-semibold text-stock-low">Para devolver dinero hace falta que tengas tu propio turno de caja abierto en la sucursal de la venta (el efectivo sale de tu caja). Abre tu caja primero; si no se devuelve dinero, elige «sin salida de dinero».</p>}
          <p className="text-xs text-ink-muted">Suma de los reembolsos: {money(suma)}{suma === pagadoNeto ? ' — cuadra con lo pagado.' : ''}</p>
        </fieldset>
      )}

      <div data-devolucion="efectos" className="rounded-xl bg-surface-sunken p-3">
        <p className="mb-1 font-semibold">Lo que va a pasar</p>
        <ul className="list-disc pl-5">
          <li>La venta pasa a <b>{tipo === 'ANULACION' ? 'anulada' : 'devuelta'}</b> y el stock de todos sus productos <b>vuelve al almacén</b>.</li>
          {nota && <li>Se emite la <b>nota de crédito total {nota}</b> del comprobante {comprobante}.</li>}
          {deEnsayo && <li>El comprobante es de ensayo (sin valor tributario): se marca anulado, sin nota de crédito.</li>}
          {!comprobante && !deEnsayo && <li>No hay comprobante real vivo: no se emite nota de crédito.</li>}
          {cuentaACancelar > 0 && <li>Se <b>cancela la deuda</b> del cliente por {money(cuentaACancelar)}.</li>}
          {lineas.filter((l) => l.mode === 'CAJA').length > 0 && <li>Salen <b>{money(lineas.filter((l) => l.mode === 'CAJA').reduce((a, l) => a + l.amount, 0))}</b> del cajón del turno abierto.</li>}
        </ul>
      </div>

      <label className="flex items-start gap-2">
        <input type="checkbox" name="confirmo" checked={confirmo} onChange={(e) => setConfirmo(e.target.checked)} disabled={pendiente} className="mt-1" />
        <span>Entiendo que {ETIQUETA_TIPO[tipo].toLowerCase()} de la venta {numero} <b>no se puede deshacer</b>.</span>
      </label>

      {!puedeOperar && <p role="alert" data-devolucion="solo-lectura" className="rounded-lg bg-stock-low-soft px-3 py-2 font-semibold text-stock-low">Tu cuenta está en solo lectura: no se pueden registrar cambios.</p>}
      {error && <p role="alert" data-error className="rounded-lg bg-stock-out-soft px-3 py-2 font-semibold text-stock-out">{error}</p>}
      <button type="submit" data-boton="confirmar-devolucion" disabled={bloqueado} className="h-touch rounded-xl bg-stock-out px-4 font-bold text-white disabled:opacity-40">
        {pendiente ? 'Procesando…' : tipo === 'ANULACION' ? 'Anular la venta' : 'Devolver la venta'}
      </button>
    </form>
  )
}
