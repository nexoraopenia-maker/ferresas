import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { isBusinessError } from '@/lib/errors'
import { estadoDeCuenta } from '@/features/clientes/cobranza'
import { puedeVerClientes } from '@/features/clientes/service'
import { EstadoCuentaImprimible } from '@/features/clientes/components/EstadoCuentaImprimible'

export const dynamic = 'force-dynamic'

type Search = Promise<{ desde?: string; hasta?: string }>

export const metadata: Metadata = { title: 'Estado de cuenta' }

/**
 * Estado de cuenta imprimible (A4) de un cliente, con filtro de fechas. Quien no puede ver clientes, o pide uno inexistente o de otro
 * negocio, recibe un 404 (no se confirma que exista en otra cuenta). Las fechas mal escritas se explican en pantalla.
 */
export default async function EstadoCuentaPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const ctx = await requireTenantContext()
  if (!puedeVerClientes(ctx)) notFound()
  const { id } = await params
  const sp = await searchParams
  const db = getTenantPrisma(ctx)

  let estado
  try {
    estado = await estadoDeCuenta(db, ctx, { customerId: id.slice(0, 64), desde: sp.desde || undefined, hasta: sp.hasta || undefined })
  } catch (e) {
    if (isBusinessError(e) && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN_ROLE')) notFound()
    if (isBusinessError(e) && e.code === 'INVALID_DOCUMENT') {
      return <p role="alert" data-a4="error" className="a4-hoja">{e.message} <a href={`/estado-de-cuenta/${id.slice(0, 64)}`}>Ver todo el historial</a></p>
    }
    throw e
  }
  const t = await db.tenant.findFirstOrThrow({ select: { name: true, legalName: true, taxId: true, address: true } })

  return <EstadoCuentaImprimible estado={estado} emisor={{ nombre: t.name, razonSocial: t.legalName, ruc: t.taxId, direccion: t.address }} />
}
