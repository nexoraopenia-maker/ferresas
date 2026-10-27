import { NextResponse } from 'next/server'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError } from '@/lib/errors'
import { respuestaCsv } from '@/lib/respuesta-csv'
import { exportarPorPagarCsv } from '@/features/por-pagar/informes'

/**
 * GET /api/proveedores/por-pagar — antigüedad de la deuda con proveedores en CSV (Excel es-PE).
 *
 * Solo lectura; lo único que escribe es la línea de auditoría de la descarga. El permiso lo decide el servicio, no esta ruta.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  try {
    const archivo = await exportarPorPagarCsv(getTenantPrisma(ctx), ctx)
    return respuestaCsv(archivo)
  } catch (e) {
    if (isBusinessError(e)) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FORBIDDEN_ROLE' ? 403 : 400 })
    console.error('[api/proveedores/por-pagar] GET falló', { tenantId: ctx.tenantId, error: e instanceof Error ? e.message : e })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
