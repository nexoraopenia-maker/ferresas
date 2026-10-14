import { cookies } from 'next/headers'
import { auth } from '@/auth'
import { prisma } from './prisma'
import {
  IMPERSONATION_COOKIE,
  resolveImpersonation,
  type ActiveImpersonation,
} from './impersonation'
import { computeAccessLevel, type TenantContext } from './tenant-context'
import { BusinessError, TenantIsolationError } from './errors'
import type { RouteSession } from './route-access'

/**
 * Resolución de sesión → contexto autorizado.
 *
 * Este es el ÚNICO punto donde se decide a qué tenant pertenece una petición
 * y qué puede hacer. El userId sale del JWT firmado por NextAuth; todo lo
 * demás — tenantId, rol, estado de la cuenta — se lee de la base en cada
 * petición, para que un cambio de plan o de rol surta efecto de inmediato
 * (ver la nota en src/auth.ts).
 *
 * Usa el cliente base a propósito: es la consulta que ocurre ANTES de que
 * exista contexto de tenant, así que no puede pasar por getTenantPrisma().
 */

const USER_SELECT = {
  id: true,
  role: true,
  isActive: true,
  deletedAt: true,
  tenantId: true,
  passwordChangedAt: true,
  tenant: {
    select: {
      isActive: true,
      subscription: {
        select: {
          status: true,
          pastDueSince: true,
          graceDays: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
        },
      },
    },
  },
} as const

/**
 * ¿El token se emitió ANTES del último cambio de contraseña?
 *
 * Con sesiones JWT no hay nada que borrar en el servidor para echar a
 * alguien: el token vale hasta que caduca. Esta comparación es lo que
 * convierte "cambié la contraseña" en "las sesiones abiertas dejan de
 * servir", que es lo que el usuario da por hecho al cambiarla.
 *
 * Se resta un segundo de margen porque `iat` va en segundos enteros y
 * `passwordChangedAt` en milisegundos: sin el margen, la propia sesión que
 * acaba de cambiar la contraseña se invalidaría a sí misma.
 */
function sesionRevocada(
  passwordChangedAt: Date | null,
  issuedAt: number | undefined,
): boolean {
  if (!passwordChangedAt) return false
  if (issuedAt === undefined) return false
  return issuedAt * 1000 < passwordChangedAt.getTime() - 1000
}

/**
 * Datos mínimos para decidir el enrutado. Devuelve `null` en vez de lanzar:
 * el proxy necesita distinguir "no hay sesión" de "algo falló".
 */
export async function getRouteSession(
  userId: string,
  impersonationId?: string,
  now: Date = new Date(),
  issuedAt?: number,
): Promise<RouteSession | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: USER_SELECT,
  })

  if (!user || !user.isActive || user.deletedAt) return null
  if (sesionRevocada(user.passwordChangedAt, issuedAt)) return null

  // Impersonation en curso: el enrutado debe verse como el del cliente, pero
  // conservando el rastro de quién está detrás.
  if (user.role === 'SUPERADMIN' && impersonationId) {
    const imp = await resolveImpersonation(user.id, impersonationId, now)
    if (imp) {
      const suplantado = await cargarContextoSuplantado(imp, now)
      if (suplantado) {
        return {
          userId: suplantado.userId,
          tenantId: imp.tenantId,
          role: suplantado.role,
          // Ver la nota de src/lib/impersonation.ts: el soporte no escribe.
          access: 'READ_ONLY',
          impersonatorId: user.id,
        }
      }
    }
  }

  return {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    // Un SUPERADMIN no tiene tenant y por tanto no tiene estado de cuenta.
    access: user.tenant
      ? computeAccessLevel(user.tenant, user.tenant.subscription, now)
      : 'FULL',
  }
}

/**
 * Resuelve a quién se está suplantando. Si no se fijó un usuario concreto se
 * toma el OWNER del tenant: es quien más permisos tiene y por tanto el que
 * más superficie deja ver al soporte.
 */
async function cargarContextoSuplantado(
  imp: ActiveImpersonation,
  now: Date,
): Promise<{ userId: string; role: TenantContext['role'] } | null> {
  const objetivo = imp.targetUserId
    ? await prisma.user.findFirst({
        where: { id: imp.targetUserId, tenantId: imp.tenantId, isActive: true, deletedAt: null },
        select: { id: true, role: true },
      })
    : await prisma.user.findFirst({
        where: { tenantId: imp.tenantId, role: 'OWNER', isActive: true, deletedAt: null },
        select: { id: true, role: true },
        orderBy: { createdAt: 'asc' },
      })

  void now
  return objetivo ? { userId: objetivo.id, role: objetivo.role } : null
}

export async function resolveTenantContext(
  userId: string,
  now: Date = new Date(),
  issuedAt?: number,
): Promise<TenantContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: USER_SELECT,
  })

  if (!user || !user.isActive || user.deletedAt) {
    throw new TenantIsolationError('Sesión no válida.')
  }
  if (sesionRevocada(user.passwordChangedAt, issuedAt)) {
    throw new BusinessError(
      'UNAUTHENTICATED',
      'Tu contraseña cambió. Vuelve a iniciar sesión.',
    )
  }

  // Un SUPERADMIN no opera dentro de un tenant: entra por el módulo auditado
  // de /superadmin, o vía impersonation (que sí produce un tenantId).
  if (!user.tenantId || !user.tenant) {
    throw new TenantIsolationError('Sesión sin negocio asociado.')
  }

  return {
    tenantId: user.tenantId,
    userId: user.id,
    role: user.role,
    access: computeAccessLevel(user.tenant, user.tenant.subscription, now),
  }
}

/**
 * Contexto de tenant de la petición en curso. Lo usan las Server Actions.
 * Lanza si no hay sesión: una Server Action nunca debe continuar "por si
 * acaso" sin saber quién la invoca.
 */
export async function requireTenantContext(): Promise<TenantContext> {
  const session = await auth()
  if (!session?.user?.id) {
    throw new BusinessError('UNAUTHENTICATED', 'Tu sesión expiró. Vuelve a iniciar sesión.')
  }

  const impersonationId = (await cookies()).get(IMPERSONATION_COOKIE)?.value
  if (impersonationId) {
    const imp = await resolveImpersonation(session.user.id, impersonationId)
    if (imp) {
      const suplantado = await cargarContextoSuplantado(imp, new Date())
      if (suplantado) {
        return {
          tenantId: imp.tenantId,
          userId: suplantado.userId,
          role: suplantado.role,
          access: 'READ_ONLY',
          impersonationId: imp.id,
        }
      }
    }
  }

  return resolveTenantContext(session.user.id, new Date(), session.issuedAt)
}

/** Sesión de SUPERADMIN real, ignorando cualquier impersonation en curso. */
export async function requireSuperAdmin(): Promise<{ id: string; email: string }> {
  const session = await auth()
  if (!session?.user?.id) {
    throw new BusinessError('UNAUTHENTICATED', 'Sesión no válida.')
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true, email: true, role: true, isActive: true,
      deletedAt: true, passwordChangedAt: true,
    },
  })

  if (!user || user.role !== 'SUPERADMIN' || !user.isActive || user.deletedAt) {
    throw new TenantIsolationError('Recurso no disponible.')
  }
  // Un token anterior al cambio de contraseña no sirve ni siquiera aquí: es
  // precisamente la cuenta cuyo robo más daño haría.
  if (sesionRevocada(user.passwordChangedAt, session.issuedAt)) {
    throw new TenantIsolationError('Recurso no disponible.')
  }

  return { id: user.id, email: user.email }
}
