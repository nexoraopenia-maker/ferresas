import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { PosTerminal } from '@/features/pos/components/PosTerminal'

export const dynamic = 'force-dynamic'

export default async function PosPage() {
  const ctx = await requireTenantContext()
  const db = getTenantPrisma(ctx)

  /*
   * El almacén tiene que ser DE LA SUCURSAL ACTIVA.
   *
   * Antes de multi-sucursal bastaba «cualquiera activo». Ahora eso es un
   * error: a un cajero de la sucursal 2 le mostraría el almacén de la matriz
   * y, aunque `registerSale` rechazaría la venta por no corresponder a su
   * sucursal, el cajero se quedaría viendo fallar cada cobro sin entender
   * por qué.
   */
  const [warehouse, tenant] = await Promise.all([
    db.warehouse.findFirst({
      where: {
        isActive: true,
        deletedAt: null,
        ...(ctx.branchId ? { branchId: ctx.branchId } : {}),
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { name: true },
    }),
    db.tenant.findFirst({ select: { timezone: true } }),
  ])

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Punto de venta</h1>
        <p className="text-sm text-ink-muted">
          {!ctx.branchId
            ? 'Sin sucursal asignada: pide a un administrador que te asigne una'
            : warehouse
              ? `Almacén: ${warehouse.name}`
              : 'Esta sucursal no tiene almacén activo'}
        </p>
      </header>

      {warehouse ? (
        <PosTerminal
          warehouseName={warehouse.name}
          zonaHoraria={tenant?.timezone ?? 'America/Lima'}
        />
      ) : (
        <p className="rounded-xl border border-stock-out/40 bg-stock-out-soft px-4 py-3 text-sm font-semibold text-stock-out">
          {ctx.branchId
            ? 'Esta sucursal necesita un almacén activo para vender.'
            : 'No tienes ninguna sucursal asignada, así que no hay dónde vender.'}
        </p>
      )}
    </main>
  )
}
