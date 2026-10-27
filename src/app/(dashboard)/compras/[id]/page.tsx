import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { hoyEnZona } from '@/features/credito/reglas'
import { DetalleCompra } from '@/features/compras/components/DetalleCompra'
import { obtenerCompra } from '@/features/compras/service'
import { puedeVerProveedores } from '@/features/proveedores/permisos'

export const dynamic = 'force-dynamic'

/** Detalle de una compra. Una que no existe, es de otro negocio o no se puede ver es un 404. */
export default async function DetalleCompraPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantContext()
  if (!puedeVerProveedores(ctx)) notFound()
  const { id } = await params
  const db = getTenantPrisma(ctx)

  const compra = await obtenerCompra(db, ctx, id.slice(0, 64)).catch((e) => {
    if (isBusinessError(e) && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN_ROLE')) return null
    throw e
  })
  if (!compra) notFound()
  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <DetalleCompra
        compra={compra} zona={tenant.timezone} hoy={hoyEnZona(tenant.timezone)} verCostos={puede(ctx, 'productos.ver_costo') || puede(ctx, 'compras.registrar')}
        permisos={{ puedeRegistrar: puede(ctx, 'compras.registrar'), puedeAjustar: puede(ctx, 'stock.ajustar'), puedeOperar: ctx.access === 'FULL' || ctx.access === 'WARN', puedePagar: puede(ctx, 'proveedores.pagar') }}
      />
    </main>
  )
}
