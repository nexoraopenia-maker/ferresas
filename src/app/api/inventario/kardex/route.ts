import { NextResponse, type NextRequest } from 'next/server'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError } from '@/lib/errors'
import { respuestaCsv } from '@/lib/respuesta-csv'
import { kardexCsvSchema } from '@/features/inventory/kardex-schemas'
import { exportarKardexCsv } from '@/features/inventory/kardex-service'

/**
 * GET /api/inventario/kardex?productId=&warehouseId=&variantId=&desde=&hasta= — el kardex del rango completo en CSV (Excel es-PE).
 * Solo lectura (salvo la línea de auditoría de la descarga). El permiso (`kardex.ver`, y los costos solo con `productos.ver_costo`) lo decide el
 * servicio; con el PIN de operador no se llega (`kardex.ver` está fuera del PIN). Un rango de más de 50.000 movimientos se rechaza, no se corta.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  const q = req.nextUrl.searchParams
  const leido = kardexCsvSchema.safeParse({
    productId: q.get('productId') || undefined, warehouseId: q.get('warehouseId') || undefined, variantId: q.get('variantId') || undefined,
    desde: q.get('desde') || undefined, hasta: q.get('hasta') || undefined,
  })
  if (!leido.success) return NextResponse.json({ error: 'INVALID_DOCUMENT', message: leido.error.issues[0]?.message ?? 'Revisa los parámetros.' }, { status: 400 })
  try {
    return respuestaCsv(await exportarKardexCsv(getTenantPrisma(ctx), ctx, leido.data))
  } catch (e) {
    if (isBusinessError(e)) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FORBIDDEN_ROLE' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400 })
    console.error('[api/inventario/kardex] GET falló', { tenantId: ctx.tenantId, error: e instanceof Error ? e.message : e })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
