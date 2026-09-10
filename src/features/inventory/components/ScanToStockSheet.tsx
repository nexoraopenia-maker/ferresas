'use client'

import { useCallback, useRef, useState, useTransition } from 'react'
import { InventoryScannerModal } from '@/components/inventory/InventoryScannerModal'
import { getStockStatusView } from '@/lib/stock-status'
import {
  createProductExpress,
  createStockMovement,
  findProductByCode,
  getDefaultWarehouse,
} from '../actions'
import type { ScannedProduct } from '../actions'

/**
 * Flujo completo del escáner (§5.1): escanear → ver stock → mover → confirmar.
 *
 * El escáner (InventoryScannerModal) queda deliberadamente ignorante del
 * dominio: solo emite códigos. Este contenedor es quien conoce productos,
 * stock y Server Actions. Esa separación es la que permite reusar el mismo
 * escáner en el POS y en recepción de mercadería sin tocarlo.
 */

type MovementType = 'ENTRADA' | 'SALIDA' | 'AJUSTE'

type Phase =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'unknown'; code: string; warehouseId: string; warehouseName: string }
  | { kind: 'product'; product: ScannedProduct }

const TIPOS: { value: MovementType; label: string; verb: string }[] = [
  { value: 'ENTRADA', label: 'Entrada', verb: 'Sumar' },
  { value: 'SALIDA', label: 'Salida', verb: 'Restar' },
  { value: 'AJUSTE', label: 'Ajuste', verb: 'Fijar en' },
]

const ATAJOS = [1, 5, 10, 25]

export function ScanToStockSheet() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [type, setType] = useState<MovementType>('ENTRADA')
  const [qty, setQty] = useState(1)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  /**
   * Se genera UNA vez por intento de confirmación y se reutiliza si el
   * usuario reintenta tras un fallo de red. Es lo que impide que un doble
   * toque con mala señal registre el movimiento dos veces (§5.1).
   */
  const idemRef = useRef<string | null>(null)

  const reset = useCallback(() => {
    setPhase({ kind: 'idle' })
    setQty(1)
    setReason('')
    setError(null)
    idemRef.current = null
  }, [])

  // --- Escaneo -> búsqueda -------------------------------------------------
  // El escáner espera esta promesa antes de aceptar otra lectura, así que el
  // anti-rebote y la consulta al servidor están encadenados de verdad.
  const onDetected = useCallback(async (code: string) => {
    setError(null)
    const res = await findProductByCode({ code })

    if (!res.ok) {
      setError(res.message)
      setPhase({ kind: 'idle' })
      return
    }

    if (!res.data) {
      // El alta exprés necesita un almacén, y aquí todavía no hay producto
      // del que sacarlo.
      const w = await getDefaultWarehouse()
      if (!w.ok) {
        setError(w.message)
        setPhase({ kind: 'idle' })
        return
      }
      setPhase({
        kind: 'unknown',
        code,
        warehouseId: w.data.id,
        warehouseName: w.data.name,
      })
      return
    }

    setQty(res.data.status === 'OUT' ? 1 : 1)
    setType('ENTRADA')
    idemRef.current = crypto.randomUUID()
    setPhase({ kind: 'product', product: res.data })
  }, [])

  // --- Confirmación -> movimiento -----------------------------------------
  const confirmar = useCallback(() => {
    if (phase.kind !== 'product') return
    const p = phase.product
    setError(null)

    idemRef.current ??= crypto.randomUUID()

    startTransition(async () => {
      const res = await createStockMovement(
        type === 'AJUSTE'
          ? {
              type: 'AJUSTE',
              productId: p.productId,
              variantId: p.variantId,
              warehouseId: p.warehouseId,
              quantity: qty,
              reason,
              expectedVersion: p.version,
              idempotencyKey: idemRef.current ?? undefined,
              source: 'ESCANER',
            }
          : {
              type,
              productId: p.productId,
              variantId: p.variantId,
              warehouseId: p.warehouseId,
              quantity: qty,
              reason: reason.trim() || undefined,
              idempotencyKey: idemRef.current ?? undefined,
              source: 'ESCANER',
            },
      )

      if (!res.ok) {
        // Un conflicto de versión significa que el stock en pantalla es viejo:
        // se relee para que el operario decida sobre el número real.
        if (res.code === 'STOCK_CONFLICT') {
          const fresh = await findProductByCode({ code: p.barcode ?? p.sku })
          if (fresh.ok && fresh.data) setPhase({ kind: 'product', product: fresh.data })
        }
        setError(res.message)
        return
      }

      setToast(
        res.data.replayed
          ? 'Ya estaba registrado. Stock actual: ' + res.data.balanceAfter
          : `${p.name}: ${res.data.balanceAfter}` +
              (res.data.wentNegative ? ' (¡quedó en negativo!)' : ''),
      )
      idemRef.current = null
      reset()
    })
  }, [phase, type, qty, reason, reset])

  const activo = TIPOS.find((t) => t.value === type)!

  return (
    <div className="flex flex-col gap-4">
      {toast && (
        <div
          role="status"
          className="rounded-xl border border-stock-ok/30 bg-stock-ok-soft px-4 py-3 text-sm font-semibold text-stock-ok"
        >
          ✓ {toast}
        </div>
      )}

      {error && phase.kind !== 'product' && (
        <div
          role="alert"
          className="rounded-xl border border-stock-out/40 bg-stock-out-soft px-4 py-3 text-sm font-semibold text-stock-out"
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          setToast(null)
          setPhase({ kind: 'scanning' })
        }}
        className="h-touch-xl w-full rounded-2xl bg-industrial-600 text-lg font-bold text-white transition active:scale-95"
      >
        Escanear producto
      </button>

      <InventoryScannerModal
        open={phase.kind === 'scanning'}
        onClose={() => phase.kind === 'scanning' && setPhase({ kind: 'idle' })}
        onDetected={onDetected}
        // Se cierra tras la primera lectura: el siguiente paso es elegir la
        // cantidad, y mantener la cámara viva detrás gasta batería para nada.
        continuous={false}
        title="Escanear para mover stock"
      />

      {/* --- Código desconocido: alta exprés (§5.1) -------------------- */}
      {phase.kind === 'unknown' && (
        <ExpressProductForm
          code={phase.code}
          warehouseId={phase.warehouseId}
          warehouseName={phase.warehouseName}
          onCancel={reset}
          onCreated={(product, alreadyExisted) => {
            setToast(
              alreadyExisted
                ? `${product.name} ya estaba registrado. Continúa desde aquí.`
                : `${product.name} creado con ${product.quantity} ${product.unitType.toLowerCase()}.`,
            )
            // Se encadena directo al selector de cantidad: el operario no
            // sale del sheet ni tiene que volver a escanear (§5.1).
            setType('ENTRADA')
            setQty(1)
            setReason('')
            idemRef.current = crypto.randomUUID()
            setPhase({ kind: 'product', product })
          }}
        />
      )}

      {/* --- Producto encontrado: selector táctil ------------------------ */}
      {phase.kind === 'product' && (
        <ProductSheet
          product={phase.product}
          type={type}
          setType={setType}
          qty={qty}
          setQty={setQty}
          reason={reason}
          setReason={setReason}
          error={error}
          pending={pending}
          verb={activo.verb}
          onConfirm={confirmar}
          onCancel={reset}
        />
      )}
    </div>
  )
}

