'use client'

import { useSyncExternalStore } from 'react'

/**
 * ¿Hay red? Para BLOQUEAR el cobro y los movimientos de stock cuando no la hay (PWA v1: sin escrituras sin conexión).
 *
 * `navigator.onLine` solo sabe si el equipo tiene ALGUNA conexión: con un wifi sin salida a internet dice `true`. Por eso
 * esto es la primera barrera (evita el toque inútil y avisa claro), no la única: el servidor sigue siendo quien decide, y
 * si la petición falla igual se muestra su error. En el servidor (render) se asume que sí hay red.
 */
export const MENSAJE_SIN_RED = 'Sin red: el cobro y los movimientos de stock necesitan conexión. Se habilitan solos al volver.'

function suscribir(avisar: () => void) {
  window.addEventListener('online', avisar)
  window.addEventListener('offline', avisar)
  return () => {
    window.removeEventListener('online', avisar)
    window.removeEventListener('offline', avisar)
  }
}

export function useEnLinea(): boolean {
  return useSyncExternalStore(suscribir, () => navigator.onLine, () => true)
}
