import { NextResponse, type NextRequest } from 'next/server'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError } from '@/lib/errors'
import { respuestaCsv } from '@/lib/respuesta-csv'
import { parametrosRegistrosSchema, TIPOS_REGISTRO, type TipoRegistro } from '@/features/registros/schemas'
import { exportarRegistroCsv } from '@/features/registros/registro-service'

/**
 * GET /api/reportes/registros/:tipo?p=&desde=&hasta= — el registro de ventas o de compras en CSV (Excel es-PE).
 * `tipo` ∈ ventas | compras. Solo lectura (salvo la línea de auditoría de la descarga); el permiso (`reportes.ver`) lo decide el servicio.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ tipo: string }> }) {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  const { tipo } = await params
  if (!(TIPOS_REGISTRO as readonly string[]).includes(tipo)) return NextResponse.json({ error: 'NOT_FOUND', message: 'Ese registro no existe.' }, { status: 404 })

  const q = req.nextUrl.searchParams
  const leido = parametrosRegistrosSchema.safeParse({ p: q.get('p') || undefined, desde: q.get('desde') || undefined, hasta: q.get('hasta') || undefined })
  if (!leido.success) return NextResponse.json({ error: 'INVALID_DOCUMENT', message: leido.error.issues[0]?.message ?? 'Revisa los parámetros.' }, { status: 400 })
  try {
    const archivo = await exportarRegistroCsv(getTenantPrisma(ctx), ctx, tipo as TipoRegistro, leido.data)
    return respuestaCsv(archivo)
  } catch (e) {
    if (isBusinessError(e)) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FORBIDDEN_ROLE' ? 403 : 400 })
    console.error('[api/reportes/registros] GET falló', { tenantId: ctx.tenantId, tipo, error: e instanceof Error ? e.message : e })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
