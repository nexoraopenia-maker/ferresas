import { NextResponse, type NextRequest } from 'next/server'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError } from '@/lib/errors'
import { respuestaCsv } from '@/lib/respuesta-csv'
import { exportarCierreCsv } from '@/features/printing/cierre-caja'

/**
 * GET /api/caja/cierre/[id] — el cierre de un turno CERRADO en CSV (Excel es-PE). Mismas reglas de visibilidad que el ticket (`caja.arqueo`, o haber abierto/cerrado ese turno);
 * lo que no se puede ver es el mismo 404. Nunca lleva costos ni márgenes.
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  const { id } = await params
  try {
    return respuestaCsv(await exportarCierreCsv(getTenantPrisma(ctx), ctx, id.slice(0, 64)))
  } catch (e) {
    if (isBusinessError(e)) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FORBIDDEN_ROLE' || e.code === 'NOT_FOUND' ? 404 : 400 })
    console.error('[api/caja/cierre] GET falló', { tenantId: ctx.tenantId, error: e instanceof Error ? e.message : e })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
