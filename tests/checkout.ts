import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { createStripeClient, type StripeTransport } from '@/features/billing/stripe-client'
import { createCheckoutSession, idempotencyFor } from '@/features/billing/checkout-service'
import { normalizeStripeEvent } from '@/features/billing/webhook-events'
import { processBillingEvent } from '@/features/billing/webhook-service'
import { computeAccessLevel } from '@/lib/tenant-context'
import type { TenantContext } from '@/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

/** Transporte falso: captura la petición y devuelve lo que le digamos. */
function fakeStripe(respuesta: any = { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }, status = 200) {
  const visto: { url?: string; body?: string; headers?: any } = {}
  const transport: StripeTransport = async (url, init) => {
    visto.url = url
    visto.body = init.body as string
    visto.headers = init.headers
    return { status, json: async () => respuesta }
  }
  return { visto, cliente: createStripeClient({ secretKey: 'sk_test_falsa', transport }) }
}

async function nuevoTenant(estado: any = 'TRIALING', extra: any = {}) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({
    data: { slug: `co-${randomUUID().slice(0, 8)}`, name: 'Ferre Checkout', planId: plan.id },
  })
  const u = await prisma.user.create({
    data: { email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER', tenantId: t.id },
  })
  await prisma.subscription.create({
    data: {
      tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: estado,
      trialEndsAt: new Date(Date.now() + 5 * 864e5), ...extra,
    },
  })
  const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL' }
  return { t, u, ctx, db: getTenantPrisma(ctx) }
}

