import { NextResponse, type NextRequest } from 'next/server'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError } from '@/lib/errors'
import { respuestaCsv } from '@/lib/respuesta-csv'
import { exportarConteoCsv } from '@/features/inventory/conteo-documentos'

/**
 * GET /api/inventario/conteos/:id — el detalle completo de una toma de inventario en CSV (Excel es-PE). Solo lectura (más la línea de auditoría de la descarga). La ve quien revisa las
 * diferencias; los valores solo con `productos.ver_costo`: lo decide el servicio, no esta ruta. Con el PIN de operador no se llega (revisar es `stock.ajustar`/`conteo.gestionar`).
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  const { id } = await params
  try {
    return respuestaCsv(await exportarConteoCsv(getTenantPrisma(ctx), ctx, id.slice(0, 64)))
  } catch (e) {
    if (isBusinessError(e)) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FORBIDDEN_ROLE' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400 })
    console.error('[api/inventario/conteos] GET falló', { tenantId: ctx.tenantId, error: e instanceof Error ? e.message : e })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
