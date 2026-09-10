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
 */

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('Falta DATABASE_URL en el entorno.')
}

const createPrismaClient = () =>
  new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log:
      process.env.NODE_ENV === 'development'
        ? ['warn', 'error']
        : ['error'],
  })

// Singleton: en dev, Next.js recarga módulos en cada cambio y sin esto se
// agotan las conexiones del pooler.
const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createPrismaClient>
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

export type BasePrismaClient = typeof prisma
