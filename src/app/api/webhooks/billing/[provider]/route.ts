import { NextResponse, type NextRequest } from 'next/server'
import {
  verifyMercadoPagoSignature,
  verifyStripeSignature,
} from '@/features/billing/webhook-verify'
import {
  normalizeMercadoPagoEvent,
  normalizeStripeEvent,
  type MpResource,
} from '@/features/billing/webhook-events'
import { createMercadoPagoClient } from '@/features/billing/mercadopago-client'
import { processBillingEvent } from '@/features/billing/webhook-service'

/**
 * POST /api/webhooks/billing/stripe
 * POST /api/webhooks/billing/mercadopago
 *
 * El proveedor va en la ruta y no deducido de las cabeceras: qué firma hay
 * que verificar es una decisión demasiado importante para inferirla de un
 * header que el propio atacante controla.
 *
 * ─── CÓDIGOS DE RESPUESTA ────────────────────────────────────────────────
 * Importan más de lo que parece, porque gobiernan los reintentos:
 *
 *   400  firma inválida / cuerpo ilegible → NO reintentar, algo va mal
 *   200  procesado, duplicado o ignorado  → el proveedor deja de insistir
 *   500  fallo transitorio nuestro        → que reintente, se reprocesa
 *
 * Devolver 200 ante un fallo real perdería el evento para siempre. Devolver
 * 500 ante un evento que nunca vamos a usar haría que Stripe reintentara
 * durante días y acabara desactivando el endpoint.
 */

/** El cuerpo CRUDO es obligatorio: la firma se calcula sobre esos bytes. */
export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params
  const rawBody = await req.text()

  if (provider === 'stripe') {
    const verificacion = verifyStripeSignature({
      rawBody,
      signatureHeader: req.headers.get('stripe-signature'),
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    })

    if (!verificacion.ok) {
      // El motivo va al log del servidor, nunca al cuerpo de la respuesta:
      // decirle a quien prueba firmas si falló el timestamp o el HMAC le
      // ahorra trabajo.
      console.warn('[webhook] firma de Stripe rechazada', { reason: verificacion.reason })
      return NextResponse.json({ error: 'invalid signature' }, { status: 400 })
    }

    let payload: unknown
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'invalid body' }, { status: 400 })
    }

    const evento = normalizeStripeEvent(payload)
    if (!evento) {
      return NextResponse.json({ error: 'unrecognized event' }, { status: 400 })
    }

    return responder(() =>
      processBillingEvent({ provider: 'STRIPE', evento, payload }),
    )
  }

  if (provider === 'mercadopago') {
    let payload: Record<string, any>
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'invalid body' }, { status: 400 })
    }

    // MercadoPago manda data.id tanto en el cuerpo como en la query.
    const dataId =
      req.nextUrl.searchParams.get('data.id') ??
      (payload?.data?.id != null ? String(payload.data.id) : null)

    const verificacion = verifyMercadoPagoSignature({
      signatureHeader: req.headers.get('x-signature'),
      requestId: req.headers.get('x-request-id'),
      dataId,
      secret: process.env.MERCADOPAGO_WEBHOOK_SECRET,
    })

    if (!verificacion.ok) {
      console.warn('[webhook] firma de MercadoPago rechazada', { reason: verificacion.reason })
      return NextResponse.json({ error: 'invalid signature' }, { status: 400 })
    }

    /**
     * Relectura autenticada del recurso. NO es opcional: MercadoPago firma el
     * manifiesto (id + request-id + ts), no el cuerpo. Un aviso legítimo
     * capturado y reescrito con status "authorized" pasaría la verificación
     * de firma sin problema. El estado real solo puede venir de su API.
     */
    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN
    let resource: MpResource | undefined

    if (accessToken && dataId) {
      try {
        const mp = createMercadoPagoClient({ accessToken })
        const topic = payload?.type ?? payload?.topic

        if (topic === 'payment') {
          const p = await mp.getPayment(dataId)
          resource = {
            kind: 'payment',
            id: p.id,
            status: p.status,
            externalReference: p.externalReference,
            preapprovalId: p.preapprovalId,
            amount: p.amount,
          }
        } else {
          const pa = await mp.getPreapproval(dataId)
          resource = {
            kind: 'preapproval',
            id: pa.id,
            status: pa.status,
            externalReference: pa.externalReference,
          }
        }
      } catch (e) {
        // Si su API no responde, se devuelve 500 para que reintente. Aplicar
        // el aviso sin poder verificarlo sería justo el agujero que este
        // bloque existe para tapar.
        console.error('[webhook] no se pudo releer el recurso de MercadoPago', {
          dataId,
          error: e instanceof Error ? e.message : e,
        })
        return NextResponse.json({ error: 'resource fetch failed' }, { status: 500 })
      }
    }

    const evento = normalizeMercadoPagoEvent(
      payload,
      req.headers.get('x-request-id') ?? undefined,
      resource,
    )
    if (!evento) {
      return NextResponse.json({ error: 'unrecognized event' }, { status: 400 })
    }

    return responder(() =>
      processBillingEvent({ provider: 'MERCADOPAGO', evento, payload }),
    )
  }

  return NextResponse.json({ error: 'unknown provider' }, { status: 404 })
}

async function responder(fn: () => Promise<{ status: string }>) {
  try {
    const outcome = await fn()
    return NextResponse.json({ received: true, outcome: outcome.status }, { status: 200 })
  } catch (e) {
    console.error('[webhook] fallo procesando evento', {
      error: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
    })
    // 500 a propósito: que el proveedor reintente.
    return NextResponse.json({ error: 'processing failed' }, { status: 500 })
  }
}
