import { createHash, randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { Role } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import { prisma } from '@/lib/prisma'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { puedeAsignar, puedeCambiarPassword, puedeGestionarA } from './asignacion'
import type {
  AceptarInput, CambiarEstadoInput, CambiarPasswordInput, CambiarRolesInput,
  CrearDirectoInput, InvitarInput,
} from './schemas'

/** Una invitación vale 7 días: lo bastante para un fin de semana de por medio. */
export const VIGENCIA_INVITACION_DIAS = 7

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

const MENSAJE_INVITACION_INVALIDA =
  'Esta invitación no es válida: caducó, ya se usó o fue cancelada. Pide una nueva a quien te invitó.'

async function auditar(
  db: TenantPrismaClient,
  ctx: TenantContext,
  action: string,
  entityId: string,
  data: { before?: Record<string, unknown>; after?: Record<string, unknown> },
) {
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorRole: ctx.role,
      action,
      entityType: 'User',
      entityId,
      before: data.before as never,
      after: data.after as never,
      impersonationId: ctx.impersonationId ?? null,
    },
  })
}

/**
 * Cupo de usuarios del plan: los activos más las invitaciones vivas. Contar
 * las invitaciones evita que un plan de 3 usuarios reparta 10 enlaces y los
 * acepten todos.
 */
async function verificarCupo(
  db: TenantPrismaClient,
  ahora: Date,
  /** Correo cuya invitación viva se va a reemplazar: no cuenta dos veces. */
  reemplaza?: string,
) {
  const tenant = await db.tenant.findFirstOrThrow({
    select: {
      plan: { select: { maxUsers: true, name: true } },
      subscription: { select: { plan: { select: { maxUsers: true, name: true } } } },
    },
  })
  const plan = tenant.subscription?.plan ?? tenant.plan
  if (plan?.maxUsers == null) return

  const [activos, pendientes] = await Promise.all([
    db.user.count({ where: { isActive: true, deletedAt: null } }),
    db.invitation.count({
      where: {
        acceptedAt: null, revokedAt: null, expiresAt: { gt: ahora },
        ...(reemplaza ? { email: { not: reemplaza } } : {}),
      },
    }),
  ])
  if (activos + pendientes + 1 > plan.maxUsers) {
    throw new BusinessError(
      'PLAN_LIMIT_REACHED',
      `Tu plan ${plan.name} permite ${plan.maxUsers} usuarios (contando invitaciones pendientes). ` +
        'Mejora el plan o cancela alguna invitación.',
      { limite: plan.maxUsers, actuales: activos + pendientes },
    )
  }
}

export interface InvitacionCreada {
  id: string
  /** El token en claro. Se devuelve UNA vez: en la base solo queda su hash. */
  token: string
  /** Ruta relativa que se comparte con la persona invitada. */
  enlace: string
  expiresAt: Date
}

export async function invitar(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: InvitarInput,
  ahora: Date = new Date(),
): Promise<InvitacionCreada> {
  exigir(ctx, 'usuarios.gestionar')

  const roles = [input.role, ...input.extraRoles] as Role[]
  if (!puedeAsignar(ctx, roles)) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'No puedes conceder un rol con más poder que el tuyo.',
    )
  }

  // Las sucursales tienen que ser del negocio, estar activas y estar a su
  // alcance: quien invita no reparte locales que él mismo no ve.
  if (input.branchIds.length > 0) {
    const alcance = new Set(ctx.branchIds ?? [])
    const validas = await db.branch.count({
      where: { id: { in: input.branchIds }, isActive: true, deletedAt: null },
    })
    if (validas !== input.branchIds.length || input.branchIds.some((b) => !alcance.has(b))) {
      throw new BusinessError('TENANT_MISMATCH', 'Alguna de las sucursales no está disponible.')
    }
  }

  const yaEsDelEquipo = await db.user.findFirst({
    where: { email: input.email, deletedAt: null },
    select: { id: true },
  })
  if (yaEsDelEquipo) {
    throw new BusinessError('DUPLICATE_CODE', 'Ese correo ya pertenece a tu equipo.')
  }

  await verificarCupo(db, ahora, input.email)

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(ahora.getTime() + VIGENCIA_INVITACION_DIAS * 86_400_000)

  const inv = await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    // Una invitación viva por correo: la nueva anula la anterior, así un
    // enlace viejo reenviado por error deja de abrir la puerta.
    await t.invitation.updateMany({
      where: { email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: ahora },
    })
    const creada = await t.invitation.create({
      data: {
        tenantId: ctx.tenantId,
        email: input.email,
        role: input.role,
        extraRoles: input.extraRoles,
        branchIds: input.branchIds,
        tokenHash: hashToken(token),
        expiresAt,
        invitedById: ctx.userId,
      },
      select: { id: true },
    })
    await auditar(t, ctx, 'usuario.invitar', creada.id, {
      after: { email: input.email, role: input.role, extraRoles: input.extraRoles, branchIds: input.branchIds },
    })
    return creada
  })

  return { id: inv.id, token, enlace: `/invitacion/${token}`, expiresAt }
}

