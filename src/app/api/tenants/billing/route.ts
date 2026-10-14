import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireSuperAdmin } from '@/lib/session'
import { checkSameOrigin } from '@/lib/csrf'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { isBusinessError } from '@/lib/errors'
import { changeTenantPlanSchema, extendTrialSchema } from '@/features/superadmin/schemas'
import { changeTenantPlan, extendTrial } from '@/features/superadmin/billing-service'

/**
 * PATCH /api/tenants/billing — gestión manual de la suscripción de un cliente.
 *
 * Dos operaciones, discriminadas por el campo `action`:
 *   change-plan    → mueve al cliente a otro plan
 *   extend-trial   → le regala N días de prueba
 *
 * Un solo endpoint y no dos rutas porque comparten absolutamente todo el
 * preámbulo: CSRF, rol, límite de ritmo y motivo obligatorio. Partirlo
 * duplicaría ese preámbulo, que es precisamente la parte en la que un
 * descuido se convierte en un agujero.
 */
export const dynamic = 'force-dynamic'

/**
 * Se usa `.extend()` y no `.and()`: `discriminatedUnion` de Zod 4 necesita
 * ver el campo discriminante en un ZodObject plano, y una intersección se lo
 * oculta —el error que da es sobre `propValues`, nada evidente—.
 */
const cuerpoSchema = z.discriminatedUnion('action', [
  changeTenantPlanSchema.extend({ action: z.literal('change-plan') }),
  extendTrialSchema.extend({ action: z.literal('extend-trial') }),
])

export async function PATCH(req: NextRequest) {
  const origen = checkSameOrigin(req.headers)
  if (!origen.ok) {
    return NextResponse.json({ error: 'forbidden origin' }, { status: 403 })
  }

  let admin
  try {
    admin = await requireSuperAdmin()
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const limite = await checkRateLimit(`billing:${clientIp(req.headers)}`, {
    limit: 30,
    windowSeconds: 600,
  })
  if (!limite.ok) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  let cuerpo: unknown
  try {
    cuerpo = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const parsed = cuerpoSchema.safeParse(cuerpo)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'validation',
        message: 'Revisa los datos. El motivo es obligatorio.',
        fields: z.flattenError(parsed.error).fieldErrors,
      },
      { status: 400 },
    )
  }

  const actor = { id: admin.id, email: admin.email }

  try {
    if (parsed.data.action === 'change-plan') {
      const r = await changeTenantPlan(parsed.data, actor)
      return NextResponse.json(
        {
          planName: r.planName,
          // La UI avisa de esto: el cobro en la pasarela NO se movió.
          gatewaySyncPending: !r.cobroSincronizado,
        },
        { status: 200 },
      )
    }

    const r = await extendTrial(parsed.data, actor)
    return NextResponse.json({ trialEndsAt: r.trialEndsAt.toISOString() }, { status: 200 })
  } catch (e) {
    if (isBusinessError(e)) {
      const status = e.code === 'DUPLICATE_CODE' ? 409 : 400
      return NextResponse.json({ error: e.code, message: e.message }, { status })
    }
    console.error('[api/tenants/billing] falló', {
      actor: admin.id,
      action: parsed.data.action,
      error: e instanceof Error ? e.message : e,
    })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
