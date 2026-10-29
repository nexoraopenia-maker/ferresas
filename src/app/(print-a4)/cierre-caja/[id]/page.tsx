import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { isBusinessError } from '@/lib/errors'
import { getTicketCierre } from '@/features/printing/cierre-caja'
import { CierreCajaA4 } from '@/features/printing/components/CierreCajaA4'

export const dynamic = 'force-dynamic'

type Params = Promise<{ id: string }>

/** El título es el nombre que el navegador le pone al PDF: «CC-20261026-3F9A1C.pdf» se puede archivar y buscar. */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params
  try {
    const ctx = await requireTenantContext()
    return { title: (await getTicketCierre(getTenantPrisma(ctx), ctx, id.slice(0, 64))).numero }
  } catch {
    return { title: 'Cierre de caja' }
  }
}

/**
 * Cierre de turno en A4 (imprimir o guardar como PDF). Mismas reglas de visibilidad que el ticket de 80 mm (`caja.arqueo`, o haber abierto/cerrado ese turno): un turno que no
 * existe, está abierto, es de otra sucursal u otro negocio, o que la persona no puede ver, es un 404.
 */
export default async function CierreCajaA4Page({ params }: { params: Params }) {
  const ctx = await requireTenantContext()
  const { id } = await params
  let ticket
  try {
    ticket = await getTicketCierre(getTenantPrisma(ctx), ctx, id.slice(0, 64))
  } catch (e) {
    if (isBusinessError(e) && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN_ROLE')) notFound()
    throw e
  }
  return <CierreCajaA4 ticket={ticket} />
}
