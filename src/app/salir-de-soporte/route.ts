import { endImpersonation } from '@/features/superadmin/actions'

/**
 * Salida de la sesión de soporte.
 *
 * Es un Route Handler y no una página para poder invocarse desde un formulario
 * de cualquier pantalla del dashboard. `endImpersonation` termina en un
 * redirect, así que esta función nunca retorna normalmente.
 */
export async function POST() {
  await endImpersonation()
}

export async function GET() {
  await endImpersonation()
}
