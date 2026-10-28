import { NextResponse, type NextRequest } from 'next/server'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError } from '@/lib/errors'
import { respuestaCsv } from '@/lib/respuesta-csv'
import { parametrosRegistrosSchema } from '@/features/registros/schemas'
import { exportarConciliacionCsv } from '@/features/conciliacion/conciliacion-service'

/**
 * GET /api/reportes/conciliacion?p=&desde=&hasta= — la conciliación fiscal en CSV (Excel es-PE).
 * Solo lectura (salvo la línea de auditoría de la descarga); el permiso (`reportes.ver`) lo decide el servicio.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  const q = req.nextUrl.searchParams
  const leido = parametrosRegistrosSchema.safeParse({ p: q.get('p') || undefined, desde: q.get('desde') || undefined, hasta: q.get('hasta') || undefined })
  if (!leido.success) return NextResponse.json({ error: 'INVALID_DOCUMENT', message: leido.error.issues[0]?.message ?? 'Revisa los parámetros.' }, { status: 400 })
  try {
    return respuestaCsv(await exportarConciliacionCsv(getTenantPrisma(ctx), ctx, leido.data))
  } catch (e) {
    if (isBusinessError(e)) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FORBIDDEN_ROLE' ? 403 : 400 })
    console.error('[api/reportes/conciliacion] GET falló', { tenantId: ctx.tenantId, error: e instanceof Error ? e.message : e })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
