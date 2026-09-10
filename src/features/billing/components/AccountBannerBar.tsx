import Link from 'next/link'
import { getDashboardAccountState } from '../queries'
import { CheckoutButton } from './CheckoutButton'
import { getAvailableGateways } from '../actions'
import { ROUTES } from '@/lib/route-access'

const TONOS = {
  info: 'border-industrial-600/40 bg-industrial-50 text-industrial-900 dark:bg-industrial-950 dark:text-industrial-100',
  warn: 'border-stock-low/40 bg-stock-low-soft text-stock-low',
  stop: 'border-stock-out/40 bg-stock-out-soft text-stock-out',
} as const

/**
 * Banner persistente de estado de cuenta (§5.2).
 *
 * Se renderiza en el servidor dentro del layout, así que aparece en todas las
 * pantallas del dashboard sin que cada página tenga que acordarse de pedirlo.
 */
export async function AccountBannerBar() {
  const { banner, planCode, canManageBilling } = await getDashboardAccountState()

  if (!banner) return null

  // Si no hay ninguna pasarela configurada, el CTA llevaría a una pantalla
  // que no puede cobrar. Mejor mandar a facturación, donde se explica.
  const gateways = await getAvailableGateways()
  const puedePagar = gateways.stripe || gateways.mercadopago

  return (
    <div
      role="status"
      className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 ${TONOS[banner.tone]}`}
    >
      <div className="min-w-0">
        <p className="text-sm font-bold">{banner.title}</p>
        <p className="text-sm">{banner.body}</p>
      </div>

      {banner.cta && canManageBilling && planCode && puedePagar ? (
        <CheckoutButton planCode={planCode} label={banner.cta} />
      ) : banner.cta ? (
        // El almacenero no puede pagar, pero sí avisar a quien sí puede.
        <span className="text-sm font-semibold">Avisa al dueño de la cuenta.</span>
      ) : (
        <Link href={ROUTES.billing} className="text-sm font-bold underline">
          Ver detalles
        </Link>
      )}
    </div>
  )
}
