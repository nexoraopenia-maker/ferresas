import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { listarUmbrales } from '@/features/inventory/umbrales-service'
import { UmbralesGrid } from '@/features/inventory/components/UmbralesGrid'
import { UmbralesImport } from '@/features/inventory/components/UmbralesImport'

export const dynamic = 'force-dynamic'

/** Mínimos y máximos de reposición por almacén (F6.6b). Solo `reposicion.configurar` (fuera del PIN); el servicio lo vuelve a comprobar en cada lectura y escritura. */
export default async function UmbralesPage({ searchParams }: { searchParams: Promise<{ almacen?: string; q?: string; pagina?: string }> }) {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'reposicion.configurar')) notFound()
  const db = getTenantPrisma(ctx)
  const sp = await searchParams
  const pagina = Math.max(0, Math.min(10_000, Number.parseInt(sp.pagina ?? '0', 10) || 0))
  const datos = await listarUmbrales(db, ctx, { warehouseId: sp.almacen, q: sp.q, pagina })
  const enlace = (p: number) => `/inventario/reposicion/umbrales?${new URLSearchParams({ ...(datos.warehouseId ? { almacen: datos.warehouseId } : {}), ...(sp.q ? { q: sp.q } : {}), pagina: String(p) })}`

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Mínimos y máximos</h1>
          <p className="text-sm text-ink-muted">Cuándo avisar y hasta dónde reponer, por almacén. Lo que dejes vacío hereda de la variante o del producto.</p>
        </div>
        <Link href="/inventario/reposicion" className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">← Reposición</Link>
      </header>

      <form method="get" data-umbrales="filtros" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Almacén
          <select name="almacen" defaultValue={datos.warehouseId ?? ''} className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base">
            {datos.almacenes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Buscar
          <input name="q" defaultValue={sp.q ?? ''} placeholder="Nombre, SKU o código" className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base" />
        </label>
        <button type="submit" className="h-touch rounded-xl border border-hairline px-4 text-sm font-semibold text-ink">Filtrar</button>
      </form>

      <p className="text-xs text-ink-muted">{datos.total} {datos.total === 1 ? 'fila' : 'filas'}{datos.paginas > 1 ? ` · página ${datos.pagina + 1} de ${datos.paginas}` : ''}. Guardar solo envía lo que cambiaste en esta página.</p>
      <UmbralesGrid key={`${datos.warehouseId}:${datos.pagina}:${sp.q ?? ''}`} filas={datos.filas} />

      {datos.paginas > 1 && (
        <nav data-umbrales="paginas" aria-label="Páginas" className="flex items-center justify-between text-sm font-semibold">
          {datos.pagina > 0 ? <a href={enlace(datos.pagina - 1)} className="text-industrial-700 dark:text-industrial-300">← Anterior</a> : <span />}
          {datos.pagina + 1 < datos.paginas ? <a href={enlace(datos.pagina + 1)} className="text-industrial-700 dark:text-industrial-300">Siguiente →</a> : <span />}
        </nav>
      )}

      <UmbralesImport />
    </main>
  )
}
