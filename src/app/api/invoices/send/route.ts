import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { checkSameOrigin } from '@/lib/csrf'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { isBusinessError } from '@/lib/errors'
import { enviarComprobante, refrescarEstado } from '@/features/invoicing/envio'

export const dynamic = 'force-dynamic'

const cuerpoSchema = z.object({ taxDocumentId: z.string().min(1).max(64) })

/**
 * Envía un comprobante pendiente al proveedor de facturación, o consulta la
 * respuesta de uno ya enviado. El permiso lo exige el servicio.
 */
export async function POST(req: NextRequest) {
  const origen = checkSameOrigin(req.headers)
  if (!origen.ok) return NextResponse.json({ error: 'forbidden origin' }, { status: 403 })

  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const limite = await checkRateLimit(`invoice-send:${clientIp(req.headers)}`, { limit: 60, windowSeconds: 600 })
  if (!limite.ok) {
    return NextResponse.json(
      { error: 'rate limited', retryAfterSeconds: limite.retryAfterSeconds },
      { status: 429, headers: { 'Retry-After': String(limite.retryAfterSeconds) } },
    )
  }

  const parsed = cuerpoSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'validation' }, { status: 400 })

  try {
    const db = getTenantPrisma(ctx)
    const doc = await db.taxDocument.findFirst({ where: { id: parsed.data.taxDocumentId }, select: { status: true } })
    const r = doc?.status === 'ENVIADO'
      ? await refrescarEstado(db, ctx, parsed.data.taxDocumentId)
      : await enviarComprobante(db, ctx, parsed.data.taxDocumentId)
    return NextResponse.json(r, { status: 200 })
  } catch (e) {
    if (isBusinessError(e)) {
      const status = e.code === 'FORBIDDEN_ROLE' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400
      return NextResponse.json({ error: e.code, message: e.message }, { status })
    }
    console.error('[api/invoices/send] falló', {
      tenantId: ctx.tenantId, error: e instanceof Error ? { name: e.name, message: e.message } : e,
    })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
