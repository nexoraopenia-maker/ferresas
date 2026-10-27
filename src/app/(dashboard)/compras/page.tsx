import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { ComprasLista } from '@/features/compras/components/ComprasLista'
import { FILTROS_COMPRA, type FiltroCompra } from '@/features/compras/borrador-ui'
import { listarComprasSchema } from '@/features/compras/schemas'
import { listarCompras } from '@/features/compras/service'
import { puedeVerProveedores } from '@/features/proveedores/permisos'

export const dynamic = 'force-dynamic'

/**
 * Compras del negocio. Las ve quien gestiona proveedores, registra compras o paga; registrar es de `compras.registrar`. El filtro por
 * estado, la búsqueda y el proveedor viajan por la dirección (desde la ficha del proveedor se llega ya filtrado).
 */
export default async function ComprasPage({ searchParams }: { searchParams: Promise<{ q?: string; estado?: string; proveedor?: string }> }) {
  const ctx = await requireTenantContext()
  if (!puedeVerProveedores(ctx)) notFound()
  const db = getTenantPrisma(ctx)

  const sp = await searchParams
  const filtro: FiltroCompra = (FILTROS_COMPRA as readonly string[]).includes(sp.estado ?? '') ? (sp.estado as FiltroCompra) : 'TODAS'
  // El proveedor de la dirección solo se usa si existe en ESTE negocio; si no, la lista es la general.
  const proveedor = sp.proveedor ? await db.supplier.findFirst({ where: { id: sp.proveedor.slice(0, 64) }, select: { id: true, name: true } }) : null
  const parsed = listarComprasSchema.safeParse({ q: sp.q, estado: filtro === 'TODAS' ? undefined : filtro, supplierId: proveedor?.id })
  const entrada = parsed.success ? parsed.data : listarComprasSchema.parse({})
  const [pagina, tenant] = await Promise.all([listarCompras(db, ctx, entrada), db.tenant.findFirstOrThrow({ select: { timezone: true } })])

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Compras</h1>
        <p className="text-sm text-ink-muted">La mercadería que entra: borradores, recibidas y anuladas.</p>
      </header>
      <ComprasLista
        key={`${filtro}|${entrada.q ?? ''}|${proveedor?.id ?? ''}`} inicial={pagina} filtro={filtro} q={entrada.q} proveedor={proveedor ?? undefined}
        puedeRegistrar={puede(ctx, 'compras.registrar')} puedeOperar={ctx.access === 'FULL' || ctx.access === 'WARN'} zona={tenant.timezone}
      />
    </main>
  )
}
