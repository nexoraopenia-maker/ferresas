import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/generated/prisma/client'

/**
 * Cliente Prisma base — SIN filtro de tenant.
 *
 * ⚠️ No lo importes desde código de dominio. Úsalo solo para:
 *   - tablas globales (Plan, WebhookEvent, VerificationToken)
 *   - resolución de sesión (buscar User por email en el login)
 *   - el módulo auditado de Super Admin
 *
 * Para cualquier dato de negocio usa `getTenantPrisma()` de ./tenant-prisma.
 *
 * Prisma 7 exige driver adapter: la URL ya no vive en el schema. Aquí usamos
 * la POOLED (DATABASE_URL) porque es la que atiende el tráfico serverless;
 * la directa (DIRECT_URL) solo la usa el CLI en migraciones.
 *
 * ─── POR QUÉ LA INICIALIZACIÓN ES PEREZOSA ───────────────────────────────
 *
 * Antes este módulo hacía `throw` a nivel superior si faltaba DATABASE_URL.
 * Parecía defensivo y era lo contrario: los imports se evalúan antes que
 * cualquier otra cosa, y la cadena
 *
 *     proxy.ts → auth.ts → credentials.ts → prisma.ts
 *
 * significa que una variable de entorno ausente tumbaba el proceso ENTERO al
 * cargar. El resultado en Vercel era un 500 en todas las rutas, un stack
 * trace minificado apuntando a `chunks/[root-of-the-server]…` y ni una línea
 * de nuestros propios logs, porque el módulo que los emite nunca terminaba
 * de cargarse. Un problema de configuración de un minuto se volvía
 * indepurable.
 *
 * Ahora el cliente se construye en el PRIMER USO. Si la variable falta, el
 * error salta en la consulta concreta, es capturable (verifyCredentials lo
 * clasifica como DATABASE_ERROR), lo dice en castellano y el resto de la app
 * —el login, las páginas públicas, /api/diagnostics— sigue respondiendo y
 * puede explicar qué pasa.
 */

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL

  if (!connectionString) {
    throw new Error(
      'Falta DATABASE_URL. En Vercel debe estar definida en el entorno ' +
        'Production, no solo en Preview. Comprueba /api/diagnostics.',
    )
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

// Singleton: en dev, Next.js recarga módulos en cada cambio y sin esto se
// agotan las conexiones del pooler.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
}

let instancia: PrismaClient | undefined = globalForPrisma.prisma

function obtener(): PrismaClient {
  if (!instancia) {
    instancia = createPrismaClient()
    if (process.env.NODE_ENV !== 'production') {
      globalForPrisma.prisma = instancia
    }
  }
  return instancia
}

/**
 * Proxy perezoso: idéntico de usar que un PrismaClient, pero no construye
 * nada hasta que se accede a una propiedad. Así importar este módulo no
 * puede tumbar el proceso.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const cliente = obtener()
    const valor = Reflect.get(cliente as object, prop, receiver)
    return typeof valor === 'function' ? valor.bind(cliente) : valor
  },
  has(_target, prop) {
    return Reflect.has(obtener() as object, prop)
  },
})

export type BasePrismaClient = PrismaClient

/** ¿Está configurada la conexión? Para /api/diagnostics, sin construir nada. */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL)
}
