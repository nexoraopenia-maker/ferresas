'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { requireSuperAdmin } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import { clientIp } from '@/lib/rate-limit'
import { ROUTES } from '@/lib/route-access'
import { IMPERSONATION_MAX_MINUTES } from '@/lib/impersonation'
import { SUPPORT_COOKIE, emitirSupportToken, verificarSupportToken } from '@/lib/support-token'
import {
  reactivateTenantSchema,
  ambienteSunatSchema,
  facturacionRealSchema,
  umbralesAlertaSchema,
  resetOwnerPasswordSchema,
  startImpersonationSchema,
  suspendTenantSchema,
  updateTenantProfileSchema,
} from './schemas'
import { cambiarFacturacionReal, fijarUmbralesAlerta } from './facturacion-real-service'
import { confirmarConexionSunat, evaluarPaseASunatProduccion, pasarASunatProduccion, volverASunatBeta, type EvaluacionPase } from './produccion-sunat-service'
import {
  resetOwnerPassword as runResetPassword,
  updateTenantProfile as runUpdateProfile,
} from './tenant-admin-service'

/**
 * Acciones del Panel Maestro (§5.3).
 *
 * Las tres son destructivas o sensibles, así que las tres siguen el mismo
 * guion: verificar SUPERADMIN real → validar con Zod (motivo incluido) →
 * mutar y auditar DENTRO de la misma transacción.
 *
 * Que la auditoría vaya en la transacción no es un detalle: si se escribiera
 * después y el proceso muriera en medio, quedaría un tenant suspendido sin
 * ningún registro de quién lo hizo ni por qué.
 */

async function rastro() {
  const h = await headers()
  return { ipAddress: clientIp(h), userAgent: h.get('user-agent')?.slice(0, 300) ?? null }
}

function fallo(e: unknown, accion: string): ActionResult<never> {
  if (isBusinessError(e)) {
    return { ok: false, code: e.code, message: e.message }
  }
  console.error('[superadmin] fallo', { accion, error: e instanceof Error ? e.message : e })
  return { ok: false, code: 'TENANT_MISMATCH', message: 'No se pudo completar la acción.' }
}

// ---------------------------------------------------------------------------
//  KILL SWITCH
// ---------------------------------------------------------------------------

/**
 * Suspende un tenant por abuso o fraude, con independencia de su estado en
 * Stripe. Un cliente puede estar pagando religiosamente y aun así tener que
 * ser cortado — por eso `Tenant.isActive` es una columna aparte de
 * `Subscription.status` y gana sobre ella en computeAccessLevel().
 */
export async function suspendTenant(
  raw: unknown,
): Promise<ActionResult<{ tenantId: string }>> {
  const parsed = suspendTenantSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Falta el motivo de la suspensión.',
      details: z.flattenError(parsed.error).fieldErrors,
    }
  }

  try {
    const admin = await requireSuperAdmin()
    const { ipAddress, userAgent } = await rastro()

    const antes = await prisma.tenant.findUnique({
      where: { id: parsed.data.tenantId },
      select: { id: true, name: true, isActive: true },
    })
    if (!antes) return { ok: false, code: 'TENANT_MISMATCH', message: 'Cuenta no encontrada.' }

    await prisma.$transaction([
      prisma.tenant.update({
        where: { id: antes.id },
        data: {
          isActive: false,
          suspendedAt: new Date(),
          suspendedReason: parsed.data.reason,
        },
      }),
      prisma.auditLog.create({
        data: {
          tenantId: antes.id,
          actorId: admin.id,
          actorRole: 'SUPERADMIN',
          actorEmail: admin.email,
          action: 'tenant.suspend',
          entityType: 'Tenant',
          entityId: antes.id,
          reason: parsed.data.reason,
          before: { isActive: antes.isActive },
          after: { isActive: false },
          ipAddress,
          userAgent,
        },
      }),
      // Cerrar cualquier sesión de soporte abierta contra la cuenta que se
      // acaba de cortar: dejarla viva sería una puerta a una cuenta suspendida.
      prisma.impersonationSession.updateMany({
        where: { tenantId: antes.id, endedAt: null },
        data: { endedAt: new Date() },
      }),
    ])

    revalidatePath(ROUTES.superadmin)
    return { ok: true, data: { tenantId: antes.id } }
  } catch (e) {
    return fallo(e, 'suspendTenant')
  }
}

