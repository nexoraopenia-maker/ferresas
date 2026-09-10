import { prisma } from './prisma'

/**
 * Impersonation para soporte (§5.3).
 *
 * ─── CÓMO SE SOSTIENE LA SEGURIDAD ───────────────────────────────────────
 *
 * La cookie guarda SOLO el id de la fila `ImpersonationSession`. No va
 * firmada, y no hace falta: para que sirva de algo, quien la presente tiene
 * que ser además el SUPERADMIN que la abrió — se comprueba que
 * `superAdminId` coincide con el usuario de la sesión de NextAuth. Robar la
 * cookie sin robar la sesión no da nada.
 *
 * Toda impersonation:
 *   · exige un motivo escrito (§6.6)
 *   · caduca sola (`expiresAt`)
 *   · queda en AuditLog al abrirse y al cerrarse
 *
 * ─── POR QUÉ ES DE SOLO LECTURA ──────────────────────────────────────────
 *
 * Un `StockMovement` guarda `userId`, y durante una impersonation ese userId
 * sería el del EMPLEADO suplantado. Es decir: si el soporte ajustara stock,
 * el registro diría que lo hizo el ferretero. Forensicamente eso es veneno —
 * el día que haya una disputa sobre un inventario descuadrado, el histórico
 * culparía a un inocente.
 *
 * Podría añadirse una columna `impersonationId` a cada tabla de escritura,
 * pero mientras no exista, la respuesta correcta es no escribir. Ver el
 * cliente exactamente como lo ve él resuelve la inmensa mayoría de los casos
 * de soporte, y se consigue reutilizando el enforcement que ya existe:
 * el contexto se fuerza a `access: 'READ_ONLY'` y getTenantPrisma() hace el
 * resto sin una línea de código nueva.
 */

export const IMPERSONATION_COOKIE = 'ferresaas.support'

/** Ventana corta: una sesión de soporte olvidada es una puerta abierta. */
export const IMPERSONATION_MAX_MINUTES = 60

export interface ActiveImpersonation {
  id: string
  tenantId: string
  superAdminId: string
  targetUserId: string | null
}

/**
 * Valida la cookie contra la BD. Devuelve null ante cualquier duda —
 * caducada, cerrada, de otro superadmin, o el tenant ya borrado.
 */
export async function resolveImpersonation(
  superAdminId: string,
  impersonationId: string | undefined,
  now: Date = new Date(),
): Promise<ActiveImpersonation | null> {
  if (!impersonationId) return null

  const row = await prisma.impersonationSession.findUnique({
    where: { id: impersonationId },
    select: {
      id: true,
      tenantId: true,
      superAdminId: true,
      targetUserId: true,
      endedAt: true,
      expiresAt: true,
      tenant: { select: { deletedAt: true } },
    },
  })

  if (!row) return null
  // La comprobación que hace innecesario firmar la cookie.
  if (row.superAdminId !== superAdminId) return null
  if (row.endedAt !== null) return null
  if (row.expiresAt <= now) return null
  if (row.tenant.deletedAt !== null) return null

  return {
    id: row.id,
    tenantId: row.tenantId,
    superAdminId: row.superAdminId,
    targetUserId: row.targetUserId,
  }
}
