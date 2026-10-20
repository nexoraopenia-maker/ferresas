import { BusinessError } from '@/lib/errors'
import { type TenantContext } from '@/lib/tenant-context'
import { auditarFacturacion } from './audit'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import type { StripeClient } from './stripe-client'
import type { MercadoPagoClient } from './mercadopago-client'
import { puede } from '@/lib/puede'

/**
 * Creación de la sesión de pago.
 *
 * ─── LA TRAMPA QUE HAY QUE VER ANTES DE ESCRIBIR ESTO ────────────────────
 *
 * `getTenantPrisma()` bloquea TODA escritura cuando el acceso es READ_ONLY.
 * Y READ_ONLY es exactamente el estado de un cliente en mora... que es
 * exactamente quien necesita pagar.
 *
 * Si esta función guardara algo —el id de sesión, el customer de Stripe—
 * fallaría con SUBSCRIPTION_READ_ONLY justo para el usuario al que queremos
 * cobrar. El bloqueo de morosos se habría comido el botón de pagar.
 *
 * Por eso NO ESCRIBE NADA. Solo lee. Los identificadores de Stripe los
 * persiste el webhook cuando llega `checkout.session.completed`, que además
 * es la fuente de verdad correcta (§5.2): si el usuario abandona el checkout
 * a mitad, no queda basura en nuestra BD.
 */

export interface CheckoutResult {
  url: string
  sessionId: string
}

export async function createCheckoutSession(
  db: TenantPrismaClient,
  ctx: TenantContext,
  stripe: StripeClient,
  input: { planCode: string; appUrl: string },
): Promise<CheckoutResult> {
  // Contratar y pagar es decisión del dueño, no del almacenero de turno.
  if (!puede(ctx, 'plan.gestionar')) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'Solo el dueño puede gestionar la suscripción.',
    )
  }

  // El PRECIO sale de nuestra tabla Plan, jamás del cliente. Si el navegador
  // pudiera mandar un priceId, cualquiera contrataría el plan Premium al
  // precio del Básico — o a un precio de prueba de otra cuenta de Stripe.
  const plan = await db.plan.findFirst({
    where: { code: input.planCode, isActive: true },
    select: {
      id: true, code: true, name: true, stripePriceMonthly: true,
      priceMonthly: true, currency: true,
    },
  })

  if (!plan) {
    throw new BusinessError('PLAN_UNAVAILABLE', 'El plan seleccionado no está disponible.')
  }

  if (!plan.stripePriceMonthly) {
    throw new BusinessError(
      'PLAN_UNAVAILABLE',
      `El plan ${plan.name} todavía no está disponible para pago en línea.`,
    )
  }

  const suscripcion = await db.subscription.findFirst({
    select: {
      status: true,
      externalCustomerId: true,
      externalSubscriptionId: true,
      trialEndsAt: true,
      // Para que el registro diga de QUÉ plan a cuál se movió.
      plan: { select: { code: true } },
    },
  })

  if (!suscripcion) {
    throw new BusinessError('PLAN_UNAVAILABLE', 'Tu cuenta no tiene una suscripción asociada.')
  }

  // Una cuenta ya activa debe ir al PORTAL (cambiar plan, actualizar tarjeta),
  // no a un checkout nuevo: eso crearía una segunda suscripción y se le
  // cobraría dos veces.
  if (suscripcion.status === 'ACTIVE' && suscripcion.externalSubscriptionId) {
    throw new BusinessError(
      'DUPLICATE_CODE',
      'Tu suscripción ya está activa. Usa el portal de facturación para cambiar de plan.',
    )
  }

  const owner = await db.user.findFirst({
    where: { role: 'OWNER', isActive: true, deletedAt: null },
    select: { email: true },
    orderBy: { createdAt: 'asc' },
  })

  const base = input.appUrl.replace(/\/+$/, '')

  const session = await stripe.createCheckoutSession({
    priceId: plan.stripePriceMonthly,
    successUrl: `${base}/facturacion?checkout=exito&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/facturacion?checkout=cancelado`,
    tenantId: ctx.tenantId,
    customerId: suscripcion.externalCustomerId ?? undefined,
    customerEmail: suscripcion.externalCustomerId ? undefined : owner?.email,
    trialEnd: suscripcion.trialEndsAt ?? undefined,
    // Clave de idempotencia estable por (tenant, plan, hora): un doble clic
    // reutiliza la misma sesión de Stripe en vez de abrir dos.
    idempotencyKey: idempotencyFor(ctx.tenantId, plan.id),
  })

  /*
   * Se audita DESPUÉS de crear la sesión: antes registraría intentos que el
   * proveedor rechazó, y eso ensucia el rastro con ruido que no ocurrió.
   *
   * Y es `.iniciado`, no `.aprobado`: aquí solo se ha abierto la pasarela.
   * Que el pago salga bien lo confirma el webhook, y lo registra aparte.
   */
  await auditarFacturacion(db, ctx.tenantId, 'billing.checkout.iniciado', {
    proveedor: 'STRIPE',
    planNuevo: plan.code,
    planAnterior: suscripcion.plan?.code ?? null,
    monto: plan.priceMonthly.toString(),
    moneda: plan.currency,
    referenciaExterna: session.id,
    estadoAnterior: suscripcion.status,
  }, ctx)

  return { url: session.url, sessionId: session.id }
}

