'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { reintentarBajaAction, solicitarBajaAction } from '../actions'

/** Largo máximo del motivo (el servicio y la base lo vuelven a exigir). */
const MOTIVO_MAX = 100

/**
 * Botón + diálogo para comunicar a SUNAT la baja de una factura ya aceptada. Si `razonBloqueo` viene informada, el botón sale desactivado y la dice: es solo la cara
 * visible, el servicio vuelve a comprobar todo. Dar de baja es solo FISCAL: no devuelve la venta, el stock ni el dinero (para eso está la devolución).
 */
export function DarDeBajaDialog({
  taxDocumentId, numero, razonBloqueo, agotada,
}: {
  taxDocumentId: string
  numero: string
  razonBloqueo: string | null
  /** La baja anterior se quedó sin respuesta: en vez de pedir otra, se reintenta. */
  agotada: boolean
}) {
  const router = useRouter()
  const [abierto, setAbierto] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [confirmado, setConfirmado] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hecho, setHecho] = useState<string | null>(null)
  const [pendiente, startTransition] = useTransition()

  const cambiar = (v: boolean) => {
    if (!v && pendiente) return
    if (!v) { if (hecho) router.refresh(); setMotivo(''); setConfirmado(false); setError(null); setHecho(null) }
    setAbierto(v)
  }

  const reintentar = () => {
    setError(null)
    startTransition(async () => {
      const r = await reintentarBajaAction({ taxDocumentId })
      if (!r.ok) { setError(r.message); return }
      router.refresh()
    })
  }

  const pedir = () => {
    setError(null)
    startTransition(async () => {
      const r = await solicitarBajaAction({ taxDocumentId, motivo })
      if (!r.ok) { setError(r.message); return }
      setHecho(r.data.identificador)
    })
  }

  if (agotada) {
    return (
      <div className="max-w-[12rem]">
        <button type="button" data-baja="reintentar" disabled={pendiente} onClick={reintentar} className="h-touch rounded-lg border border-hairline px-3 text-sm font-semibold text-ink disabled:opacity-50">
          Reintentar la baja
        </button>
        {error && <p role="alert" className="mt-1 text-xs font-semibold text-stock-out">{error}</p>}
      </div>
    )
  }

  if (razonBloqueo) {
    return (
      <div className="max-w-[12rem]">
        <button type="button" data-baja="bloqueada" disabled className="h-touch rounded-lg border border-hairline px-3 text-sm font-semibold text-ink opacity-50">Dar de baja</button>
        <p className="mt-1 text-xs text-ink-muted">{razonBloqueo}</p>
      </div>
    )
  }

  return (
    <>
      <button type="button" data-baja="abrir" onClick={() => cambiar(true)} className="h-touch rounded-lg border border-hairline px-3 text-sm font-semibold text-ink">Dar de baja</button>
      <Dialog open={abierto} onOpenChange={cambiar}>
        <DialogContent title={hecho ? 'Baja solicitada' : `Dar de baja ${numero}`} size="sm">
          {hecho ? (
            <div data-baja="hecho" className="flex flex-col gap-3">
              <p className="text-sm text-ink-muted">
                La comunicación <span className="font-mono font-bold text-ink">{hecho}</span> quedó en la cola. Se envía a SUNAT en segundos y su respuesta puede tardar unos minutos:
                el comprobante pasa a «Anulado» cuando SUNAT la acepta.
              </p>
              <button type="button" onClick={() => cambiar(false)} className="h-touch rounded-lg bg-industrial-600 px-3 text-sm font-bold text-white">Entendido</button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-ink-muted">
                Se le pide a SUNAT que anule este comprobante. <strong className="text-ink">Solo cambia lo tributario:</strong> la venta, el stock y el dinero no se tocan.
                Si el cliente devuelve mercadería, usa la devolución.
              </p>
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-ink-muted">Motivo de la baja <span className="font-bold text-stock-out">(obligatorio)</span></span>
                <textarea data-baja="motivo" value={motivo} maxLength={MOTIVO_MAX} onChange={(e) => setMotivo(e.target.value)} rows={2}
                  placeholder="Ej.: error en el RUC del cliente" className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink" />
                <span className="text-right text-xs text-ink-muted">{motivo.length}/{MOTIVO_MAX}</span>
              </label>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input data-baja="confirmar" type="checkbox" checked={confirmado} onChange={(e) => setConfirmado(e.target.checked)} className="mt-1" />
                <span>Entiendo que la baja no se puede deshacer una vez que SUNAT la acepta.</span>
              </label>
              {error && <p role="alert" className="text-sm font-semibold text-stock-out">{error}</p>}
              <div className="flex gap-2">
                <button type="button" disabled={pendiente} onClick={() => cambiar(false)} className="h-touch flex-1 rounded-lg border border-hairline px-3 text-sm font-semibold text-ink">Cancelar</button>
                <button type="button" data-baja="enviar" disabled={pendiente || !confirmado || motivo.trim().length === 0} onClick={pedir}
                  className="h-touch flex-1 rounded-lg bg-stock-out px-3 text-sm font-bold text-white disabled:opacity-50">{pendiente ? 'Pidiendo…' : 'Dar de baja'}</button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
