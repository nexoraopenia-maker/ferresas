import { Prisma } from '@/generated/prisma/client'
import type { PaymentProvider } from '@/generated/prisma/enums'
import { prisma } from '@/lib/prisma'
import type { NormalizedEvent } from './webhook-events'

/**
 * Procesamiento de webhooks de facturación.
 *
 * ⚠️ EXCEPCIÓN DELIBERADA a la regla de oro (§3): usa el cliente base, no
 * `getTenantPrisma()`. Un webhook llega sin sesión, así que no hay contexto
 * de tenant que inyectar — el tenant se DESCUBRE a partir del evento. Cada
 * escritura lleva su `tenantId` explícito, resuelto desde la suscripción que
 * el proveedor identificó.
 *
 * ─── LAS TRES GARANTÍAS ──────────────────────────────────────────────────
 *
 * 1. IDEMPOTENCIA. Stripe reintenta ante cualquier respuesta que no sea 2xx,
 *    y también puede entregar el mismo evento dos veces sin fallo previo. El
 *    índice único (provider, externalEventId) de WebhookEvent es lo que
 *    impide aplicar dos veces el mismo cambio.
 *
 * 2. ORDEN. Los webhooks NO llegan ordenados. Es perfectamente posible
 *    recibir `subscription.deleted` y después un `payment_succeeded` más
 *    antiguo que estaba reintentándose. Sin protección, ese evento viejo
 *    reactivaría una cuenta cancelada. Por eso se compara `occurredAt`
 *    contra `lastEventAt` y se descarta lo que llegue tarde.
 *
 * 3. ATOMICIDAD. El evento se marca PROCESADO en la MISMA transacción que
 *    cambia la suscripción. Si el proceso muere en medio, el evento queda
 *    RECIBIDO y el reintento lo vuelve a tomar.
 */

export type WebhookOutcome =
  | { status: 'PROCESADO'; tenantId: string; applied: string }
  | { status: 'DUPLICADO'; eventId: string }
  | { status: 'IGNORADO'; reason: string }

const P2002_UNIQUE = 'P2002'

/**
 * Resuelve a qué suscripción se refiere el evento.
 *
 * Se prueba, en orden: el id de suscripción del proveedor (lo más fiable),
 * el tenantId de la metadata del checkout, y por último el id de cliente.
 * El id de cliente va al final porque un mismo cliente de Stripe podría
 * llegar a tener más de una suscripción.
 */
async function resolverSuscripcion(evento: NormalizedEvent) {
  const select = {
    id: true,
    tenantId: true,
    status: true,
    lastEventAt: true,
    pastDueSince: true,
    externalSubscriptionId: true,
    externalCustomerId: true,
    /*
     * El plan y su moneda entran al select para poder REGISTRARLOS en la
     * auditoría. El registro ya existía pero solo guardaba el estado, así
     * que al revisar un cobro no se podía saber de qué plan a cuál se movió
     * ni por cuánto — y eso es justo lo que se consulta cuando un cliente
     * reclama.
     */
    plan: { select: { code: true, name: true, currency: true, priceMonthly: true } },
  } as const

  if (evento.externalSubscriptionId) {
    const s = await prisma.subscription.findUnique({
      where: { externalSubscriptionId: evento.externalSubscriptionId },
      select,
    })
    if (s) return s
  }

  if (evento.tenantId) {
    const s = await prisma.subscription.findUnique({
      where: { tenantId: evento.tenantId },
      select,
    })
    if (s) return s
  }

  if (evento.externalCustomerId) {
    const s = await prisma.subscription.findFirst({
      where: { externalCustomerId: evento.externalCustomerId },
      select,
    })
    if (s) return s
  }

  return null
}

