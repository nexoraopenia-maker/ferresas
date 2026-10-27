import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { ProveedoresLista } from '@/features/proveedores/components/ProveedoresLista'
import { listarProveedoresSchema } from '@/features/proveedores/schemas'
import { listarProveedores, puedeVerProveedores } from '@/features/proveedores/service'

export const dynamic = 'force-dynamic'

/**
 * Proveedores del negocio. Lo ve quien gestiona proveedores, registra compras o paga; crear, editar y dar de baja es de
 * `proveedores.gestionar`. La búsqueda y el filtro viajan por la dirección.
 */
export default async function ProveedoresPage({ searchParams }: { searchParams: Promise<{ q?: string; filtro?: string }> }) {
  const ctx = await requireTenantContext()
  if (!puedeVerProveedores(ctx)) notFound()

  const sp = await searchParams
  const puedeGestionar = puede(ctx, 'proveedores.gestionar')
  const parsed = listarProveedoresSchema.safeParse({ q: sp.q, filtro: sp.filtro })
  // Una dirección manipulada (filtro inventado, «de baja» sin permiso) vuelve a la lista normal en vez de fallar.
  const entrada = parsed.success && !(parsed.data.filtro === 'DE_BAJA' && !puedeGestionar) ? parsed.data : listarProveedoresSchema.parse({})
  const pagina = await listarProveedores(getTenantPrisma(ctx), ctx, entrada)

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Proveedores</h1>
        <p className="text-sm text-ink-muted">A quién le compras, cuánto le debes y cuándo vence.</p>
      </header>
      <ProveedoresLista
        key={`${entrada.filtro}|${entrada.q ?? ''}`} inicial={pagina} filtro={entrada.filtro} q={entrada.q}
        puedeGestionar={puedeGestionar} puedeOperar={ctx.access === 'FULL' || ctx.access === 'WARN'}
      />
    </main>
  )
}
