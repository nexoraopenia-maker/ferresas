import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { planVigente } from '@/lib/plan-limits'
import { BranchManager } from '@/features/branches/components/BranchManager'
import { puede } from '@/lib/puede'

export const dynamic = 'force-dynamic'

/**
 * Gestión de sucursales y de quién entra a cada una.
 *
 * 404 y no 403 para quien no es ADMIN: una redirección delataría que la ruta
 * existe y hace algo, igual que en /superadmin. El enforcement real está en
 * los servicios, no aquí.
 */
export default async function SucursalesPage() {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'sucursales.gestionar')) notFound()

  const db = getTenantPrisma(ctx)

  const [sucursales, usuarios, plan] = await Promise.all([
    db.branch.findMany({
      where: { deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { seriesNumber: 'asc' }],
      select: {
        id: true, code: true, name: true, establishmentCode: true,
        seriesNumber: true, address: true, ubigeo: true, phone: true,
        isDefault: true, isActive: true,
        manager: { select: { name: true, email: true } },
        warehouses: {
          where: { deletedAt: null },
          select: { id: true, _count: { select: { stocks: true } } },
        },
      },
    }),
    db.user.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      select: {
        id: true, name: true, email: true, role: true,
        branches: {
          where: { branch: { deletedAt: null } },
          select: { branch: { select: { name: true } } },
        },
      },
    }),
    planVigente(db),
  ])

  // Productos con stock > 0 por sucursal: es el dato que decide si se puede
  // dar de baja, así que se cuenta aquí y no se deja al usuario descubrirlo
  // cuando el servidor le rechace la operación.
  const conStock = await db.stock.groupBy({
    by: ['warehouseId'],
    where: { quantity: { gt: 0 } },
    _count: { _all: true },
  })
  const porAlmacen = new Map(conStock.map((c) => [c.warehouseId, c._count._all]))

  const activas = sucursales.filter((s) => s.isActive).length
  const limite = plan?.maxBranches ?? null

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Sucursales</h1>
        <p className="text-sm text-ink-muted">
          Cada sucursal es un establecimiento ante SUNAT y emite con su propia
          serie de comprobantes.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <Contador label="Activas" value={activas} />
        <Contador
          label="Permitidas por tu plan"
          value={limite === null ? '∞' : limite}
          aviso={limite !== null && activas >= limite}
        />
      </section>

      <BranchManager
        puedeGestionar={ctx.access === 'FULL' || ctx.access === 'WARN'}
        sucursales={sucursales.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          establishmentCode: s.establishmentCode,
          seriesNumber: s.seriesNumber,
          address: s.address,
          ubigeo: s.ubigeo,
          phone: s.phone,
          isDefault: s.isDefault,
          isActive: s.isActive,
          responsable: s.manager?.name ?? s.manager?.email ?? null,
          almacenes: s.warehouses.length,
          conStock: s.warehouses.reduce((a, w) => a + (porAlmacen.get(w.id) ?? 0), 0),
        }))}
        usuarios={usuarios.map((u) => ({
          id: u.id,
          nombre: u.name,
          email: u.email,
          role: u.role,
          sucursales: u.branches.map((b) => b.branch.name),
        }))}
      />
    </main>
  )
}

function Contador({
  label, value, aviso,
}: { label: string; value: number | string; aviso?: boolean }) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${aviso ? 'text-stock-low' : 'text-ink'}`}>
        {value}
      </p>
      {aviso && (
        <p className="mt-1 text-xs font-semibold text-stock-low">
          Al tope: mejora de plan para abrir otra.
        </p>
      )}
    </div>
  )
}
