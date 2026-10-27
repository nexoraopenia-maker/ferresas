import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { parametrosRegistrosSchema, TIPOS_REGISTRO, type ParametrosRegistros, type TipoRegistro } from '@/features/registros/schemas'
import { informeRegistroCompras, informeRegistroVentas } from '@/features/registros/registro-service'
import { BarraDescargaRegistro, PestanasRegistros, TablaRegistroCompras, TablaRegistroVentas } from '@/features/registros/components/TablasRegistros'
import { SelectorPeriodo } from '@/features/reportes/components/SelectorPeriodo'

export const dynamic = 'force-dynamic'

type Search = Promise<{ t?: string; p?: string; desde?: string; hasta?: string }>

/**
 * Registros de ventas y de compras. Los pide `reportes.ver` (dueño, administrador y contador). La pestaña y el periodo viajan por la
 * dirección; una dirección manipulada vuelve a este mes con un aviso, no a un error.
 */
export default async function RegistrosPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'reportes.ver')) notFound()
  const db = getTenantPrisma(ctx)
  const sp = await searchParams

  const tab: TipoRegistro = (TIPOS_REGISTRO as readonly string[]).includes(sp.t ?? '') ? (sp.t as TipoRegistro) : 'ventas'
  const porDefecto = parametrosRegistrosSchema.parse({})
  const leidos = parametrosRegistrosSchema.safeParse({ p: sp.p || undefined, desde: sp.desde || undefined, hasta: sp.hasta || undefined })
  let params: ParametrosRegistros = leidos.success ? leidos.data : porDefecto
  let aviso: string | null = leidos.success ? null : 'Esa dirección tenía un periodo que no entiendo: te muestro este mes.'

  const cargar = async (p: ParametrosRegistros) => {
    if (tab === 'ventas') { const r = await informeRegistroVentas(db, ctx, p); return { texto: r.textoPeriodo, vista: <TablaRegistroVentas r={r.datos} /> } }
    const r = await informeRegistroCompras(db, ctx, p)
    return { texto: r.textoPeriodo, vista: <TablaRegistroCompras r={r.datos} /> }
  }
  let resultado
  try {
    resultado = await cargar(params)
  } catch (e) {
    if (!(isBusinessError(e) && e.code === 'INVALID_DOCUMENT')) throw e
    aviso = e.message
    params = porDefecto
    resultado = await cargar(params)
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Registros de ventas y compras</h1>
        <p className="text-sm text-ink-muted">Para tu contador: cada comprobante y cada documento de compra del periodo, con descarga en CSV. No es el formato oficial de SUNAT (PLE).</p>
      </header>
      <PestanasRegistros activa={tab} params={params} />
      <SelectorPeriodo tab={tab} params={params} accion="/reportes/registros" pestanaInicial="ventas" />
      {aviso && <p role="alert" data-reporte="aviso" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">{aviso}</p>}
      <BarraDescargaRegistro tipo={tab} params={params} texto={resultado.texto} />
      {resultado.vista}
    </main>
  )
}
