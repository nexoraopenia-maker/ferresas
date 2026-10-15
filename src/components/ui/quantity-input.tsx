'use client'

import { useEffect, useState } from 'react'
import {
  formatQuantity,
  isPartialQuantity,
  limitarDecimales,
  parseQuantity,
  redondear,
  stepFor,
  unitLabel,
} from '@/lib/quantity'

/**
 * Input de cantidad que admite decimales de verdad.
 *
 * ─── POR QUÉ NO ES type="number" ─────────────────────────────────────────
 *
 * `type="number"` parece lo obvio y estorba en tres frentes:
 *   · rechaza la coma según el locale del navegador, y en Perú se teclea
 *     "0,250" tan a menudo como "0.250";
 *   · las flechas y la rueda del ratón saltan de 1 en 1, inútil para kg;
 *   · su normalización pelea con el estado de cadena que necesitamos.
 *
 * `type="text"` con `inputMode="decimal"` da el teclado numérico en el móvil
 * —que es lo único que aportaba `number` en este caso— y control completo.
 *
 * ─── POR QUÉ EL ESTADO ES UNA CADENA ─────────────────────────────────────
 *
 * Guardar un `number` hacía imposible teclear "1.5": al pulsar el punto,
 * `Number("1.")` daba 1, el estado pasaba a 1 y el input se repintaba sin el
 * punto. Aquí la cadena vive mientras se edita y solo se convierte al
 * confirmar, así que "", "0." y "1," son estados intermedios legítimos.
 */
export function QuantityInput({
  value,
  onChange,
  unitType,
  min = 0,
  autoFocus,
  ariaLabel,
  className,
  showStepper = true,
}: {
  value: number
  onChange: (n: number) => void
  unitType: string
  min?: number
  autoFocus?: boolean
  ariaLabel: string
  className?: string
  showStepper?: boolean
}) {
  // Borrador local. Se sincroniza con `value` solo cuando el cambio viene de
  // FUERA (un botón de atajo), no mientras el usuario escribe: si no, cada
  // repintado le machacaría lo tecleado.
  const [borrador, setBorrador] = useState(() => formatQuantity(value, unitType))
  const [editando, setEditando] = useState(false)

  useEffect(() => {
    if (!editando) setBorrador(formatQuantity(value, unitType))
  }, [value, unitType, editando])

  const paso = stepFor(unitType)

  const escribir = (raw: string) => {
    if (!isPartialQuantity(raw)) return // no se acepta la tecla
    const recortado = limitarDecimales(raw)
    setBorrador(recortado)

    const n = parseQuantity(recortado)
    // Solo se propaga cuando ya es un número completo. Mientras sea "1." el
    // carrito conserva el último valor válido.
    if (n !== null) onChange(Math.max(n, min))
  }

  const confirmar = () => {
    setEditando(false)
    const n = parseQuantity(borrador)
    if (n === null) {
      // Campo vacío o solo un separador: se vuelve al mínimo en lugar de
      // dejar el carrito en un estado que no se puede cobrar.
      onChange(min)
      setBorrador(formatQuantity(min, unitType))
      return
    }
    const limpio = Math.max(redondear(n), min)
    onChange(limpio)
    setBorrador(formatQuantity(limpio, unitType))
  }

  const mover = (delta: number) => {
    const actual = parseQuantity(borrador) ?? value
    const siguiente = Math.max(redondear(actual + delta), min)
    onChange(siguiente)
    setBorrador(formatQuantity(siguiente, unitType))
  }

  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`}>
      {showStepper && (
        <button
          type="button"
          aria-label={`Quitar ${paso} ${unitLabel(unitType)}`}
          onClick={() => mover(-paso)}
          className="size-touch shrink-0 rounded-xl bg-surface-sunken text-2xl font-bold text-ink active:scale-95"
        >
          −
        </button>
      )}

      <div className="relative min-w-0 flex-1">
        <input
          type="text"
          inputMode="decimal"
          // Teclado numérico con separador en iOS, que ignora inputMode
          // para el punto en algunos teclados.
          pattern="[0-9]*[.,]?[0-9]*"
          autoComplete="off"
          value={borrador}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          onFocus={(e) => {
            setEditando(true)
            // Seleccionar todo al enfocar: en el mostrador se reemplaza la
            // cantidad entera, no se edita un dígito.
            e.currentTarget.select()
          }}
          onChange={(e) => escribir(e.target.value)}
          onBlur={confirmar}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              confirmar()
              e.currentTarget.blur()
            }
            // Las flechas mueven según la unidad, no de 1 en 1.
            if (e.key === 'ArrowUp') { e.preventDefault(); mover(paso) }
            if (e.key === 'ArrowDown') { e.preventDefault(); mover(-paso) }
          }}
          className="h-touch-lg w-full rounded-xl border border-hairline bg-surface pr-12 text-center text-xl font-bold text-ink focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-ink-muted">
          {unitLabel(unitType)}
        </span>
      </div>

      {showStepper && (
        <button
          type="button"
          aria-label={`Añadir ${paso} ${unitLabel(unitType)}`}
          onClick={() => mover(paso)}
          className="size-touch shrink-0 rounded-xl bg-surface-sunken text-2xl font-bold text-ink active:scale-95"
        >
          +
        </button>
      )}
    </div>
  )
}
