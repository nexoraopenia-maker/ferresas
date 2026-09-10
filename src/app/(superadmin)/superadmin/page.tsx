import { requireSuperAdmin } from '@/lib/session'
import { getSuperAdminDashboard, getRecentAuditLog } from '@/features/superadmin/queries'
import { TenantActions } from '@/features/superadmin/components/TenantActions'

export const dynamic = 'force-dynamic'

const ACCESO_ESTILO: Record<string, string> = {
  FULL: 'bg-stock-ok-soft text-stock-ok',
  WARN: 'bg-stock-low-soft text-stock-low',
  READ_ONLY: 'bg-stock-out-soft text-stock-out',
  BLOCKED: 'bg-graphite-900 text-graphite-50',
}

export default async function SuperadminPage() {
  const admin = await requireSuperAdmin()
  const [{ metrics, tenants }, auditoria] = await Promise.all([
    getSuperAdminDashboard(),
    getRecentAuditLog(10),
  ])

  const money = (n: number) =>
    n.toLocaleString('es-PE', { style: 'currency', currency: 'PEN', maximumFractionDigits: 0 })

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-ink">Torre de control</h1>
          <p className="text-sm text-ink-muted">{admin.email}</p>
        </div>
        <span className="rounded-full bg-graphite-900 px-3 py-1 text-xs font-bold uppercase tracking-wide text-graphite-50">
          Super Admin
        </span>
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
          Ferreterías ({tenants.length})
        </h2>

        {/* La tabla desborda en horizontal dentro de su propio contenedor:
            el panel se consulta desde el móvil tanto como desde el escritorio. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="bg-surface-sunken text-left text-ink-muted">
              <tr>
                <Th>Ferretería</Th>
                <Th>Plan</Th>
                <Th>Estado</Th>
                <Th>Acceso</Th>
                <Th>Usuarios</Th>
                <Th>Productos</Th>
                <Th>Alta</Th>
                <Th>Acciones</Th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-t border-hairline align-middle">
                  <td className="px-3 py-3">
                    <p className="font-semibold text-ink">{t.name}</p>
                    <p className="font-mono text-xs text-ink-muted">{t.slug}</p>
                    {!t.isActive && t.suspendedReason && (
                      <p className="mt-1 max-w-xs text-xs font-semibold text-stock-out">
                        Suspendida: {t.suspendedReason}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-3 text-ink">{t.planName ?? '—'}</td>
                  <td className="px-3 py-3 text-ink">{t.status}</td>
                  <td className="px-3 py-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-bold ${
                        ACCESO_ESTILO[t.access] ?? ''
                      }`}
                    >
                      {t.access}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-ink">{t.users}</td>
                  <td className="px-3 py-3 text-ink">{t.products}</td>
                  <td className="px-3 py-3 text-ink-muted">
                    {t.createdAt.toLocaleDateString('es-PE')}
                  </td>
                  <td className="px-3 py-3">
                    <TenantActions
                      tenantId={t.id}
                      tenantName={t.name}
                      isActive={t.isActive}
                    />
                  </td>
                </tr>
              ))}
              {tenants.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-ink-muted">
                    Todavía no hay ferreterías registradas.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* La torre de control se vigila a sí misma: quién suspendió qué y quién
          entró en la cuenta de quién, a la vista. */}
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

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-semibold">{children}</th>
}

function Metrica({
  label,
  value,
  destacado,
  tono,
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
        destacado ? 'border-industrial-600 bg-industrial-50 dark:bg-industrial-950' : 'border-hairline bg-surface'
      }`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${destacado ? 'text-industrial-700 dark:text-industrial-300' : acento}`}>
        {value}
      </p>
    </div>
  )
}