export async function processBillingEvent(params: {
  provider: PaymentProvider
  evento: NormalizedEvent
  payload: unknown
  now?: Date
}): Promise<WebhookOutcome> {
  const { provider, evento, payload, now = new Date() } = params

  // --- 1. Registrar el evento (o detectar que ya lo vimos) ----------------
  let eventRowId: string
  try {
    const row = await prisma.webhookEvent.create({
      data: {
        provider,
        externalEventId: evento.externalEventId,
        type: evento.rawType,
        payload: payload as Prisma.InputJsonValue,
        status: 'RECIBIDO',
        attempts: 1,
      },
      select: { id: true },
    })
    eventRowId = row.id
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== P2002_UNIQUE) {
      throw e
    }

    const previo = await prisma.webhookEvent.findUniqueOrThrow({
      where: {
        provider_externalEventId: { provider, externalEventId: evento.externalEventId },
      },
      select: { id: true, status: true },
    })

    // Un evento ya resuelto no se vuelve a aplicar. Pero uno que quedó
    // RECIBIDO o FALLIDO SÍ se reprocesa: significa que el intento anterior
    // murió a medias, y descartarlo por "duplicado" dejaría la suscripción
    // desincronizada para siempre.
    if (previo.status === 'PROCESADO' || previo.status === 'IGNORADO') {
      return { status: 'DUPLICADO', eventId: previo.id }
    }

    await prisma.webhookEvent.update({
      where: { id: previo.id },
      data: { attempts: { increment: 1 }, status: 'RECIBIDO', error: null },
    })
    eventRowId = previo.id
  }

  try {
    // --- 2. Resolver el tenant ------------------------------------------
    const suscripcion = await resolverSuscripcion(evento)

    if (!suscripcion) {
      // No es nuestra, o el checkout aún no creó la suscripción local. Se
      // marca IGNORADO y se responde 200: reintentar no la haría aparecer.
      await prisma.webhookEvent.update({
        where: { id: eventRowId },
        data: { status: 'IGNORADO', processedAt: now, error: 'Suscripción no encontrada' },
      })
      return { status: 'IGNORADO', reason: 'Suscripción no encontrada' }
    }

    const suscripcionTieneIds = {
      subscription: suscripcion.externalSubscriptionId !== null,
      customer: suscripcion.externalCustomerId !== null,
    }

    // --- 3. Descartar eventos que llegan tarde ---------------------------
    const esViejo =
      suscripcion.lastEventAt !== null && evento.occurredAt < suscripcion.lastEventAt

    if (esViejo && evento.action !== 'NOOP') {
      // Se descarta la TRANSICIÓN DE ESTADO, pero no los identificadores de
      // Stripe: esos son hechos inmutables, no estado. Si el evento que los
      // traía llega desordenado y lo tiramos entero, la suscripción se queda
      // sin `externalSubscriptionId` y los pagos futuros ya no se pueden
      // vincular a este tenant.
      const backfill: Prisma.SubscriptionUpdateInput = {}
      if (evento.externalSubscriptionId && !suscripcionTieneIds.subscription) {
        backfill.externalSubscriptionId = evento.externalSubscriptionId
      }
      if (evento.externalCustomerId && !suscripcionTieneIds.customer) {
        backfill.externalCustomerId = evento.externalCustomerId
      }

      await prisma.$transaction([
        ...(Object.keys(backfill).length > 0
          ? [prisma.subscription.update({ where: { id: suscripcion.id }, data: backfill })]
          : []),
        prisma.webhookEvent.update({
          where: { id: eventRowId },
          data: {
            status: 'IGNORADO',
            processedAt: now,
            tenantId: suscripcion.tenantId,
            error: 'Evento anterior al último aplicado (fuera de orden)',
          },
        }),
      ])

      return { status: 'IGNORADO', reason: 'Evento fuera de orden' }
    }

    // --- 4. Aplicar el cambio, atómicamente con el marcado del evento ----
    const data: Prisma.SubscriptionUpdateInput = {
      lastEventId: evento.externalEventId,
      lastEventAt: evento.occurredAt,
    }

    if (evento.externalSubscriptionId) {
      data.externalSubscriptionId = evento.externalSubscriptionId
    }
    if (evento.externalCustomerId) {
      data.externalCustomerId = evento.externalCustomerId
    }
    if (evento.currentPeriodStart) data.currentPeriodStart = evento.currentPeriodStart
    if (evento.currentPeriodEnd) data.currentPeriodEnd = evento.currentPeriodEnd
    if (evento.cancelAtPeriodEnd !== undefined) {
      data.cancelAtPeriodEnd = evento.cancelAtPeriodEnd
    }

    switch (evento.action) {
      case 'ACTIVATE':
        data.status = 'ACTIVE'
        // Se limpia el inicio de mora: si no, un cliente que se puso al día
        // seguiría contando días de gracia desde el impago viejo y volvería
        // a solo-lectura sin deber nada.
        data.pastDueSince = null
        data.lastPaymentAt = evento.occurredAt
        if (evento.amount) data.lastPaymentAmount = evento.amount
        break

      case 'MARK_PAST_DUE':
        data.status = 'PAST_DUE'
        // Solo se fija si no había mora previa: el período de gracia cuenta
        // desde el PRIMER impago, no desde el último reintento fallido.
        if (!suscripcion.pastDueSince) data.pastDueSince = evento.occurredAt
        break

      case 'CANCEL':
        data.status = 'CANCELED'
        data.canceledAt = evento.occurredAt
        break

      case 'SYNC':
        if (evento.status) {
          data.status = evento.status
          if (evento.status === 'ACTIVE' || evento.status === 'TRIALING') {
            data.pastDueSince = null
          }
          if (evento.status === 'PAST_DUE' && !suscripcion.pastDueSince) {
            data.pastDueSince = evento.occurredAt
          }
          if (evento.status === 'CANCELED') data.canceledAt = evento.occurredAt
        }
        break

      case 'NOOP':
        break
    }

    await prisma.$transaction([
      prisma.subscription.update({ where: { id: suscripcion.id }, data }),
      prisma.webhookEvent.update({
        where: { id: eventRowId },
        data: { status: 'PROCESADO', processedAt: now, tenantId: suscripcion.tenantId },
      }),
      prisma.auditLog.create({
        data: {
          tenantId: suscripcion.tenantId,
          // Sin actor: lo ejecutó el proveedor de pagos, no una persona.
          action: `billing.${evento.action.toLowerCase()}`,
          entityType: 'Subscription',
          entityId: suscripcion.id,
          reason: evento.rawType,
          /*
           * Antes solo guardaba el estado. Con eso, revisar un cobro no decía
           * de qué plan a cuál se movió, por cuánto ni con qué proveedor —
           * exactamente los tres datos que se buscan cuando un cliente
           * reclama un cargo. El plan no cambia en un webhook de cobro, así
           * que va igual en `before` y `after`: lo que importa es saber CUÁL
           * estaba vigente.
           */
          before: {
            status: suscripcion.status,
            plan: suscripcion.plan?.code ?? null,
          },
          after: {
            status: (data.status as string) ?? suscripcion.status,
            plan: suscripcion.plan?.code ?? null,
            proveedor: provider,
            monto: evento.amount ?? suscripcion.plan?.priceMonthly?.toString() ?? null,
            moneda: suscripcion.plan?.currency ?? null,
            referencia: evento.externalSubscriptionId ?? null,
          },
        },
      }),
    ])

    return {
      status: 'PROCESADO',
      tenantId: suscripcion.tenantId,
      applied: evento.action,
    }
  } catch (e) {
    // Se deja FALLIDO para que el reintento del proveedor lo retome (el
    // chequeo de duplicados de arriba permite reprocesar un FALLIDO).
    await prisma.webhookEvent.update({
      where: { id: eventRowId },
      data: {
        status: 'FALLIDO',
        error: e instanceof Error ? e.message.slice(0, 500) : 'Error desconocido',
      },
    })
    throw e
  }
}
