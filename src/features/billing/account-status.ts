import type { SubscriptionStatus } from '@/generated/prisma/enums'
import type { AccessLevel } from '@/lib/tenant-context'

/**
 * Estado de cuenta para el banner del dashboard (§5.2).
 *
 * Función PURA: recibe la suscripción y devuelve exactamente qué decirle al
 * usuario. Separarla de la consulta permite probar cada escalón del aviso
 * —trial holgado, trial que expira mañana, mora, solo lectura— sin BD.
 */

export type BannerTone = 'info' | 'warn' | 'stop'

export interface AccountBanner {
  tone: BannerTone
  title: string
  body: string
  /** Etiqueta del botón; null si no procede ofrecer pago. */
  cta: string | null
  /** Días restantes cuando aplique, para que la UI pueda destacarlos. */
  daysLeft?: number
}

export interface AccountSnapshot {
  status: SubscriptionStatus
  access: AccessLevel
  trialEndsAt: Date | null
  pastDueSince: Date | null
  graceDays: number
  planName: string | null
}

function dias(desde: Date, hasta: Date): number {
  return Math.ceil((hasta.getTime() - desde.getTime()) / 86_400_000)
}

/**
 * Devuelve `null` cuando no hay nada que decir. Un banner permanente que
 * repite "todo bien" enseña al usuario a ignorar la franja superior, y el día
 * que de verdad avise algo importante ya nadie la lee.
 */
export function getAccountBanner(
  snap: AccountSnapshot,
  now: Date = new Date(),
): AccountBanner | null {
  if (snap.access === 'BLOCKED') {
    return {
      tone: 'stop',
      title: 'Cuenta suspendida',
      body: 'Escríbenos para resolverlo.',
      cta: null,
    }
  }

  if (snap.access === 'READ_ONLY') {
    const motivo =
      snap.status === 'CANCELED'
        ? 'Tu suscripción está cancelada.'
        : snap.status === 'TRIALING'
          ? 'Tu prueba gratuita terminó.'
          : 'Tu suscripción está vencida.'

    return {
      tone: 'stop',
      title: 'Solo lectura',
      body: `${motivo} Puedes consultar tu información, pero no registrar movimientos ni ventas.`,
      cta: 'Activar mi plan',
    }
  }

  if (snap.status === 'PAST_DUE' && snap.pastDueSince) {
    const limite = new Date(snap.pastDueSince.getTime() + snap.graceDays * 86_400_000)
    const restantes = Math.max(dias(now, limite), 0)
    return {
      tone: 'warn',
      title: 'Pago pendiente',
      body:
        restantes > 0
          ? `No pudimos cobrar tu suscripción. Te quedan ${restantes} ${restantes === 1 ? 'día' : 'días'} antes de pasar a solo lectura.`
          : 'No pudimos cobrar tu suscripción. Regulariza para seguir operando.',
      cta: 'Actualizar pago',
      daysLeft: restantes,
    }
  }

  if (snap.status === 'TRIALING' && snap.trialEndsAt) {
    const restantes = Math.max(dias(now, snap.trialEndsAt), 0)

    // Solo se avisa en la recta final. Molestar desde el día uno de una
    // prueba de catorce días es la forma más rápida de que el banner se
    // vuelva invisible.
    if (restantes > 5) return null

    return {
      tone: restantes <= 2 ? 'warn' : 'info',
      title:
        restantes === 0
          ? 'Tu prueba termina hoy'
          : `Te ${restantes === 1 ? 'queda 1 día' : `quedan ${restantes} días`} de prueba`,
      body: snap.planName
        ? `Activa el plan ${snap.planName} para no interrumpir tu operación.`
        : 'Activa tu plan para no interrumpir tu operación.',
      cta: 'Activar mi plan',
      daysLeft: restantes,
    }
  }

  return null
}
