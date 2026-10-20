'use server'

import { revalidatePath } from 'next/cache'
import { cookies, headers } from 'next/headers'
import { z } from 'zod'
import { auth } from '@/auth'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, BusinessError, type ActionResult } from '@/lib/errors'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { OPERATOR_COOKIE, OPERADOR_MAX_HORAS, emitirOperadorToken } from '@/lib/operator-token'
import type { TenantContext } from '@/lib/tenant-context'
import {
  cerrarDispositivo, cerrarOtrosDispositivos, cerrarSesionesDeUsuario, listarDispositivos,
  type DispositivoVista,
} from './dispositivos'
import {
  desbloquearPin, establecerPin, listarOperadores, quitarPin, verificarPin, type OperadorVista,
} from './pin-service'

/**
 * Server Actions de seguridad: PIN de cajero y sesiones por dispositivo. El
 * permiso lo exige cada SERVICIO; aquí van la sesión, Zod y el resultado tipado.
 */

async function withTenant<T>(
  accion: string,
  fn: (db: TenantPrismaClient, ctx: TenantContext) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  let ctx: TenantContext | null = null
  try {
    ctx = await requireTenantContext()
    return await fn(getTenantPrisma(ctx), ctx)
  } catch (e) {
    if (isBusinessError(e)) return { ok: false, code: e.code, message: e.message, details: e.details }
    console.error('[seguridad] fallo inesperado', {
      accion, tenantId: ctx?.tenantId ?? null,
      error: e instanceof Error ? { name: e.name, message: e.message } : e,
    })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos completar la operación. Intenta de nuevo.' }
  }
}

const idSchema = z.string().min(1).max(64)

// ═══════════════════════════════════════════════════════════════════════════
//  OPERADOR POR PIN
// ═══════════════════════════════════════════════════════════════════════════

export async function listarOperadoresDeLaSucursal(): Promise<ActionResult<OperadorVista[]>> {
  return withTenant('listarOperadores', async (db, ctx) => ({ ok: true, data: await listarOperadores(db, ctx) }))
}

export async function cambiarOperador(raw: unknown): Promise<ActionResult<{ nombre: string }>> {
  const parsed = z.object({ userId: idSchema, pin: z.string().min(1).max(12) }).safeParse(raw)
  if (!parsed.success) return { ok: false, code: 'VALIDATION', message: 'Elige al operador y escribe su PIN.' }

  // Freno adicional por conexión, además del bloqueo por usuario: el PIN son
  // pocas cifras y no debe poder probarse a ráfagas desde un mismo sitio.
  const lim = await checkRateLimit(`pin:${clientIp(await headers())}`, { limit: 30, windowSeconds: 600 })
  if (!lim.ok) {
    return { ok: false, code: 'RATE_LIMITED', message: `Demasiados intentos. Espera ${Math.ceil(lim.retryAfterSeconds / 60)} minutos.` }
  }

  const sesion = await auth()
  if (!sesion?.user?.id || !sesion.sid) {
    return { ok: false, code: 'UNAUTHENTICATED', message: 'Esta sesión no admite cambio de operador. Vuelve a iniciar sesión.' }
  }

  return withTenant('cambiarOperador', async (db, ctx) => {
    const op = await verificarPin(db, ctx, parsed.data)
    ;(await cookies()).set(
      OPERATOR_COOKIE,
      emitirOperadorToken({ sid: sesion.sid!, sub: sesion.user.id, op: op.id }),
      {
        httpOnly: true, sameSite: 'lax', path: '/',
        secure: process.env.NODE_ENV === 'production',
        maxAge: OPERADOR_MAX_HORAS * 3600,
      },
    )
    revalidatePath('/', 'layout')
    return { ok: true, data: { nombre: op.nombre } }
  })
}

