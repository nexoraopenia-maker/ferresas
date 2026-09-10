import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { createMercadoPagoClient, type MpTransport } from '@/features/billing/mercadopago-client'
import { createMercadoPagoCheckout } from '@/features/billing/checkout-service'
import { normalizeMercadoPagoEvent, mapMercadoPagoStatus } from '@/features/billing/webhook-events'
import { processBillingEvent } from '@/features/billing/webhook-service'
import type { TenantContext } from '@/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

function fakeMp(respuesta: any, status = 200) {
  const visto: { url?: string; body?: any; headers?: any; method?: string } = {}
  const transport: MpTransport = async (url, init) => {
    visto.url = url
    visto.method = init.method
    visto.headers = init.headers
    visto.body = init.body ? JSON.parse(init.body as string) : undefined
    return { status, json: async () => respuesta }
  }
  return { visto, cliente: createMercadoPagoClient({ accessToken: 'APP_USR-falso', transport }) }
}

async function nuevoTenant(estado: any = 'TRIALING') {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({
    data: { slug: `mp-${randomUUID().slice(0, 8)}`, name: 'Ferre MP', planId: plan.id },
  })
  const u = await prisma.user.create({
    data: { email: `mp-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER', tenantId: t.id },
  })
  await prisma.subscription.create({
    data: { tenantId: t.id, planId: plan.id, provider: 'MERCADOPAGO', status: estado },
  })
  const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL' }
  return { t, u, ctx, db: getTenantPrisma(ctx), plan }
}

async function main() {
  console.log('\n1) Creación de la suscripción (preapproval)')
  const A = await nuevoTenant()
  const f = fakeMp({ id: 'preapp_123', init_point: 'https://mercadopago.com/subscriptions/checkout?pref=x' })
  const r = await createMercadoPagoCheckout(A.db, A.ctx, f.cliente, {
    planCode: 'pro', appUrl: 'http://localhost:3999/',
  })
  check('devuelve el enlace de pago', r.url.startsWith('https://mercadopago.com/'))
  check('llama a /preapproval', f.visto.url === 'https://api.mercadopago.com/preapproval')
  check('external_reference lleva el tenantId (único hilo hacia el tenant)',
    f.visto.body.external_reference === A.t.id)
  check('el importe sale de NUESTRO plan',
    f.visto.body.auto_recurring.transaction_amount === Number(A.plan.priceMonthly))
  check('la moneda también', f.visto.body.auto_recurring.currency_id === A.plan.currency)
  check('frecuencia mensual', f.visto.body.auto_recurring.frequency_type === 'months')
  check('envía X-Idempotency-Key', typeof f.visto.headers['X-Idempotency-Key'] === 'string')
  check('el token viaja en Authorization',
    f.visto.headers.Authorization === 'Bearer APP_USR-falso')
  check('back_url absoluta sin doble barra',
    f.visto.body.back_url === 'http://localhost:3999/facturacion?checkout=exito')

  console.log('\n2) Plan preconfigurado en MercadoPago')
  await prisma.plan.update({ where: { code: 'pro' }, data: { mercadoPagoPlanId: 'plan_mp_pro' } })
  const f2 = fakeMp({ id: 'p2', init_point: 'https://mp/x' })
  await createMercadoPagoCheckout(A.db, A.ctx, f2.cliente, { planCode: 'pro', appUrl: 'http://x' })
  check('usa preapproval_plan_id si existe', f2.visto.body.preapproval_plan_id === 'plan_mp_pro')
  check('y entonces NO manda importe en línea', f2.visto.body.auto_recurring === undefined)
  await prisma.plan.update({ where: { code: 'pro' }, data: { mercadoPagoPlanId: null } })

  console.log('\n3) Las mismas garantías que Stripe')
  const ctxAlm: TenantContext = { ...A.ctx, role: 'ALMACENERO' }
  check('ALMACENERO no puede contratar',
    await createMercadoPagoCheckout(getTenantPrisma(ctxAlm), ctxAlm, fakeMp({}).cliente,
      { planCode: 'pro', appUrl: 'http://x' }).then(() => null).catch((e) => e.code) === 'FORBIDDEN_ROLE')

  const ctxRO: TenantContext = { ...A.ctx, access: 'READ_ONLY' }
  const moroso = await createMercadoPagoCheckout(getTenantPrisma(ctxRO), ctxRO,
    fakeMp({ id: 'p3', init_point: 'https://mp/y' }).cliente,
    { planCode: 'pro', appUrl: 'http://x' }).then((v) => v).catch((e) => e)
  check('un moroso en READ_ONLY SÍ puede pagar', 'url' in moroso, moroso?.code ?? 'ok')

  check('un plan inexistente se rechaza',
    await createMercadoPagoCheckout(A.db, A.ctx, fakeMp({}).cliente,
      { planCode: 'nope', appUrl: 'http://x' }).then(() => null).catch((e) => e.code) === 'PLAN_UNAVAILABLE')

  const C = await nuevoTenant('ACTIVE')
  // Id único por corrida: externalSubscriptionId es @unique, así que un valor
  // fijo hace que el test solo pase la primera vez contra una base dada.
  await prisma.subscription.update({
    where: { tenantId: C.t.id },
    data: { externalSubscriptionId: `preapp_activo_${randomUUID().slice(0, 8)}` },
  })
  check('una cuenta ya activa no abre otra suscripción',
    await createMercadoPagoCheckout(C.db, C.ctx, fakeMp({}).cliente,
      { planCode: 'pro', appUrl: 'http://x' }).then(() => null).catch((e) => e.code) === 'DUPLICATE_CODE')

  console.log('\n4) Mapeo de estados de MercadoPago')
  check('authorized -> ACTIVE', mapMercadoPagoStatus('authorized') === 'ACTIVE')
  check('paused -> PAST_DUE', mapMercadoPagoStatus('paused') === 'PAST_DUE')
  check('cancelled -> CANCELED', mapMercadoPagoStatus('cancelled') === 'CANCELED')
  check('pending NO activa nada (el pago aún no se autorizó)',
    mapMercadoPagoStatus('pending') === undefined)

  console.log('\n5) SEGURIDAD: el cuerpo del aviso NO decide nada')
  {
    // MercadoPago firma el manifiesto (id+request-id+ts), NO el cuerpo. Un
    // atacante puede reescribir el JSON y la firma sigue validando.
    const cuerpoManipulado = {
      id: 'evt_mp_1', type: 'subscription_preapproval', action: 'updated',
      data: { id: 'preapp_x' },
      status: 'authorized', // <- inyectado por el atacante
    }
    const sinRelectura = normalizeMercadoPagoEvent(cuerpoManipulado, 'req-1')
    check('sin releer el recurso, NO se toca el estado', sinRelectura?.action === 'NOOP')
    check('y no se infiere ningún status', sinRelectura?.status === undefined)

    const conRelectura = normalizeMercadoPagoEvent(cuerpoManipulado, 'req-1', {
      kind: 'preapproval', id: 'preapp_x', status: 'pending', externalReference: 'tenant-x',
    })
    check('el estado sale de la API, no del cuerpo mentiroso',
      conRelectura?.status === undefined && conRelectura?.action === 'SYNC')
  }

  console.log('\n6) Relectura del recurso desde su API')
  {
    const f3 = fakeMp({ id: 'preapp_9', status: 'authorized', external_reference: 'tenant-9' })
    const pa = await f3.cliente.getPreapproval('preapp_9')
    check('GET /preapproval/:id', f3.visto.url === 'https://api.mercadopago.com/preapproval/preapp_9')
    check('extrae el estado real', pa.status === 'authorized')
    check('y el external_reference', pa.externalReference === 'tenant-9')

    const f4 = fakeMp({ id: 991, status: 'approved', external_reference: 'tenant-9', transaction_amount: 99.9 })
    const pg = await f4.cliente.getPayment('991')
    check('GET /v1/payments/:id', f4.visto.url === 'https://api.mercadopago.com/v1/payments/991')
    check('convierte el importe a decimal', pg.amount === '99.90')
  }

  console.log('\n7) CICLO COMPLETO de MercadoPago hasta la BD')
  const E = await nuevoTenant('TRIALING')
  const preappId = `preapp_${randomUUID().slice(0, 8)}`

  const aplicar = async (payload: any, resource: any) =>
    processBillingEvent({
      provider: 'MERCADOPAGO',
      evento: normalizeMercadoPagoEvent(payload, 'req-x', resource)!,
      payload,
    })

  await aplicar(
    { id: `mpev_${randomUUID().slice(0,6)}`, type: 'subscription_preapproval', action: 'updated',
      data: { id: preappId }, date_created: '2026-08-25T10:00:00.000-04:00' },
    { kind: 'preapproval', id: preappId, status: 'authorized', externalReference: E.t.id },
  )
  const tras = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: E.t.id } })
  check('resuelve el tenant por external_reference', tras.externalSubscriptionId === preappId)
  check('la cuenta queda ACTIVE', tras.status === 'ACTIVE')

  await aplicar(
    { id: `mpev_${randomUUID().slice(0,6)}`, type: 'payment', action: 'created',
      data: { id: '991' }, date_created: '2026-08-25T10:05:00.000-04:00' },
    { kind: 'payment', id: '991', status: 'approved', externalReference: E.t.id,
      preapprovalId: preappId, amount: '99.90' },
  )
  const conPago = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: E.t.id } })
  check('un pago aprobado registra el importe', conPago.lastPaymentAmount?.toString() === '99.9')

  await aplicar(
    { id: `mpev_${randomUUID().slice(0,6)}`, type: 'payment', action: 'updated',
      data: { id: '992' }, date_created: '2026-09-25T10:00:00.000-04:00' },
    { kind: 'payment', id: '992', status: 'rejected', externalReference: E.t.id, preapprovalId: preappId },
  )
  const moroso2 = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: E.t.id } })
  check('un pago rechazado abre la mora',
    moroso2.status === 'PAST_DUE' && moroso2.pastDueSince !== null)

  await aplicar(
    { id: `mpev_${randomUUID().slice(0,6)}`, type: 'subscription_preapproval', action: 'cancelled',
      data: { id: preappId }, date_created: '2026-10-01T10:00:00.000-04:00' },
    { kind: 'preapproval', id: preappId, status: 'cancelled', externalReference: E.t.id },
  )
  check('la cancelación en MercadoPago cancela aquí',
    (await prisma.subscription.findUniqueOrThrow({ where: { tenantId: E.t.id } })).status === 'CANCELED')

  console.log('\n8) Errores de la API')
  check('un 400 se propaga como MercadoPagoError',
    await fakeMp({ message: 'invalid_token' }, 400).cliente.getPreapproval('x')
      .then(() => null).catch((e) => e.name) === 'MercadoPagoError')
  check('un preapproval sin init_point no se da por bueno',
    await createMercadoPagoCheckout(A.db, A.ctx, fakeMp({ id: 'p' }).cliente,
      { planCode: 'pro', appUrl: 'http://x' }).then(() => null).catch((e) => e.name) === 'MercadoPagoError')

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
