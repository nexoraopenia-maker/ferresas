import { NextResponse, type NextRequest } from 'next/server'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError } from '@/lib/errors'
import { respuestaCsv } from '@/lib/respuesta-csv'
import { parametrosCostosSchema, TIPOS_REPORTE_COSTOS, type TipoReporteCostos } from '@/features/reportes/schemas'
import { exportarCostosCsv } from '@/features/reportes/rentabilidad-service'

/**
 * GET /api/reportes/rentabilidad/:tipo?p=&desde=&hasta=&base=&a=&b= — margen, inventario valorizado o ABC en CSV (Excel es-PE).
 * `tipo` ∈ margen | inventario | abc. Solo lectura (salvo la línea de auditoría de la descarga); el permiso (`productos.ver_costo`) lo decide el servicio.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ tipo: string }> }) {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  const { tipo } = await params
  if (!(TIPOS_REPORTE_COSTOS as readonly string[]).includes(tipo)) return NextResponse.json({ error: 'NOT_FOUND', message: 'Ese reporte no existe.' }, { status: 404 })

  const q = req.nextUrl.searchParams
  const leido = parametrosCostosSchema.safeParse({ p: q.get('p') || undefined, desde: q.get('desde') || undefined, hasta: q.get('hasta') || undefined, base: q.get('base') || undefined, a: q.get('a') || undefined, b: q.get('b') || undefined })
  if (!leido.success) return NextResponse.json({ error: 'INVALID_DOCUMENT', message: leido.error.issues[0]?.message ?? 'Revisa los parámetros.' }, { status: 400 })
  try {
    const archivo = await exportarCostosCsv(getTenantPrisma(ctx), ctx, tipo as TipoReporteCostos, leido.data)
    return respuestaCsv(archivo)
  } catch (e) {
    if (isBusinessError(e)) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FORBIDDEN_ROLE' ? 403 : 400 })
    console.error('[api/reportes/rentabilidad] GET falló', { tenantId: ctx.tenantId, tipo, error: e instanceof Error ? e.message : e })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
