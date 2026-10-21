import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { listarCostosPendientes } from '@/features/inventory/costos-service'
import { CostosPendientes } from '@/features/inventory/components/CostosPendientes'

export const dynamic = 'force-dynamic'

/** Entradas de mercadería a las que les falta el costo. Solo quien puede ver costos. */
export default async function CostosPage() {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'productos.ver_costo')) notFound()
  const filas = await listarCostosPendientes(getTenantPrisma(ctx), ctx)

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-extrabold text-ink">Costos por completar</h1>
        <p className="text-sm text-ink-muted">
          Entradas que registró alguien sin acceso a los costos. Mientras falte el costo, esa entrada no entra en ningún costo promedio.
        </p>
      </header>
      <CostosPendientes
        puedeOperar={ctx.access === 'FULL' || ctx.access === 'WARN'}
        filas={filas.map((f) => ({ ...f, fecha: f.fecha.toISOString() }))}
      />
    </main>
  )
}
