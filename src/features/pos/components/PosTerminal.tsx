'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { formatearFechaLocal } from '@/lib/fecha-local'
import { redondearCentimos } from '@/lib/dinero'
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
import {
  lookupForPos, registerQuote, registerSale, searchForPos,
  type PosCustomer, type PosProduct,
} from '../actions'
import { CustomerPicker } from './CustomerPicker'
import { ATAJOS_VISIBLES, usePosShortcuts } from './use-pos-shortcuts'

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
/**
 * Mismo redondeo que el servidor, y eso es el punto.
 *
 * El total que ve el cajero en pantalla lo calcula ESTE código; el que se
 * cobra lo calcula `registerSale`. Si cada uno redondeara distinto, el POS
 * mostraría 63.30 y la boleta saldría con 63.31 — un céntimo que nadie
 * sabría explicar y que aparecería solo en ciertos precios.
 */
const cent = redondearCentimos
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
export function PosTerminal({
  warehouseName,
  zonaHoraria,
}: {
  warehouseName: string
  /** Zona del negocio: ver la nota en CashPanel. */
  zonaHoraria: string
}) {
  const [carrito, setCarrito] = useState<LineaCarrito[]>([])
  const [escaneando, setEscaneando] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const [resultados, setResultados] = useState<PosProduct[]>([])
  const [metodo, setMetodo] = useState<Metodo>('EFECTIVO')
  const [recibido, setRecibido] = useState('')
  const [aviso, setAviso] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recibo, setRecibo] = useState<{ saleId: string; number: string; total: number } | null>(null)
  const [cliente, setCliente] = useState<PosCustomer | null>(null)
  const [forzarStock, setForzarStock] = useState(false)
  const [cotizacion, setCotizacion] = useState<
    { quoteId: string; number: string; validUntil: string } | null
  >(null)
  const [pendiente, startTransition] = useTransition()
  const idemRef = useRef<string | null>(null)
  const buscadorRef = useRef<HTMLInputElement>(null)

  usePosShortcuts({
    onBuscar: () => buscadorRef.current?.focus(),
    onEscanear: () => { setAviso(null); setEscaneando(true) },
    onCobrar: () => { if (carrito.length > 0 && !pendiente) cobrar() },
    onCotizar: () => { if (carrito.length > 0 && !pendiente) cotizar() },
  })

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

  /*
   * Búsqueda inmediata pero sin atropellarse:
   *   · 120 ms de espera tras la última tecla (no una consulta por letra);
   *   · cada consulta lleva un número de secuencia y solo vale la ÚLTIMA: sin
   *     esto, la respuesta lenta de «ce» podía llegar después de la de «cem» y
   *     pisarla con resultados viejos.
   */
  const seqBusqueda = useRef(0)
  const temporizador = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(temporizador.current), [])

  const buscar = useCallback((texto: string) => {
    setBusqueda(texto)
    clearTimeout(temporizador.current)
    const seq = ++seqBusqueda.current
    if (texto.trim().length < 2) { setResultados([]); return }
    temporizador.current = setTimeout(() => {
      startTransition(async () => {
        const r = await searchForPos(texto)
        if (seq === seqBusqueda.current) setResultados(r.ok ? r.data : [])
      })
    }, 120)
  }, [])

  /*
   * Enter en la caja: lo que hace un lector USB que «teclea» el código y
   * termina con Enter. Se resuelve por código EXACTO sin esperar a la lista, y
   * si no hay código exacto, con el primer resultado cuando es inequívoco.
   */
  const alPulsarEnter = async () => {
    const texto = busqueda.trim()
    if (texto.length < 2) return
    clearTimeout(temporizador.current)
    seqBusqueda.current++
    setError(null); setAviso(null)
    const exacto = await lookupForPos({ code: texto })
    if (exacto.ok && exacto.data) {
      agregar(exacto.data); setBusqueda(''); setResultados([]); return
    }
    const lista = resultados.length > 0 ? resultados : (await searchForPos(texto).then((r) => (r.ok ? r.data : [])))
    const primero = lista[0]
    if (primero && (lista.length === 1 || (primero.relevancia ?? 9) <= 1)) {
      agregar(primero); setBusqueda(''); setResultados([]); return
    }
    setResultados(lista)
    if (lista.length === 0) setAviso(`No encontré «${texto}». Revisa el código o créalo en inventario.`)
  }

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
        customerId: cliente?.id ?? null,
        items: carrito.map((l) => ({
          productId: l.producto.productId,
          variantId: l.producto.variantId,
          quantity: l.quantity,
          discount: l.discount,
        })),
        payments: [{ method: metodo, amount: Math.max(entregado, totales.total) }],
        documentType: 'NOTA_VENTA',
        allowNegativeStock: forzarStock,
        idempotencyKey: idemRef.current ?? undefined,
      })

      if (!res.ok) {
        setError(res.message)
        // Si el bloqueo fue por stock, se ofrece forzar en lugar de dejar al
        // cajero atascado con el cliente delante.
        if (res.code === 'INSUFFICIENT_STOCK' && !forzarStock) {
          setAviso('Marca «Vender sin stock» si el producto está físicamente disponible.')
        }
        return
      }

      setRecibo({ saleId: res.data.saleId, number: res.data.number, total: res.data.total })
      setCarrito([])
      setCliente(null)
      setForzarStock(false)
      setRecibido('')
      setBusqueda('')
      setResultados([])
      idemRef.current = null
      if (res.data.soldBelowStock) {
        setAviso('La venta se registró dejando stock en negativo. Revisa el inventario.')
      }
    })
  }

  const cotizar = () => {
    if (carrito.length === 0) return
    setError(null)
    setAviso(null)

    startTransition(async () => {
      const res = await registerQuote({
        warehouseId: carrito[0]!.producto.warehouseId,
        customerId: cliente?.id ?? null,
        items: carrito.map((l) => ({
          productId: l.producto.productId,
          variantId: l.producto.variantId,
          quantity: l.quantity,
          discount: l.discount,
        })),
        validDays: 15,
        idempotencyKey: crypto.randomUUID(),
      })

      if (!res.ok) { setError(res.message); return }

      setCotizacion({
        quoteId: res.data.quoteId,
        number: res.data.number,
        validUntil: res.data.validUntil,
      })
      // El carrito se VACÍA: la cotización ya quedó guardada y dejarlo lleno
      // haría que el siguiente cliente heredara los productos del anterior.
      setCarrito([])
      setCliente(null)
    })
  }

  const vuelto = Number(recibido) > 0 ? cent(Number(recibido) - totales.total) : 0
  const hayFaltaDeStock = carrito.some(
    (l) => l.producto.trackStock && l.quantity > l.producto.stock,
  )

  return (
    /**
     * Una columna en móvil, dos en escritorio.
     *
     * `items-start` en la rejilla es lo que permite que la columna del
     * carrito se quede pegada arriba (`sticky`) mientras la izquierda crece:
     * con el `stretch` por defecto, ambas tendrían la altura de la más alta
     * y el `sticky` no tendría contra qué pegarse.
     *
     * El `pb-40` solo en móvil: ahí el bloque de cobro va fijo al fondo y
     * taparía las últimas líneas del carrito sin ese hueco. En escritorio
     * vive en su columna y no tapa nada.
     */
    <div className="pb-40 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6 lg:pb-0">
      {/* Avisos a ANCHO COMPLETO sobre las dos columnas.
          Sin `col-span-2` cada uno ocuparía una celda de la rejilla y
          desplazaría el carrito a una tercera fila. */}
      {(recibo || aviso || error) && (
        <div className="flex flex-col gap-3 lg:col-span-2">
          {recibo && (
            <ReciboEmitido recibo={recibo} onCerrar={() => setRecibo(null)} />
          )}
          {cotizacion && (
            <div className="rounded-2xl border-2 border-industrial-600 bg-industrial-50 p-4 dark:bg-industrial-950">
              <p className="font-bold text-industrial-700 dark:text-industrial-300">
                Cotización guardada
              </p>
              <p className="mt-1 text-sm text-ink">
                <span className="font-mono font-semibold">{cotizacion.number}</span> · válida
                hasta{' '}
                {formatearFechaLocal(cotizacion.validUntil, zonaHoraria, 'es-PE', {
                  conHora: false,
                })}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  href={`/imprimir/cotizacion/${cotizacion.quoteId}?auto=1`}
                  target="_blank"
                  rel="noopener"
                  className="h-touch inline-flex items-center rounded-xl bg-graphite-900 px-4 text-sm font-bold text-white dark:bg-graphite-50 dark:text-graphite-900"
                >
                  Imprimir 80 mm
                </a>
                <a
                  href="/cotizaciones"
                  className="h-touch inline-flex items-center rounded-xl border border-hairline px-4 text-sm font-semibold text-ink"
                >
                  Ver listado
                </a>
                <button
                  type="button"
                  onClick={() => setCotizacion(null)}
                  className="h-touch rounded-xl border border-hairline px-4 text-sm font-semibold text-ink"
                >
                  Nueva venta
                </button>
              </div>
            </div>
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
        </div>
      )}

      {/* ══════════ COLUMNA IZQUIERDA: entrada de productos ══════════ */}
      <div className="flex min-w-0 flex-col gap-4">
      {/* --- Entrada: escáner + búsqueda --------------------------------- */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => { setAviso(null); setEscaneando(true) }}
          className="h-touch-xl flex-1 rounded-2xl bg-industrial-600 text-lg font-bold text-white transition active:scale-95"
        >
          Escanear <span className="hidden text-sm font-normal opacity-75 lg:inline">(F4)</span>
        </button>
      </div>

      <div>
        <input
          ref={buscadorRef}
          value={busqueda}
          onChange={(e) => buscar(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void alPulsarEnter() } }}
          placeholder="Código, SKU o nombre…  (F2)"
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

      </div>

      {/* ══════════ COLUMNA DERECHA: carrito, totales y cobro ══════════
          En escritorio se queda pegada arriba mientras la izquierda crece:
          el cajero no pierde de vista el total al bajar por la lista. */}
      <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4">
      {/* --- Cliente: encima del carrito, que es donde se decide el
              comprobante ------------------------------------------------- */}
      <CustomerPicker cliente={cliente} onChange={setCliente} />

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
        <div
          /**
           * El MISMO bloque en los dos modos, posicionado por breakpoint en
           * vez de duplicado. Duplicarlo habría significado dos copias de la
           * lógica de cobro, y la segunda se queda sin arreglar siempre.
           *
           * Móvil: fijo al fondo, al alcance del pulgar.
           * Escritorio: estático dentro de la columna derecha, que ya es
           * sticky, así que acompaña igual sin flotar sobre el contenido.
           */
          className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-hairline bg-surface px-4 pt-3 shadow-[0_-8px_24px_rgba(2,6,23,0.12)] lg:static lg:inset-auto lg:rounded-2xl lg:border lg:p-4 lg:pb-4 lg:shadow-none"
        >
          <div className="mx-auto max-w-lg lg:max-w-none">
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

            {/* Venta forzada. Solo aparece cuando hace falta: una casilla
                permanente invitaría a marcarla por costumbre, y entonces la
                política de stock dejaría de significar nada. */}
            {hayFaltaDeStock && (
              <label className="mt-2 flex items-start gap-2 rounded-xl border border-stock-low/40 bg-stock-low-soft px-3 py-2">
                <input
                  type="checkbox"
                  checked={forzarStock}
                  onChange={(e) => setForzarStock(e.target.checked)}
                  className="mt-0.5 size-5 shrink-0 accent-stock-low"
                />
                <span className="text-xs font-semibold text-stock-low">
                  Vender sin stock suficiente
                  <span className="mt-0.5 block font-normal">
                    El inventario quedará en negativo y se registrará para
                    que puedas contar esos productos.
                  </span>
                </span>
              </label>
            )}

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={cotizar}
                disabled={pendiente || carrito.some((l) => l.quantity <= 0)}
                className="h-touch-xl shrink-0 rounded-2xl border border-graphite-900 px-4 text-sm font-bold text-ink transition active:scale-95 disabled:opacity-40 dark:border-graphite-50"
              >
                Cotizar
                <span className="hidden text-xs font-normal opacity-70 lg:block">Ctrl+G</span>
              </button>
              <button
                type="button"
                onClick={cobrar}
                disabled={pendiente || carrito.some((l) => l.quantity <= 0)}
                className="h-touch-xl min-w-0 flex-1 rounded-2xl bg-industrial-600 text-lg font-bold text-white transition active:scale-95 disabled:opacity-40"
              >
                {pendiente ? 'Registrando…' : `Cobrar ${money(totales.total)}`}
                <span className="hidden text-xs font-normal opacity-75 lg:block">F9</span>
              </button>
            </div>

            {/* Los atajos solo en escritorio y solo si hay carrito: un atajo
                que nadie descubre no existe, pero en móvil no hay teclado. */}
            <p className="mt-1.5 hidden text-center text-xs text-ink-muted lg:block">
              {ATAJOS_VISIBLES.map((a) => `${a.teclas} ${a.accion.toLowerCase()}`).join(' · ')}
            </p>
          </div>
        </div>
      )}
      </div>
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
  const [doc, setDoc] = useState<{ id: string; fullNumber: string; status: string } | null>(null)
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
      setDoc({ id: d.id, fullNumber: d.fullNumber, status: d.status })
    })
  }

  return (
    <div className="rounded-2xl border-2 border-stock-ok bg-stock-ok-soft p-4">
      <p className="font-bold text-stock-ok">Venta registrada</p>
      <p className="mt-1 text-sm text-ink">
        <span className="font-mono font-semibold">{recibo.number}</span> ·{' '}
        {money(recibo.total)}
      </p>

      {/*
        * El ticket se puede imprimir siempre, incluso antes de decidir si la
        * venta lleva comprobante: en el mostrador el cliente se va con un
        * papel en la mano, y esperar a emitir la boleta lo retiene.
        */}
      <a
        href={`/imprimir/venta/${recibo.saleId}?auto=1`}
        target="_blank"
        rel="noopener"
        className="mt-3 flex h-touch-lg items-center justify-center rounded-xl bg-graphite-900 px-4 font-bold text-white dark:bg-graphite-50 dark:text-graphite-900"
      >
        Imprimir ticket 80 mm
      </a>

      {doc ? (
        <div className="mt-3 rounded-xl bg-surface px-3 py-2">
          <p className="text-sm text-ink">
            Comprobante <span className="font-mono font-bold">{doc.fullNumber}</span>{' '}
            — estado <span className="font-semibold">{doc.status}</span>
          </p>
          <a
            href={`/imprimir/comprobante/${doc.id}?auto=1`}
            target="_blank"
            rel="noopener"
            className="mt-2 flex h-touch items-center justify-center rounded-lg border border-hairline text-sm font-semibold text-ink"
          >
            Imprimir {doc.fullNumber}
          </a>
        </div>
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
