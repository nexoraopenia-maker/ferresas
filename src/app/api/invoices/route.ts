import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { checkSameOrigin } from '@/lib/csrf'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { isBusinessError } from '@/lib/errors'
import { issueTaxDocumentSchema } from '@/features/invoicing/schemas'
import { issueTaxDocument } from '@/features/invoicing/service'

/**
 * GET  /api/invoices           — comprobantes del negocio, con filtros.
 * POST /api/invoices           — emite un comprobante para una venta.
 *
 * Route Handler y no Server Action porque un comprobante es un documento que
 * otros sistemas van a querer consumir: el contador que exporta el registro
 * de ventas, o el proceso de firma cuando exista. Un endpoint HTTP les sirve;
 * una Server Action, no.
 *
 * La contrapartida es la protección CSRF manual, que aquí pesa más que en
 * otras rutas: emitir un comprobante consume un correlativo que NO se puede
 * reciclar. Un POST forzado desde otra página dejaría un hueco en la serie.
 */
export const dynamic = 'force-dynamic'

const filtroSchema = z.object({
  status: z.enum(['PENDIENTE', 'ENVIADO', 'ACEPTADO', 'RECHAZADO', 'ANULADO']).optional(),
  documentType: z.enum(['BOLETA', 'FACTURA']).optional(),
  series: z.string().trim().max(10).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export async function GET(req: NextRequest) {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const q = Object.fromEntries(req.nextUrl.searchParams)
  const parsed = filtroSchema.safeParse(q)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', fields: z.flattenError(parsed.error).fieldErrors },
      { status: 400 },
    )
  }

  try {
    const db = getTenantPrisma(ctx)
    const docs = await db.taxDocument.findMany({
      where: {
        status: parsed.data.status,
        documentType: parsed.data.documentType,
        series: parsed.data.series,
      },
      orderBy: [{ series: 'asc' }, { correlativo: 'desc' }],
      take: parsed.data.limit,
      select: {
        id: true, fullNumber: true, documentType: true, series: true,
        correlativo: true, status: true, statusMessage: true,
        receiverDocType: true, receiverDocNumber: true, receiverName: true,
        currency: true, subtotal: true, taxTotal: true, total: true,
        issuedAt: true, sentAt: true, acceptedAt: true,
        sale: { select: { number: true } },
      },
    })

    return NextResponse.json(
      {
        invoices: docs.map((d) => ({
          ...d,
          subtotal: d.subtotal.toFixed(2),
          taxTotal: d.taxTotal.toFixed(2),
          total: d.total.toFixed(2),
          saleNumber: d.sale.number,
          sale: undefined,
        })),
      },
      { status: 200 },
    )
  } catch (e) {
    if (isBusinessError(e)) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 400 })
    }
    console.error('[api/invoices] GET falló', {
      tenantId: ctx.tenantId,
      error: e instanceof Error ? e.message : e,
    })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const origen = checkSameOrigin(req.headers)
  if (!origen.ok) {
    console.warn('[api/invoices] POST rechazado por origen', { reason: origen.reason })
    return NextResponse.json({ error: 'forbidden origin' }, { status: 403 })
  }

  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const limite = await checkRateLimit(`invoice:${clientIp(req.headers)}`, {
    limit: 120,
    windowSeconds: 600,
  })
  if (!limite.ok) {
    return NextResponse.json(
      { error: 'rate limited', retryAfterSeconds: limite.retryAfterSeconds },
      { status: 429, headers: { 'Retry-After': String(limite.retryAfterSeconds) } },
    )
  }

  let cuerpo: unknown
  try {
    cuerpo = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const parsed = issueTaxDocumentSchema.safeParse(cuerpo)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'validation',
        message: 'Revisa los datos del comprobante.',
        fields: z.flattenError(parsed.error).fieldErrors,
      },
      { status: 400 },
    )
  }

  try {
    const db = getTenantPrisma(ctx)
    const doc = await issueTaxDocument(db, ctx, parsed.data)
    // 200 y no 201 cuando ya existía: no se creó nada nuevo.
    return NextResponse.json(doc, { status: doc.alreadyIssued ? 200 : 201 })
  } catch (e) {
    if (isBusinessError(e)) {
      const status =
        e.code === 'DUPLICATE_CODE' ? 409
        : e.code === 'FORBIDDEN_ROLE' ? 403
        : 400
      return NextResponse.json({ error: e.code, message: e.message }, { status })
    }
    console.error('[api/invoices] POST falló', {
      tenantId: ctx.tenantId,
      error: e instanceof Error ? { name: e.name, message: e.message } : e,
    })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
