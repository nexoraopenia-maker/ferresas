'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { cancelarConteoAccion, cerrarConteoAccion, iniciarConteoAccion } from '../conteo-actions'
import type { AccionesConteo as Acciones } from '../conteo-ui'

/** Los botones del ciclo de una toma de inventario (F6.5c): iniciar, cerrar y cancelar (con motivo). Solo se ofrece lo que el estado y los permisos permiten; el servidor lo vuelve a comprobar. */

export function AccionesConteo({ countId, acciones }: { countId: string; acciones: Pick<Acciones, 'iniciar' | 'cerrar' | 'cancelar'> }) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [error, setError] = useState<string | null>(null)
  const [cancelando, setCancelando] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [pendiente, startTransition] = useTransition()
  if (!acciones.iniciar && !acciones.cerrar && !acciones.cancelar) return null

  const ejecutar = (f: () => Promise<{ ok: boolean; message?: string }>) => {
    setError(null)
    startTransition(async () => {
      const r = await f()
      if (!r.ok) { setError(r.message ?? 'No se pudo completar.'); return }
      setCancelando(false); setMotivo('')
      router.refresh()
    })
  }
  const boton = 'h-touch rounded-xl px-5 text-sm font-bold disabled:opacity-40'
  return (
    <section data-conteo="acciones" className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4">
      <div className="flex flex-wrap gap-2">
        {acciones.iniciar && <button type="button" data-accion="iniciar" disabled={pendiente || !enLinea} onClick={() => ejecutar(() => iniciarConteoAccion({ countId }))} className={`${boton} bg-industrial-600 text-white`}>Iniciar el conteo</button>}
        {acciones.cerrar && <button type="button" data-accion="cerrar" disabled={pendiente || !enLinea} onClick={() => ejecutar(() => cerrarConteoAccion({ countId }))} className={`${boton} bg-industrial-600 text-white`}>Cerrar el conteo y pasar a revisión</button>}
        {acciones.cancelar && !cancelando && <button type="button" data-accion="cancelar" onClick={() => setCancelando(true)} className={`${boton} border border-hairline text-ink`}>Cancelar</button>}
      </div>
      {acciones.iniciar && <p className="text-xs text-ink-muted">Al iniciar se toma una foto del stock y ya se puede contar. Las ventas no se detienen.</p>}
      {acciones.cerrar && <p className="text-xs text-ink-muted">Al cerrar ya no entran más conteos (solo se recuenta lo que el revisor mande a recontar).</p>}
      {cancelando && (
        <div data-conteo="cancelar" className="flex flex-col gap-2">
          <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo de la cancelación" aria-label="Motivo de la cancelación" maxLength={280} className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base text-ink" />
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setCancelando(false)} className={`${boton} border border-hairline text-ink`}>Volver</button>
            <button type="button" data-accion="confirmar-cancelar" disabled={pendiente || !enLinea || motivo.trim().length < 3} onClick={() => ejecutar(() => cancelarConteoAccion({ countId, reason: motivo.trim() }))} className={`${boton} bg-stock-out text-white`}>Cancelar la toma</button>
          </div>
        </div>
      )}
      {!enLinea && <p role="status" className="text-sm text-stock-low">{MENSAJE_SIN_RED}</p>}
      {error && <p role="alert" data-conteo="error" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
    </section>
  )
}
