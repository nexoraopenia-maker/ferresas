import { prisma } from '@/lib/prisma'
import { computeAccessLevel, type AccessLevel } from '@/lib/tenant-context'
import { computeSaasMetrics, type SaasMetrics } from './metrics'

/**
 * Consultas del Panel Maestro (§5.3).
 *
 * ⚠️ EXCEPCIÓN AUTORIZADA a la regla de oro (§3): estas consultas cruzan
 * tenants a propósito, usando el cliente base. Es la única excepción de
 * lectura del sistema y por eso vive aislada en su propio módulo, detrás de
 * `requireSuperAdmin()`. Ninguna de estas funciones debe importarse jamás
 * desde código del dashboard de cliente.
 */

export interface TenantRow {
  id: string
  name: string
  slug: string
  planName: string | null
  status: string
  access: AccessLevel
  isActive: boolean
  suspendedReason: string | null
  trialEndsAt: Date | null
  currentPeriodEnd: Date | null
  users: number
  products: number
  createdAt: Date
}

export interface SuperAdminDashboard {
  metrics: SaasMetrics
  tenants: TenantRow[]
}

export async function getSuperAdminDashboard(
  now: Date = new Date(),
): Promise<SuperAdminDashboard> {
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      suspendedReason: true,
      createdAt: true,
      plan: { select: { name: true, priceMonthly: true } },
      subscription: {
        select: {
          status: true,
          trialEndsAt: true,
          pastDueSince: true,
          graceDays: true,
          currentPeriodEnd: true,
          canceledAt: true,
          plan: { select: { name: true, priceMonthly: true } },
        },
      },
      _count: { select: { users: true, products: true } },
    },
  })

  const filas = tenants.map((t) => {
    // El plan de la SUSCRIPCIÓN manda sobre el cacheado en Tenant: es el que
    // el webhook mantiene al día, y por tanto el que se está cobrando.
    const plan = t.subscription?.plan ?? t.plan
    return {
      tenant: t,
      plan,
      access: computeAccessLevel(t, t.subscription ?? null, now),
    }
  })

  return {
    metrics: computeSaasMetrics(
      filas.map(({ tenant, plan }) => ({
        status: tenant.subscription?.status ?? 'CANCELED',
        isActive: tenant.isActive,
        priceMonthly: plan?.priceMonthly.toString() ?? '0',
        createdAt: tenant.createdAt,
        canceledAt: tenant.subscription?.canceledAt ?? null,
      })),
      now,
    ),
    tenants: filas.map(({ tenant, plan, access }) => ({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      planName: plan?.name ?? null,
      status: tenant.subscription?.status ?? 'SIN SUSCRIPCIÓN',
      access,
      isActive: tenant.isActive,
      suspendedReason: tenant.suspendedReason,
      trialEndsAt: tenant.subscription?.trialEndsAt ?? null,
      currentPeriodEnd: tenant.subscription?.currentPeriodEnd ?? null,
      users: tenant._count.users,
      products: tenant._count.products,
      createdAt: tenant.createdAt,
    })),
  }
}

/** Últimas acciones sensibles, para que la torre de control se vigile a sí misma. */
export async function getRecentAuditLog(limit = 25) {
  return prisma.auditLog.findMany({
    where: { action: { in: ['tenant.suspend', 'tenant.reactivate', 'impersonation.start', 'impersonation.end'] } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      action: true,
      actorEmail: true,
      reason: true,
      createdAt: true,
      tenant: { select: { name: true } },
    },
  })
}
