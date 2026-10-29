'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { unitLabel } from '@/lib/quantity'
import { validarTramos, type Tramo } from '@/features/pos/precios-reglas'
import { guardarPreciosAccion } from '../actions'
import type { CambioPrecioInput } from '../schemas'
import type { FilaPrecio } from '../service'

const soles = (n: number) => `S/ ${n.toFixed(2)}`
const clave = (f: FilaPrecio) => f.productId

type FilaTramo = { min: string; precio: string }
type Borrador = { price: string; tiers: FilaTramo[]; eliminar: boolean }

const numero = (t: string): number | 'error' | null => {
  const s = t.trim().replace(',', '.')
  if (s === '') return null
  if (!/^\d+(\.\d+)?$/.test(s)) return 'error'
  const n = Number(s)
  return Number.isFinite(n) ? n : 'error'
}

const precioInicial = (f: FilaPrecio, lista: boolean): number | null => (lista ? f.entrada?.price ?? null : null)
const tramosIniciales = (f: FilaPrecio, lista: boolean): Tramo[] => (lista ? f.entrada?.tiers ?? [] : f.baseTiers)
const aTexto = (n: number | null) => (n === null ? '' : String(n))
const inicial = (f: FilaPrecio, lista: boolean): Borrador => ({
  price: aTexto(precioInicial(f, lista)), eliminar: false,
  tiers: [...tramosIniciales(f, lista)].sort((a, b) => a.minQuantity - b.minQuantity).map((t) => ({ min: String(t.minQuantity), precio: String(t.unitPrice) })),
})
const mismosTramos = (a: readonly Tramo[], b: readonly Tramo[]) => {
  const k = (t: Tramo) => `${Math.round(t.minQuantity * 1e4)}|${Math.round(t.unitPrice * 1e4)}`
  return a.length === b.length && [...a].map(k).sort().join(',') === [...b].map(k).sort().join(',')
}

/**
 * Lo que cambió una fila: el cambio a enviar, o el problema que lo impide. Usa las MISMAS reglas que el servidor (`validarTramos`): un tramo mal formado se marca antes de guardar, pero
 * el servidor lo vuelve a validar contra lo que hay en la base.
 */
export function cambioDeFila(f: FilaPrecio, b: Borrador, lista: boolean): { cambio: CambioPrecioInput | null; error: string | null } {
  if (b.eliminar) return { cambio: lista && f.entrada ? { productId: f.productId, eliminar: true } : null, error: null }
  const tramos: Tramo[] = []
  for (const t of b.tiers) {
    const min = numero(t.min), precio = numero(t.precio)
    if (min === null && precio === null) continue
    if (min === 'error' || precio === 'error' || min === null || precio === null) return { cambio: null, error: 'Cada tramo necesita una cantidad y un precio, con números.' }
    tramos.push({ minQuantity: min, unitPrice: precio })
  }
  const p = lista ? numero(b.price) : null
  if (p === 'error') return { cambio: null, error: 'El precio debe ser un número.' }
  const plano = lista ? p ?? f.salePrice : f.salePrice
  const problema = validarTramos(tramos, plano)
  if (problema) return { cambio: null, error: problema }
  if (lista && p === null && tramos.length === 0 && f.entrada) return { cambio: null, error: 'Pon un precio o al menos un tramo, o quita el producto de la lista.' }

  const cambioPrecio = lista && p !== precioInicial(f, lista) ? { price: p } : {}
  const cambioTramos = !mismosTramos(tramos, tramosIniciales(f, lista)) ? { tiers: tramos } : {}
  if (Object.keys(cambioPrecio).length === 0 && Object.keys(cambioTramos).length === 0) return { cambio: null, error: null }
  return { cambio: { productId: f.productId, ...cambioPrecio, ...cambioTramos }, error: null }
}

/**
 * Cuadrícula de precios y tramos de UNA lista (o de los tramos de la Base) (F6.7c). `priceListId` nulo = la Base: su precio plano es el del producto, aquí solo se editan tramos.
 * Guarda en bloque solo las filas que cambiaron. El costo existe solo si el servidor lo mandó (`productos.ver_costo`). Requiere `precios.gestionar`; el servidor lo vuelve a comprobar.
 */
