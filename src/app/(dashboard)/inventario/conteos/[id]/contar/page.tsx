import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { ContarConteo } from '@/features/inventory/components/ContarConteo'
import { enlaceConteo } from '@/features/inventory/conteo-ui'

export const dynamic = 'force-dynamic'

/**
 * Contar (la pantalla del móvil). Solo `conteo.registrar` (también con el PIN de operador). Es CIEGA: esta página ni siquiera lee lo que dice el sistema. Solo se cuenta con la
 * toma en conteo, o en revisión si el revisor mandó algo a recontar; en cualquier otro estado se explica por qué no.
 */
export default async function ContarPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'conteo.registrar')) notFound()
  const { id } = await params
  const db = getTenantPrisma(ctx)
  const c = await db.inventoryCount.findFirst({ where: { id: id.slice(0, 64) }, select: { id: true, number: true, status: true, warehouse: { select: { name: true } } } })
  if (!c) notFound()
  const porRecontar = c.status === 'EN_REVISION' ? await db.inventoryCountItem.count({ where: { countId: c.id, status: 'RECONTAR' } }) : 0
  const abierta = c.status === 'EN_CONTEO' || (c.status === 'EN_REVISION' && porRecontar > 0)

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-4">
      <Link href={enlaceConteo(c.id)} className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">← {c.number}</Link>
      {abierta
        ? <ContarConteo countId={c.id} numero={c.number} almacen={c.warehouse.name} enRevision={c.status === 'EN_REVISION'} />
        : <p data-contar="cerrado" className="rounded-xl bg-surface-sunken px-3 py-4 text-sm text-ink-muted">{c.status === 'BORRADOR' ? 'Esta toma todavía no se inició: quien la gestiona debe iniciarla.' : c.status === 'EN_REVISION' ? 'Esta toma ya se cerró y no tiene nada por recontar.' : c.status === 'APLICADO' ? 'Esta toma ya se aplicó.' : 'Esta toma está cancelada.'}</p>}
    </main>
  )
}