/** Vuelve al usuario de la sesión del dispositivo. */
export async function volverAlUsuarioDeLaSesion(): Promise<ActionResult<null>> {
  return withTenant('volverAlUsuario', async (db, ctx) => {
    ;(await cookies()).delete(OPERATOR_COOKIE)
    if (ctx.operadorDe) {
      await db.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.operadorDe, actorRole: ctx.role,
          action: 'pin.salir', entityType: 'User', entityId: ctx.userId,
        },
      })
    }
    revalidatePath('/', 'layout')
    return { ok: true, data: null }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
//  GESTIÓN DEL PIN (Equipo)
// ═══════════════════════════════════════════════════════════════════════════

export async function establecerPinUsuario(raw: unknown): Promise<ActionResult<null>> {
  const parsed = z.object({ userId: idSchema, pin: z.string().min(1).max(12) }).safeParse(raw)
  if (!parsed.success) return { ok: false, code: 'VALIDATION', message: 'Revisa el PIN.' }
  return withTenant('establecerPin', async (db, ctx) => {
    await establecerPin(db, ctx, parsed.data)
    revalidatePath('/usuarios')
    return { ok: true, data: null }
  })
}

export async function quitarPinUsuario(userId: string): Promise<ActionResult<null>> {
  if (!idSchema.safeParse(userId).success) return { ok: false, code: 'VALIDATION', message: 'Usuario no válido.' }
  return withTenant('quitarPin', async (db, ctx) => {
    await quitarPin(db, ctx, userId)
    revalidatePath('/usuarios')
    return { ok: true, data: null }
  })
}

export async function desbloquearPinUsuario(userId: string): Promise<ActionResult<null>> {
  if (!idSchema.safeParse(userId).success) return { ok: false, code: 'VALIDATION', message: 'Usuario no válido.' }
  return withTenant('desbloquearPin', async (db, ctx) => {
    await desbloquearPin(db, ctx, userId)
    revalidatePath('/usuarios')
    return { ok: true, data: null }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
//  DISPOSITIVOS
// ═══════════════════════════════════════════════════════════════════════════

export async function cerrarSesionesDelUsuario(userId: string): Promise<ActionResult<{ cerradas: number }>> {
  if (!idSchema.safeParse(userId).success) return { ok: false, code: 'VALIDATION', message: 'Usuario no válido.' }
  return withTenant('cerrarSesionesDelUsuario', async (db, ctx) => {
    const cerradas = await cerrarSesionesDeUsuario(db, ctx, userId)
    revalidatePath('/usuarios')
    return { ok: true, data: { cerradas } }
  })
}

/** Las del propio usuario de la SESIÓN (no las del operador por PIN). */
function usuarioDeLaSesion(ctx: TenantContext) {
  return ctx.operadorDe ?? ctx.userId
}

export async function misDispositivos(): Promise<ActionResult<DispositivoVista[]>> {
  return withTenant('misDispositivos', async (_db, ctx) => {
    const sesion = await auth()
    return { ok: true, data: await listarDispositivos(usuarioDeLaSesion(ctx), sesion?.sid) }
  })
}

export async function cerrarMiDispositivo(deviceId: string): Promise<ActionResult<null>> {
  if (!idSchema.safeParse(deviceId).success) return { ok: false, code: 'VALIDATION', message: 'Dispositivo no válido.' }
  return withTenant('cerrarMiDispositivo', async (_db, ctx) => {
    const ok = await cerrarDispositivo(usuarioDeLaSesion(ctx), deviceId)
    if (!ok) throw new BusinessError('NOT_FOUND', 'Esa sesión no existe o ya estaba cerrada.')
    revalidatePath('/seguridad')
    return { ok: true, data: null }
  })
}

export async function cerrarMisOtrosDispositivos(): Promise<ActionResult<{ cerradas: number }>> {
  return withTenant('cerrarMisOtrosDispositivos', async (_db, ctx) => {
    const sesion = await auth()
    const cerradas = await cerrarOtrosDispositivos(usuarioDeLaSesion(ctx), sesion?.sid)
    revalidatePath('/seguridad')
    return { ok: true, data: { cerradas } }
  })
}
