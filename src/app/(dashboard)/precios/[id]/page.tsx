import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { listarListas, listarPrecios } from '@/features/precios/service'
import { PreciosGrid } from '@/features/precios/components/PreciosGrid'

export const dynamic = 'force-dynamic'

/**
 * Precios y tramos de una lista, o los tramos de la Base (`/precios/base`). Solo `precios.gestionar`. Un id que no existe o de otro negocio es un 404. El costo y el margen solo salen
 * del servicio si la persona además tiene `productos.ver_costo`.
 */
export default async function PreciosListaPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; pagina?: string }> }) {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'precios.gestionar')) notFound()
  const { id } = await params
  const sp = await searchParams
  const db = getTenantPrisma(ctx)
  const esBase = id === 'base'
  const lista = esBase ? null : (await listarListas(db, ctx)).find((l) => l.id === id.slice(0, 64))
  if (!esBase && !lista) notFound()

  const pagina = Math.max(0, Math.min(10_000, Number.parseInt(sp.pagina ?? '0', 10) || 0))
  const datos = await listarPrecios(db, ctx, { priceListId: esBase ? null : id.slice(0, 64), q: sp.q, pagina }).catch((e) => {
    if (isBusinessError(e) && e.code === 'NOT_FOUND') return null
    throw e
  })
  if (!datos) notFound()
  const enlace = (p: number) => `/precios/${id}?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), pagina: String(p) })}`

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">{esBase ? 'Tramos de la lista Base' : lista!.name}</h1>
          <p className="text-sm text-ink-muted">
            {esBase
              ? 'El precio Base de cada producto es su precio de venta. Aquí defines desde qué cantidad baja el precio unitario.'
              : 'Fija el precio de cada producto en esta lista y, si quieres, sus tramos de volumen. Lo que no definas se vende al precio Base. Los precios incluyen IGV.'}
          </p>
        </div>
        <Link href="/precios" className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">← Listas</Link>
      </header>

      <form method="get" data-precios="filtros" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Buscar
          <input name="q" defaultValue={sp.q ?? ''} placeholder="Nombre, SKU o código" className="h-touch rounded-xl border border-hairline bg-surface px-3 text-base font-normal text-ink" />
        </label>
        <button type="submit" className="h-touch rounded-xl border border-hairline px-4 text-sm font-semibold text-ink">Filtrar</button>
      </form>
      <p className="text-xs text-ink-muted">{datos.total} {datos.total === 1 ? 'producto' : 'productos'}{datos.paginas > 1 ? ` · página ${datos.pagina + 1} de ${datos.paginas}` : ''}. Guardar solo envía lo que cambiaste en esta página.</p>

      <PreciosGrid key={`${id}:${datos.pagina}:${sp.q ?? ''}`} priceListId={esBase ? null : id.slice(0, 64)} filas={datos.filas} />

      {datos.paginas > 1 && (
        <nav data-precios="paginas" aria-label="Páginas" className="flex items-center justify-between text-sm font-semibold">
          {datos.pagina > 0 ? <a href={enlace(datos.pagina - 1)} className="text-industrial-700 dark:text-industrial-300">← Anterior</a> : <span />}
          {datos.pagina + 1 < datos.paginas ? <a href={enlace(datos.pagina + 1)} className="text-industrial-700 dark:text-industrial-300">Siguiente →</a> : <span />}
        </nav>
      )}
    </main>
  )
}
