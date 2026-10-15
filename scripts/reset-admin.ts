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
import bcrypt from 'bcryptjs'
import { prisma } from '../src/lib/prisma'
import { verifyCredentialsDetailed } from '../src/lib/credentials'
import { assertWritableEnvironment } from '../src/lib/env-guard'

/**
 * Reseteo de la contraseña del SUPERADMIN.
 *
 *   npx tsx scripts/reset-admin.ts
 *   npx tsx scripts/reset-admin.ts otra-contrasena-larga
 *   SUPERADMIN_EMAIL=otro@dominio.com npx tsx scripts/reset-admin.ts
 *
 * ─── QUÉ HACE Y POR QUÉ ──────────────────────────────────────────────────
 *
 * Reescribe el hash y, al terminar, VERIFICA el login por la misma ruta que
 * usa NextAuth (`verifyCredentialsDetailed`). Esa comprobación es el motivo
 * de que el script exista: sin ella uno escribe un hash y se queda sin saber
 * si el problema era ese. Con ella, el script responde "la credencial
 * funciona" o "sigue fallando, y el motivo es X".
 *
 * También fija `passwordChangedAt`, que revoca las sesiones JWT anteriores.
 * Si se está reseteando por sospecha de acceso indebido, dejar vivas las
 * sesiones viejas anularía el sentido del reseteo.
 *
 * Crea la cuenta si no existe, para que sirva igual en una base recién
 * migrada donde el seed no se haya corrido.
 */

const MINIMO = 12

async function main() {
  assertWritableEnvironment({
    script: 'scripts/reset-admin.ts',
    efecto: 'SOBREESCRIBE la contraseña del SUPERADMIN y revoca sus sesiones',
  })

  const email = (process.env.SUPERADMIN_EMAIL ?? 'admin@ferresaas.dev').toLowerCase().trim()
  const password = process.argv[2] ?? process.env.SUPERADMIN_PASSWORD ?? 'cambiala-en-produccion'

  console.log('▶ Reseteo de SUPERADMIN')
  console.log(`  correo: ${email}`)
  console.log(`  contraseña: ${password.length} caracteres`)

  if (password.length < MINIMO) {
    console.warn(
      `  ⚠️  Tiene menos de ${MINIMO} caracteres. Se aplica igual porque lo has pedido ` +
        'explícitamente, pero esta cuenta controla TODOS los clientes del SaaS.',
    )
  }

  // La base responde antes de tocar nada: si está caída, conviene saberlo
  // aquí y no después de haber reescrito un hash a medias.
  try {
    const t0 = Date.now()
    await prisma.$queryRawUnsafe('SELECT 1')
    console.log(`  base de datos: alcanzable (${Date.now() - t0} ms)`)
  } catch (e) {
    console.error('✖ La base de datos NO responde. Revisa DATABASE_URL.')
    console.error(`  ${e instanceof Error ? e.message.split('\n')[0] : e}`)
    process.exitCode = 1
    return
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const ahora = new Date()

  const existente = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, isActive: true, deletedAt: true, tenantId: true },
  })

  if (existente && existente.role !== 'SUPERADMIN') {
    // Promover a superadmin por accidente a un empleado de una ferretería le
    // daría acceso a todos los demás clientes. Se para en seco.
    console.error(
      `✖ ${email} existe pero su rol es ${existente.role}, no SUPERADMIN. ` +
        'No se toca: elevarlo le daría acceso a todos los tenants.',
    )
    process.exitCode = 1
    return
  }

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      passwordHash,
      passwordChangedAt: ahora,
      // Un reseteo también sirve para recuperar una cuenta desactivada.
      isActive: true,
      deletedAt: null,
    },
    create: {
      email,
      name: 'Super Admin',
      role: 'SUPERADMIN',
      passwordHash,
      passwordChangedAt: ahora,
      emailVerified: ahora,
    },
    select: { id: true, email: true, role: true, tenantId: true },
  })

  console.log(`  ${existente ? 'actualizado' : 'CREADO'}: ${user.email} (${user.role})`)
  if (user.tenantId !== null) {
    console.warn(
      '  ⚠️  Este SUPERADMIN tiene tenantId. Debería ser null: el superadmin ' +
        'vive fuera de cualquier ferretería.',
    )
  }

  // --- La parte que de verdad importa: comprobar que el login funciona ---
  console.log('')
  console.log('▶ Verificando por la MISMA ruta que usa NextAuth…')
  const r = await verifyCredentialsDetailed({ email, password })

  if (r.ok) {
    console.log('✔ La credencial FUNCIONA. Entra con:')
    console.log(`    correo:     ${email}`)
    console.log(`    contraseña: ${password}`)
    console.log('')
    console.log('  Las sesiones anteriores quedaron revocadas (passwordChangedAt).')
    console.log('  Si el login sigue fallando en producción, el problema NO es la')
    console.log('  contraseña: revisa /api/diagnostics?key=$CRON_SECRET')
  } else {
    console.error(`✖ Sigue fallando. Motivo: ${r.reason}`)
    if (r.reason === 'DATABASE_ERROR') console.error(`  detalle: ${r.detail}`)
    process.exitCode = 1
  }

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('✖ Error inesperado:', e)
  await prisma.$disconnect()
  process.exit(1)
})
