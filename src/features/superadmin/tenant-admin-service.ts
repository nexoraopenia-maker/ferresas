import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { BusinessError } from '@/lib/errors'
import { generateTempPassword } from './tenant-service'
import type {
  ResetOwnerPasswordInput,
  UpdateTenantProfileInput,
} from './schemas'

/**
 * Gestión de cuentas de cliente desde la torre de control (§5.3).
 *
 * ⚠️ Cliente base a propósito: estas operaciones cruzan tenants por
 * definición. Viven detrás de `requireSuperAdmin()` y cada una audita con
 * motivo obligatorio.
 */

interface Actor {
  id: string
  email: string
}

export interface ResetResult {
  userEmail: string
  /** Se devuelve UNA vez; en la base solo queda su hash. */
  temporaryPassword: string
}

/**
 * Resetea la contraseña de un usuario de una ferretería.
 *
 * ─── LA GUARDA QUE IMPORTA ───────────────────────────────────────────────
 *
 * Se rechaza si el objetivo es SUPERADMIN. Sin esa comprobación, un
 * superadmin podría resetear la contraseña de OTRO superadmin y quedarse con
 * su cuenta — y como el Super Admin ve todos los tenants, eso es la
 * escalada de privilegios más grave que admite el sistema. Para la propia
 * cuenta existe el modal de "cambiar mi contraseña", que sí exige la actual.
 *
 * Fija `passwordChangedAt`, así que las sesiones abiertas de ese usuario
 * quedan revocadas: si se resetea por sospecha de acceso indebido, dejarlas
 * vivas anularía el sentido.
 */
export async function resetOwnerPassword(
  input: ResetOwnerPasswordInput,
  actor: Actor,
  now: Date = new Date(),
): Promise<ResetResult> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: input.tenantId, deletedAt: null },
    select: { id: true, name: true },
  })
  if (!tenant) throw new BusinessError('TENANT_MISMATCH', 'Cuenta no encontrada.')

  const objetivo = input.userId
    ? await prisma.user.findFirst({
        where: { id: input.userId, tenantId: tenant.id, deletedAt: null },
        select: { id: true, email: true, role: true },
      })
    : await prisma.user.findFirst({
        where: { tenantId: tenant.id, role: 'OWNER', isActive: true, deletedAt: null },
        select: { id: true, email: true, role: true },
        orderBy: { createdAt: 'asc' },
      })

  if (!objetivo) {
    throw new BusinessError(
      'TENANT_MISMATCH',
      'Esa ferretería no tiene un usuario dueño activo.',
    )
  }

  if (objetivo.role === 'SUPERADMIN') {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'No se puede resetear la contraseña de otro Super Admin desde aquí.',
    )
  }

  const temporaryPassword = generateTempPassword()
  const passwordHash = await bcrypt.hash(temporaryPassword, 12)

  await prisma.$transaction([
    prisma.user.update({
      where: { id: objetivo.id },
      data: { passwordHash, passwordChangedAt: now, isActive: true },
    }),
    prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorId: actor.id,
        actorRole: 'SUPERADMIN',
        actorEmail: actor.email,
        action: 'tenant.password.reset',
        entityType: 'User',
        entityId: objetivo.id,
        reason: input.reason,
        // NUNCA se registra la contraseña ni su hash.
        after: { usuario: objetivo.email, sesionesRevocadas: true },
      },
    }),
  ])

  return { userEmail: objetivo.email, temporaryPassword }
}

/**
 * Edita los datos fiscales y de contacto de una ferretería.
 *
 * Solo se tocan los campos presentes en la entrada: un `undefined` significa
 * "no cambiar", mientras que una cadena vacía significa "borrar el dato".
 * Sin esa distinción, editar solo el teléfono borraría el RUC.
 */
export async function updateTenantProfile(
  input: UpdateTenantProfileInput,
  actor: Actor,
): Promise<{ tenantId: string; cambios: string[] }> {
  const antes = await prisma.tenant.findFirst({
    where: { id: input.tenantId, deletedAt: null },
    select: {
      id: true, name: true, legalName: true,
      taxId: true, phone: true, email: true, address: true,
    },
  })
  if (!antes) throw new BusinessError('TENANT_MISMATCH', 'Cuenta no encontrada.')

  const data: Record<string, string | null> = {}
  const cambios: string[] = []

  const campos = ['name', 'legalName', 'taxId', 'phone', 'email', 'address'] as const
  for (const campo of campos) {
    const valor = input[campo]
    if (valor === undefined) continue

    // Cadena vacía = borrar. `name` es obligatorio, así que no se vacía.
    const nuevo = valor === '' ? (campo === 'name' ? null : null) : valor
    if (campo === 'name' && !valor) continue

    if (antes[campo] !== nuevo) {
      data[campo] = nuevo
      cambios.push(campo)
    }
  }

  if (cambios.length === 0) {
    throw new BusinessError('DUPLICATE_CODE', 'No hay ningún cambio que guardar.')
  }

  try {
    await prisma.$transaction([
      prisma.tenant.update({ where: { id: antes.id }, data }),
      prisma.auditLog.create({
        data: {
          tenantId: antes.id,
          actorId: actor.id,
          actorRole: 'SUPERADMIN',
          actorEmail: actor.email,
          action: 'tenant.profile.update',
          entityType: 'Tenant',
          entityId: antes.id,
          reason: input.reason,
          before: Object.fromEntries(cambios.map((c) => [c, antes[c as (typeof campos)[number]]])),
          after: data,
        },
      }),
    ])
  } catch (e) {
    // `taxId` es único por tenant: dos ferreterías no pueden compartir RUC.
    if (
      e instanceof Error &&
      'code' in e &&
      (e as { code?: string }).code === 'P2002'
    ) {
      throw new BusinessError('DUPLICATE_CODE', 'Ese RUC ya está registrado en otra cuenta.')
    }
    throw e
  }

  return { tenantId: antes.id, cambios }
}
