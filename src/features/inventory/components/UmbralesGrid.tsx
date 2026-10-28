'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { formatQuantity, limitarDecimales, parseQuantity, unitLabel } from '@/lib/quantity'
import { guardarUmbralesAccion } from '../reposicion-actions'
import type { FilaUmbral } from '../umbrales-service'
import type { CambioUmbralInput } from '../umbrales-schemas'

const ORIGEN = { ALMACEN: 'este almacén', VARIANTE: 'la variante', PRODUCTO: 'el producto' } as const
const clave = (f: Pick<FilaUmbral, 'productId' | 'variantId'>) => `${f.productId}:${f.variantId ?? '-'}`
const aTexto = (n: number | null) => (n === null ? '' : String(n))

type Borrador = { min: string; max: string }

/** Una celda vacía = «hereda». Devuelve `undefined` si no cambió, `null` si se quitó, o el número; `'error'` si no se entiende. */
function leer(texto: string, original: number | null): number | null | undefined | 'error' {
  const t = texto.trim()
  if (t === '') return original === null ? undefined : null
  const n = parseQuantity(t)
  if (n === null) return 'error'
  return n === original ? undefined : n
}

/**
 * Cuadrícula de mínimos y máximos por almacén (F6.6b). Cada fila es una fila de stock del almacén elegido; lo que se escribe es el valor PROPIO de ese almacén y, vacío, hereda
 * (el gris muestra lo que rige hoy y de dónde viene). Guarda en bloque solo las filas que cambiaron. Requiere `reposicion.configurar`; el servidor lo vuelve a comprobar.
 */
export function UmbralesGrid({ filas }: { filas: FilaUmbral[] }) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [borr, setBorr] = useState<Record<string, Borrador>>({})
  const [error, setError] = useState<string | null>(null)
  const [hecho, setHecho] = useState<string | null>(null)
  const [pendiente, startTransition] = useTransition()

  const valor = (f: FilaUmbral): Borrador => borr[clave(f)] ?? { min: aTexto(f.almacenMin), max: aTexto(f.almacenMax) }
  const poner = (f: FilaUmbral, parte: Partial<Borrador>) => { setHecho(null); setBorr((b) => ({ ...b, [clave(f)]: { ...valor(f), ...parte } })) }

  const cambios = useMemo(() => {
    const out: { fila: FilaUmbral; cambio: CambioUmbralInput | null; error: string | null }[] = []
    for (const f of filas) {
      const b = borr[clave(f)]
      if (!b) continue
      const min = leer(b.min, f.almacenMin)
      const max = leer(b.max, f.almacenMax)
      if (min === 'error' || max === 'error') { out.push({ fila: f, cambio: null, error: 'Escribe un número.' }); continue }
      if (min === undefined && max === undefined) continue
      const nuevoMin = min === undefined ? f.almacenMin : min
      const nuevoMax = max === undefined ? f.almacenMax : max
      if (nuevoMin !== null && nuevoMax !== null && nuevoMax < nuevoMin) { out.push({ fila: f, cambio: null, error: 'El máximo no puede ser menor que el mínimo.' }); continue }
      out.push({ fila: f, error: null, cambio: { nivel: 'ALMACEN', productId: f.productId, variantId: f.variantId, warehouseId: f.warehouseId, minimo: min, maximo: max } })
    }
    return out
  }, [borr, filas])

  const conError = cambios.filter((c) => c.error)
  const validos = cambios.filter((c) => c.cambio).map((c) => c.cambio!)

  const guardar = () => {
    setError(null); setHecho(null)
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    if (conError.length > 0) { setError('Corrige las filas marcadas antes de guardar.'); return }
    startTransition(async () => {
      const r = await guardarUmbralesAccion({ cambios: validos })
      if (!r.ok) { setError(r.message); return }
      setBorr({})
      setHecho(`${r.data.aplicados} ${r.data.aplicados === 1 ? 'fila guardada' : 'filas guardadas'}.`)
      router.refresh()
    })
  }

  if (filas.length === 0) return <p data-umbrales="vacio" className="rounded-2xl border border-hairline bg-surface p-4 text-sm text-ink-muted">No hay productos con existencias registradas en este almacén.</p>

  return (
    <section data-umbrales="grid" className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              <th scope="col" className="px-3 py-2">Producto</th>
              <th scope="col" className="px-2 py-2 text-right">Hay</th>
              <th scope="col" className="px-2 py-2">Mínimo</th>
              <th scope="col" className="px-2 py-2">Máximo</th>
              <th scope="col" className="px-3 py-2">Rige hoy</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => {
              const v = valor(f)
              const malo = conError.find((c) => clave(c.fila) === clave(f))
              return (
                <tr key={clave(f)} data-fila={clave(f)} className="border-t border-hairline align-top">
                  <td className="px-3 py-2">
                    <span className="block font-semibold text-ink">{f.nombre}</span>
                    <span className="block font-mono text-xs text-ink-muted">{f.sku} · {unitLabel(f.unitType)}</span>
                    {malo && <span role="alert" className="block text-xs font-semibold text-stock-out">{malo.error}</span>}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatQuantity(f.cantidad, f.unitType)}</td>
                  <td className="px-2 py-2">
                    <input data-campo="min" inputMode="decimal" aria-label={`Mínimo de ${f.nombre}`} value={v.min} placeholder={formatQuantity(f.minimo, f.unitType)}
                      onChange={(e) => poner(f, { min: limitarDecimales(e.target.value) })} className="h-touch w-24 rounded-xl border border-hairline bg-surface px-2 text-base text-ink" />
                  </td>
                  <td className="px-2 py-2">
                    <input data-campo="max" inputMode="decimal" aria-label={`Máximo de ${f.nombre}`} value={v.max} placeholder={f.maximo === null ? '—' : formatQuantity(f.maximo, f.unitType)}
                      onChange={(e) => poner(f, { max: limitarDecimales(e.target.value) })} className="h-touch w-24 rounded-xl border border-hairline bg-surface px-2 text-base text-ink" />
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-muted">
                    mín {formatQuantity(f.minimo, f.unitType)} <span>({ORIGEN[f.origenMinimo]})</span>
                    <br />
                    {f.maximo === null ? 'sin máximo (objetivo 2 × mín)' : <>máx {formatQuantity(f.maximo, f.unitType)} <span>({ORIGEN[f.origenMaximo!]})</span></>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="sticky bottom-2 flex flex-wrap items-center gap-3 rounded-2xl border border-hairline bg-surface p-3 shadow-sm">
        <button type="button" data-umbrales="guardar" disabled={pendiente || validos.length === 0 || conError.length > 0} onClick={guardar}
          className="h-touch rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white disabled:opacity-50">
          {pendiente ? 'Guardando…' : `Guardar ${validos.length || ''} ${validos.length === 1 ? 'cambio' : 'cambios'}`.replace('  ', ' ')}
        </button>
        {cambios.length > 0 && <button type="button" onClick={() => { setBorr({}); setError(null) }} className="text-sm font-semibold text-ink-muted">Descartar</button>}
        {hecho && <p role="status" className="text-sm font-semibold text-stock-ok">{hecho}</p>}
        {error && <p role="alert" className="text-sm font-semibold text-stock-out">{error}</p>}
      </div>
    </section>
  )
}
