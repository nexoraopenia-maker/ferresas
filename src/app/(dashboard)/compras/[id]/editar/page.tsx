import { notFound, redirect } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { hoyEnZona } from '@/features/credito/reglas'
import { FormularioCompra } from '@/features/compras/components/FormularioCompra'
import { borradorParaEditar, opcionesDeCompra } from '@/features/compras/service'

export const dynamic = 'force-dynamic'

/** Editar un BORRADOR. Solo `compras.registrar`; una compra ya recibida o anulada vuelve a su detalle (ya no se edita). */
export default async function EditarCompraPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'compras.registrar')) notFound()
  const { id } = await params
  const db = getTenantPrisma(ctx)

  const borrador = await borradorParaEditar(db, ctx, id.slice(0, 64)).catch((e) => {
    if (isBusinessError(e) && e.code === 'NOT_FOUND') return null
    if (isBusinessError(e) && e.code === 'INVALID_DOCUMENT') return 'no-editable' as const
    throw e
  })
  if (!borrador) notFound()
  if (borrador === 'no-editable') redirect(`/compras/${id.slice(0, 64)}`)
  const [opciones, tenant] = await Promise.all([opcionesDeCompra(db, ctx), db.tenant.findFirstOrThrow({ select: { timezone: true } })])

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Editar compra {borrador.number}</h1>
        <p className="text-sm text-ink-muted">Sigue siendo un borrador: nada cambia en el stock hasta recibirla.</p>
      </header>
      <FormularioCompra modo="editar" opciones={opciones} hoy={hoyEnZona(tenant.timezone)} inicial={borrador} puedeOperar={ctx.access === 'FULL' || ctx.access === 'WARN'} />
    </main>
  )
}
