import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireSuperAdmin } from '@/lib/session'
import { checkSameOrigin } from '@/lib/csrf'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { isBusinessError } from '@/lib/errors'
import { createTenantBySuperAdminSchema } from '@/features/onboarding/schemas'
import { createTenantBySuperAdmin } from '@/features/superadmin/tenant-service'
import { getSuperAdminDashboard } from '@/features/superadmin/queries'

/**
 * GET  /api/tenants  — lista de clientes con su estado.
 * POST /api/tenants  — crea un cliente nuevo y su usuario OWNER.
 *
 * Solo SUPERADMIN. Sustituye al trabajo manual de crear filas a mano en el
 * proveedor de base de datos.
 *
 * ─── POR QUÉ 404 Y NO 401/403 ────────────────────────────────────────────
 *
 * Coherente con la política del panel (§5.3): un 403 confirma que el recurso
 * existe y que hay algo que proteger. El 404 no dice nada. Quien no sea
 * SUPERADMIN —incluido quien no haya entrado— recibe lo mismo que si la ruta
 * no existiera.
 *
 * El precio es que una sesión caducada también da 404; la UI lo traduce a
 * "vuelve a iniciar sesión" en lugar de mostrar el código crudo.
 *
 * ─── POR QUÉ UN ROUTE HANDLER Y NO UNA SERVER ACTION ─────────────────────
 *
 * El resto de mutaciones internas del proyecto van por Server Actions. Aquí
 * un endpoint HTTP aporta algo concreto: permite dar de alta clientes desde
 * un script o desde una herramienta externa sin pasar por el navegador, que
 * es exactamente lo que se pidió. El coste es que hay que escribir a mano la
 * protección CSRF que las Server Actions traen de serie — de eso se encarga
 * `checkSameOrigin`.
 */

export const dynamic = 'force-dynamic'

const NO_EXISTE = () => NextResponse.json({ error: 'not found' }, { status: 404 })

export async function GET() {
  let admin
  try {
    admin = await requireSuperAdmin()
  } catch {
    return NO_EXISTE()
  }

  try {
    const { metrics, tenants } = await getSuperAdminDashboard()
    return NextResponse.json({ metrics, tenants }, { status: 200 })
  } catch (e) {
    console.error('[api/tenants] GET falló', {
      actor: admin.id,
      error: e instanceof Error ? e.message : e,
    })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  // 1. CSRF antes que nada: si la petición no es de confianza, no se mira
  //    siquiera quién la manda.
  const origen = checkSameOrigin(req.headers)
  if (!origen.ok) {
    console.warn('[api/tenants] POST rechazado por origen', { reason: origen.reason })
    return NextResponse.json({ error: 'forbidden origin' }, { status: 403 })
  }

  // 2. Autorización.
  let admin
  try {
    admin = await requireSuperAdmin()
  } catch {
    return NO_EXISTE()
  }

  // 3. Límite de ritmo. Crear tenants escribe cinco tablas por llamada; un
  //    script con la sesión del superadmin podría llenar la base en un bucle.
  const limite = await checkRateLimit(`tenants:${clientIp(req.headers)}`, {
    limit: 20,
    windowSeconds: 600,
  })
  if (!limite.ok) {
    return NextResponse.json(
      { error: 'rate limited', retryAfterSeconds: limite.retryAfterSeconds },
      { status: 429, headers: { 'Retry-After': String(limite.retryAfterSeconds) } },
    )
  }

  // 4. Cuerpo.
  let cuerpo: unknown
  try {
    cuerpo = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const parsed = createTenantBySuperAdminSchema.safeParse(cuerpo)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'validation',
        message: 'Revisa los datos del formulario.',
        fields: z.flattenError(parsed.error).fieldErrors,
      },
      { status: 400 },
    )
  }

  // 5. Alta.
  try {
    const r = await createTenantBySuperAdmin(parsed.data, {
      id: admin.id,
      email: admin.email,
      role: 'SUPERADMIN',
    })

    return NextResponse.json(
      {
        tenantId: r.tenantId,
        slug: r.slug,
        userId: r.userId,
        planName: r.planName,
        trialEndsAt: r.trialEndsAt.toISOString(),
        ownerEmail: r.ownerEmail,
        // Viaja UNA sola vez y nunca se persiste en claro. Si se pierde, hay
        // que generar otra: no existe forma de recuperarla.
        generatedPassword: r.generatedPassword,
      },
      { status: 201 },
    )
  } catch (e) {
    if (isBusinessError(e)) {
      // Correo repetido o plan inválido: es culpa del dato, no del servidor.
      const status = e.code === 'DUPLICATE_CODE' ? 409 : 400
      return NextResponse.json({ error: e.code, message: e.message }, { status })
    }

    console.error('[api/tenants] POST falló', {
      actor: admin.id,
      // El correo del cliente NO se loguea: es dato personal de un tercero.
      error: e instanceof Error ? { name: e.name, message: e.message } : e,
    })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
