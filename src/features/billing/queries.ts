import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { puede } from '@/lib/puede'
import { getAccountBanner, type AccountBanner } from './account-status'

export interface DashboardAccountState {
  banner: AccountBanner | null
  /** Código del plan a contratar cuando el usuario pulse el CTA. */
  planCode: string | null
  canManageBilling: boolean
}

/**
 * Estado de cuenta para el layout del dashboard.
 *
 * Consulta propia en vez de reutilizar la cabecera que pone el proxy: el
 * banner necesita días restantes y nombre de plan, que no caben en una
 * cabecera sin inventar un formato. Tener DOS fuentes para el mismo aviso
 * acaba en que divergen y el usuario ve un banner que contradice su acceso
 * real.
 */
export async function getDashboardAccountState(): Promise<DashboardAccountState> {
  const ctx = await requireTenantContext()

  // Durante una impersonation el acceso se fuerza a READ_ONLY por diseño (ver
  // src/lib/impersonation.ts). Mostrar el banner de facturación aquí diría
  // "tu suscripción está vencida" sobre una cuenta que puede estar al día:
  // el soporte diagnosticaría un problema inexistente. Manda el banner de
  // impersonation, que sí explica el motivo real.
  if (ctx.impersonationId) {
    return { banner: null, planCode: null, canManageBilling: false }
  }

  const db = getTenantPrisma(ctx)

  const sub = await db.subscription.findFirst({
    select: {
      status: true,
      trialEndsAt: true,
      pastDueSince: true,
      graceDays: true,
      plan: { select: { code: true, name: true } },
    },
  })

  if (!sub) {
    return { banner: null, planCode: null, canManageBilling: false }
  }

  return {
    banner: getAccountBanner({
      status: sub.status,
      access: ctx.access,
      trialEndsAt: sub.trialEndsAt,
      pastDueSince: sub.pastDueSince,
      graceDays: sub.graceDays,
      planName: sub.plan?.name ?? null,
    }),
    planCode: sub.plan?.code ?? null,
    // Un almacenero no debe ver un botón de pagar que no puede usar.
    canManageBilling: puede(ctx, 'plan.gestionar'),
  }
}
