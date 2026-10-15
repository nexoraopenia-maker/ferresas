'use client'

import { useEffect } from 'react'

/**
 * Atajos de teclado del POS.
 *
 * ─── UNA ADVERTENCIA SOBRE F12 ───────────────────────────────────────────
 *
 * F12 abre las herramientas de desarrollo y es un atajo del NAVEGADOR, no de
 * la página: `preventDefault()` no lo detiene en Chrome ni en Edge. Se
 * registra porque funciona en Firefox y en modo kiosco, pero NO se puede
 * prometer.
 *
 * Por eso se añade F9 y Ctrl+Enter para lo mismo. Son atajos que ningún
 * navegador reclama, así que funcionan siempre — y si el cajero se acostumbra
 * a uno de esos, no depende de qué navegador le toque.
 *
 * Los atajos se ignoran mientras se escribe en un campo, salvo los
 * explícitos de función: si no, teclear "F2" en el buscador de nombre
 * reenfocaría el buscador y se perdería la letra.
 */
export interface PosShortcuts {
  onBuscar: () => void
  onCobrar: () => void
  onEscanear: () => void
  onCotizar: () => void
}

function escribiendo(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function usePosShortcuts(h: PosShortcuts) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F2: enfoca el buscador. Funciona incluso escribiendo, porque es
      // justo el atajo que el cajero usa para volver al buscador.
      if (e.key === 'F2') {
        e.preventDefault()
        h.onBuscar()
        return
      }

      // F4: abre la cámara.
      if (e.key === 'F4') {
        e.preventDefault()
        h.onEscanear()
        return
      }

      // Cobrar: F12 (puede no llegar), F9 y Ctrl/Cmd+Enter.
      if (e.key === 'F12' || e.key === 'F9') {
        e.preventDefault()
        h.onCobrar()
        return
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        h.onCobrar()
        return
      }

      // Cotizar: Ctrl/Cmd+G. No se usa F-algo para no chocar con el
      // navegador en una acción menos frecuente.
      if (e.key.toLowerCase() === 'g' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        h.onCotizar()
        return
      }

      // Lo demás no se intercepta mientras se escribe.
      if (escribiendo(e.target)) return
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [h])
}

/** Para mostrarlos en la interfaz: el atajo que nadie descubre no existe. */
export const ATAJOS_VISIBLES = [
  { teclas: 'F2', accion: 'Buscar producto' },
  { teclas: 'F4', accion: 'Escanear' },
  { teclas: 'F9', accion: 'Cobrar' },
  { teclas: 'Ctrl+G', accion: 'Cotizar' },
] as const
