import { NextResponse, type NextRequest } from 'next/server'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError } from '@/lib/errors'
import { leerArchivoBaja, leerArchivoFiscal, type TipoArchivoFiscal } from '@/features/sunat/archivos'

/**
 * GET /api/comprobantes/[id]/archivo?tipo=xml|cdr|baja-xml|baja-cdr — descarga el XML firmado o el CDR (constancia de SUNAT) guardados de un comprobante, o los de su comunicación de baja.
 * Exige sesión y permiso (`comprobantes.emitir` o `reportes.ver`; lo decide el servicio). Lo que no existe, no es del negocio o no se puede ver es el mismo 404.
 * Se entrega como adjunto, sin guardar en caché y sin que el navegador lo reinterprete.
 */
export const dynamic = 'force-dynamic'

const TIPOS: Record<string, { kind: TipoArchivoFiscal; baja: boolean }> = {
  xml: { kind: 'XML_FIRMADO', baja: false }, cdr: { kind: 'CDR', baja: false }, 'baja-xml': { kind: 'XML_FIRMADO', baja: true }, 'baja-cdr': { kind: 'CDR', baja: true },
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantContext().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  const tipo = TIPOS[req.nextUrl.searchParams.get('tipo') ?? '']
  if (!tipo) return NextResponse.json({ error: 'INVALID_DOCUMENT', message: 'Pide tipo=xml, cdr, baja-xml o baja-cdr.' }, { status: 400 })
  const { id } = await params
  try {
    const lector = tipo.baja ? leerArchivoBaja : leerArchivoFiscal
    const a = await lector(getTenantPrisma(ctx), ctx, id.slice(0, 64), tipo.kind)
    return new NextResponse(a.contenido, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${a.nombre.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ETag: `"${a.sha256}"`,
      },
    })
  } catch (e) {
    if (isBusinessError(e)) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FORBIDDEN_ROLE' || e.code === 'NOT_FOUND' ? 404 : 400 })
    console.error('[api/comprobantes/archivo] GET falló', { tenantId: ctx.tenantId, error: e instanceof Error ? e.message : e })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
