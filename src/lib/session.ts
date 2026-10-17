import { cache } from 'react'
import { cookies } from 'next/headers'
import { auth } from '@/auth'
import { prisma } from './prisma'
import {
  resolveImpersonation,
  type ActiveImpersonation,
} from './impersonation'
import { computeAccessLevel, type TenantContext } from './tenant-context'
import { BRANCH_COOKIE, resolverSucursalActiva } from './branch-selection'
import { SUPPORT_COOKIE, verificarSupportToken } from './support-token'
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
  /*
   * Sucursales asignadas. Van en la MISMA consulta que ya resolvía la sesión
   * en lugar de en una aparte: el proxy corre antes de cada petición y Neon
   * suspende el cómputo por inactividad, así que una segunda consulta aquí
   * se paga en latencia en el camino crítico de cada navegación.
   *
   * Solo las vigentes: una sucursal dada de baja no se puede operar aunque
   * la asignación siga en la tabla puente.
   */
  branches: {
    where: { branch: { deletedAt: null, isActive: true } },
    select: { branch: { select: { id: true, code: true, isDefault: true } } },
  },
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
    /*
     * UNA sola sentencia con LATERAL JOIN, en lugar de una consulta por
     * relación anidada.
     *
     * Medido: sin esto, esta consulta cuesta 3,2 idas y vueltas porque
     * Prisma la parte en tres (usuario, tenant+suscripción, sucursales).
     * Corre en CADA navegación, así que es el gasto más repetido de la app.
     * En producción pasa de 45 ms a ~15 ms.
     */
    relationLoadStrategy: 'join',
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
): Promise<
  { userId: string; role: TenantContext['role']; branchId?: string } | null
> {
  /*
   * Se traen también las sucursales del suplantado. El soporte tiene que ver
   * lo MISMO que el cliente: sin sucursal, el POS y el inventario saldrían
   * vacíos y el técnico diagnosticaría un problema que no existe.
   */
  const select = {
    id: true,
    role: true,
    branches: {
      where: { branch: { deletedAt: null, isActive: true } },
      select: { branch: { select: { id: true, code: true, isDefault: true } } },
    },
  } as const

  const objetivo = imp.targetUserId
    ? await prisma.user.findFirst({
        where: { id: imp.targetUserId, tenantId: imp.tenantId, isActive: true, deletedAt: null },
        select,
        relationLoadStrategy: 'join',
      })
    : await prisma.user.findFirst({
        where: { tenantId: imp.tenantId, role: 'OWNER', isActive: true, deletedAt: null },
        select,
        relationLoadStrategy: 'join',
        orderBy: { createdAt: 'asc' },
      })

  void now
  if (!objetivo) return null
  return {
    userId: objetivo.id,
    role: objetivo.role,
    branchId: resolverSucursalActiva(objetivo.branches.map((ub) => ub.branch)),
  }
}

export async function resolveTenantContext(
  userId: string,
  now: Date = new Date(),
  issuedAt?: number,
  /** Sucursal pedida por el selector. Es una sugerencia: se valida contra lo asignado. */
  branchPedida?: string,
): Promise<TenantContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: USER_SELECT,
    /*
     * UNA sola sentencia con LATERAL JOIN, en lugar de una consulta por
     * relación anidada.
     *
     * Medido: sin esto, esta consulta cuesta 3,2 idas y vueltas porque
     * Prisma la parte en tres (usuario, tenant+suscripción, sucursales).
     * Corre en CADA navegación, así que es el gasto más repetido de la app.
     * En producción pasa de 45 ms a ~15 ms.
     */
    relationLoadStrategy: 'join',
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
    branchId: resolverSucursalActiva(
      user.branches.map((ub) => ub.branch),
      branchPedida,
    ),
  }
}

/**
 * Contexto de tenant de la petición en curso, MEMOIZADO por render.
 *
 * Lo usan las Server Actions y las páginas. Lanza si no hay sesión: una
 * Server Action nunca debe continuar "por si acaso" sin saber quién la
 * invoca.
 *
 * ─── POR QUÉ ────────────────────────────────────────────────────────────
 *
 * La sesión se resolvía TRES veces por navegación: una en el proxy, una en
 * el layout del dashboard y una en la página. Son tres consultas idénticas
 * —`USER_SELECT` con el join de sucursales— y cada una cuesta una ida y
 * vuelta completa a la base.
 *
 * Medido: 605 ms por ida y vuelta desde un portátil a Neon en us-east-2, y
 * 21-60 ms desde Vercel. O sea entre 120 ms y 1,8 s de latencia puramente
 * redundante en cada clic del menú, antes de que la página consulte NADA de
 * lo suyo.
 *
 * `cache()` de React deduplica dentro del mismo pase de render, así que
 * layout y página comparten una sola consulta. El proxy corre en otro
 * contexto —antes del render— y no entra en esa caché: ahí siguen siendo
 * dos, no tres. Compartirlo con el proxy exigiría pasar la sesión por una
 * cabecera, y eso introduce una frontera de confianza que no compensa por
 * una consulta.
 *
 * La memoización NO relaja la seguridad: el alcance es UNA petición. Un
 * cambio de rol sigue surtiendo efecto en la navegación siguiente, que es
 * exactamente la garantía que se buscaba al leer el rol de la base en vez
 * del JWT.
 */
export const requireTenantContext = cache(requireTenantContextSinCache)

async function requireTenantContextSinCache(): Promise<TenantContext> {
  const session = await auth()
  if (!session?.user?.id) {
    throw new BusinessError('UNAUTHENTICATED', 'Tu sesión expiró. Vuelve a iniciar sesión.')
  }

  /*
   * Se verifica la FIRMA y la caducidad antes de molestar a la base. Un token
   * manipulado o vencido se descarta aquí; que la sesión siga abierta lo
   * comprueba `resolveImpersonation` contra la base, porque eso la firma no
   * lo puede saber.
   */
  const impersonationId = verificarSupportToken(
    (await cookies()).get(SUPPORT_COOKIE)?.value,
  )?.id
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
          branchId: suplantado.branchId,
          impersonationId: imp.id,
        }
      }
    }
  }

  return resolveTenantContext(
    session.user.id,
    new Date(),
    session.issuedAt,
    (await cookies()).get(BRANCH_COOKIE)?.value,
  )
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
