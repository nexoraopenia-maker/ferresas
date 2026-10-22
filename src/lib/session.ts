import { cache } from 'react'
import { cookies } from 'next/headers'
import { auth } from '@/auth'
import { prisma } from './prisma'
import {
  resolveImpersonation,
  type ActiveImpersonation,
} from './impersonation'
import { computeAccessLevel, type TenantContext } from './tenant-context'
import { BRANCH_COOKIE, resolverSucursalActiva, sucursalesPermitidas } from './branch-selection'
import { permisosEfectivos } from './permisos'
import { extrasPorTopes, type TopesDescuento } from './descuentos'
import { SUPPORT_COOKIE, verificarSupportToken } from './support-token'
import { OPERATOR_COOKIE, verificarOperadorToken } from './operator-token'
import { tocarDispositivo } from '@/features/seguridad/dispositivos'
import { BusinessError, TenantIsolationError } from './errors'
import { mfaObligatorio } from '@/features/seguridad/mfa-reglas'
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
  extraRoles: true,
  isActive: true,
  deletedAt: true,
  tenantId: true,
  passwordChangedAt: true,
  mfaEnabledAt: true,
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
/**
 * Lo mismo que `USER_SELECT` más TODAS las sucursales activas del negocio.
 *
 * Solo para armar el contexto completo: el dueño y el administrador alcanzan
 * todas, y eso se decide con los datos de la misma sentencia. Se mantiene
 * aparte para no ensanchar la consulta que corre en el enrutado.
 */
const CONTEXT_SELECT = {
  ...USER_SELECT,
  tenant: {
    select: {
      ...USER_SELECT.tenant.select,
      isDemo: true,
      branches: {
        where: { isActive: true, deletedAt: null },
        select: { id: true, code: true, isDefault: true },
      },
      // Topes de descuento por rol: viajan en la MISMA sentencia (join).
      discountCaps: { select: { role: true, maxPercent: true } },
    },
  },
} as const

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
  {
    userId: string
    role: TenantContext['role']
    roles: TenantContext['role'][]
    branchId?: string
    branchIds: string[]
  } | null
