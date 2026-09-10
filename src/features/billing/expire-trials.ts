import { prisma } from '@/lib/prisma'

/**
 * Cierre de pruebas vencidas.
 *
 * ─── POR QUÉ HACE FALTA SI computeAccessLevel YA LO RESUELVE ─────────────
 *
 * Un trial vencido ya cae a READ_ONLY por cálculo en cada petición, así que
 * el acceso está correcto sin este job. Lo que NO está correcto sin él son
 * los datos: la suscripción sigue diciendo TRIALING para siempre, el panel
 * Super Admin cuenta como "en prueba" a cuentas abandonadas hace meses, y el
 * churn queda subestimado. El estado calculado gobierna el acceso; el estado
 * persistido gobierna las métricas, y este job los reconcilia.
 *
 * Es IDEMPOTENTE: solo toca filas que siguen en TRIALING con la fecha
 * pasada, así que correrlo cien veces seguidas tiene el mismo efecto que
 * correrlo una.
 */

export interface ExpireTrialsResult {
  expirados: number
  tenantIds: string[]
}

export async function expireTrials(
  now: Date = new Date(),
  limite = 500,
): Promise<ExpireTrialsResult> {
  const vencidas = await prisma.subscription.findMany({
    where: {
      status: 'TRIALING',
      trialEndsAt: { lt: now },
      // Una cuenta borrada no necesita que le cerremos nada.
      tenant: { deletedAt: null },
    },
    select: { id: true, tenantId: true, trialEndsAt: true },
    // Tope por ejecución: sin él, un arranque con miles de trials caducados
    // agotaría el tiempo de la función serverless y no cerraría ninguno.
    take: limite,
    orderBy: { trialEndsAt: 'asc' },
  })

  if (vencidas.length === 0) return { expirados: 0, tenantIds: [] }

  await prisma.$transaction([
    prisma.subscription.updateMany({
      // Se repiten las condiciones en el update: entre el SELECT y el UPDATE
      // un webhook pudo activar la cuenta, y cancelarla entonces sería
      // cortarle el servicio a alguien que acaba de pagar.
      where: {
        id: { in: vencidas.map((v) => v.id) },
        status: 'TRIALING',
        trialEndsAt: { lt: now },
      },
      data: { status: 'CANCELED', canceledAt: now },
    }),
    prisma.auditLog.createMany({
      data: vencidas.map((v) => ({
        tenantId: v.tenantId,
        // Sin actor: lo ejecuta el sistema, no una persona.
        action: 'trial.expired',
        entityType: 'Subscription',
        entityId: v.id,
        reason: 'Prueba gratuita vencida sin conversión',
        before: { status: 'TRIALING' },
        after: { status: 'CANCELED' },
      })),
    }),
  ])

  return { expirados: vencidas.length, tenantIds: vencidas.map((v) => v.tenantId) }
}
