'use client'

import { useEffect } from 'react'

/**
 * Registra /sw.js (caché estricta de estáticos: ver el propio archivo). Solo en producción: en desarrollo un worker
 * cacheando JS ocultaría los cambios y haría perder tiempo. Si el navegador no lo soporta o falla, la app funciona igual.
 */
export function RegistrarServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
  }, [])
  return null
}
