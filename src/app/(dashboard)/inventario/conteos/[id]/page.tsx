import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { formatearFechaLocal } from '@/lib/fecha-local'
import { puedeVerConteos } from '@/features/inventory/conteo-service'
import { detalleDeConteo } from '@/features/inventory/conteo-lista'
import { puedeVerRevision } from '@/features/inventory/conteo-revision'
import { AccionesConteo } from '@/features/inventory/components/AccionesConteo'
import { InsigniaEstado } from '@/features/inventory/components/ConteosLista'
import { AYUDA_MODO, ETIQUETA_ALCANCE, ETIQUETA_MODO, accionesDisponibles, enlaceActa, enlaceContar, enlaceConteos, enlaceCsvConteo, enlaceRevision } from '@/features/inventory/conteo-ui'

export const dynamic = 'force-dynamic'

/** El detalle de una toma de inventario y lo que se puede hacer ahora con ella, según su estado y los permisos de la persona. */
export default async function ConteoPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantContext()
  if (!puedeVerConteos(ctx)) notFound()
  const { id } = await params
  const db = getTenantPrisma(ctx)
  const c = await detalleDeConteo(db, ctx, id.slice(0, 64)).catch((e) => { if (isBusinessError(e) && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN_ROLE')) return null; throw e })
  if (!c) notFound()
  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const sinPin = !ctx.operadorDe
  const a = accionesDisponibles(c.status, {
    gestionar: puede(ctx, 'conteo.gestionar') && sinPin, registrar: puede(ctx, 'conteo.registrar'), aprobar: puede(ctx, 'stock.ajustar') && sinPin, verRevision: puedeVerRevision(ctx),
  }, { porRecontar: c.porRecontar > 0, aplicadas: c.aplicadas > 0 })
  const f = (iso: string | null) => (iso ? formatearFechaLocal(iso, tenant.timezone) : '—')

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">{c.number}</h1>
          <p className="text-sm text-ink-muted">{c.warehouse.name} · {ETIQUETA_ALCANCE[c.scope]} · Conteo {ETIQUETA_MODO[c.mode].toLowerCase()}</p>
        </div>
        <div className="flex items-center gap-3"><InsigniaEstado estado={c.status} /><Link href={enlaceConteos()} className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">← Todas</Link></div>
      </header>

      <section data-conteo="resumen" className="rounded-2xl border border-hairline bg-surface p-4">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-ink-muted">Líneas</dt><dd className="font-semibold text-ink">{c.lineas === 0 ? '—' : c.lineas}</dd></div>
          <div><dt className="text-xs text-ink-muted">Contadas</dt><dd className="font-semibold text-ink">{c.lineas === 0 ? '—' : c.contadas}</dd></div>
          <div><dt className="text-xs text-ink-muted">Sin contar</dt><dd className="font-semibold text-ink">{c.lineas === 0 ? '—' : c.pendientes}</dd></div>
          <div><dt className="text-xs text-ink-muted">Pasadas</dt><dd className="font-semibold text-ink">{c.pasadas}</dd></div>
        </dl>
        <dl className="mt-3 grid gap-1 text-xs text-ink-muted sm:grid-cols-2">
          <div>Creada {f(c.createdAt)} · {c.creadoPor}</div>
          <div>Iniciada {f(c.startedAt)}{c.iniciadoPor ? ` · ${c.iniciadoPor}` : ''}</div>
          <div>Cerrada {f(c.closedAt)}{c.cerradoPor ? ` · ${c.cerradoPor}` : ''}</div>
          <div>Aplicada {f(c.aplicadoEn)}{c.aplicadoPor ? ` · ${c.aplicadoPor}` : ''}</div>
        </dl>
        <p className="mt-2 text-xs text-ink-muted">{AYUDA_MODO[c.mode]}</p>
        {c.notes && <p className="mt-2 text-sm text-ink">Nota: {c.notes}</p>}
        {c.status === 'CANCELADO' && <p data-conteo="cancelado" className="mt-2 rounded-lg bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">Cancelada{c.canceladoPor ? ` por ${c.canceladoPor}` : ''}: {c.motivoCancelacion}</p>}
        {c.status === 'EN_CONTEO' && c.lineas === 0 && <p className="mt-2 text-sm text-ink-muted">Todavía no hay nada contado.</p>}
        {c.aplicadas > 0 && <p data-conteo="aplicadas" className="mt-2 text-sm font-semibold text-stock-ok">{c.aplicadas} ajuste(s) ya aplicados al stock.</p>}
      </section>

      <AccionesConteo countId={c.id} acciones={a} />

      <nav data-conteo="enlaces" className="flex flex-wrap gap-2">
        {a.contar && <a data-enlace="contar" href={enlaceContar(c.id)} className="h-touch-lg inline-flex items-center rounded-xl bg-industrial-600 px-5 text-base font-bold text-white">{c.status === 'EN_REVISION' ? 'Recontar lo pendiente' : 'Contar'}</a>}
        {a.verRevision && <a data-enlace="revision" href={enlaceRevision(c.id)} className="h-touch inline-flex items-center rounded-xl border border-hairline px-4 text-sm font-semibold text-ink">{a.decidir ? 'Revisar y aprobar diferencias' : 'Ver diferencias'}</a>}
        {a.acta && <a data-enlace="acta" href={enlaceActa(c.id)} target="_blank" rel="noopener" className="h-touch inline-flex items-center rounded-xl border border-hairline px-4 text-sm font-semibold text-ink">Acta (A4)</a>}
        {a.csv && <a data-enlace="csv" href={enlaceCsvConteo(c.id)} download className="h-touch inline-flex items-center rounded-xl border border-hairline px-4 text-sm font-semibold text-ink">Descargar CSV</a>}
      </nav>
    </main>
  )
}
