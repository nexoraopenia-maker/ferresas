import bcrypt from 'bcryptjs'
import type { Role } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import { prisma } from '@/lib/prisma'
import { exigir, permisosDe } from '@/lib/puede'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { puedeCambiarPassword } from '@/features/usuarios/asignacion'
import { MAX_INTENTOS_PIN, permisosDenegadosAlOperador, validarFormatoPin } from './pin-reglas'

/**
 * PIN de cajero.
 *
 * Identifica a un operador en un dispositivo cuya sesión ya está abierta
 * (ver `pin-reglas.ts` y `operator-token.ts`). Aquí vive lo que toca la base:
 * poner, quitar y desbloquear PIN, verificarlo y construir el contexto del
 * operador.
 */

const MENSAJE_GENERICO = 'El operador o el PIN no son correctos.'

async function auditar(
  db: TenantPrismaClient,
  ctx: TenantContext,
  action: string,
  entityId: string,
  after: Record<string, unknown> = {},
) {
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
      action, entityType: 'User', entityId,
      after: after as never,
      impersonationId: ctx.impersonationId ?? null,
    },
  })
}

async function objetivoGestionable(db: TenantPrismaClient, ctx: TenantContext, userId: string) {
  exigir(ctx, 'usuarios.gestionar')
  const u = await db.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, role: true, extraRoles: true },
  })
  if (!u) throw new BusinessError('NOT_FOUND', 'El usuario no existe.')
  // Mismo límite de poder que cambiar su contraseña: la propia y la de quien tenga menos poder.
  if (!puedeCambiarPassword(ctx, u)) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No puedes gestionar el PIN de este usuario: es el dueño o tiene más poder que tú.')
  }
  return u
}

/** Pone (o reemplaza) el PIN de un usuario. También lo desbloquea y limpia sus fallos. */
export async function establecerPin(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: { userId: string; pin: string },
  ahora: Date = new Date(),
): Promise<void> {
  const u = await objetivoGestionable(db, ctx, input.userId)
  const f = validarFormatoPin(input.pin)
  if (!f.valido) throw new BusinessError('INVALID_DOCUMENT', f.mensaje)

  const pinHash = await bcrypt.hash(input.pin, 12)
  await db.user.update({
    where: { id: u.id },
    data: { pinHash, pinSetAt: ahora, pinFailedAttempts: 0, pinLockedAt: null },
  })
  await auditar(db, ctx, 'pin.establecer', u.id)
}

export async function quitarPin(db: TenantPrismaClient, ctx: TenantContext, userId: string): Promise<void> {
  const u = await objetivoGestionable(db, ctx, userId)
  await db.user.update({
    where: { id: u.id },
    data: { pinHash: null, pinSetAt: null, pinFailedAttempts: 0, pinLockedAt: null },
  })
  await auditar(db, ctx, 'pin.quitar', u.id)
}

/** Solo dueño o administrador (permiso `usuarios.gestionar`), y sobre quien tenga menos poder o sobre sí mismo. */
export async function desbloquearPin(db: TenantPrismaClient, ctx: TenantContext, userId: string): Promise<void> {
  const u = await objetivoGestionable(db, ctx, userId)
  await db.user.update({ where: { id: u.id }, data: { pinFailedAttempts: 0, pinLockedAt: null } })
  await auditar(db, ctx, 'pin.desbloquear', u.id)
}

export interface OperadorVista {
  id: string
  nombre: string
  rol: Role
  bloqueado: boolean
}

/** Quién puede entrar con PIN en esta sucursal: asignados a ella, activos y con PIN puesto. */
export async function listarOperadores(db: TenantPrismaClient, ctx: TenantContext): Promise<OperadorVista[]> {
  const branchId = requireBranch(ctx)
  const filas = await db.user.findMany({
    where: {
      isActive: true, deletedAt: null, pinHash: { not: null },
      branches: { some: { branchId } },
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, role: true, pinLockedAt: true },
  })
  return filas.map((f) => ({ id: f.id, nombre: f.name, rol: f.role, bloqueado: f.pinLockedAt !== null }))
}

export interface OperadorIdentificado { id: string; nombre: string }

/**
 * Verifica el PIN de un operador.
 *
 * ─── POR QUÉ SE CUENTA EL INTENTO ANTES DE COMPARAR ──────────────────────
 *
 * Si se leyera «¿está bloqueado?», se comparara y SOLO DESPUÉS se sumara el
 * fallo, un atacante lanzaría cien intentos a la vez: todos verían «no
 * bloqueado» y se comprobarían los cien. Aquí el intento se RESERVA con un
 * incremento atómico y solo se compara si el contador devuelto es ≤ 5. Con
 * peticiones simultáneas, como mucho 5 PIN distintos llegan a probarse.
 *
 * Los mensajes de error no distinguen «no existe», «no tiene PIN» y «PIN
 * equivocado»: no se revela quién tiene PIN.
 */
