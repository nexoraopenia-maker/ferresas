'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { crearProveedor, editarProveedor } from '../actions'

export interface DatosProveedor {
  id: string; name: string; taxId: string | null; contact: string | null; phone: string | null; email: string | null
  address: string | null; notes: string | null; paymentTermDays: number
}

export const MENSAJE_RUC_BLOQUEADO = 'El RUC no se puede cambiar: el proveedor ya tiene compras y alteraría los documentos registrados.'

const campo = 'h-touch w-full rounded-xl border border-hairline bg-surface px-3 text-base text-ink disabled:bg-surface-sunken disabled:text-ink-muted'

/**
 * Alta y edición de un proveedor. El servicio vuelve a decidir permisos y reglas (RUC válido y único, RUC fijo con compras); esto es la
 * comodidad de decirlo antes.
 */
export function FormularioProveedor({ modo, inicial, rucEditable, onCancelar, onListo }: {
  modo: 'crear' | 'editar'
  inicial?: DatosProveedor
  rucEditable: boolean
  onCancelar?: () => void
  onListo?: () => void
}) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [v, setV] = useState({
    name: inicial?.name ?? '', taxId: inicial?.taxId ?? '', contact: inicial?.contact ?? '', phone: inicial?.phone ?? '',
    email: inicial?.email ?? '', address: inicial?.address ?? '', notes: inicial?.notes ?? '', plazo: String(inicial?.paymentTermDays ?? 0),
  })
  const cambia = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }))
  const plazo = /^\d{1,3}$/.test(v.plazo.trim()) ? Number(v.plazo.trim()) : Number.NaN
  const plazoInvalido = Number.isNaN(plazo) || plazo > 365

  const guardar = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    if (plazoInvalido) { setError('El plazo es un número entero de días, de 0 a 365.'); return }
    setError(null)
    startTransition(async () => {
      const datos = { name: v.name, taxId: v.taxId, contact: v.contact, phone: v.phone, email: v.email, address: v.address, notes: v.notes, paymentTermDays: plazo }
      const r = modo === 'crear' ? await crearProveedor(datos) : await editarProveedor({ ...datos, supplierId: inicial!.id })
      if (!r.ok) { setError(r.message); return }
      if (modo === 'crear') router.push(`/proveedores/${(r.data as { id: string }).id}`)
      else router.refresh()
      onListo?.()
    })
  }

  return (
    <form onSubmit={guardar} data-form={`proveedor-${modo}`} className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4">
      <h3 className="font-bold text-ink">{modo === 'crear' ? 'Nuevo proveedor' : 'Datos del proveedor'}</h3>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Nombre o razón social
        <input name="name" value={v.name} onChange={cambia('name')} required minLength={2} maxLength={120} className={campo} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">RUC
        <input name="taxId" value={v.taxId} onChange={cambia('taxId')} inputMode="numeric" maxLength={11} pattern="\d{11}"
          disabled={modo === 'editar' && !rucEditable} placeholder="11 dígitos; opcional si es un proveedor informal" className={campo} />
        {modo === 'editar' && !rucEditable && <span data-aviso="ruc-bloqueado" className="text-xs font-normal text-ink-muted">{MENSAJE_RUC_BLOQUEADO}</span>}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Contacto
          <input name="contact" value={v.contact} onChange={cambia('contact')} maxLength={120} placeholder="Vendedor o persona de contacto" className={campo} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Teléfono
          <input name="phone" value={v.phone} onChange={cambia('phone')} inputMode="tel" maxLength={30} className={campo} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Correo
          <input name="email" type="email" value={v.email} onChange={cambia('email')} maxLength={120} className={campo} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Plazo de pago (días)
          <input name="paymentTermDays" value={v.plazo} onChange={cambia('plazo')} inputMode="numeric" maxLength={3} aria-invalid={plazoInvalido} className={campo} />
          <span className="text-xs font-normal text-ink-muted">Con este plazo se sugiere el vencimiento de sus compras a crédito. 0 = sin plazo.</span>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Dirección
        <input name="address" value={v.address} onChange={cambia('address')} maxLength={200} className={campo} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Notas
        <textarea name="notes" value={v.notes} onChange={cambia('notes')} maxLength={500} rows={2} className={`${campo} h-auto py-2`} />
      </label>
      {error && <p role="alert" data-form="error" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" data-boton="guardar-proveedor" disabled={pendiente || !enLinea} className="h-touch flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">
          {pendiente ? 'Guardando…' : modo === 'crear' ? 'Crear proveedor' : 'Guardar cambios'}
        </button>
        {onCancelar && <button type="button" onClick={onCancelar} className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Cancelar</button>}
      </div>
    </form>
  )
}
