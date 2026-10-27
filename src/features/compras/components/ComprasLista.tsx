'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { fechaDiaCorta, formatearFechaLocal } from '@/lib/fecha-local'
import { listarCompras } from '../actions'
import type { FilaCompra, PaginaCompras } from '../service'
import { ETIQUETA_CONDICION, ETIQUETA_ESTADO, ETIQUETA_FILTRO_COMPRA, FILTROS_COMPRA, enlaceFiltroCompras, type FiltroCompra } from '../borrador-ui'

const money = (n: number) => `S/ ${n.toFixed(2)}`

export const ESTILO_ESTADO: Record<FilaCompra['status'], string> = {
  BORRADOR: 'bg-surface-sunken text-ink-muted',
  RECIBIDA: 'bg-stock-ok-soft text-stock-ok',
  ANULADA: 'bg-stock-out-soft text-stock-out',
}

/**
 * Lista de compras: búsqueda (número, documento del proveedor o nombre del proveedor) y filtro por estado en la dirección, 50 por
 * página con «Cargar más». Solo presenta: los datos y los permisos vienen resueltos del servidor.
 */
export function ComprasLista({ inicial, filtro, q, proveedor, puedeRegistrar, puedeOperar, zona }: {
  inicial: PaginaCompras
  filtro: FiltroCompra
  q?: string
  /** Filtrada por un proveedor (desde su ficha): su nombre, para decirlo. */
  proveedor?: { id: string; name: string }
  puedeRegistrar: boolean
  puedeOperar: boolean
  /** Zona del negocio: la fecha de la compra es la del negocio, no la de UTC. */
  zona: string
}) {
  const [filas, setFilas] = useState<FilaCompra[]>(inicial.filas)
  const [siguiente, setSiguiente] = useState<string | null>(inicial.siguiente)
  const [error, setError] = useState<string | null>(null)
  const [pendiente, startTransition] = useTransition()

  const cargarMas = () => {
    if (!siguiente) return
    setError(null)
    startTransition(async () => {
      const r = await listarCompras({ q, estado: filtro === 'TODAS' ? undefined : filtro, supplierId: proveedor?.id, cursor: siguiente })
      if (!r.ok) { setError(r.message); return }
      setFilas((prev) => [...prev, ...r.data.filas.filter((n) => !prev.some((p) => p.id === n.id))])
      setSiguiente(r.data.siguiente)
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <form action="/compras" method="get" role="search" className="flex min-w-0 flex-1 gap-2">
          {filtro !== 'TODAS' && <input type="hidden" name="estado" value={filtro} />}
          {proveedor && <input type="hidden" name="proveedor" value={proveedor.id} />}
          <input type="search" name="q" defaultValue={q ?? ''} placeholder="Buscar por número, documento o proveedor" aria-label="Buscar compras" maxLength={60}
            className="h-touch min-w-0 flex-1 rounded-xl border border-hairline bg-surface px-3 text-base text-ink" />
          <button type="submit" className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Buscar</button>
        </form>
        {puedeRegistrar && (
          <Link href={proveedor ? `/compras/nueva?proveedor=${proveedor.id}` : '/compras/nueva'} data-enlace="nueva-compra" aria-disabled={!puedeOperar}
            className={`inline-flex h-touch items-center rounded-xl bg-industrial-600 px-4 font-bold text-white ${puedeOperar ? '' : 'pointer-events-none opacity-40'}`}>Nueva compra</Link>
        )}
      </div>

      {proveedor && (
        <p data-aviso="filtro-proveedor" className="flex flex-wrap items-center gap-2 text-sm text-ink">
          Compras a <b>{proveedor.name}</b>
          <Link href={enlaceFiltroCompras(filtro, q)} className="font-semibold text-industrial-600 underline">ver todas</Link>
        </p>
      )}

      <nav aria-label="Filtros" className="flex flex-wrap gap-2">
        {FILTROS_COMPRA.map((f) => {
          const base = enlaceFiltroCompras(f, q)
          const href = proveedor ? `${base}${base.includes('?') ? '&' : '?'}proveedor=${proveedor.id}` : base
          return (
            <Link key={f} href={href} aria-current={f === filtro ? 'page' : undefined}
              className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${f === filtro ? 'border-industrial-600 bg-industrial-600 text-white' : 'border-hairline text-ink'}`}>
              {ETIQUETA_FILTRO_COMPRA[f]}
            </Link>
          )
        })}
      </nav>

      {filas.length === 0 ? (
        <p data-lista="vacia" className="rounded-2xl border border-hairline bg-surface p-6 text-center text-sm text-ink-muted">
          {q || filtro !== 'TODAS' || proveedor ? 'Ninguna compra coincide con esa búsqueda o filtro.' : 'Todavía no hay compras. Registra la primera con «Nueva compra».'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Compras">
          {filas.map((c) => (
            <li key={c.id}>
              <Link href={`/compras/${c.id}`} data-compra={c.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-2xl border border-hairline bg-surface px-4 py-3 hover:bg-surface-sunken">
                <div className="min-w-0">
                  <p className="truncate font-bold text-ink">{c.number}{c.invoiceRef ? ` · ${c.invoiceRef}` : ''}</p>
                  <p className="text-xs text-ink-muted">{c.supplierName ?? 'Sin proveedor'} · {formatearFechaLocal(c.createdAt, zona, undefined, { conHora: false })}</p>
                  <p className="mt-1 flex flex-wrap gap-1.5">
                    <span data-insignia={`estado-${c.status}`} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ESTILO_ESTADO[c.status]}`}>{ETIQUETA_ESTADO[c.status]}</span>
                    <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-semibold text-ink-muted">{ETIQUETA_CONDICION[c.paymentCondition]}{c.dueDate ? ` · vence ${fechaDiaCorta(c.dueDate)}` : ''}</span>
                  </p>
                </div>
                <p className={`font-bold tabular-nums ${c.status === 'ANULADA' ? 'text-ink-muted line-through' : 'text-ink'}`}>{money(c.total)}</p>
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
