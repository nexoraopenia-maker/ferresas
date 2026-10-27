'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { anularCompra, recibirCompra } from '../actions'
import type { CondicionCompra, EstadoCompra } from '../borrador-ui'

const money = (n: number) => `S/ ${n.toFixed(2)}`

export const MENSAJE_ANULAR_SIN_AJUSTE = 'Anular una compra recibida devuelve la mercadería: necesitas además el permiso de ajustar el inventario.'

export interface PermisosCompra {
  /** `compras.registrar`: editar el borrador, recibir, anular. */
  puedeRegistrar: boolean
  /** `stock.ajustar`: además, para anular una compra ya RECIBIDA (sale mercadería). */
  puedeAjustar: boolean
  /** La cuenta del negocio permite escribir. */
  puedeOperar: boolean
}

/**
 * Lo que se puede hacer con una compra según su estado. Recibir y anular piden confirmación porque mueven stock, costos y deuda.
 * Cada botón aparece solo con su permiso; el servidor decide igualmente (y rechaza anular si el stock ya salió o hay pagos).
 */
export function AccionesCompra({ purchaseId, estado, condicion, total, lineas, conPagos, permisos }: {
  purchaseId: string
  estado: EstadoCompra
  condicion: CondicionCompra
  total: number
  lineas: number
  /** La cuenta por pagar ya tiene pagos: anular se rechazará hasta anularlos. */
  conPagos: boolean
  permisos: PermisosCompra
}) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [abierto, setAbierto] = useState<'recibir' | 'anular' | null>(null)
  const [motivo, setMotivo] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!permisos.puedeRegistrar || estado === 'ANULADA') return null
  const puedeAnular = estado === 'BORRADOR' || permisos.puedeAjustar

  const ejecutar = (que: 'recibir' | 'anular') => {
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    setError(null)
    startTransition(async () => {
      const r = que === 'recibir' ? await recibirCompra({ purchaseId }) : await anularCompra({ purchaseId, motivo })
      if (!r.ok) { setError(r.message); return }
      setAbierto(null); setMotivo(''); router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {estado === 'BORRADOR' && (
          <>
            <button type="button" data-boton="recibir" onClick={() => setAbierto(abierto === 'recibir' ? null : 'recibir')} disabled={!permisos.puedeOperar}
              className="h-touch rounded-xl bg-industrial-600 px-4 font-bold text-white disabled:opacity-40">Recibir mercadería</button>
            <Link href={`/compras/${purchaseId}/editar`} data-enlace="editar" aria-disabled={!permisos.puedeOperar}
              className={`inline-flex h-touch items-center rounded-xl border border-hairline px-4 font-semibold text-ink ${permisos.puedeOperar ? '' : 'pointer-events-none opacity-40'}`}>Editar</Link>
          </>
        )}
        {puedeAnular && (
          <button type="button" data-boton="anular" onClick={() => setAbierto(abierto === 'anular' ? null : 'anular')} disabled={!permisos.puedeOperar}
            className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink disabled:opacity-40">{estado === 'BORRADOR' ? 'Descartar borrador' : 'Anular compra'}</button>
        )}
      </div>
      {estado === 'RECIBIDA' && !permisos.puedeAjustar && <p data-aviso="anular-sin-ajuste" className="text-xs text-ink-muted">{MENSAJE_ANULAR_SIN_AJUSTE}</p>}

      {abierto === 'recibir' && (
        <form data-form="recibir" onSubmit={(e) => { e.preventDefault(); ejecutar('recibir') }} className="flex flex-col gap-2 rounded-2xl border-2 border-industrial-600 bg-surface p-4 text-sm text-ink">
          <p className="font-bold">¿Llegó la mercadería?</p>
          <ul className="list-disc pl-5">
            <li>Entran al almacén los {lineas} {lineas === 1 ? 'producto' : 'productos'} de la compra.</li>
            <li>Se actualiza el costo promedio de cada producto (sin IGV).</li>
            {condicion === 'CREDITO' && <li data-aviso="nace-deuda">Nace una deuda con el proveedor por {money(total)}.</li>}
          </ul>
          <p className="text-xs text-ink-muted">Después ya no se puede editar; si te equivocas, se anula (solo mientras el stock siga ahí y sin pagos).</p>
          <div className="flex gap-2">
            <button type="submit" data-boton="confirmar-recibir" disabled={pendiente || !enLinea} className="h-touch flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">{pendiente ? 'Recibiendo…' : 'Sí, recibir'}</button>
            <button type="button" onClick={() => setAbierto(null)} className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Cancelar</button>
          </div>
        </form>
      )}

      {abierto === 'anular' && (
        <form data-form="anular" onSubmit={(e) => { e.preventDefault(); ejecutar('anular') }} className="flex flex-col gap-2 rounded-2xl border-2 border-stock-low bg-surface p-4 text-sm text-ink">
          {estado === 'BORRADOR' ? (
            <p>El borrador queda anulado (no se borra). No toca stock ni costos.</p>
          ) : (
            <>
              <p>Anular devuelve la mercadería al proveedor: sale el stock de cada producto, se revierte el costo promedio{condicion === 'CREDITO' ? ' y se cierra la deuda' : ''}.</p>
              <p className="text-xs text-ink-muted">No se permite si parte de la mercadería ya se vendió (el stock quedaría en negativo) ni si la compra tiene pagos.</p>
              {conPagos && <p data-aviso="anular-con-pagos" className="font-semibold text-stock-out">Esta compra tiene pagos: anula primero esos pagos.</p>}
            </>
          )}
          <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} maxLength={300} required minLength={3} placeholder="Motivo"
            className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink" aria-label="Motivo de la anulación" />
          <div className="flex gap-2">
            <button type="submit" data-boton="confirmar-anular" disabled={pendiente || !enLinea || motivo.trim().length < 3 || conPagos} className="h-touch flex-1 rounded-xl bg-stock-out font-bold text-white disabled:opacity-40">{pendiente ? 'Anulando…' : 'Confirmar'}</button>
            <button type="button" onClick={() => setAbierto(null)} className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Cancelar</button>
          </div>
        </form>
      )}
      {error && <p role="alert" data-form="error" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
    </div>
  )
}
