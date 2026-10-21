'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { guardarProveedorPse, probarProveedorPse, quitarProveedorPse } from '../actions'

/**
 * Proveedor de facturación electrónica (PSE). Solo el dueño.
 *
 * El token se escribe una vez y NO vuelve a mostrarse: el servidor lo guarda
 * cifrado y esta pantalla solo sabe si «hay uno».
 */
export function PseConfig({
  configurado, host, claveMaestra, puedeOperar,
}: { configurado: boolean; host: string | null; claveMaestra: boolean; puedeOperar: boolean }) {
  const router = useRouter()
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [editando, setEditando] = useState(!configurado)
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const guardar = () => {
    setMsg(null)
    startTransition(async () => {
      const r = await guardarProveedorPse({ url, token })
      if (!r.ok) { setMsg({ ok: false, texto: r.message }); return }
      setToken(''); setUrl(''); setEditando(false)
      setMsg({ ok: true, texto: 'Guardado. El token quedó cifrado y no se vuelve a mostrar.' })
      router.refresh()
    })
  }
  const probar = () => {
    setMsg(null)
    startTransition(async () => {
      const r = await probarProveedorPse()
      setMsg(r.ok ? { ok: r.data.ok, texto: r.data.mensaje + (r.data.certificadoVenceEn ? ` Certificado vence el ${r.data.certificadoVenceEn}.` : '') } : { ok: false, texto: r.message })
    })
  }
  const quitar = () => {
    if (!window.confirm('¿Quitar el proveedor de facturación? Los comprobantes nuevos quedarán pendientes de envío.')) return
    startTransition(async () => {
      const r = await quitarProveedorPse()
      if (!r.ok) { setMsg({ ok: false, texto: r.message }); return }
      setEditando(true); setMsg(null)
      router.refresh()
    })
  }

  const campo = 'h-touch w-full rounded-xl border border-hairline bg-surface px-3 text-base text-ink'
  return (
    <section className="rounded-2xl border border-hairline bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-ink">Proveedor de facturación electrónica</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            {configurado
              ? <>Conectado a <b className="text-ink">{host}</b>. Él firma y envía a SUNAT; tú no subes ningún certificado.</>
              : 'Sin configurar: los comprobantes se emiten y quedan pendientes de envío.'}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${configurado ? 'bg-stock-ok-soft text-stock-ok' : 'bg-stock-low-soft text-stock-low'}`}>
          {configurado ? 'Configurado' : 'Pendiente'}
        </span>
      </div>

      {!claveMaestra && (
        <p className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
          El servidor no tiene la clave para guardar credenciales de forma segura. Avisa a soporte antes de configurar.
        </p>
      )}

      {puedeOperar && claveMaestra && (editando ? (
        <div className="mt-3 flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">URL del servicio (https)</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.tu-proveedor.pe/v1" autoComplete="off" className={campo} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">Token de acceso</span>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" className={campo} />
          </label>
          <div className="flex gap-2">
            {configurado && <button type="button" onClick={() => setEditando(false)} className="h-touch flex-1 rounded-xl border border-hairline font-semibold text-ink">Cancelar</button>}
            <button type="button" disabled={pending || url.length < 8 || token.length < 8} onClick={guardar} className="h-touch flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">
              {pending ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={pending} onClick={probar} className="h-touch rounded-xl bg-industrial-600 px-4 font-bold text-white disabled:opacity-50">Probar conexión</button>
          <button type="button" onClick={() => setEditando(true)} className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Cambiar</button>
          <button type="button" disabled={pending} onClick={quitar} className="h-touch rounded-xl px-4 font-semibold text-stock-out">Quitar</button>
        </div>
      ))}

      {msg && <p role="status" className={`mt-3 rounded-xl px-3 py-2 text-sm font-semibold ${msg.ok ? 'bg-stock-ok-soft text-stock-ok' : 'bg-stock-out-soft text-stock-out'}`}>{msg.texto}</p>}
    </section>
  )
}
