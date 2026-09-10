'use server'

import { headers } from 'next/headers'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import { checkRateLimit, RATE_RULES } from '@/lib/rate-limit'
import { createStripeClient, StripeError } from './stripe-client'
import { createMercadoPagoClient } from './mercadopago-client'
import {
  createCheckoutSession as runCheckout,
  createMercadoPagoCheckout as runMpCheckout,
} from './checkout-service'

/**
 * Inicia el pago. Devuelve la URL de Stripe para que el cliente redirija.
 *
 * No se hace `redirect()` desde el servidor a propósito: devolver la URL deja
 * que la UI muestre el estado "abriendo pago…" y maneje un fallo sin dejar al
 * usuario mirando una pantalla en blanco.
 */
export async function startCheckout(
  planCode: string,
): Promise<ActionResult<{ url: string }>> {
  const ctx = await requireTenantContext().catch(() => null)

  if (!ctx) {
    return { ok: false, code: 'UNAUTHENTICATED', message: 'Tu sesión expiró.' }
  }

  const limite = await checkRateLimit(`checkout:${ctx.tenantId}`, RATE_RULES.checkout)
  if (!limite.ok) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      message: 'Demasiados intentos. Espera un momento y vuelve a probar.',
    }
  }

  const secretKey = process.env.STRIPE_SECRET_KEY
  const appUrl = process.env.APP_URL ?? (await inferirAppUrl())

  if (!secretKey) {
    console.error('[billing] falta STRIPE_SECRET_KEY')
    return {
      ok: false,
      code: 'PLAN_UNAVAILABLE',
      message: 'El pago en línea no está disponible ahora mismo.',
    }
  }

  try {
    const db = getTenantPrisma(ctx)
    const stripe = createStripeClient({ secretKey })
    const { url } = await runCheckout(db, ctx, stripe, { planCode, appUrl })
    return { ok: true, data: { url } }
  } catch (e) {
    if (isBusinessError(e)) {
      return { ok: false, code: e.code, message: e.message, details: e.details }
    }

    // Los errores de Stripe llevan detalles internos (ids de precio, cuenta):
    // se loguean, no se muestran.
    console.error('[billing] fallo creando checkout', {
      tenantId: ctx.tenantId,
      planCode,
      stripe: e instanceof StripeError ? { status: e.status, code: e.stripeCode } : undefined,
      error: e instanceof Error ? e.message : e,
    })

    return {
      ok: false,
      code: 'PLAN_UNAVAILABLE',
      message: 'No pudimos abrir la pasarela de pago. Intenta de nuevo.',
    }
  }
}

/** Portal de Stripe: cambiar tarjeta, ver facturas, cancelar. */
export async function openBillingPortal(): Promise<ActionResult<{ url: string }>> {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED', message: 'Tu sesión expiró.' }

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    return { ok: false, code: 'PLAN_UNAVAILABLE', message: 'Portal no disponible.' }
  }

  try {
    const db = getTenantPrisma(ctx)
    const sub = await db.subscription.findFirst({ select: { externalCustomerId: true } })

    if (!sub?.externalCustomerId) {
      return {
        ok: false,
        code: 'PLAN_UNAVAILABLE',
        message: 'Todavía no tienes un método de pago registrado.',
      }
    }

    const appUrl = process.env.APP_URL ?? (await inferirAppUrl())
    const stripe = createStripeClient({ secretKey })
    const { url } = await stripe.createBillingPortalSession({
      customerId: sub.externalCustomerId,
      returnUrl: `${appUrl.replace(/\/+$/, '')}/facturacion`,
    })

    return { ok: true, data: { url } }
  } catch (e) {
    console.error('[billing] fallo abriendo portal', {
      tenantId: ctx.tenantId,
      error: e instanceof Error ? e.message : e,
    })
    return { ok: false, code: 'PLAN_UNAVAILABLE', message: 'No pudimos abrir el portal.' }
  }
}

/**
 * Deduce la URL pública cuando APP_URL no está configurada. Las URLs de
 * retorno de Stripe deben ser absolutas, y una equivocada deja al cliente
 * pagando y aterrizando en ninguna parte.
 */
async function inferirAppUrl(): Promise<string> {
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

/**
 * Checkout de MercadoPago. Idéntico en forma al de Stripe; lo elige el
 * cliente según qué pasarela tenga configurada el SaaS.
 */
export async function startMercadoPagoCheckout(
  planCode: string,
): Promise<ActionResult<{ url: string }>> {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED', message: 'Tu sesión expiró.' }

  const limite = await checkRateLimit(`checkout-mp:${ctx.tenantId}`, RATE_RULES.checkout)
  if (!limite.ok) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      message: 'Demasiados intentos. Espera un momento y vuelve a probar.',
    }
  }

  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN
  if (!accessToken) {
    console.error('[billing] falta MERCADOPAGO_ACCESS_TOKEN')
    return {
      ok: false,
      code: 'PLAN_UNAVAILABLE',
      message: 'El pago con MercadoPago no está disponible ahora mismo.',
    }
  }

  try {
    const appUrl = process.env.APP_URL ?? (await inferirAppUrl())
    const db = getTenantPrisma(ctx)
    const mp = createMercadoPagoClient({ accessToken })
    const { url } = await runMpCheckout(db, ctx, mp, { planCode, appUrl })
    return { ok: true, data: { url } }
  } catch (e) {
    if (isBusinessError(e)) {
      return { ok: false, code: e.code, message: e.message, details: e.details }
    }
    console.error('[billing] fallo creando checkout de MercadoPago', {
      tenantId: ctx.tenantId,
      planCode,
      error: e instanceof Error ? e.message : e,
    })
    return {
      ok: false,
      code: 'PLAN_UNAVAILABLE',
      message: 'No pudimos abrir la pasarela de pago. Intenta de nuevo.',
    }
  }
}

/** Pasarelas configuradas, para que la UI solo ofrezca las que funcionan. */
export async function getAvailableGateways(): Promise<{
  stripe: boolean
  mercadopago: boolean
}> {
  return {
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    mercadopago: Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN),
  }
}
