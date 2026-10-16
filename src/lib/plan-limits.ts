import type { TenantPrismaClient } from './tenant-prisma'
import { BusinessError } from './errors'

/**
 * Límites de plan, en un solo sitio.
 *
 * ─── POR QUÉ CENTRALIZADO ────────────────────────────────────────────────
 *
 * El límite tiene DOS fuentes: `Tenant.plan` (una caché) y
 * `Subscription.plan` (lo que el webhook del proveedor de pagos mantiene al
 * día). La segunda manda. Cada sitio que comprobara un límite por su cuenta
 * tendría que recordar ese orden, y el día que uno lo olvidara, un cliente
 * que subió de plan seguiría topado con los límites del anterior —o peor, uno
 * que bajó de plan seguiría disfrutando de los de antes.
 *
 * `null` significa ILIMITADO, no cero. Confundir los dos es cómo se bloquea
 * entero al plan más caro.
 */

export type LimitKey = 'maxUsers' | 'maxBranches' | 'maxWarehouses' | 'maxProducts'

const SELECT_LIMITES = {
  maxUsers: true,
  maxBranches: true,
  maxWarehouses: true,
  maxProducts: true,
  name: true,
} as const

export interface PlanVigente {
  name: string
  maxUsers: number | null
  maxBranches: number | null
  maxWarehouses: number | null
  maxProducts: number | null
}

/** Plan que realmente aplica: el de la suscripción si existe, si no el del tenant. */
export async function planVigente(db: TenantPrismaClient): Promise<PlanVigente | null> {
  const tenant = await db.tenant.findFirstOrThrow({
    select: {
      plan: { select: SELECT_LIMITES },
      subscription: { select: { plan: { select: SELECT_LIMITES } } },
    },
  })
  return tenant.subscription?.plan ?? tenant.plan ?? null
}

/**
 * Frena la creación si el plan ya está al tope.
 *
 * `contar` se recibe como función y no como número para que la cuenta se
 * haga DENTRO de la transacción que va a crear el recurso. Contar antes y
 * crear después deja una ventana en la que dos peticiones simultáneas pasan
 * las dos: cada una ve N < límite y ambas crean, dejando N+2.
 */
export async function exigirLimitePlan(
  db: TenantPrismaClient,
  clave: LimitKey,
  contar: () => Promise<number>,
  etiqueta: { singular: string; plural: string },
): Promise<void> {
  const plan = await planVigente(db)
  const limite = plan?.[clave]
  if (limite == null) return // sin plan o ilimitado

  const actuales = await contar()
  if (actuales >= limite) {
    throw new BusinessError(
      'PLAN_LIMIT_REACHED',
      `Tu plan ${plan!.name} permite ${limite} ` +
        `${limite === 1 ? etiqueta.singular : etiqueta.plural}. ` +
        'Mejora de plan para añadir más.',
      { limite, actuales },
    )
  }
}
