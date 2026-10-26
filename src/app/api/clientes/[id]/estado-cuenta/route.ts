import { NextResponse, type NextRequest } from 'next/server'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError } from '@/lib/errors'
import { respuestaCsv } from '@/lib/respuesta-csv'
import { exportarEstadoDeCuentaCsv } from '@/features/clientes/cobranza'

/**
 * GET /api/clientes/:id/estado-cuenta?desde=AAAA-MM-DD&hasta=AAAA-MM-DD — estado de cuenta de un cliente en CSV.
 * El servicio valida las fechas, el permiso y que el cliente sea del negocio.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  const { id } = await params
  const q = req.nextUrl.searchParams
  try {
    const archivo = await exportarEstadoDeCuentaCsv(getTenantPrisma(ctx), ctx, {
      customerId: id.slice(0, 64), desde: q.get('desde') ?? undefined, hasta: q.get('hasta') ?? undefined,
    })
    return respuestaCsv(archivo)
  } catch (e) {
    if (isBusinessError(e)) {
      const status = e.code === 'FORBIDDEN_ROLE' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400
      return NextResponse.json({ error: e.code, message: e.message }, { status })
    }
    console.error('[api/clientes/estado-cuenta] GET falló', { tenantId: ctx.tenantId, error: e instanceof Error ? e.message : e })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
