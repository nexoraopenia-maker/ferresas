import type { Role, SubscriptionStatus } from '@/generated/prisma/enums'

/**
 * Nivel de acceso efectivo del tenant (§5.2 — bloqueo progresivo).
 * Se calcula SIEMPRE en el servidor. La UI lo usa para pintar banners,
 * pero el enforcement real vive en tenant-prisma.ts.
 */
export type AccessLevel = 'FULL' | 'WARN' | 'READ_ONLY' | 'BLOCKED'

export interface TenantContext {
  tenantId: string
  userId: string
  role: Role
  access: AccessLevel
  /** Presente solo si un SUPERADMIN está impersonando (§5.3). */
  impersonationId?: string
}

export interface SubscriptionSnapshot {
  status: SubscriptionStatus
  pastDueSince: Date | null
  graceDays: number
  trialEndsAt: Date | null
  currentPeriodEnd: Date | null
}

/**
 * Función PURA — el corazón de la monetización, y por eso testeable sin BD
 * (§8: "transiciones de estado de suscripción").
 *
 * Escalera de bloqueo:
 *   tenant suspendido por el Super Admin  -> BLOCKED  (manda sobre todo)
 *   CANCELED                              -> READ_ONLY
 *   PAST_DUE dentro de la gracia          -> WARN     (banner, sigue operando)
 *   PAST_DUE pasada la gracia             -> READ_ONLY
 *   TRIALING vencido                      -> READ_ONLY
 *   ACTIVE / TRIALING vigente             -> FULL
 *
 * READ_ONLY (no BLOCKED) es deliberado para la mora: un ferretero que no pagó
 * debe poder seguir consultando su inventario y exportar sus datos. Cortarle
 * el acceso a su propia información convierte un problema de cobranza en una
 * disputa. BLOCKED queda reservado para suspensión explícita por abuso.
 */
export function computeAccessLevel(
  tenant: { isActive: boolean },
  subscription: SubscriptionSnapshot | null,
  now: Date,
): AccessLevel {
  if (!tenant.isActive) return 'BLOCKED'
  if (!subscription) return 'READ_ONLY'

  switch (subscription.status) {
    case 'CANCELED':
      return 'READ_ONLY'

    case 'PAST_DUE': {
      if (!subscription.pastDueSince) return 'WARN'
      const graceMs = subscription.graceDays * 24 * 60 * 60 * 1000
      const deadline = subscription.pastDueSince.getTime() + graceMs
      return now.getTime() <= deadline ? 'WARN' : 'READ_ONLY'
    }

    case 'TRIALING': {
      if (!subscription.trialEndsAt) return 'FULL'
      return now <= subscription.trialEndsAt ? 'FULL' : 'READ_ONLY'
    }

    case 'ACTIVE': {
      // Si el webhook de renovación se perdió, el período vencido NO corta el
      // servicio: se degrada a WARN y se resuelve por reconciliación. Cortar
      // por un webhook perdido castiga a un cliente que sí pagó.
      if (subscription.currentPeriodEnd && now > subscription.currentPeriodEnd) {
        return 'WARN'
      }
      return 'FULL'
    }

    default:
      return 'READ_ONLY'
  }
}

/** Jerarquía de roles para las comprobaciones de autorización (§6.4). */
const ROLE_RANK: Record<Role, number> = {
  SUPERADMIN: 100,
  OWNER: 80,
  ADMIN: 60,
  ALMACENERO: 40,
  VENDEDOR: 20,
}

export function hasRole(actual: Role, minimum: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[minimum]
}
