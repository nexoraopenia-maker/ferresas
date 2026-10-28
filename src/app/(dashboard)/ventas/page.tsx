import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { puede } from '@/lib/puede'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { isBusinessError } from '@/lib/errors'
import { puedeVerVentas } from '@/features/ventas/permisos'
import { COMPROBANTES_FILTRO, ESTADOS_VENTA, ETIQUETA_COMPROBANTE_FILTRO, ETIQUETA_ESTADO_VENTA, parametrosVentasListaSchema, type ParametrosVentasLista } from '@/features/ventas/schemas'
import { listarVentas } from '@/features/ventas/service'
import { TablaVentas } from '@/features/ventas/components/TablaVentas'
import { SelectorPeriodo } from '@/features/reportes/components/SelectorPeriodo'

export const dynamic = 'force-dynamic'

type Search = Promise<{ p?: string; desde?: string; hasta?: string; sucursal?: string; estado?: string; comprobante?: string; q?: string; cursor?: string }>
const campo = 'h-touch rounded-xl border border-hairline bg-surface px-3 text-ink'

/**
 * Historial de ventas. Lo ve quien cobra, quien anula o quien revisa reportes; cada uno ve solo las sucursales que tiene asignadas. Nunca
 * muestra costos. Los filtros viajan por la dirección; una dirección manipulada vuelve a la última semana con un aviso, no a un error.
 */
export default async function VentasPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireTenantContext()
  if (!puedeVerVentas(ctx)) notFound()
  const db = getTenantPrisma(ctx)
  const sp = await searchParams

  const porDefecto = parametrosVentasListaSchema.parse({})
  const leidos = parametrosVentasListaSchema.safeParse({
    p: sp.p || undefined, desde: sp.desde || undefined, hasta: sp.hasta || undefined, sucursal: sp.sucursal || undefined, estado: sp.estado || undefined,
    comprobante: sp.comprobante || undefined, q: sp.q || undefined, cursor: sp.cursor || undefined,
  })
  let params: ParametrosVentasLista = leidos.success ? leidos.data : porDefecto
  let aviso: string | null = leidos.success ? null : 'Esa dirección tenía filtros que no entiendo: te muestro la última semana.'

  let pagina
  try {
    pagina = await listarVentas(db, ctx, params)
  } catch (e) {
    if (!(isBusinessError(e) && e.code === 'INVALID_DOCUMENT')) throw e
    aviso = e.message
    params = porDefecto
    pagina = await listarVentas(db, ctx, params)
  }

  const extra = (
    <>
      {pagina.sucursales.length > 1 && (
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">Sucursal
          <select name="sucursal" defaultValue={params.sucursal ?? ''} className={campo}>
            <option value="">Todas</option>
            {pagina.sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">Estado
        <select name="estado" defaultValue={params.estado ?? ''} className={campo}>
          <option value="">Todos</option>
          {ESTADOS_VENTA.map((e) => <option key={e} value={e}>{ETIQUETA_ESTADO_VENTA[e]}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">Comprobante
        <select name="comprobante" defaultValue={params.comprobante ?? ''} className={campo}>
          <option value="">Todos</option>
          {COMPROBANTES_FILTRO.map((c) => <option key={c} value={c}>{ETIQUETA_COMPROBANTE_FILTRO[c]}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">Buscar
        <input type="search" name="q" defaultValue={params.q ?? ''} maxLength={60} placeholder="N.º de venta, comprobante o cliente" className={`${campo} w-60`} />
      </label>
    </>
  )

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Ventas</h1>
        <p className="text-sm text-ink-muted">El historial de lo que vendiste, en la hora de tu negocio. Abre una venta para ver sus detalles{puede(ctx, 'ventas.anular') ? ' o anularla / devolverla' : ''}.</p>
      </header>
      <SelectorPeriodo tab="ventas" pestanaInicial="ventas" accion="/ventas" params={params} extra={extra} />
      {aviso && <p role="alert" data-reporte="aviso" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">{aviso}</p>}
      <p data-periodo className="text-sm font-semibold text-ink">{pagina.textoPeriodo ?? 'Resultado de la búsqueda, de cualquier fecha'}</p>
      <TablaVentas pagina={pagina} params={params} />
    </main>
  )
}
