import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/diagnostics?key=$CRON_SECRET — estado de la configuración.
 *
 * Existe porque depurar producción leyendo logs de Vercel es lento: hay que
 * provocar el fallo, encontrar la invocación y leer. Esto responde de una vez
 * qué está mal.
 *
 * ─── QUÉ NO DEVUELVE ─────────────────────────────────────────────────────
 *
 * Ningún valor secreto. Solo presencia y longitud de cada variable, y
 * booleanos sobre el estado de la base. Aun así va protegido: confirmar a
 * cualquiera que "la base no responde" le dibuja el mapa de la
 * infraestructura.
 *
 * Si CRON_SECRET no está configurado, en producción responde 404 — falla
 * cerrado antes que convertirse en un endpoint público de información.
 */
export const dynamic = 'force-dynamic'

function autorizado(req: NextRequest): boolean {
  const secreto = process.env.CRON_SECRET
  if (!secreto) return process.env.NODE_ENV !== 'production'

  const dado =
    req.nextUrl.searchParams.get('key') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    ''

  const a = Buffer.from(dado)
  const b = Buffer.from(secreto)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Presencia y tamaño, nunca el valor. */
function variable(nombre: string) {
  const v = process.env[nombre]
  return v ? { presente: true, caracteres: v.length } : { presente: false }
}

export async function GET(req: NextRequest) {
  if (!autorizado(req)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const entorno = {
    vercelEnv: process.env.VERCEL_ENV ?? null,
    nodeEnv: process.env.NODE_ENV,
    AUTH_SECRET: variable('AUTH_SECRET'),
    NEXTAUTH_SECRET: variable('NEXTAUTH_SECRET'),
    AUTH_URL: process.env.AUTH_URL ?? null,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? null,
    APP_URL: process.env.APP_URL ?? null,
    DATABASE_URL: variable('DATABASE_URL'),
    DIRECT_URL: variable('DIRECT_URL'),
    STRIPE_SECRET_KEY: variable('STRIPE_SECRET_KEY'),
    MERCADOPAGO_ACCESS_TOKEN: variable('MERCADOPAGO_ACCESS_TOKEN'),
    CRON_SECRET: variable('CRON_SECRET'),
  }

  // Comprobación de la cadena de conexión SIN revelar credenciales: solo si
  // lleva los parámetros que hacen falta en serverless.
  const pooled = process.env.DATABASE_URL ?? ''
  const directa = process.env.DIRECT_URL ?? ''
  const conexion = {
    pooledTienePgbouncer: pooled.includes('pgbouncer=true'),
    pooledTieneConnectionLimit: /connection_limit=\d+/.test(pooled),
    pooledUsaPooler: pooled.includes('-pooler'),
    // La directa NO debe ir por el pooler: `prisma migrate` falla si lo hace.
    directaUsaPooler: directa.includes('-pooler'),
    directaTieneSslmode: directa.includes('sslmode='),
  }

  let baseDatos: Record<string, unknown>
  const t0 = Date.now()
  try {
    const [migraciones, planes, superadmins, tenants] = await Promise.all([
      prisma.$queryRawUnsafe<{ migration_name: string }[]>(
        'SELECT migration_name FROM _prisma_migrations ORDER BY finished_at',
      ),
      prisma.plan.count({ where: { isActive: true } }),
      prisma.user.count({ where: { role: 'SUPERADMIN', isActive: true } }),
      prisma.tenant.count({ where: { deletedAt: null } }),
    ])

    baseDatos = {
      alcanzable: true,
      latenciaMs: Date.now() - t0,
      migracionesAplicadas: migraciones.map((m) => m.migration_name),
      planesActivos: planes,
      superadminsActivos: superadmins,
      tenants,
    }
  } catch (e) {
    baseDatos = {
      alcanzable: false,
      latenciaMs: Date.now() - t0,
      // El mensaje de Prisma no lleva la contraseña, pero sí el host: se
      // recorta a lo justo para identificar el tipo de fallo.
      error: e instanceof Error
        ? `${e.name}: ${(e.message.split('\n')[0] ?? e.message).slice(0, 160)}`
        : 'desconocido',
    }
  }

  const problemas: string[] = []
  if (!entorno.AUTH_SECRET.presente && !entorno.NEXTAUTH_SECRET.presente) {
    problemas.push('Falta AUTH_SECRET: las sesiones no se pueden firmar ni verificar.')
  }
  if (!entorno.DATABASE_URL.presente) {
    problemas.push('Falta DATABASE_URL.')
  }
  if (baseDatos.alcanzable === false) {
    problemas.push('La base de datos no responde: todo login fallará como si la contraseña fuera incorrecta.')
  }
  if (baseDatos.superadminsActivos === 0) {
    problemas.push('No hay ningún SUPERADMIN activo: corre `npm run db:seed`.')
  }
  if (pooled && !conexion.pooledTienePgbouncer) {
    problemas.push('DATABASE_URL sin pgbouncer=true: en serverless se agotan las conexiones.')
  }
  if (pooled && !conexion.pooledTieneConnectionLimit) {
    problemas.push('DATABASE_URL sin connection_limit=1: cada invocación abrirá su propio pool.')
  }
  if (directa && conexion.directaUsaPooler) {
    problemas.push('DIRECT_URL apunta al pooler: `prisma migrate deploy` fallará en el build.')
  }
  const appUrl = process.env.APP_URL?.trim()
  if (process.env.APP_URL !== undefined && !appUrl) {
    problemas.push(
      'APP_URL está definida pero VACÍA. Las URLs de retorno de Stripe y ' +
        'MercadoPago deben ser absolutas: bórrala o ponle el dominio completo.',
    )
  } else if (appUrl && !/^https?:\/\//.test(appUrl)) {
    problemas.push('APP_URL no empieza por http(s)://: las pasarelas la rechazarán.')
  }

  if (entorno.AUTH_URL || entorno.NEXTAUTH_URL) {
    problemas.push(
      'AUTH_URL/NEXTAUTH_URL está fijada. Con trustHost:true no hace falta, y si no coincide ' +
        'EXACTAMENTE con el dominio desde el que entras, el login rebota al formulario.',
    )
  }

  return NextResponse.json(
    { ok: problemas.length === 0, problemas, entorno, conexion, baseDatos },
    { status: 200 },
  )
}