export async function reactivateTenant(
  raw: unknown,
): Promise<ActionResult<{ tenantId: string }>> {
  const parsed = reactivateTenantSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: 'Falta el motivo de la reactivación.' }
  }

  try {
    const admin = await requireSuperAdmin()
    const { ipAddress, userAgent } = await rastro()

    const antes = await prisma.tenant.findUnique({
      where: { id: parsed.data.tenantId },
      select: { id: true, isActive: true, suspendedReason: true },
    })
    if (!antes) return { ok: false, code: 'TENANT_MISMATCH', message: 'Cuenta no encontrada.' }

    await prisma.$transaction([
      prisma.tenant.update({
        where: { id: antes.id },
        data: { isActive: true, suspendedAt: null, suspendedReason: null },
      }),
      prisma.auditLog.create({
        data: {
          tenantId: antes.id,
          actorId: admin.id,
          actorRole: 'SUPERADMIN',
          actorEmail: admin.email,
          action: 'tenant.reactivate',
          entityType: 'Tenant',
          entityId: antes.id,
          reason: parsed.data.reason,
          before: { isActive: antes.isActive, suspendedReason: antes.suspendedReason },
          after: { isActive: true },
          ipAddress,
          userAgent,
        },
      }),
    ])

    revalidatePath(ROUTES.superadmin)
    return { ok: true, data: { tenantId: antes.id } }
  } catch (e) {
    return fallo(e, 'reactivateTenant')
  }
}

// ---------------------------------------------------------------------------
//  IMPERSONATION
// ---------------------------------------------------------------------------

/**
 * Abre una sesión de soporte suplantando a un usuario del tenant.
 *
 * La fila de ImpersonationSession y su AuditLog se crean en la MISMA
 * transacción, y solo después se entrega la cookie. El orden importa: si se
 * pusiera la cookie primero y la escritura fallara, existiría una sesión de
 * soporte sin rastro alguno — exactamente lo que la auditoría debe impedir.
 */
export async function startImpersonation(
  raw: unknown,
): Promise<ActionResult<{ impersonationId: string }>> {
  const parsed = startImpersonationSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Debes indicar el motivo del acceso de soporte (mínimo 10 caracteres).',
      details: z.flattenError(parsed.error).fieldErrors,
    }
  }

  try {
    const admin = await requireSuperAdmin()
    const { ipAddress, userAgent } = await rastro()

    const tenant = await prisma.tenant.findFirst({
      where: { id: parsed.data.tenantId, deletedAt: null },
      select: { id: true, name: true },
    })
    if (!tenant) return { ok: false, code: 'TENANT_MISMATCH', message: 'Cuenta no encontrada.' }

    const objetivo = parsed.data.targetUserId
      ? await prisma.user.findFirst({
          where: {
            id: parsed.data.targetUserId,
            tenantId: tenant.id,
            isActive: true,
            deletedAt: null,
          },
          select: { id: true, email: true, role: true },
        })
      : await prisma.user.findFirst({
          where: { tenantId: tenant.id, role: 'OWNER', isActive: true, deletedAt: null },
          select: { id: true, email: true, role: true },
          orderBy: { createdAt: 'asc' },
        })

    if (!objetivo) {
      return {
        ok: false,
        code: 'TENANT_MISMATCH',
        message: 'Esa cuenta no tiene usuarios activos a los que dar soporte.',
      }
    }

    const ahora = new Date()
    const expiresAt = new Date(ahora.getTime() + IMPERSONATION_MAX_MINUTES * 60_000)

    const [, sesion] = await prisma.$transaction([
      // Solo una sesión de soporte viva a la vez por superadmin: si no, las
      // anteriores quedarían abiertas y utilizables con su cookie vieja.
      prisma.impersonationSession.updateMany({
        where: { superAdminId: admin.id, endedAt: null },
        data: { endedAt: ahora },
      }),
      prisma.impersonationSession.create({
        data: {
          superAdminId: admin.id,
          tenantId: tenant.id,
          targetUserId: objetivo.id,
          reason: parsed.data.reason,
          expiresAt,
          ipAddress,
          userAgent,
        },
        select: { id: true },
      }),
    ])

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorId: admin.id,
        actorRole: 'SUPERADMIN',
        actorEmail: admin.email,
        action: 'impersonation.start',
        entityType: 'ImpersonationSession',
        entityId: sesion.id,
        reason: parsed.data.reason,
        after: {
          tenant: tenant.name,
          targetUser: objetivo.email,
          targetRole: objetivo.role,
          expiresAt: expiresAt.toISOString(),
        },
        ipAddress,
        userAgent,
        impersonationId: sesion.id,
      },
    })

    /*
     * La cookie pasa a llevar un token FIRMADO con su propia caducidad, no el
     * id suelto. Así el proxy puede cortar una sesión de soporte vencida sin
     * consultar la base — y esa consulta costaba 120-140 ms en cada
     * navegación, porque el proxy corre lejos de la base.
     *
     * Al RENDERIZAR se sigue validando contra la base: la firma prueba que el
     * token es nuestro y que no caducó, pero no que la sesión siga abierta.
     * Cerrarla deja `endedAt`, y eso solo se ve consultando.
     */
    const jar = await cookies()
    const token = emitirSupportToken(
      { id: sesion.id, tenantId: tenant.id, superAdminId: admin.id },
      IMPERSONATION_MAX_MINUTES,
    )
    jar.set(SUPPORT_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: IMPERSONATION_MAX_MINUTES * 60,
    })

    return { ok: true, data: { impersonationId: sesion.id } }
  } catch (e) {
    return fallo(e, 'startImpersonation')
  }
}

