/**
 * Cliente mínimo de la API de Stripe.
 *
 * ─── POR QUÉ NO EL SDK OFICIAL ───────────────────────────────────────────
 *
 * El SDK aporta tipos y reintentos, pero hace incómodo lo que más falta hace
 * aquí: poder EJECUTAR el código de pago en los tests sin claves reales ni
 * red. Con un transporte inyectable, la construcción de la petición y el
 * manejo de cada respuesta de error se prueban de verdad, que es donde están
 * los fallos caros (un precio tomado del cliente, una idempotency-key
 * ausente).
 *
 * El trade-off es explícito: renunciamos a los tipos del SDK y a su reintento
 * automático. Si el módulo de pagos crece —portal de cliente, prorrateos,
 * facturas— conviene reevaluarlo.
 */

export interface StripeTransport {
  (url: string, init: RequestInit): Promise<{
    status: number
    json: () => Promise<unknown>
  }>
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly stripeCode: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'StripeError'
  }
}

/**
 * Stripe habla `application/x-www-form-urlencoded` con notación de corchetes
 * para lo anidado: `line_items[0][price]=price_x`. Serializarlo mal no da un
 * error claro — Stripe simplemente ignora el campo, y una sesión de pago sin
 * `metadata[tenantId]` se cobra sin que el webhook sepa a quién asignarla.
 */
export function toFormEncoded(
  obj: Record<string, unknown>,
  prefijo = '',
): string {
  const partes: string[] = []

  for (const [clave, valor] of Object.entries(obj)) {
    if (valor === undefined || valor === null) continue
    const nombre = prefijo ? `${prefijo}[${clave}]` : clave

    if (Array.isArray(valor)) {
      valor.forEach((item, i) => {
        if (item !== null && typeof item === 'object') {
          partes.push(toFormEncoded(item as Record<string, unknown>, `${nombre}[${i}]`))
        } else {
          partes.push(`${encodeURIComponent(`${nombre}[${i}]`)}=${encodeURIComponent(String(item))}`)
        }
      })
    } else if (typeof valor === 'object') {
      partes.push(toFormEncoded(valor as Record<string, unknown>, nombre))
    } else {
      partes.push(`${encodeURIComponent(nombre)}=${encodeURIComponent(String(valor))}`)
    }
  }

  return partes.filter(Boolean).join('&')
}

export interface CheckoutSessionResult {
  id: string
  url: string
}

export interface StripeClientOptions {
  secretKey: string
  transport?: StripeTransport
  baseUrl?: string
}

export function createStripeClient(opts: StripeClientOptions) {
  const transport: StripeTransport =
    opts.transport ??
    ((url, init) =>
      fetch(url, init).then((r) => ({ status: r.status, json: () => r.json() })))

  const baseUrl = opts.baseUrl ?? 'https://api.stripe.com/v1'

  async function post(
    path: string,
    params: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<Record<string, any>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    }

    // Sin esto, un doble clic con la red lenta crea DOS suscripciones y el
    // ferretero acaba pagando dos veces. Stripe deduplica por esta cabecera
    // durante 24 h.
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

    const res = await transport(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: toFormEncoded(params),
    })

    const cuerpo = (await res.json()) as Record<string, any>

    if (res.status >= 400) {
      const err = cuerpo?.error ?? {}
      throw new StripeError(
        res.status,
        typeof err.code === 'string' ? err.code : undefined,
        typeof err.message === 'string' ? err.message : 'Error de Stripe',
      )
    }

    return cuerpo
  }

  return {
    async createCheckoutSession(params: {
      priceId: string
      successUrl: string
      cancelUrl: string
      tenantId: string
      /** Cliente ya existente en Stripe; evita duplicarlo en cada pago. */
      customerId?: string
      customerEmail?: string
      trialEnd?: Date
      idempotencyKey: string
    }): Promise<CheckoutSessionResult> {
      const body: Record<string, unknown> = {
        mode: 'subscription',
        line_items: [{ price: params.priceId, quantity: 1 }],
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        // Permite resolver el tenant desde el evento checkout.session.completed.
        client_reference_id: params.tenantId,
        metadata: { tenantId: params.tenantId },
        // Y también desde customer.subscription.*, que puede llegar ANTES.
        subscription_data: { metadata: { tenantId: params.tenantId } },
      }

      if (params.customerId) {
        body.customer = params.customerId
      } else if (params.customerEmail) {
        body.customer_email = params.customerEmail
        // Sin esto, cada pago crea un cliente nuevo en Stripe y el historial
        // del ferretero queda desperdigado.
        body.customer_creation = 'always'
      }

      if (params.trialEnd && params.trialEnd > new Date()) {
        // Se respeta el trial que ya tenía: pagar antes de tiempo no debe
        // costarle los días que le quedaban.
        ;(body.subscription_data as Record<string, unknown>).trial_end =
          Math.floor(params.trialEnd.getTime() / 1000)
      }

      const session = await post('/checkout/sessions', body, params.idempotencyKey)

      if (typeof session.id !== 'string' || typeof session.url !== 'string') {
        throw new StripeError(502, undefined, 'Stripe devolvió una sesión sin URL.')
      }

      return { id: session.id, url: session.url }
    },

    /** Portal de cliente: cambiar tarjeta, ver facturas, cancelar. */
    async createBillingPortalSession(params: {
      customerId: string
      returnUrl: string
    }): Promise<{ url: string }> {
      const session = await post('/billing_portal/sessions', {
        customer: params.customerId,
        return_url: params.returnUrl,
      })

      if (typeof session.url !== 'string') {
        throw new StripeError(502, undefined, 'Stripe devolvió un portal sin URL.')
      }
      return { url: session.url }
    },
  }
}

export type StripeClient = ReturnType<typeof createStripeClient>
