import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { crearSucursal, asignarSucursal } from './fixtures'
import { prisma } from '@/lib/prisma'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { createCheckoutSession, createMercadoPagoCheckout } from '@/features/billing/checkout-service'
import { processBillingEvent } from '@/features/billing/webhook-service'
import type { TenantContext } from '@/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const M = randomUUID().slice(0, 6)
const code = async (fn: () => Promise<unknown>) =>
  fn().then(() => 'SIN_ERROR').catch((e) => (e as { code?: string }).code ?? 'ERR')

/** Stripe simulado: devuelve una sesión sin salir a la red. */
const stripeFalso = {
  createCheckoutSession: async () => ({ id: `cs_test_${M}`, url: 'https://stripe.test/pagar' }),
  createPortalSession: async () => ({ url: 'https://stripe.test/portal' }),
} as never

const mpFalso = {
  createPreapproval: async () => ({ id: `mp_${M}`, initPoint: 'https://mp.test/pagar' }),
} as never

async function main() {
  const basico = await prisma.plan.findUniqueOrThrow({ where: { code: 'basico' } })
  const premium = await prisma.plan.findUniqueOrThrow({ where: { code: 'premium' } })

  const t = await prisma.tenant.create({
    data: { slug: `aud-${M}`, name: 'Auditoría', planId: basico.id },
  })
  const owner = await prisma.user.create({
    data: { email: `aud-${M}@x.com`, name: 'Dueño', role: 'OWNER', tenantId: t.id },
  })
  const b = await crearSucursal(t.id)
  await asignarSucursal(t.id, owner.id, b.id)
  await prisma.subscription.create({
    data: { tenantId: t.id, planId: basico.id, status: 'TRIALING', trialEndsAt: new Date(Date.now() + 86_400_000) },
  })
  const ctx: TenantContext = {
    tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL', branchId: b.id,
  }
  const db = getTenantPrisma(ctx)

  const registros = (accion: string) =>
    db.auditLog.findMany({
      where: { action: accion },
      orderBy: { createdAt: 'desc' },
      select: { actorId: true, actorRole: true, action: true, before: true, after: true, entityId: true },
    })

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n1) >>> EL CHECKOUT DE STRIPE SE AUDITA')
  // Antes NO se auditaba, y por eso no se pudo responder «¿algún ADMIN
  // contrató un plan?»: no había nada que contar.
  check('antes del checkout no hay registros', (await registros('billing.checkout.iniciado')).length === 0)

  await createCheckoutSession(db, ctx, stripeFalso, {
    planCode: 'premium', appUrl: 'https://app.test',
  })

  const r1 = await registros('billing.checkout.iniciado')
  check('>>> ahora SÍ hay registro', r1.length === 1)
  const a1 = r1[0]!
  check('con QUIÉN', a1.actorId === owner.id)
  check('y su rol', a1.actorRole === 'OWNER')
  check('>>> plan ANTERIOR', (a1.before as { plan?: string }).plan === 'basico')
  check('>>> plan NUEVO', (a1.after as { plan?: string }).plan === 'premium')
  check('>>> MONTO', (a1.after as { monto?: string }).monto === premium.priceMonthly.toString(),
    String((a1.after as { monto?: string }).monto))
  check('>>> y MONEDA', (a1.after as { moneda?: string }).moneda === premium.currency)
  check('>>> PROVEEDOR', (a1.after as { proveedor?: string }).proveedor === 'STRIPE')
  check('referencia de la sesión, para cruzar con el panel de Stripe',
    a1.entityId === `cs_test_${M}`)
  check('estado anterior de la suscripción',
    (a1.before as { estado?: string }).estado === 'TRIALING')

  console.log('\n2) El de MercadoPago también')
  await createMercadoPagoCheckout(db, ctx, mpFalso, {
    planCode: 'premium', appUrl: 'https://app.test',
  })
  const r2 = (await registros('billing.checkout.iniciado')).filter(
    (r) => (r.after as { proveedor?: string }).proveedor === 'MERCADOPAGO',
  )
  check('>>> hay registro de MercadoPago', r2.length === 1)
  check('con su proveedor', (r2[0]!.after as { proveedor?: string }).proveedor === 'MERCADOPAGO')
  check('y su referencia de preapproval', r2[0]!.entityId === `mp_${M}`)

  console.log('\n3) >>> SE AUDITA EL INICIO, NO EL ÉXITO')
  // Abrir la pasarela no es haber cobrado. Confundirlos haría creer que un
  // cliente pagó cuando solo llegó a ver la pantalla de pago.
  check('la acción dice "iniciado", no "aprobado"',
    r1.every((r) => r.action === 'billing.checkout.iniciado'))
  check('no existe ningún registro de aprobado todavía',
    (await registros('billing.checkout.aprobado')).length === 0)

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n4) >>> EL RESULTADO DEL WEBHOOK, CON PLAN, MONTO Y PROVEEDOR')
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: t.id } })
  await prisma.subscription.update({
    where: { id: sub.id },
    data: { externalSubscriptionId: `sub_${M}`, planId: premium.id },
  })

  const aprobado = await processBillingEvent({
    provider: 'STRIPE',
    evento: {
      externalEventId: `evt_ok_${M}`,
      rawType: 'invoice.payment_succeeded',
      action: 'ACTIVATE',
      occurredAt: new Date(),
      externalSubscriptionId: `sub_${M}`,
      amount: '99.00',
    },
    payload: {},
  })
  check('el webhook se procesa', aprobado.status === 'PROCESADO', aprobado.status)

  const rAct = await registros('billing.activate')
  check('>>> hay registro del cobro aprobado', rAct.length === 1)
  const act = rAct[0]!
  check('sin actor: lo movió el proveedor, no una persona', act.actorId === null)
  check('>>> con el PLAN vigente', (act.after as { plan?: string }).plan === 'premium',
    String((act.after as { plan?: string }).plan))
  check('>>> con el MONTO que informó el proveedor',
    (act.after as { monto?: string }).monto === '99.00',
    String((act.after as { monto?: string }).monto))
  check('>>> con la MONEDA', (act.after as { moneda?: string }).moneda === premium.currency)
  check('>>> y con el PROVEEDOR', (act.after as { proveedor?: string }).proveedor === 'STRIPE')
  check('estado anterior y nuevo',
    (act.before as { status?: string }).status === 'TRIALING' &&
    (act.after as { status?: string }).status === 'ACTIVE')

  console.log('\n5) Pago fallido y cancelación')
  await processBillingEvent({
    provider: 'STRIPE',
    evento: {
      externalEventId: `evt_fail_${M}`,
      rawType: 'invoice.payment_failed',
      action: 'MARK_PAST_DUE',
      occurredAt: new Date(),
      externalSubscriptionId: `sub_${M}`,
    },
    payload: {},
  })
  const rFail = await registros('billing.mark_past_due')
  check('>>> el fallido queda registrado', rFail.length === 1)
  check('con el proveedor', (rFail[0]!.after as { proveedor?: string }).proveedor === 'STRIPE')
  check('y el cambio de estado a PAST_DUE',
    (rFail[0]!.after as { status?: string }).status === 'PAST_DUE')

  await processBillingEvent({
    provider: 'MERCADOPAGO',
    evento: {
      externalEventId: `evt_cancel_${M}`,
      rawType: 'preapproval.cancelled',
      action: 'CANCEL',
      occurredAt: new Date(),
      externalSubscriptionId: `sub_${M}`,
    },
    payload: {},
  })
  const rCancel = await registros('billing.cancel')
  check('>>> la cancelación queda registrada', rCancel.length === 1)
  check('>>> con el proveedor correcto, no el del evento anterior',
    (rCancel[0]!.after as { proveedor?: string }).proveedor === 'MERCADOPAGO',
    String((rCancel[0]!.after as { proveedor?: string }).proveedor))

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n6) >>> UN MOROSO EN READ_ONLY SIGUE PUDIENDO PAGAR')
  /*
   * El caso que casi rompo al añadir la auditoría. Los checkouts declaran que
   * no escriben en la BD para que una cuenta en READ_ONLY pueda pagar, y
   * auditar es escribir: el guard la habría cortado, bloqueando justo a quien
   * más necesita pagar.
   */
  const ctxMoroso: TenantContext = { ...ctx, access: 'READ_ONLY' }
  const dbMoroso = getTenantPrisma(ctxMoroso)

  check('una escritura normal SÍ está bloqueada en READ_ONLY',
    await code(() => dbMoroso.customer.create({
      data: { tenantId: t.id, name: 'No debería' },
    })) === 'SUBSCRIPTION_READ_ONLY')

  check('>>> pero el registro de auditoría NO: es constancia, no mutación',
    await code(() => dbMoroso.auditLog.create({
      data: { tenantId: t.id, action: 'prueba.readonly' },
    })) === 'SIN_ERROR')

  await prisma.subscription.update({
    where: { id: sub.id }, data: { status: 'PAST_DUE', externalSubscriptionId: null },
  })
  check('>>> y el CHECKOUT completo funciona en READ_ONLY, auditoría incluida',
    await code(() => createCheckoutSession(dbMoroso, ctxMoroso, stripeFalso, {
      planCode: 'premium', appUrl: 'https://app.test',
    })) === 'SIN_ERROR')
  check('con su registro escrito',
    (await registros('billing.checkout.iniciado')).length >= 3)

  check('en BLOCKED también se puede auditar',
    await code(() => getTenantPrisma({ ...ctx, access: 'BLOCKED' }).auditLog.create({
      data: { tenantId: t.id, action: 'prueba.blocked' },
    })) === 'SIN_ERROR')
  check('pero NO escribir datos de negocio',
    await code(() => getTenantPrisma({ ...ctx, access: 'BLOCKED' }).customer.create({
      data: { tenantId: t.id, name: 'No' },
    })) === 'SUBSCRIPTION_BLOCKED')

  console.log('\n7) La auditoría NUNCA tumba el pago')
  /*
   * Si el registro falla, la operación de pago debe seguir. Perder una línea
   * es malo; impedir cobrar porque no se pudo registrar es peor, y convierte
   * un problema de observación en una caída de ingresos.
   */
  const { auditarFacturacion } = await import('@/features/billing/audit')
  check('>>> auditar contra un tenant inexistente no lanza',
    await code(() => auditarFacturacion(
      db, 'tenant-que-no-existe', 'billing.checkout.iniciado', { proveedor: 'STRIPE' },
    )) === 'SIN_ERROR')

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