/**
 * Cierra la sesión de soporte. Se ejecuta desde el banner y desde la ruta
 * /salir-de-soporte, y es idempotente: pulsarlo dos veces no rompe nada.
 */
export async function endImpersonation() {
  const jar = await cookies()
  const id = verificarSupportToken(jar.get(SUPPORT_COOKIE)?.value)?.id

  // La cookie se borra SIEMPRE, incluso si la fila ya no existe o el usuario
  // perdió la sesión. Dejar la cookie puesta tras un fallo dejaría al
  // superadmin encerrado en la vista del cliente.
  jar.delete(SUPPORT_COOKIE)

  if (id) {
    const sesion = await prisma.impersonationSession.findUnique({
      where: { id },
      select: { id: true, endedAt: true, tenantId: true, superAdminId: true },
    })

    if (sesion && !sesion.endedAt) {
      const admin = await prisma.user.findUnique({
        where: { id: sesion.superAdminId },
        select: { email: true },
      })

      await prisma.$transaction([
        prisma.impersonationSession.update({
          where: { id: sesion.id },
          data: { endedAt: new Date() },
        }),
        prisma.auditLog.create({
          data: {
            tenantId: sesion.tenantId,
            actorId: sesion.superAdminId,
            actorRole: 'SUPERADMIN',
            actorEmail: admin?.email ?? null,
            action: 'impersonation.end',
            entityType: 'ImpersonationSession',
            entityId: sesion.id,
            impersonationId: sesion.id,
          },
        }),
      ])
    }
  }

  redirect(ROUTES.superadmin)
}

// ---------------------------------------------------------------------------
//  GESTIÓN DE CUENTAS DE CLIENTE
// ---------------------------------------------------------------------------

/**
 * Resetea la contraseña del dueño de una ferretería.
 *
 * Devuelve la contraseña temporal UNA sola vez: en la base solo queda su
 * hash y no hay forma de recuperarla después.
 */
export async function resetTenantOwnerPassword(
  raw: unknown,
): Promise<ActionResult<{ userEmail: string; temporaryPassword: string }>> {
  const parsed = resetOwnerPasswordSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION',
      // El primer error real (motivo o contraseña), no un texto fijo.
      message: parsed.error.issues[0]?.message ?? 'Revisa los datos del reseteo.',
      details: z.flattenError(parsed.error).fieldErrors,
    }
  }

  try {
    const admin = await requireSuperAdmin()
    const r = await runResetPassword(parsed.data, { id: admin.id, email: admin.email })
    revalidatePath(ROUTES.superadmin)
    return { ok: true, data: r }
  } catch (e) {
    return fallo(e, 'resetTenantOwnerPassword')
  }
}

