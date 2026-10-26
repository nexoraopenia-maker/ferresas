'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { crearCliente, editarCliente } from '../actions'

export interface DatosCliente { id: string; name: string; docNumber: string | null; phone: string | null; email: string | null; address: string | null; notes: string | null }

export const MENSAJE_DOC_BLOQUEADO = 'El documento no se puede cambiar: el cliente ya tiene ventas y alteraría sus comprobantes.'

const campo = 'h-touch w-full rounded-xl border border-hairline bg-surface px-3 text-base text-ink disabled:bg-surface-sunken disabled:text-ink-muted'

/**
 * Alta y edición de un cliente. Solo los DATOS de la persona: la línea de crédito, el plazo y el bloqueo NO están aquí (son de
 * `credito.limite`, en su propio bloque). El servicio vuelve a decidir permisos y reglas; esto es la comodidad de decirlo antes.
 */
export function FormularioCliente({ modo, inicial, documentoEditable, onCancelar, onListo }: {
  modo: 'crear' | 'editar'
  inicial?: DatosCliente
  documentoEditable: boolean
  onCancelar?: () => void
  onListo?: () => void
}) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [v, setV] = useState({
    name: inicial?.name ?? '', docNumber: inicial?.docNumber ?? '', phone: inicial?.phone ?? '',
    email: inicial?.email ?? '', address: inicial?.address ?? '', notes: inicial?.notes ?? '',
  })
  const cambia = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }))

  const guardar = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    setError(null)
    startTransition(async () => {
      const datos = { name: v.name, docNumber: v.docNumber, phone: v.phone, email: v.email, address: v.address, notes: v.notes }
      const r = modo === 'crear' ? await crearCliente(datos) : await editarCliente({ ...datos, customerId: inicial!.id })
      if (!r.ok) { setError(r.message); return }
      if (modo === 'crear') router.push(`/clientes/${(r.data as { id: string }).id}`)
      else router.refresh()
      onListo?.()
    })
  }

  return (
    <form onSubmit={guardar} data-form={modo} className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4">
      <h3 className="font-bold text-ink">{modo === 'crear' ? 'Nuevo cliente' : 'Datos del cliente'}</h3>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Nombre o razón social
        <input name="name" value={v.name} onChange={cambia('name')} required minLength={2} maxLength={120} className={campo} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">DNI o RUC
        <input name="docNumber" value={v.docNumber} onChange={cambia('docNumber')} inputMode="numeric" maxLength={15}
          disabled={modo === 'editar' && !documentoEditable} placeholder="Opcional; sin documento no se le puede fiar" className={campo} />
        {modo === 'editar' && !documentoEditable && <span data-aviso="doc-bloqueado" className="text-xs font-normal text-ink-muted">{MENSAJE_DOC_BLOQUEADO}</span>}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Teléfono
          <input name="phone" value={v.phone} onChange={cambia('phone')} inputMode="tel" maxLength={30} className={campo} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Correo
          <input name="email" type="email" value={v.email} onChange={cambia('email')} maxLength={120} className={campo} />
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
        <button type="submit" disabled={pendiente || !enLinea} className="h-touch flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">
          {pendiente ? 'Guardando…' : modo === 'crear' ? 'Crear cliente' : 'Guardar cambios'}
        </button>
        {onCancelar && <button type="button" onClick={onCancelar} className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Cancelar</button>}
      </div>
    </form>
  )
}
