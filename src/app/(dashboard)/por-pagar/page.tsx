import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/session'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { informeDePorPagar } from '@/features/por-pagar/informes'
import { puedeVerPorPagar } from '@/features/por-pagar/permisos'
import { TablaPorPagar } from '@/features/por-pagar/components/TablaPorPagar'
import { puedeVerProveedores } from '@/features/proveedores/permisos'

export const dynamic = 'force-dynamic'

/**
 * Cuentas por pagar: la antigüedad de la deuda con los proveedores. La ve quien ve proveedores y el contador (`reportes.ver`); el nombre
 * lleva a la ficha solo si quien mira puede abrirla (donde se registra el pago). Solo lectura.
 */
export default async function PorPagarPage() {
  const ctx = await requireTenantContext()
  if (!puedeVerPorPagar(ctx)) notFound()
  const informe = await informeDePorPagar(getTenantPrisma(ctx), ctx)

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Por pagar</h1>
        <p className="text-sm text-ink-muted">A quién le debes, cuánto y desde hace cuánto.</p>
      </header>
      <TablaPorPagar informe={informe} enlazarFicha={puedeVerProveedores(ctx)} />
    </main>
  )
}