export async function revocarInvitacion(
  db: TenantPrismaClient,
  ctx: TenantContext,
  invitationId: string,
  ahora: Date = new Date(),
): Promise<void> {
  exigir(ctx, 'usuarios.gestionar')
  const r = await db.invitation.updateMany({
    where: { id: invitationId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: ahora },
  })
  if (r.count === 0) {
    throw new BusinessError('NOT_FOUND', 'La invitación no existe o ya no está pendiente.')
  }
  await auditar(db, ctx, 'usuario.invitacion_revocada', invitationId, {})
}

export async function cambiarRoles(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: CambiarRolesInput,
): Promise<void> {
  exigir(ctx, 'usuarios.gestionar')

  const objetivo = await db.user.findFirst({
    where: { id: input.userId, deletedAt: null },
    select: { id: true, role: true, extraRoles: true },
  })
  if (!objetivo) throw new BusinessError('NOT_FOUND', 'El usuario no existe.')

  if (!puedeGestionarA(ctx, objetivo)) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'No puedes modificar a este usuario: es tu propia cuenta, es el dueño, o tiene más poder que tú.',
    )
  }
  const nuevos = [input.role, ...input.extraRoles] as Role[]
  if (!puedeAsignar(ctx, nuevos)) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No puedes conceder un rol con más poder que el tuyo.')
  }

  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    await t.user.update({
      where: { id: objetivo.id },
      data: { role: input.role, extraRoles: input.extraRoles },
    })
    await auditar(t, ctx, 'usuario.cambiar_roles', objetivo.id, {
      before: { role: objetivo.role, extraRoles: objetivo.extraRoles },
      after: { role: input.role, extraRoles: input.extraRoles },
    })
  })
}

export async function cambiarEstado(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: CambiarEstadoInput,
  ahora: Date = new Date(),
): Promise<void> {
  exigir(ctx, 'usuarios.gestionar')

  const objetivo = await db.user.findFirst({
    where: { id: input.userId, deletedAt: null },
    select: { id: true, role: true, extraRoles: true, isActive: true },
  })
  if (!objetivo) throw new BusinessError('NOT_FOUND', 'El usuario no existe.')
  if (!puedeGestionarA(ctx, objetivo)) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'No puedes modificar a este usuario: es tu propia cuenta, es el dueño, o tiene más poder que tú.',
    )
  }
  if (objetivo.isActive === input.activo) return

  if (input.activo) await verificarCupo(db, ahora)

  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    await t.user.update({
      where: { id: objetivo.id },
      data: {
        isActive: input.activo,
        // Desactivar también invalida las sesiones ya abiertas: el `iat` del
        // JWT queda anterior a esta marca (ver `passwordChangedAt`).
        ...(input.activo ? {} : { passwordChangedAt: ahora }),
      },
    })
    await auditar(t, ctx, input.activo ? 'usuario.reactivar' : 'usuario.desactivar', objetivo.id, {
      before: { isActive: objetivo.isActive },
      after: { isActive: input.activo },
    })
  })
}

/**
 * Alta directa: crea la cuenta con una contraseña que pone quien administra,
 * sin esperar a que la persona abra un enlace.
 *
 * Mismas reglas que una invitación: nadie concede más poder del que tiene,
 * las sucursales tienen que estar a su alcance y el cupo del plan manda. La
 * contraseña se guarda con bcrypt y NO se registra en ningún sitio.
 */
