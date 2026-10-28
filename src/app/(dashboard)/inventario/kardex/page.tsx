import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { isBusinessError } from '@/lib/errors'
import { buscarProductosKardex, kardexDeProducto, almacenesDelKardex, type KardexResultado, type ProductoKardex } from '@/features/inventory/kardex-service'
import { kardexSchema } from '@/features/inventory/kardex-schemas'
import { enlaceKardex, leerFiltros } from '@/features/inventory/kardex-enlaces'
import { BuscadorProducto, FiltrosKardex } from '@/features/inventory/components/KardexFiltros'
import { KardexAlertas, KardexResumen, KardexTabla } from '@/features/inventory/components/KardexTabla'

export const dynamic = 'force-dynamic'

/**
 * Kardex de un producto: cada movimiento de stock con su saldo y, para quien ve costos, su valor. Ver el kardex: `kardex.ver` (con el PIN de operador no hay
 * acceso). Los costos solo con `productos.ver_costo`: el servicio ni los lee sin ese permiso. Todo viaja por la dirección (producto, almacén, variante, fechas
 * y página), así se puede compartir y volver atrás.
 */
export default async function KardexPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'kardex.ver')) notFound()
  const db = getTenantPrisma(ctx)
  const f = leerFiltros(await searchParams)

  let kardex: KardexResultado | null = null
  let aviso: string | null = null
  let candidatos: ProductoKardex[] = []
  let variantes: { id: string; nombre: string }[] = []

  if (f.producto) {
    const p = kardexSchema.safeParse({ productId: f.producto, warehouseId: f.almacen, variantId: f.variante, desde: f.desde, hasta: f.hasta, cursor: f.cursor, limite: 50 })
    if (!p.success) aviso = p.error.issues[0]?.message ?? 'Revisa los datos del filtro.'
    else {
      try {
        kardex = await kardexDeProducto(db, ctx, p.data)
        variantes = (await db.productVariant.findMany({ where: { productId: f.producto }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })).map((v) => ({ id: v.id, nombre: v.name }))
      } catch (e) {
        if (isBusinessError(e) && (e.code === 'NOT_FOUND' || e.code === 'INVALID_DOCUMENT')) aviso = e.message
        else throw e
      }
    }
  } else if (f.q) {
    candidatos = await buscarProductosKardex(db, ctx, f.q)
  }
  const almacenes = kardex?.almacenes ?? (await almacenesDelKardex(db, ctx))

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Kardex</h1>
          <p className="text-sm text-ink-muted">Cada movimiento de un producto, con su saldo{puede(ctx, 'productos.ver_costo') ? ' y su valor' : ''}.</p>
        </div>
        <Link href="/inventario" className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">← Inventario</Link>
      </header>

      <BuscadorProducto q={f.q} />

      {aviso && <p role="alert" data-kardex="aviso" className="rounded-xl border border-stock-low/40 bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">{aviso}</p>}

      {!f.producto && f.q && (
        candidatos.length === 0
          ? <p data-kardex="sin-resultados" className="rounded-xl bg-surface-sunken px-3 py-3 text-sm text-ink-muted">No encontramos productos con control de stock que coincidan con «{f.q}».</p>
          : (
            <ul data-kardex="candidatos" className="flex flex-col gap-2">
              {candidatos.map((c) => (
                <li key={c.id}>
                  <a href={enlaceKardex({ producto: c.id })} className="flex items-center justify-between gap-3 rounded-xl border border-hairline bg-surface px-3 py-3 hover:border-industrial-600">
                    <span className="min-w-0"><span className="block truncate font-semibold text-ink">{c.nombre}</span><span className="font-mono text-xs text-ink-muted">{c.sku}{c.codigo ? ` · ${c.codigo}` : ''}</span></span>
                    <span className="shrink-0 text-sm font-semibold text-industrial-700 dark:text-industrial-300">Ver kardex →</span>
                  </a>
                </li>
              ))}
            </ul>
          )
      )}

      {!f.producto && !f.q && <p data-kardex="ayuda" className="rounded-xl bg-surface-sunken px-3 py-3 text-sm text-ink-muted">Busca un producto para ver su kardex. Por defecto verás los últimos 30 días.</p>}

      {kardex && (
        <>
          <FiltrosKardex filtros={f} almacenes={almacenes} variantes={variantes} desde={kardex.desde} hasta={kardex.hasta} />
          <KardexResumen k={kardex} filtros={f} />
          <KardexAlertas k={kardex} />
          <KardexTabla k={kardex} filtros={f} primeraPagina={!f.cursor} />
        </>
      )}
    </main>
  )
}
