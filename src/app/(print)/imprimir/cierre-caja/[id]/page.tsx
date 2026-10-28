import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { isBusinessError } from '@/lib/errors'
import { getTicketCierre } from '@/features/printing/cierre-caja'
import { TicketCierreCaja } from '@/features/printing/components/TicketCierreCaja'
import { BarraImpresion } from '@/features/printing/components/BarraImpresion'

export const dynamic = 'force-dynamic'

type Params = Promise<{ id: string }>
type Search = Promise<Record<string, string | string[] | undefined>>

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
 * Ticket de cierre de turno en 80 mm. Ruta propia (no un tipo más de `/imprimir/[tipo]/[id]`) porque no es un documento de venta. Un turno
 * que no existe, está abierto, es de otro negocio o sucursal o que el usuario no puede ver es un 404 (no se confirma que exista en otra cuenta). Comparte layout y
 * hoja de estilos con el ticket de venta.
 */
export default async function CierreCajaPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const ctx = await requireTenantContext()
  const { id } = await params
  let voucher
  try {
    voucher = await getTicketCierre(getTenantPrisma(ctx), ctx, id.slice(0, 64))
  } catch (e) {
    if (isBusinessError(e) && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN_ROLE')) notFound()
    throw e
  }
  const { auto } = await searchParams

  return (
    <>
      <TicketCierreCaja ticket={voucher} />
      <BarraImpresion auto={auto === '1'} volverA="/caja" />
      <p className="ticket-nota no-imprimir">
        Formato de 80 mm. En el diálogo de impresión elige tu ticketera y deja los márgenes en «ninguno»; si la impresora no aparece,
        cualquier impresora común sirve para una copia en A4.
      </p>
    </>
  )
}
