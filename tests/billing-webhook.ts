import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { normalizeStripeEvent, mapStripeStatus } from '@/features/billing/webhook-events'
import { processBillingEvent } from '@/features/billing/webhook-service'
import { computeAccessLevel } from '@/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

const seg = (d: Date) => Math.floor(d.getTime() / 1000)

function stripeEvent(type: string, obj: any, created: Date, id = `evt_${randomUUID().slice(0, 8)}`) {
  return { id, type, created: seg(created), data: { object: obj } }
}

async function aplicar(payload: any) {
  const evento = normalizeStripeEvent(payload)!
  return processBillingEvent({ provider: 'STRIPE', evento, payload })
}

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({
    data: { slug: `wh-${randomUUID().slice(0, 8)}`, name: 'Ferre WH', planId: plan.id },
  })
  const subId = `sub_${randomUUID().slice(0, 8)}`
  await prisma.subscription.create({
    data: {
      tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'TRIALING',
      externalSubscriptionId: subId, externalCustomerId: 'cus_test',
    },
  })
  const leer = () => prisma.subscription.findUniqueOrThrow({ where: { tenantId: t.id } })
  const T0 = new Date('2026-08-01T10:00:00Z')

  console.log('\n1) Mapeo de estados de Stripe')
  check('trialing -> TRIALING', mapStripeStatus('trialing') === 'TRIALING')
  check('active -> ACTIVE', mapStripeStatus('active') === 'ACTIVE')
  check('past_due -> PAST_DUE', mapStripeStatus('past_due') === 'PAST_DUE')
  check('unpaid -> PAST_DUE (recuperable pagando, no cancelado)',
    mapStripeStatus('unpaid') === 'PAST_DUE')
  check('incomplete -> PAST_DUE, no CANCELED', mapStripeStatus('incomplete') === 'PAST_DUE')
  check('canceled -> CANCELED', mapStripeStatus('canceled') === 'CANCELED')
  check('estado desconocido no inventa nada', mapStripeStatus('vaya_cosa') === undefined)

  console.log('\n2) invoice.payment_succeeded activa la cuenta')
  const pago = stripeEvent('invoice.payment_succeeded',
    { subscription: subId, customer: 'cus_test', amount_paid: 9900 }, T0)
  const r1 = await aplicar(pago)
  check('resuelve el tenant por externalSubscriptionId',
    r1.status === 'PROCESADO' && r1.tenantId === t.id)
  const s1 = await leer()
  check('la suscripción queda ACTIVE', s1.status === 'ACTIVE')
  check('registra el importe convertido de céntimos',
    s1.lastPaymentAmount?.toString() === '99', s1.lastPaymentAmount?.toString())
  check('guarda el id del último evento aplicado', s1.lastEventId === pago.id)

  console.log('\n3) IDEMPOTENCIA — el mismo evento reentregado')
  const r2 = await aplicar(pago)
  check('la segunda entrega se detecta como duplicada', r2.status === 'DUPLICADO')
  check('solo hay UNA fila en WebhookEvent',
    (await prisma.webhookEvent.count({ where: { externalEventId: pago.id } })) === 1)

  console.log('\n4) invoice.payment_failed abre el período de gracia')
  const T1 = new Date('2026-09-01T10:00:00Z')
  await aplicar(stripeEvent('invoice.payment_failed', { subscription: subId }, T1))
  const s2 = await leer()
  check('pasa a PAST_DUE', s2.status === 'PAST_DUE')
  check('marca el inicio de la mora', s2.pastDueSince?.toISOString() === T1.toISOString())

  const T2 = new Date('2026-09-04T10:00:00Z')
  await aplicar(stripeEvent('invoice.payment_failed', { subscription: subId }, T2))
  const s3 = await leer()
  check('un segundo intento fallido NO reinicia el contador de gracia',
    s3.pastDueSince?.toISOString() === T1.toISOString(), s3.pastDueSince?.toISOString())

  console.log('\n5) El estado se traduce a acceso real (§5.2)')
  const acc = (s: any, now: Date) =>
    computeAccessLevel({ isActive: true }, {
      status: s.status, pastDueSince: s.pastDueSince, graceDays: s.graceDays,
      trialEndsAt: s.trialEndsAt, currentPeriodEnd: s.currentPeriodEnd,
    }, now)
  check('día 3 de mora -> WARN, sigue operando',
    acc(s3, new Date('2026-09-04T10:00:00Z')) === 'WARN')
  check('día 12 de mora -> READ_ONLY',
    acc(s3, new Date('2026-09-13T10:00:00Z')) === 'READ_ONLY')

  console.log('\n6) Se pone al día: la mora se limpia')
  const T3 = new Date('2026-09-05T10:00:00Z')
  await aplicar(stripeEvent('invoice.payment_succeeded',
    { subscription: subId, amount_paid: 9900 }, T3))
  const s4 = await leer()
  check('vuelve a ACTIVE', s4.status === 'ACTIVE')
  check('pastDueSince se limpia (no arrastra el impago viejo)', s4.pastDueSince === null)
  check('y el acceso vuelve a FULL', acc(s4, new Date('2026-09-20T10:00:00Z')) === 'FULL')

  console.log('\n7) ORDEN — un evento viejo no puede resucitar una cuenta')
  const T4 = new Date('2026-10-01T10:00:00Z')
  await aplicar(stripeEvent('customer.subscription.deleted', { id: subId }, T4))
  const s5 = await leer()
  check('customer.subscription.deleted cancela', s5.status === 'CANCELED')
  check('registra canceledAt', s5.canceledAt?.toISOString() === T4.toISOString())

  // Un payment_succeeded de septiembre que estaba reintentándose y llega ahora.
  const rezagado = await aplicar(stripeEvent('invoice.payment_succeeded',
    { subscription: subId, amount_paid: 9900 }, new Date('2026-09-20T10:00:00Z')))
  check('un pago ANTERIOR que llega tarde se ignora', rezagado.status === 'IGNORADO')
  check('la cuenta SIGUE cancelada', (await leer()).status === 'CANCELED')
  check('el evento fuera de orden queda registrado como IGNORADO',
    (await prisma.webhookEvent.count({ where: { status: 'IGNORADO' } })) >= 1)

  console.log('\n8) Suscripción desconocida')
  const ajeno = await aplicar(stripeEvent('invoice.payment_succeeded',
    { subscription: 'sub_de_otro_saas', amount_paid: 100 }, new Date()))
  check('se ignora en vez de reventar', ajeno.status === 'IGNORADO')
  check('responde sin tocar ninguna suscripción',
    ajeno.status === 'IGNORADO' && ajeno.reason.includes('no encontrada'))

  console.log('\n9) Reprocesado tras un fallo transitorio')
  const evFallido = stripeEvent('invoice.payment_succeeded', { subscription: subId }, new Date('2026-11-01T10:00:00Z'))
  await prisma.webhookEvent.create({
    data: {
      provider: 'STRIPE', externalEventId: evFallido.id, type: evFallido.type,
      payload: evFallido as any, status: 'FALLIDO', error: 'cayó la BD', attempts: 1,
    },
  })
  const reintento = await aplicar(evFallido)
  check('un evento FALLIDO SÍ se reprocesa (no se descarta por duplicado)',
    reintento.status === 'PROCESADO', reintento.status)
  check('y el contador de intentos sube',
    (await prisma.webhookEvent.findFirstOrThrow({ where: { externalEventId: evFallido.id } })).attempts === 2)

  console.log('\n10) Trazabilidad')
  check('cada cambio deja AuditLog sin actor humano',
    (await prisma.auditLog.count({ where: { tenantId: t.id, actorId: null } })) > 0)
  check('el payload crudo queda guardado para depurar',
    (await prisma.webhookEvent.findFirstOrThrow({ where: { externalEventId: pago.id } })).payload !== null)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
