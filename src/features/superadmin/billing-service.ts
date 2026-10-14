import { prisma } from '@/lib/prisma'
import { BusinessError } from '@/lib/errors'
import type { ChangeTenantPlanInput, ExtendTrialInput } from './schemas'

/**
 * Gestión manual de la suscripción de un cliente (§5.3).
 *
 * ─── EL LÍMITE DE LO QUE ESTO PUEDE HACER ────────────────────────────────
 *
 * Cambiar el plan aquí cambia lo que el cliente PUEDE hacer en FerreSaaS
 * (límites del plan) pero NO lo que se le COBRA en Stripe o MercadoPago: eso
 * vive en la pasarela y la mueve su webhook. Es deliberado — si esta función
 * tocara el estado de pago, dejaría de ser cierto que el webhook es la única
 * fuente de verdad, y ya no habría forma de saber qué cifra es la real.
 *
 * Sirve para lo que sirve: conceder un plan superior a un cliente que
 * negoció condiciones, o corregir un alta mal hecha. El cobro se ajusta en
 * la pasarela, aparte.
 */

interface ActorAuditado {
  id: string
  email: string
}

export async function changeTenantPlan(
  input: ChangeTenantPlanInput,
  actor: ActorAuditado,
  now: Date = new Date(),
): Promise<{ planName: string; cobroSincronizado: boolean }> {
  const [tenant, plan] = await Promise.all([
    prisma.tenant.findFirst({
      where: { id: input.tenantId, deletedAt: null },
      select: {
        id: true,
        name: true,
        subscription: {
          select: {
            id: true,
            planId: true,
            provider: true,
            externalSubscriptionId: true,
            plan: { select: { name: true } },
          },
        },
      },
    }),
    prisma.plan.findFirst({
      where: { code: input.planCode, isActive: true },
      select: { id: true, name: true },
    }),
  ])

  if (!tenant) throw new BusinessError('TENANT_MISMATCH', 'Cuenta no encontrada.')
  if (!plan) throw new BusinessError('PLAN_UNAVAILABLE', 'Ese plan no está disponible.')
  if (!tenant.subscription) {
    throw new BusinessError('PLAN_UNAVAILABLE', 'La cuenta no tiene suscripción.')
  }
  if (tenant.subscription.planId === plan.id) {
    throw new BusinessError('DUPLICATE_CODE', `La cuenta ya está en el plan ${plan.name}.`)
  }

  const anterior = tenant.subscription.plan?.name ?? '—'

  await prisma.$transaction([
    prisma.subscription.update({
      where: { id: tenant.subscription.id },
      data: { planId: plan.id },
    }),
    // Se actualiza también el plan cacheado en Tenant para que no queden los
    // dos diciendo cosas distintas.
    prisma.tenant.update({ where: { id: tenant.id }, data: { planId: plan.id } }),
    prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorId: actor.id,
        actorRole: 'SUPERADMIN',
        actorEmail: actor.email,
        action: 'tenant.plan.change',
        entityType: 'Subscription',
        entityId: tenant.subscription.id,
        reason: input.reason,
        before: { plan: anterior },
        after: { plan: plan.name },
      },
    }),
  ])

  return {
    planName: plan.name,
    // Avisa a la UI de que el cobro en la pasarela sigue siendo el viejo.
    cobroSincronizado: !tenant.subscription.externalSubscriptionId,
  }
}

export async function extendTrial(
  input: ExtendTrialInput,
  actor: ActorAuditado,
  now: Date = new Date(),
): Promise<{ trialEndsAt: Date }> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: input.tenantId, deletedAt: null },
    select: {
      id: true,
      subscription: { select: { id: true, status: true, trialEndsAt: true } },
    },
  })

  if (!tenant?.subscription) {
    throw new BusinessError('TENANT_MISMATCH', 'Cuenta no encontrada.')
  }

  const sub = tenant.subscription
  if (sub.status === 'ACTIVE') {
    throw new BusinessError(
      'DUPLICATE_CODE',
      'La cuenta ya está pagando: extender la prueba no tiene efecto.',
    )
  }

  // Se cuenta desde HOY si la prueba ya venció, y desde su fin si aún corre.
  // Sumar siempre sobre `trialEndsAt` regalaría días en el pasado a una
  // cuenta caducada hace meses: la prueba "nueva" nacería ya vencida.
  const base = sub.trialEndsAt && sub.trialEndsAt > now ? sub.trialEndsAt : now
  const trialEndsAt = new Date(base.getTime() + input.days * 86_400_000)

  await prisma.$transaction([
    prisma.subscription.update({
      where: { id: sub.id },
      data: {
        trialEndsAt,
        // Devuelve a TRIALING una cuenta que el cron ya había cerrado.
        status: 'TRIALING',
        canceledAt: null,
        pastDueSince: null,
      },
    }),
    prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorId: actor.id,
        actorRole: 'SUPERADMIN',
        actorEmail: actor.email,
        action: 'tenant.trial.extend',
        entityType: 'Subscription',
        entityId: sub.id,
        reason: input.reason,
        before: { status: sub.status, trialEndsAt: sub.trialEndsAt?.toISOString() ?? null },
        after: { status: 'TRIALING', trialEndsAt: trialEndsAt.toISOString(), dias: input.days },
      },
    }),
  ])

  return { trialEndsAt }
}
