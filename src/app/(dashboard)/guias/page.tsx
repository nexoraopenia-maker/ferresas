import Link from 'next/link'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { puede, puedeAlguno } from '@/lib/puede'
import { GuiasList } from '@/features/guias/components/GuiasList'
import { listarGuias } from '@/features/guias/service'

export const dynamic = 'force-dynamic'

/** Guías de remisión emitidas, con su estado y la venta o transferencia de origen. */
export default async function GuiasPage() {
  const ctx = await requireTenantContext()
  const db = getTenantPrisma(ctx)
  const puedeVer = puedeAlguno(ctx, 'guias.emitir', 'guias.anular', 'reportes.ver')
  if (!puedeVer) {
    return <main className="mx-auto max-w-2xl p-4"><p className="rounded-xl border border-hairline px-4 py-6 text-sm text-ink-muted">No tienes acceso a las guías de remisión.</p></main>
  }

  const guias = await listarGuias(db)
  const emite = puede(ctx, 'guias.emitir')

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-5 p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Guías de remisión</h1>
          <p className="text-sm text-ink-muted">Acompañan la mercadería que sale: ventas, traslados entre almacenes y otros.</p>
        </div>
        {emite && (
          <Link href="/guias/nueva" className="h-touch-lg inline-flex items-center rounded-xl bg-industrial-600 px-5 font-bold text-white">Nueva guía</Link>
        )}
      </header>
      <GuiasList
        puedeAnular={puede(ctx, 'guias.anular')}
        filas={guias.map((g) => ({
          id: g.id, fullNumber: g.fullNumber, motive: g.motive, transportMode: g.transportMode,
          issueDate: g.issueDate.toISOString().slice(0, 10),
          recipientName: g.recipientName, recipientDocNumber: g.recipientDocNumber,
          grossWeightKg: Number(g.grossWeightKg), status: g.status,
          voidedAt: g.voidedAt?.toISOString() ?? null, voidReason: g.voidReason,
          origen: g.sale ? `Venta ${g.sale.number}` : g.transfer ? `Transferencia ${g.transfer.number}` : null,
          lineas: g._count.items,
        }))}
      />
    </main>
  )
}
