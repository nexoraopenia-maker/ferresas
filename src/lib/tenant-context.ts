import type { Role, SubscriptionStatus } from '@/generated/prisma/enums'
import { BusinessError } from './errors'
import type { Permiso } from './permisos'

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
  /**
   * TODAS las sucursales cuyos datos puede ver y tocar este usuario.
   *
   * `branchId` es en cuál OPERA ahora; esto es hasta dónde LLEGA. El cliente
   * aislado (`getTenantPrisma`) filtra por esta lista las ventas, cotizaciones,
   * turnos de caja, mermas y transferencias, así que un servicio que olvide
   * filtrar por sucursal no filtra datos de un local ajeno.
   *
   * `undefined` = sin restricción de sucursal (flujos que no son de una
   * persona: SUPERADMIN, alta del negocio, scripts). Un contexto de usuario
   * siempre lo trae; `tests/branch-ids.ts` lo comprueba por AST. Vacío (`[]`)
   * = no ve ninguna.
   */
  branchIds?: readonly string[]
  /**
   * Roles ADICIONALES del usuario, además de `role`. Sus permisos se UNEN.
   *
   * Hoy ninguna parte lo rellena —`User.role` es uno solo—, pero el modelo
   * aprobado es «un usuario puede tener varios roles» y la autorización ya
   * tiene que comportarse bien con eso. Existe para poder PROBARLO: la
   * frontera entre permisos se rompe justo con la unión, y no se puede
   * comprobar una unión que el contexto no sabe representar.
   */
  roles?: readonly Role[]
  /**
   * Permisos OPCIONALES que el dueño activó para este usuario.
   *
   * Existen porque hay decisiones de confianza, no de puesto: en una
   * ferretería el cajero puede descontar y en otra no, y acertar por defecto
   * es imposible. Van apagados de fábrica porque conceder de más es peor que
   * tener que pedirlo.
   */
  permisosExtra?: readonly Permiso[]
  /**
   * Permisos quitados a este usuario concreto, pese a su rol.
   *
   * Permite restringir a una persona sin inventar un rol nuevo para ella.
   */
  permisosDenegados?: readonly Permiso[]
  /**
   * Presente cuando un operador entró con su PIN en un dispositivo cuya sesión
   * es de OTRA persona: es el usuario cuya sesión está abierta. `userId` y
   * `role` son los del operador; los permisos nunca superan los de este usuario
   * ni los del operador (ver `src/features/seguridad/pin-reglas.ts`).
   */
  operadorDe?: string
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