async function main() {
  console.log('\n1) Sesión de checkout: qué se le manda a Stripe')
  const A = await nuevoTenant()
  const { visto, cliente } = fakeStripe()
  const r = await createCheckoutSession(A.db, A.ctx, cliente, {
    planCode: 'pro', appUrl: 'http://localhost:3999/',
  })
  const body = decodeURIComponent(visto.body ?? '')
  check('devuelve la URL de pago', r.url.startsWith('https://checkout.stripe.com/'))
  check('llama al endpoint correcto', visto.url === 'https://api.stripe.com/v1/checkout/sessions')
  check('modo suscripción', body.includes('mode=subscription'))
  check('usa el priceId DE NUESTRA BD', body.includes('price_pro'))
  check('manda client_reference_id con el tenant', body.includes(`client_reference_id=${A.t.id}`))
  check('y metadata[tenantId], para el webhook', body.includes(`metadata[tenantId]=${A.t.id}`))
  check('también en subscription_data (llega antes a veces)',
    body.includes(`subscription_data[metadata][tenantId]=${A.t.id}`))
  check('URL de éxito absoluta y sin doble barra',
    body.includes('success_url=http://localhost:3999/facturacion?checkout=exito'), '')
  check('respeta el trial que le quedaba', body.includes('subscription_data[trial_end]='))
  check('envía Idempotency-Key', typeof visto.headers['Idempotency-Key'] === 'string')
  check('la clave es estable para el mismo tenant+plan+hora',
    idempotencyFor('t1', 'p1', new Date('2026-08-25T10:30:00Z')) ===
    idempotencyFor('t1', 'p1', new Date('2026-08-25T10:59:00Z')))
  check('pero cambia a la hora siguiente',
    idempotencyFor('t1', 'p1', new Date('2026-08-25T10:30:00Z')) !==
    idempotencyFor('t1', 'p1', new Date('2026-08-25T11:30:00Z')))
  check('la clave secreta viaja en Authorization, no en el cuerpo',
    visto.headers.Authorization === 'Bearer sk_test_falsa' && !body.includes('sk_test'))

  console.log('\n2) El precio NUNCA viene del cliente')
  const malPlan = await createCheckoutSession(A.db, A.ctx, fakeStripe().cliente, {
    planCode: 'plan_inventado', appUrl: 'http://x',
  }).then(() => null).catch((e) => e)
  check('un planCode inexistente se rechaza', malPlan?.code === 'PLAN_UNAVAILABLE')
  await prisma.plan.update({ where: { code: 'premium' }, data: { stripePriceMonthly: null } })
  const sinPrecio = await createCheckoutSession(A.db, A.ctx, fakeStripe().cliente, {
    planCode: 'premium', appUrl: 'http://x',
  }).then(() => null).catch((e) => e)
  check('un plan sin precio de Stripe no genera checkout', sinPrecio?.code === 'PLAN_UNAVAILABLE')
  await prisma.plan.update({ where: { code: 'premium' }, data: { stripePriceMonthly: 'price_premium' } })

  console.log('\n3) EL CASO CRÍTICO: un moroso en READ_ONLY debe poder pagar')
  const B = await nuevoTenant('PAST_DUE', { pastDueSince: new Date('2026-01-01') })
  const ctxRO: TenantContext = { ...B.ctx, access: 'READ_ONLY' }
  const dbRO = getTenantPrisma(ctxRO)
  const pagoMoroso = await createCheckoutSession(dbRO, ctxRO, fakeStripe().cliente, {
    planCode: 'pro', appUrl: 'http://x',
  }).then((v) => v).catch((e) => e)
  check('el checkout FUNCIONA en READ_ONLY',
    'url' in pagoMoroso, pagoMoroso?.code ?? 'ok')
  check('porque no escribe nada en la BD',
    (await prisma.webhookEvent.count({ where: { tenantId: B.t.id } })) === 0)

  console.log('\n4) Autorización')
  const ctxAlm: TenantContext = { ...A.ctx, role: 'ALMACENERO' }
  const rolErr = await createCheckoutSession(getTenantPrisma(ctxAlm), ctxAlm, fakeStripe().cliente, {
    planCode: 'pro', appUrl: 'http://x',
  }).then(() => null).catch((e) => e)
  check('un ALMACENERO no puede contratar', rolErr?.code === 'FORBIDDEN_ROLE')

  console.log('\n5) Cuenta ya activa: al portal, no a un segundo checkout')
  const C = await nuevoTenant('ACTIVE', { externalSubscriptionId: `sub_${randomUUID().slice(0,6)}` })
  const dobleCobro = await createCheckoutSession(C.db, C.ctx, fakeStripe().cliente, {
    planCode: 'pro', appUrl: 'http://x',
  }).then(() => null).catch((e) => e)
  check('se bloquea para no cobrar dos veces', dobleCobro?.code === 'DUPLICATE_CODE')
  check('y el mensaje orienta al portal', /portal/i.test(dobleCobro?.message ?? ''))

  console.log('\n6) Cliente existente de Stripe: no se duplica')
  const D = await nuevoTenant('PAST_DUE', { externalCustomerId: 'cus_ya_existe' })
  const f2 = fakeStripe()
  await createCheckoutSession(D.db, D.ctx, f2.cliente, { planCode: 'pro', appUrl: 'http://x' })
  const b2 = decodeURIComponent(f2.visto.body ?? '')
  check('reutiliza el customer existente', b2.includes('customer=cus_ya_existe'))
  check('y NO manda customer_email', !b2.includes('customer_email'))

  console.log('\n7) Errores de Stripe')
  const errStripe = await createCheckoutSession(A.db, A.ctx,
    fakeStripe({ error: { code: 'resource_missing', message: 'No such price: price_pro' } }, 400).cliente,
    { planCode: 'pro', appUrl: 'http://x' }).then(() => null).catch((e) => e)
  check('un 400 de Stripe se propaga como StripeError', errStripe?.name === 'StripeError')
  check('conserva el código para el log', errStripe?.stripeCode === 'resource_missing')
  const sinUrl = await createCheckoutSession(A.db, A.ctx,
    fakeStripe({ id: 'cs_1' }).cliente, { planCode: 'pro', appUrl: 'http://x' })
    .then(() => null).catch((e) => e)
  check('una sesión sin URL no se da por buena', errStripe !== null && sinUrl?.name === 'StripeError')

  console.log('\n8) CICLO COMPLETO: clic en pagar -> webhook -> BD en ACTIVE')
  const E = await nuevoTenant('TRIALING')
  const antes = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: E.t.id } })
  check('parte en TRIALING sin ids de Stripe',
    antes.status === 'TRIALING' && antes.externalSubscriptionId === null)

  const f3 = fakeStripe()
  await createCheckoutSession(E.db, E.ctx, f3.cliente, { planCode: 'pro', appUrl: 'http://x' })

  const subId = `sub_${randomUUID().slice(0, 8)}`
  const cusId = `cus_${randomUUID().slice(0, 8)}`
  const seg = (d: Date) => Math.floor(d.getTime() / 1000)
  const aplicar = async (p: any) =>
    processBillingEvent({ provider: 'STRIPE', evento: normalizeStripeEvent(p)!, payload: p })

  // Stripe entrega estos tres tras un pago real.
  await aplicar({
    id: `evt_${randomUUID().slice(0,8)}`, type: 'checkout.session.completed',
    created: seg(new Date('2026-08-25T10:00:00Z')),
    data: { object: { subscription: subId, customer: cusId, client_reference_id: E.t.id,
                      metadata: { tenantId: E.t.id } } },
  })
  const trasCheckout = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: E.t.id } })
  check('checkout.session.completed vincula la suscripción de Stripe',
    trasCheckout.externalSubscriptionId === subId && trasCheckout.externalCustomerId === cusId)

  await aplicar({
    id: `evt_${randomUUID().slice(0,8)}`, type: 'customer.subscription.created',
    created: seg(new Date('2026-08-25T10:00:05Z')),
    data: { object: { id: subId, status: 'active', customer: cusId,
                      current_period_end: seg(new Date('2026-09-25T10:00:00Z')),
                      metadata: { tenantId: E.t.id } } },
  })
  await aplicar({
    id: `evt_${randomUUID().slice(0,8)}`, type: 'invoice.payment_succeeded',
    created: seg(new Date('2026-08-25T10:00:10Z')),
    data: { object: { subscription: subId, customer: cusId, amount_paid: 9900 } },
  })

  const final = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: E.t.id } })
  check('la BD queda en ACTIVE', final.status === 'ACTIVE')
  check('registra el importe cobrado', final.lastPaymentAmount?.toString() === '99')
  check('guarda cuándo renueva',
    final.currentPeriodEnd?.toISOString() === '2026-09-25T10:00:00.000Z')
  check('el acceso efectivo pasa a FULL',
    computeAccessLevel({ isActive: true }, {
      status: final.status, pastDueSince: final.pastDueSince, graceDays: final.graceDays,
      trialEndsAt: final.trialEndsAt, currentPeriodEnd: final.currentPeriodEnd,
    }, new Date('2026-09-01T10:00:00Z')) === 'FULL')

  console.log('\n9) Eventos del checkout desordenados')
  const F = await nuevoTenant('TRIALING')
  const subF = `sub_${randomUUID().slice(0, 8)}`
  // Primero el evento MÁS NUEVO...
  await aplicar({
    id: `evt_${randomUUID().slice(0,8)}`, type: 'customer.subscription.created',
    created: seg(new Date('2026-08-25T10:00:05Z')),
    data: { object: { id: subF, status: 'active', metadata: { tenantId: F.t.id } } },
  })
  // ...y después el checkout.session.completed, que es ANTERIOR.
  await aplicar({
    id: `evt_${randomUUID().slice(0,8)}`, type: 'checkout.session.completed',
    created: seg(new Date('2026-08-25T10:00:00Z')),
    data: { object: { subscription: subF, customer: 'cus_tardio', client_reference_id: F.t.id,
                      metadata: { tenantId: F.t.id } } },
  })
  const fFinal = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: F.t.id } })
  check('el evento tardío no revierte el estado', fFinal.status === 'ACTIVE')
  check('pero SÍ se rescata el customerId que solo él traía',
    fFinal.externalCustomerId === 'cus_tardio', String(fFinal.externalCustomerId))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
