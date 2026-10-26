import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { FichaClienteVista } from '@/features/clientes/components/FichaClienteVista'
import { obtenerFichaCliente, puedeVerClientes } from '@/features/clientes/service'

export const dynamic = 'force-dynamic'

/** Ficha de un cliente: datos, crédito, cuentas y abonos. Un cliente que no existe, es de otro negocio o no se puede ver es un 404. */
export default async function FichaClientePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantContext()
  if (!puedeVerClientes(ctx)) notFound()
  const { id } = await params

  const ficha = await obtenerFichaCliente(getTenantPrisma(ctx), ctx, id.slice(0, 64)).catch((e) => {
    if (isBusinessError(e) && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN_ROLE')) return null
    throw e
  })
  if (!ficha) notFound()

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <FichaClienteVista
        ficha={ficha}
        permisos={{
          puedeGestionar: puede(ctx, 'clientes.gestionar'), puedeAbonar: puede(ctx, 'credito.cobrar'),
          puedeLimite: puede(ctx, 'credito.limite'), puedeCastigar: puede(ctx, 'credito.castigar'),
          puedeOperar: ctx.access === 'FULL' || ctx.access === 'WARN',
        }}
      />
    </main>
  )
}
