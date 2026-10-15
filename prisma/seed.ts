/**
 * Carga de entorno: `.env.local` ANTES de `.env`.
 *
 * dotenv no sobrescribe lo ya definido, así que `.env.local` —donde vive
 * staging— gana sobre `.env` —producción—. Sin este orden, el CLI de Prisma
 * apuntaba siempre a producción aunque `.env.local` dijera otra cosa: eso ya
 * hizo que un `migrate deploy` y un `db seed` destinados a staging se
 * ejecutaran contra la base real.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'
import bcrypt from 'bcryptjs'
import { assertWritableEnvironment } from '../src/lib/env-guard'

/**
 * Seed idempotente: se puede correr N veces sin duplicar nada (todo va por
 * upsert sobre claves únicas). Importante porque `prisma migrate reset` y los
 * despliegues lo ejecutan más de una vez.
 *
 * Usa DIRECT_URL si existe: el seed es DDL-adyacente y no debe ir por pooler.
 */
assertWritableEnvironment({
  script: 'prisma/seed.ts',
  efecto: 'crea/actualiza planes y SOBREESCRIBE la contraseña del SUPERADMIN',
})

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('Falta DATABASE_URL / DIRECT_URL para el seed.')
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
})

/**
 * Límites de plan. `null` = ilimitado.
 * Se aplican al CREAR el recurso, no en la UI (§5.2).
 */
const PLANS = [
  {
    code: 'basico',
    name: 'Básico',
    description: 'Para la ferretería de barrio que recién digitaliza su stock.',
    priceMonthly: '49.00',
    priceYearly: '490.00',
    maxUsers: 2,
    maxWarehouses: 1,
    maxProducts: 500,
    maxMonthlyTransactions: 500,
    trialDays: 14,
    sortOrder: 1,
    features: {
      escaner: true,
      pos: true,
      cotizaciones: false,
      multiAlmacen: false,
      reportes: 'basicos',
    },
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'Varios almacenes, equipo completo y cotizaciones.',
    priceMonthly: '99.00',
    priceYearly: '990.00',
    maxUsers: 8,
    maxWarehouses: 3,
    maxProducts: 5000,
    maxMonthlyTransactions: 5000,
    trialDays: 14,
    sortOrder: 2,
    features: {
      escaner: true,
      pos: true,
      cotizaciones: true,
      multiAlmacen: true,
      reportes: 'avanzados',
    },
  },
  {
    code: 'premium',
    name: 'Premium',
    description: 'Sin límites, soporte prioritario y exportación de datos.',
    priceMonthly: '199.00',
    priceYearly: '1990.00',
    maxUsers: null,
    maxWarehouses: null,
    maxProducts: null,
    maxMonthlyTransactions: null,
    trialDays: 30,
    sortOrder: 3,
    features: {
      escaner: true,
      pos: true,
      cotizaciones: true,
      multiAlmacen: true,
      reportes: 'avanzados',
      soportePrioritario: true,
      exportacion: true,
    },
  },
] as const

async function main() {
  console.log('▶ Sembrando planes…')

  for (const plan of PLANS) {
    const { code, features, ...rest } = plan
    await prisma.plan.upsert({
      where: { code },
      update: { ...rest, features },
      create: { code, ...rest, features },
    })
    console.log(`  ✓ ${plan.name}`)
  }

  console.log('▶ Sembrando SUPERADMIN…')

  const email = process.env.SUPERADMIN_EMAIL ?? 'admin@ferresaas.dev'
  const password = process.env.SUPERADMIN_PASSWORD ?? 'ferresaas-dev-2026'

  // Este seed solo debe correr en desarrollo con credenciales por defecto.
  // En producción, exigimos que las variables vengan del entorno: un
  // SUPERADMIN con contraseña conocida es una puerta trasera al SaaS entero.
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.SUPERADMIN_EMAIL || !process.env.SUPERADMIN_PASSWORD) {
      throw new Error(
        'En producción, SUPERADMIN_EMAIL y SUPERADMIN_PASSWORD son obligatorios.',
      )
    }
  }

  const passwordHash = await bcrypt.hash(password, 12)

  const superadmin = await prisma.user.upsert({
    where: { email },
    // La contraseña se reescribe también al actualizar: SUPERADMIN_PASSWORD
    // es la fuente de verdad. Así, cambiarla en el entorno y volver a correr
    // el seed basta para recuperar el acceso — antes había que borrar la fila
    // a mano porque el `update` no tocaba el hash.
    update: {
      email,
      role: 'SUPERADMIN',
      isActive: true,
      passwordHash,
    },
    create: {
      email,
      name: 'Super Admin',
      role: 'SUPERADMIN',
      // tenantId queda NULL a propósito: es el único rol que vive fuera de
      // un tenant.
      passwordHash,
      emailVerified: new Date(),
    },
  })

  console.log(`  ✓ ${superadmin.email} (rol ${superadmin.role})`)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`    contraseña de desarrollo: ${password}`)
  }
}

main()
  .then(async () => {
    await prisma.$disconnect()
    console.log('✔ Seed completado.')
  })
  .catch(async (e) => {
    console.error('✖ Seed falló:', e)
    await prisma.$disconnect()
    process.exit(1)
  })
