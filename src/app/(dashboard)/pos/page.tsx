import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { PosTerminal } from '@/features/pos/components/PosTerminal'

export const dynamic = 'force-dynamic'

export default async function PosPage() {
  const ctx = await requireTenantContext()
  const db = getTenantPrisma(ctx)

  const warehouse = await db.warehouse.findFirst({
    where: { isActive: true, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { name: true },
  })

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Punto de venta</h1>
        <p className="text-sm text-ink-muted">
          {warehouse ? `Almacén: ${warehouse.name}` : 'Sin almacén activo'}
        </p>
      </header>

      {warehouse ? (
        <PosTerminal warehouseName={warehouse.name} />
      ) : (
        <p className="rounded-xl border border-stock-out/40 bg-stock-out-soft px-4 py-3 text-sm font-semibold text-stock-out">
          Necesitas un almacén activo para vender.
        </p>
      )}
    </main>
  )
}
