import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { reporteDeReposicion } from '@/features/inventory/reposicion-reporte'
import { ReposicionReporte } from '@/features/inventory/components/ReposicionReporte'

export const dynamic = 'force-dynamic'

/**
 * Reposición sugerida (F6.6b): qué pedir y cuánto, agrupado por proveedor habitual. Verla: `reposicion.ver`. El valor estimado del pedido solo aparece con
 * `productos.ver_costo` (el servicio ni lee los costos sin ese permiso). Cambiar mínimos y máximos: `reposicion.configurar`, en su propia pantalla.
 */
export default async function ReposicionPage({ searchParams }: { searchParams: Promise<{ almacen?: string }> }) {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'reposicion.ver')) notFound()
  const db = getTenantPrisma(ctx)
  const { almacen } = await searchParams
  const reporte = await reporteDeReposicion(db, ctx, { warehouseId: almacen })

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Reposición sugerida</h1>
          <p className="text-sm text-ink-muted">Lo que conviene pedir, por proveedor. Se repone hasta el máximo (o 2 × el mínimo) contando lo que ya viene en camino.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm font-semibold">
          {puede(ctx, 'reposicion.configurar') && <Link href="/inventario/reposicion/umbrales" className="text-industrial-700 dark:text-industrial-300">Mínimos y máximos →</Link>}
          <Link href="/inventario" className="text-industrial-700 dark:text-industrial-300">← Inventario</Link>
        </div>
      </header>

      {reporte.almacenes.length > 1 && (
        <nav data-reposicion="almacenes" aria-label="Filtrar por almacén" className="flex flex-wrap gap-2 text-sm font-semibold">
          <a href="/inventario/reposicion" aria-current={!reporte.warehouseId ? 'page' : undefined} className={`rounded-full px-3 py-1 ${!reporte.warehouseId ? 'bg-industrial-600 text-white' : 'border border-hairline text-ink'}`}>Todos</a>
          {reporte.almacenes.map((a) => (
            <a key={a.id} href={`/inventario/reposicion?almacen=${encodeURIComponent(a.id)}`} aria-current={reporte.warehouseId === a.id ? 'page' : undefined}
              className={`rounded-full px-3 py-1 ${reporte.warehouseId === a.id ? 'bg-industrial-600 text-white' : 'border border-hairline text-ink'}`}>{a.name}</a>
          ))}
        </nav>
      )}

      <div className="flex justify-end">
        <a data-reposicion="csv" href={`/api/inventario/reposicion${reporte.warehouseId ? `?almacen=${encodeURIComponent(reporte.warehouseId)}` : ''}`} className="text-sm font-semibold text-industrial-700 underline dark:text-industrial-300">Descargar CSV</a>
      </div>

      <ReposicionReporte reporte={reporte} verKardex={puede(ctx, 'kardex.ver')} puedeComprar={puede(ctx, 'compras.registrar')} puedeTransferir={puede(ctx, 'stock.transferir_solicitar')} sucursalActualId={ctx.branchId ?? null} />
    </main>
  )
}
