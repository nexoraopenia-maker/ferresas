import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { fechaDiaCorta } from '@/lib/fecha-local'
import { parametrosCostosSchema, TIPOS_REPORTE_COSTOS, type ParametrosCostos, type TipoReporteCostos } from '@/features/reportes/schemas'
import { informeAbc, informeInventario, informeMargen } from '@/features/reportes/rentabilidad-service'
import { SelectorPeriodo } from '@/features/reportes/components/SelectorPeriodo'
import { BarraDescargaCostos, PestanasCostos, TablaAbc, TablaInventario, TablaMargen } from '@/features/reportes/components/TablasRentabilidad'

export const dynamic = 'force-dynamic'

type Search = Promise<{ t?: string; p?: string; desde?: string; hasta?: string; base?: string; a?: string; b?: string }>

const campo = 'h-touch rounded-xl border border-hairline bg-surface px-3 text-ink'

/**
 * Rentabilidad: margen por producto, inventario valorizado y ABC. Revela costos, así que la puerta es `productos.ver_costo` (y solo ese:
 * el permiso de los reportes de ventas no basta, igual que no basta para ver el costo en el catálogo). Sin el permiso la página no existe (404).
 */
export default async function RentabilidadPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'productos.ver_costo')) notFound()
  const db = getTenantPrisma(ctx)
  const sp = await searchParams

  const tab: TipoReporteCostos = (TIPOS_REPORTE_COSTOS as readonly string[]).includes(sp.t ?? '') ? (sp.t as TipoReporteCostos) : 'margen'
  const porDefecto = parametrosCostosSchema.parse({})
  const leidos = parametrosCostosSchema.safeParse({ p: sp.p || undefined, desde: sp.desde || undefined, hasta: sp.hasta || undefined, base: sp.base || undefined, a: sp.a || undefined, b: sp.b || undefined })
  let params: ParametrosCostos = leidos.success ? leidos.data : porDefecto
  let aviso: string | null = leidos.success ? null : (leidos.error.issues[0]?.path[0] === 'a' || leidos.error.issues[0]?.path[0] === 'b'
    ? 'Esos umbrales no sirven (A debe ser menor que B, entre 1 y 99): uso 80 % y 95 %.'
    : 'Esa dirección tenía un periodo que no entiendo: te muestro este mes.')

  const cargar = async (p: ParametrosCostos) => {
    switch (tab) {
      case 'margen': { const r = await informeMargen(db, ctx, p); return { texto: r.textoPeriodo, vista: <TablaMargen r={r.datos} /> } }
      case 'abc': { const r = await informeAbc(db, ctx, p); return { texto: r.textoPeriodo, vista: <TablaAbc r={r.datos} /> } }
      case 'inventario': { const r = await informeInventario(db, ctx); return { texto: `Inventario al ${fechaDiaCorta(r.fecha)}`, vista: <TablaInventario r={r.datos} fecha={r.fecha} /> } }
    }
  }
  let resultado
  try {
    resultado = await cargar(params)
  } catch (e) {
    if (!(isBusinessError(e) && e.code === 'INVALID_DOCUMENT')) throw e
    aviso = e.message
    params = { ...porDefecto, base: params.base }
    resultado = await cargar(params)
  }

  const extraAbc = (
    <>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">Ordenar por
        <select name="base" defaultValue={params.base} className={campo}><option value="VENTAS">Venta sin IGV</option><option value="UTILIDAD">Utilidad</option></select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">A hasta (%)
        <input type="number" name="a" min={1} max={99} defaultValue={params.a} className={`${campo} w-24`} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">B hasta (%)
        <input type="number" name="b" min={1} max={99} defaultValue={params.b} className={`${campo} w-24`} />
      </label>
    </>
  )

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Rentabilidad</h1>
        <p className="text-sm text-ink-muted">Utilidad, valor del inventario y clasificación ABC. Usan los costos de tus productos: solo lo ven quienes pueden ver costos.</p>
      </header>
      <PestanasCostos activa={tab} params={params} />
      {tab !== 'inventario' && <SelectorPeriodo tab={tab} params={params} accion="/reportes/rentabilidad" pestanaInicial="margen" extra={tab === 'abc' ? extraAbc : undefined} />}
      {aviso && <p role="alert" data-reporte="aviso" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">{aviso}</p>}
      <BarraDescargaCostos tipo={tab} params={params} texto={resultado.texto} />
      {resultado.vista}
    </main>
  )
}
