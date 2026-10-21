'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatQuantity, limitarDecimales, parseQuantity, unitLabel } from '@/lib/quantity'
import { searchForPos, type PosProduct } from '@/features/pos/actions'
import { resolverMermaAction, solicitarMermaAction } from '../actions'

interface Fila {
  id: string; estado: 'PENDIENTE' | 'APROBADA' | 'RECHAZADA'; producto: string; sku: string; unitType: string
  cantidad: number; motivo: string; fotoUrl: string | null; solicitante: string; solicitadaEn: string
  resolvio: string | null; resueltaEn: string | null; motivoRechazo: string | null; esMia: boolean
}

const fecha = (iso: string) =>
  new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Lima' }).format(new Date(iso))
const campo = 'h-touch w-full rounded-xl border border-hairline bg-surface px-3 text-base text-ink'
const ESTADO = {
  PENDIENTE: 'bg-stock-low-soft text-stock-low', APROBADA: 'bg-stock-ok-soft text-stock-ok', RECHAZADA: 'bg-stock-out-soft text-stock-out',
} as const

export function MermasManager({
  filas, puedeSolicitar, puedeResolver, puedeOperar,
}: { filas: Fila[]; puedeSolicitar: boolean; puedeResolver: boolean; puedeOperar: boolean }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Solicitar
  const [abierto, setAbierto] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const [candidatos, setCandidatos] = useState<PosProduct[]>([])
  const [producto, setProducto] = useState<PosProduct | null>(null)
  const [cantidad, setCantidad] = useState('')
  const [motivo, setMotivo] = useState('')
  const [foto, setFoto] = useState('')

  // Resolver
  const [rechazando, setRechazando] = useState<string | null>(null)
  const [motivoRechazo, setMotivoRechazo] = useState('')
  const [permitirNegativo, setPermitirNegativo] = useState(false)

  const buscar = (v: string) => {
    setBusqueda(v)
    if (v.trim().length < 2) { setCandidatos([]); return }
    startTransition(async () => {
      const r = await searchForPos(v)
      setCandidatos(r.ok ? r.data : [])
    })
  }

  const solicitar = () => {
    if (!producto) return
    setError(null)
    const q = parseQuantity(cantidad)
    if (!q || q <= 0) { setError('Escribe la cantidad perdida.'); return }
    startTransition(async () => {
      const r = await solicitarMermaAction({
        warehouseId: producto.warehouseId, productId: producto.productId, quantity: q, reason: motivo,
        ...(foto.trim() ? { photoUrl: foto.trim() } : {}),
      })
      if (!r.ok) { setError(r.message); return }
      setAbierto(false); setProducto(null); setBusqueda(''); setCantidad(''); setMotivo(''); setFoto('')
      router.refresh()
    })
  }

  const resolver = (mermaId: string, decision: 'APROBAR' | 'RECHAZAR') => {
    setError(null)
    startTransition(async () => {
      const r = await resolverMermaAction(
        decision === 'APROBAR' ? { mermaId, decision, permitirNegativo } : { mermaId, decision, rejectReason: motivoRechazo },
      )
      if (!r.ok) { setError(r.message); return }
      setRechazando(null); setMotivoRechazo(''); setPermitirNegativo(false)
      router.refresh()
    })
  }

  const pendientes = filas.filter((f) => f.estado === 'PENDIENTE').length

  return (
    <div className="flex flex-col gap-4">
      {error && <p role="alert" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}

      {puedeSolicitar && puedeOperar && (abierto ? (
        <section className="rounded-2xl border-2 border-industrial-600 bg-surface p-4">
          <h2 className="font-bold text-ink">Solicitar una merma</h2>
          {!producto ? (
            <div className="mt-3">
              <input value={busqueda} onChange={(e) => buscar(e.target.value)} placeholder="Busca el producto: código, SKU o nombre…" className={campo} autoFocus />
              {candidatos.length > 0 && (
                <ul className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-hairline bg-surface-raised">
                  {candidatos.map((c) => (
                    <li key={c.productId}>
                      <button type="button" onClick={() => { setProducto(c); setCandidatos([]) }} className="flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left hover:bg-surface-sunken">
                        <span className="min-w-0 truncate text-sm font-semibold text-ink">{c.name}</span>
                        <span className="shrink-0 font-mono text-xs text-ink-muted">hay {formatQuantity(c.stock, c.unitType)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              <p className="rounded-xl bg-surface-sunken px-3 py-2 text-sm font-semibold text-ink">
                {producto.name} <button type="button" onClick={() => setProducto(null)} className="ml-2 text-xs font-semibold text-industrial-700 underline dark:text-industrial-300">cambiar</button>
              </p>
              <input inputMode="decimal" value={cantidad} onChange={(e) => setCantidad(limitarDecimales(e.target.value))} placeholder={`Cantidad perdida (${unitLabel(producto.unitType)})`} className={campo} />
              <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={3} placeholder="¿Qué pasó? (mínimo 10 caracteres)" className="w-full rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink" />
              <input value={foto} onChange={(e) => setFoto(e.target.value)} placeholder="Enlace a una foto (opcional)" className={campo} />
            </div>
          )}
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => { setAbierto(false); setError(null) }} className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink">Cancelar</button>
            <button type="button" disabled={pending || !producto || motivo.trim().length < 10} onClick={solicitar} className="h-touch-lg flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">
              {pending ? 'Enviando…' : 'Solicitar'}
            </button>
          </div>
        </section>
      ) : (
        <button type="button" onClick={() => setAbierto(true)} className="h-touch-lg rounded-xl bg-industrial-600 px-5 font-bold text-white">Solicitar una merma</button>
      ))}

      {puedeResolver && pendientes > 0 && (
        <p className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-bold text-stock-low">
          {pendientes} {pendientes === 1 ? 'merma espera' : 'mermas esperan'} tu revisión.
        </p>
      )}

      {filas.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-hairline px-4 py-10 text-center text-sm text-ink-muted">Todavía no hay mermas registradas.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {filas.map((f) => (
            <li key={f.id} className="rounded-2xl border border-hairline bg-surface p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">{f.producto}</p>
                  <p className="text-xs text-ink-muted">{f.solicitante} · {fecha(f.solicitadaEn)}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-bold text-ink">{formatQuantity(f.cantidad, f.unitType)} {unitLabel(f.unitType)}</p>
                  <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-bold ${ESTADO[f.estado]}`}>{f.estado === 'PENDIENTE' ? 'Pendiente' : f.estado === 'APROBADA' ? 'Aprobada' : 'Rechazada'}</span>
                </div>
              </div>
              <p className="mt-2 text-sm text-ink">{f.motivo}</p>
              {f.fotoUrl && <a href={f.fotoUrl} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 inline-block text-xs font-semibold text-industrial-700 underline dark:text-industrial-300">Ver foto</a>}
              {f.estado !== 'PENDIENTE' && (
                <p className="mt-2 text-xs text-ink-muted">
                  {f.estado === 'APROBADA' ? 'Aprobada' : 'Rechazada'} por {f.resolvio ?? '—'}{f.resueltaEn && <> · {fecha(f.resueltaEn)}</>}
                  {f.motivoRechazo && <> · «{f.motivoRechazo}»</>}
                </p>
              )}

              {f.estado === 'PENDIENTE' && puedeResolver && puedeOperar && (
                f.esMia ? (
                  <p className="mt-3 text-xs font-semibold text-ink-muted">La pediste tú: la tiene que revisar otra persona.</p>
                ) : rechazando === f.id ? (
                  <div className="mt-3 flex flex-col gap-2">
                    <input value={motivoRechazo} onChange={(e) => setMotivoRechazo(e.target.value)} placeholder="Motivo del rechazo (mínimo 5 caracteres)" className={campo} autoFocus />
                    <div className="flex gap-2">
                      <button type="button" onClick={() => { setRechazando(null); setMotivoRechazo('') }} className="h-touch flex-1 rounded-xl border border-hairline font-semibold text-ink">Atrás</button>
                      <button type="button" disabled={pending || motivoRechazo.trim().length < 5} onClick={() => resolver(f.id, 'RECHAZAR')} className="h-touch flex-1 rounded-xl bg-stock-out font-bold text-white disabled:opacity-40">Rechazar</button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button type="button" disabled={pending} onClick={() => resolver(f.id, 'APROBAR')} className="h-touch rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-50">Aprobar</button>
                    <button type="button" disabled={pending} onClick={() => setRechazando(f.id)} className="h-touch rounded-xl border border-hairline px-4 text-sm font-semibold text-stock-out">Rechazar</button>
                    <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                      <input type="checkbox" checked={permitirNegativo} onChange={(e) => setPermitirNegativo(e.target.checked)} />
                      Aunque el saldo quede en negativo
                    </label>
                  </div>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
