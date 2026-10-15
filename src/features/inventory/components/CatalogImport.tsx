'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  analyzeCatalogImport,
  commitCatalogImport,
} from '../actions'
import type { AnalisisImport, FilaAnalizada } from '../import-service'
import { formatQuantity, unitLabel } from '@/lib/quantity'

const EJEMPLO = `Nombre;Código de barras;Unidad;P. Venta;Costo;Stock;Mínimo
Cemento Sol 42.5 kg;7751234567890;bls;32,50;28,00;120;20
Clavo 3" a granel;;kg;8,50;6,20;45,5;5
Cable THW 14 AWG;;m;4,20;3,10;200;25`

/**
 * Importación de catálogo en dos pasos: revisar y confirmar.
 *
 * ─── POR QUÉ LA VISTA PREVIA NO ES OPCIONAL ──────────────────────────────
 *
 * El archivo viene de un Excel que lleva años pasando de mano en mano:
 * precios en blanco, unidades inventadas, SKU repetidos. Escribir primero y
 * avisar después dejaría el catálogo a medio cargar sin forma de saber qué
 * entró.
 *
 * La tabla muestra el valor YA INTERPRETADO, no el del archivo. Es lo que
 * permite detectar la ambigüedad de "1.200": si el ferretero ve S/ 1.20
 * donde esperaba S/ 1200, lo corrige antes de que exista el producto.
 */
