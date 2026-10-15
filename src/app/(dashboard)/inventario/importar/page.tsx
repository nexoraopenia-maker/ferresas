import Link from 'next/link'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { CatalogImport } from '@/features/inventory/components/CatalogImport'

export const dynamic = 'force-dynamic'

export default async function ImportarPage() {
  const ctx = await requireTenantContext()
  const db = getTenantPrisma(ctx)

  const warehouse = await db.warehouse.findFirst({
    where: { isActive: true, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true },
  })
  const productos = await db.product.count({ where: { deletedAt: null } })

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-5 p-4">
      <header>
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <Link href="/inventario" className="underline">Inventario</Link>
          <span>/</span>
          <span>Importar</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-ink">Importar catálogo</h1>
        <p className="text-sm text-ink-muted">
          {productos === 0
            ? 'Carga tu catálogo de una vez en lugar de producto por producto.'
            : `Tienes ${productos} productos. Reimportar actualiza precios sin tocar el stock.`}
          {warehouse && ` Almacén: ${warehouse.name}.`}
        </p>
      </header>

      {warehouse ? (
        <CatalogImport warehouseId={warehouse.id} />
      ) : (
        <p className="rounded-xl border border-stock-out/40 bg-stock-out-soft px-4 py-3 text-sm font-semibold text-stock-out">
          Necesitas un almacén activo antes de importar.
        </p>
      )}
    </main>
  )
}
