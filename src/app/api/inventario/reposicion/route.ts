import { NextResponse, type NextRequest } from 'next/server'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError } from '@/lib/errors'
import { respuestaCsv } from '@/lib/respuesta-csv'
import { exportarReposicionCsv } from '@/features/inventory/reposicion-reporte'

/**
 * GET /api/inventario/reposicion?almacen=… — la reposición sugerida en CSV (Excel es-PE). Solo lectura (más la línea de auditoría de la descarga). La ve quien tiene `reposicion.ver`; las
 * columnas de dinero solo existen con `productos.ver_costo`: lo decide el servicio, no esta ruta.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  const almacen = req.nextUrl.searchParams.get('almacen')?.slice(0, 64) || undefined
  try {
    return respuestaCsv(await exportarReposicionCsv(getTenantPrisma(ctx), ctx, { warehouseId: almacen }))
  } catch (e) {
    if (isBusinessError(e)) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FORBIDDEN_ROLE' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400 })
    console.error('[api/inventario/reposicion] GET falló', { tenantId: ctx.tenantId, error: e instanceof Error ? e.message : e })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
