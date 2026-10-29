import type { Role } from '@/generated/prisma/enums'
import { cifrar, descifrar, hayClaveMaestra } from '@/lib/cifrado'
import { BusinessError } from '@/lib/errors'
import { prisma } from '@/lib/prisma'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import {
  CANTIDAD_CODIGOS, esCodigoTotp, generarCodigosRecuperacion, generarSecreto,
  hashCodigoRecuperacion, normalizarCodigo, otpauthUrl, verificarTotp,
} from '@/lib/totp'
import { puedeCambiarPassword } from '@/features/usuarios/asignacion'
import { BLOQUEO_MFA_MS, EMISOR_TOTP, MAX_INTENTOS_MFA, mfaObligatorio } from './mfa-reglas'

/**
 * Segundo factor: TOTP + códigos de recuperación.
 *
 * El secreto se guarda CIFRADO (AES-256-GCM con la clave maestra y el id del
 * usuario como AAD: copiarlo a otra fila no lo descifra). Los códigos de
 * recuperación, solo como hash.
 */

export const aad = (userId: string) => `mfa:${userId}`

export type ResultadoSegundoFactor =
  | { ok: true; recuperacion: boolean }
  | { ok: false; motivo: 'INVALIDO' | 'BLOQUEADO' | 'NO_ACTIVO' }

const MENSAJE_CLAVE = 'Falta la clave maestra del servidor (PSE_MASTER_KEY): no se puede activar el segundo factor.'

export async function estadoMfa(userId: string) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, extraRoles: true, mfaEnabledAt: true, mfaRecoveryHashes: true },
  })
  if (!u) throw new BusinessError('NOT_FOUND', 'El usuario no existe.')
  return {
    activo: u.mfaEnabledAt !== null,
    obligatorio: mfaObligatorio([u.role, ...u.extraRoles]),
    codigosRestantes: u.mfaRecoveryHashes.length,
  }
}

/** Empieza (o reinicia) la activación: genera un secreto pendiente de confirmar. */
export async function iniciarActivacionMfa(userId: string): Promise<{ secreto: string; otpauth: string }> {
  if (!hayClaveMaestra()) throw new BusinessError('NOT_FOUND', MENSAJE_CLAVE)
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, mfaEnabledAt: true } })
  if (!u) throw new BusinessError('NOT_FOUND', 'El usuario no existe.')
  if (u.mfaEnabledAt) throw new BusinessError('FORBIDDEN_ROLE', 'El segundo factor ya está activo.')
  const secreto = generarSecreto()
  await prisma.user.update({ where: { id: userId }, data: { mfaSecretEnc: cifrar(secreto, aad(userId)) } })
  return { secreto, otpauth: otpauthUrl(secreto, u.email, EMISOR_TOTP) }
}

/** Confirma la activación con un código de la app; devuelve los códigos de recuperación (única vez en claro). */
export async function confirmarActivacionMfa(
  userId: string, codigo: string, ahora: Date = new Date(),
): Promise<{ codigosRecuperacion: string[] }> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { tenantId: true, role: true, mfaSecretEnc: true, mfaEnabledAt: true },
  })
  if (!u?.mfaSecretEnc || u.mfaEnabledAt) {
    throw new BusinessError('NOT_FOUND', 'No hay una activación en curso. Empieza de nuevo.')
  }
  const paso = verificarTotp(descifrar(u.mfaSecretEnc, aad(userId)), normalizarCodigo(codigo), ahora)
  if (paso === null) throw new BusinessError('UNAUTHENTICATED', 'El código no es correcto. Revisa la hora del teléfono.')
  const codigos = generarCodigosRecuperacion()
  await prisma.user.update({
    where: { id: userId },
    data: {
      mfaEnabledAt: ahora, mfaLastStep: paso, mfaFailedAttempts: 0, mfaLockedUntil: null,
      mfaRecoveryHashes: codigos.map((c) => hashCodigoRecuperacion(userId, c)),
    },
  })
  await auditarPropio(u.tenantId, userId, u.role, 'mfa.activar')
  return { codigosRecuperacion: codigos }
}

/**
 * Verifica el segundo factor en el login: un TOTP (6 dígitos) o un código de
 * recuperación. Límite por cuenta: 5 fallos seguidos bloquean 15 min. El intento
 * se RESERVA antes de comprobar (incremento atómico), así que lanzar peticiones
 * en paralelo no da más de 5 intentos.
 */
