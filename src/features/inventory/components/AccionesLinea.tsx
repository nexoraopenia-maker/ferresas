'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { aprobarLineaAccion, rechazarLineaAccion, solicitarRecuentoAccion } from '../conteo-actions'
import type { LineaRevision } from '../conteo-revision'

/**
 * Las decisiones sobre UNA línea del conteo (F6.5c): aprobar, recontar o rechazar. Una diferencia grande no se aprueba de un toque: primero se avisa y se pide confirmarla (y si el
 * servidor la rechaza por grande —`COUNT_OVER_THRESHOLD`— se vuelve a preguntar). Recontar y rechazar piden el motivo.
 */

type Paso = null | 'confirmar-umbral' | 'recontar' | 'rechazar'

export function AccionesLinea({ countId, linea }: { countId: string; linea: Pick<LineaRevision, 'id' | 'estado' | 'alertas' | 'nombre'> }) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [paso, setPaso] = useState<Paso>(null)
  const [motivo, setMotivo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendiente, startTransition] = useTransition()
  const grande = linea.alertas.includes('SOBRE_UMBRAL')
  const puedeAprobar = linea.estado === 'CONTADO' || linea.estado === 'RECHAZADO'
  const puedeRechazar = linea.estado === 'CONTADO' || linea.estado === 'APROBADO'
  const puedeRecontar = linea.estado !== 'RECONTAR'
  if (!puedeAprobar && !puedeRechazar && !puedeRecontar) return null

  const hecho = () => { setPaso(null); setMotivo(''); router.refresh() }
  const correr = (f: () => Promise<{ ok: boolean; message?: string; code?: string }>, alError?: (code?: string) => boolean) => {
    setError(null)
    startTransition(async () => {
      const r = await f()
      if (r.ok) { hecho(); return }
      if (alError?.(r.code)) return
      setError(r.message ?? 'No se pudo completar.')
    })
  }
  const aprobar = (confirmaUmbral: boolean) => correr(
    () => aprobarLineaAccion({ countId, itemId: linea.id, confirmaUmbral }),
    (code) => { if (code === 'COUNT_OVER_THRESHOLD') { setPaso('confirmar-umbral'); return true } return false },
  )
  const deshabilitado = pendiente || !enLinea
  const b = 'h-touch rounded-lg px-3 text-xs font-bold disabled:opacity-40'

  return (
    <div data-linea-acciones={linea.id} className="flex flex-col gap-1">
      {paso === null && (
        <div className="flex flex-wrap gap-1">
          {puedeAprobar && <button type="button" data-accion="aprobar" disabled={deshabilitado} onClick={() => (grande ? setPaso('confirmar-umbral') : aprobar(false))} className={`${b} bg-industrial-600 text-white`}>Aprobar</button>}
          {puedeRecontar && <button type="button" data-accion="recontar" disabled={deshabilitado} onClick={() => setPaso('recontar')} className={`${b} border border-hairline text-ink`}>Recontar</button>}
          {puedeRechazar && <button type="button" data-accion="rechazar" disabled={deshabilitado} onClick={() => setPaso('rechazar')} className={`${b} border border-stock-out text-stock-out`}>Rechazar</button>}
        </div>
      )}
      {paso === 'confirmar-umbral' && (
        <div data-linea="confirmar-umbral" className="flex flex-col gap-1 rounded-lg border-2 border-stock-low bg-stock-low-soft p-2">
          <p className="text-xs font-semibold text-stock-low">Es una diferencia grande de «{linea.nombre}»: conviene recontar. ¿Aprobarla igual?</p>
          <div className="flex gap-1">
            <button type="button" data-accion="recontar-en-lugar" disabled={deshabilitado} onClick={() => setPaso('recontar')} className={`${b} border border-hairline bg-surface text-ink`}>Mejor recontar</button>
            <button type="button" data-accion="aprobar-igual" disabled={deshabilitado} onClick={() => aprobar(true)} className={`${b} bg-stock-low text-white`}>Aprobar igual</button>
          </div>
        </div>
      )}
      {(paso === 'recontar' || paso === 'rechazar') && (
        <div data-linea={paso} className="flex flex-col gap-1">
          <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder={paso === 'recontar' ? 'Por qué se recuenta' : 'Por qué se rechaza'} aria-label="Motivo" maxLength={280} className="h-touch rounded-lg border border-hairline bg-surface px-2 text-sm text-ink" />
          <div className="flex gap-1">
            <button type="button" onClick={() => { setPaso(null); setMotivo('') }} className={`${b} border border-hairline text-ink`}>Volver</button>
            <button type="button" data-accion={`confirmar-${paso}`} disabled={deshabilitado || motivo.trim().length < 3}
              onClick={() => correr(() => (paso === 'recontar' ? solicitarRecuentoAccion({ countId, itemId: linea.id, reason: motivo.trim() }) : rechazarLineaAccion({ countId, itemId: linea.id, reason: motivo.trim() })))}
              className={`${b} ${paso === 'recontar' ? 'bg-industrial-600 text-white' : 'bg-stock-out text-white'}`}>{paso === 'recontar' ? 'Mandar a recontar' : 'Rechazar'}</button>
          </div>
        </div>
      )}
      {!enLinea && <p role="status" className="text-xs text-stock-low">{MENSAJE_SIN_RED}</p>}
      {error && <p role="alert" data-linea="error" className="text-xs font-semibold text-stock-out">{error}</p>}
    </div>
  )
}
