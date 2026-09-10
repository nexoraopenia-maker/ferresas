'use server'

import { headers } from 'next/headers'
import { signIn } from '@/auth'
import { prisma } from '@/lib/prisma'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import { registerSchema, type RegisterInput } from '@/features/onboarding/schemas'
import { registerTenant } from '@/features/onboarding/service'
import { ROUTES } from '@/lib/route-access'
import { checkRateLimit, clientIp, RATE_RULES } from '@/lib/rate-limit'
import { z } from 'zod'

/**
 * Planes visibles en el formulario de registro. Salen de la BD para que los
 * precios y límites que ve el visitante sean los reales.
 */
export async function getPublicPlans() {
  return prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: {
      code: true,
      name: true,
      description: true,
      priceMonthly: true,
      currency: true,
      trialDays: true,
      maxUsers: true,
      maxWarehouses: true,
      maxProducts: true,
    },
  })
}

export async function registerAction(
  raw: RegisterInput,
): Promise<ActionResult<{ redirectTo: string; trialEndsAt: string }>> {
  // El límite se comprueba ANTES de validar y antes de tocar la BD: si se
  // hiciera después, un script ya habría gastado una consulta y un bcrypt por
  // intento, que es justo el coste que queremos negarle.
  const ip = clientIp(await headers())
  const limite = await checkRateLimit(`register:${ip}`, RATE_RULES.register)

  if (!limite.ok) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      message: `Demasiados registros desde esta conexión. Inténtalo en ${Math.ceil(limite.retryAfterSeconds / 60)} minutos.`,
    }
  }

  const parsed = registerSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Revisa los datos del formulario.',
      details: z.flattenError(parsed.error).fieldErrors,
    }
  }

  try {
    const result = await registerTenant(parsed.data)

    // Se inicia sesión inmediatamente: obligar a volver al login justo
    // después de registrarse es fricción gratuita.
    await signIn('credentials', {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: false,
    })

    return {
      ok: true,
      data: {
        redirectTo: ROUTES.dashboard,
        trialEndsAt: result.trialEndsAt.toISOString(),
      },
    }
  } catch (e) {
    if (isBusinessError(e)) {
      return { ok: false, code: e.code, message: e.message, details: e.details }
    }

    console.error('[onboarding] fallo inesperado', {
      // El correo NO se loguea: es un dato personal de alguien que ni
      // siquiera llegó a tener cuenta.
      error: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
    })

    return {
      ok: false,
      code: 'TENANT_MISMATCH',
      message: 'No pudimos crear tu cuenta. Intenta de nuevo.',
    }
  }
}