function ProductSheet({
  product,
  type,
  setType,
  qty,
  setQty,
  reason,
  setReason,
  error,
  pending,
  verb,
  onConfirm,
  onCancel,
}: {
  product: ScannedProduct
  type: MovementType
  setType: (t: MovementType) => void
  qty: number
  setQty: (n: number) => void
  reason: string
  setReason: (s: string) => void
  error: string | null
  pending: boolean
  verb: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const actual = getStockStatusView(product.quantity, product.minStock)

  // Previsualización del resultado: el operario ve a qué número va a quedar
  // ANTES de confirmar. Es lo que evita el ajuste equivocado.
  const resultado =
    type === 'AJUSTE'
      ? qty
      : type === 'SALIDA'
        ? product.quantity - qty
        : product.quantity + qty

  const previsto = getStockStatusView(resultado, product.minStock)
  const ajusteSinMotivo = type === 'AJUSTE' && reason.trim().length < 3

  return (
    <section className="rounded-2xl border border-hairline bg-surface-raised p-4">
      <header>
        <h2 className="text-lg font-bold text-ink">{product.name}</h2>
        <p className="text-sm text-ink-muted">
          {product.sku} · {product.warehouseName}
        </p>
      </header>

      <div className={`mt-3 flex items-center gap-2 rounded-xl border px-3 py-2 ${actual.className}`}>
        <span className={`size-3 rounded-full ${actual.dotClassName}`} />
        <span className="text-sm font-bold">
          {product.quantity} {product.unitType.toLowerCase()} · {actual.label}
        </span>
      </div>

      {/* Tipo de movimiento */}
      <div role="group" aria-label="Tipo de movimiento" className="mt-4 flex gap-2">
        {TIPOS.map((t) => (
          <button
            key={t.value}
            type="button"
            aria-pressed={type === t.value}
            onClick={() => setType(t.value)}
            className={`h-touch-lg flex-1 rounded-xl text-base font-bold transition active:scale-95 ${
              type === t.value
                ? 'bg-graphite-900 text-white'
                : 'border border-hairline bg-surface text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Selector táctil grande */}
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          aria-label="Quitar uno"
          onClick={() => setQty(Math.max(type === 'AJUSTE' ? 0 : 1, qty - 1))}
          className="size-touch-xl shrink-0 rounded-2xl bg-surface-sunken text-3xl font-bold text-ink active:scale-95"
        >
          −
        </button>
        <input
          type="number"
          inputMode="decimal"
          value={qty}
          min={type === 'AJUSTE' ? 0 : 1}
          onChange={(e) => setQty(Math.max(0, Number(e.target.value) || 0))}
          aria-label="Cantidad"
          className="h-touch-xl min-w-0 flex-1 rounded-2xl border border-hairline bg-surface text-center text-3xl font-bold text-ink focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
        />
        <button
          type="button"
          aria-label="Añadir uno"
          onClick={() => setQty(qty + 1)}
          className="size-touch-xl shrink-0 rounded-2xl bg-surface-sunken text-3xl font-bold text-ink active:scale-95"
        >
          +
        </button>
      </div>

      <div className="mt-2 flex gap-2">
        {ATAJOS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setQty(type === 'AJUSTE' ? n : qty + n)}
            className="h-touch flex-1 rounded-xl border border-hairline bg-surface text-base font-bold text-ink active:scale-95"
          >
            {type === 'AJUSTE' ? n : `+${n}`}
          </button>
        ))}
      </div>

      {type === 'AJUSTE' && (
        <div className="mt-4">
          <label htmlFor="motivo" className="text-sm font-medium text-ink-muted">
            Motivo del ajuste (queda auditado)
          </label>
          <input
            id="motivo"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Conteo físico, rotura, merma…"
            className="mt-1 h-touch-lg w-full rounded-xl border border-hairline bg-surface px-4 text-base text-ink placeholder:text-ink-muted focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
          />
        </div>
      )}

      <p className="mt-4 text-center text-sm text-ink-muted">
        {verb} {type === 'AJUSTE' ? '' : qty} → quedará en{' '}
        <span className={`font-bold ${resultado < 0 ? 'text-stock-out' : ''}`}>
          {resultado}
        </span>{' '}
        <span className="font-semibold">({previsto.label})</span>
      </p>

      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
          {error}
        </p>
      )}

      <div className="safe-bottom mt-4 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-touch-xl rounded-2xl border border-hairline px-6 font-semibold text-ink"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending || qty <= 0 || ajusteSinMotivo}
          className="h-touch-xl flex-1 rounded-2xl bg-industrial-600 text-lg font-bold text-white transition active:scale-95 disabled:opacity-40"
        >
          {pending ? 'Registrando…' : 'Confirmar'}
        </button>
      </div>
    </section>
  )
}

/**
 * Formulario exprés (§5.1): lo MÍNIMO para que el producto exista y tenga
 * stock. Nombre, precio, cuántos hay y su mínimo — nada más.
 *
 * El mínimo entra aquí, aunque el brief solo pedía tres campos, porque sin él
 * el semáforo nace siempre en verde y el producto recién creado no avisaría
 * nunca de quiebre. Es un campo con teclado numérico y valor por defecto: no
 * añade fricción real.
 *
 * Categoría, proveedor y costo se completan después desde el catálogo. Un
 * formulario largo en el pasillo, con guantes, se abandona — y un producto
 * sin registrar es peor que uno registrado a medias.
 */
function ExpressProductForm({
  code,
  warehouseId,
  warehouseName,
  onCreated,
  onCancel,
}: {
  code: string
  warehouseId: string
  warehouseName: string
  onCreated: (product: ScannedProduct, alreadyExisted: boolean) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [salePrice, setSalePrice] = useState('')
  const [initialStock, setInitialStock] = useState('0')
  const [minStock, setMinStock] = useState('5')
  const [unitType, setUnitType] = useState<UnitOption>('UNIDAD')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const idemRef = useRef<string | null>(null)

  const submit = () => {
    setError(null)
    setFieldErrors({})
    idemRef.current ??= crypto.randomUUID()

    startTransition(async () => {
      const res = await createProductExpress({
        barcode: code,
        name,
        salePrice: Number(salePrice) || 0,
        initialStock: Number(initialStock) || 0,
        minStock: Number(minStock) || 0,
        unitType,
        warehouseId,
        idempotencyKey: idemRef.current ?? undefined,
      })

      if (!res.ok) {
        if (res.code === 'VALIDATION') {
          setFieldErrors((res.details ?? {}) as Record<string, string[]>)
          setError(res.message)
        } else {
          setError(res.message)
        }
        return
      }

      idemRef.current = null
      const { alreadyExisted, ...product } = res.data
      onCreated(product, alreadyExisted)
    })
  }

  const err = (campo: string) => fieldErrors[campo]?.[0]

  return (
    <section className="rounded-2xl border border-hairline bg-surface-raised p-4">
      <header>
        <h2 className="text-lg font-bold text-ink">Producto nuevo</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Código <span className="font-mono font-semibold text-ink">{code}</span> ·{' '}
          {warehouseName}
        </p>
      </header>

      <div className="mt-4 flex flex-col gap-3">
        <Field label="Nombre" error={err('name')}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            autoComplete="off"
            placeholder="Ej. Cemento Sol 42.5 kg"
            className={inputClass(err('name'))}
          />
        </Field>

        <div className="flex gap-3">
          <Field label="Precio de venta" error={err('salePrice')} className="flex-1">
            <input
              value={salePrice}
              onChange={(e) => setSalePrice(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className={inputClass(err('salePrice'))}
            />
          </Field>
          <Field label="Unidad" className="flex-1">
            <select
              value={unitType}
              onChange={(e) => setUnitType(e.target.value as UnitOption)}
              className={inputClass(undefined)}
            >
              {UNIDADES.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="flex gap-3">
          <Field label="Stock inicial" error={err('initialStock')} className="flex-1">
            <input
              value={initialStock}
              onChange={(e) => setInitialStock(e.target.value)}
              inputMode="decimal"
              className={inputClass(err('initialStock'))}
            />
          </Field>
          <Field label="Avisar bajo" error={err('minStock')} className="flex-1">
            <input
              value={minStock}
              onChange={(e) => setMinStock(e.target.value)}
              inputMode="decimal"
              className={inputClass(err('minStock'))}
            />
          </Field>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out"
        >
          {error}
        </p>
      )}

      <div className="safe-bottom mt-4 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-touch-xl rounded-2xl border border-hairline px-6 font-semibold text-ink"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pending || name.trim().length < 2}
          className="h-touch-xl flex-1 rounded-2xl bg-industrial-600 text-lg font-bold text-white transition active:scale-95 disabled:opacity-40"
        >
          {pending ? 'Creando…' : 'Crear y continuar'}
        </button>
      </div>
    </section>
  )
}

type UnitOption =
  | 'UNIDAD' | 'KILOGRAMO' | 'METRO' | 'LITRO' | 'GALON' | 'CAJA'
  | 'PAQUETE' | 'DOCENA' | 'ROLLO' | 'PLANCHA' | 'BOLSA' | 'JUEGO' | 'PAR'

/** Las unidades que de verdad se usan en una ferretería, en ese orden. */
const UNIDADES: { value: UnitOption; label: string }[] = [
  { value: 'UNIDAD', label: 'Unidad' },
  { value: 'BOLSA', label: 'Bolsa' },
  { value: 'CAJA', label: 'Caja' },
  { value: 'METRO', label: 'Metro' },
  { value: 'KILOGRAMO', label: 'Kilo' },
  { value: 'GALON', label: 'Galón' },
  { value: 'LITRO', label: 'Litro' },
  { value: 'PLANCHA', label: 'Plancha' },
  { value: 'ROLLO', label: 'Rollo' },
  { value: 'PAQUETE', label: 'Paquete' },
  { value: 'DOCENA', label: 'Docena' },
  { value: 'JUEGO', label: 'Juego' },
  { value: 'PAR', label: 'Par' },
]

function inputClass(error?: string) {
  return [
    'h-touch-lg w-full rounded-xl border bg-surface px-4 text-base text-ink',
    'placeholder:text-ink-muted focus:outline-none focus:ring-2',
    error
      ? 'border-stock-out focus:border-stock-out focus:ring-stock-out/40'
      : 'border-hairline focus:border-industrial-600 focus:ring-industrial-600/40',
  ].join(' ')
}

function Field({
  label,
  error,
  className = '',
  children,
}: {
  label: string
  error?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-sm font-medium text-ink-muted">{label}</span>
      {children}
      {error && <span className="text-xs font-semibold text-stock-out">{error}</span>}
    </label>
  )
}