export async function crearUsuarioDirecto(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: CrearDirectoInput,
  ahora: Date = new Date(),
): Promise<{ userId: string; email: string }> {
  exigir(ctx, 'usuarios.gestionar')

  const roles = [input.role, ...input.extraRoles] as Role[]
  if (!puedeAsignar(ctx, roles)) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No puedes conceder un rol con más poder que el tuyo.')
  }

  if (input.branchIds.length > 0) {
    const alcance = new Set(ctx.branchIds ?? [])
    const validas = await db.branch.count({
      where: { id: { in: input.branchIds }, isActive: true, deletedAt: null },
    })
    if (validas !== input.branchIds.length || input.branchIds.some((b) => !alcance.has(b))) {
      throw new BusinessError('TENANT_MISMATCH', 'Alguna de las sucursales no está disponible.')
    }
  }

  await verificarCupo(db, ahora, input.email)

  // bcrypt FUERA de la transacción: ~100 ms con coste 12.
  const passwordHash = await bcrypt.hash(input.password, 12)

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      const user = await t.user.create({
        data: {
          tenantId: ctx.tenantId, email: input.email, name: input.name,
          passwordHash, role: input.role, extraRoles: input.extraRoles, emailVerified: ahora,
        },
        select: { id: true, email: true },
      })
      if (input.branchIds.length > 0) {
        await t.userBranch.createMany({
          data: input.branchIds.map((branchId) => ({ tenantId: ctx.tenantId, userId: user.id, branchId })),
        })
      }
      // Una invitación viva a ese correo ya no tiene sentido.
      await t.invitation.updateMany({
        where: { email: input.email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: ahora },
      })
      await auditar(t, ctx, 'usuario.crear_directo', user.id, {
        after: { email: input.email, role: input.role, extraRoles: input.extraRoles, branchIds: input.branchIds },
      })
      return { userId: user.id, email: user.email }
    })
  } catch (e) {
    // El correo es único en toda la plataforma. Mensaje neutro: no se dice si
    // pertenece a otro negocio.
    if (typeof e === 'object' && e && 'code' in e && (e as { code?: string }).code === 'P2002') {
      throw new BusinessError('DUPLICATE_CODE', 'Ese correo no está disponible. Usa otro.')
    }
    throw e
  }
}

/**
 * Pone una contraseña nueva a un usuario (la de otro, o la propia).
 *
 * Fija `passwordChangedAt`, así que TODAS las sesiones abiertas de esa cuenta
 * caen en su próxima navegación (la propia incluida si cambia la suya). La
 * contraseña no se registra: la auditoría guarda quién, a quién y cuándo.
 */
export async function cambiarPasswordUsuario(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: CambiarPasswordInput,
  ahora: Date = new Date(),
): Promise<void> {
  exigir(ctx, 'usuarios.gestionar')

  const objetivo = await db.user.findFirst({
    where: { id: input.userId, deletedAt: null },
    select: { id: true, role: true, extraRoles: true },
  })
  if (!objetivo) throw new BusinessError('NOT_FOUND', 'El usuario no existe.')

  if (!puedeCambiarPassword(ctx, objetivo)) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'No puedes cambiar la contraseña de este usuario: es el dueño o tiene más poder que tú.',
    )
  }

  const passwordHash = await bcrypt.hash(input.password, 12)

  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    await t.user.update({
      where: { id: objetivo.id },
      data: { passwordHash, passwordChangedAt: ahora },
    })
    await auditar(t, ctx, 'usuario.cambiar_password', objetivo.id, {
      after: { passwordChangedAt: ahora.toISOString(), propia: objetivo.id === ctx.userId },
    })
  })
}

export interface MiembroEquipo {
  id: string
  name: string
  email: string
  role: Role
  extraRoles: Role[]
  isActive: boolean
  lastLoginAt: Date | null
  sucursales: string[]
  /** Si el que mira puede cambiarlo o desactivarlo. */
  gestionable: boolean
  /** Si el que mira puede ponerle la contraseña (incluye la propia). */
  puedeCambiarPassword: boolean
  /** Tiene PIN de cajero. Solo se informa SI lo tiene, nunca nada del PIN. */
  tienePin: boolean
  pinBloqueado: boolean
}

export interface InvitacionPendiente {
  id: string
  email: string
  role: Role
  extraRoles: Role[]
  expiresAt: Date
}

