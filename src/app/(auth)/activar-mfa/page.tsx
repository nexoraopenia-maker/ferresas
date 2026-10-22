import { redirect } from 'next/navigation'
import { requireIdentidad } from '@/lib/session'
import { ROUTES } from '@/lib/route-access'
import { estadoMfa } from '@/features/seguridad/mfa-service'
import { ActivarMfa } from '@/features/seguridad/components/ActivarMfa'

export const dynamic = 'force-dynamic'

/**
 * Activación del segundo factor. Vive FUERA del panel a propósito: quien tiene
 * un rol que lo exige no puede entrar al panel hasta activarlo, y esta es la
 * puerta por la que sí puede pasar.
 */
export default async function ActivarMfaPage() {
  let userId: string
  try {
    userId = (await requireIdentidad()).userId
  } catch {
    redirect(`${ROUTES.login}?motivo=sesion`)
  }
  const estado = await estadoMfa(userId)
  if (estado.activo) redirect(ROUTES.dashboard)

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 p-4">
      <header>
        <h1 className="text-2xl font-extrabold text-ink">Verificación en dos pasos</h1>
        <p className="text-sm text-ink-muted">
          {estado.obligatorio
            ? 'Tu rol puede borrar datos y cambiar la configuración, así que exige un segundo paso al entrar.'
            : 'Protege tu cuenta con un código de tu teléfono.'}
        </p>
      </header>
      <ActivarMfa destino={ROUTES.dashboard} />
    </main>
  )
}
