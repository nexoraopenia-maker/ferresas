'use client'

import { ETIQUETA_DOCUMENTO_COMPRA, TIPOS_DOCUMENTO_COMPRA } from '../documento'

export interface ValorDocumento { docType: string; docSeries: string; docNumber: string; issueDate: string }
export const DOCUMENTO_VACIO: ValorDocumento = { docType: '', docSeries: '', docNumber: '', issueDate: '' }

const campo = 'h-touch w-full rounded-xl border border-hairline bg-surface px-3 text-base text-ink disabled:bg-surface-sunken disabled:text-ink-muted'

/**
 * Los cuatro datos del documento del proveedor: tipo, serie, número y fecha de emisión. Van juntos o ninguno; el servidor valida y
 * normaliza (mayúsculas, sin espacios, sin fecha futura). `hoy` (AAAA-MM-DD, hora del negocio) es solo el tope del selector de fecha.
 */
export function CamposDocumento({ valor, onChange, hoy, disabled }: { valor: ValorDocumento; onChange: (v: ValorDocumento) => void; hoy: string; disabled?: boolean }) {
  const set = (k: keyof ValorDocumento) => (e: { target: { value: string } }) => onChange({ ...valor, [k]: e.target.value })
  return (
    <fieldset data-campos="documento" className="grid gap-3 sm:grid-cols-4">
      <legend className="mb-1 text-sm font-semibold text-ink">Documento del proveedor</legend>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Tipo
        <select name="docType" value={valor.docType} onChange={set('docType')} disabled={disabled} className={campo}>
          <option value="">Sin documento todavía</option>
          {TIPOS_DOCUMENTO_COMPRA.map((t) => <option key={t} value={t}>{ETIQUETA_DOCUMENTO_COMPRA[t]}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Serie
        <input name="docSeries" value={valor.docSeries} onChange={set('docSeries')} disabled={disabled} maxLength={20} autoCapitalize="characters" placeholder="F001" className={campo} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Número
        <input name="docNumber" value={valor.docNumber} onChange={set('docNumber')} disabled={disabled} maxLength={20} inputMode="numeric" placeholder="000123" className={campo} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Fecha de emisión
        <input type="date" name="issueDate" value={valor.issueDate} onChange={set('issueDate')} disabled={disabled} max={hoy} min="2000-01-01" className={campo} />
      </label>
    </fieldset>
  )
}
