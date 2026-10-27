import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { hoyEnZona } from '@/features/credito/reglas'
import { FormularioCompra } from '@/features/compras/components/FormularioCompra'
import { opcionesDeCompra } from '@/features/compras/service'

export const dynamic = 'force-dynamic'

/** Registrar una compra (queda en borrador). Solo `compras.registrar`; desde la ficha de un proveedor llega con él ya elegido. */
export default async function NuevaCompraPage({ searchParams }: { searchParams: Promise<{ proveedor?: string }> }) {
  const ctx = await requireTenantContext()
  if (!puede(ctx, 'compras.registrar')) notFound()
  const db = getTenantPrisma(ctx)
  const sp = await searchParams
  const [opciones, tenant] = await Promise.all([opcionesDeCompra(db, ctx), db.tenant.findFirstOrThrow({ select: { timezone: true } })])

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Nueva compra</h1>
        <p className="text-sm text-ink-muted">Se guarda como borrador. El stock, el costo y la deuda cambian cuando recibes la mercadería.</p>
      </header>
      <FormularioCompra
        modo="crear" opciones={opciones} hoy={hoyEnZona(tenant.timezone)} proveedorInicial={sp.proveedor?.slice(0, 64)}
        puedeOperar={ctx.access === 'FULL' || ctx.access === 'WARN'}
      />
    </main>
  )
}
