import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { FichaProveedorVista } from '@/features/proveedores/components/FichaProveedorVista'
import { obtenerFichaProveedor, puedeVerProveedores } from '@/features/proveedores/service'
import { listarCompras } from '@/features/compras/service'
import { listarComprasSchema } from '@/features/compras/schemas'

export const dynamic = 'force-dynamic'

/** Ficha de un proveedor: datos, deuda, cuentas y últimas compras. Uno que no existe, es de otro negocio o no se puede ver es un 404. */
export default async function FichaProveedorPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantContext()
  if (!puedeVerProveedores(ctx)) notFound()
  const { id } = await params
  const db = getTenantPrisma(ctx)

  const ficha = await obtenerFichaProveedor(db, ctx, id.slice(0, 64)).catch((e) => {
    if (isBusinessError(e) && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN_ROLE')) return null
    throw e
  })
  if (!ficha) notFound()
  const compras = await listarCompras(db, ctx, listarComprasSchema.parse({ supplierId: ficha.id, limite: 10 }))

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <FichaProveedorVista
        ficha={ficha} compras={compras.filas}
        permisos={{
          puedeGestionar: puede(ctx, 'proveedores.gestionar'), puedeComprar: puede(ctx, 'compras.registrar'),
          puedeOperar: ctx.access === 'FULL' || ctx.access === 'WARN',
        }}
      />
    </main>
  )
}
