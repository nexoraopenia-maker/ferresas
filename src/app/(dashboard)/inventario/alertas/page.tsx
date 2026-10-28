import Link from 'next/link'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { formatQuantity, unitLabel } from '@/lib/quantity'
import { filtroAlmacen } from '@/features/branches/queries'
import { alertasDeStock } from '@/features/dashboard/service'
import { AlertasStockWidget } from '@/features/dashboard/components/Widgets'
import { enlaceKardex } from '@/features/inventory/kardex-enlaces'
import { ReposicionRapida } from '@/features/dashboard/components/ReposicionRapida'

export const dynamic = 'force-dynamic'

/** Todo lo agotado o en su mínimo, con la reposición a un clic. */
export default async function AlertasPage() {
  const ctx = await requireTenantContext()
  const db = getTenantPrisma(ctx)

  const [alertas, almacen] = await Promise.all([
    alertasDeStock(db, ctx, 300),
    db.warehouse.findFirst({
      where: filtroAlmacen(ctx.branchId),
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
  ])
  const puedeEntrada = puede(ctx, 'stock.entrada') && !!almacen &&
    (ctx.access === 'FULL' || ctx.access === 'WARN')
  const puedePedir = puede(ctx, 'stock.transferir_solicitar')
  const verKardex = puede(ctx, 'kardex.ver')

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-ink">Alertas de stock</h1>
          <p className="text-sm text-ink-muted">
            Lo agotado primero. Registra lo que llegó o pídelo a otra sucursal.
          </p>
        </div>
        <Link href="/panel" className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">← Panel</Link>
      </header>

      <AlertasStockWidget agotados={alertas.agotados} criticos={alertas.criticos} items={alertas.items} completo />

      {alertas.items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {alertas.items.map((a) => (
            <li
              key={a.productId} id={a.productId}
              className="scroll-mt-20 rounded-2xl border border-hairline bg-surface p-3 shadow-sm target:ring-2 target:ring-accent-500"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">{a.nombre}</p>
                  <p className="font-mono text-xs text-ink-muted">{a.sku}</p>
                  {verKardex && <a data-producto="kardex" href={enlaceKardex({ producto: a.productId })} className="text-xs font-semibold text-industrial-700 underline dark:text-industrial-300">Ver kardex</a>}
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${
                  a.estado === 'OUT' ? 'bg-stock-out-soft text-stock-out' : 'bg-stock-low-soft text-stock-low'
                }`}>
                  {a.estado === 'OUT' ? 'Agotado' : 'En su mínimo'}
                </span>
              </div>
              <p className="mt-1 text-sm text-ink-muted">
                Hay <b className="text-ink">{formatQuantity(a.stock, a.unitType)}</b> {unitLabel(a.unitType)}
                {a.minimo > 0 && <> · mínimo {formatQuantity(a.minimo, a.unitType)}</>}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {puedeEntrada && almacen && (
                  <ReposicionRapida productId={a.productId} warehouseId={almacen.id} unitType={a.unitType} />
                )}
                {puedePedir && (
                  <Link
                    href="/transferencias"
                    className="h-touch inline-flex items-center rounded-xl border border-hairline px-3 text-sm font-semibold text-ink hover:bg-industrial-50 dark:hover:bg-graphite-800"
                  >
                    Pedir a otra sucursal
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
