/**
 * Cliente mínimo de MercadoPago. Mismo patrón que el de Stripe: transporte
 * inyectable para poder ejecutar el código de pago en los tests sin tocar la
 * red ni necesitar credenciales.
 */

export interface MpTransport {
  (url: string, init: RequestInit): Promise<{
    status: number
    json: () => Promise<unknown>
  }>
}

export class MercadoPagoError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'MercadoPagoError'
  }
}

export interface MpPreapproval {
  id: string
  status: string
  externalReference?: string
  payerEmail?: string
}

export interface MpPayment {
  id: string
  status: string
  externalReference?: string
  preapprovalId?: string
  amount?: string
}

export function createMercadoPagoClient(opts: {
  accessToken: string
  transport?: MpTransport
  baseUrl?: string
}) {
  const transport: MpTransport =
    opts.transport ??
    ((url, init) => fetch(url, init).then((r) => ({ status: r.status, json: () => r.json() })))

  const baseUrl = opts.baseUrl ?? 'https://api.mercadopago.com'

  async function request(
    path: string,
    init: { method: string; body?: unknown; idempotencyKey?: string },
  ): Promise<Record<string, any>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.accessToken}`,
      'Content-Type': 'application/json',
    }
    if (init.idempotencyKey) headers['X-Idempotency-Key'] = init.idempotencyKey

    const res = await transport(`${baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })

    const cuerpo = (await res.json()) as Record<string, any>

    if (res.status >= 400) {
      throw new MercadoPagoError(
        res.status,
        typeof cuerpo?.message === 'string' ? cuerpo.message : 'Error de MercadoPago',
      )
    }
    return cuerpo
  }

  return {
    /**
     * Crea una suscripción (preapproval). `external_reference` lleva el
     * tenantId: es lo ÚNICO que permitirá al webhook saber de quién es el
     * cobro, porque MercadoPago no manda metadata en el aviso.
     */
    async createPreapproval(params: {
      reason: string
      payerEmail: string
      amount: string
      currency: string
      backUrl: string
      tenantId: string
      /** Plan preconfigurado en MercadoPago; si existe, manda sobre el importe. */
      preapprovalPlanId?: string
      idempotencyKey: string
    }): Promise<{ id: string; initPoint: string }> {
      const body: Record<string, unknown> = {
        reason: params.reason,
        payer_email: params.payerEmail,
        back_url: params.backUrl,
        external_reference: params.tenantId,
        status: 'pending',
      }

      if (params.preapprovalPlanId) {
        body.preapproval_plan_id = params.preapprovalPlanId
      } else {
        body.auto_recurring = {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: Number(params.amount),
          currency_id: params.currency,
        }
      }

      const r = await request('/preapproval', {
        method: 'POST',
        body,
        idempotencyKey: params.idempotencyKey,
      })

      const initPoint = r.init_point ?? r.sandbox_init_point
      if (typeof r.id !== 'string' || typeof initPoint !== 'string') {
        throw new MercadoPagoError(502, 'MercadoPago devolvió una suscripción sin enlace de pago.')
      }
      return { id: r.id, initPoint }
    },

    /**
     * Relee la suscripción desde la API.
     *
     * Es OBLIGATORIO y no una optimización: la firma de MercadoPago cubre el
     * manifiesto (id + request-id + ts), NO el cuerpo del aviso. Un atacante
     * que capture una notificación legítima podría alterar el JSON y la firma
     * seguiría validando. Por eso el estado se toma siempre de esta lectura
     * autenticada, nunca del payload recibido.
     */
    async getPreapproval(id: string): Promise<MpPreapproval> {
      const r = await request(`/preapproval/${encodeURIComponent(id)}`, { method: 'GET' })
      return {
        id: String(r.id ?? id),
        status: String(r.status ?? ''),
        externalReference: typeof r.external_reference === 'string' ? r.external_reference : undefined,
        payerEmail: typeof r.payer_email === 'string' ? r.payer_email : undefined,
      }
    },

    async getPayment(id: string): Promise<MpPayment> {
      const r = await request(`/v1/payments/${encodeURIComponent(id)}`, { method: 'GET' })
      return {
        id: String(r.id ?? id),
        status: String(r.status ?? ''),
        externalReference: typeof r.external_reference === 'string' ? r.external_reference : undefined,
        preapprovalId: typeof r.metadata?.preapproval_id === 'string' ? r.metadata.preapproval_id : undefined,
        amount: typeof r.transaction_amount === 'number' ? r.transaction_amount.toFixed(2) : undefined,
      }
    },
  }
}

export type MercadoPagoClient = ReturnType<typeof createMercadoPagoClient>
