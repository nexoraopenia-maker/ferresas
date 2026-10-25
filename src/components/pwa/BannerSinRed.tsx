'use client'

import { useEnLinea } from '@/lib/en-linea'

/** Franja fija y visible en TODA pantalla mientras no hay red. Sin red no se cobra ni se mueve stock. */
export function BannerSinRed() {
  const enLinea = useEnLinea()
  return enLinea ? null : <AvisoSinRed />
}

/** La franja en sí (separada para poder renderizarla y probarla sin depender del estado del navegador). */
export function AvisoSinRed() {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2 bg-stock-out px-4 py-2 text-center text-sm font-bold text-white"
      style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
    >
      <span aria-hidden="true">⚠</span>
      Sin red / Offline — el cobro y los movimientos de stock están bloqueados hasta que vuelva la conexión.
    </div>
  )
}
