import { BusinessError } from '@/lib/errors'
import { prisma } from '@/lib/prisma'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { puedeCambiarPassword } from '@/features/usuarios/asignacion'

/**
 * Sesiones por dispositivo.
 *
 * Cada inicio de sesión crea una `DeviceSession` y su id (`sid`) viaja en el
 * JWT. El JWT no se puede «borrar», pero SÍ se puede dejar de aceptar: cada
 * petición comprueba, en la misma consulta que ya resuelve al usuario, que su
 * `sid` siga vivo. Revocar una sesión surte efecto en la siguiente navegación
 * o acción, y eso incluye las que escriben dinero: cada Server Action resuelve
 * el contexto de nuevo.
 *
 * Los JWT emitidos antes de que existiera esto no llevan `sid` y se aceptan
 * hasta que caduquen (12 h); no hay forma de revocarlos salvo cambiar la
 * contraseña.
 */

/** Duración máxima de una sesión (igual que `session.maxAge` de Auth.js). */
export const VIDA_SESION_MS = 12 * 60 * 60 * 1000
/** Cada cuánto se actualiza «visto por última vez»: escribir en cada clic no compensa. */
export const TOQUE_CADA_MS = 5 * 60_000

/** «Chrome · Windows», sin ser exhaustivo: es para reconocer el dispositivo, no para analizarlo. */
export function describirDispositivo(ua: string | null | undefined): string {
  if (!ua) return 'Dispositivo desconocido'
  const nav =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Navegador'
  const so =
    /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'sistema desconocido'
  return `${nav} · ${so}`
}

export async function registrarDispositivo(i: {
  userId: string
  tenantId: string | null
  userAgent: string | null
  ip: string | null
}): Promise<string> {
  const tenantId =
    i.tenantId ?? (await prisma.user.findUnique({ where: { id: i.userId }, select: { tenantId: true } }))?.tenantId ?? null
  const d = await prisma.deviceSession.create({
    data: {
      userId: i.userId, tenantId,
      userAgent: i.userAgent?.slice(0, 300) ?? null, ip: i.ip?.slice(0, 64) ?? null,
    },
    select: { id: true },
  })
  return d.id
}

/** Marca «visto» sin escribir en cada petición. No lanza: es accesorio. */
export async function tocarDispositivo(sid: string, ultimaVez: Date, ahora: Date = new Date()): Promise<void> {
  if (ahora.getTime() - ultimaVez.getTime() < TOQUE_CADA_MS) return
  await prisma.deviceSession.updateMany({ where: { id: sid, revokedAt: null }, data: { lastSeenAt: ahora } }).catch(() => {})
}

export interface DispositivoVista {
  id: string
  descripcion: string
  ip: string | null
  creadaEn: Date
  vistaEn: Date
  actual: boolean
}

/** Sesiones VIVAS (no revocadas y dentro de su vida útil) de un usuario. */
export async function listarDispositivos(
  userId: string,
  sidActual: string | undefined,
  ahora: Date = new Date(),
): Promise<DispositivoVista[]> {
  const filas = await prisma.deviceSession.findMany({
    where: { userId, revokedAt: null, createdAt: { gte: new Date(ahora.getTime() - VIDA_SESION_MS) } },
    orderBy: { lastSeenAt: 'desc' },
    take: 50,
    select: { id: true, userAgent: true, ip: true, createdAt: true, lastSeenAt: true },
  })
  return filas.map((f) => ({
    id: f.id, descripcion: describirDispositivo(f.userAgent), ip: f.ip,
    creadaEn: f.createdAt, vistaEn: f.lastSeenAt, actual: f.id === sidActual,
  }))
}

/** Cierra UNA sesión del propio usuario. `false` si no era suya o ya estaba cerrada. */
export async function cerrarDispositivo(
  userId: string,
  deviceId: string,
  ahora: Date = new Date(),
): Promise<boolean> {
  const r = await prisma.deviceSession.updateMany({
    // El `userId` en el filtro es lo que impide cerrar la sesión de otro por id.
    where: { id: deviceId, userId, revokedAt: null },
    data: { revokedAt: ahora, revokedById: userId },
  })
  return r.count === 1
}

/** Cierra todas las del usuario menos la actual («cerrar las demás»). */
export async function cerrarOtrosDispositivos(
  userId: string,
  sidActual: string | undefined,
  ahora: Date = new Date(),
): Promise<number> {
  const r = await prisma.deviceSession.updateMany({
    where: { userId, revokedAt: null, ...(sidActual ? { id: { not: sidActual } } : {}) },
    data: { revokedAt: ahora, revokedById: userId },
  })
  return r.count
}

/** Al cerrar sesión se revoca su registro, para que el JWT, si alguien lo conservara, no valga. */
export async function cerrarSesionActual(sid: string | undefined, ahora: Date = new Date()): Promise<void> {
  if (!sid) return
  await prisma.deviceSession.updateMany({ where: { id: sid, revokedAt: null }, data: { revokedAt: ahora } }).catch(() => {})
}

/**
 * Un dueño o administrador cierra TODAS las sesiones de un miembro del equipo
 * (un teléfono perdido, un empleado que se va). Mismo límite de poder que
 * cambiar su contraseña: la propia y las de quien tenga menos poder.
 */
export async function cerrarSesionesDeUsuario(
  db: TenantPrismaClient,
  ctx: TenantContext,
  userId: string,
  ahora: Date = new Date(),
): Promise<number> {
  exigir(ctx, 'usuarios.gestionar')
  const objetivo = await db.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, role: true, extraRoles: true },
  })
  if (!objetivo) throw new BusinessError('NOT_FOUND', 'El usuario no existe.')
  if (!puedeCambiarPassword(ctx, objetivo)) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No puedes cerrar las sesiones de este usuario: es el dueño o tiene más poder que tú.')
  }
  const r = await prisma.deviceSession.updateMany({
    where: { userId: objetivo.id, revokedAt: null },
    data: { revokedAt: ahora, revokedById: ctx.userId },
  })
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
      action: 'sesion.cerrar_todas', entityType: 'User', entityId: objetivo.id,
      after: { cerradas: r.count },
      impersonationId: ctx.impersonationId ?? null,
    },
  })
  return r.count
}
