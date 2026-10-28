'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { analizarUmbralesCsvAccion, guardarUmbralesAccion } from '../reposicion-actions'
import type { AnalisisUmbralesCsv } from '../umbrales-service'

/**
 * Importar mínimos y máximos por CSV (F6.6b): `sku`, `almacen` (opcional), `minimo`, `maximo`. Primero se ANALIZA (no escribe nada) y se enseña qué pasaría; solo si no hay
 * errores se ofrece aplicar. Celda vacía = no tocar; «-» = quitar el valor propio.
 */
export function UmbralesImport() {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [analisis, setAnalisis] = useState<AnalisisUmbralesCsv | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hecho, setHecho] = useState<string | null>(null)
  const [pendiente, startTransition] = useTransition()

  const leer = async (archivo: File | undefined) => {
    setError(null); setHecho(null); setAnalisis(null)
    if (!archivo) return
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    const contenido = await archivo.text()
    startTransition(async () => {
      const r = await analizarUmbralesCsvAccion({ contenido })
      if (!r.ok) { setError(r.message); return }
      setAnalisis(r.data)
    })
  }

  const aplicar = () => {
    if (!analisis || analisis.cambios.length === 0) return
    setError(null)
    startTransition(async () => {
      const r = await guardarUmbralesAccion({ cambios: analisis.cambios })
      if (!r.ok) { setError(r.message); return }
      setHecho(`${r.data.aplicados} aplicados, ${r.data.sinCambio} ya estaban así.`)
      setAnalisis(null)
      router.refresh()
    })
  }

  return (
    <section data-umbrales="importar" className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4">
      <h2 className="font-bold text-ink">Importar desde un archivo CSV</h2>
      <p className="text-sm text-ink-muted">
        Columnas: <b>sku</b> (de un producto o de una variante), <b>almacen</b> (código o nombre; vacío = el valor predeterminado del producto), <b>minimo</b> y <b>maximo</b>.
        Una celda vacía no cambia nada; un guion («-») quita el valor propio y vuelve a heredar.
      </p>
      <input type="file" accept=".csv,text/csv" aria-label="Archivo CSV de mínimos y máximos" disabled={pendiente} onChange={(e) => void leer(e.target.files?.[0])} className="text-sm" />
      {analisis && analisis.bloqueos.length > 0 && <ul role="alert" className="list-disc pl-5 text-sm font-semibold text-stock-out">{analisis.bloqueos.map((b) => <li key={b}>{b}</li>)}</ul>}
      {analisis && analisis.bloqueos.length === 0 && (
        <div data-umbrales="analisis" className="flex flex-col gap-2">
          <p className="text-sm text-ink">{analisis.resumen.total} filas: <b>{analisis.resumen.ok}</b> listas, <b className={analisis.resumen.error > 0 ? 'text-stock-out' : ''}>{analisis.resumen.error}</b> con errores.</p>
          {analisis.resumen.error > 0 && (
            <ul className="max-h-48 list-disc overflow-auto pl-5 text-sm text-stock-out">
              {analisis.filas.filter((f) => f.estado === 'error').slice(0, 50).map((f) => <li key={f.linea}>Línea {f.linea}: {f.errores.join(' ')}</li>)}
            </ul>
          )}
          {analisis.resumen.error > 0
            ? <p className="text-xs text-ink-muted">Corrige el archivo y vuelve a subirlo: no se aplica nada mientras haya errores.</p>
            : <button type="button" data-umbrales="aplicar" disabled={pendiente} onClick={aplicar} className="h-touch self-start rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-50">{pendiente ? 'Aplicando…' : `Aplicar ${analisis.cambios.length} cambios`}</button>}
        </div>
      )}
      {hecho && <p role="status" className="text-sm font-semibold text-stock-ok">{hecho}</p>}
      {error && <p role="alert" className="text-sm font-semibold text-stock-out">{error}</p>}
    </section>
  )
}
