'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { formatearFechaLocal } from '@/lib/fecha-local'
import { redondearCentimos } from '@/lib/dinero'
import { trocearResaltado } from '../resaltado'
import { InventoryScannerModal, type ResultadoLectura } from '@/components/inventory/InventoryScannerModal'
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
  cobrarPedido, lookupForPos, registerPedido, registerQuote, registerSale, searchForPos, soltarPedido, tomarPedido,
  type PosCustomer, type PosProduct,
} from '../actions'
import { CustomerPicker } from './CustomerPicker'
import { ATAJOS_VISIBLES, usePosShortcuts } from './use-pos-shortcuts'

interface LineaCarrito {
  key: string
  producto: PosProduct
  quantity: number
  discount: number
  /** Descuento en % de la línea. El importe (`discount`) se recalcula si cambia la cantidad. */
  pct?: number
}

/** Importe del descuento de una línea con esa cantidad: mismo redondeo que el servidor. */
const descuentoDe = (l: LineaCarrito, cantidad: number) =>
  cent(cent(l.producto.salePrice * cantidad) * ((l.pct ?? 0) / 100))

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
  puedeCobrar = true,
  puedeArmarPedido = false,
  pedidoId,
  topeDescuentoPct = 0,
}: {
  warehouseName: string
  /** Zona del negocio: ver la nota en CashPanel. */
  zonaHoraria: string
  /** Tiene `ventas.cobrar`. Sin él, el carrito se envía a caja en lugar de cobrarse. */
  puedeCobrar?: boolean
  /** Tiene `ventas.crear`: puede mandar el carrito a la cola de caja. */
  puedeArmarPedido?: boolean
  /** Pedido de la cola que se va a cobrar (llega por `?pedido=`). */
  pedidoId?: string
  /** Descuento máximo (% de la línea) que el rol puede dar. 0 = sin descuentos. */
  topeDescuentoPct?: number
}) {
  const [carrito, setCarrito] = useState<LineaCarrito[]>([])
  const [escaneando, setEscaneando] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const [resultados, setResultados] = useState<PosProduct[]>([])
  // Autocompletado: fila marcada con las flechas, última búsqueda terminada y si falló.
  const [activo, setActivo] = useState(-1)
  const [buscado, setBuscado] = useState('')
  const [falloBusqueda, setFalloBusqueda] = useState(false)
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
  const [pedido, setPedido] = useState<{ id: string; number: string } | null>(null)
  const [pedidoEnviado, setPedidoEnviado] = useState<{ number: string; total: number } | null>(null)
  const pedidoRef = useRef(pedido)
  useEffect(() => { pedidoRef.current = pedido }, [pedido])
  const idemRef = useRef<string | null>(null)
  const buscadorRef = useRef<HTMLInputElement>(null)

  usePosShortcuts({
    onBuscar: () => buscadorRef.current?.focus(),
    onEscanear: () => { setAviso(null); setEscaneando(true) },
    onCobrar: () => { if (carrito.length > 0 && !pendiente) cobrar() },
    onCotizar: () => { if (carrito.length > 0 && !pendiente) cotizar() },
  })

  /*
   * Pedido de la cola: se TOMA al abrir la pantalla (reserva atómica en el
   * servidor), se renueva cada 2 min mientras siga abierta y se carga en el
   * carrito con sus precios congelados. Si no se puede tomar (lo tiene otro
   * cajero, venció, ya se cobró) se dice por qué y no se carga nada.
   */
  useEffect(() => {
    if (!pedidoId) return
    let vivo = true
    ;(async () => {
      const r = await tomarPedido(pedidoId)
      if (!vivo) return
      if (!r.ok) { setError(r.message); return }
      const p = r.data
      setPedido({ id: p.id, number: p.number })
      setCliente(p.cliente ? { ...p.cliente, creado: false } : null)
      setCarrito(p.lineas.map((l, i) => ({
        key: `${l.productId}-${i}`,
        quantity: l.cantidad,
        discount: l.descuento,
        producto: {
          productId: l.productId, variantId: l.variantId, name: l.nombre, sku: l.sku, barcode: null, qrCode: null,
          unitType: l.unitType, salePrice: l.precio, taxRate: l.taxRate, trackStock: false, stock: 0, minStock: 0,
          stockStatus: 'OK', warehouseId: p.warehouseId, warehouseName,
        },
      })))
    })()
    const latido = setInterval(() => { void tomarPedido(pedidoId) }, 120_000)
    return () => { vivo = false; clearInterval(latido) }
  }, [pedidoId, warehouseName])

  const devolverPedido = () => {
    if (!pedido) return
    startTransition(async () => {
      await soltarPedido(pedido.id)
      setPedido(null); setCarrito([]); setCliente(null)
      window.location.assign('/pedidos')
    })
  }

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
    if (pedidoRef.current) return   // un pedido tomado no se edita
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
  const onDetected = useCallback(async (code: string): Promise<ResultadoLectura> => {
    setError(null)
    setAviso(null)
    const res = await lookupForPos({ code })

    if (!res.ok) {
      // Un QR ajeno (un enlace, un texto largo) no es un producto: mensaje claro, sin ruido.
      const mensaje = res.code === 'VALIDATION' ? 'Ese código no es de un producto de tu catálogo.' : res.message
      return { tipo: 'error', mensaje }
    }
    if (!res.data) {
      return { tipo: 'aviso', mensaje: `El código ${code.length > 24 ? `${code.slice(0, 24)}…` : code} no está registrado.` }
    }
    agregar(res.data)
    return { tipo: 'ok', mensaje: `+ ${res.data.name}` }
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
    if (texto.trim().length < 2) { setResultados([]); setBuscado(''); setActivo(-1); setFalloBusqueda(false); return }
    temporizador.current = setTimeout(() => {
      startTransition(async () => {
        const r = await searchForPos(texto)
        if (seq === seqBusqueda.current) {
          setResultados(r.ok ? r.data : [])
          setFalloBusqueda(!r.ok)
          setBuscado(texto.trim())
          setActivo(-1)
        }
      })
    }, 120)
  }, [])

  /*
   * Enter en la caja: lo que hace un lector USB que «teclea» el código y
   * termina con Enter. Se resuelve por código EXACTO sin esperar a la lista, y
   * si no hay código exacto, con el primer resultado cuando es inequívoco.
   */
  const alPulsarEnter = async () => {
    // Con una fila marcada con las flechas, Enter elige ESA.
    const marcada = activo >= 0 ? resultados[activo] : undefined
    if (marcada) { agregar(marcada); setBusqueda(''); setResultados([]); setActivo(-1); return }
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
    pedido ? undefined : setCarrito((prev) =>
      prev.flatMap((l) => {
        if (l.key !== key) return [l]
        // Llegar a cero saca la línea: es lo que el cajero espera, en vez de
        // dejar una línea de cero que no se puede cobrar.
        if (q <= 0) return []
        const quantity = redondear(q)
        return [{ ...l, quantity, discount: descuentoDe(l, quantity) }]
      }),
    )

  /** Fija el descuento de una línea en %, sin pasar del tope del rol. */
  const fijarDescuento = (key: string, texto: string) =>
    pedido ? undefined : setCarrito((prev) =>
      prev.map((l) => {
        if (l.key !== key) return l
        const n = Number(texto.replace(',', '.'))
        const pct = !Number.isFinite(n) || n <= 0 ? 0 : Math.min(n, topeDescuentoPct)
        return { ...l, pct, discount: descuentoDe({ ...l, pct }, l.quantity) }
      }),
    )

  const sumarCantidad = (key: string, delta: number) =>
    pedido ? undefined : setCarrito((prev) =>
      prev.flatMap((l) => {
        if (l.key !== key) return [l]
        const q = redondear(l.quantity + delta)
        return q <= 0 ? [] : [{ ...l, quantity: q, discount: descuentoDe(l, q) }]
      }),
    )

  const cobrar = () => {
    if (carrito.length === 0) return
    setError(null)
    idemRef.current ??= crypto.randomUUID()

    const entregado = Number(recibido) || totales.total

    startTransition(async () => {
      // Pedido de la cola: se cobra EL PEDIDO (sus líneas y precios congelados), no el carrito.
      const res = pedido
        ? await cobrarPedido({
            quoteId: pedido.id,
            payments: [{ method: metodo, amount: Math.max(entregado, totales.total) }],
            documentType: 'NOTA_VENTA',
            allowNegativeStock: forzarStock,
            idempotencyKey: idemRef.current ?? undefined,
          })
        : await registerSale({
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
      setPedido(null)
      setCarrito([])
      setCliente(null)
      setForzarStock(false)
      setRecibido('')
      setBusqueda('')
      setResultados([])
      idemRef.current = null
      if ('soldBelowStock' in res.data && res.data.soldBelowStock) {
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

  /** El vendedor manda el carrito a la cola de caja; no cobra ni toca dinero. */
  const enviarACaja = () => {
    if (carrito.length === 0) return
    setError(null)
    setAviso(null)
    startTransition(async () => {
      const res = await registerPedido({
        warehouseId: carrito[0]!.producto.warehouseId,
        customerId: cliente?.id ?? null,
        items: carrito.map((l) => ({
          productId: l.producto.productId, variantId: l.producto.variantId, quantity: l.quantity, discount: l.discount,
        })),
        validDays: 1,
        idempotencyKey: crypto.randomUUID(),
      })
      if (!res.ok) { setError(res.message); return }
      setPedidoEnviado({ number: res.data.number, total: res.data.total })
      // Se vacía: el pedido ya está en la cola y el siguiente cliente no debe heredarlo.
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
    <div className="flex flex-col gap-5 pb-[23rem] lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-6 lg:pb-0 xl:grid-cols-[minmax(0,1fr)_27rem] xl:gap-8">
      {/* Avisos a ANCHO COMPLETO sobre las dos columnas.
          Sin `col-span-2` cada uno ocuparía una celda de la rejilla y
          desplazaría el carrito a una tercera fila. */}
      {pedidoEnviado && (
        <div className="rounded-2xl border-2 border-industrial-600 bg-industrial-50 p-4 lg:col-span-2 dark:bg-industrial-950">
          <p className="font-bold text-industrial-700 dark:text-industrial-300">Pedido enviado a caja</p>
          <p className="mt-1 text-sm text-ink">
            <span className="font-mono font-semibold">{pedidoEnviado.number}</span> · {money(pedidoEnviado.total)}. El cajero lo cobra desde su cola.
          </p>
          <button type="button" onClick={() => setPedidoEnviado(null)} className="mt-2 text-sm font-semibold text-industrial-700 dark:text-industrial-300">Entendido</button>
        </div>
      )}
      {pedido && (
        <div className="rounded-2xl border-2 border-accent-500 bg-accent-50 p-4 lg:col-span-2">
          <p className="font-bold text-accent-800">Cobrando el pedido <span className="font-mono">{pedido.number}</span></p>
          <p className="mt-0.5 text-sm text-accent-900">Las líneas y los precios son los del vendedor y no se editan aquí. Nadie más puede cobrarlo mientras lo tengas abierto.</p>
          <button type="button" onClick={devolverPedido} disabled={pendiente} className="mt-2 text-sm font-bold text-accent-800 underline">Devolver a la cola</button>
        </div>
      )}
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
      <div className="flex min-w-0 flex-col gap-5">
      {/* --- Entrada: escáner + búsqueda --------------------------------- */}
      <div className={pedido ? 'hidden' : 'relative'}>
        <div className="flex gap-3">
          <div className="relative min-w-0 flex-1">
            <svg aria-hidden viewBox="0 0 24 24" className="pointer-events-none absolute left-4 top-1/2 size-6 -translate-y-1/2 text-ink-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={buscadorRef}
              value={busqueda}
              onChange={(e) => buscar(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void alPulsarEnter() }
                else if (e.key === 'ArrowDown' && resultados.length > 0) { e.preventDefault(); setActivo((a) => (a + 1) % resultados.length) }
                else if (e.key === 'ArrowUp' && resultados.length > 0) { e.preventDefault(); setActivo((a) => (a <= 0 ? resultados.length - 1 : a - 1)) }
                else if (e.key === 'Escape') { setResultados([]); setActivo(-1) }
              }}
              role="combobox"
              aria-expanded={resultados.length > 0}
              aria-controls="resultados-pos"
              aria-autocomplete="list"
              autoComplete="off"
              enterKeyHint="search"
              placeholder="Buscar por nombre, código o SKU…  (F2)"
              className="h-16 w-full rounded-2xl border-2 border-hairline bg-surface pl-12 pr-4 text-lg text-ink shadow-sm placeholder:text-ink-muted focus:border-industrial-600 focus:outline-none focus:ring-4 focus:ring-industrial-600/20"
            />
          </div>
          <button
            type="button"
            onClick={() => { setAviso(null); setEscaneando(true) }}
            aria-label="Escanear con la cámara"
            className="flex h-16 shrink-0 items-center justify-center gap-2 rounded-2xl bg-industrial-600 px-5 text-base font-bold text-white shadow-sm transition active:scale-95"
          >
            <svg aria-hidden viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M4 12h16" />
            </svg>
            <span className="hidden sm:inline lg:hidden xl:inline">Escanear</span>
            <span className="hidden text-sm font-normal opacity-75 xl:inline">(F4)</span>
          </button>
        </div>

        {/* Lista FLOTANTE: no empuja el carrito ni el cobro; se cierra al tocar fuera o con Esc. */}
        {(resultados.length > 0 || (busqueda.trim().length >= 2 && (pendiente || falloBusqueda || (buscado !== '' && buscado === busqueda.trim())))) && (
          <>
            <div className="fixed inset-0 z-20" aria-hidden onClick={() => { setResultados([]); setActivo(-1) }} />
            <div
              className="absolute inset-x-0 top-full z-30 mt-2 max-h-[min(32rem,62dvh)] overflow-y-auto overscroll-contain rounded-2xl border border-hairline bg-surface shadow-2xl ring-1 ring-black/5"
            >
              {pendiente && resultados.length === 0 && (
                <p className="px-5 py-4 text-base text-ink-muted" role="status">Buscando…</p>
              )}
              {falloBusqueda && (
                <p className="px-5 py-4 text-base font-semibold text-stock-out" role="alert">
                  No pude buscar ahora. Revisa tu conexión y vuelve a escribir.
                </p>
              )}
              {!pendiente && !falloBusqueda && resultados.length === 0 && (
                <p className="px-5 py-4 text-base text-ink-muted" role="status">
                  Sin coincidencias para «{buscado}». Prueba con menos letras o créalo en inventario.
                </p>
              )}
              {resultados.length > 0 && (
                <ul id="resultados-pos" role="listbox" className="divide-y divide-hairline">
                  {resultados.map((p, i) => {
                    const s = getStockStatusView(p.stock, p.minStock)
                    const marcado = i === activo
                    return (
                      <li key={p.productId} role="option" aria-selected={marcado}>
                        <button
                          type="button"
                          ref={(el) => { if (marcado) el?.scrollIntoView({ block: 'nearest' }) }}
                          onMouseEnter={() => setActivo(i)}
                          onClick={() => { agregar(p); setBusqueda(''); setResultados([]); setActivo(-1) }}
                          className={`flex min-h-[4.5rem] w-full items-center gap-4 px-5 py-3 text-left transition active:bg-surface-sunken ${marcado ? 'bg-industrial-600/10' : 'hover:bg-surface-sunken'}`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-base font-bold text-ink sm:text-lg">
                              <Resaltado texto={p.name} buscadas={busqueda} />
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-sm text-ink-muted">
                              <span className="font-mono"><Resaltado texto={p.sku} buscadas={busqueda} /></span>
                              <span className="font-bold text-ink">{money(p.salePrice)}</span>
                              <span className="inline-flex items-center gap-1.5" title={s.label}>
                                <span className={`size-2.5 rounded-full ${s.dotClassName}`} aria-hidden />
                                {formatQuantity(p.stock, p.unitType)} {unitLabel(p.unitType)}
                              </span>
                            </span>
                          </span>
                          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-industrial-600/10 text-xl font-bold text-industrial-700">+</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </>
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
      <div className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-4">
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
          <ul className="mt-3 flex flex-col gap-3">
            {carrito.map((l) => {
              const neto = cent(l.producto.salePrice * l.quantity - l.discount)
              const sinStock = l.producto.trackStock && l.quantity > l.producto.stock
              return (
                <li
                  key={l.key}
                  className={`rounded-2xl border p-4 ${sinStock ? 'border-stock-out/50 bg-stock-out-soft' : 'border-hairline bg-surface'}`}
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

                  {pedido ? (
                    <p className="mt-2 text-sm text-ink-muted">
                      {formatQuantity(l.quantity, l.producto.unitType)} {unitLabel(l.producto.unitType)} × {money(l.producto.salePrice)}
                    </p>
                  ) : (
                  <QuantityInput
                    value={l.quantity}
                    onChange={(q) => fijarCantidad(l.key, q)}
                    unitType={l.producto.unitType}
                    min={0}
                    ariaLabel={`Cantidad de ${l.producto.name}`}
                    className="mt-3"
                    grande
                  />
                  )}

                  {topeDescuentoPct > 0 && !pedido && (
                    <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                      Descuento
                      <input
                        inputMode="decimal" defaultValue={l.pct ? String(l.pct) : ''} placeholder="0"
                        onChange={(e) => fijarDescuento(l.key, e.target.value)}
                        aria-label={`Descuento de ${l.producto.name} en porcentaje`}
                        className="h-touch w-20 rounded-lg border border-hairline bg-surface px-2 text-right text-sm font-bold text-ink"
                      />
                      %
                      <span>(máx. {topeDescuentoPct}%)</span>
                      {l.discount > 0 && <span className="font-semibold text-accent-700">− {money(l.discount)}</span>}
                    </label>
                  )}

                  {/* Atajos adaptados a la unidad: para clavos al peso,
                      +25 no sirve de nada; +0.25 kg sí. */}
                  <div className={pedido ? 'hidden' : 'mt-2 flex items-center gap-1.5'}>
                    {stepsFor(l.producto.unitType).map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => sumarCantidad(l.key, n)}
                        className="h-12 flex-1 rounded-xl border border-hairline bg-surface text-sm font-bold text-ink active:scale-95"
                      >
                        +{formatQuantity(n, l.producto.unitType)}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setCarrito((p) => p.filter((x) => x.key !== l.key))}
                      className="h-12 shrink-0 rounded-xl px-4 text-sm font-semibold text-stock-out"
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
          className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-hairline bg-surface px-4 pt-3 shadow-[0_-8px_24px_rgba(2,6,23,0.12)] max-h-[85dvh] overflow-y-auto lg:static lg:inset-auto lg:max-h-none lg:overflow-visible lg:rounded-2xl lg:border lg:p-5 lg:pb-5 lg:shadow-none"
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

            {puedeCobrar && (<>
            <div role="group" aria-label="Método de pago" className="mt-3 grid grid-cols-3 gap-2.5">
              {METODOS.map((m) => (
                <button key={m.value} type="button" onClick={() => setMetodo(m.value)}
                  aria-pressed={metodo === m.value}
                  className={`h-14 rounded-2xl px-2 text-base font-bold transition active:scale-95 ${
                    metodo === m.value
                      ? 'bg-industrial-600 text-white shadow-md ring-2 ring-industrial-600 ring-offset-2 ring-offset-surface'
                      : 'border-2 border-hairline bg-surface text-ink hover:bg-surface-sunken'
                  }`}>
                  {m.label}
                </button>
              ))}
            </div>

            {metodo === 'EFECTIVO' && (
              <div className="mt-3 flex items-center gap-3">
                <input
                  type="number" inputMode="decimal" value={recibido}
                  onChange={(e) => setRecibido(e.target.value)}
                  placeholder="Recibido"
                  aria-label="Efectivo recibido"
                  className="h-14 min-w-0 flex-1 rounded-2xl border-2 border-hairline bg-surface px-4 text-xl font-bold text-ink focus:border-industrial-600 focus:outline-none"
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

            </>)}

            <div className="mt-3 flex gap-3 lg:flex-wrap">
              {!pedido && puedeArmarPedido && (
                <button
                  type="button"
                  onClick={enviarACaja}
                  disabled={pendiente || carrito.some((l) => l.quantity <= 0)}
                  className={`h-16 rounded-2xl text-base font-bold transition active:scale-95 disabled:opacity-40 ${
                    puedeCobrar ? 'shrink-0 border-2 border-graphite-900 px-4 text-ink lg:flex-1 lg:shrink dark:border-graphite-50' : 'min-w-0 flex-1 bg-industrial-600 text-lg text-white'
                  }`}
                >
                  {pendiente && !puedeCobrar ? 'Enviando…' : 'Enviar a caja'}
                </button>
              )}
              {!pedido && <button
                type="button"
                onClick={cotizar}
                disabled={pendiente || carrito.some((l) => l.quantity <= 0)}
                className="h-16 shrink-0 rounded-2xl border-2 border-graphite-900 px-5 text-base font-bold text-ink transition active:scale-95 disabled:opacity-40 lg:flex-1 lg:shrink dark:border-graphite-50"
              >
                Cotizar
                <span className="hidden text-xs font-normal opacity-70 lg:block">Ctrl+G</span>
              </button>}
              {puedeCobrar && <button
                type="button"
                onClick={cobrar}
                disabled={pendiente || carrito.some((l) => l.quantity <= 0)}
                className="h-16 min-w-0 flex-1 rounded-2xl bg-industrial-600 text-xl font-bold text-white shadow-md transition active:scale-95 disabled:opacity-40 lg:order-first lg:basis-full"
              >
                {pendiente ? 'Registrando…' : `Cobrar ${money(totales.total)}`}
                <span className="hidden text-xs font-normal opacity-75 lg:block">F9</span>
              </button>}
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

/** Texto con la coincidencia de la búsqueda resaltada (sin importar tildes ni mayúsculas). */
function Resaltado({ texto, buscadas }: { texto: string; buscadas: string }) {
  const trozos = trocearResaltado(texto, buscadas.trim().split(/\s+/).filter(Boolean))
  return (
    <>
      {trozos.map((t, i) =>
        t.coincide
          ? <mark key={i} className="rounded-sm bg-industrial-500/25 px-0 text-inherit">{t.texto}</mark>
          : <span key={i}>{t.texto}</span>)}
    </>
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
  const [doc, setDoc] = useState<{ id: string; fullNumber: string; status: string; isTrial: boolean } | null>(null)
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
      setDoc({ id: d.id, fullNumber: d.fullNumber, status: d.status, isTrial: d.isTrial === true })
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
          {doc.isTrial ? (
            <p className="text-sm text-ink">
              Documento de <b>prueba</b> <span className="font-mono font-bold">{doc.fullNumber}</span>.{' '}
              <span className="font-semibold">Sin valor tributario:</span> no es una boleta ni una factura y no se envía a SUNAT.
            </p>
          ) : (
            <p className="text-sm text-ink">
              Comprobante <span className="font-mono font-bold">{doc.fullNumber}</span>{' '}
              — estado <span className="font-semibold">{doc.status}</span>
            </p>
          )}
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