> {
  /*
   * Se traen también las sucursales del suplantado. El soporte tiene que ver
   * lo MISMO que el cliente: sin sucursal, el POS y el inventario saldrían
   * vacíos y el técnico diagnosticaría un problema que no existe.
   */
  const select = {
    id: true,
    role: true,
    extraRoles: true,
    branches: {
      where: { branch: { deletedAt: null, isActive: true } },
      select: { branch: { select: { id: true, code: true, isDefault: true } } },
    },
    tenant: {
      select: {
        branches: {
          where: { isActive: true, deletedAt: null },
          select: { id: true, code: true, isDefault: true },
        },
      },
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
  const permitidas = sucursalesPermitidas(
    objetivo.branches.map((ub) => ub.branch),
    objetivo.tenant?.branches ?? [],
    permisosEfectivos([objetivo.role, ...objetivo.extraRoles]).has('sucursales.gestionar'),
  )
  return {
    userId: objetivo.id,
    role: objetivo.role,
    roles: objetivo.extraRoles,
    branchId: resolverSucursalActiva(permitidas),
    branchIds: permitidas.map((b) => b.id),
  }
}

export async function resolveTenantContext(
  userId: string,
  now: Date = new Date(),
  issuedAt?: number,
  /** Sucursal pedida por el selector. Es una sugerencia: se valida contra lo asignado. */
  branchPedida?: string,
  /**
   * Sesión de dispositivo del JWT. Si viene, tiene que existir y no estar
   * revocada: revocar una sesión surte efecto en la siguiente petición. Sin
   * `sid` (JWT anteriores a las sesiones por dispositivo) no se exige.
   */
  sid?: string,
): Promise<TenantContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ...CONTEXT_SELECT,
      // En la MISMA sentencia (join): comprobar la sesión no añade una ida y vuelta.
      deviceSessions: {
        where: { id: sid ?? '__sin_sid__' },
        select: { revokedAt: true, lastSeenAt: true },
        take: 1,
      },
    },
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
  if (sid) {
    const d = user.deviceSessions[0]
    if (!d || d.revokedAt) {
      throw new BusinessError('UNAUTHENTICATED', 'Esta sesión se cerró. Vuelve a iniciar sesión.')
    }
    // Accesorio y sin esperar: «visto por última vez» (máx. cada 5 min).
    void tocarDispositivo(sid, d.lastSeenAt, now)
  }

  // Un SUPERADMIN no opera dentro de un tenant: entra por el módulo auditado
  // de /superadmin, o vía impersonation (que sí produce un tenantId).
  if (!user.tenantId || !user.tenant) {
    throw new TenantIsolationError('Sesión sin negocio asociado.')
  }

  const topes: TopesDescuento = Object.fromEntries(
    user.tenant.discountCaps.map((c) => [c.role, Number(c.maxPercent)]),
  )

  const permitidas = sucursalesPermitidas(
    user.branches.map((ub) => ub.branch),
    user.tenant.branches,
    permisosEfectivos([user.role, ...user.extraRoles]).has('sucursales.gestionar'),
  )

  return {
    tenantId: user.tenantId,
    userId: user.id,
    role: user.role,
    // Roles adicionales: sus permisos se UNEN a los del principal.
    roles: user.extraRoles,
    access: computeAccessLevel(user.tenant, user.tenant.subscription, now),
    // La cookie del selector es una sugerencia: solo vale si es una de las permitidas.
    branchId: resolverSucursalActiva(permitidas, branchPedida),
    branchIds: permitidas.map((b) => b.id),
    // El tope > 0 de un rol con `ventas.descuento` OPCIONAL (vendedor, cajero) lo activa.
    permisosExtra: extrasPorTopes([user.role, ...user.extraRoles], topes),
    topesDescuento: topes,
    // Rol que exige segundo factor y aún sin activarlo: `requireTenantContext` lo corta.
    // La cuenta demo es pública y de usar y tirar: no se le exige.
    mfaPendiente: !user.tenant.isDemo && mfaObligatorio([user.role, ...user.extraRoles]) && user.mfaEnabledAt === null,
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
          branchIds: suplantado.branchIds,
          roles: suplantado.roles,
          impersonationId: imp.id,
        }
      }
    }
  }

  const jar = await cookies()
  const base = await resolveTenantContext(
    session.user.id,
    new Date(),
    session.issuedAt,
    jar.get(BRANCH_COOKIE)?.value,
    session.sid,
  )

  /*
   * Operador por PIN. La cookie solo vale si está firmada, no ha caducado y
   * está atada a ESTA sesión de dispositivo y a ESTE usuario. Si no se puede
   * aplicar (operador desactivado, PIN quitado o bloqueado, fuera de la
   * sucursal) se ignora en silencio y se sigue con el usuario de la sesión: el
   * fallo seguro es «no hay operador», nunca «hay otro».
   */
  if (base.mfaPendiente) {
    throw new BusinessError(
      'MFA_REQUIRED',
      'Tu rol exige verificación en dos pasos. Actívala para continuar.',
    )
  }

  const op = session.sid ? verificarOperadorToken(jar.get(OPERATOR_COOKIE)?.value) : null
  if (op && op.sid === session.sid && op.sub === session.user.id) {
    const { aplicarOperador } = await import('@/features/seguridad/pin-service')
    const conOperador = await aplicarOperador(base, op.op)
    if (conOperador) return conOperador
  }
  return base
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

/**
 * Identidad de la sesión SIN exigir el segundo factor ya activado.
 *
 * Existe para la pantalla de activación del MFA y sus acciones: quien aún no lo
 * tiene activo no puede pasar `requireTenantContext` (lo corta), pero tiene que
 * poder activarlo. Comprueba lo mismo que el resto —usuario vigente, sesión no
 * revocada— y NO da acceso a ningún dato del negocio.
 */
export async function requireIdentidad(): Promise<{ userId: string }> {
  const session = await auth()
  if (!session?.user?.id) {
    throw new BusinessError('UNAUTHENTICATED', 'Tu sesión expiró. Vuelve a iniciar sesión.')
  }
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      isActive: true, deletedAt: true, passwordChangedAt: true,
      deviceSessions: { where: { id: session.sid ?? '__sin_sid__' }, select: { revokedAt: true }, take: 1 },
    },
  })
  if (!user || !user.isActive || user.deletedAt || sesionRevocada(user.passwordChangedAt, session.issuedAt)) {
    throw new BusinessError('UNAUTHENTICATED', 'Tu sesión expiró. Vuelve a iniciar sesión.')
  }
  if (session.sid && (!user.deviceSessions[0] || user.deviceSessions[0].revokedAt)) {
    throw new BusinessError('UNAUTHENTICATED', 'Esta sesión se cerró. Vuelve a iniciar sesión.')
  }
  return { userId: session.user.id }
}
