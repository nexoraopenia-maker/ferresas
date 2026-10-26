'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { darDeBajaCliente, reactivarCliente } from '../actions'
import type { CuentaAbonable } from '../abono-ui'
import { ModalAbono } from './ModalAbono'

/**
 * Botones de la cabecera de la ficha: registrar un abono, bajar o reactivar al cliente. Cada uno solo aparece con su permiso; el
 * servidor decide igualmente.
 */
export function AccionesCliente({ customerId, nombre, activo, deudaTotal, cuentas, puedeAbonar, puedeGestionar, puedeOperar }: {
  customerId: string
  nombre: string
  activo: boolean
  deudaTotal: number
  cuentas: readonly CuentaAbonable[]
  puedeAbonar: boolean
  puedeGestionar: boolean
  puedeOperar: boolean
}) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [abono, setAbono] = useState(false)
  const [baja, setBaja] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [error, setError] = useState<string | null>(null)

  const confirmarBaja = () => {
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    setError(null)
    startTransition(async () => {
      const r = await darDeBajaCliente({ customerId, motivo })
      if (!r.ok) { setError(r.message); return }
      setBaja(false); router.refresh()
    })
  }
  const reactivar = () => {
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    setError(null)
    startTransition(async () => {
      const r = await reactivarCliente({ customerId })
      if (!r.ok) { setError(r.message); return }
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {puedeAbonar && activo && deudaTotal > 0 && (
          <button type="button" data-boton="abonar" onClick={() => setAbono(true)} disabled={!puedeOperar}
            className="h-touch rounded-xl bg-industrial-600 px-4 font-bold text-white disabled:opacity-40">Registrar abono</button>
        )}
        <a href={`/api/clientes/${customerId}/estado-cuenta`} data-enlace="estado-cuenta-csv" download
          className="inline-flex h-touch items-center rounded-xl border border-hairline px-4 font-semibold text-ink">Estado de cuenta (CSV)</a>
        {puedeGestionar && activo && (
          <button type="button" data-boton="baja" onClick={() => setBaja((v) => !v)} disabled={!puedeOperar}
            className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink disabled:opacity-40">Dar de baja</button>
        )}
        {puedeGestionar && !activo && (
          <button type="button" data-boton="reactivar" onClick={reactivar} disabled={!puedeOperar || pendiente}
            className="h-touch rounded-xl bg-industrial-600 px-4 font-bold text-white disabled:opacity-40">Reactivar cliente</button>
        )}
      </div>
      {baja && (
        <form data-form="baja" onSubmit={(e) => { e.preventDefault(); confirmarBaja() }} className="flex flex-col gap-2 rounded-2xl border-2 border-stock-low bg-surface p-4">
          <p className="text-sm text-ink">Dar de baja a <b>{nombre}</b> lo oculta de las listas y del POS. No se borra nada, y se puede reactivar. Si debe dinero, no se permite.</p>
          <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} maxLength={200} required minLength={3} placeholder="Motivo"
            className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink" aria-label="Motivo de la baja" />
          <div className="flex gap-2">
            <button type="submit" disabled={pendiente || !enLinea || motivo.trim().length < 3} className="h-touch flex-1 rounded-xl bg-stock-out font-bold text-white disabled:opacity-40">Confirmar la baja</button>
            <button type="button" onClick={() => setBaja(false)} className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Cancelar</button>
          </div>
        </form>
      )}
      {error && <p role="alert" data-form="error" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
      <ModalAbono abierto={abono} onCerrar={() => setAbono(false)} customerId={customerId} nombre={nombre} cuentas={cuentas} deudaTotal={deudaTotal} />
    </div>
  )
}
