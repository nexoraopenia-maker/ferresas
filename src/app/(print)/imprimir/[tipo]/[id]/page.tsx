import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { isBusinessError } from '@/lib/errors'
import { getDocumentoImprimible, esTipoImpresion } from '@/features/printing/queries'
import { TicketTermico } from '@/features/printing/components/TicketTermico'
import { BarraImpresion } from '@/features/printing/components/BarraImpresion'

export const dynamic = 'force-dynamic'

type Params = Promise<{ tipo: string; id: string }>
type Search = Promise<Record<string, string | string[] | undefined>>

const ETIQUETA = {
  venta: 'Ticket',
  comprobante: 'Comprobante',
  cotizacion: 'Cotización',
} as const

/** A dónde vuelve «Cerrar» cuando el navegador no deja cerrar la pestaña. */
const VOLVER_A = {
  venta: '/pos',
  comprobante: '/comprobantes',
  cotizacion: '/cotizaciones',
} as const

/**
 * El título es el nombre que el navegador le pone al PDF si el cajero elige
 * "Guardar como PDF" en lugar de imprimir. "B001-00000123.pdf" es archivable;
 * "localhost - FerreSaaS.pdf" no.
 */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { tipo, id } = await params
  if (!esTipoImpresion(tipo)) return { title: 'Impresión' }
  try {
    const ctx = await requireTenantContext()
    const doc = await getDocumentoImprimible(getTenantPrisma(ctx), tipo, id)
    return { title: doc.numero }
  } catch {
    return { title: ETIQUETA[tipo] }
  }
}

/**
 * Vista de impresión en papel térmico de 80 mm.
 *
 * Una sola ruta para los tres documentos: el formato del ticket es el mismo
 * y la plantilla ya está normalizada en `getDocumentoImprimible`. Tener tres
 * rutas casi idénticas garantizaría que una se quedara atrás al cambiar el
 * formato.
 *
 * El aislamiento no se comprueba aquí: el cliente de Prisma ya viene
 * limitado al tenant de la sesión, así que un id de otro negocio cae en el
 * `notFound()` de abajo. Un 404 y no un 403, para no confirmar que el
 * documento existe en otra cuenta.
 */
export default async function ImprimirPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: Search
}) {
  const { tipo, id } = await params
  if (!esTipoImpresion(tipo)) notFound()

  const ctx = await requireTenantContext()

  let doc
  try {
    doc = await getDocumentoImprimible(getTenantPrisma(ctx), tipo, id)
  } catch (e) {
    if (isBusinessError(e) && e.code === 'NOT_FOUND') notFound()
    throw e
  }

  const { auto } = await searchParams

  return (
    <>
      <TicketTermico doc={doc} />

      <BarraImpresion auto={auto === '1'} volverA={VOLVER_A[tipo]} />

      <p className="ticket-nota no-imprimir">
        Formato de 80 mm. En el diálogo de impresión elige tu ticketera y deja
        los márgenes en «ninguno»; si la impresora no aparece, cualquier
        impresora común sirve para una copia en A4.
      </p>
    </>
  )
}
