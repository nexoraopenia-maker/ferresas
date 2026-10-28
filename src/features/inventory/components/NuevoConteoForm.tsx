'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { buscarProductosSeleccionAccion, crearConteoAccion } from '../conteo-actions'
import { AYUDA_MODO, ETIQUETA_ALCANCE, ETIQUETA_MODO, enlaceConteo } from '../conteo-ui'
import { MAX_PRODUCTOS_SELECCION } from '../conteo-schemas'

/** Crear una toma de inventario (F6.5c): almacén, alcance (todo, una categoría o una selección de productos), modo y nota. Solo `conteo.gestionar`; el servidor lo comprueba igual. */

type Alcance = 'TOTAL' | 'CATEGORIA' | 'SELECCION'
interface Elegido { id: string; nombre: string; sku: string }

export function NuevoConteoForm({ almacenes, categorias }: { almacenes: { id: string; nombre: string }[]; categorias: { id: string; nombre: string }[] }) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [almacen, setAlmacen] = useState(almacenes[0]?.id ?? '')
  const [alcance, setAlcance] = useState<Alcance>('TOTAL')
  const [categoria, setCategoria] = useState(categorias[0]?.id ?? '')
  const [modo, setModo] = useState<'CIEGO' | 'GUIADO'>('CIEGO')
  const [notas, setNotas] = useState('')
  const [q, setQ] = useState('')
  const [hallados, setHallados] = useState<Elegido[]>([])
  const [elegidos, setElegidos] = useState<Elegido[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pendiente, startTransition] = useTransition()
  // Una clave por intento de creación: si la red falla y se reintenta, no se crean dos conteos.
  const clave = useRef(crypto.randomUUID())

  const buscar = () => {
    setError(null)
    startTransition(async () => {
      const r = await buscarProductosSeleccionAccion({ q })
      if (!r.ok) { setError(r.message); return }
      setHallados(r.data)
    })
  }
  const agregar = (p: Elegido) => setElegidos((l) => (l.some((x) => x.id === p.id) || l.length >= MAX_PRODUCTOS_SELECCION ? l : [...l, p]))

  const crear = () => {
    setError(null)
    if (!almacen) { setError('Elige el almacén que vas a contar.'); return }
    if (alcance === 'SELECCION' && elegidos.length === 0) { setError('Elige al menos un producto.'); return }
    startTransition(async () => {
      const r = await crearConteoAccion({
        warehouseId: almacen, scope: alcance, mode: modo, idempotencyKey: clave.current,
        ...(alcance === 'CATEGORIA' ? { categoryId: categoria } : {}), ...(alcance === 'SELECCION' ? { productIds: elegidos.map((e) => e.id) } : {}),
        ...(notas.trim() ? { notes: notas.trim() } : {}),
      })
      if (!r.ok) { setError(r.message); return }
      clave.current = crypto.randomUUID()
      router.push(enlaceConteo(r.data.id))
    })
  }

  return (
    <section data-conteos="nuevo" className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4">
      <h2 className="font-bold text-ink">Nueva toma de inventario</h2>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-muted">Almacén</span>
        <select value={almacen} onChange={(e) => setAlmacen(e.target.value)} className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base text-ink">
          {almacenes.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </label>
      <div role="group" aria-label="Alcance" className="grid gap-2 sm:grid-cols-3">
        {(['TOTAL', 'CATEGORIA', 'SELECCION'] as const).map((a) => (
          <button key={a} type="button" aria-pressed={alcance === a} onClick={() => setAlcance(a)}
            className={`h-touch rounded-xl border text-sm font-semibold ${alcance === a ? 'border-industrial-600 bg-industrial-600 text-white' : 'border-hairline text-ink'}`}>{ETIQUETA_ALCANCE[a]}</button>
        ))}
      </div>
      {alcance === 'CATEGORIA' && (
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-muted">Categoría</span>
          <select value={categoria} onChange={(e) => setCategoria(e.target.value)} className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base text-ink">
            {categorias.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </label>
      )}
      {alcance === 'SELECCION' && (
        <div data-conteos="seleccion" className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); buscar() } }} placeholder="Nombre, SKU o código de barras" aria-label="Buscar producto"
              className="h-touch min-w-0 flex-1 rounded-xl border border-hairline bg-surface px-3 text-base text-ink" />
            <button type="button" onClick={buscar} disabled={pendiente} className="h-touch shrink-0 rounded-xl border border-hairline px-4 text-sm font-semibold text-ink">Buscar</button>
          </div>
          {hallados.length > 0 && (
            <ul className="flex flex-col gap-1">{hallados.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-2 rounded-lg border border-hairline px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{h.nombre} <span className="font-mono text-xs text-ink-muted">{h.sku}</span></span>
                <button type="button" onClick={() => agregar(h)} className="shrink-0 text-sm font-semibold text-industrial-700 underline">Agregar</button>
              </li>))}
            </ul>
          )}
          {elegidos.length > 0 && (
            <ul data-conteos="elegidos" className="flex flex-wrap gap-2">{elegidos.map((e) => (
              <li key={e.id} className="inline-flex items-center gap-1 rounded-full bg-industrial-50 px-3 py-1 text-xs font-semibold text-industrial-700">
                {e.nombre}<button type="button" aria-label={`Quitar ${e.nombre}`} onClick={() => setElegidos((l) => l.filter((x) => x.id !== e.id))}>×</button>
              </li>))}
            </ul>
          )}
        </div>
      )}
      <div role="group" aria-label="Modo" className="grid grid-cols-2 gap-2">
        {(['CIEGO', 'GUIADO'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={modo === m} onClick={() => setModo(m)}
            className={`h-touch rounded-xl border text-sm font-semibold ${modo === m ? 'border-industrial-600 bg-industrial-600 text-white' : 'border-hairline text-ink'}`}>Conteo {ETIQUETA_MODO[m].toLowerCase()}</button>
        ))}
      </div>
      <p className="text-xs text-ink-muted">{AYUDA_MODO[modo]}</p>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-muted">Nota (opcional)</span>
        <input value={notas} onChange={(e) => setNotas(e.target.value)} maxLength={280} placeholder="Ej.: inventario de fin de mes" className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base text-ink" />
      </label>
      {error && <p role="alert" data-conteos="error" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
      {!enLinea && <p role="status" className="text-sm text-stock-low">{MENSAJE_SIN_RED}</p>}
      <button type="button" data-conteos="crear" onClick={crear} disabled={pendiente || !enLinea || !almacen} className="h-touch-lg rounded-xl bg-industrial-600 text-base font-bold text-white disabled:opacity-40">
        {pendiente ? 'Creando…' : 'Crear toma de inventario'}
      </button>
    </section>
  )
}