/** Equipo del negocio y sus invitaciones vivas. Nunca devuelve hashes. */
export async function listarEquipo(
  db: TenantPrismaClient,
  ctx: TenantContext,
  ahora: Date = new Date(),
): Promise<{ miembros: MiembroEquipo[]; invitaciones: InvitacionPendiente[] }> {
  exigir(ctx, 'usuarios.gestionar')

  const [usuarios, invitaciones] = await Promise.all([
    db.user.findMany({
      where: { deletedAt: null },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: {
        id: true, name: true, email: true, role: true, extraRoles: true,
        isActive: true, lastLoginAt: true, pinHash: true, pinLockedAt: true,
        branches: { select: { branch: { select: { name: true } } } },
      },
      relationLoadStrategy: 'join',
    }),
    db.invitation.findMany({
      where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: ahora } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, role: true, extraRoles: true, expiresAt: true },
    }),
  ])

  return {
    miembros: usuarios.map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, extraRoles: u.extraRoles,
      isActive: u.isActive, lastLoginAt: u.lastLoginAt,
      sucursales: u.branches.map((b) => b.branch.name),
      gestionable: puedeGestionarA(ctx, u),
      puedeCambiarPassword: puedeCambiarPassword(ctx, u),
      tienePin: u.pinHash !== null,
      pinBloqueado: u.pinLockedAt !== null,
    })),
    invitaciones,
  }
}

/**
 * Aceptar una invitación. PÚBLICO: quien llega aquí no tiene sesión.
 *
 * Por eso no usa `getTenantPrisma` (no hay contexto todavía) y por eso lo
 * decide TODO el contenido de la fila, no el cliente: rol, sucursales y
 * negocio salen de la invitación, y la persona solo aporta nombre y
 * contraseña. El token es de un solo uso y se consume con un UPDATE
 * condicional, así dos clics simultáneos no crean dos usuarios.
 */
export async function aceptarInvitacion(
  input: AceptarInput,
  ahora: Date = new Date(),
): Promise<{ userId: string; email: string }> {
  const tokenHash = hashToken(input.token)

  const inv = await prisma.invitation.findUnique({
    where: { tokenHash },
    select: {
      id: true, tenantId: true, email: true, role: true, extraRoles: true, branchIds: true,
      expiresAt: true, acceptedAt: true, revokedAt: true,
      tenant: { select: { isActive: true } },
    },
  })
  if (
    !inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt <= ahora || !inv.tenant.isActive
  ) {
    throw new BusinessError('NOT_FOUND', MENSAJE_INVITACION_INVALIDA)
  }
  // Defensa en profundidad: aunque alguien escribiera la fila a mano, un
  // dueño o un superadmin no nace de una invitación.
  if (!puedeAsignarEnBase([inv.role, ...inv.extraRoles])) {
    throw new BusinessError('NOT_FOUND', MENSAJE_INVITACION_INVALIDA)
  }

  // El correo es único en toda la plataforma. Si ya existe, el mensaje no
  // dice cuál es el motivo para no revelar quién tiene cuenta.
  if (await prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } })) {
    throw new BusinessError('NOT_FOUND', MENSAJE_INVITACION_INVALIDA)
  }

  // bcrypt FUERA de la transacción: ~100 ms con coste 12.
  const passwordHash = await bcrypt.hash(input.password, 12)

  return prisma.$transaction(async (tx) => {
    const consumida = await tx.invitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: ahora } },
      data: { acceptedAt: ahora },
    })
    if (consumida.count !== 1) {
      throw new BusinessError('NOT_FOUND', MENSAJE_INVITACION_INVALIDA)
    }

    const sucursales = inv.branchIds.length
      ? await tx.branch.findMany({
          where: { id: { in: inv.branchIds }, tenantId: inv.tenantId, isActive: true, deletedAt: null },
          select: { id: true },
        })
      : []

    const user = await tx.user.create({
      data: {
        tenantId: inv.tenantId,
        email: inv.email,
        name: input.name,
        passwordHash,
        role: inv.role,
        extraRoles: inv.extraRoles,
        emailVerified: ahora,
      },
      select: { id: true, email: true },
    })
    if (sucursales.length > 0) {
      await tx.userBranch.createMany({
        data: sucursales.map((b) => ({ tenantId: inv.tenantId, userId: user.id, branchId: b.id })),
      })
    }
    await tx.invitation.update({ where: { id: inv.id }, data: { acceptedUserId: user.id } })
    await tx.auditLog.create({
      data: {
        tenantId: inv.tenantId,
        actorId: user.id,
        actorRole: inv.role,
        actorEmail: user.email,
        action: 'usuario.aceptar_invitacion',
        entityType: 'User',
        entityId: user.id,
        after: { role: inv.role, extraRoles: inv.extraRoles, sucursales: sucursales.length } as never,
      },
    })
    return { userId: user.id, email: user.email }
  })
}

/** Lo que una invitación nunca puede contener, sea cual sea quien la creó. */
function puedeAsignarEnBase(roles: readonly Role[]): boolean {
  return roles.every((r) => r !== 'OWNER' && r !== 'SUPERADMIN')
}
