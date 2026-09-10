import type { SubscriptionStatus } from '@/generated/prisma/enums'

/**
 * Normalización de eventos: payload crudo del proveedor → forma común.
 *
 * Función pura y sin BD, para poder probar el mapeo de estados con payloads
 * reales sin levantar nada. El mapeo de estados es justo donde un error
 * silencioso significa cobrar de más o dar servicio gratis.
 */

export type BillingAction =
  | 'ACTIVATE'
  | 'MARK_PAST_DUE'
  | 'CANCEL'
  | 'SYNC'
  /** Reconocido pero sin efecto sobre el estado (p. ej. invoice.created). */
  | 'NOOP'

export interface NormalizedEvent {
  externalEventId: string
  rawType: string
  action: BillingAction
  occurredAt: Date
  status?: SubscriptionStatus
  externalSubscriptionId?: string
  externalCustomerId?: string
  /** Enviado en la metadata del checkout; permite resolver el tenant directo. */
  tenantId?: string
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
  cancelAtPeriodEnd?: boolean
  amount?: string
}

function fecha(seg: unknown): Date | undefined {
  if (typeof seg !== 'number' || !Number.isFinite(seg)) return undefined
  return new Date(seg * 1000)
}

function texto(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Estados de Stripe → los cuatro nuestros.
 *
 * `incomplete`, `incomplete_expired` y `unpaid` se tratan como PAST_DUE y no
 * como CANCELED: son situaciones recuperables pagando, y marcar CANCELED
 * dejaría al cliente en solo-lectura de forma prematura por un cobro que
 * puede reintentarse.
 */
export function mapStripeStatus(status: unknown): SubscriptionStatus | undefined {
  switch (status) {
    case 'trialing':
      return 'TRIALING'
    case 'active':
      return 'ACTIVE'
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return 'PAST_DUE'
    case 'canceled':
    case 'incomplete_expired':
      return 'CANCELED'
    default:
      return undefined
  }
}

export function normalizeStripeEvent(payload: unknown): NormalizedEvent | null {
  if (!payload || typeof payload !== 'object') return null
  const e = payload as Record<string, any>

  const externalEventId = texto(e.id)
  const rawType = texto(e.type)
  if (!externalEventId || !rawType) return null

  const obj = (e.data?.object ?? {}) as Record<string, any>
  const occurredAt = fecha(e.created) ?? new Date()

  const base: NormalizedEvent = {
    externalEventId,
    rawType,
    action: 'NOOP',
    occurredAt,
    tenantId: texto(obj.metadata?.tenantId),
    externalCustomerId: texto(obj.customer),
  }

  switch (rawType) {
    case 'invoice.payment_succeeded':
    case 'invoice.paid':
      return {
        ...base,
        action: 'ACTIVATE',
        status: 'ACTIVE',
        externalSubscriptionId: texto(obj.subscription) ?? texto(obj.parent?.subscription_details?.subscription),
        // Stripe manda céntimos enteros; se convierte a la unidad monetaria.
        amount:
          typeof obj.amount_paid === 'number' ? (obj.amount_paid / 100).toFixed(2) : undefined,
        currentPeriodEnd: fecha(obj.lines?.data?.[0]?.period?.end),
      }

    case 'invoice.payment_failed':
      return {
        ...base,
        action: 'MARK_PAST_DUE',
        status: 'PAST_DUE',
        externalSubscriptionId: texto(obj.subscription) ?? texto(obj.parent?.subscription_details?.subscription),
      }

    case 'checkout.session.completed':
      // Cierra el círculo del checkout: es aquí donde aprendemos qué customer
      // y qué subscription de Stripe corresponden a este tenant. No fija
      // estado — de eso se encarga el customer.subscription.* que acompaña.
      return {
        ...base,
        action: 'SYNC',
        tenantId: texto(obj.metadata?.tenantId) ?? texto(obj.client_reference_id),
        externalSubscriptionId: texto(obj.subscription),
        externalCustomerId: texto(obj.customer),
      }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return {
        ...base,
        action: 'SYNC',
        status: mapStripeStatus(obj.status),
        externalSubscriptionId: texto(obj.id),
        currentPeriodStart: fecha(obj.current_period_start),
        currentPeriodEnd: fecha(obj.current_period_end),
        cancelAtPeriodEnd: obj.cancel_at_period_end === true,
      }

    case 'customer.subscription.deleted':
      return {
        ...base,
        action: 'CANCEL',
        status: 'CANCELED',
        externalSubscriptionId: texto(obj.id),
      }

    default:
      // Reconocido pero irrelevante: se registra y se responde 200 para que
      // Stripe no reintente un evento que nunca vamos a usar.
      return base
  }
}

/**
 * Estados de preapproval de MercadoPago → los cuatro nuestros.
 * `pending` no fija estado: la suscripción existe pero el pago aún no se
 * autorizó, y marcarla ACTIVE ahí sería regalar servicio.
 */
export function mapMercadoPagoStatus(status: unknown): SubscriptionStatus | undefined {
  switch (status) {
    case 'authorized':
      return 'ACTIVE'
    case 'paused':
      return 'PAST_DUE'
    case 'cancelled':
      return 'CANCELED'
    default:
      return undefined
  }
}

/** Datos releídos desde la API de MercadoPago; ver la nota de seguridad abajo. */
export interface MpResource {
  kind: 'preapproval' | 'payment'
  id: string
  status: string
  externalReference?: string
  preapprovalId?: string
  amount?: string
}

/**
 * Normaliza un aviso de MercadoPago.
 *
 * ⚠️ El estado y el tenant NO se leen del payload recibido, sino de
 * `resource`: lo que la API de MercadoPago devuelve al releer el recurso.
 *
 * El motivo es que la firma de MercadoPago cubre el manifiesto
 * (id + request-id + ts) y NO el cuerpo. Quien capture una notificación
 * legítima puede reescribir el JSON —por ejemplo, poner status "authorized"—
 * y la firma seguirá validando. Confiar en el cuerpo sería regalar cuentas
 * activas a cualquiera que sepa esto.
 */
export function normalizeMercadoPagoEvent(
  payload: unknown,
  fallbackId?: string,
  resource?: MpResource,
): NormalizedEvent | null {
  if (!payload || typeof payload !== 'object') return null
  const e = payload as Record<string, any>

  const externalEventId = texto(e.id?.toString()) ?? fallbackId
  const rawType = texto(e.type) ?? texto(e.topic)
  if (!externalEventId || !rawType) return null

  const data = (e.data ?? {}) as Record<string, any>
  const fechaAviso = e.date_created ? new Date(e.date_created) : new Date()

  const base: NormalizedEvent = {
    externalEventId,
    rawType: `${rawType}.${texto(e.action) ?? 'unknown'}`,
    action: 'NOOP',
    occurredAt: Number.isNaN(fechaAviso.getTime()) ? new Date() : fechaAviso,
    externalSubscriptionId: texto(data.id?.toString()),
  }

  // Sin lectura autenticada del recurso no se toca ningún estado.
  if (!resource) return base

  if (resource.kind === 'preapproval') {
    const status = mapMercadoPagoStatus(resource.status)
    return {
      ...base,
      action: status === 'CANCELED' ? 'CANCEL' : 'SYNC',
      status,
      externalSubscriptionId: resource.id,
      tenantId: resource.externalReference,
    }
  }

  // Pagos: aprobado activa, rechazado abre la mora.
  if (resource.status === 'approved') {
    return {
      ...base,
      action: 'ACTIVATE',
      status: 'ACTIVE',
      externalSubscriptionId: resource.preapprovalId,
      tenantId: resource.externalReference,
      amount: resource.amount,
    }
  }

  if (resource.status === 'rejected' || resource.status === 'cancelled') {
    return {
      ...base,
      action: 'MARK_PAST_DUE',
      status: 'PAST_DUE',
      externalSubscriptionId: resource.preapprovalId,
      tenantId: resource.externalReference,
    }
  }

  return { ...base, tenantId: resource.externalReference }
}
