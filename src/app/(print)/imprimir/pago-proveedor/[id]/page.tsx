import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { isBusinessError } from '@/lib/errors'
import { getVoucherPago } from '@/features/printing/voucher-pago'
import { TicketPagoProveedor } from '@/features/printing/components/TicketPagoProveedor'
import { BarraImpresion } from '@/features/printing/components/BarraImpresion'

export const dynamic = 'force-dynamic'

type Params = Promise<{ id: string }>
type Search = Promise<Record<string, string | string[] | undefined>>

/** El título es el nombre que el navegador le pone al PDF: «PP-20261026-3F9A1C.pdf» se puede archivar y buscar. */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params
  try {
    const ctx = await requireTenantContext()
    return { title: (await getVoucherPago(getTenantPrisma(ctx), ctx, id.slice(0, 64))).numero }
  } catch {
    return { title: 'Voucher de pago' }
  }
}

/**
 * Voucher de pago a proveedor en 80 mm. Ruta propia (no un tipo más de `/imprimir/[tipo]/[id]`) porque no es un documento de venta. Un pago
 * que no existe, es de otro negocio o que el usuario no puede ver es un 404 (no se confirma que exista en otra cuenta). Comparte layout y
 * hoja de estilos con el ticket de venta.
 */
export default async function VoucherPagoPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const ctx = await requireTenantContext()
  const { id } = await params
  let voucher
  try {
    voucher = await getVoucherPago(getTenantPrisma(ctx), ctx, id.slice(0, 64))
  } catch (e) {
    if (isBusinessError(e) && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN_ROLE')) notFound()
    throw e
  }
  const { auto } = await searchParams

  return (
    <>
      <TicketPagoProveedor voucher={voucher} />
      <BarraImpresion auto={auto === '1'} volverA="/por-pagar" />
      <p className="ticket-nota no-imprimir">
        Formato de 80 mm. En el diálogo de impresión elige tu ticketera y deja los márgenes en «ninguno»; si la impresora no aparece,
        cualquier impresora común sirve para una copia en A4.
      </p>
    </>
  )
}
