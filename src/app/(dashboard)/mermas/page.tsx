import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { listarMermas } from '@/features/inventory/merma-service'
import { MermasManager } from '@/features/inventory/components/MermasManager'

export const dynamic = 'force-dynamic'

/**
 * Mermas. Quien trabaja el almacén las SOLICITA (el stock no se mueve); quien
 * puede ajustar inventario las APRUEBA o RECHAZA, y nunca las suyas.
 */
export default async function MermasPage() {
  const ctx = await requireTenantContext()
  const aprueba = puede(ctx, 'stock.ajustar')
  const solicita = puede(ctx, 'stock.merma_solicitar')
  if (!aprueba && !solicita) notFound()

  const filas = ctx.branchId ? await listarMermas(getTenantPrisma(ctx), ctx) : []
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-extrabold text-ink">Mermas</h1>
        <p className="text-sm text-ink-muted">
          Pérdidas, roturas y faltantes. Al solicitarla no se mueve el stock: se descuenta cuando otra persona la aprueba.
        </p>
      </header>
      {!ctx.branchId ? (
        <p className="rounded-xl border border-stock-low/40 bg-stock-low-soft px-4 py-3 text-sm font-semibold text-stock-low">No tienes sucursal asignada.</p>
      ) : (
        <MermasManager
          puedeSolicitar={solicita}
          puedeResolver={aprueba}
          puedeOperar={ctx.access === 'FULL' || ctx.access === 'WARN'}
          filas={filas.map((f) => ({ ...f, solicitadaEn: f.solicitadaEn.toISOString(), resueltaEn: f.resueltaEn?.toISOString() ?? null }))}
        />
      )}
    </main>
  )
}
