'use client'

import { useEffect, useRef } from 'react'

/**
 * Acciones de la vista de impresión. Solo existe en pantalla.
 *
 * Con `auto`, abre el diálogo de impresión en cuanto la página está lista:
 * el flujo desde el POS es un clic, no dos. Se espera a
 * `document.fonts.ready` porque imprimir antes de que la tipografía esté
 * resuelta produce un ticket con métricas de la fuente de reemplazo, y en
 * 72 mm de ancho eso desalinea la columna de importes.
 */
export function BarraImpresion({
  auto,
  volverA,
}: {
  auto: boolean
  volverA: string
}) {
  const yaImprimio = useRef(false)

  useEffect(() => {
    if (!auto || yaImprimio.current) return
    // En desarrollo React monta dos veces; sin esta guarda saldrían dos
    // diálogos de impresión encadenados.
    yaImprimio.current = true

    let cancelado = false
    const lanzar = () => {
      if (!cancelado) window.print()
    }

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => requestAnimationFrame(lanzar))
    } else {
      requestAnimationFrame(lanzar)
    }

    return () => { cancelado = true }
  }, [auto])

  const cerrar = () => {
    /*
     * `window.close()` solo cierra pestañas que abrió un script; una abierta
     * con target="_blank" desde un enlace la ignora. Y `history.back()` no
     * sirve de reserva: en una pestaña nueva no hay historial al que volver.
     * De ahí el destino explícito.
     */
    window.close()
    setTimeout(() => {
      if (!window.closed) window.location.href = volverA
    }, 150)
  }

  return (
    <div className="ticket-acciones no-imprimir">
      <button type="button" className="primario" onClick={() => window.print()}>
        Imprimir
      </button>
      <button type="button" onClick={cerrar}>
        Cerrar
      </button>
    </div>
  )
}
