import { MOTIVOS_NOTA_CREDITO_TOTAL, type CodigoMotivoNota } from '../motivos-nota'

/**
 * Contenido del diálogo de la nota de crédito, SIN estado propio: todo entra por props. Así cada estado
 * (editando, enviando, emitida, con error) se puede dibujar y probar sin navegador. Va aparte del diálogo porque
 * el portal de Radix no se renderiza en el servidor.
 */

export interface DocParaFormulario {
  fullNumber: string
  receiverName: string | null
  receiverDocNumber: string | null
  currency: string
  total: string
  /** Fecha ya formateada en la zona del negocio. */
  fecha: string
}

export type EstadoFormulario = 'editando' | 'enviando' | 'emitida'

export const MIN_SUSTENTO = 3
export const MAX_SUSTENTO = 250

export function FormularioNotaCredito({
  doc, motivo, sustento, confirmado, estado, error, emitida,
  onMotivo, onSustento, onConfirmado, onEmitir, onCerrar,
}: {
  doc: DocParaFormulario
  motivo: CodigoMotivoNota | ''
  sustento: string
  confirmado: boolean
  estado: EstadoFormulario
  error: string | null
  emitida: { fullNumber: string } | null
  onMotivo: (m: CodigoMotivoNota | '') => void
  onSustento: (s: string) => void
  onConfirmado: (c: boolean) => void
  onEmitir: () => void
  onCerrar: () => void
}) {
  if (estado === 'emitida' && emitida) {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-xl bg-stock-ok-soft px-3 py-3 text-stock-ok" role="status">
          <p className="text-sm font-bold">Nota de crédito emitida</p>
          <p className="mt-1 font-mono text-lg font-bold">{emitida.fullNumber}</p>
          <p className="mt-1 text-sm">Anula {doc.fullNumber}. Queda <b>pendiente</b> y se envía sola al proveedor.</p>
        </div>
        <button type="button" onClick={onCerrar} className="h-touch-lg rounded-xl bg-industrial-600 font-bold text-white">
          Listo
        </button>
      </div>
    )
  }

  const enviando = estado === 'enviando'
  const sustentoValido = sustento.trim().length >= MIN_SUSTENTO && sustento.trim().length <= MAX_SUSTENTO
  const puedeEmitir = !enviando && motivo !== '' && sustentoValido && confirmado
  const elegido = MOTIVOS_NOTA_CREDITO_TOTAL.find((m) => m.codigo === motivo)

  return (
    <div className="flex flex-col gap-3">
      <dl className="rounded-xl border border-hairline bg-surface-sunken px-3 py-2 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-ink-muted">Comprobante</dt>
          <dd className="font-mono font-bold text-ink">{doc.fullNumber}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-muted">Cliente</dt>
          <dd className="text-right text-ink">
            {doc.receiverName ?? 'Sin cliente'}
            {doc.receiverDocNumber && <span className="block font-mono text-xs text-ink-muted">{doc.receiverDocNumber}</span>}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-muted">Fecha</dt>
          <dd className="text-ink">{doc.fecha}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-muted">Importe a anular</dt>
          <dd className="font-bold text-ink">{doc.currency} {doc.total}</dd>
        </div>
      </dl>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-muted">Motivo</span>
        <select
          value={motivo} disabled={enviando}
          onChange={(e) => onMotivo(e.target.value as CodigoMotivoNota | '')}
          className="h-touch-lg rounded-xl border border-hairline bg-surface px-4 text-base text-ink"
        >
          <option value="">Elige un motivo…</option>
          {MOTIVOS_NOTA_CREDITO_TOTAL.map((m) => (
            <option key={m.codigo} value={m.codigo}>{m.codigo} · {m.nombre}</option>
          ))}
        </select>
        {elegido && <span className="text-xs text-ink-muted">{elegido.ayuda}</span>}
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-muted">
          Sustento <span className="font-bold text-stock-out">(obligatorio)</span>
        </span>
        <textarea
          value={sustento} disabled={enviando} rows={3} maxLength={MAX_SUSTENTO}
          onChange={(e) => onSustento(e.target.value)}
          placeholder="Ej.: El cliente devolvió toda la mercadería el mismo día"
          className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink"
        />
        <span className="text-xs text-ink-muted">Sale impreso en la nota. {sustento.trim().length}/{MAX_SUSTENTO}</span>
      </label>

      <div role="note" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm text-stock-low">
        <p className="font-bold">Esta nota anula {doc.fullNumber} por completo ({doc.currency} {doc.total}).</p>
        <p className="mt-1">
          <b>No devuelve el stock ni el dinero</b>: eso se hace aparte. Una vez emitida no se borra ni se repite.
        </p>
      </div>

      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox" checked={confirmado} disabled={enviando}
          onChange={(e) => onConfirmado(e.target.checked)}
          className="mt-1 h-5 w-5"
        />
        <span>Entiendo que esta nota no se puede deshacer.</span>
      </label>

      {error && (
        <p role="alert" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={onCerrar} disabled={enviando}
          className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink disabled:opacity-40">
          Cancelar
        </button>
        <button type="button" onClick={onEmitir} disabled={!puedeEmitir}
          className="h-touch-lg flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">
          {enviando ? 'Emitiendo…' : 'Emitir nota de crédito'}
        </button>
      </div>
    </div>
  )
}
