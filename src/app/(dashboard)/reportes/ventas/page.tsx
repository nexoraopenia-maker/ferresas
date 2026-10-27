import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { parametrosVentasSchema, TIPOS_REPORTE_VENTAS, type ParametrosVentas, type TipoReporteVentas } from '@/features/reportes/schemas'
import { informeCobros, informeVentasPorMedio, informeVentasPorPeriodo, informeVentasPorVendedor } from '@/features/reportes/ventas-service'
import { SelectorPeriodo } from '@/features/reportes/components/SelectorPeriodo'
import { BarraDescarga, PestanasVentas, TablaCobros, TablaPorMedio, TablaPorPeriodo, TablaPorVendedor } from '@/features/reportes/components/TablasVentas'

export const dynamic = 'force-dynamic'

type Search = Promise<{ t?: string; p?: string; desde?: string; hasta?: string; agrupar?: string; atrib?: string }>

/**
 * Reportes de ventas. La pestaña y el periodo viajan por la dirección. Una dirección manipulada (periodo inventado, rango imposible)
 * vuelve al periodo por defecto con un aviso, en vez de dar un error.
 */
export default async function ReportesVentasPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'reportes.ver')) notFound()
  const db = getTenantPrisma(ctx)
  const sp = await searchParams

  const tab: TipoReporteVentas = (TIPOS_REPORTE_VENTAS as readonly string[]).includes(sp.t ?? '') ? (sp.t as TipoReporteVentas) : 'periodo'
  const porDefecto = parametrosVentasSchema.parse({})
  const leidos = parametrosVentasSchema.safeParse({ p: sp.p || undefined, desde: sp.desde || undefined, hasta: sp.hasta || undefined, agrupar: sp.agrupar || undefined, atrib: sp.atrib || undefined })
  let params: ParametrosVentas = leidos.success ? leidos.data : porDefecto
  let aviso: string | null = leidos.success ? null : 'Esa dirección tenía un periodo que no entiendo: te muestro este mes.'

  const cargar = (p: ParametrosVentas) => {
    switch (tab) {
      case 'periodo': return informeVentasPorPeriodo(db, ctx, p).then((r) => ({ r, vista: <TablaPorPeriodo r={r.datos} /> }))
      case 'vendedor': return informeVentasPorVendedor(db, ctx, p).then((r) => ({ r, vista: <TablaPorVendedor r={r.datos} /> }))
      case 'medios': return informeVentasPorMedio(db, ctx, p).then((r) => ({ r, vista: <TablaPorMedio r={r.datos} /> }))
      case 'cobros': return informeCobros(db, ctx, p).then((r) => ({ r, vista: <TablaCobros r={r.datos} /> }))
    }
  }
  let resultado
  try {
    resultado = await cargar(params)
  } catch (e) {
    // Un rango imposible (fechas que no existen, «hasta» antes de «desde», más de un año): se avisa y se muestra el periodo por defecto.
    if (!(isBusinessError(e) && e.code === 'INVALID_DOCUMENT')) throw e
    aviso = e.message
    params = { ...porDefecto, agrupar: params.agrupar, atrib: params.atrib }
    resultado = await cargar(params)
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Reportes de ventas</h1>
        <p className="text-sm text-ink-muted">Ventas completadas, por la fecha en que se cobraron, en la hora de tu negocio. Las anuladas no cuentan.</p>
      </header>
      <PestanasVentas activa={tab} params={params} />
      <SelectorPeriodo tab={tab} params={params} />
      {aviso && <p role="alert" data-reporte="aviso" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">{aviso}</p>}
      <BarraDescarga tipo={tab} params={params} textoPeriodo={resultado.r.textoPeriodo} />
      {resultado.vista}
    </main>
  )
}
