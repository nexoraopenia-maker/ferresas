import type { Role, SubscriptionStatus } from '@/generated/prisma/enums'
import { BusinessError } from './errors'

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
  /**
   * Sucursal en la que está operando el usuario.
   *
   * Se resuelve en el servidor a partir de las sucursales que tiene
   * asignadas, nunca desde el cliente: si viniera en el cuerpo de la
   * petición, un cajero podría emitir con la serie de otro local y
   * contaminar los correlativos de un establecimiento al que no pertenece.
   *
   * Opcional en el tipo porque el SUPERADMIN y los flujos que no operan
   * sobre una sucursal concreta (facturación de la cuenta, catálogo global)
   * no la necesitan. Los servicios que SÍ la necesitan la exigen con
   * `requireBranch()` y fallan claro si falta, en vez de inventar una.
   */
  branchId?: string
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

/**
 * Jerarquía de roles para las comprobaciones de autorización (§6.4).
 *
 * EXPORTADA a propósito: `nav-items.ts` tenía su propia copia, y una copia
 * de esta tabla es una bomba de relojería — el día que se añade un rol, el
 * menú le asigna rango 0 en silencio y el usuario nuevo no ve ninguna
 * sección sin que nada falle.
 */
export const ROLE_RANK: Record<Role, number> = {
  SUPERADMIN: 100,
  OWNER: 80,
  ADMIN: 60,
  ALMACENERO: 40,
  VENDEDOR: 20,
  /*
   * CAJERO y CONTADOR entran a 0, y es deliberado.
   *
   * No caben en una escalera: el CONTADOR ve reportes y comprobantes pero no
   * vende ni toca stock — no está «por encima» ni «por debajo» del cajero,
   * está al lado. Cualquier número sería mentira, y esa mentira es justo lo
   * que motivó sustituir esta tabla por permisos nombrados
   * (`src/lib/permisos.ts`).
   *
   * Cero significa «denegar todo» en `hasRole`, que es el valor SEGURO
   * mientras la escalera siga viva: un rol sin rango legítimo no obtiene
   * nada por descuido. Y hoy no afecta a nadie, porque todavía no hay forma
   * de asignar estos roles.
   *
   * Esta tabla y `hasRole` se eliminan al cablear `puede()` en los 29 sitios.
   */
  CAJERO: 0,
  CONTADOR: 0,
}

export function hasRole(actual: Role, minimum: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[minimum]
}

/**
 * Exige que el contexto traiga una sucursal activa.
 *
 * Existe para que ningún servicio tenga que decidir qué hacer cuando falta:
 * sin sucursal no se puede elegir la serie del documento, y elegir una "por
 * defecto" en silencio es exactamente cómo se emiten comprobantes con la
 * serie del local equivocado.
 */
export function requireBranch(ctx: TenantContext): string {
  if (!ctx.branchId) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'No tienes una sucursal asignada. Pide a un administrador que te asigne una.',
    )
  }
  return ctx.branchId
}
