import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireSuperAdmin } from '@/lib/session'
import { checkSameOrigin } from '@/lib/csrf'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { isBusinessError } from '@/lib/errors'
import { changePasswordSchema } from '@/features/superadmin/schemas'
import { changeSuperAdminPassword } from '@/features/superadmin/account-service'

/**
 * POST /api/account/password — cambia la contraseña del Super Admin.
 *
 * Al terminar, TODAS las sesiones emitidas antes quedan invalidadas, incluida
 * la que hizo la llamada: el navegador tendrá que volver a entrar. Es lo
 * correcto —si cambias la contraseña por sospecha de robo, no quieres que la
 * sesión del intruso siga viva— y la UI lo avisa antes de ejecutar.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const origen = checkSameOrigin(req.headers)
  if (!origen.ok) {
    console.warn('[api/account/password] rechazado por origen', { reason: origen.reason })
    return NextResponse.json({ error: 'forbidden origin' }, { status: 403 })
  }

  let admin
  try {
    admin = await requireSuperAdmin()
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  // Límite estrecho: este endpoint comprueba la contraseña actual, así que es
  // un oráculo para adivinarla si se deja sin tope.
  const limite = await checkRateLimit(`pwd:${clientIp(req.headers)}`, {
    limit: 5,
    windowSeconds: 900,
  })
  if (!limite.ok) {
    return NextResponse.json(
      { error: 'rate limited', retryAfterSeconds: limite.retryAfterSeconds },
      { status: 429, headers: { 'Retry-After': String(limite.retryAfterSeconds) } },
    )
  }

  let cuerpo: unknown
  try {
    cuerpo = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const parsed = changePasswordSchema.safeParse(cuerpo)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'validation',
        message: 'Revisa los datos.',
        fields: z.flattenError(parsed.error).fieldErrors,
      },
      { status: 400 },
    )
  }

  try {
    const { changedAt } = await changeSuperAdminPassword(admin.id, parsed.data)
    return NextResponse.json(
      {
        changedAt: changedAt.toISOString(),
        sessionsRevoked: true,
        message: 'Contraseña actualizada. Vuelve a iniciar sesión.',
      },
      { status: 200 },
    )
  } catch (e) {
    if (isBusinessError(e)) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 400 })
    }
    console.error('[api/account/password] falló', {
      actor: admin.id,
      error: e instanceof Error ? e.name : 'desconocido',
    })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
