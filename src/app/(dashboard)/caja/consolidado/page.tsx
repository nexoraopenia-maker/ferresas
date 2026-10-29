import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { consolidadoDelDia } from '@/features/branches/consolidado-caja'
import { ConsolidadoCajaVista } from '@/features/branches/components/ConsolidadoCaja'

export const dynamic = 'force-dynamic'

type Search = Promise<{ fecha?: string }>

/**
 * Consolidado del día por sucursal: lo vendido y arqueado en TODAS las cajas. Solo con `caja.consolidado` (dueño y administrador); para el resto la ruta no existe (404). El día es el del negocio, por la
 * fecha en que se abrió cada turno. Se puede descargar en CSV.
 */
export default async function ConsolidadoPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'caja.consolidado')) notFound()
  const { fecha } = await searchParams
  const db = getTenantPrisma(ctx)
  let consolidado
  let aviso: string | null = null
  try {
    consolidado = await consolidadoDelDia(db, ctx, fecha || null)
  } catch (e) {
    if (!isBusinessError(e) || e.code !== 'INVALID_DOCUMENT') throw e
    aviso = e.message
    consolidado = await consolidadoDelDia(db, ctx, null)
  }
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-5 p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Consolidado de caja</h1>
          <p className="text-sm text-ink-muted">Todas las cajas de cada sucursal, por día de apertura del turno.</p>
        </div>
        <Link href="/caja" className="text-sm font-semibold underline">Volver a Caja</Link>
      </header>
      <form method="get" className="flex flex-wrap items-end gap-3" data-consolidado="filtro">
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Día
          <input type="date" name="fecha" defaultValue={consolidado.fecha} className="h-11 rounded-xl border-2 border-hairline px-3" />
        </label>
        <button type="submit" className="h-11 rounded-xl bg-industrial-600 px-4 text-sm font-bold text-white">Ver</button>
        <a href={`/api/caja/consolidado?fecha=${consolidado.fecha}`} className="h-11 rounded-xl border-2 border-hairline px-4 py-2.5 text-sm font-bold text-ink" data-consolidado="csv">Descargar CSV</a>
      </form>
      {aviso && <p role="alert" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">{aviso} Se muestra hoy.</p>}
      <ConsolidadoCajaVista c={consolidado} />
    </main>
  )
}
