import Link from 'next/link'
import { logoutAction } from '../(auth)/actions'
import { AccountBannerBar } from '@/features/billing/components/AccountBannerBar'
import { ImpersonationBanner } from '@/features/superadmin/components/ImpersonationBanner'
import { ROUTES } from '@/lib/route-access'

/**
 * Layout del área de cliente.
 *
 * El banner de estado (§5.2) lo resuelve AccountBannerBar con su propia
 * consulta. Antes se pintaba desde la cabecera `x-account-notice` que ponía
 * el proxy; se cambió porque el aviso necesita días restantes y nombre de
 * plan, y mantener dos fuentes para el mismo mensaje termina en que divergen.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      {/* El aviso de soporte va PRIMERO y por encima del de facturación: si el
          superadmin ve "solo lectura" sin saber que está impersonando, creerá
          que el cliente tiene un problema de suscripción que no tiene. */}
      <ImpersonationBanner />
      <AccountBannerBar />

      <div className="flex-1">{children}</div>

      <nav className="safe-bottom sticky bottom-0 flex items-center justify-between border-t border-hairline bg-surface px-4 pt-2">
        <Link href={ROUTES.dashboard} className="h-touch px-3 font-semibold text-ink">
          Inventario
        </Link>
        <Link href={ROUTES.billing} className="h-touch px-3 font-semibold text-ink">
          Facturación
        </Link>
        <form action={logoutAction}>
          <button type="submit" className="h-touch px-3 font-semibold text-ink-muted">
            Salir
          </button>
        </form>
      </nav>
    </div>
  )
}
