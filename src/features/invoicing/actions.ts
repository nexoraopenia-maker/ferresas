'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import { fijarArranqueSchema } from './schemas'
import { fijarArranqueSerie, listarSeriesConfigurables } from './counter-service'

/**
 * Server Actions de comprobantes.
 *
 * El rol se comprueba en el SERVICIO, no aquí: una Server Action es un
 * endpoint HTTP y cualquiera puede invocarla a mano (Frente 1).
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
    if (isBusinessError(e)) {
      return { ok: false, code: e.code, message: e.message, details: e.details }
    }
    console.error('[comprobantes] fallo inesperado', {
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

export async function getSeriesConfigurables(branchId: string) {
  return withTenant('getSeriesConfigurables', async (db, ctx) => ({
    ok: true as const,
    data: await listarSeriesConfigurables(db, ctx, branchId),
  }))
}

export async function setArranqueSerie(raw: unknown) {
  const parsed = fijarArranqueSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false as const,
      code: 'VALIDATION' as const,
      message: 'Revisa el correlativo inicial.',
      details: z.flattenError(parsed.error).fieldErrors,
    }
  }

  return withTenant('setArranqueSerie', async (db, ctx) => {
    const r = await fijarArranqueSerie(db, ctx, {
      branchId: parsed.data.branchId,
      scope: parsed.data.scope,
      startNumber: parsed.data.startNumber,
    })
    revalidatePath('/comprobantes')
    return { ok: true as const, data: r }
  })
}
