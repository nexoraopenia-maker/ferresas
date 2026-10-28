import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { estadoDeRevision, puedeVerRevision, revisionDelConteo } from '@/features/inventory/conteo-revision'
import { revisionSchema } from '@/features/inventory/conteo-schemas'
import { BarraRevision } from '@/features/inventory/components/BarraRevision'
import { InsigniaEstado } from '@/features/inventory/components/ConteosLista'
import { RevisionTabla } from '@/features/inventory/components/RevisionTabla'
import { ETIQUETA_ESTADO_LINEA, enlaceActa, enlaceConteo, enlaceCsvConteo, enlaceRevision } from '@/features/inventory/conteo-ui'

export const dynamic = 'force-dynamic'

const ESTADOS_LINEA = Object.keys(ETIQUETA_ESTADO_LINEA) as (keyof typeof ETIQUETA_ESTADO_LINEA)[]

/**
 * Revisión de diferencias: lo contado frente a lo que decía el kardex a la hora de contar. La ve quien tiene `stock.ajustar` o `conteo.gestionar`; decidir (aprobar, recontar,
 * rechazar, aplicar) es solo de `stock.ajustar` y nunca con el PIN de operador. Los costos y valores aparecen solo con `productos.ver_costo`. Un conteo que no existe o que no se
 * puede ver es un 404.
 */
export default async function RevisionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ estado?: string; cursor?: string }> }) {
  const ctx = await requireTenantContext()
  if (!puedeVerRevision(ctx)) notFound()
  const { id } = await params
  const { estado, cursor } = await searchParams
  const db = getTenantPrisma(ctx)
  const filtro = ESTADOS_LINEA.find((e) => e === estado)
  const p = revisionSchema.safeParse({ countId: id.slice(0, 64), estado: filtro, cursor: cursor?.slice(0, 64), limite: 100 })
  if (!p.success) notFound()
  const datos = await Promise.all([revisionDelConteo(db, ctx, p.data), estadoDeRevision(db, ctx, p.data.countId)]).catch((e) => { if (isBusinessError(e) && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN_ROLE')) return null; throw e })
  if (!datos) notFound()
  const [rev, est] = datos
  const puedeDecidir = puede(ctx, 'stock.ajustar') && !ctx.operadorDe && rev.conteo.status === 'EN_REVISION'
  const aplicable = puedeDecidir && est.porRecontar === 0 && est.contadas === 0

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Revisión · {rev.conteo.number}</h1>
          <p className="text-sm text-ink-muted">{rev.conteo.warehouse.name}. «Sistema al contar» es lo que decía el kardex a la hora de la última pasada de cada producto.</p>
        </div>
        <div className="flex items-center gap-3"><InsigniaEstado estado={rev.conteo.status} /><Link href={enlaceConteo(rev.conteo.id)} className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">← Toma</Link></div>
      </header>

      <BarraRevision countId={rev.conteo.id} estado={est} puedeDecidir={puedeDecidir} aplicable={aplicable} />

      <nav data-revision="filtros" aria-label="Filtrar por estado de la línea" className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        <a href={enlaceRevision(rev.conteo.id)} aria-current={!filtro ? 'page' : undefined} className={`rounded-full px-3 py-1 ${!filtro ? 'bg-industrial-600 text-white' : 'border border-hairline text-ink'}`}>Todas</a>
        {ESTADOS_LINEA.map((e) => <a key={e} href={enlaceRevision(rev.conteo.id, { estado: e })} aria-current={filtro === e ? 'page' : undefined} className={`rounded-full px-3 py-1 ${filtro === e ? 'bg-industrial-600 text-white' : 'border border-hairline text-ink'}`}>{ETIQUETA_ESTADO_LINEA[e]}</a>)}
        <span className="ml-auto flex gap-2">
          {(rev.conteo.status === 'EN_REVISION' || rev.conteo.status === 'APLICADO') && <a data-enlace="acta" href={enlaceActa(rev.conteo.id)} target="_blank" rel="noopener" className="rounded-full border border-hairline px-3 py-1 text-ink">Acta (A4)</a>}
          <a data-enlace="csv" href={enlaceCsvConteo(rev.conteo.id)} download className="rounded-full border border-hairline px-3 py-1 text-ink">CSV</a>
        </span>
      </nav>

      <RevisionTabla countId={rev.conteo.id} lineas={rev.lineas} conCostos={rev.conCostos} puedeDecidir={puedeDecidir} />

      {(rev.siguiente || cursor) && (
        <nav data-revision="paginas" className="flex items-center justify-between gap-3 text-sm font-semibold">
          {cursor ? <a href={enlaceRevision(rev.conteo.id, { estado: filtro })} className="text-industrial-700 dark:text-industrial-300">← Volver al inicio</a> : <span />}
          {rev.siguiente ? <a data-revision="siguiente" href={enlaceRevision(rev.conteo.id, { estado: filtro, cursor: rev.siguiente })} className="rounded-xl border border-hairline px-4 py-2 text-ink">Ver más líneas →</a> : <span />}
        </nav>
      )}
    </main>
  )
}
