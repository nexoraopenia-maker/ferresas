import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { parametrosRegistrosSchema, type ParametrosRegistros } from '@/features/registros/schemas'
import { informeConciliacion } from '@/features/conciliacion/conciliacion-service'
import { BarraDescargaConciliacion, VistaConciliacion } from '@/features/conciliacion/components/VistaConciliacion'
import { SelectorPeriodo } from '@/features/reportes/components/SelectorPeriodo'

export const dynamic = 'force-dynamic'

type Search = Promise<{ p?: string; desde?: string; hasta?: string }>

/**
 * Conciliación fiscal: comprueba que ventas, comprobantes, numeración, envíos y compras cuadran entre sí. Solo informa. La pide `reportes.ver`
 * (dueño, administrador y contador). El periodo viaja por la dirección; una dirección manipulada vuelve a este mes con un aviso.
 */
export default async function ConciliacionPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'reportes.ver')) notFound()
  const db = getTenantPrisma(ctx)
  const sp = await searchParams

  const porDefecto = parametrosRegistrosSchema.parse({})
  const leidos = parametrosRegistrosSchema.safeParse({ p: sp.p || undefined, desde: sp.desde || undefined, hasta: sp.hasta || undefined })
  let params: ParametrosRegistros = leidos.success ? leidos.data : porDefecto
  let aviso: string | null = leidos.success ? null : 'Esa dirección tenía un periodo que no entiendo: te muestro este mes.'

  let resultado
  try {
    resultado = await informeConciliacion(db, ctx, params)
  } catch (e) {
    if (!(isBusinessError(e) && e.code === 'INVALID_DOCUMENT')) throw e
    aviso = e.message
    params = porDefecto
    resultado = await informeConciliacion(db, ctx, params)
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Conciliación fiscal</h1>
        <p className="text-sm text-ink-muted">Comprueba que tus ventas, comprobantes, series, envíos y compras cuadran entre sí. Solo informa: no corrige nada.</p>
      </header>
      <SelectorPeriodo tab="conciliacion" pestanaInicial="conciliacion" accion="/reportes/conciliacion" params={params} />
      {aviso && <p role="alert" data-reporte="aviso" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">{aviso}</p>}
      <BarraDescargaConciliacion params={params} texto={resultado.textoPeriodo} />
      <VistaConciliacion r={resultado.informe} />
    </main>
  )
}
