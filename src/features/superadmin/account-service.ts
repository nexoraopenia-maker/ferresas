import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { BusinessError } from '@/lib/errors'
import type { ChangePasswordInput } from './schemas'

/**
 * Cambio de contraseña del Super Admin.
 *
 * Todo ocurre en una transacción: el hash nuevo y la marca
 * `passwordChangedAt` tienen que entrar juntos. Si se escribiera el hash y
 * fallara la marca, la contraseña habría cambiado pero las sesiones viejas
 * seguirían valiendo — el peor de los dos mundos, porque el dueño creería
 * que ha echado al intruso.
 */
export async function changeSuperAdminPassword(
  userId: string,
  input: ChangePasswordInput,
  now: Date = new Date(),
): Promise<{ changedAt: Date }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, passwordHash: true },
  })

  if (!user || user.role !== 'SUPERADMIN') {
    throw new BusinessError('UNAUTHENTICATED', 'Sesión no válida.')
  }

  if (!user.passwordHash) {
    throw new BusinessError(
      'UNAUTHENTICATED',
      'Esta cuenta no tiene contraseña configurada.',
    )
  }

  const correcta = await bcrypt.compare(input.currentPassword, user.passwordHash)
  if (!correcta) {
    // Mensaje específico, a diferencia del login: aquí ya sabemos quién es, no
    // hay nada que enumerar, y decirle "tu contraseña actual no coincide" le
    // ahorra adivinar si el fallo fue en ese campo o en los otros dos.
    throw new BusinessError(
      'UNAUTHENTICATED',
      'Tu contraseña actual no coincide.',
    )
  }

  const passwordHash = await bcrypt.hash(input.newPassword, 12)

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordChangedAt: now },
    }),
    prisma.auditLog.create({
      data: {
        // Sin tenantId: el Super Admin vive fuera de todo tenant.
        actorId: user.id,
        actorRole: 'SUPERADMIN',
        actorEmail: user.email,
        action: 'superadmin.password.change',
        entityType: 'User',
        entityId: user.id,
        // NUNCA se registra ni el hash ni ninguna de las dos contraseñas.
        after: { passwordChangedAt: now.toISOString() },
      },
    }),
  ])

  return { changedAt: now }
}