export async function verificarPin(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: { userId: string; pin: string },
): Promise<OperadorIdentificado> {
  const branchId = requireBranch(ctx)

  const u = await db.user.findFirst({
    where: {
      id: input.userId, isActive: true, deletedAt: null,
      // Solo quien está asignado a la sucursal ACTIVA.
      branches: { some: { branchId } },
    },
    select: { id: true, name: true, pinHash: true, pinLockedAt: true },
  })
  if (!u || !u.pinHash) throw new BusinessError('FORBIDDEN_ROLE', MENSAJE_GENERICO)

  if (u.pinLockedAt) {
    await auditar(db, ctx, 'pin.rechazado_bloqueado', u.id)
    throw new BusinessError('FORBIDDEN_ROLE', 'Este PIN está bloqueado. Pide a un administrador que lo desbloquee.')
  }

  // Reserva atómica del intento.
  const tras = await db.user.update({
    where: { id: u.id },
    data: { pinFailedAttempts: { increment: 1 } },
    select: { pinFailedAttempts: true },
  })
  const intento = tras.pinFailedAttempts

  if (intento > MAX_INTENTOS_PIN) {
    // Otro intento simultáneo ya agotó los cinco: no se compara nada más.
    await db.user.updateMany({ where: { id: u.id, pinLockedAt: null }, data: { pinLockedAt: new Date() } })
    await auditar(db, ctx, 'pin.rechazado_bloqueado', u.id, { intento })
    throw new BusinessError('FORBIDDEN_ROLE', 'Este PIN está bloqueado. Pide a un administrador que lo desbloquee.')
  }

  const ok = await bcrypt.compare(input.pin, u.pinHash)

  if (!ok) {
    const bloquea = intento >= MAX_INTENTOS_PIN
    if (bloquea) await db.user.updateMany({ where: { id: u.id, pinLockedAt: null }, data: { pinLockedAt: new Date() } })
    await auditar(db, ctx, bloquea ? 'pin.bloqueo' : 'pin.fallo', u.id, { intento, restantes: Math.max(0, MAX_INTENTOS_PIN - intento) })
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      bloquea ? 'PIN incorrecto. Se bloqueó tras 5 intentos: pide a un administrador que lo desbloquee.' : MENSAJE_GENERICO,
      { intentosRestantes: Math.max(0, MAX_INTENTOS_PIN - intento) },
    )
  }

  await db.user.update({ where: { id: u.id }, data: { pinFailedAttempts: 0 } })
  await auditar(db, ctx, 'pin.uso', u.id)
  return { id: u.id, nombre: u.name }
}

/**
 * Contexto del operador sobre la sesión de un dispositivo.
 *
 * Es la parte que importa para la seguridad: la identidad es la del operador
 * (a él se le atribuyen ventas y auditoría), pero los permisos son la
 * INTERSECCIÓN con los de la sesión, menos lo vedado al PIN. Nunca más.
 */
export function contextoDeOperador(
  sesion: TenantContext,
  operador: { id: string; role: Role; extraRoles: readonly Role[] },
): TenantContext {
  const permisosSesion = permisosDe(sesion)
  return {
    ...sesion,
    userId: operador.id,
    role: operador.role,
    roles: [...operador.extraRoles],
    // Se descarta lo que el operador tuviera "extra" o denegado a título personal
    // de la sesión: el operador parte de su rol limpio y se recorta.
    permisosExtra: undefined,
    permisosDenegados: permisosDenegadosAlOperador(permisosSesion),
    // Solo opera en la sucursal activa.
    branchIds: sesion.branchId ? [sesion.branchId] : [],
    operadorDe: sesion.userId,
  }
}

/** Carga al operador y construye el contexto, o `null` si ya no vale (se desactivó, se le quitó el PIN…). */
export async function aplicarOperador(sesion: TenantContext, operadorId: string): Promise<TenantContext | null> {
  if (!sesion.branchId || operadorId === sesion.userId) return null
  const op = await prisma.user.findFirst({
    where: {
      id: operadorId, tenantId: sesion.tenantId, isActive: true, deletedAt: null,
      pinHash: { not: null }, pinLockedAt: null,
      branches: { some: { branchId: sesion.branchId } },
    },
    select: { id: true, role: true, extraRoles: true },
  })
  return op ? contextoDeOperador(sesion, op) : null
}

