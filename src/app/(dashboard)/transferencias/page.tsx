import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { hasRole } from '@/lib/tenant-context'
import { TransferList } from '@/features/branches/components/TransferList'
import { NewTransfer } from '@/features/branches/components/NewTransfer'

export const dynamic = 'force-dynamic'

/**
 * Transferencias entre sucursales.
 *
 * Se listan las de ENTRADA y SALIDA de la sucursal activa, no todas las del
 * tenant: a quien está en un local le importa lo que sale de su almacén y lo
 * que tiene que recibir, no el tráfico entre otros dos locales.
 */
export default async function TransferenciasPage() {
  const ctx = await requireTenantContext()
  if (!hasRole(ctx.role, 'ALMACENERO')) notFound()

  const db = getTenantPrisma(ctx)

  if (!ctx.branchId) {
    return (
      <main className="mx-auto max-w-3xl p-4">
        <h1 className="text-2xl font-bold text-ink">Transferencias</h1>
        <p className="mt-4 rounded-xl border border-stock-low/40 bg-stock-low-soft px-4 py-3 text-sm font-semibold text-stock-low">
          No tienes ninguna sucursal asignada. Pídele a un administrador que
          te asigne una para poder pedir y recibir mercadería.
        </p>
      </main>
    )
  }

  // Almacenes de MI sucursal (origen posible) y sucursales ajenas vigentes
  // con sus almacenes (destinos posibles).
  const [misAlmacenes, otrasSucursales] = await Promise.all([
    db.warehouse.findMany({
      where: { branchId: ctx.branchId, isActive: true, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
    db.branch.findMany({
      where: { id: { not: ctx.branchId }, isActive: true, deletedAt: null },
      orderBy: { seriesNumber: 'asc' },
      select: {
        id: true, name: true,
        warehouses: {
          where: { isActive: true, deletedAt: null },
          orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
          select: { id: true, name: true },
        },
      },
    }),
  ])

  const transferencias = await db.branchTransfer.findMany({
    where: {
      OR: [{ fromBranchId: ctx.branchId }, { toBranchId: ctx.branchId }],
    },
    orderBy: [{ requestedAt: 'desc' }],
    take: 80,
    select: {
      id: true, number: true, status: true, requestedAt: true,
      notes: true, rejectReason: true,
      fromBranchId: true, toBranchId: true,
      fromBranch: { select: { name: true } },
      toBranch: { select: { name: true } },
      requestedBy: { select: { name: true, email: true } },
      items: {
        select: {
          id: true, nameSnapshot: true, skuSnapshot: true, unitType: true,
          quantitySent: true, quantityReceived: true,
        },
      },
    },
  })

  const tenant = await db.tenant.findFirst({ select: { timezone: true } })

  const pendientes = transferencias.filter((t) =>
    ['SOLICITADA', 'APROBADA', 'EN_TRANSITO'].includes(t.status),
  ).length
  const porRecibir = transferencias.filter(
    (t) => t.status === 'EN_TRANSITO' && t.toBranchId === ctx.branchId,
  ).length

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Transferencias</h1>
        <p className="text-sm text-ink-muted">
          El stock sale del origen al despachar y entra al destino al recibir.
          Mientras viaja no está en ningún almacén.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <Contador label="Sin cerrar" value={pendientes} />
        <Contador label="Por recibir aquí" value={porRecibir} aviso={porRecibir > 0} />
      </section>

      {(ctx.access === 'FULL' || ctx.access === 'WARN') && (
        <NewTransfer
          almacenes={misAlmacenes}
          destinos={otrasSucursales
            // Una sucursal sin almacén activo no puede recibir nada.
            .filter((b) => b.warehouses.length > 0)
            .map((b) => ({
              branchId: b.id,
              branchName: b.name,
              warehouses: b.warehouses,
            }))}
        />
      )}

      <TransferList
        puedeAprobar={hasRole(ctx.role, 'ADMIN')}
        zonaHoraria={tenant?.timezone ?? 'America/Lima'}
        puedeOperar={ctx.access === 'FULL' || ctx.access === 'WARN'}
        transferencias={transferencias.map((t) => ({
          id: t.id,
          number: t.number,
          status: t.status,
          origen: t.fromBranch.name,
          destino: t.toBranch.name,
          esMiOrigen: t.fromBranchId === ctx.branchId,
          esMiDestino: t.toBranchId === ctx.branchId,
          solicitadaPor: t.requestedBy.name ?? t.requestedBy.email,
          requestedAt: t.requestedAt.toISOString(),
          notes: t.notes,
          rejectReason: t.rejectReason,
          items: t.items.map((i) => ({
            id: i.id,
            nombre: i.nameSnapshot,
            sku: i.skuSnapshot,
            unitType: i.unitType,
            enviado: Number(i.quantitySent),
            recibido: i.quantityReceived === null ? null : Number(i.quantityReceived),
          })),
        }))}
      />
    </main>
  )
}

function Contador({
  label, value, aviso,
}: { label: string; value: number; aviso?: boolean }) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${aviso ? 'text-stock-low' : 'text-ink'}`}>
        {value}
      </p>
    </div>
  )
}
