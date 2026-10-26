import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { informeDeCobranza, puedeVerCobranza } from '@/features/clientes/cobranza'
import { puedeVerClientes } from '@/features/clientes/service'
import { TablaCobranza } from '@/features/clientes/components/TablaCobranza'

export const dynamic = 'force-dynamic'

/**
 * Cobranza: la antigüedad de la deuda por cliente. La ve quien ve clientes y el contador (`reportes.ver`); el nombre lleva a la
 * ficha solo si quien mira puede abrirla. Solo lectura.
 */
export default async function CobranzaPage() {
  const ctx = await requireTenantContext()
  if (!puedeVerCobranza(ctx)) notFound()
  const informe = await informeDeCobranza(getTenantPrisma(ctx), ctx)

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Por cobrar</h1>
        <p className="text-sm text-ink-muted">Quién te debe, cuánto y desde hace cuánto.</p>
      </header>
      <TablaCobranza informe={informe} enlazarFicha={puedeVerClientes(ctx)} />
    </main>
  )
}
