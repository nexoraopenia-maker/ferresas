'use client'

import { useCallback, useMemo, useRef, useState, useTransition } from 'react'
import { InventoryScannerModal } from '@/components/inventory/InventoryScannerModal'
import { QuantityInput } from '@/components/ui/quantity-input'
import { getStockStatusView } from '@/lib/stock-status'
import {
  formatQuantity,
  isBulkUnit,
  redondear,
  stepsFor,
  unitLabel,
} from '@/lib/quantity'
import { lookupForPos, registerSale, searchForPos, type PosProduct } from '../actions'

interface LineaCarrito {
  key: string
  producto: PosProduct
  quantity: number
  discount: number
}

const METODOS = [
  { value: 'EFECTIVO', label: 'Efectivo' },
  { value: 'YAPE', label: 'Yape' },
  { value: 'PLIN', label: 'Plin' },
  { value: 'TARJETA_DEBITO', label: 'Débito' },
  { value: 'TARJETA_CREDITO', label: 'Crédito' },
  { value: 'TRANSFERENCIA', label: 'Transfer.' },
] as const

type Metodo = (typeof METODOS)[number]['value']

/** Dinero: siempre 2 decimales. Las CANTIDADES usan `redondear` (4). */
const cent = (n: number) => Math.round(n * 100) / 100
const money = (n: number) => `S/ ${n.toFixed(2)}`

/**
 * Terminal del Punto de Venta (§5.4).
 *
 * El escáner es el MISMO componente que usa el almacén: solo emite códigos y
 * no sabe nada de carritos ni de ventas. Esa separación es la que permite
 * reutilizarlo aquí sin tocarlo.
 *
 * Modo continuo activado: en el mostrador se escanean cinco productos
 * seguidos, y cerrar la cámara entre cada uno sería absurdo. El anti-rebote
 * del escáner, encadenado a la búsqueda en el servidor, es lo que evita que
 * un código delante de la cámara añada veinte unidades.
 */
