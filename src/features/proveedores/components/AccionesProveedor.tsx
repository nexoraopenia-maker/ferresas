'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { ModalPago } from '@/features/por-pagar/components/ModalPago'
import type { CuentaPagable } from '@/features/por-pagar/pago-ui'
import { darDeBajaProveedor, reactivarProveedor } from '../actions'

/**
 * Botones de la cabecera de la ficha: registrar una compra a este proveedor, darlo de baja o reactivarlo. Cada uno solo aparece con su
 * permiso; el servidor decide igualmente (y rechaza la baja con deuda o con borradores).
 */
export function AccionesProveedor({ supplierId, nombre, activo, deuda, cuentas, puedePagar, puedeVerDeuda, puedeGestionar, puedeComprar, puedeOperar }: {
  supplierId: string
  nombre: string
  activo: boolean
  deuda: number
  /** Cuentas abiertas, en el orden en que el servidor las aplicaría. */
  cuentas: readonly CuentaPagable[]
  /** `proveedores.pagar`. */
  puedePagar: boolean
  /** Ve las cuentas por pagar (descarga el estado de cuenta). */
  puedeVerDeuda: boolean
  puedeGestionar: boolean
  puedeComprar: boolean
  puedeOperar: boolean
}) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [pago, setPago] = useState(false)
  const [baja, setBaja] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [error, setError] = useState<string | null>(null)

  const confirmarBaja = () => {
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    setError(null)
    startTransition(async () => {
      const r = await darDeBajaProveedor({ supplierId, motivo })
      if (!r.ok) { setError(r.message); return }
      setBaja(false); router.refresh()
    })
  }
  const reactivar = () => {
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    setError(null)
    startTransition(async () => {
      const r = await reactivarProveedor({ supplierId })
      if (!r.ok) { setError(r.message); return }
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {puedeComprar && activo && (
          <Link href={`/compras/nueva?proveedor=${supplierId}`} data-enlace="nueva-compra" aria-disabled={!puedeOperar}
            className={`inline-flex h-touch items-center rounded-xl bg-industrial-600 px-4 font-bold text-white ${puedeOperar ? '' : 'pointer-events-none opacity-40'}`}>Registrar compra</Link>
        )}
        {puedePagar && deuda > 0 && (
          <button type="button" data-boton="pagar" onClick={() => setPago(true)} disabled={!puedeOperar}
            className="h-touch rounded-xl bg-industrial-600 px-4 font-bold text-white disabled:opacity-40">Registrar pago</button>
        )}
        <Link href={`/compras?proveedor=${supplierId}`} data-enlace="compras-del-proveedor"
          className="inline-flex h-touch items-center rounded-xl border border-hairline px-4 font-semibold text-ink">Ver sus compras</Link>
        {puedeVerDeuda && (
          <a href={`/api/proveedores/${supplierId}/estado-cuenta`} data-enlace="estado-cuenta-csv" download
            className="inline-flex h-touch items-center rounded-xl border border-hairline px-4 font-semibold text-ink">Estado de cuenta (CSV)</a>
        )}
        {puedeGestionar && activo && (
          <button type="button" data-boton="baja" onClick={() => setBaja((v) => !v)} disabled={!puedeOperar}
            className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink disabled:opacity-40">Dar de baja</button>
        )}
        {puedeGestionar && !activo && (
          <button type="button" data-boton="reactivar" onClick={reactivar} disabled={!puedeOperar || pendiente}
            className="h-touch rounded-xl bg-industrial-600 px-4 font-bold text-white disabled:opacity-40">Reactivar proveedor</button>
        )}
      </div>
      {baja && (
        <form data-form="baja" onSubmit={(e) => { e.preventDefault(); confirmarBaja() }} className="flex flex-col gap-2 rounded-2xl border-2 border-stock-low bg-surface p-4">
          <p className="text-sm text-ink">Dar de baja a <b>{nombre}</b> lo oculta de las listas y del formulario de compras. No se borra nada, y se puede reactivar.</p>
          {deuda > 0 && <p data-aviso="baja-con-deuda" className="text-sm font-semibold text-stock-out">Le debes S/ {deuda.toFixed(2)}: no se puede dar de baja hasta pagarlo o anular la compra.</p>}
          <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} maxLength={200} required minLength={3} placeholder="Motivo"
            className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink" aria-label="Motivo de la baja" />
          <div className="flex gap-2">
            <button type="submit" data-boton="confirmar-baja" disabled={pendiente || !enLinea || motivo.trim().length < 3 || deuda > 0} className="h-touch flex-1 rounded-xl bg-stock-out font-bold text-white disabled:opacity-40">Confirmar la baja</button>
            <button type="button" onClick={() => setBaja(false)} className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Cancelar</button>
          </div>
        </form>
      )}
      <ModalPago abierto={pago} onCerrar={() => setPago(false)} supplierId={supplierId} nombre={nombre} cuentas={cuentas} deudaTotal={deuda} />
      {error && <p role="alert" data-form="error" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
    </div>
  )
}
