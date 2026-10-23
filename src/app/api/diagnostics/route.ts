import { NextResponse, type NextRequest } from 'next/server'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { hayClaveMaestra } from '@/lib/cifrado'
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
    /**
     * Región donde Vercel ejecuta la función.
     *
     * Importa porque cada consulta cruza la distancia entre esta región y la
     * de Neon, y una página hace varias. Si no coinciden, cada ida y vuelta
     * paga ese trayecto de más, multiplicado por el número de consultas.
     */
    vercelRegion: process.env.VERCEL_REGION ?? null,
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
    // Cifra las credenciales del PSE y los secretos del segundo factor. Solo presencia, nunca el valor.
    PSE_MASTER_KEY: { ...variable('PSE_MASTER_KEY'), validaComoClave: hayClaveMaestra() },
    PSE_MASTER_KEY_PREVIOUS: variable('PSE_MASTER_KEY_PREVIOUS'),
    // Secreto con el que el programador externo dispara el worker de la cola fiscal.
    FISCAL_WORKER_SECRET: variable('FISCAL_WORKER_SECRET'),
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
    const [
      migraciones, planes, superadmins, tenants,
      tenantsSinSucursal, usuariosSinSucursal,
      configFiscalPorAdmin, configFiscalTotal, accionesDeAdmin,
    ] = await Promise.all([
      /**
       * Se distingue ÉXITO de simple presencia.
       *
       * La consulta anterior contaba FILAS de _prisma_migrations. Prisma
       * inserta la fila al EMPEZAR y rellena `finished_at` al terminar, así
       * que una migración que falló a mitad deja su fila con `finished_at`
       * NULL y `logs` con el error — y se habría contado como aplicada.
       * Un falso verde justo en el momento en que el dato importa.
       *
       * `rolled_back_at` cubre el otro caso: una migración revertida a mano
       * con `prisma migrate resolve --rolled-back`.
       */
      prisma.$queryRawUnsafe<
        { migration_name: string; ok: boolean; rolled_back: boolean }[]
      >(
        `SELECT migration_name,
                (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS ok,
                (rolled_back_at IS NOT NULL) AS rolled_back
         FROM _prisma_migrations
         ORDER BY started_at`,
      ),
      prisma.plan.count({ where: { isActive: true } }),
      prisma.user.count({ where: { role: 'SUPERADMIN', isActive: true } }),
      prisma.tenant.count({ where: { deletedAt: null } }),
      /*
       * Invariantes de multi-sucursal que una migración exitosa NO prueba.
       *
       * El backfill de `branches` y de `warehouses.branchId` está protegido
       * por el SET NOT NULL: si hubiera dejado un hueco, la migración habría
       * abortado. Pero el INSERT en `user_branches` no tiene nada que lo
       * respalde — si insertara cero filas, la migración se reportaría
       * aplicada y correcta, y el dueño del negocio simplemente no podría
       * vender, porque `requireBranch` lo rechazaría.
       *
       * Son dos cuentas baratas y responden la única pregunta que importa
       * tras desplegar esto: ¿puede operar la gente?
       */
      prisma.tenant.count({ where: { deletedAt: null, branches: { none: {} } } }),
      prisma.user.count({
        where: { deletedAt: null, isActive: true, tenantId: { not: null }, branches: { none: {} } },
      }),
      /*
       * ¿Algún ADMINISTRADOR ha configurado alguna vez el correlativo inicial?
       *
       * La matriz de permisos de la fase B mueve `config.fiscal` a DUEÑO
       * exclusivamente, así que un ADMIN que hoy configure series dejaría de
       * poder. Hay que saberlo ANTES de desplegar ese cambio, no después de
       * que alguien se queje — y la única forma de saberlo es contar lo que
       * ya pasó, que es justo para lo que existe el AuditLog.
       */
      prisma.auditLog.count({
        where: { action: 'counter.startNumber', actorRole: 'ADMIN' },
      }),
      prisma.auditLog.count({ where: { action: 'counter.startNumber' } }),
      /*
       * Acciones de un ADMIN que la matriz de la fase B pasa a reservar al
       * DUEÑO. `counter.startNumber` era la que estaba sobre la mesa; al
       * mapear los 29 `hasRole` apareció otra de la misma clase
       * (`tenant.plan.change`).
       *
       * ⚠️ El CHECKOUT no aparece aquí porque NO SE AUDITA: ni
       * `createCheckoutSession` ni `createMercadoPagoCheckout` escriben en
       * AuditLog. Así que de esa acción no hay histórico que consultar, y
       * decir «0» sería confundir «no pasó» con «no se registró». Queda
       * anotado como deuda: una acción que mueve dinero del dueño debería
       * auditarse.
       *
       * Se agrupa por acción para poder decir CUÁL y CUÁNTAS, no solo que
       * «hay algunas».
       */
      prisma.auditLog.groupBy({
        by: ['action'],
        where: {
          actorRole: 'ADMIN',
          action: { in: ['counter.startNumber', 'tenant.plan.change'] },
        },
        _count: { _all: true },
      }),
    ])

    const aplicadas = migraciones.filter((m) => m.ok).map((m) => m.migration_name)
    // Fallidas o revertidas: existen en la tabla pero NO están aplicadas.
    const fallidas = migraciones.filter((m) => !m.ok).map((m) => m.migration_name)

    /**
     * Migraciones PENDIENTES: las que vienen en el repositorio y no están
     * en la base.
     *
     * Existe porque un `migrate deploy` que no se ejecuta es invisible: el
     * código se despliega, la columna no se crea, y el fallo aparece más
     * tarde como un error de runtime sin relación aparente. Compararlo a
     * mano cada vez no es un proceso, es un descuido esperando a ocurrir.
     */
    let pendientes: string[] = []
    try {
      const dir = join(process.cwd(), 'prisma', 'migrations')
      const enRepo = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
      pendientes = enRepo.filter((m) => !aplicadas.includes(m))
    } catch {
      // En el bundle serverless el directorio puede no viajar. No es un
      // fallo: simplemente no se puede comparar.
      pendientes = []
    }

    baseDatos = {
      alcanzable: true,
      latenciaMs: Date.now() - t0,
      migracionesAplicadas: aplicadas,
      migracionesPendientes: pendientes,
      migracionesFallidas: fallidas,
      planesActivos: planes,
      superadminsActivos: superadmins,
      tenants,
      tenantsSinSucursal,
      usuariosSinSucursal,
      /** Veces que un ADMIN configuró el correlativo inicial. Ver la nota arriba. */
      configFiscalPorAdmin,
      /** Total, de cualquier rol, para poner el anterior en contexto. */
      configFiscalTotal,
      /**
       * Acciones de ADMIN que la fase B reserva al DUEÑO, por acción.
       * NO incluye el checkout: no se audita (ver la nota arriba).
       */
      accionesDeAdminQueSeReservan: Object.fromEntries(
        (accionesDeAdmin as { action: string; _count: { _all: number } }[]).map((r) => [
          r.action,
          r._count._all,
        ]),
      ),
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
  const fall = baseDatos.migracionesFallidas
  if (Array.isArray(fall) && fall.length > 0) {
    problemas.push(
      `${fall.length} migración(es) FALLIDA(S) o revertida(s): ${fall.join(', ')}. ` +
        'El esquema quedó a medias. Resuélvelo con `prisma migrate resolve` ' +
        'antes de desplegar nada más.',
    )
  }

  const pend = baseDatos.migracionesPendientes
  if (Array.isArray(pend) && pend.length > 0) {
    problemas.push(
      `${pend.length} migración(es) SIN APLICAR: ${pend.join(', ')}. ` +
        'El código está desplegado pero el esquema no se movió. Revisa el log ' +
        'del build en Vercel: `prisma migrate deploy` no se ejecutó o falló.',
    )
  }
  if (typeof baseDatos.tenantsSinSucursal === 'number' && baseDatos.tenantsSinSucursal > 0) {
    problemas.push(
      `${baseDatos.tenantsSinSucursal} negocio(s) SIN NINGUNA SUCURSAL. ` +
        'No pueden emitir nada: la serie de los comprobantes sale de la ' +
        'sucursal. Revisa el backfill de la migración de sucursales.',
    )
  }
  if (typeof baseDatos.usuariosSinSucursal === 'number' && baseDatos.usuariosSinSucursal > 0) {
    problemas.push(
      `${baseDatos.usuariosSinSucursal} usuario(s) activo(s) sin sucursal asignada. ` +
        'No podrán vender ni mover stock hasta que un administrador se la asigne ' +
        'en /sucursales.',
    )
  }
  if (!hayClaveMaestra()) {
    problemas.push(
      'PSE_MASTER_KEY no está configurada o no es una clave válida (32 bytes en base64 o hexadecimal): ' +
        'no se pueden guardar las credenciales del proveedor de facturación ni activar el segundo factor (MFA).',
    )
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
