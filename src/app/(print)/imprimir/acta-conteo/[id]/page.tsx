import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { isBusinessError } from '@/lib/errors'
import { getActaConteo } from '@/features/inventory/conteo-documentos'
import { ActaConteoDoc } from '@/features/inventory/components/ActaConteoDoc'
import { BarraImpresion } from '@/features/printing/components/BarraImpresion'
import { enlaceConteo } from '@/features/inventory/conteo-ui'

export const dynamic = 'force-dynamic'

type Params = Promise<{ id: string }>
type Search = Promise<Record<string, string | string[] | undefined>>

/** El título es el nombre que el navegador le pone al PDF: «CF001-00000007.pdf» se puede archivar y buscar. */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params
  try {
    const ctx = await requireTenantContext()
    return { title: `Acta ${(await getActaConteo(getTenantPrisma(ctx), ctx, id.slice(0, 64))).numero}` }
  } catch {
    return { title: 'Acta de toma de inventario' }
  }
}

/**
 * Acta de la toma de inventario en A4 (para imprimir o guardar como PDF). Ruta propia, comparte el contenedor de impresión. La ve quien revisa las diferencias; un conteo que no
 * existe, es de otro negocio o sucursal, o no está cerrado, es un 404. `?detalle=todo` lista todas las líneas; sin él, solo las diferencias y las observadas.
 */
export default async function ActaConteoPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const ctx = await requireTenantContext()
  const { id } = await params
  const { auto, detalle } = await searchParams
  let acta
  try {
    acta = await getActaConteo(getTenantPrisma(ctx), ctx, id.slice(0, 64), { detalleCompleto: detalle === 'todo' })
  } catch (e) {
    if (isBusinessError(e) && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN_ROLE' || e.code === 'INVALID_DOCUMENT')) notFound()
    throw e
  }
  return (
    <>
      <ActaConteoDoc acta={acta} />
      <BarraImpresion auto={auto === '1'} volverA={enlaceConteo(id.slice(0, 64))} />
      <p className="ticket-nota no-imprimir">Formato A4. En el diálogo de impresión elige «Guardar como PDF» si quieres archivarla.</p>
    </>
  )
}
