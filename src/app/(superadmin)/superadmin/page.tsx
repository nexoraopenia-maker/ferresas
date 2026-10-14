import { requireSuperAdmin } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { getSuperAdminDashboard, getRecentAuditLog } from '@/features/superadmin/queries'
import { NewTenantForm } from '@/features/superadmin/components/NewTenantForm'
import { ChangePasswordModal } from '@/features/superadmin/components/ChangePasswordModal'
import { TenantTable, type TenantTableRow } from '@/features/superadmin/components/TenantTable'
import type { PlanOpcion } from '@/features/superadmin/components/BillingPanel'

export const dynamic = 'force-dynamic'

export default async function SuperadminPage() {
  const admin = await requireSuperAdmin()
  const [{ metrics, tenants }, auditoria, planes] = await Promise.all([
    getSuperAdminDashboard(),
    getRecentAuditLog(12),
    prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, name: true, trialDays: true, priceMonthly: true, currency: true },
    }),
  ])

  const money = (n: number) =>
    n.toLocaleString('es-PE', { style: 'currency', currency: 'PEN', maximumFractionDigits: 0 })

  // Decimal y Date de Prisma no cruzan el límite servidor→cliente: se
  // serializan aquí, una vez, en lugar de en cada componente.
  const planOpciones: PlanOpcion[] = planes.map((p) => ({
    code: p.code,
    name: p.name,
    priceMonthly: p.priceMonthly.toFixed(2),
    currency: p.currency,
  }))

  const filas: TenantTableRow[] = tenants.map((t) => ({
    tenantId: t.id,
    tenantName: t.name,
    slug: t.slug,
    ownerEmail: t.ownerEmail,
    ownerName: t.ownerName,
    billingEmail: t.billingEmail,
    phone: t.phone,
    taxId: t.taxId,
    planCode: t.planCode,
    planName: t.planName,
    priceMonthly: t.priceMonthly,
    currency: t.currency,
    status: t.status,
    provider: t.provider,
    trialEndsAt: t.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: t.currentPeriodEnd?.toISOString() ?? null,
    pastDueSince: t.pastDueSince?.toISOString() ?? null,
    graceDays: t.graceDays,
    lastPaymentAt: t.lastPaymentAt?.toISOString() ?? null,
    lastPaymentAmount: t.lastPaymentAmount,
    cancelAtPeriodEnd: t.cancelAtPeriodEnd,
    gatewayLinked: t.gatewayLinked,
    access: t.access,
    isActive: t.isActive,
    suspendedReason: t.suspendedReason,
    users: t.users,
    products: t.products,
    createdAt: t.createdAt.toISOString(),
  }))

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Torre de control</h1>
          <p className="text-sm text-ink-muted">{admin.email}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-graphite-900 px-3 py-1 text-xs font-bold uppercase tracking-wide text-graphite-50">
            Super Admin
          </span>
          <ChangePasswordModal />
          <NewTenantForm plans={planes} />
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metrica label="MRR" value={money(metrics.mrr)} destacado />
        <Metrica label="ARPU" value={money(metrics.arpu)} />
        <Metrica label="Ferreterías" value={String(metrics.totalTenants)} />
        <Metrica label="Churn 30d" value={`${metrics.churnRate}%`} />
        <Metrica label="Activas" value={String(metrics.active)} tono="ok" />
        <Metrica label="En prueba" value={String(metrics.trialing)} tono="info" />
        <Metrica label="En mora" value={String(metrics.pastDue)} tono="warn" />
        <Metrica label="Suspendidas" value={String(metrics.suspended)} tono="stop" />
      </section>

      <section className="overflow-hidden rounded-2xl border border-hairline bg-surface">
        <h2 className="border-b border-hairline px-4 py-3 font-bold text-ink">
          Ferreterías ({filas.length})
        </h2>
        <TenantTable rows={filas} plans={planOpciones} />
      </section>

      <section className="rounded-2xl border border-hairline bg-surface p-4">
        <h2 className="font-bold text-ink">Auditoría reciente</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {auditoria.map((a) => (
            <li key={a.id} className="flex flex-wrap gap-x-2 text-sm">
              <span className="font-mono text-xs text-ink-muted">
                {a.createdAt.toLocaleString('es-PE')}
              </span>
              <span className="font-semibold text-ink">{a.action}</span>
              <span className="text-ink-muted">{a.tenant?.name ?? '—'}</span>
              <span className="text-ink-muted">por {a.actorEmail ?? 'sistema'}</span>
              {a.reason && <span className="w-full text-xs text-ink-muted">“{a.reason}”</span>}
            </li>
          ))}
          {auditoria.length === 0 && (
            <li className="text-sm text-ink-muted">Sin acciones sensibles registradas.</li>
          )}
        </ul>
      </section>
    </main>
  )
}

function Metrica({
  label, value, destacado, tono,
}: {
  label: string
  value: string
  destacado?: boolean
  tono?: 'ok' | 'info' | 'warn' | 'stop'
}) {
  const acento =
    tono === 'ok' ? 'text-stock-ok'
    : tono === 'warn' ? 'text-stock-low'
    : tono === 'stop' ? 'text-stock-out'
    : tono === 'info' ? 'text-industrial-600'
    : 'text-ink'

  return (
    <div
      className={`rounded-2xl border p-4 ${
        destacado
          ? 'border-industrial-600 bg-industrial-50 dark:bg-industrial-950'
          : 'border-hairline bg-surface'
      }`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${destacado ? 'text-industrial-700 dark:text-industrial-300' : acento}`}>
        {value}
      </p>
    </div>
  )
}
