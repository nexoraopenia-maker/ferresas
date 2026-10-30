'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { InventoryScannerModal } from '@/components/inventory/InventoryScannerLazy'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { formatQuantity, unitLabel } from '@/lib/quantity'
import { anularPasadaAccion, buscarProductosAccion, misPasadasAccion, registrarPasadaAccion, resolverProductoAccion } from '../conteo-actions'
import type { MiPasada, ProductoParaContar } from '../conteo-captura'
import { evaluarPasada, type PresentacionElegible } from '../conteo-ui'

/**
 * La pantalla de CONTAR (F6.5c), pensada para el móvil y para el que cuenta de pie en el pasillo: leer o escribir un código, decir cuánto hay (en unidades o en cajas) y,
 * si hace falta, en qué zona; registrar y seguir. Es CIEGA: ni una cifra de lo que dice el sistema llega a este componente (el servidor no la manda). Cada pasada lleva su
 * clave de idempotencia, que se conserva si falla la red: reintentar no cuenta dos veces.
 */

export function ContarConteo({ countId, numero, almacen, enRevision }: { countId: string; numero: string; almacen: string; enRevision: boolean }) {
  const enLinea = useEnLinea()
  const [codigo, setCodigo] = useState('')
  const [escaneando, setEscaneando] = useState(false)
  const [producto, setProducto] = useState<ProductoParaContar | null>(null)
  const [candidatos, setCandidatos] = useState<ProductoParaContar[]>([])
  const [presentacionId, setPresentacionId] = useState<string>('')
  const [cantidad, setCantidad] = useState('')
  const [zona, setZona] = useState('')
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null)
  const [mias, setMias] = useState<MiPasada[]>([])
  const [anulando, setAnulando] = useState<string | null>(null)
  const [motivo, setMotivo] = useState('')
  const [pendiente, startTransition] = useTransition()
  const clave = useRef<string | null>(null)
  const entradaCodigo = useRef<HTMLInputElement>(null)

  const cargarMias = useCallback(() => { void misPasadasAccion({ countId }).then((r) => { if (r.ok) setMias(r.data) }) }, [countId])
  useEffect(() => { cargarMias() }, [cargarMias])

  const elegir = (p: ProductoParaContar) => {
    setProducto(p); setCandidatos([]); setCantidad(''); setAviso(null); clave.current = null
    setPresentacionId(p.presentacionLeida?.id ?? '')
  }
  const buscar = (texto: string, esCodigo: boolean) => {
    const t = texto.trim()
    if (!t) return
    setAviso(null)
    startTransition(async () => {
      if (esCodigo) {
        const r = await resolverProductoAccion({ countId, code: t })
        if (!r.ok) { setAviso({ tipo: 'error', texto: r.message }); return }
        if (r.data) { elegir(r.data); setCodigo(''); return }
      }
      const b = await buscarProductosAccion({ countId, q: t })
      if (!b.ok) { setAviso({ tipo: 'error', texto: b.message }); return }
      if (b.data.length === 0) { setAviso({ tipo: 'error', texto: `No encontramos «${t}» entre los productos con control de stock.` }); return }
      if (b.data.length === 1) { elegir(b.data[0]!); setCodigo(''); return }
      setCandidatos(b.data)
    })
  }

  const presentacion: PresentacionElegible | null = producto && presentacionId ? (() => { const p = producto.presentaciones.find((x) => x.id === presentacionId) ?? producto.presentacionLeida; return p && p.id === presentacionId ? { id: p.id, nombre: p.nombre, unidad: p.unidad, factor: p.factor } : null })() : null
  const ev = producto ? evaluarPasada({ cantidad, unidad: producto.unidad, presentacion, zona }) : null

  const registrar = () => {
    if (!producto || !ev || !ev.ok || ev.cantidadBase === null) return
    const base = ev.cantidadBase
    clave.current ??= crypto.randomUUID()
    setAviso(null)
    startTransition(async () => {
      const r = await registrarPasadaAccion({
        countId, productId: producto.productId, variantId: producto.variantId, quantity: base,
        ...(ev.presentationId ? { presentationId: ev.presentationId, enteredQuantity: ev.enteredQuantity } : {}), ...(ev.zona ? { zone: ev.zona } : {}), idempotencyKey: clave.current,
      })
      if (!r.ok) { setAviso({ tipo: 'error', texto: r.message }); return }     // la clave se CONSERVA: reintentar no cuenta dos veces
      setAviso({ tipo: 'ok', texto: `Registrado: ${formatQuantity(base, producto.unidad)} ${unitLabel(producto.unidad)} de «${producto.nombre}».` })
      clave.current = null
      setProducto(null); setCantidad(''); setPresentacionId('')
      cargarMias()
      entradaCodigo.current?.focus()
    })
  }

  const anular = (entryId: string) => {
    if (motivo.trim().length < 3) { setAviso({ tipo: 'error', texto: 'Escribe por qué anulas la pasada (mínimo 3 letras).' }); return }
    startTransition(async () => {
      const r = await anularPasadaAccion({ entryId, reason: motivo.trim() })
      if (!r.ok) { setAviso({ tipo: 'error', texto: r.message }); return }
      setAnulando(null); setMotivo(''); setAviso({ tipo: 'ok', texto: 'Pasada anulada.' }); cargarMias()
    })
  }

  return (
    <div data-contar="pantalla" className="flex flex-col gap-4">
      <header className="rounded-2xl border border-hairline bg-surface p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{enRevision ? 'Recuento' : 'Contando'} · {numero}</p>
        <h2 className="text-lg font-bold text-ink">{almacen}</h2>
        <p data-contar="ciego" className="mt-1 text-sm text-ink-muted">Cuenta lo que ves en el estante. No se muestra lo que dice el sistema: así el conteo vale.</p>
        {enRevision && <p data-contar="recuento" className="mt-1 text-sm font-semibold text-stock-low">Solo se cuentan los productos que el revisor mandó a recontar.</p>}
      </header>

      <section className="flex flex-col gap-2 rounded-2xl border border-hairline bg-surface p-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-muted">Código, SKU o nombre del producto</span>
          <div className="flex gap-2">
            <input ref={entradaCodigo} value={codigo} onChange={(e) => setCodigo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); buscar(codigo, true) } }} inputMode="search" autoFocus
              placeholder="Escanea o escribe" className="h-touch-lg min-w-0 flex-1 rounded-xl border border-hairline bg-surface px-3 text-lg text-ink" />
            <button type="button" data-contar="buscar" onClick={() => buscar(codigo, true)} disabled={pendiente || !codigo.trim()} className="h-touch-lg shrink-0 rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-40">Buscar</button>
          </div>
        </label>
        <button type="button" data-contar="escanear" onClick={() => setEscaneando(true)} className="h-touch rounded-xl border border-hairline text-sm font-semibold text-ink">Escanear con la cámara</button>
        {candidatos.length > 0 && (
          <ul data-contar="candidatos" className="flex flex-col gap-1">{candidatos.map((c) => (
            <li key={c.productId}><button type="button" onClick={() => elegir(c)} className="flex w-full items-center justify-between rounded-lg border border-hairline px-3 py-2 text-left text-sm"><span className="truncate">{c.nombre}</span><span className="ml-2 shrink-0 font-mono text-xs text-ink-muted">{c.sku}</span></button></li>))}
          </ul>
        )}
      </section>

      {producto && ev && (
        <section data-contar="producto" className="flex flex-col gap-3 rounded-2xl border-2 border-industrial-600 bg-surface p-4">
          <div>
            <h3 className="text-lg font-bold text-ink">{producto.nombre}</h3>
            <p className="font-mono text-xs text-ink-muted">{producto.sku} · se cuenta en {unitLabel(producto.unidad)}</p>
          </div>
          {producto.presentaciones.length > 0 && (
            <div role="group" aria-label="Contar en" className="flex flex-wrap gap-2">
              <button type="button" aria-pressed={presentacionId === ''} onClick={() => setPresentacionId('')} className={`h-touch rounded-xl border px-3 text-sm font-semibold ${presentacionId === '' ? 'border-industrial-600 bg-industrial-600 text-white' : 'border-hairline text-ink'}`}>{unitLabel(producto.unidad)}</button>
              {producto.presentaciones.map((p) => (
                <button key={p.id} type="button" aria-pressed={presentacionId === p.id} onClick={() => setPresentacionId(p.id)} className={`h-touch rounded-xl border px-3 text-sm font-semibold ${presentacionId === p.id ? 'border-industrial-600 bg-industrial-600 text-white' : 'border-hairline text-ink'}`}>{p.nombre} (×{p.factor})</button>
              ))}
            </div>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">Cantidad contada{presentacion ? ` (en ${presentacion.nombre.toLowerCase()})` : ''}</span>
            <input value={cantidad} onChange={(e) => setCantidad(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); registrar() } }} inputMode="decimal" placeholder="0" aria-label="Cantidad contada"
              className="h-touch-xl rounded-xl border border-hairline bg-surface px-4 text-3xl font-bold text-ink" />
          </label>
          {presentacion && ev.ok && ev.cantidadBase !== null && cantidad.trim() !== '' && <p data-contar="conversion" className="text-sm font-semibold text-ink">= {formatQuantity(ev.cantidadBase, producto.unidad)} {unitLabel(producto.unidad)}</p>}
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">Zona (opcional)</span>
            <input value={zona} onChange={(e) => setZona(e.target.value)} maxLength={40} placeholder="Ej.: Pasillo 3, estante B" className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base text-ink" />
          </label>
          {cantidad.trim() !== '' && !ev.ok && <ul data-contar="ayuda" className="list-disc pl-5 text-sm text-stock-out">{ev.errores.map((m) => <li key={m}>{m}</li>)}</ul>}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => { setProducto(null); setCantidad(''); clave.current = null }} className="h-touch-lg rounded-xl border border-hairline text-base font-semibold text-ink">Otro producto</button>
            <button type="button" data-contar="registrar" onClick={registrar} disabled={pendiente || !enLinea || !ev.ok || cantidad.trim() === ''} className="h-touch-lg rounded-xl bg-industrial-600 text-base font-bold text-white disabled:opacity-40">{pendiente ? 'Guardando…' : 'Registrar'}</button>
          </div>
        </section>
      )}

      {!enLinea && <p role="status" data-contar="sin-red" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">{MENSAJE_SIN_RED}</p>}
      {aviso && <p role={aviso.tipo === 'error' ? 'alert' : 'status'} data-contar="aviso" data-tipo={aviso.tipo} className={`rounded-xl px-3 py-2 text-sm font-semibold ${aviso.tipo === 'ok' ? 'bg-stock-ok-soft text-stock-ok' : 'bg-stock-out-soft text-stock-out'}`}>{aviso.texto}</p>}

      <section data-contar="mias" className="rounded-2xl border border-hairline bg-surface p-4">
        <h3 className="font-bold text-ink">Mis últimas pasadas</h3>
        {mias.length === 0 ? <p className="mt-1 text-sm text-ink-muted">Todavía no has contado nada en esta toma.</p> : (
          <ul className="mt-2 flex flex-col gap-2">{mias.map((m) => (
            <li key={m.id} data-pasada={m.id} data-anulada={m.anulada ? 'si' : 'no'} className="rounded-xl border border-hairline p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div className={m.anulada ? 'line-through opacity-60' : ''}>
                  <p className="font-semibold text-ink">{formatQuantity(m.cantidad, 'UNIDAD')} · {m.producto}</p>
                  <p className="text-xs text-ink-muted">{m.presentacion ? `${m.presentacion.cantidad} × ${m.presentacion.nombre} · ` : ''}{m.zona ? `Zona ${m.zona}` : 'Sin zona'}</p>
                </div>
                {m.puedeAnular && anulando !== m.id && <button type="button" data-contar="anular" onClick={() => { setAnulando(m.id); setMotivo('') }} className="shrink-0 text-xs font-semibold underline">Anular</button>}
              </div>
              {anulando === m.id && (
                <div className="mt-2 flex flex-col gap-2">
                  <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo" aria-label="Motivo de la anulación" className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base text-ink" />
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => setAnulando(null)} className="h-touch rounded-xl border border-hairline text-sm font-semibold">Volver</button>
                    <button type="button" data-contar="confirmar-anulacion" onClick={() => anular(m.id)} disabled={pendiente} className="h-touch rounded-xl bg-stock-out text-sm font-bold text-white">Anular pasada</button>
                  </div>
                </div>
              )}
            </li>))}
          </ul>
        )}
      </section>

      <InventoryScannerModal open={escaneando} onClose={() => setEscaneando(false)} onDetected={(c: string) => { setEscaneando(false); setCodigo(c); buscar(c, true); return { tipo: 'ok' as const, mensaje: c } }} continuous={false} title="Escanear para contar" />
    </div>
  )
}
