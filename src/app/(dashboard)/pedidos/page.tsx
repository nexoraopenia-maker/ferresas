import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { listarPedidos } from '@/features/pos/pedido-service'
import { ColaPedidos } from '@/features/pos/components/ColaPedidos'

export const dynamic = 'force-dynamic'

/**
 * Pedidos a caja. Listado propio, aparte de las cotizaciones.
 * Quien cobra ve la cola de su sucursal; quien solo vende, los que armó él.
 */
export default async function PedidosPage() {
  const ctx = await requireTenantContext()
  const puedeCobrar = puede(ctx, 'ventas.cobrar')
  if (!puedeCobrar && !puede(ctx, 'ventas.crear')) notFound()

  const db = getTenantPrisma(ctx)
  const pedidos = ctx.branchId ? await listarPedidos(db, ctx) : []

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-extrabold text-ink">Pedidos a caja</h1>
        <p className="text-sm text-ink-muted">
          {puedeCobrar
            ? 'Los pedidos que armaron los vendedores de esta sucursal. Tómalo para cobrarlo: nadie más podrá cobrarlo mientras lo tengas.'
            : 'Los pedidos que armaste y siguen sin cobrar. Vencen al cerrar la caja o al acabar el día.'}
        </p>
      </header>
      {!ctx.branchId ? (
        <p className="rounded-xl border border-stock-low/40 bg-stock-low-soft px-4 py-3 text-sm font-semibold text-stock-low">
          No tienes sucursal asignada.
        </p>
      ) : (
        <ColaPedidos
          puedeCobrar={puedeCobrar}
          puedeOperar={ctx.access === 'FULL' || ctx.access === 'WARN'}
          puedeSoltarAjenos={puede(ctx, 'caja.cerrar_ajeno')}
          pedidos={pedidos.map((p) => ({
            id: p.id, number: p.number, total: p.total, lineas: p.lineas, creadoEn: p.creadoEn.toISOString(),
            creadoPor: p.creadoPor, cliente: p.cliente, cobrando: p.cobrando?.nombre ?? null, mio: p.mio, esMio: p.esMio,
          }))}
        />
      )}
    </main>
  )
}
