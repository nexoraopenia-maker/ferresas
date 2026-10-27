import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { puede, puedeAlguno } from '@/lib/puede'

export const dynamic = 'force-dynamic'

/**
 * Centro de reportes. Cada tarjeta aparece solo para quien puede abrir ese reporte (`reportes.ver`; los que revelan costos, además
 * `productos.ver_costo`). Hoy: ventas y rentabilidad. Los demás se irán sumando aquí.
 */
export default async function ReportesPage() {
  const ctx = await requireTenantContext()
  // Cada reporte tiene su propio permiso: ventas = reportes.ver; rentabilidad = productos.ver_costo (no se exigen los dos juntos).
  const verVentas = puede(ctx, 'reportes.ver')
  const verRentabilidad = puede(ctx, 'productos.ver_costo')
  if (!puedeAlguno(ctx, 'reportes.ver', 'productos.ver_costo')) notFound()

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Reportes</h1>
        <p className="text-sm text-ink-muted">Lo que vendiste, cómo te pagaron y quién vendió. Todo por días de tu negocio, con descarga en CSV para Excel.</p>
      </header>
      <ul className="grid gap-3 sm:grid-cols-2" aria-label="Reportes disponibles">
        {verVentas && <li>
          <Link href="/reportes/ventas" data-reporte-tarjeta="ventas" className="flex h-full flex-col gap-1 rounded-2xl border border-hairline bg-surface p-4 hover:bg-surface-sunken">
            <span className="font-bold text-ink">Ventas</span>
            <span className="text-sm text-ink-muted">Por periodo, por vendedor, por medio de pago y cobros (ventas de contado y abonos de deuda).</span>
          </Link>
        </li>}
        {verRentabilidad && <li>
          <Link href="/reportes/rentabilidad" data-reporte-tarjeta="rentabilidad" className="flex h-full flex-col gap-1 rounded-2xl border border-hairline bg-surface p-4 hover:bg-surface-sunken">
            <span className="font-bold text-ink">Rentabilidad</span>
            <span className="text-sm text-ink-muted">Utilidad y margen por producto, valor del inventario y clasificación ABC.</span>
          </Link>
        </li>}
      </ul>
    </main>
  )
}
