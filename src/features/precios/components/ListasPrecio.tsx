'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { crearListaAccion, darDeBajaListaAccion, editarListaAccion } from '../actions'
import type { ListaDePrecio } from '../service'

/**
 * Las listas de precio del negocio (F6.7c): la Base siempre primera, las demás con su cantidad de productos y de clientes; crear, renombrar y dar de baja. Solo con `precios.gestionar`
 * (la página es 404 sin él y el servicio lo vuelve a exigir).
 */
export function ListasPrecio({ listas }: { listas: ListaDePrecio[] }) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [nombre, setNombre] = useState('')
  const [codigo, setCodigo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editando, setEditando] = useState<{ id: string; nombre: string } | null>(null)
  const [confirmar, setConfirmar] = useState<string | null>(null)

  const correr = (f: () => Promise<{ ok: boolean; message?: string }>, alTerminar?: () => void) => {
    setError(null)
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    startTransition(async () => {
      const r = await f()
      if (!r.ok) { setError(r.message ?? 'No se pudo completar.'); return }
      alTerminar?.()
      router.refresh()
    })
  }

  return (
    <section data-precios="listas" className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        <li data-lista="base" className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface p-3">
          <div>
            <p className="font-semibold text-ink">Base (minorista)</p>
            <p className="text-xs text-ink-muted">El precio de venta de cada producto. Aquí solo se editan sus tramos de volumen.</p>
          </div>
          <Link href="/precios/base" className="text-sm font-semibold text-industrial-700 underline dark:text-industrial-300">Tramos de volumen</Link>
        </li>
        {listas.map((l) => (
          <li key={l.id} data-lista={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface p-3">
            <div className="min-w-0">
              {editando?.id === l.id ? (
                <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); correr(() => editarListaAccion({ priceListId: l.id, name: editando.nombre }), () => setEditando(null)) }}>
                  <input value={editando.nombre} onChange={(e) => setEditando({ id: l.id, nombre: e.target.value })} aria-label={`Nuevo nombre de ${l.name}`} className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base text-ink" />
                  <button type="submit" disabled={pendiente} className="h-touch rounded-xl bg-industrial-600 px-3 text-sm font-bold text-white disabled:opacity-50">Guardar</button>
                  <button type="button" onClick={() => setEditando(null)} className="text-sm font-semibold text-ink-muted">Cancelar</button>
                </form>
              ) : (
                <>
                  <p className="font-semibold text-ink">{l.name}{l.code && <span className="ml-2 font-mono text-xs font-normal text-ink-muted">{l.code}</span>}{!l.isActive && <span className="ml-2 text-xs font-normal text-stock-low">inactiva</span>}</p>
                  <p className="text-xs text-ink-muted">{l.entradas} {l.entradas === 1 ? 'producto' : 'productos'} · {l.clientes} {l.clientes === 1 ? 'cliente' : 'clientes'}</p>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm font-semibold">
              <Link href={`/precios/${l.id}`} className="text-industrial-700 underline dark:text-industrial-300">Precios</Link>
              <button type="button" onClick={() => setEditando({ id: l.id, nombre: l.name })} className="text-ink">Renombrar</button>
              {confirmar === l.id ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs font-normal text-ink-muted">{l.clientes > 0 ? `${l.clientes} cliente(s) volverán a Base. ` : ''}¿Dar de baja?</span>
                  <button type="button" disabled={pendiente} onClick={() => correr(() => darDeBajaListaAccion({ priceListId: l.id }), () => setConfirmar(null))} className="text-stock-out">Sí, dar de baja</button>
                  <button type="button" onClick={() => setConfirmar(null)} className="text-ink-muted">No</button>
                </span>
              ) : <button type="button" onClick={() => setConfirmar(l.id)} className="text-stock-out">Dar de baja</button>}
            </div>
          </li>
        ))}
        {listas.length === 0 && <li data-precios="sin-listas" className="rounded-2xl border border-dashed border-hairline p-4 text-sm text-ink-muted">Todavía no hay listas de precio. Crea la primera (por ejemplo «Mayorista») abajo.</li>}
      </ul>

      <form data-precios="nueva" className="flex flex-wrap items-end gap-3 rounded-2xl border border-hairline bg-surface p-4"
        onSubmit={(e) => { e.preventDefault(); correr(() => crearListaAccion({ name: nombre, ...(codigo.trim() ? { code: codigo } : {}) }), () => { setNombre(''); setCodigo('') }) }}>
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Nueva lista
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Mayorista, Constructor…" maxLength={40} className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base font-normal text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Código (opcional)
          <input value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder="MAY" maxLength={30} className="h-touch w-32 rounded-xl border border-hairline bg-surface px-3 text-base font-normal text-ink" />
        </label>
        <button type="submit" disabled={pendiente || nombre.trim().length < 2} className="h-touch rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-50">{pendiente ? 'Creando…' : 'Crear lista'}</button>
      </form>
      {error && <p role="alert" className="text-sm font-semibold text-stock-out">{error}</p>}
    </section>
  )
}