export async function verificarSegundoFactor(
  userId: string, codigo: string, ahora: Date = new Date(),
): Promise<ResultadoSegundoFactor> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { tenantId: true, role: true, mfaSecretEnc: true, mfaEnabledAt: true, mfaLockedUntil: true },
  })
  if (!u?.mfaEnabledAt || !u.mfaSecretEnc) return { ok: false, motivo: 'NO_ACTIVO' }
  if (u.mfaLockedUntil) {
    if (u.mfaLockedUntil > ahora) return { ok: false, motivo: 'BLOQUEADO' }
    // Bloqueo vencido: empieza de cero. (Mientras dura, el contador queda por encima
    // del máximo, así que las peticiones que ya iban en vuelo no obtienen otra tanda.)
    await prisma.user.updateMany({
      where: { id: userId, mfaLockedUntil: { lte: ahora } },
      data: { mfaFailedAttempts: 0, mfaLockedUntil: null },
    })
  }

  const reserva = await prisma.user.update({
    where: { id: userId }, data: { mfaFailedAttempts: { increment: 1 } },
    select: { mfaFailedAttempts: true },
  })
  if (reserva.mfaFailedAttempts > MAX_INTENTOS_MFA) return { ok: false, motivo: 'BLOQUEADO' }

  const limpio = normalizarCodigo(codigo)
  let acierto = false
  let recuperacion = false
  if (esCodigoTotp(limpio)) {
    const paso = verificarTotp(descifrar(u.mfaSecretEnc, aad(userId)), limpio, ahora)
    if (paso !== null) {
      // Un código ya usado (o más viejo) no vale: la reclamación del paso es atómica.
      const r = await prisma.user.updateMany({
        where: { id: userId, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: paso } }] },
        data: { mfaLastStep: paso },
      })
      acierto = r.count === 1
    }
  } else if (limpio.length === 10) {
    const hash = hashCodigoRecuperacion(userId, limpio)
    // Consumo atómico: dos peticiones con el mismo código no pueden ganar las dos.
    const n = await prisma.$executeRaw`
      UPDATE "users" SET "mfaRecoveryHashes" = array_remove("mfaRecoveryHashes", ${hash})
      WHERE "id" = ${userId} AND ${hash} = ANY("mfaRecoveryHashes")`
    acierto = n === 1
    recuperacion = acierto
  }

  if (acierto) {
    await prisma.user.update({ where: { id: userId }, data: { mfaFailedAttempts: 0, mfaLockedUntil: null } })
    if (recuperacion) await auditarPropio(u.tenantId, userId, u.role, 'mfa.codigo_recuperacion_usado')
    return { ok: true, recuperacion }
  }
  if (reserva.mfaFailedAttempts === MAX_INTENTOS_MFA) {
    await prisma.user.update({
      where: { id: userId },
      data: { mfaLockedUntil: new Date(ahora.getTime() + BLOQUEO_MFA_MS) },
    })
    await auditarPropio(u.tenantId, userId, u.role, 'mfa.bloqueo')
    return { ok: false, motivo: 'BLOQUEADO' }
  }
  return { ok: false, motivo: reserva.mfaFailedAttempts > MAX_INTENTOS_MFA ? 'BLOQUEADO' : 'INVALIDO' }
}

/** Códigos nuevos (invalidan los anteriores). Exige un código vigente. */
export async function regenerarCodigosRecuperacion(userId: string, codigo: string, ahora: Date = new Date()) {
  const v = await verificarSegundoFactor(userId, codigo, ahora)
  if (!v.ok) throw new BusinessError('UNAUTHENTICATED', 'El código no es correcto.')
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true, role: true } })
  const codigos = generarCodigosRecuperacion(CANTIDAD_CODIGOS)
  await prisma.user.update({
    where: { id: userId }, data: { mfaRecoveryHashes: codigos.map((c) => hashCodigoRecuperacion(userId, c)) },
  })
  await auditarPropio(u.tenantId, userId, u.role, 'mfa.regenerar_codigos')
  return { codigosRecuperacion: codigos }
}

/** Quitar el segundo factor por cuenta propia: solo si el rol no lo exige y con un código vigente. */
export async function desactivarMfa(userId: string, codigo: string, ahora: Date = new Date()): Promise<void> {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: userId }, select: { tenantId: true, role: true, extraRoles: true },
  })
  if (mfaObligatorio([u.role, ...u.extraRoles])) {
    throw new BusinessError('FORBIDDEN_ROLE', 'Tu rol exige el segundo factor: no se puede desactivar.')
  }
  const v = await verificarSegundoFactor(userId, codigo, ahora)
  if (!v.ok) throw new BusinessError('UNAUTHENTICATED', 'El código no es correcto.')
  await limpiarMfa(userId)
  await auditarPropio(u.tenantId, userId, u.role, 'mfa.desactivar')
}

/**
 * Restablecimiento por un administrador (teléfono perdido y sin códigos).
 * Mismo límite de poder que cambiar la contraseña ajena: al dueño solo lo
 * restablece él mismo. Cierra las sesiones del usuario y, si su rol lo exige,
 * tendrá que volver a activarlo al entrar.
 */
export async function restablecerMfaDeUsuario(
  db: TenantPrismaClient, ctx: TenantContext, userId: string,
): Promise<void> {
  exigir(ctx, 'usuarios.gestionar')
  const objetivo = await db.user.findFirst({
    where: { id: userId, deletedAt: null }, select: { id: true, role: true, extraRoles: true },
  })
  if (!objetivo) throw new BusinessError('NOT_FOUND', 'El usuario no existe.')
  if (objetivo.id === ctx.userId || !puedeCambiarPassword(ctx, objetivo)) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No puedes restablecer el segundo factor de este usuario.')
  }
  await limpiarMfa(objetivo.id)
  await prisma.deviceSession.updateMany({
    where: { userId: objetivo.id, revokedAt: null }, data: { revokedAt: new Date(), revokedById: ctx.userId },
  })
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
      action: 'mfa.restablecer', entityType: 'User', entityId: objetivo.id,
      impersonationId: ctx.impersonationId ?? null,
    },
  })
}

async function limpiarMfa(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, mfaFailedAttempts: 0,
      mfaLockedUntil: null, mfaRecoveryHashes: [],
    },
  })
}

async function auditarPropio(tenantId: string | null, userId: string, rol: Role, action: string) {
  await prisma.auditLog.create({
    data: { tenantId, actorId: userId, actorRole: rol, action, entityType: 'User', entityId: userId },
  })
}
