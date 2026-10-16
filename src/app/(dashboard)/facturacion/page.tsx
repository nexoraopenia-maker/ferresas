import { getTenantPrisma } from '@/lib/tenant-prisma'
import { formatearFechaLocal } from '@/lib/fecha-local'
import { requireTenantContext } from '@/lib/session'
import { GatewayButtons } from '@/features/billing/components/GatewayButtons'
import { PortalButton } from '@/features/billing/components/PortalButton'
import { getAvailableGateways } from '@/features/billing/actions'

/**
 * Portal de pago. Accesible con la cuenta en mora (§5.2): cortarle a un
 * moroso el acceso a la pantalla donde paga es contraproducente.
 */
export default async function FacturacionPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>
}) {
  const { checkout } = await searchParams
  const ctx = await requireTenantContext()
  const db = getTenantPrisma(ctx)

  const tenant = await db.tenant.findFirst({ select: { timezone: true } })
  const zonaHoraria = tenant?.timezone ?? 'America/Lima'

  const [sub, planes, gateways] = await Promise.all([
    db.subscription.findFirst({
      select: {
        status: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        externalCustomerId: true,
        plan: { select: { code: true, name: true } },
      },
    }),
    db.plan.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, name: true, priceMonthly: true, currency: true, description: true },
    }),
    getAvailableGateways(),
  ])

  const puedeGestionar = ctx.role === 'OWNER' || ctx.role === 'ADMIN'

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 p-4">
      <h1 className="text-2xl font-bold text-ink">Facturación</h1>

      {/* Stripe redirige aquí al terminar. El estado real NO se lee de este
          parámetro —el usuario podría escribirlo a mano— sino de la BD, que
          actualiza el webhook. Esto es solo un acuse visual. */}
      {checkout === 'exito' && (
        <p className="rounded-xl border border-stock-ok/30 bg-stock-ok-soft px-4 py-3 text-sm font-semibold text-stock-ok">
          ✓ Pago recibido. La activación puede tardar unos segundos en reflejarse.
        </p>
      )}
      {checkout === 'cancelado' && (
        <p className="rounded-xl border border-hairline bg-surface-sunken px-4 py-3 text-sm text-ink-muted">
          Cancelaste el pago. Tu cuenta sigue igual.
        </p>
      )}

      <section className="rounded-2xl border border-hairline bg-surface-raised p-4">
        <h2 className="font-bold text-ink">Tu suscripción</h2>
        <dl className="mt-2 flex flex-col gap-1 text-sm">
          <Fila label="Plan" value={sub?.plan?.name ?? '—'} />
          <Fila label="Estado" value={sub?.status ?? '—'} />
          <Fila label="Acceso" value={ctx.access} />
          {sub?.trialEndsAt && (
            <Fila
              label="Prueba hasta"
              value={formatearFechaLocal(sub.trialEndsAt, zonaHoraria, 'es-PE', { conHora: false })}
            />
          )}
          {sub?.currentPeriodEnd && (
            <Fila
              label="Renueva el"
              value={formatearFechaLocal(sub.currentPeriodEnd, zonaHoraria, 'es-PE', { conHora: false })}
            />
          )}
        </dl>

        {puedeGestionar && sub?.externalCustomerId && (
          <div className="mt-4">
            <PortalButton />
          </div>
        )}
      </section>

      {puedeGestionar ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-bold text-ink">
            {sub?.status === 'ACTIVE' ? 'Cambiar de plan' : 'Activar un plan'}
          </h2>
          {planes.map((p) => (
            <div
              key={p.code}
              className="flex items-center justify-between gap-3 rounded-xl border border-hairline bg-surface p-4"
            >
              <div className="min-w-0">
                <p className="font-bold text-ink">{p.name}</p>
                <p className="text-sm text-ink-muted">
                  {p.currency} {p.priceMonthly.toFixed(2)} / mes
                </p>
              </div>
              <GatewayButtons
                planCode={p.code}
                gateways={gateways}
                label={sub?.plan?.code === p.code ? 'Renovar' : 'Pagar'}
              />
            </div>
          ))}
        </section>
      ) : (
        <p className="text-sm text-ink-muted">
          Solo el dueño o un administrador puede gestionar la suscripción.
        </p>
      )}
    </main>
  )
}

function Fila({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-semibold text-ink">{value}</dd>
    </div>
  )
}
