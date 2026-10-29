import { NextResponse, type NextRequest } from 'next/server'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError } from '@/lib/errors'
import { respuestaCsv } from '@/lib/respuesta-csv'
import { exportarConsolidadoCsv } from '@/features/branches/consolidado-caja'

/**
 * GET /api/caja/consolidado?fecha=AAAA-MM-DD — el consolidado del día por sucursal en CSV (Excel es-PE). Exige `caja.consolidado` (lo comprueba el servicio; sin él, 403).
 * Sin `fecha` es el día de hoy del negocio. Nunca lleva costos.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  try {
    return respuestaCsv(await exportarConsolidadoCsv(getTenantPrisma(ctx), ctx, req.nextUrl.searchParams.get('fecha')))
  } catch (e) {
    if (isBusinessError(e)) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FORBIDDEN_ROLE' ? 403 : 400 })
    console.error('[api/caja/consolidado] GET falló', { tenantId: ctx.tenantId, error: e instanceof Error ? e.message : e })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
