import type { SubscriptionStatus } from '@/generated/prisma/enums'

/**
 * Métricas del SaaS. Función PURA para poder verificar el MRR sin BD — es el
 * número que mira el dueño del negocio para decidir, y un error aquí no lo
 * detecta nadie hasta que las cuentas no cuadran.
 *
 * ─── EL DINERO SE SUMA EN CÉNTIMOS ───────────────────────────────────────
 *
 * Sumar 49.90 + 99.90 + 199.90 en coma flotante da 349.69999999999993. Con
 * cien tenants la deriva es visible en el dashboard. Se opera en enteros y se
 * convierte a la unidad monetaria solo al final.
 */

export interface TenantMetricRow {
  status: SubscriptionStatus
  /** Kill switch del Super Admin, independiente del estado de pago. */
  isActive: boolean
  /** Precio mensual del plan, como string decimal ("99.00"). */
  priceMonthly: string
  createdAt: Date
  canceledAt: Date | null
}

export interface SaasMetrics {
  /** Ingreso recurrente mensual, en la unidad monetaria (no céntimos). */
  mrr: number
  /** Ingreso medio por cuenta que paga. */
  arpu: number
  totalTenants: number
  active: number
  trialing: number
  pastDue: number
  canceled: number
  /** Suspendidos a mano por el Super Admin. */
  suspended: number
  newLast30Days: number
  canceledLast30Days: number
  /** Cancelaciones sobre la base que pagaba hace 30 días, en porcentaje. */
  churnRate: number
}

function centimos(precio: string): number {
  const n = Number(precio)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

export function computeSaasMetrics(
  rows: TenantMetricRow[],
  now: Date = new Date(),
): SaasMetrics {
  const hace30 = new Date(now.getTime() - 30 * 86_400_000)

  let mrrCentimos = 0
  let active = 0
  let trialing = 0
  let pastDue = 0
  let canceled = 0
  let suspended = 0
  let newLast30Days = 0
  let canceledLast30Days = 0

  for (const r of rows) {
    if (r.createdAt >= hace30) newLast30Days++
    if (r.canceledAt && r.canceledAt >= hace30) canceledLast30Days++
    if (!r.isActive) suspended++

    switch (r.status) {
      case 'ACTIVE':
        // Un tenant suspendido a mano NO cuenta para el MRR aunque su
        // suscripción siga ACTIVE en Stripe: no está usando el servicio y su
        // cobro es lo primero que se va a disputar.
        if (r.isActive) {
          active++
          mrrCentimos += centimos(r.priceMonthly)
        }
        break
      case 'TRIALING':
        trialing++
        break
      case 'PAST_DUE':
        // La mora NO suma al MRR: ese dinero todavía no ha entrado, y
        // contarlo infla la métrica justo cuando peor va el negocio.
        pastDue++
        break
      case 'CANCELED':
        canceled++
        break
    }
  }

  const baseHace30 = active + canceledLast30Days

  return {
    mrr: mrrCentimos / 100,
    arpu: active > 0 ? Math.round(mrrCentimos / active) / 100 : 0,
    totalTenants: rows.length,
    active,
    trialing,
    pastDue,
    canceled,
    suspended,
    newLast30Days,
    canceledLast30Days,
    churnRate: baseHace30 > 0 ? Math.round((canceledLast30Days / baseHace30) * 1000) / 10 : 0,
  }
}
