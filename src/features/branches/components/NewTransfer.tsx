'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatQuantity, limitarDecimales, parseQuantity, unitLabel } from '@/lib/quantity'
import { createTransfer, searchForTransfer } from '../actions'

interface Candidato {
  productId: string
  name: string
  sku: string
  unitType: string
  disponible: number
}

interface Linea extends Candidato {
  cantidad: string
}

export interface AlmacenOrigen {
  id: string
  name: string
}

export interface DestinoPosible {
  branchId: string
  branchName: string
  warehouses: { id: string; name: string }[]
}

/**
 * Solicitud de mercadería a otra sucursal.
 *
 * Deja pedir MÁS de lo disponible a propósito: quien pide puede no saber el
 * stock exacto del otro local, y el sistema no debería impedirle preguntar.
 * El freno está donde importa —al despachar—, donde `applyStockMovement`
 * rechaza sacar lo que no hay. Aquí solo se avisa.
 */
export function NewTransfer({
  almacenes,
  destinos,
}: {
  almacenes: AlmacenOrigen[]
  destinos: DestinoPosible[]
}) {
  const router = useRouter()
  const [abierto, setAbierto] = useState(false)
  const [origen, setOrigen] = useState(almacenes[0]?.id ?? '')
  const [destinoBranch, setDestinoBranch] = useState(destinos[0]?.branchId ?? '')
  const [destinoWh, setDestinoWh] = useState(destinos[0]?.warehouses[0]?.id ?? '')
  const [busqueda, setBusqueda] = useState('')
  const [candidatos, setCandidatos] = useState<Candidato[]>([])
  const [lineas, setLineas] = useState<Linea[]>([])
  const [notas, setNotas] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const buscar = (v: string) => {
    setBusqueda(v)
    if (v.trim().length < 2) { setCandidatos([]); return }
    startTransition(async () => {
      const res = await searchForTransfer(v, origen)
      setCandidatos(res.ok ? res.data : [])
    })
  }

  const añadir = (c: Candidato) => {
    setCandidatos([])
    setBusqueda('')
    setLineas((prev) =>
      prev.some((l) => l.productId === c.productId)
        ? prev
        : [...prev, { ...c, cantidad: '1' }],
    )
  }

  const destinoActual = destinos.find((d) => d.branchId === destinoBranch)

  const enviar = () => {
    setError(null)
    const items = lineas.map((l) => ({
      productId: l.productId,
      quantity: parseQuantity(l.cantidad) ?? 0,
    }))
    if (items.some((i) => i.quantity <= 0)) {
      setError('Hay líneas sin cantidad. Quítalas o ponles un número mayor que cero.')
      return
    }
    startTransition(async () => {
      const res = await createTransfer({
        fromWarehouseId: origen,
        toBranchId: destinoBranch,
        toWarehouseId: destinoWh,
        items,
        notes: notas.trim() || undefined,
      })
      if (!res.ok) { setError(res.message); return }
      setAbierto(false)
      setLineas([])
      setNotas('')
      router.refresh()
    })
  }

  if (destinos.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-hairline px-4 py-6 text-center text-sm text-ink-muted">
        Solo tienes una sucursal, así que no hay a dónde transferir. Crea otra
        sucursal para mover mercadería entre locales.
      </p>
    )
  }

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={() => { setAbierto(true); setError(null) }}
        className="h-touch-lg rounded-xl bg-industrial-600 px-5 font-bold text-white"
      >
        Pedir mercadería a otra sucursal
      </button>
    )
  }

  return (
    <div className="rounded-2xl border-2 border-industrial-600 bg-surface p-4">
      <h2 className="font-bold text-ink">Nueva transferencia</h2>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-muted">Sale de</span>
          <select
            value={origen}
            onChange={(e) => { setOrigen(e.target.value); setCandidatos([]); setLineas([]) }}
            className="h-touch-lg rounded-xl border border-hairline bg-surface px-3 text-base text-ink"
          >
            {almacenes.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-muted">Va a</span>
          <select
            value={destinoBranch}
            onChange={(e) => {
              setDestinoBranch(e.target.value)
              const d = destinos.find((x) => x.branchId === e.target.value)
              setDestinoWh(d?.warehouses[0]?.id ?? '')
            }}
            className="h-touch-lg rounded-xl border border-hairline bg-surface px-3 text-base text-ink"
          >
            {destinos.map((d) => (
              <option key={d.branchId} value={d.branchId}>{d.branchName}</option>
            ))}
          </select>
        </label>
      </div>

      {destinoActual && destinoActual.warehouses.length > 1 && (
        <label className="mt-3 flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-muted">Almacén de destino</span>
          <select
            value={destinoWh}
            onChange={(e) => setDestinoWh(e.target.value)}
            className="h-touch-lg rounded-xl border border-hairline bg-surface px-3 text-base text-ink"
          >
            {destinoActual.warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </label>
      )}

      <div className="mt-4">
        <input
          value={busqueda}
          onChange={(e) => buscar(e.target.value)}
          placeholder="Busca por nombre, SKU o código de barras…"
          className="h-touch-lg w-full rounded-xl border border-hairline bg-surface px-4 text-base text-ink placeholder:text-ink-muted focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
        />
        {candidatos.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1 rounded-xl border border-hairline bg-surface-raised p-1">
            {candidatos.map((c) => (
              <li key={c.productId}>
                <button
                  type="button"
                  onClick={() => añadir(c)}
                  className="flex w-full items-baseline justify-between gap-2 rounded-lg px-3 py-2 text-left hover:bg-surface-sunken"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-ink">{c.name}</span>
                    <span className="block font-mono text-xs text-ink-muted">{c.sku}</span>
                  </span>
                  <span className={`shrink-0 font-mono text-xs ${c.disponible > 0 ? 'text-ink-muted' : 'text-stock-out'}`}>
                    {formatQuantity(c.disponible, c.unitType)} {unitLabel(c.unitType)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {lineas.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {lineas.map((l, idx) => {
            const pedido = parseQuantity(l.cantidad) ?? 0
            const excede = pedido > l.disponible
            return (
              <li key={l.productId} className="rounded-xl border border-hairline p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{l.name}</p>
                    <p className="font-mono text-xs text-ink-muted">
                      hay {formatQuantity(l.disponible, l.unitType)} {unitLabel(l.unitType)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLineas((p) => p.filter((_, i) => i !== idx))}
                    className="shrink-0 text-xs font-semibold text-stock-out"
                  >
                    Quitar
                  </button>
                </div>
                <input
                  inputMode="decimal"
                  value={l.cantidad}
                  onChange={(e) =>
                    setLineas((p) =>
                      p.map((x, i) =>
                        i === idx ? { ...x, cantidad: limitarDecimales(e.target.value) } : x,
                      ),
                    )
                  }
                  className="mt-2 h-touch-lg w-full rounded-xl border border-hairline bg-surface px-3 text-base font-bold text-ink"
                />
                {excede && (
                  <p className="mt-1 text-xs font-semibold text-stock-low">
                    Pides más de lo que hay. Puedes solicitarlo, pero el
                    despacho fallará si no se repone antes.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <label className="mt-3 flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-muted">Nota (opcional)</span>
        <input
          value={notas}
          onChange={(e) => setNotas(e.target.value)}
          className="h-touch-lg rounded-xl border border-hairline bg-surface px-3 text-base text-ink"
        />
      </label>

      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => { setAbierto(false); setError(null) }}
          className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={pending || lineas.length === 0}
          onClick={enviar}
          className="h-touch-lg flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40"
        >
          {pending ? 'Enviando…' : 'Solicitar'}
        </button>
      </div>
    </div>
  )
}
