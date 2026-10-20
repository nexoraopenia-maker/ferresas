'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { z } from 'zod'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import { checkRateLimit, clientIp, RATE_RULES } from '@/lib/rate-limit'
import type { TenantContext } from '@/lib/tenant-context'
import {
  aceptarSchema, cambiarEstadoSchema, cambiarRolesSchema, invitarSchema, revocarSchema,
} from './schemas'
import {
  aceptarInvitacion as runAceptar, cambiarEstado as runEstado, cambiarRoles as runRoles,
  invitar as runInvitar, revocarInvitacion as runRevocar,
} from './service'

/**
 * Server Actions de usuarios e invitaciones. El permiso se comprueba en el
 * SERVICIO (una Server Action es un endpoint HTTP que se puede invocar a
 * mano); aquí solo van la sesión, Zod y el resultado tipado.
 */

function validationFailure(error: z.ZodError, que: string): ActionResult<never> {
  return {
    ok: false,
    code: 'VALIDATION',
    message: `Revisa los datos de ${que}.`,
    details: z.flattenError(error).fieldErrors,
  }
}

async function withTenant<T>(
  accion: string,
  fn: (db: TenantPrismaClient, ctx: TenantContext) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  let ctx: TenantContext | null = null
  try {
    ctx = await requireTenantContext()
    return await fn(getTenantPrisma(ctx), ctx)
  } catch (e) {
    if (isBusinessError(e)) {
      return { ok: false, code: e.code, message: e.message, details: e.details }
    }
    console.error('[usuarios] fallo inesperado', {
      accion,
      tenantId: ctx?.tenantId ?? null,
      error: e instanceof Error ? { name: e.name, message: e.message } : e,
    })
    return {
      ok: false,
      code: 'TENANT_MISMATCH',
      message: 'No pudimos completar la operación. Intenta de nuevo.',
    }
  }
}

export async function invitarUsuario(raw: unknown) {
  const parsed = invitarSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'la invitación')

  return withTenant('invitarUsuario', async (db, ctx) => {
    const r = await runInvitar(db, ctx, parsed.data)
    revalidatePath('/usuarios')
    return { ok: true as const, data: { id: r.id, enlace: r.enlace, expiresAt: r.expiresAt.toISOString() } }
  })
}

export async function revocarInvitacion(raw: unknown) {
  const parsed = revocarSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'la invitación')

  return withTenant('revocarInvitacion', async (db, ctx) => {
    await runRevocar(db, ctx, parsed.data.invitationId)
    revalidatePath('/usuarios')
    return { ok: true as const, data: null }
  })
}

export async function cambiarRolesUsuario(raw: unknown) {
  const parsed = cambiarRolesSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'los roles')

  return withTenant('cambiarRolesUsuario', async (db, ctx) => {
    await runRoles(db, ctx, parsed.data)
    revalidatePath('/usuarios')
    return { ok: true as const, data: null }
  })
}

export async function cambiarEstadoUsuario(raw: unknown) {
  const parsed = cambiarEstadoSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'el usuario')

  return withTenant('cambiarEstadoUsuario', async (db, ctx) => {
    await runEstado(db, ctx, parsed.data)
    revalidatePath('/usuarios')
    return { ok: true as const, data: null }
  })
}

/** Pública: la persona invitada todavía no tiene sesión ni cuenta. */
export async function aceptarInvitacion(raw: unknown): Promise<ActionResult<{ email: string }>> {
  const ip = clientIp(await headers())
  const limite = await checkRateLimit(`invitation:${ip}`, RATE_RULES.invitation)
  if (!limite.ok) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      message: `Demasiados intentos desde esta conexión. Inténtalo en ${Math.ceil(limite.retryAfterSeconds / 60)} minutos.`,
    }
  }

  const parsed = aceptarSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error, 'tu cuenta')

  try {
    const r = await runAceptar(parsed.data)
    return { ok: true, data: { email: r.email } }
  } catch (e) {
    if (isBusinessError(e)) return { ok: false, code: e.code, message: e.message }
    console.error('[usuarios] fallo al aceptar invitación', e instanceof Error ? e.name : e)
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos crear tu cuenta. Intenta de nuevo.' }
  }
}
