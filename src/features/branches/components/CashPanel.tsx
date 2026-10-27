'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatearFechaLocal } from '@/lib/fecha-local'
import { closeCash, openCash } from '../actions'

const money = (n: number) =>
  `S/ ${new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`

export interface TurnoAbierto {
  id: string
  openingAmount: number
  expectedAmount: number
  salesCount: number
  openedAt: string
  abiertoPor: string
}

export interface CierreReciente {
  id: string
  openingAmount: number
  countedAmount: number
  expectedAmount: number
  difference: number
  salesCount: number
  salesTotal: number
  cashTotal: number
  changeTotal: number
  creditSalesTotal: number
  cashReceiptsTotal: number
  otherReceiptsTotal: number
  /** Pagos a proveedores en efectivo: SALIERON del cajón y restan al esperado. */
  supplierCashPaymentsTotal: number
  /** Pagos a proveedores por otros medios: no tocaron el cajón. */
  supplierOtherPaymentsTotal: number
  closedAt: string
  /** Ausente justo tras cerrar: el servicio devuelve el arqueo, no el nombre. */
  cerradoPor?: string
}

/**
 * Apertura, cierre y arqueo del turno de caja.
 *
 * El importe esperado NO se muestra antes de teclear lo contado, y es la
 * decisión de diseño que da sentido a toda la pantalla: si el cajero ve «debe
 * haber 165.80» antes de contar, teclea 165.80. Un arqueo que sugiere la
 * respuesta no detecta ni un faltante.
 */