/** Edita los datos fiscales y de contacto de una ferretería. */
export async function updateTenantProfileAction(
  raw: unknown,
): Promise<ActionResult<{ cambios: string[] }>> {
  const parsed = updateTenantProfileSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Revisa los datos del perfil.',
      details: z.flattenError(parsed.error).fieldErrors,
    }
  }

  try {
    const admin = await requireSuperAdmin()
    const r = await runUpdateProfile(parsed.data, { id: admin.id, email: admin.email })
    revalidatePath(ROUTES.superadmin)
    return { ok: true, data: { cambios: r.cambios } }
  } catch (e) {
    return fallo(e, 'updateTenantProfileAction')
  }
}


/** Enciende o apaga la facturación electrónica real de un negocio (solo SuperAdmin). */
export async function setFacturacionRealAction(raw: unknown): Promise<ActionResult<{ modo: string }>> {
  const parsed = facturacionRealSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: parsed.error.issues[0]?.message ?? 'Revisa los datos.', details: z.flattenError(parsed.error).fieldErrors }
  }
  try {
    const admin = await requireSuperAdmin()
    const r = await cambiarFacturacionReal(
      { tenantId: parsed.data.tenantId, accion: parsed.data.accion, reason: parsed.data.reason },
      { id: admin.id, email: admin.email },
    )
    revalidatePath(ROUTES.superadmin)
    return { ok: true, data: r }
  } catch (e) {
    return fallo(e, 'setFacturacionRealAction')
  }
}


/** Qué le falta a un negocio para pasar su conexión con SUNAT a producción, y qué pasaría con lo pendiente (solo SuperAdmin; no cambia nada). */
export async function previsualizarPaseSunatAction(raw: unknown): Promise<ActionResult<EvaluacionPase>> {
  const tenantId = typeof (raw as { tenantId?: unknown })?.tenantId === 'string' ? (raw as { tenantId: string }).tenantId.slice(0, 64) : ''
  if (!tenantId) return { ok: false, code: 'VALIDATION', message: 'Falta el negocio.' }
  try {
    await requireSuperAdmin()
    return { ok: true, data: await evaluarPaseASunatProduccion(tenantId) }
  } catch (e) {
    return fallo(e, 'previsualizarPaseSunatAction')
  }
}

/** Pasa la conexión con SUNAT de un negocio a producción, o la devuelve a pruebas (solo SuperAdmin, con motivo). */
export async function setAmbienteSunatAction(raw: unknown): Promise<ActionResult<{ ambiente?: string; confirmada?: boolean; reencolados?: number; retenidos?: number }>> {
  const parsed = ambienteSunatSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: parsed.error.issues[0]?.message ?? 'Revisa los datos.', details: z.flattenError(parsed.error).fieldErrors }
  }
  try {
    const admin = await requireSuperAdmin()
    const actor = { id: admin.id, email: admin.email }
    const input = { tenantId: parsed.data.tenantId, reason: parsed.data.reason }
    const r = parsed.data.accion === 'produccion' ? await pasarASunatProduccion(input, actor)
      : parsed.data.accion === 'beta' ? await volverASunatBeta(input, actor)
      : await confirmarConexionSunat(input, actor)
    revalidatePath(ROUTES.superadmin)
    return { ok: true, data: r }
  } catch (e) {
    return fallo(e, 'setAmbienteSunatAction')
  }
}

/** Fija los umbrales de alerta de envío fiscal de un negocio (solo SuperAdmin). */
export async function setUmbralesAlertaAction(raw: unknown): Promise<ActionResult<null>> {
  const parsed = umbralesAlertaSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: parsed.error.issues[0]?.message ?? 'Revisa los datos.', details: z.flattenError(parsed.error).fieldErrors }
  }
  try {
    const admin = await requireSuperAdmin()
    await fijarUmbralesAlerta(parsed.data, { id: admin.id, email: admin.email })
    revalidatePath(ROUTES.superadmin)
    return { ok: true, data: null }
  } catch (e) {
    return fallo(e, 'setUmbralesAlertaAction')
  }
}
