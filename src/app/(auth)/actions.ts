'use server'

import { cookies, headers } from 'next/headers'
import { AuthError } from 'next-auth'
import { auth, signIn, signOut } from '@/auth'
import { OPERATOR_COOKIE } from '@/lib/operator-token'
import { credentialsSchema } from '@/lib/credentials'
import { ROUTES } from '@/lib/route-access'
import { checkRateLimit, clientIp, RATE_RULES } from '@/lib/rate-limit'
import type { ActionResult } from '@/lib/errors'

/**
 * Login. Devuelve un resultado tipado en vez de lanzar, igual que el resto
 * de Server Actions (§6.7).
 */
export async function loginAction(input: {
  email: string
  password: string
  /** Segundo factor, cuando la cuenta lo tiene. */
  codigo?: string
  callbackUrl?: string
}): Promise<ActionResult<{ redirectTo: string }>> {
  // bcrypt(12) ya hace lenta la fuerza bruta contra UNA cuenta, pero no frena
  // a quien prueba las veinte contraseñas más comunes contra muchas cuentas
  // distintas. El límite va por IP, que es lo que comparte ese ataque.
  const ip = clientIp(await headers())
  const limite = await checkRateLimit(`login:${ip}`, RATE_RULES.login)

  if (!limite.ok) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      message: 'Demasiados intentos. Espera unos minutos y vuelve a probar.',
    }
  }

  const parsed = credentialsSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Revisa tu correo y contraseña.',
    }
  }

  try {
    await signIn('credentials', {
      email: parsed.data.email,
      password: parsed.data.password,
      codigo: parsed.data.codigo ?? '',
      redirect: false,
    })
  } catch (e) {
    if (e instanceof AuthError) {
      // Códigos del segundo factor: solo existen si la contraseña ya era correcta.
      const codigo = (e as { code?: string }).code
      if (codigo === 'mfa_required') {
        return { ok: false, code: 'MFA_REQUIRED', message: 'Escribe el código de tu app autenticadora.' }
      }
      if (codigo === 'mfa_invalid') {
        return { ok: false, code: 'UNAUTHENTICATED', message: 'El código no es correcto o ya se usó.' }
      }
      if (codigo === 'mfa_locked') {
        return { ok: false, code: 'RATE_LIMITED', message: 'Demasiados intentos con el código. Espera 15 minutos y vuelve a probar.' }
      }
      // Mensaje deliberadamente idéntico para credenciales malas y usuario
      // inexistente: distinguirlos permitiría enumerar cuentas del SaaS.
      return {
        ok: false,
        code: 'UNAUTHENTICATED',
        message: 'Correo o contraseña incorrectos.',
      }
    }
    throw e
  }

  // El destino real lo decide el proxy según rol y estado de cuenta; aquí
  // solo se propone uno.
  const destino = input.callbackUrl?.startsWith('/') ? input.callbackUrl : ROUTES.dashboard
  return { ok: true, data: { redirectTo: destino } }
}

export async function logoutAction() {
  // Se revoca el registro del dispositivo ANTES de borrar la cookie: así el JWT,
  // si alguien lo hubiera copiado, deja de valer.
  try {
    const sesion = await auth()
    const { cerrarSesionActual } = await import('@/features/seguridad/dispositivos')
    await cerrarSesionActual(sesion?.sid)
  } catch {
    /* cerrar sesión nunca debe fallar por esto */
  }
  ;(await cookies()).delete(OPERATOR_COOKIE)
  await signOut({ redirectTo: ROUTES.login })
}
