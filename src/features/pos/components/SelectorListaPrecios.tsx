'use client'

/**
 * La lista de precios del carrito (F6.7c): «Base (minorista)» y las listas activas del negocio. Elegir otra recalcula el carrito con el motor compartido. Se muestra solo si el negocio
 * tiene listas. Todos los que venden ven todas las listas (el cajero puede cotizar a distintos clientes); los costos nunca llegan aquí.
 */
export function SelectorListaPrecios({
  listas, valor, onChange, deshabilitado = false, nota = null,
}: { listas: { id: string; name: string }[]; valor: string | null; onChange: (id: string | null) => void; deshabilitado?: boolean; nota?: string | null }) {
  return (
    <label data-pos="lista-precios" className="flex flex-col gap-1 text-sm font-semibold text-ink">
      Lista de precios
      <select
        value={valor ?? ''} disabled={deshabilitado} aria-label="Lista de precios"
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base font-normal text-ink disabled:opacity-60"
      >
        <option value="">Base (minorista)</option>
        {listas.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
      {nota && <span data-pos="lista-nota" className="text-xs font-normal text-ink-muted">{nota}</span>}
    </label>
  )
}
