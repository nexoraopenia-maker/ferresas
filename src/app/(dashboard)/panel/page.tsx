import Link from 'next/link'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { alertasDeStock, rendimientoDeCaja, resumenDeVentas } from '@/features/dashboard/service'
import { contarMermasPendientes } from '@/features/inventory/merma-service'
import { contarCostosPendientes } from '@/features/inventory/costos-service'
import {
  AlertasStockWidget, CajaWidget, GraficoSemana, KpiVentas, PendientesWidget, TopProductos,
} from '@/features/dashboard/components/Widgets'

export const dynamic = 'force-dynamic'

/**
 * Panel principal.
 *
 * Cada bloque aparece solo para quien puede ver ese dato: las ventas y el
 * ranking exigen `reportes.ver` (es dinero del negocio), la caja exige
 * `reportes.ver` o `caja.arqueo`, y las alertas de stock las ve cualquiera
 * porque es lo mismo que el POS enseña al vender. Lo decide el SERVICIO; aquí
 * solo se evita pedir lo que se sabe que se va a negar.
 */
export default async function PanelPage() {
  const ctx = await requireTenantContext()
  const db = getTenantPrisma(ctx)

  const verVentas = puede(ctx, 'reportes.ver')
  const verCaja = verVentas || puede(ctx, 'caja.arqueo')

  const [ventas, caja, alertas, tenant, mermasPendientes, costosPendientes] = await Promise.all([
    verVentas ? resumenDeVentas(db, ctx) : null,
    verCaja ? rendimientoDeCaja(db, ctx) : null,
    alertasDeStock(db, ctx),
    db.tenant.findFirst({ select: { name: true } }),
    // Cada contador solo para quien puede actuar sobre él; para los demás no se calcula ni se muestra.
    puede(ctx, 'stock.ajustar') && ctx.branchId ? contarMermasPendientes(db, ctx.branchId) : Promise.resolve(null),
    puede(ctx, 'productos.ver_costo') ? contarCostosPendientes(db, ctx) : Promise.resolve(null),
  ])

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-5 p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-ink">Panel</h1>
          <p className="text-sm text-ink-muted">
            {tenant?.name ?? 'Tu ferretería'} · así va el negocio
          </p>
        </div>
        {puede(ctx, 'ventas.crear') && (
          <Link
            href="/pos"
            className="h-touch-lg inline-flex items-center rounded-xl bg-accent-600 px-5 font-bold text-white shadow-md shadow-accent-600/30 hover:bg-accent-700"
          >
            Nueva venta
          </Link>
        )}
      </header>

      <PendientesWidget mermas={mermasPendientes} costos={costosPendientes} />

      {ventas && (
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Ventas">
          <KpiVentas titulo="Hoy" datos={ventas.hoy} destacado />
          <KpiVentas titulo="Esta semana" datos={ventas.semana} />
          <KpiVentas titulo="Este mes" datos={ventas.mes} />
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {ventas && <GraficoSemana dias={ventas.ultimos7} />}
        {ventas && <TopProductos items={ventas.topProductos} />}
        {caja && <CajaWidget caja={caja} />}
        <AlertasStockWidget {...alertas} />
      </div>

      {!ventas && !caja && (
        <p className="rounded-2xl border border-hairline bg-surface p-4 text-sm text-ink-muted">
          Tu rol no incluye informes de ventas. Usa el menú para ir a lo tuyo.
        </p>
      )}
    </main>
  )
}
