'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { aplicarConteoAccion, aprobarSinAlertasAccion } from '../conteo-actions'
import type { EstadoRevision } from '../conteo-revision'

/**
 * La barra de la revisión (F6.5c): el estado de las decisiones, «Aprobar todas sin alerta» (por tandas hasta terminar) y «Aplicar conteo» (con confirmación; el servidor aplica por
 * tandas y esto repite hasta que el conteo queda APLICADO o algo lo detiene). Solo la ve quien puede decidir (`stock.ajustar`).
 */

export function BarraRevision({ countId, estado, puedeDecidir, aplicable }: { countId: string; estado: EstadoRevision; puedeDecidir: boolean; aplicable: boolean }) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null)
  const [confirmando, setConfirmando] = useState(false)
  const [pendiente, startTransition] = useTransition()

  const aprobarLimpias = () => {
    setAviso(null)
    startTransition(async () => {
      let aprobadas = 0, conAlerta = 0
      let cursor: string | undefined
      for (let i = 0; i < 100; i++) {
        const r = await aprobarSinAlertasAccion({ countId, ...(cursor ? { cursor } : {}) })
        if (!r.ok) { setAviso({ tipo: 'error', texto: r.message }); router.refresh(); return }
        aprobadas += r.data.aprobadas; conAlerta += r.data.conAlerta
        if (!r.data.siguiente) break
        cursor = r.data.siguiente
      }
      setAviso({ tipo: 'ok', texto: `Se aprobaron ${aprobadas} línea(s) sin alertas. ${conAlerta > 0 ? `${conAlerta} quedan para revisar a mano.` : ''}` })
      router.refresh()
    })
  }

  const aplicar = () => {
    setAviso(null); setConfirmando(false)
    startTransition(async () => {
      let movimientos = 0
      for (let i = 0; i < 100; i++) {
        const r = await aplicarConteoAccion({ countId })
        if (!r.ok) { setAviso({ tipo: 'error', texto: movimientos > 0 ? `${r.message} (ya se aplicaron ${movimientos} ajuste(s); puedes seguir cuando lo resuelvas.)` : r.message }); router.refresh(); return }
        movimientos += r.data.movimientos
        if (r.data.estado === 'APLICADO') { setAviso({ tipo: 'ok', texto: `Conteo aplicado: ${movimientos} ajuste(s) al stock.` }); router.refresh(); return }
      }
      setAviso({ tipo: 'error', texto: 'La aplicación sigue en curso: vuelve a pulsar «Aplicar conteo» para continuar.' })
      router.refresh()
    })
  }

  const dato = (k: string, v: number) => <div key={k}><dt className="text-xs text-ink-muted">{k}</dt><dd className="font-semibold text-ink">{v}</dd></div>
  return (
    <section data-revision="barra" className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4">
      <dl data-revision="estado" className="grid grid-cols-3 gap-3 text-sm sm:grid-cols-6">
        {dato('Líneas', estado.lineas)}{dato('Sin contar', estado.sinContar)}{dato('Por decidir', estado.contadas)}{dato('Por recontar', estado.porRecontar)}{dato('Aprobadas', estado.aprobadas)}{dato('Rechazadas', estado.rechazadas)}
      </dl>
      {estado.aplicadas > 0 && <p data-revision="aplicadas" className="text-sm font-semibold text-stock-ok">{estado.aplicadas} ajuste(s) ya aplicados al stock; faltan {estado.porAplicar}.</p>}
      {puedeDecidir && (
        <div className="flex flex-wrap gap-2">
          <button type="button" data-revision="aprobar-limpias" onClick={aprobarLimpias} disabled={pendiente || !enLinea || estado.contadas === 0} className="h-touch rounded-xl border border-hairline px-4 text-sm font-bold text-ink disabled:opacity-40">Aprobar todas sin alerta</button>
          {aplicable && !confirmando && <button type="button" data-revision="aplicar" onClick={() => setConfirmando(true)} disabled={pendiente || !enLinea} className="h-touch rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-40">Aplicar conteo</button>}
        </div>
      )}
      {confirmando && (
        <div data-revision="confirmar-aplicar" className="flex flex-col gap-2 rounded-xl border-2 border-stock-low bg-stock-low-soft p-3">
          <p className="text-sm font-semibold text-stock-low">Se ajustará el stock con lo aprobado ({estado.porAplicar} línea(s) con diferencia). Las ventas hechas desde que se contó se conservan. Esto no se deshace.</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setConfirmando(false)} className="h-touch rounded-xl border border-hairline bg-surface text-sm font-semibold text-ink">Volver</button>
            <button type="button" data-revision="confirmar" onClick={aplicar} disabled={pendiente || !enLinea} className="h-touch rounded-xl bg-industrial-600 text-sm font-bold text-white">Sí, aplicar</button>
          </div>
        </div>
      )}
      {pendiente && <p role="status" className="text-sm text-ink-muted">Trabajando…</p>}
      {!enLinea && <p role="status" className="text-sm text-stock-low">{MENSAJE_SIN_RED}</p>}
      {aviso && <p role={aviso.tipo === 'error' ? 'alert' : 'status'} data-revision="aviso" data-tipo={aviso.tipo} className={`rounded-xl px-3 py-2 text-sm font-semibold ${aviso.tipo === 'ok' ? 'bg-stock-ok-soft text-stock-ok' : 'bg-stock-out-soft text-stock-out'}`}>{aviso.texto}</p>}
    </section>
  )
}
