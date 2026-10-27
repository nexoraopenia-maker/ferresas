'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { listarProveedores } from '../actions'
import type { FilaProveedor, PaginaProveedores } from '../service'
import { FILTROS_PROVEEDOR, type FiltroProveedor } from '../schemas'
import { FormularioProveedor } from './FormularioProveedor'

const money = (n: number) => `S/ ${n.toFixed(2)}`

export const ETIQUETA_FILTRO_PROVEEDOR: Record<FiltroProveedor, string> = { TODOS: 'Todos', CON_DEUDA: 'Les debo', DE_BAJA: 'De baja' }

/** La dirección de un filtro conservando la búsqueda. «Todos» y sin búsqueda es la dirección limpia. */
export function enlaceFiltroProveedores(filtro: FiltroProveedor, q: string | undefined): string {
  const p = new URLSearchParams()
  if (filtro !== 'TODOS') p.set('filtro', filtro)
  if (q) p.set('q', q)
  const s = p.toString()
  return s ? `/proveedores?${s}` : '/proveedores'
}

/**
 * Lista de proveedores: búsqueda y filtros por la dirección (se pueden compartir y el botón «atrás» funciona), 50 por página con
 * «Cargar más». Solo presenta: los datos y los permisos vienen resueltos del servidor.
 */
export function ProveedoresLista({ inicial, filtro, q, puedeGestionar, puedeOperar }: {
  inicial: PaginaProveedores
  filtro: FiltroProveedor
  q?: string
  puedeGestionar: boolean
  puedeOperar: boolean
}) {
  const [items, setItems] = useState<FilaProveedor[]>(inicial.items)
  const [siguiente, setSiguiente] = useState<string | null>(inicial.siguiente)
  const [creando, setCreando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendiente, startTransition] = useTransition()

  const cargarMas = () => {
    if (!siguiente) return
    setError(null)
    startTransition(async () => {
      const r = await listarProveedores({ q, filtro, cursor: siguiente })
      if (!r.ok) { setError(r.message); return }
      setItems((prev) => [...prev, ...r.data.items.filter((n) => !prev.some((p) => p.id === n.id))])
      setSiguiente(r.data.siguiente)
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <form action="/proveedores" method="get" role="search" className="flex min-w-0 flex-1 gap-2">
          {filtro !== 'TODOS' && <input type="hidden" name="filtro" value={filtro} />}
          <input type="search" name="q" defaultValue={q ?? ''} placeholder="Buscar por nombre, RUC, contacto o teléfono" aria-label="Buscar proveedores" maxLength={80}
            className="h-touch min-w-0 flex-1 rounded-xl border border-hairline bg-surface px-3 text-base text-ink" />
          <button type="submit" className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Buscar</button>
        </form>
        {puedeGestionar && (
          <button type="button" data-boton="nuevo-proveedor" onClick={() => setCreando((v) => !v)} disabled={!puedeOperar}
            className="h-touch rounded-xl bg-industrial-600 px-4 font-bold text-white disabled:opacity-40">
            {creando ? 'Cancelar' : 'Nuevo proveedor'}
          </button>
        )}
      </div>

      <nav aria-label="Filtros" className="flex flex-wrap gap-2">
        {FILTROS_PROVEEDOR.filter((f) => f !== 'DE_BAJA' || puedeGestionar).map((f) => (
          <Link key={f} href={enlaceFiltroProveedores(f, q)} aria-current={f === filtro ? 'page' : undefined}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${f === filtro ? 'border-industrial-600 bg-industrial-600 text-white' : 'border-hairline text-ink'}`}>
            {ETIQUETA_FILTRO_PROVEEDOR[f]}
          </Link>
        ))}
      </nav>

      {creando && puedeGestionar && <FormularioProveedor modo="crear" rucEditable onCancelar={() => setCreando(false)} />}

      {items.length === 0 ? (
        <p data-lista="vacia" className="rounded-2xl border border-hairline bg-surface p-6 text-center text-sm text-ink-muted">
          {q || filtro !== 'TODOS' ? 'Ningún proveedor coincide con esa búsqueda o filtro.' : 'Todavía no hay proveedores. Crea el primero con «Nuevo proveedor».'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Proveedores">
          {items.map((s) => (
            <li key={s.id}>
              <Link href={`/proveedores/${s.id}`} data-proveedor={s.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-2xl border border-hairline bg-surface px-4 py-3 hover:bg-surface-sunken">
                <div className="min-w-0">
                  <p className="truncate font-bold text-ink">{s.name}</p>
                  <p className="text-xs text-ink-muted">
                    {s.taxId ? `RUC ${s.taxId}` : 'Sin RUC'}{s.contact ? ` · ${s.contact}` : ''}{s.phone ? ` · ${s.phone}` : ''}
                  </p>
                  <p className="mt-1 flex flex-wrap gap-1.5">
                    {!s.activo && <span data-insignia="baja" className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-semibold text-ink-muted">De baja</span>}
                    {s.vencido > 0 && <span data-insignia="vencido" className="rounded-full bg-stock-low-soft px-2 py-0.5 text-xs font-semibold text-stock-low">Vencido {money(s.vencido)}</span>}
                  </p>
                </div>
                <dl className="text-right text-sm">
                  <div><dt className="sr-only">Le debes</dt><dd className={`font-bold tabular-nums ${s.deuda > 0 ? 'text-ink' : 'text-ink-muted'}`}>{s.deuda > 0 ? `Le debes ${money(s.deuda)}` : 'Sin deuda'}</dd></div>
                  {s.paymentTermDays > 0 && <div><dt className="sr-only">Plazo</dt><dd className="text-xs text-ink-muted">Plazo {s.paymentTermDays} días</dd></div>}
                </dl>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {error && <p role="alert" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">{error}</p>}
      {siguiente && (
        <button type="button" data-boton="cargar-mas" onClick={cargarMas} disabled={pendiente}
          className="h-touch rounded-xl border border-hairline font-semibold text-ink disabled:opacity-40">
          {pendiente ? 'Cargando…' : 'Cargar más'}
        </button>
      )}
    </div>
  )
}
