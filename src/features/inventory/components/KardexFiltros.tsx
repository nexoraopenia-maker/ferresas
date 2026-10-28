import type { FiltrosKardexUrl } from '../kardex-enlaces'

/**
 * Buscador de producto y filtros del kardex (F6.4c). Formularios GET sin JavaScript: la dirección lleva todo (producto, almacén, variante y fechas), así que
 * se pueden compartir, volver atrás y paginar sin perder nada.
 */

export function BuscadorProducto({ q }: { q?: string }) {
  return (
    <form method="get" action="/inventario/kardex" role="search" data-kardex="buscador" className="flex gap-2">
      <input
        type="search" name="q" defaultValue={q ?? ''} placeholder="Nombre, SKU o código de barras" aria-label="Buscar producto"
        className="h-touch min-w-0 flex-1 rounded-xl border border-hairline bg-surface px-3 text-base text-ink"
      />
      <button type="submit" className="h-touch shrink-0 rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white">Buscar</button>
    </form>
  )
}

export function FiltrosKardex({ filtros, almacenes, variantes, desde, hasta }: {
  filtros: FiltrosKardexUrl
  almacenes: { id: string; nombre: string }[]
  variantes: { id: string; nombre: string }[]
  desde: string
  hasta: string
}) {
  return (
    <form method="get" action="/inventario/kardex" data-kardex="filtros" className="grid grid-cols-2 gap-3 rounded-2xl border border-hairline bg-surface p-4 sm:grid-cols-4">
      <input type="hidden" name="producto" value={filtros.producto ?? ''} />
      <label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
        <span className="text-xs font-medium text-ink-muted">Almacén</span>
        <select name="almacen" defaultValue={filtros.almacen ?? ''} className="h-touch rounded-xl border border-hairline bg-surface px-2 text-base text-ink">
          <option value="">Todos mis almacenes</option>
          {almacenes.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </label>
      {variantes.length > 0 && (
        <label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
          <span className="text-xs font-medium text-ink-muted">Variante</span>
          <select name="variante" defaultValue={filtros.variante ?? ''} className="h-touch rounded-xl border border-hairline bg-surface px-2 text-base text-ink">
            <option value="">Todas las variantes</option>
            {variantes.map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink-muted">Desde</span>
        <input type="date" name="desde" defaultValue={desde} className="h-touch rounded-xl border border-hairline bg-surface px-2 text-base text-ink" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink-muted">Hasta</span>
        <input type="date" name="hasta" defaultValue={hasta} className="h-touch rounded-xl border border-hairline bg-surface px-2 text-base text-ink" />
      </label>
      <div className="col-span-2 flex items-center justify-between gap-3 sm:col-span-4">
        <a data-kardex="ultimos-30" href={`/inventario/kardex?producto=${encodeURIComponent(filtros.producto ?? '')}${filtros.almacen ? `&almacen=${encodeURIComponent(filtros.almacen)}` : ''}${filtros.variante ? `&variante=${encodeURIComponent(filtros.variante)}` : ''}`} className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">
          Últimos 30 días
        </a>
        <button type="submit" className="h-touch rounded-xl bg-industrial-600 px-5 text-sm font-bold text-white">Ver kardex</button>
      </div>
    </form>
  )
}
