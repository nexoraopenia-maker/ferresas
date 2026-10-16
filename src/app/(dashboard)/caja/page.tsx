import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { currentCashSession } from '@/features/branches/cash-service'
import { CashPanel } from '@/features/branches/components/CashPanel'

export const dynamic = 'force-dynamic'

/**
 * Turno de caja de la sucursal activa.
 *
 * Es por SUCURSAL y no por usuario: el cajón es físico y está en un local
 * concreto. Dos cajeros que se relevan comparten el mismo turno, y el arqueo
 * se hace sobre el cajón, no sobre quién cobró.
 */
export default async function CajaPage() {
  const ctx = await requireTenantContext()
  const db = getTenantPrisma(ctx)

  if (!ctx.branchId) {
    return (
      <main className="mx-auto max-w-2xl p-4">
        <h1 className="text-2xl font-bold text-ink">Caja</h1>
        <p className="mt-4 rounded-xl border border-stock-low/40 bg-stock-low-soft px-4 py-3 text-sm font-semibold text-stock-low">
          No tienes ninguna sucursal asignada, así que no hay caja que abrir.
          Pídele a un administrador que te asigne una.
        </p>
      </main>
    )
  }

  const [turnoRaw, sucursal, ultimo, tenant] = await Promise.all([
    currentCashSession(db, ctx),
    db.branch.findFirst({ where: { id: ctx.branchId }, select: { name: true } }),
    db.cashSession.findFirst({
      where: { branchId: ctx.branchId, status: 'CERRADA' },
      orderBy: { closedAt: 'desc' },
      select: {
        id: true, openingAmount: true, countedAmount: true, expectedAmount: true,
        difference: true, salesCount: true, salesTotal: true, cashTotal: true,
        changeTotal: true, closedAt: true,
        closedBy: { select: { name: true, email: true } },
      },
    }),
    db.tenant.findFirst({ select: { timezone: true } }),
  ])

  const abiertoPor = turnoRaw
    ? await db.cashSession.findFirst({
        where: { id: turnoRaw.id },
        select: { openedBy: { select: { name: true, email: true } } },
      })
    : null

  const n = (v: unknown) => Number(v ?? 0)

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-5 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Caja</h1>
        <p className="text-sm text-ink-muted">
          Apertura, cierre y arqueo del cajón de {sucursal?.name ?? 'la sucursal'}.
        </p>
      </header>

      <CashPanel
        sucursal={sucursal?.name ?? 'Sucursal'}
        zonaHoraria={tenant?.timezone ?? 'America/Lima'}
        puedeOperar={ctx.access === 'FULL' || ctx.access === 'WARN'}
        turno={
          turnoRaw
            ? {
                id: turnoRaw.id,
                openingAmount: turnoRaw.openingAmount,
                expectedAmount: turnoRaw.expectedAmount,
                salesCount: turnoRaw.salesCount,
                openedAt: turnoRaw.openedAt,
                abiertoPor:
                  abiertoPor?.openedBy.name ?? abiertoPor?.openedBy.email ?? '—',
              }
            : null
        }
        ultimoCierre={
          ultimo
            ? {
                id: ultimo.id,
                openingAmount: n(ultimo.openingAmount),
                countedAmount: n(ultimo.countedAmount),
                expectedAmount: n(ultimo.expectedAmount),
                difference: n(ultimo.difference),
                salesCount: ultimo.salesCount,
                salesTotal: n(ultimo.salesTotal),
                cashTotal: n(ultimo.cashTotal),
                changeTotal: n(ultimo.changeTotal),
                closedAt: (ultimo.closedAt ?? new Date()).toISOString(),
                cerradoPor: ultimo.closedBy?.name ?? ultimo.closedBy?.email ?? undefined,
              }
            : null
        }
      />
    </main>
  )
}
