'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { guardarDatosFiscalesAction } from '../actions'

/**
 * «Datos fiscales del negocio»: RUC y razón social, el primer paso de la configuración fiscal (el certificado de SUNAT debe ser del MISMO RUC). Solo el dueño (`config.fiscal`).
 * El RUC se bloquea cuando ya hay certificado, facturación real o comprobantes reales: entonces lo cambia soporte (el servicio lo vuelve a exigir).
 */
export function DatosFiscalesForm({
  ruc, razonSocial, rucBloqueadoPor, puedeOperar,
}: { ruc: string | null; razonSocial: string | null; rucBloqueadoPor: string | null; puedeOperar: boolean }) {
  const router = useRouter()
  const [rucTxt, setRucTxt] = useState(ruc ?? '')
  const [razon, setRazon] = useState(razonSocial ?? '')
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null)
  const [pendiente, startTransition] = useTransition()

  const campo = 'h-touch w-full rounded-xl border border-hairline bg-surface px-3 text-base text-ink disabled:opacity-60'
  const completo = !!ruc && !!razonSocial
  const cambio = rucTxt.trim() !== (ruc ?? '') || razon.trim() !== (razonSocial ?? '')
  const listo = /^\d{11}$/.test(rucTxt.replace(/\s+/g, '')) && razon.trim().length >= 3 && cambio

  const guardar = () => {
    setMsg(null)
    startTransition(async () => {
      const r = await guardarDatosFiscalesAction({ ruc: rucTxt, razonSocial: razon })
      if (!r.ok) { setMsg({ ok: false, texto: r.message }); return }
      setMsg({ ok: true, texto: 'Datos fiscales guardados.' })
      router.refresh()
    })
  }

  return (
    <section data-fiscal="datos" className="rounded-2xl border border-hairline bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-ink">Datos fiscales del negocio</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            {completo ? <>RUC <b className="font-mono text-ink">{ruc}</b> · {razonSocial}</> : 'Falta el RUC y la razón social: sin ellos no se puede cargar el certificado ni enviar comprobantes.'}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${completo ? 'bg-stock-ok-soft text-stock-ok' : 'bg-stock-low-soft text-stock-low'}`}>{completo ? 'Completo' : 'Pendiente'}</span>
      </div>

      {puedeOperar && (
        <div className="mt-3 flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">RUC (11 dígitos)</span>
            <input data-fiscal="ruc" inputMode="numeric" maxLength={11} value={rucTxt} onChange={(e) => setRucTxt(e.target.value.replace(/\D/g, ''))} disabled={!!rucBloqueadoPor || pendiente} className={campo + ' font-mono'} />
          </label>
          {rucBloqueadoPor && <p data-fiscal="bloqueo" className="text-xs font-semibold text-stock-low">{rucBloqueadoPor}</p>}
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">Razón social (como figura en SUNAT)</span>
            <input data-fiscal="razon" value={razon} maxLength={200} onChange={(e) => setRazon(e.target.value)} disabled={pendiente} placeholder="FERRETERÍA EL SOL S.A.C." className={campo} />
          </label>
          <div className="flex items-center gap-3">
            <button type="button" data-fiscal="guardar" disabled={!listo || pendiente} onClick={guardar} className="h-touch rounded-lg bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-50">{pendiente ? 'Guardando…' : 'Guardar datos'}</button>
            {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm font-semibold ${msg.ok ? 'text-stock-ok' : 'text-stock-out'}`}>{msg.texto}</p>}
          </div>
        </div>
      )}
    </section>
  )
}
