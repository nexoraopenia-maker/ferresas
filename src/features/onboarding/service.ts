import bcrypt from 'bcryptjs'
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { BusinessError } from '@/lib/errors'
import { slugify, SLUGS_RESERVADOS, type RegisterInput } from './schemas'

/**
 * Alta de un tenant nuevo.
 *
 * ⚠️ EXCEPCIÓN DELIBERADA a la regla de oro (§3): usa el cliente `prisma`
 * base y no `getTenantPrisma()`. No puede ser de otro modo — el tenant no
 * existe todavía, así que no hay contexto que inyectar. Es el mismo caso que
 * la resolución de sesión. Por eso cada `create` de aquí lleva su `tenantId`
 * explícito y todo ocurre dentro de una única transacción.
 *
 * Lo que se crea, atómicamente:
 *   Tenant → Subscription (TRIALING) → User (OWNER) → Warehouse por defecto
 *
 * El almacén no es opcional: sin él, el primer escaneo del ferretero
 * fallaría con "no tienes ningún almacén activo" en su primer minuto de uso.
 */

export interface RegisterResult {
  tenantId: string
  slug: string
  userId: string
  trialEndsAt: Date
  planName: string
}

const P2002_UNIQUE = 'P2002'

/**
 * Busca un slug libre. La colisión es esperable: "Ferretería El Sol" existe
 * en media docena de ciudades.
 */
async function slugDisponible(base: string): Promise<string> {
  const candidatos = [
    base,
    ...Array.from({ length: 20 }, (_, i) => `${base}-${i + 2}`),
  ]

  for (const c of candidatos) {
    if (SLUGS_RESERVADOS.has(c)) continue
    const existe = await prisma.tenant.findUnique({
      where: { slug: c },
      select: { id: true },
    })
    if (!existe) return c
  }

  // Con 20 homónimos, se corta por lo sano en vez de iterar sin fin.
  return `${base}-${Date.now().toString(36)}`
}

/**
 * Quién da de alta la cuenta. En el autoservicio es el propio dueño; cuando
 * la crea el Super Admin desde la torre de control hay que decirlo, o el
 * AuditLog afirmaría que el ferretero se registró solo — y eso es justo el
 * dato que haría falta el día que alguien pregunte de dónde salió una cuenta.
 */
export interface RegisterActor {
  id: string
  email: string
  role: 'SUPERADMIN'
}

export async function registerTenant(
  input: RegisterInput,
  now: Date = new Date(),
  actor?: RegisterActor,
): Promise<RegisterResult> {
  // El plan se lee de la BD: los límites, el precio y los días de prueba
  // salen de aquí, nunca de lo que mande el navegador.
  const plan = await prisma.plan.findFirst({
    where: { code: input.planCode, isActive: true },
    select: { id: true, name: true, trialDays: true },
  })

  if (!plan) {
    throw new BusinessError('PLAN_UNAVAILABLE', 'El plan seleccionado no está disponible.')
  }

  // Comprobación temprana para dar un error claro. La garantía real es el
  // índice único de `email`, que se maneja en el catch.
  const emailTomado = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  })
  if (emailTomado) {
    throw new BusinessError(
      'DUPLICATE_CODE',
      'Ya existe una cuenta con este correo. Inicia sesión o usa otro.',
    )
  }

  const slug = await slugDisponible(slugify(input.businessName))
  const trialEndsAt = new Date(now.getTime() + plan.trialDays * 24 * 60 * 60 * 1000)

  // El hash va FUERA de la transacción: bcrypt con coste 12 tarda ~100 ms y
  // mantener una transacción abierta ese tiempo desperdicia una conexión del
  // pooler en cada registro.
  const passwordHash = await bcrypt.hash(input.password, 12)

  try {
    return await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          slug,
          name: input.businessName,
          taxId: input.taxId || null,
          phone: input.phone || null,
          email: input.email,
          planId: plan.id,
        },
        select: { id: true, slug: true },
      })

      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          planId: plan.id,
          // TRIALING sin proveedor de pagos todavía: el checkout llega
          // cuando el ferretero decide pagar. Obligarle a poner tarjeta para
          // probar es la forma más rápida de perderlo.
          provider: 'MANUAL',
          status: 'TRIALING',
          trialEndsAt,
        },
      })

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: input.email,
          name: input.ownerName,
          role: 'OWNER',
          passwordHash,
        },
        select: { id: true },
      })

      /*
       * Casa matriz. Se crea ANTES del almacén porque el almacén cuelga de
       * ella, y dentro de la misma transacción que el tenant: un negocio sin
       * sucursal no puede vender —no habría de dónde sacar la serie— así que
       * dejarlo a medias sería dejar una cuenta inservible.
       *
       * establishmentCode "0000" y seriesNumber 1 son los de la casa matriz
       * ante SUNAT, y de ahí salen las series V001 / C001 / B001 / F001.
       */
      const branch = await tx.branch.create({
        data: {
          tenantId: tenant.id,
          code: 'PRINCIPAL',
          name: 'Casa matriz',
          establishmentCode: '0000',
          seriesNumber: 1,
          phone: input.phone ?? null,
          isDefault: true,
        },
        select: { id: true },
      })

      // La «Caja principal» de la casa matriz (F6.8b): sin una caja no se puede abrir turno ni cobrar.
      await tx.cashRegister.create({ data: { tenantId: tenant.id, branchId: branch.id, name: 'Caja principal' }, select: { id: true } })

      // El OWNER opera su propia casa matriz. Sin esta asignación no podría
      // registrar ni una venta: `requireBranch` lo rechazaría.
      await tx.userBranch.create({
        data: { tenantId: tenant.id, userId: user.id, branchId: branch.id },
      })

      await tx.warehouse.create({
        data: {
          tenantId: tenant.id,
          branchId: branch.id,
          code: 'PRIN',
          name: 'Almacén principal',
          isDefault: true,
        },
      })

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          actorId: actor?.id ?? user.id,
          actorRole: actor?.role ?? 'OWNER',
          actorEmail: actor?.email ?? input.email,
          action: actor ? 'tenant.create.superadmin' : 'tenant.register',
          entityType: 'Tenant',
          entityId: tenant.id,
          after: {
            slug: tenant.slug,
            plan: plan.name,
            trialEndsAt: trialEndsAt.toISOString(),
            ownerEmail: input.email,
          },
        },
      })

      return {
        tenantId: tenant.id,
        slug: tenant.slug,
        userId: user.id,
        trialEndsAt,
        planName: plan.name,
      }
    })
  } catch (e) {
    // Carrera: dos registros con el mismo correo en el mismo instante.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
      const campos = (e.meta?.target as string[] | undefined)?.join(', ') ?? ''
      throw new BusinessError(
        'DUPLICATE_CODE',
        campos.includes('slug')
          ? 'Ese nombre de ferretería ya está tomado. Prueba con otro.'
          : 'Ya existe una cuenta con este correo. Inicia sesión o usa otro.',
      )
    }
    throw e
  }
}
