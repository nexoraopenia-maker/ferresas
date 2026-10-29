import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { currentCashSession, desgloseDeMovimientos } from '@/features/branches/cash-service'
import { listarMovimientosDelTurno, puedeVerMovimientos } from '@/features/branches/cash-movement-service'
import { puede } from '@/lib/puede'
import { CashPanel } from '@/features/branches/components/CashPanel'
import { cajasDeSucursal } from '@/features/branches/cajas-service'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

/**
 * Tu turno de caja (F6.8): cada persona abre y cierra EL SUYO en una de las cajas de la sucursal, y todo lo que mueve dinero (cobros, abonos, pagos, movimientos, devoluciones) queda en el turno
 * de quien lo hace. Quien tiene `caja.arqueo` ve el último cierre de cualquiera; el resto, el suyo. El consolidado de todas las cajas está en /caja/consolidado (`caja.consolidado`).
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

  const arqueo = puede(ctx, 'caja.arqueo')
  const [turnoRaw, sucursal, ultimo, tenant, cajas, enOtra] = await Promise.all([
    currentCashSession(db, ctx),
    db.branch.findFirst({ where: { id: ctx.branchId }, select: { name: true } }),
    db.cashSession.findFirst({
      where: { branchId: ctx.branchId, status: 'CERRADA', ...(arqueo ? {} : { openedById: ctx.userId }) },
      orderBy: { closedAt: 'desc' },
      select: {
        id: true, openingAmount: true, countedAmount: true, expectedAmount: true,
        difference: true, salesCount: true, salesTotal: true, cashTotal: true,
        changeTotal: true, creditSalesTotal: true, cashReceiptsTotal: true,
        otherReceiptsTotal: true, supplierCashPaymentsTotal: true, supplierOtherPaymentsTotal: true, refundsCashTotal: true, refundsOtherTotal: true, closedAt: true, openedById: true, closedById: true,
        closedBy: { select: { name: true, email: true } },
      },
    }),
    db.tenant.findFirst({ select: { timezone: true } }),
    cajasDeSucursal(db, ctx, ctx.branchId),
    db.cashSession.findFirst({ where: { openedById: ctx.userId, status: 'ABIERTA', branchId: { not: ctx.branchId } }, select: { branch: { select: { name: true } } } }),
  ])

  const abiertoPor = turnoRaw
    ? await db.cashSession.findFirst({
        where: { id: turnoRaw.id },
        select: { openedBy: { select: { name: true, email: true } }, register: { select: { name: true } } },
      })
    : null

  const n = (v: unknown) => Number(v ?? 0)
  const lista = turnoRaw && puedeVerMovimientos(ctx) ? await listarMovimientosDelTurno(db, ctx, turnoRaw.id) : []
  const desgloseUltimo = ultimo ? await desgloseDeMovimientos(db, ultimo.id) : null

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-5 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Caja</h1>
        <p className="text-sm text-ink-muted">
          Apertura, cierre y arqueo del cajón de {sucursal?.name ?? 'la sucursal'}.
        </p>
      </header>

      {puede(ctx, 'caja.consolidado') && (
        <p className="text-sm"><Link href="/caja/consolidado" data-caja="consolidado" className="font-semibold underline">Ver el consolidado del día (todas las cajas)</Link></p>
      )}

      <CashPanel
        sucursal={sucursal?.name ?? 'Sucursal'}
        zonaHoraria={tenant?.timezone ?? 'America/Lima'}
        puedeOperar={ctx.access === 'FULL' || ctx.access === 'WARN'}
        permisos={{ movimientos: puede(ctx, 'caja.movimientos'), ajuste: puede(ctx, 'caja.ajuste') }}
        cajas={cajas}
        turnoEnOtraSucursal={enOtra?.branch.name ?? null}
        turno={
          turnoRaw
            ? {
                id: turnoRaw.id,
                openingAmount: turnoRaw.openingAmount,
                expectedAmount: turnoRaw.expectedAmount,
                salesCount: turnoRaw.salesCount,
                refundsCashTotal: turnoRaw.refundsCashTotal,
                refundsOtherTotal: turnoRaw.refundsOtherTotal,
                movimientos: turnoRaw.movimientos,
                lista,
                openedAt: turnoRaw.openedAt,
                abiertoPor:
                  abiertoPor?.openedBy.name ?? abiertoPor?.openedBy.email ?? '—',
                caja: abiertoPor?.register?.name ?? null,
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
                creditSalesTotal: n(ultimo.creditSalesTotal),
                cashReceiptsTotal: n(ultimo.cashReceiptsTotal),
                otherReceiptsTotal: n(ultimo.otherReceiptsTotal),
                supplierCashPaymentsTotal: n(ultimo.supplierCashPaymentsTotal),
                supplierOtherPaymentsTotal: n(ultimo.supplierOtherPaymentsTotal),
                refundsCashTotal: n(ultimo.refundsCashTotal),
                refundsOtherTotal: n(ultimo.refundsOtherTotal),
                movimientos: desgloseUltimo!,
                closedAt: (ultimo.closedAt ?? new Date()).toISOString(),
                cerradoPor: ultimo.closedBy?.name ?? ultimo.closedBy?.email ?? undefined,
              }
            : null
        }
        puedeImprimirUltimoCierre={
          !!ultimo && (puede(ctx, 'caja.arqueo') || (puede(ctx, 'caja.abrir_cerrar') && (ultimo.openedById === ctx.userId || ultimo.closedById === ctx.userId)))
        }
      />
    </main>
  )
}
