import Link from 'next/link'
import { getPublicPlans } from './actions'
import { RegisterForm, type PlanOption } from './RegisterForm'

/**
 * Dinámica a propósito. Sin esto, Next la prerenderiza en build y consulta la
 * tabla Plan al compilar: los precios quedarían horneados en el bundle
 * —cambiarlos exigiría un despliegue— y el build fallaría en cualquier CI que
 * no tenga acceso a la base de producción.
 */
export const dynamic = 'force-dynamic'

export default async function RegistroPage() {
  const plans = await getPublicPlans()

  // Decimal de Prisma no cruza el límite servidor→cliente: se serializa aquí.
  const options: PlanOption[] = plans.map((p) => ({
    code: p.code,
    name: p.name,
    description: p.description,
    priceMonthly: p.priceMonthly.toFixed(2),
    currency: p.currency,
    trialDays: p.trialDays,
    maxProducts: p.maxProducts,
  }))

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <header>
        <h1 className="text-3xl font-bold text-ink">Crea tu cuenta</h1>
        <p className="mt-1 text-ink-muted">
          Empieza a controlar tu inventario hoy. Sin tarjeta.
        </p>
      </header>

      <RegisterForm plans={options} />

      <p className="text-center text-sm text-ink-muted">
        ¿Ya tienes cuenta?{' '}
        <Link href="/login" className="font-semibold text-industrial-700 underline dark:text-industrial-400">
          Inicia sesión
        </Link>
      </p>
    </main>
  )
}