export function PreciosGrid({ priceListId, filas }: { priceListId: string | null; filas: FilaPrecio[] }) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const lista = priceListId !== null
  const [borr, setBorr] = useState<Record<string, Borrador>>({})
  const [error, setError] = useState<string | null>(null)
  const [hecho, setHecho] = useState<string | null>(null)
  const [pendiente, startTransition] = useTransition()

  const valor = (f: FilaPrecio): Borrador => borr[clave(f)] ?? inicial(f, lista)
  const editar = (f: FilaPrecio, parte: Partial<Borrador>) => { setHecho(null); setBorr((b) => ({ ...b, [clave(f)]: { ...valor(f), ...parte } })) }

  const evaluadas = useMemo(() => filas.flatMap((f) => (borr[clave(f)] ? [{ fila: f, ...cambioDeFila(f, borr[clave(f)]!, lista) }] : [])), [borr, filas, lista])
  const conError = evaluadas.filter((e) => e.error)
  const cambios = evaluadas.flatMap((e) => (e.cambio ? [e.cambio] : []))

  const guardar = () => {
    setError(null); setHecho(null)
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    if (conError.length > 0) { setError('Corrige las filas marcadas antes de guardar.'); return }
    startTransition(async () => {
      const r = await guardarPreciosAccion({ priceListId, cambios })
      if (!r.ok) { setError(r.message); return }
      setBorr({})
      setHecho(`${r.data.aplicados} ${r.data.aplicados === 1 ? 'producto guardado' : 'productos guardados'}.${r.data.bajoCosto > 0 ? ` ${r.data.bajoCosto} ${r.data.bajoCosto === 1 ? 'precio queda' : 'precios quedan'} por debajo del costo: no se podrán vender sin autorización de un administrador.` : ''}`)
      router.refresh()
    })
  }

  if (filas.length === 0) return <p data-precios="vacio" className="rounded-2xl border border-hairline bg-surface p-4 text-sm text-ink-muted">No hay productos que coincidan.</p>

  return (
    <section data-precios="grid" className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {filas.map((f) => {
          const b = valor(f)
          const malo = conError.find((e) => clave(e.fila) === clave(f))
          return (
            <li key={clave(f)} data-fila={clave(f)} className={`rounded-2xl border p-3 ${b.eliminar ? 'border-hairline bg-surface-sunken' : 'border-hairline bg-surface'}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{f.nombre}</p>
                  <p className="font-mono text-xs text-ink-muted">{f.sku} · {unitLabel(f.unitType)} · Base {soles(f.salePrice)}{f.costoUnitario !== undefined && <span data-precio="costo"> · costo {f.costoUnitario === null ? 'sin dato' : `${soles(f.costoUnitario)} sin IGV`}</span>}</p>
                </div>
                {lista && f.entrada && (
                  b.eliminar
                    ? <button type="button" onClick={() => editar(f, { eliminar: false })} className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">Deshacer</button>
                    : <button type="button" data-precio="quitar" onClick={() => editar(f, { eliminar: true })} className="text-sm font-semibold text-stock-out">Quitar de la lista</button>
                )}
              </div>
              {b.eliminar ? (
                <p className="mt-2 text-sm text-ink-muted">Al guardar, este producto volverá a venderse al precio Base en esta lista.</p>
              ) : (
                <div className="mt-2 flex flex-col gap-2">
                  {lista && (
                    <label className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">Precio en la lista
                      <input data-campo="precio" inputMode="decimal" value={b.price} placeholder={f.salePrice.toFixed(2)} aria-label={`Precio de ${f.nombre} en la lista`}
                        onChange={(e) => editar(f, { price: e.target.value })} className="h-touch w-28 rounded-xl border border-hairline bg-surface px-2 text-base font-normal text-ink" />
                      <span className="text-xs font-normal text-ink-muted">con IGV; vacío = el precio Base</span>
                    </label>
                  )}
                  <div className="flex flex-col gap-1">
                    {b.tiers.map((t, i) => (
                      <div key={i} data-tramo="" className="flex flex-wrap items-center gap-2 text-sm text-ink">
                        Desde
                        <input data-campo="tramo-min" inputMode="decimal" value={t.min} aria-label={`Cantidad mínima del tramo ${i + 1} de ${f.nombre}`}
                          onChange={(e) => editar(f, { tiers: b.tiers.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)) })} className="h-touch w-20 rounded-xl border border-hairline bg-surface px-2 text-base text-ink" />
                        {unitLabel(f.unitType)} → S/
                        <input data-campo="tramo-precio" inputMode="decimal" value={t.precio} aria-label={`Precio del tramo ${i + 1} de ${f.nombre}`}
                          onChange={(e) => editar(f, { tiers: b.tiers.map((x, j) => (j === i ? { ...x, precio: e.target.value } : x)) })} className="h-touch w-24 rounded-xl border border-hairline bg-surface px-2 text-base text-ink" />
                        <button type="button" aria-label={`Quitar el tramo ${i + 1} de ${f.nombre}`} onClick={() => editar(f, { tiers: b.tiers.filter((_, j) => j !== i) })} className="text-sm font-semibold text-stock-out">×</button>
                      </div>
                    ))}
                    <button type="button" data-precio="mas-tramo" onClick={() => editar(f, { tiers: [...b.tiers, { min: '', precio: '' }] })} className="self-start text-sm font-semibold text-industrial-700 dark:text-industrial-300">+ Añadir tramo de volumen</button>
                  </div>
                </div>
              )}
              {malo && <p role="alert" className="mt-1 text-xs font-semibold text-stock-out">{malo.error}</p>}
            </li>
          )
        })}
      </ul>
      <div className="sticky bottom-2 flex flex-wrap items-center gap-3 rounded-2xl border border-hairline bg-surface p-3 shadow-sm">
        <button type="button" data-precios="guardar" disabled={pendiente || cambios.length === 0 || conError.length > 0} onClick={guardar} className="h-touch rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-50">
          {pendiente ? 'Guardando…' : cambios.length === 0 ? 'Guardar' : `Guardar ${cambios.length} ${cambios.length === 1 ? 'cambio' : 'cambios'}`}
        </button>
        {evaluadas.length > 0 && <button type="button" onClick={() => { setBorr({}); setError(null) }} className="text-sm font-semibold text-ink-muted">Descartar</button>}
        {hecho && <p role="status" className="text-sm font-semibold text-stock-ok">{hecho}</p>}
        {error && <p role="alert" className="text-sm font-semibold text-stock-out">{error}</p>}
      </div>
    </section>
  )
}
