import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { ClientesLista } from '@/features/clientes/components/ClientesLista'
import { listarClientesSchema } from '@/features/clientes/schemas'
import { listarClientes, puedeVerClientes } from '@/features/clientes/service'

export const dynamic = 'force-dynamic'

/**
 * Clientes del negocio. Lo ve quien gestiona clientes o maneja el crédito (el cajero que cobra abonos incluido, en solo lectura);
 * crear y editar es de `clientes.gestionar`. La búsqueda y el filtro viajan por la dirección.
 */
export default async function ClientesPage({ searchParams }: { searchParams: Promise<{ q?: string; filtro?: string }> }) {
  const ctx = await requireTenantContext()
  if (!puedeVerClientes(ctx)) notFound()

  const sp = await searchParams
  const puedeGestionar = puede(ctx, 'clientes.gestionar')
  const parsed = listarClientesSchema.safeParse({ q: sp.q, filtro: sp.filtro })
  // Una dirección manipulada (filtro inventado, «de baja» sin permiso) vuelve a la lista normal en vez de fallar.
  const entrada = parsed.success && !(parsed.data.filtro === 'DE_BAJA' && !puedeGestionar) ? parsed.data : listarClientesSchema.parse({})
  const pagina = await listarClientes(getTenantPrisma(ctx), ctx, entrada)

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Clientes</h1>
        <p className="text-sm text-ink-muted">Quién te compra, cuánto te debe y cuánto crédito tiene disponible.</p>
      </header>
      <ClientesLista
        key={`${entrada.filtro}|${entrada.q ?? ''}`} inicial={pagina} filtro={entrada.filtro} q={entrada.q}
        puedeGestionar={puedeGestionar} puedeOperar={ctx.access === 'FULL' || ctx.access === 'WARN'}
      />
    </main>
  )
}
