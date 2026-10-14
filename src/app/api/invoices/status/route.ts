import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { checkSameOrigin } from '@/lib/csrf'
import { isBusinessError } from '@/lib/errors'
import { updateTaxStatusSchema } from '@/features/invoicing/schemas'
import { updateTaxStatus } from '@/features/invoicing/service'

/**
 * PATCH /api/invoices/status — refleja la respuesta de la administración
 * tributaria sobre un comprobante.
 *
 * Hoy la invoca una persona desde el panel. Está pensada para que, cuando
 * exista el proceso de firma y envío al OSE, sea ese proceso quien la llame
 * con el resultado — por eso vive en una ruta HTTP y no en una Server Action.
 */
export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest) {
  const origen = checkSameOrigin(req.headers)
  if (!origen.ok) {
    return NextResponse.json({ error: 'forbidden origin' }, { status: 403 })
  }

  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  let cuerpo: unknown
  try {
    cuerpo = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const parsed = updateTaxStatusSchema.safeParse(cuerpo)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', fields: z.flattenError(parsed.error).fieldErrors },
      { status: 400 },
    )
  }

  try {
    const db = getTenantPrisma(ctx)
    const r = await updateTaxStatus(db, ctx, parsed.data)
    return NextResponse.json(r, { status: 200 })
  } catch (e) {
    if (isBusinessError(e)) {
      const status =
        e.code === 'DUPLICATE_CODE' ? 409
        : e.code === 'FORBIDDEN_ROLE' ? 403
        : 400
      return NextResponse.json({ error: e.code, message: e.message }, { status })
    }
    console.error('[api/invoices/status] falló', {
      tenantId: ctx.tenantId,
      error: e instanceof Error ? e.message : e,
    })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
