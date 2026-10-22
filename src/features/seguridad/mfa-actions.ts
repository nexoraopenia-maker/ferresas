'use server'

import { revalidatePath } from 'next/cache'
import QRCode from 'qrcode'
import { z } from 'zod'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import { requireIdentidad, requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import {
  confirmarActivacionMfa, desactivarMfa, iniciarActivacionMfa, regenerarCodigosRecuperacion,
  restablecerMfaDeUsuario,
} from './mfa-service'

/**
 * Server Actions del segundo factor. Las de la propia cuenta usan
 * `requireIdentidad` (quien aún no lo activó no pasa `requireTenantContext`, y
 * tiene que poder activarlo); el restablecimiento ajeno usa el contexto de
 * tenant y su permiso.
 */

const codigoSchema = z.object({ codigo: z.string().min(6).max(32) })

async function envolver<T>(accion: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    if (isBusinessError(e)) return { ok: false, code: e.code, message: e.message, details: e.details }
    console.error('[mfa] fallo inesperado', { accion, error: e instanceof Error ? e.message : e })
    return { ok: false, code: 'TENANT_MISMATCH', message: 'No pudimos completar la operación. Intenta de nuevo.' }
  }
}

export async function iniciarMfaAction(): Promise<ActionResult<{ secreto: string; qr: string }>> {
  return envolver('iniciar', async () => {
    const { userId } = await requireIdentidad()
    const { secreto, otpauth } = await iniciarActivacionMfa(userId)
    return { secreto, qr: await QRCode.toDataURL(otpauth, { margin: 1, width: 240 }) }
  })
}

export async function confirmarMfaAction(input: unknown): Promise<ActionResult<{ codigosRecuperacion: string[] }>> {
  return envolver('confirmar', async () => {
    const { userId } = await requireIdentidad()
    const { codigo } = codigoSchema.parse(input)
    const r = await confirmarActivacionMfa(userId, codigo)
    revalidatePath('/', 'layout')
    return r
  })
}

export async function regenerarCodigosAction(input: unknown): Promise<ActionResult<{ codigosRecuperacion: string[] }>> {
  return envolver('regenerar', async () => {
    const { userId } = await requireIdentidad()
    const { codigo } = codigoSchema.parse(input)
    return regenerarCodigosRecuperacion(userId, codigo)
  })
}

export async function desactivarMfaAction(input: unknown): Promise<ActionResult<null>> {
  return envolver('desactivar', async () => {
    const { userId } = await requireIdentidad()
    const { codigo } = codigoSchema.parse(input)
    await desactivarMfa(userId, codigo)
    revalidatePath('/seguridad')
    return null
  })
}

export async function restablecerMfaAction(input: unknown): Promise<ActionResult<null>> {
  return envolver('restablecer', async () => {
    const ctx = await requireTenantContext()
    const { userId } = z.object({ userId: z.string().min(1) }).parse(input)
    await restablecerMfaDeUsuario(getTenantPrisma(ctx), ctx, userId)
    revalidatePath('/usuarios')
    return null
  })
}
