import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { listarListas } from '@/features/precios/service'
import { ListasPrecio } from '@/features/precios/components/ListasPrecio'

export const dynamic = 'force-dynamic'

/** Listas de precio del negocio (F6.7c). Solo `precios.gestionar` (fuera del PIN): 404 sin él, y el servicio lo vuelve a exigir. */
export default async function PreciosPage() {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'precios.gestionar')) notFound()
  const listas = await listarListas(getTenantPrisma(ctx), ctx)

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Listas de precio</h1>
          <p className="text-sm text-ink-muted">Precios distintos según quién compra (Mayorista, Constructor…) y según cuánto compra (tramos de volumen). Lo que una lista no define se vende al precio Base.</p>
        </div>
        <Link href="/inventario" className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">← Inventario</Link>
      </header>
      <ListasPrecio listas={listas} />
    </main>
  )
}
