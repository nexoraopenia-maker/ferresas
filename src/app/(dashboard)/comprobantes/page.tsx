import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { TaxDocumentList } from '@/features/invoicing/components/TaxDocumentList'
import { SeriesPanel } from '@/features/invoicing/components/SeriesPanel'
import { listarSeriesConfigurables } from '@/features/invoicing/counter-service'
import { puede } from '@/lib/puede'

export const dynamic = 'force-dynamic'

/**
 * Registro de comprobantes emitidos.
 *
 * Es la pantalla que el contador necesita: qué se emitió, con qué serie y
 * correlativo, y en qué estado está frente a la administración tributaria.
 */
export default async function ComprobantesPage() {
  const ctx = await requireTenantContext()
  const db = getTenantPrisma(ctx)

  const [docs, resumen] = await Promise.all([
    db.taxDocument.findMany({
      orderBy: [{ issuedAt: 'desc' }],
      take: 100,
      select: {
        id: true, fullNumber: true, documentType: true, series: true,
        correlativo: true, status: true, statusMessage: true,
        receiverDocType: true, receiverDocNumber: true, receiverName: true,
        currency: true, subtotal: true, taxTotal: true, total: true,
        issuedAt: true,
        sale: { select: { number: true } },
      },
      // Una sentencia en vez de dos: ver la nota en src/lib/session.ts.
      relationLoadStrategy: 'join',
    }),
    db.taxDocument.groupBy({ by: ['status'], _count: { _all: true } }),
  ])

  const tenant = await db.tenant.findFirst({ select: { timezone: true } })

  /*
   * Series configurables de la sucursal activa. Solo para quien puede
   * gestionarlas: a un cajero no le sirve de nada y el panel invita a tocar
   * algo irreversible.
   */
  const puedeSeries = puede(ctx, 'config.fiscal')
  const [series, sucursal] = ctx.branchId && puedeSeries
    ? await Promise.all([
        listarSeriesConfigurables(db, ctx, ctx.branchId),
        db.branch.findFirst({ where: { id: ctx.branchId }, select: { name: true } }),
      ])
    : [null, null]

  const porEstado = Object.fromEntries(resumen.map((r) => [r.status, r._count._all]))

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-5 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Comprobantes</h1>
        <p className="text-sm text-ink-muted">
          Boletas y facturas emitidas, con su serie y estado tributario.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Contador label="Pendientes" value={porEstado.PENDIENTE ?? 0} tono="warn" />
        <Contador label="Enviados" value={porEstado.ENVIADO ?? 0} tono="info" />
        <Contador label="Aceptados" value={porEstado.ACEPTADO ?? 0} tono="ok" />
        <Contador label="Rechazados" value={porEstado.RECHAZADO ?? 0} tono="stop" />
      </section>

      {series && ctx.branchId && (
        <SeriesPanel
          series={series.map((s) => ({
            scope: s.scope as 'TAX_BOLETA' | 'TAX_FACTURA',
            series: s.series,
            next: s.next,
            startNumber: s.startNumber,
            emitidos: s.emitidos,
            editable: s.editable,
            ultimoEmitido: s.ultimoEmitido,
          }))}
          branchId={ctx.branchId}
          sucursal={sucursal?.name ?? 'esta sucursal'}
          puedeGestionar={ctx.access === 'FULL' || ctx.access === 'WARN'}
        />
      )}

      <TaxDocumentList
        canManage={puede(ctx, 'comprobantes.anular')}
        zonaHoraria={tenant?.timezone ?? 'America/Lima'}
        docs={docs.map((d) => ({
          id: d.id,
          fullNumber: d.fullNumber,
          documentType: d.documentType,
          status: d.status,
          statusMessage: d.statusMessage,
          receiverDocNumber: d.receiverDocNumber,
          receiverName: d.receiverName,
          currency: d.currency,
          subtotal: d.subtotal.toFixed(2),
          taxTotal: d.taxTotal.toFixed(2),
          total: d.total.toFixed(2),
          issuedAt: d.issuedAt.toISOString(),
          saleNumber: d.sale.number,
        }))}
      />
    </main>
  )
}

function Contador({
  label, value, tono,
}: { label: string; value: number; tono: 'ok' | 'info' | 'warn' | 'stop' }) {
  const acento =
    tono === 'ok' ? 'text-stock-ok'
    : tono === 'warn' ? 'text-stock-low'
    : tono === 'stop' ? 'text-stock-out'
    : 'text-industrial-600'
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${acento}`}>{value}</p>
    </div>
  )
}