export function CashPanel({
  turno,
  ultimoCierre,
  sucursal,
  puedeOperar,
  zonaHoraria,
}: {
  turno: TurnoAbierto | null
  ultimoCierre: CierreReciente | null
  sucursal: string
  puedeOperar: boolean
  /**
   * Zona del negocio. Sin ella, `toLocaleString` usaría la del SERVIDOR al
   * renderizar —UTC en Vercel— y un turno abierto a las 21:00 en Lima
   * aparecería fechado al día siguiente. Con la zona explícita, servidor y
   * navegador imprimen lo mismo y no hay desajuste de hidratación.
   */
  zonaHoraria: string
}) {
  const router = useRouter()
  const [fondo, setFondo] = useState('')
  const [contado, setContado] = useState('')
  const [notas, setNotas] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [resultado, setResultado] = useState<CierreReciente | null>(null)
  const [pending, startTransition] = useTransition()

  const abrir = () => {
    setError(null)
    const monto = Number(fondo.replace(',', '.'))
    if (!Number.isFinite(monto) || monto < 0) {
      setError('Escribe el fondo de cambio con el que arrancas. Si es cero, pon 0.')
      return
    }
    startTransition(async () => {
      const res = await openCash({ openingAmount: monto, notes: notas.trim() || undefined })
      if (!res.ok) { setError(res.message); return }
      setFondo(''); setNotas('')
      router.refresh()
    })
  }

  const cerrar = () => {
    if (!turno) return
    setError(null)
    const monto = Number(contado.replace(',', '.'))
    if (!Number.isFinite(monto) || monto < 0) {
      setError('Cuenta el efectivo del cajón y escribe el total.')
      return
    }
    startTransition(async () => {
      const res = await closeCash({
        sessionId: turno.id,
        countedAmount: monto,
        notes: notas.trim() || undefined,
      })
      if (!res.ok) { setError(res.message); return }
      setResultado(res.data)
      setContado(''); setNotas('')
      router.refresh()
    })
  }

  // ── Resultado del arqueo recién hecho ──────────────────────────────────
  if (resultado) {
    const falta = resultado.difference < 0
    const cuadra = resultado.difference === 0
    return (
      <div className={`rounded-2xl border-2 p-5 ${
        cuadra ? 'border-stock-ok bg-stock-ok-soft'
        : falta ? 'border-stock-out bg-stock-out-soft'
        : 'border-stock-low bg-stock-low-soft'
      }`}>
        <h2 className="text-lg font-bold text-ink">
          {cuadra ? 'Caja cuadrada' : falta ? 'Faltante en caja' : 'Sobrante en caja'}
        </h2>
        <p className={`mt-1 text-3xl font-bold ${
          cuadra ? 'text-stock-ok' : falta ? 'text-stock-out' : 'text-stock-low'
        }`}>
          {resultado.difference === 0 ? money(0) : money(Math.abs(resultado.difference))}
        </p>

        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <Dato k="Fondo inicial" v={money(resultado.openingAmount)} />
          <Dato k="Cobrado en efectivo" v={money(resultado.cashTotal)} />
          <Dato k="Vueltos entregados" v={`- ${money(resultado.changeTotal)}`} />
          {resultado.cashReceiptsTotal > 0 && (
            <Dato k="Abonos de deuda en efectivo" v={money(resultado.cashReceiptsTotal)} />
          )}
          {resultado.supplierCashPaymentsTotal > 0 && (
            <Dato k="Pagos a proveedores en efectivo" v={`- ${money(resultado.supplierCashPaymentsTotal)}`} />
          )}
          <Dato k="Debía haber" v={money(resultado.expectedAmount)} />
          <Dato k="Contaste" v={money(resultado.countedAmount)} />
          <Dato k="Ventas del turno" v={`${resultado.salesCount} · ${money(resultado.salesTotal)}`} />
          {resultado.creditSalesTotal > 0 && (
            <Dato k="Fiado (no entró al cajón)" v={money(resultado.creditSalesTotal)} />
          )}
          {resultado.otherReceiptsTotal > 0 && (
            <Dato k="Abonos por otros medios" v={money(resultado.otherReceiptsTotal)} />
          )}
          {resultado.supplierOtherPaymentsTotal > 0 && (
            <Dato k="Pagos a proveedores por otros medios (no salieron del cajón)" v={money(resultado.supplierOtherPaymentsTotal)} />
          )}
        </dl>

        <p className="mt-4 text-xs text-ink-muted">
          El arqueo quedó guardado tal cual. Si mañana se anula una de estas
          ventas, este cierre no cambia: es la foto de lo que había en el cajón
          al terminar el turno.
        </p>

        <button
          type="button"
          onClick={() => setResultado(null)}
          className="mt-4 h-touch-lg w-full rounded-xl bg-graphite-900 font-bold text-white dark:bg-graphite-50 dark:text-graphite-900"
        >
          Entendido
        </button>
      </div>
    )
  }

  // ── Turno abierto: cierre y arqueo ─────────────────────────────────────
  if (turno) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-2xl border border-hairline bg-surface p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-stock-ok">
                Caja abierta
              </p>
              <h2 className="text-lg font-bold text-ink">{sucursal}</h2>
            </div>
            <span className="rounded-full bg-stock-ok-soft px-3 py-1 text-xs font-bold text-stock-ok">
              En curso
            </span>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <Dato k="Fondo inicial" v={money(turno.openingAmount)} />
            <Dato k="Ventas del turno" v={String(turno.salesCount)} />
            <Dato k="Abrió" v={turno.abiertoPor} />
            <Dato k="Desde" v={formatearFechaLocal(turno.openedAt, zonaHoraria)} />
          </dl>
        </div>

        <div className="rounded-2xl border border-hairline bg-surface p-5">
          <h3 className="font-bold text-ink">Cerrar y arquear</h3>
          <p className="mt-1 text-sm text-ink-muted">
            Cuenta el efectivo del cajón y escribe el total. El sistema no te
            dice cuánto debería haber hasta que lo hagas: si te lo dijera, el
            arqueo no serviría para encontrar diferencias.
          </p>

          <label className="mt-4 flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">Efectivo contado</span>
            <input
              inputMode="decimal"
              value={contado}
              onChange={(e) => setContado(e.target.value)}
              placeholder="0.00"
              className="h-touch-xl rounded-xl border border-hairline bg-surface px-4 text-2xl font-bold text-ink focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
            />
          </label>

          <label className="mt-3 flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">
              Observación {' '}
              <span className="font-normal">(obligatoria si hay diferencia)</span>
            </span>
            <textarea
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              rows={2}
              placeholder="Ej.: falta un billete de 10, se pagó un delivery del cajón"
              className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink"
            />
          </label>

          {error && (
            <p role="alert" className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={cerrar}
            disabled={pending || !puedeOperar}
            className="mt-4 h-touch-xl w-full rounded-xl bg-industrial-600 text-lg font-bold text-white disabled:opacity-40"
          >
            {pending ? 'Cerrando…' : 'Cerrar caja'}
          </button>
        </div>
      </div>
    )
  }

  // ── Sin turno: apertura ────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-hairline bg-surface p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Caja cerrada
        </p>
        <h2 className="text-lg font-bold text-ink">{sucursal}</h2>
        <p className="mt-2 text-sm text-ink-muted">
          Puedes vender sin abrir caja, pero esas ventas no entrarán en ningún
          arqueo. Si llevas control del cajón, abre el turno antes de empezar.
        </p>

        <label className="mt-4 flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-muted">Fondo de cambio</span>
          <input
            inputMode="decimal"
            value={fondo}
            onChange={(e) => setFondo(e.target.value)}
            placeholder="0.00"
            className="h-touch-xl rounded-xl border border-hairline bg-surface px-4 text-2xl font-bold text-ink focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
          />
        </label>

        <label className="mt-3 flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-muted">Nota (opcional)</span>
          <input
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
            className="h-touch-lg rounded-xl border border-hairline bg-surface px-3 text-base text-ink"
          />
        </label>

        {error && (
          <p role="alert" className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={abrir}
          disabled={pending || !puedeOperar}
          className="mt-4 h-touch-xl w-full rounded-xl bg-industrial-600 text-lg font-bold text-white disabled:opacity-40"
        >
          {pending ? 'Abriendo…' : 'Abrir caja'}
        </button>
      </div>

      {ultimoCierre && (
        <div className="rounded-2xl border border-hairline bg-surface p-5">
          <h3 className="font-bold text-ink">Último cierre</h3>
          <p className="text-xs text-ink-muted">
            {formatearFechaLocal(ultimoCierre.closedAt, zonaHoraria)}
            {ultimoCierre.cerradoPor ? ` · ${ultimoCierre.cerradoPor}` : ''}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <Dato k="Debía haber" v={money(ultimoCierre.expectedAmount)} />
            <Dato k="Se contó" v={money(ultimoCierre.countedAmount)} />
            <Dato
              k="Diferencia"
              v={ultimoCierre.difference === 0 ? 'Cuadrada' : money(ultimoCierre.difference)}
            />
            <Dato k="Ventas" v={`${ultimoCierre.salesCount} · ${money(ultimoCierre.salesTotal)}`} />
            {ultimoCierre.creditSalesTotal > 0 && <Dato k="Fiado" v={money(ultimoCierre.creditSalesTotal)} />}
            {ultimoCierre.cashReceiptsTotal > 0 && (
              <Dato k="Abonos en efectivo" v={money(ultimoCierre.cashReceiptsTotal)} />
            )}
            {ultimoCierre.supplierCashPaymentsTotal > 0 && (
              <Dato k="Pagos a proveedores en efectivo" v={`- ${money(ultimoCierre.supplierCashPaymentsTotal)}`} />
            )}
          </dl>
        </div>
      )}
    </div>
  )
}

function Dato({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{k}</dt>
      <dd className="font-semibold text-ink">{v}</dd>
    </div>
  )
}