/**
 * Clave estable dentro de la misma hora. No usa un UUID al azar a propósito:
 * la gracia de la idempotencia está en que dos intentos seguidos produzcan la
 * MISMA clave. Se rota cada hora para que un reintento al día siguiente sí
 * cree una sesión nueva (las de Stripe caducan a las 24 h).
 */
export function idempotencyFor(tenantId: string, planId: string, now: Date = new Date()): string {
  const hora = now.toISOString().slice(0, 13) // YYYY-MM-DDTHH
  return `checkout:${tenantId}:${planId}:${hora}`
}

/**
 * Checkout de MercadoPago.
 *
 * Comparte con el de Stripe las tres reglas que importan: el precio sale de
 * nuestra tabla Plan, no escribe NADA en la BD (para que un moroso en
 * READ_ONLY pueda pagar) y exige rol ADMIN o superior.
 *
 * La diferencia relevante es cómo se recupera el tenant después: Stripe
 * acepta metadata y la devuelve en el webhook; MercadoPago no manda metadata
 * en el aviso, así que el único hilo es `external_reference`. De ahí que el
 * webhook tenga que releer el preapproval por API para saber de quién es.
 */
export async function createMercadoPagoCheckout(
  db: TenantPrismaClient,
  ctx: TenantContext,
  mp: MercadoPagoClient,
  input: { planCode: string; appUrl: string },
): Promise<CheckoutResult> {
  if (!puede(ctx, 'plan.gestionar')) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'Solo el dueño puede gestionar la suscripción.',
    )
  }

  const plan = await db.plan.findFirst({
    where: { code: input.planCode, isActive: true },
    select: {
      id: true,
      code: true,
      name: true,
      priceMonthly: true,
      currency: true,
      mercadoPagoPlanId: true,
    },
  })

  if (!plan) {
    throw new BusinessError('PLAN_UNAVAILABLE', 'El plan seleccionado no está disponible.')
  }

  const suscripcion = await db.subscription.findFirst({
    select: {
      status: true,
      externalSubscriptionId: true,
      plan: { select: { code: true } },
    },
  })

  if (!suscripcion) {
    throw new BusinessError('PLAN_UNAVAILABLE', 'Tu cuenta no tiene una suscripción asociada.')
  }

  if (suscripcion.status === 'ACTIVE' && suscripcion.externalSubscriptionId) {
    throw new BusinessError(
      'DUPLICATE_CODE',
      'Tu suscripción ya está activa. Cancélala antes de contratar otra.',
    )
  }

  const owner = await db.user.findFirst({
    where: { role: 'OWNER', isActive: true, deletedAt: null },
    select: { email: true },
    orderBy: { createdAt: 'asc' },
  })

  if (!owner?.email) {
    throw new BusinessError(
      'PLAN_UNAVAILABLE',
      'Tu cuenta no tiene un correo de facturación válido.',
    )
  }

  const base = input.appUrl.replace(/\/+$/, '')

  const { id, initPoint } = await mp.createPreapproval({
    reason: `FerreSaaS · plan ${plan.name}`,
    payerEmail: owner.email,
    amount: plan.priceMonthly.toString(),
    currency: plan.currency,
    backUrl: `${base}/facturacion?checkout=exito`,
    tenantId: ctx.tenantId,
    preapprovalPlanId: plan.mercadoPagoPlanId ?? undefined,
    idempotencyKey: idempotencyFor(ctx.tenantId, plan.id),
  })

  // Mismo criterio que en Stripe: se audita el INICIO tras crear el
  // preapproval, y el resultado lo registra el webhook.
  await auditarFacturacion(db, ctx.tenantId, 'billing.checkout.iniciado', {
    proveedor: 'MERCADOPAGO',
    planNuevo: plan.code,
    planAnterior: suscripcion.plan?.code ?? null,
    monto: plan.priceMonthly.toString(),
    moneda: plan.currency,
    referenciaExterna: id,
    estadoAnterior: suscripcion.status,
  }, ctx)

  return { url: initPoint, sessionId: id }
}
