import Link from 'next/link'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError } from '@/lib/errors'
import { diaLocal } from '@/lib/periodos'
import { puede } from '@/lib/puede'
import { GuiaForm } from '@/features/guias/components/GuiaForm'
import { borradorDeTransferencia, borradorDeVenta, type BorradorGuia } from '@/features/guias/service'

export const dynamic = 'force-dynamic'

const caja = 'rounded-2xl border border-hairline bg-surface p-4'

/**
 * Nueva guía. Se abre desde una venta (`?venta=`), una transferencia
 * (`?transferencia=`) o sin origen (`?libre=1`, para una compra u otro motivo).
 * Sin parámetros, pide elegir de dónde sale la mercadería.
 */
export default async function NuevaGuiaPage({
  searchParams,
}: { searchParams: Promise<{ venta?: string; transferencia?: string; libre?: string }> }) {
  const ctx = await requireTenantContext()
  const db = getTenantPrisma(ctx)
  const { venta, transferencia, libre } = await searchParams

  if (!puede(ctx, 'guias.emitir')) {
    return <main className="mx-auto max-w-2xl p-4"><p className="rounded-xl border border-hairline px-4 py-6 text-sm text-ink-muted">No tienes permiso para emitir guías de remisión.</p></main>
  }

  const tenant = await db.tenant.findFirst({ select: { timezone: true } })
  const hoy = diaLocal(tenant?.timezone ?? 'America/Lima', new Date())

  let borrador: BorradorGuia | null = null
  let fallo: string | null = null
  try {
    if (venta) borrador = await borradorDeVenta(db, ctx, venta)
    else if (transferencia) borrador = await borradorDeTransferencia(db, ctx, transferencia)
    else if (libre) {
      const b = ctx.branchId ? await db.branch.findFirst({ where: { id: ctx.branchId }, select: { address: true, ubigeo: true } }) : null
      borrador = {
        motive: 'COMPRA', etiquetaOrigen: null,
        recipient: { docType: '', docNumber: '', name: '' },
        origin: { address: b?.address ?? '', ubigeo: b?.ubigeo ?? '' },
        destination: { address: '', ubigeo: '' }, items: [],
      }
    }
  } catch (e) {
    if (!isBusinessError(e)) throw e
    fallo = e.message
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Nueva guía de remisión</h1>
        <p className="text-sm text-ink-muted"><Link href="/guias" className="underline">← Volver a las guías</Link></p>
      </header>

      {fallo && <p role="alert" className="rounded-xl bg-stock-out-soft px-4 py-3 text-sm font-semibold text-stock-out">{fallo}</p>}

      {borrador ? (
        <GuiaForm borrador={borrador} hoy={hoy} />
      ) : !fallo && (
        <Elegir db={db} />
      )}
    </main>
  )
}

/** Sin origen elegido: ventas recientes, transferencias despachables y la opción sin origen. */
async function Elegir({ db }: { db: ReturnType<typeof getTenantPrisma> }) {
  const [ventas, transferencias] = await Promise.all([
    db.sale.findMany({
      where: { status: 'COMPLETADA' }, orderBy: { completedAt: 'desc' }, take: 15,
      select: { id: true, number: true, total: true, customer: { select: { name: true } } },
      relationLoadStrategy: 'join',
    }),
    db.branchTransfer.findMany({
      where: { status: { in: ['APROBADA', 'EN_TRANSITO', 'RECIBIDA'] } }, orderBy: { requestedAt: 'desc' }, take: 10,
      select: { id: true, number: true, status: true },
    }),
  ])
  return (
    <div className="flex flex-col gap-4">
      <section className={caja}>
        <h2 className="font-bold text-ink">¿De qué venta sale la mercadería?</h2>
        {ventas.length === 0 ? <p className="mt-2 text-sm text-ink-muted">No hay ventas completadas.</p> : (
          <ul className="mt-2 divide-y divide-hairline">
            {ventas.map((v) => (
              <li key={v.id}>
                <Link href={`/guias/nueva?venta=${v.id}`} className="flex items-center justify-between gap-3 py-3">
                  <span><span className="font-mono font-semibold text-ink">{v.number}</span> <span className="text-sm text-ink-muted">{v.customer?.name ?? 'Sin cliente'}</span></span>
                  <span className="font-bold text-ink">S/ {Number(v.total).toFixed(2)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={caja}>
        <h2 className="font-bold text-ink">¿O de una transferencia entre almacenes?</h2>
        {transferencias.length === 0 ? <p className="mt-2 text-sm text-ink-muted">No hay transferencias aprobadas.</p> : (
          <ul className="mt-2 divide-y divide-hairline">
            {transferencias.map((t) => (
              <li key={t.id}><Link href={`/guias/nueva?transferencia=${t.id}`} className="flex items-center justify-between py-3"><span className="font-mono font-semibold text-ink">{t.number}</span><span className="text-xs text-ink-muted">{t.status}</span></Link></li>
            ))}
          </ul>
        )}
      </section>
      <Link href="/guias/nueva?libre=1" className={`${caja} font-semibold text-ink`}>Guía sin venta ni transferencia (compra u otro motivo) →</Link>
    </div>
  )
}