export function PosTerminal({ warehouseName }: { warehouseName: string }) {
  const [carrito, setCarrito] = useState<LineaCarrito[]>([])
  const [escaneando, setEscaneando] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const [resultados, setResultados] = useState<PosProduct[]>([])
  const [metodo, setMetodo] = useState<Metodo>('EFECTIVO')
  const [recibido, setRecibido] = useState('')
  const [aviso, setAviso] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recibo, setRecibo] = useState<{ saleId: string; number: string; total: number } | null>(null)
  const [pendiente, startTransition] = useTransition()
  const idemRef = useRef<string | null>(null)

  const totales = useMemo(() => {
    let bruto = 0
    let descuentos = 0
    for (const l of carrito) {
      bruto = cent(bruto + l.producto.salePrice * l.quantity)
      descuentos = cent(descuentos + l.discount)
    }
    const total = cent(bruto - descuentos)
    // El precio ya incluye IGV: se extrae, no se suma.
    const igv = cent(carrito.reduce((s, l) => {
      const neto = cent(l.producto.salePrice * l.quantity - l.discount)
      return s + (neto - neto / (1 + l.producto.taxRate))
    }, 0))
    return { bruto, descuentos, total, igv, base: cent(total - igv) }
  }, [carrito])

  const agregar = useCallback((p: PosProduct) => {
    setError(null)
    setCarrito((prev) => {
      const i = prev.findIndex((l) => l.producto.productId === p.productId)
      if (i >= 0) {
        const copia = [...prev]
        copia[i] = { ...copia[i]!, quantity: redondear(copia[i]!.quantity + 1) }
        return copia
      }
      // Arranca en 1 incluso a granel: el cajero pesa y teclea la cifra
      // exacta, y 1 kg es un punto de partida más útil que 0.
      return [...prev, { key: `${p.productId}-${Date.now()}`, producto: p, quantity: 1, discount: 0 }]
    })
    if (p.trackStock && p.stock <= 0) {
      setAviso(`"${p.name}" está sin stock. Podrás cobrar solo si tu política lo permite.`)
    } else if (isBulkUnit(p.unitType)) {
      setAviso(`"${p.name}" se vende por ${unitLabel(p.unitType)}: escribe la cantidad pesada o medida.`)
    }
  }, [])

  // El escáner espera esta promesa antes de aceptar otra lectura.
  const onDetected = useCallback(async (code: string) => {
    setError(null)
    setAviso(null)
    const res = await lookupForPos({ code })

    if (!res.ok) { setError(res.message); return }
    if (!res.data) {
      setAviso(`El código ${code} no está registrado. Búscalo por nombre o créalo en inventario.`)
      return
    }
    agregar(res.data)
  }, [agregar])

  const buscar = useCallback((texto: string) => {
    setBusqueda(texto)
    if (texto.trim().length < 2) { setResultados([]); return }
    startTransition(async () => {
      const r = await searchForPos(texto)
      setResultados(r.ok ? r.data : [])
    })
  }, [])

  const fijarCantidad = (key: string, q: number) =>
    setCarrito((prev) =>
      prev.flatMap((l) => {
        if (l.key !== key) return [l]
        // Llegar a cero saca la línea: es lo que el cajero espera, en vez de
        // dejar una línea de cero que no se puede cobrar.
        return q <= 0 ? [] : [{ ...l, quantity: redondear(q) }]
      }),
    )

  const sumarCantidad = (key: string, delta: number) =>
    setCarrito((prev) =>
      prev.flatMap((l) => {
        if (l.key !== key) return [l]
        const q = redondear(l.quantity + delta)
        return q <= 0 ? [] : [{ ...l, quantity: q }]
      }),
    )

  const cobrar = () => {
    if (carrito.length === 0) return
    setError(null)
    idemRef.current ??= crypto.randomUUID()

    const entregado = Number(recibido) || totales.total

    startTransition(async () => {
      const res = await registerSale({
        warehouseId: carrito[0]!.producto.warehouseId,
        items: carrito.map((l) => ({
          productId: l.producto.productId,
          variantId: l.producto.variantId,
          quantity: l.quantity,
          discount: l.discount,
        })),
        payments: [{ method: metodo, amount: Math.max(entregado, totales.total) }],
        documentType: 'NOTA_VENTA',
        idempotencyKey: idemRef.current ?? undefined,
      })

      if (!res.ok) { setError(res.message); return }

      setRecibo({ saleId: res.data.saleId, number: res.data.number, total: res.data.total })
      setCarrito([])
      setRecibido('')
      setBusqueda('')
      setResultados([])
      idemRef.current = null
      if (res.data.soldBelowStock) {
        setAviso('La venta se registró dejando stock en negativo. Revisa el inventario.')
      }
    })
  }

  const vuelto = Number(recibido) > 0 ? cent(Number(recibido) - totales.total) : 0

  return (
    <div className="flex flex-col gap-4 pb-40">
      {recibo && (
        <ReciboEmitido
          recibo={recibo}
          onCerrar={() => setRecibo(null)}
        />
      )}

      {aviso && (
        <p role="status" className="rounded-xl border border-stock-low/40 bg-stock-low-soft px-4 py-3 text-sm font-semibold text-stock-low">
          {aviso}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-xl border border-stock-out/40 bg-stock-out-soft px-4 py-3 text-sm font-semibold text-stock-out">
          {error}
        </p>
      )}

      {/* --- Entrada: escáner + búsqueda --------------------------------- */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => { setAviso(null); setEscaneando(true) }}
          className="h-touch-xl flex-1 rounded-2xl bg-industrial-600 text-lg font-bold text-white transition active:scale-95"
        >
          Escanear
        </button>
      </div>

      <div>
        <input
          value={busqueda}
          onChange={(e) => buscar(e.target.value)}
          placeholder="O busca por nombre…"
          className="h-touch-lg w-full rounded-xl border border-hairline bg-surface px-4 text-base text-ink placeholder:text-ink-muted focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
        />
        {resultados.length > 0 && (
          <ul className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-hairline bg-surface">
            {resultados.map((p) => {
              const s = getStockStatusView(p.stock, p.minStock)
              return (
                <li key={p.productId}>
                  <button
                    type="button"
                    onClick={() => { agregar(p); setBusqueda(''); setResultados([]) }}
                    className="flex w-full items-center gap-3 border-b border-hairline px-3 py-3 text-left last:border-0 active:bg-surface-sunken"
                  >
                    <span className={`size-2.5 shrink-0 rounded-full ${s.dotClassName}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-ink">{p.name}</span>
                      <span className="block text-xs text-ink-muted">
                        {p.sku} · stock {formatQuantity(p.stock, p.unitType)} {unitLabel(p.unitType)}
                      </span>
                    </span>
                    <span className="shrink-0 font-bold text-ink">{money(p.salePrice)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <InventoryScannerModal
        open={escaneando}
        onClose={() => setEscaneando(false)}
        onDetected={onDetected}
        continuous
        title="Escanear para cobrar"
        hint={`Almacén: ${warehouseName}`}
      />

      {/* --- Carrito ----------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Carrito ({carrito.length})
        </h2>

        {carrito.length === 0 ? (
          <p className="mt-2 rounded-xl border border-dashed border-hairline px-4 py-8 text-center text-sm text-ink-muted">
            Escanea un producto para empezar.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {carrito.map((l) => {
              const neto = cent(l.producto.salePrice * l.quantity - l.discount)
              const sinStock = l.producto.trackStock && l.quantity > l.producto.stock
              return (
                <li
                  key={l.key}
                  className={`rounded-xl border p-3 ${sinStock ? 'border-stock-out/50 bg-stock-out-soft' : 'border-hairline bg-surface'}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{l.producto.name}</p>
                      <p className="text-xs text-ink-muted">
                        {formatQuantity(l.quantity, l.producto.unitType)}{' '}
                        {unitLabel(l.producto.unitType)} × {money(l.producto.salePrice)}
                        {sinStock && (
                          <> · solo {formatQuantity(l.producto.stock, l.producto.unitType)} en stock</>
                        )}
                      </p>
                    </div>
                    <p className="shrink-0 text-lg font-bold text-ink">{money(neto)}</p>
                  </div>

                  <QuantityInput
                    value={l.quantity}
                    onChange={(q) => fijarCantidad(l.key, q)}
                    unitType={l.producto.unitType}
                    min={0}
                    ariaLabel={`Cantidad de ${l.producto.name}`}
                    className="mt-2"
                  />

                  {/* Atajos adaptados a la unidad: para clavos al peso,
                      +25 no sirve de nada; +0.25 kg sí. */}
                  <div className="mt-2 flex items-center gap-1.5">
                    {stepsFor(l.producto.unitType).map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => sumarCantidad(l.key, n)}
                        className="h-touch flex-1 rounded-lg border border-hairline bg-surface text-xs font-bold text-ink active:scale-95"
                      >
                        +{formatQuantity(n, l.producto.unitType)}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setCarrito((p) => p.filter((x) => x.key !== l.key))}
                      className="h-touch shrink-0 rounded-lg px-3 text-xs font-semibold text-stock-out"
                    >
                      Quitar
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* --- Cobro: fijo abajo, al alcance del pulgar -------------------- */}
      {carrito.length > 0 && (
        <div className="safe-bottom fixed inset-x-0 bottom-0 border-t border-hairline bg-surface px-4 pt-3 shadow-[0_-8px_24px_rgba(2,6,23,0.12)]">
          <div className="mx-auto max-w-lg">
            <dl className="flex flex-col gap-0.5 text-sm">
              <Linea label="Base imponible" value={money(totales.base)} />
              <Linea label="IGV (incluido)" value={money(totales.igv)} />
              {totales.descuentos > 0 && (
                <Linea label="Descuentos" value={`− ${money(totales.descuentos)}`} />
              )}
              <div className="mt-1 flex items-baseline justify-between border-t border-hairline pt-1">
                <dt className="font-bold text-ink">Total</dt>
                <dd className="text-2xl font-bold text-industrial-700 dark:text-industrial-400">
                  {money(totales.total)}
                </dd>
              </div>
            </dl>

            <div className="mt-2 flex gap-1 overflow-x-auto pb-1">
              {METODOS.map((m) => (
                <button key={m.value} type="button" onClick={() => setMetodo(m.value)}
                  aria-pressed={metodo === m.value}
                  className={`h-touch shrink-0 rounded-xl px-3 text-sm font-bold ${
                    metodo === m.value ? 'bg-graphite-900 text-white dark:bg-graphite-50 dark:text-graphite-900'
                    : 'border border-hairline text-ink'
                  }`}>
                  {m.label}
                </button>
              ))}
            </div>

            {metodo === 'EFECTIVO' && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number" inputMode="decimal" value={recibido}
                  onChange={(e) => setRecibido(e.target.value)}
                  placeholder="Recibido"
                  aria-label="Efectivo recibido"
                  className="h-touch-lg min-w-0 flex-1 rounded-xl border border-hairline bg-surface px-4 text-lg font-bold text-ink"
                />
                <p className="shrink-0 text-sm text-ink-muted">
                  Vuelto <span className="text-base font-bold text-ink">{money(Math.max(vuelto, 0))}</span>
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={cobrar}
              disabled={pendiente || carrito.some((l) => l.quantity <= 0)}
              className="mt-2 h-touch-xl w-full rounded-2xl bg-industrial-600 text-lg font-bold text-white transition active:scale-95 disabled:opacity-40"
            >
              {pendiente ? 'Registrando…' : `Cobrar ${money(totales.total)}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Linea({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-semibold text-ink">{value}</dd>
    </div>
  )
}

/** Tras cobrar: emitir comprobante o seguir vendiendo. */
function ReciboEmitido({
  recibo,
  onCerrar,
}: {
  recibo: { saleId: string; number: string; total: number }
  onCerrar: () => void
}) {
  const [doc, setDoc] = useState<{ fullNumber: string; status: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendiente, startTransition] = useTransition()

  const emitir = (documentType: 'BOLETA' | 'FACTURA') => {
    setError(null)
    startTransition(async () => {
      const res = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ saleId: recibo.saleId, documentType }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok) {
        setError(d?.message ?? 'No se pudo emitir el comprobante.')
        return
      }
      setDoc({ fullNumber: d.fullNumber, status: d.status })
    })
  }

  return (
    <div className="rounded-2xl border-2 border-stock-ok bg-stock-ok-soft p-4">
      <p className="font-bold text-stock-ok">Venta registrada</p>
      <p className="mt-1 text-sm text-ink">
        <span className="font-mono font-semibold">{recibo.number}</span> ·{' '}
        {money(recibo.total)}
      </p>

      {doc ? (
        <p className="mt-3 rounded-xl bg-surface px-3 py-2 text-sm text-ink">
          Comprobante <span className="font-mono font-bold">{doc.fullNumber}</span>{' '}
          — estado <span className="font-semibold">{doc.status}</span>
        </p>
      ) : (
        <>
          <p className="mt-3 text-sm text-ink-muted">¿Emitir comprobante?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => emitir('BOLETA')} disabled={pendiente}
              className="h-touch-lg flex-1 rounded-xl bg-graphite-900 px-4 font-bold text-white disabled:opacity-40 dark:bg-graphite-50 dark:text-graphite-900">
              {pendiente ? '…' : 'Boleta'}
            </button>
            <button type="button" onClick={() => emitir('FACTURA')} disabled={pendiente}
              className="h-touch-lg flex-1 rounded-xl border border-graphite-900 px-4 font-bold text-ink disabled:opacity-40 dark:border-graphite-50">
              Factura
            </button>
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="mt-2 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
          {error}
        </p>
      )}

      <button type="button" onClick={onCerrar}
        className="mt-3 h-touch w-full rounded-xl text-sm font-semibold text-ink-muted">
        Nueva venta
      </button>
    </div>
  )
}
