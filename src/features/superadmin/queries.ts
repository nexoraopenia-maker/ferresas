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
  // --- Contacto ---
  /** Correo del usuario OWNER: el que de verdad sirve para entrar. */
  ownerEmail: string | null
  ownerName: string | null
  /** Correo de la ficha de la ferretería; puede diferir del del dueño. */
  billingEmail: string | null
  phone: string | null
  taxId: string | null
  // --- Facturación ---
  planCode: string | null
  planName: string | null
  priceMonthly: string | null
  currency: string
  status: string
  access: AccessLevel
  provider: string | null
  trialEndsAt: Date | null
  currentPeriodEnd: Date | null
  pastDueSince: Date | null
  graceDays: number | null
  lastPaymentAt: Date | null
  lastPaymentAmount: string | null
  cancelAtPeriodEnd: boolean
  /** true si el cobro vive en una pasarela; false si es alta manual. */
  gatewayLinked: boolean
  // --- Estado y uso ---
  isActive: boolean
  suspendedReason: string | null
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
      email: true,
      phone: true,
      taxId: true,
      plan: { select: { code: true, name: true, priceMonthly: true, currency: true } },
      subscription: {
        select: {
          status: true,
          trialEndsAt: true,
          pastDueSince: true,
          graceDays: true,
          currentPeriodEnd: true,
          canceledAt: true,
          cancelAtPeriodEnd: true,
          provider: true,
          externalSubscriptionId: true,
          lastPaymentAt: true,
          lastPaymentAmount: true,
          plan: { select: { code: true, name: true, priceMonthly: true, currency: true } },
        },
      },
      // El OWNER se trae en la misma consulta en vez de una por fila: con
      // cien clientes, lo segundo serían cien viajes a Neon.
      users: {
        where: { role: 'OWNER', deletedAt: null },
        select: { email: true, name: true },
        orderBy: { createdAt: 'asc' },
        take: 1,
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
    tenants: filas.map(({ tenant, plan, access }) => {
      const sub = tenant.subscription
      const owner = tenant.users[0]
      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        ownerEmail: owner?.email ?? null,
        ownerName: owner?.name ?? null,
        billingEmail: tenant.email,
        phone: tenant.phone,
        taxId: tenant.taxId,
        planCode: plan?.code ?? null,
        planName: plan?.name ?? null,
        priceMonthly: plan?.priceMonthly.toFixed(2) ?? null,
        currency: plan?.currency ?? 'PEN',
        status: sub?.status ?? 'SIN SUSCRIPCIÓN',
        access,
        provider: sub?.provider ?? null,
        trialEndsAt: sub?.trialEndsAt ?? null,
        currentPeriodEnd: sub?.currentPeriodEnd ?? null,
        pastDueSince: sub?.pastDueSince ?? null,
        graceDays: sub?.graceDays ?? null,
        lastPaymentAt: sub?.lastPaymentAt ?? null,
        lastPaymentAmount: sub?.lastPaymentAmount?.toFixed(2) ?? null,
        cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
        gatewayLinked: Boolean(sub?.externalSubscriptionId),
        isActive: tenant.isActive,
        suspendedReason: tenant.suspendedReason,
        users: tenant._count.users,
        products: tenant._count.products,
        createdAt: tenant.createdAt,
      }
    }),
  }
}

/** Últimas acciones sensibles, para que la torre de control se vigile a sí misma. */
export async function getRecentAuditLog(limit = 25) {
  return prisma.auditLog.findMany({
    where: {
      action: {
        in: [
          'tenant.suspend', 'tenant.reactivate',
          'impersonation.start', 'impersonation.end',
          'tenant.create.superadmin', 'tenant.plan.change',
          'tenant.trial.extend', 'superadmin.password.change',
        ],
      },
    },
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