export function CatalogImport({ warehouseId }: { warehouseId: string }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [contenido, setContenido] = useState('')
  const [nombreArchivo, setNombreArchivo] = useState<string | null>(null)
  const [analisis, setAnalisis] = useState<AnalisisImport | null>(null)
  const [resultado, setResultado] = useState<{ creados: number; actualizados: number; omitidos: number } | null>(null)
  const [soloProblemas, setSoloProblemas] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const leerArchivo = async (file: File) => {
    setError(null)
    setAnalisis(null)
    setResultado(null)
    setNombreArchivo(file.name)
    // Se lee como texto en el navegador: el servidor recibe una cadena y no
    // hace falta un endpoint multipart para unos pocos megas.
    const texto = await file.text()
    setContenido(texto)
    analizar(texto)
  }

  const analizar = (texto: string) => {
    setError(null)
    startTransition(async () => {
      const res = await analyzeCatalogImport(texto)
      if (!res.ok) { setError(res.message); return }
      setAnalisis(res.data)
    })
  }

  const confirmar = () => {
    if (!analisis) return
    setError(null)
    startTransition(async () => {
      const res = await commitCatalogImport(analisis, warehouseId)
      if (!res.ok) { setError(res.message); return }
      setResultado(res.data)
      setAnalisis(null)
      setContenido('')
      setNombreArchivo(null)
      router.refresh()
    })
  }

  const filasVisibles = analisis
    ? soloProblemas
      ? analisis.filas.filter((f) => f.errores.length > 0 || f.avisos.length > 0)
      : analisis.filas
    : []

  return (
    <div className="flex flex-col gap-5">
      {/* ───────── Resultado ───────── */}
      {resultado && (
        <div className="rounded-2xl border-2 border-stock-ok bg-stock-ok-soft p-4">
          <p className="font-bold text-stock-ok">Catálogo importado</p>
          <ul className="mt-2 flex flex-col gap-0.5 text-sm text-ink">
            <li>{resultado.creados} producto{resultado.creados === 1 ? '' : 's'} nuevo{resultado.creados === 1 ? '' : 's'}</li>
            <li>{resultado.actualizados} actualizado{resultado.actualizados === 1 ? '' : 's'}</li>
            {resultado.omitidos > 0 && (
              <li className="font-semibold text-stock-out">
                {resultado.omitidos} omitido{resultado.omitidos === 1 ? '' : 's'} por errores
              </li>
            )}
          </ul>
          <p className="mt-2 text-xs text-ink-muted">
            Puedes volver a lanzar el mismo archivo: el emparejamiento es por
            código de barras o SKU, así que no se duplica nada.
          </p>
        </div>
      )}

      {/* ───────── Carga ───────── */}
      {!analisis && (
        <section className="rounded-2xl border border-hairline bg-surface p-4">
          <h2 className="font-bold text-ink">1. Sube tu archivo</h2>
          <p className="mt-1 text-sm text-ink-muted">
            CSV exportado de Excel. Se detecta solo si usa punto y coma o coma,
            y se aceptan precios con coma decimal.
          </p>

          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void leerArchivo(f)
            }}
            className="mt-3 block w-full cursor-pointer rounded-xl border border-hairline bg-surface-sunken p-3 text-sm text-ink file:mr-3 file:rounded-lg file:border-0 file:bg-industrial-600 file:px-4 file:py-2 file:text-sm file:font-bold file:text-white"
          />

          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-semibold text-industrial-700 dark:text-industrial-400">
              ¿Qué columnas necesita?
            </summary>
            <div className="mt-2 text-sm text-ink-muted">
              <p>
                Obligatorias: <strong className="text-ink">nombre</strong> y{' '}
                <strong className="text-ink">precio</strong>. Opcionales: código
                de barras, QR, unidad, costo, stock y mínimo.
              </p>
              <p className="mt-2">
                Los nombres de columna admiten variantes: «producto»,
                «descripción», «p. venta», «pvp», «existencias», «mínimo»…
              </p>
              <pre className="mt-2 overflow-x-auto rounded-xl bg-surface-sunken p-3 text-xs text-ink">
{EJEMPLO}
              </pre>
              <button
                type="button"
                onClick={() => { setNombreArchivo('ejemplo.csv'); setContenido(EJEMPLO); analizar(EJEMPLO) }}
                className="mt-2 h-touch rounded-xl border border-hairline px-4 text-sm font-semibold text-ink"
              >
                Probar con este ejemplo
              </button>
            </div>
          </details>
        </section>
      )}

      {error && (
        <p role="alert" className="rounded-xl border border-stock-out/40 bg-stock-out-soft px-4 py-3 text-sm font-semibold text-stock-out">
          {error}
        </p>
      )}

      {pending && !analisis && (
        <p className="animate-pulse text-sm text-ink-muted">Analizando el archivo…</p>
      )}

      {/* ───────── Vista previa ───────── */}
      {analisis && (
        <section className="flex flex-col gap-4">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-bold text-ink">2. Revisa antes de importar</h2>
              <p className="text-sm text-ink-muted">
                {nombreArchivo} · separador «{analisis.delimitador === '\t' ? 'tabulador' : analisis.delimitador}»
              </p>
            </div>
            <button
              type="button"
              onClick={() => { setAnalisis(null); setContenido(''); setNombreArchivo(null) }}
              className="h-touch rounded-xl border border-hairline px-4 text-sm font-semibold text-ink"
            >
              Cambiar archivo
            </button>
          </header>

          {analisis.bloqueos.length > 0 && (
            <ul className="flex flex-col gap-2">
              {analisis.bloqueos.map((b, i) => (
                <li key={i} role="alert" className="rounded-xl border border-stock-out/40 bg-stock-out-soft px-4 py-3 text-sm font-semibold text-stock-out">
                  {b}
                </li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-3 gap-3">
            <Resumen label="Nuevos" value={analisis.resumen.crear} tono="ok" />
            <Resumen label="Se actualizan" value={analisis.resumen.actualizar} tono="info" />
            <Resumen label="Con errores" value={analisis.resumen.error} tono="stop" />
          </div>

          {analisis.limitePlan.maxProducts !== null && (
            <p className={`rounded-xl px-4 py-2 text-sm ${
              analisis.limitePlan.excede
                ? 'bg-stock-out-soft font-semibold text-stock-out'
                : 'bg-surface-sunken text-ink-muted'
            }`}>
              Plan: {analisis.limitePlan.actuales} de {analisis.limitePlan.maxProducts} productos
              {' · '}este archivo crearía {analisis.limitePlan.seCrearian}
            </p>
          )}

          {analisis.columnasIgnoradas.length > 0 && (
            <p className="rounded-xl bg-stock-low-soft px-4 py-2 text-sm text-stock-low">
              <strong>Columnas no reconocidas</strong> (se ignoran):{' '}
              {analisis.columnasIgnoradas.join(', ')}
            </p>
          )}

          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={soloProblemas}
              onChange={(e) => setSoloProblemas(e.target.checked)}
              className="size-5 accent-industrial-600"
            />
            Ver solo las filas con errores o avisos
          </label>

          <div className="overflow-hidden rounded-2xl border border-hairline bg-surface">
            <div className="max-h-[32rem] overflow-auto">
              <table className="w-full min-w-[50rem] text-sm">
                <thead className="sticky top-0 bg-surface-sunken text-left text-ink-muted">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Línea</th>
                    <th className="px-3 py-2 font-semibold">Producto</th>
                    <th className="px-3 py-2 font-semibold">Códigos</th>
                    <th className="px-3 py-2 font-semibold">Precio</th>
                    <th className="px-3 py-2 font-semibold">Stock</th>
                    <th className="px-3 py-2 font-semibold">Qué pasará</th>
                  </tr>
                </thead>
                <tbody>
                  {filasVisibles.map((f) => <Fila key={f.linea} f={f} />)}
                  {filasVisibles.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-ink-muted">
                        Ninguna fila con problemas. Todo listo.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={confirmar}
              disabled={
                pending ||
                analisis.bloqueos.length > 0 ||
                analisis.resumen.crear + analisis.resumen.actualizar === 0
              }
              className="h-touch-xl flex-1 rounded-2xl bg-industrial-600 text-lg font-bold text-white disabled:opacity-40"
            >
              {pending
                ? 'Importando…'
                : `Importar ${analisis.resumen.crear + analisis.resumen.actualizar} producto${
                    analisis.resumen.crear + analisis.resumen.actualizar === 1 ? '' : 's'
                  }`}
            </button>
          </div>

          {analisis.resumen.error > 0 && (
            <p className="text-sm text-ink-muted">
              Las {analisis.resumen.error} filas con errores se omiten. Puedes
              corregirlas en el Excel y volver a subir el archivo: lo que ya
              entró no se duplica.
            </p>
          )}
        </section>
      )}
    </div>
  )
}

function Fila({ f }: { f: FilaAnalizada }) {
  const malo = f.errores.length > 0
  return (
    <tr className={`border-t border-hairline align-top ${malo ? 'bg-stock-out-soft/40' : ''}`}>
      <td className="px-3 py-2 font-mono text-xs text-ink-muted">{f.linea}</td>
      <td className="px-3 py-2">
        <p className="font-semibold text-ink">{f.datos.name || <em className="text-stock-out">sin nombre</em>}</p>
        <p className="text-xs text-ink-muted">{unitLabel(f.datos.unitType)}</p>
      </td>
      <td className="px-3 py-2 font-mono text-xs text-ink-muted">
        {f.datos.barcode && <p>EAN {f.datos.barcode}</p>}
        {f.datos.sku && <p>SKU {f.datos.sku}</p>}
        {f.datos.qrCode && <p>QR {f.datos.qrCode}</p>}
        {!f.datos.barcode && !f.datos.sku && !f.datos.qrCode && <p>—</p>}
      </td>
      <td className="px-3 py-2">
        {/* El valor INTERPRETADO, no el del archivo: así se detecta si
            "1.200" se leyó como 1.20 cuando debía ser 1200. */}
        <p className="font-bold text-ink">S/ {f.datos.salePrice.toFixed(2)}</p>
        {f.datos.costPrice > 0 && (
          <p className="text-xs text-ink-muted">costo {f.datos.costPrice.toFixed(2)}</p>
        )}
      </td>
      <td className="px-3 py-2 text-ink">
        {formatQuantity(f.datos.stock, f.datos.unitType)}
        {f.datos.minStock > 0 && (
          <span className="block text-xs text-ink-muted">
            mín {formatQuantity(f.datos.minStock, f.datos.unitType)}
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        {f.estado === 'crear' && (
          <span className="rounded-full bg-stock-ok-soft px-2 py-1 text-xs font-bold text-stock-ok">Nuevo</span>
        )}
        {f.estado === 'actualizar' && (
          <span className="rounded-full bg-industrial-100 px-2 py-1 text-xs font-bold text-industrial-800 dark:bg-industrial-950 dark:text-industrial-300">
            Actualiza (por{' '}
            {f.coincidePor === 'barcode' ? 'código de barras'
              : f.coincidePor === 'sku' ? 'SKU'
              : 'nombre'})
          </span>
        )}
        {f.estado === 'error' && (
          <span className="rounded-full bg-stock-out-soft px-2 py-1 text-xs font-bold text-stock-out">Se omite</span>
        )}
        {f.errores.map((e, i) => (
          <p key={i} className="mt-1 text-xs font-semibold text-stock-out">{e}</p>
        ))}
        {f.avisos.map((a, i) => (
          <p key={i} className="mt-1 text-xs text-stock-low">{a}</p>
        ))}
      </td>
    </tr>
  )
}

function Resumen({
  label, value, tono,
}: { label: string; value: number; tono: 'ok' | 'info' | 'stop' }) {
  const acento =
    tono === 'ok' ? 'text-stock-ok' : tono === 'stop' ? 'text-stock-out' : 'text-industrial-600'
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${acento}`}>{value}</p>
    </div>
  )
}
