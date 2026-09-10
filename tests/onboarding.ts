import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { registerTenant } from '@/features/onboarding/service'
import { registerSchema, slugify } from '@/features/onboarding/schemas'
import { verifyCredentials } from '@/lib/credentials'
import { getRouteSession } from '@/lib/session'
import { resolveRouteAccess } from '@/lib/route-access'
import { computeAccessLevel } from '@/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
/**
 * Nombre único por ejecución: sin esto, las aserciones sobre conteos y sobre
 * el sufijo del slug dependen de cuántas veces se haya corrido antes la
 * suite. Un test que solo pasa con la BD recién creada no sirve para nada.
 */
const MARCA = randomUUID().slice(0, 6)
const NOMBRE = `Ferretería Sol ${MARCA}`
const nuevo = (o: any = {}) => ({
  businessName: NOMBRE, ownerName: 'Juan Pérez',
  email: `j-${randomUUID().slice(0, 8)}@x.com`, password: 'clave-segura-123',
  planCode: 'pro', ...o,
})

async function main() {
  console.log('\n1) Validación')
  check('exige nombre de negocio de 3+', !registerSchema.safeParse(nuevo({ businessName: 'ab' })).success)
  check('exige contraseña de 8+', !registerSchema.safeParse(nuevo({ password: 'corta' })).success)
  check('rechaza contraseña de solo espacios',
    !registerSchema.safeParse(nuevo({ password: '        ' })).success)
  check('normaliza el correo a minúsculas',
    registerSchema.parse(nuevo({ email: 'JUAN@X.COM' })).email === 'juan@x.com')
  check('el input NO admite tenantId ni role',
    !('role' in (registerSchema.parse(nuevo({ role: 'SUPERADMIN' })) as any)))

  console.log('\n2) Slug')
  check('quita tildes', slugify('Ferretería El Sol') === 'ferreteria-el-sol')
  check('trunca nombres larguísimos a 40 caracteres',
    slugify('a'.repeat(200)).length === 40)
  check('colapsa símbolos', slugify('Ferre & Cía. S.A.C.') === 'ferre-cia-s-a-c')
  check('nunca queda vacío', slugify('!!!###') === 'ferreteria')

  console.log('\n3) Alta completa y atómica')
  const input = registerSchema.parse(nuevo())
  const T0 = new Date('2026-08-24T12:00:00Z')
  const r = await registerTenant(input, T0)
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: r.tenantId },
    include: { subscription: true, users: true, warehouses: true },
  })
  check('crea el Tenant', tenant.name === NOMBRE)
  check('crea la Subscription en TRIALING', tenant.subscription?.status === 'TRIALING')
  check('el trial dura los días del PLAN, no un número fijo',
    tenant.subscription?.trialEndsAt?.toISOString() === new Date('2026-09-07T12:00:00Z').toISOString(),
    tenant.subscription?.trialEndsAt?.toISOString())
  check('crea el usuario como OWNER',
    tenant.users.length === 1 && tenant.users[0]!.role === 'OWNER')
  check('crea un almacén por defecto (sin él, el primer escaneo falla)',
    tenant.warehouses.length === 1 && tenant.warehouses[0]!.isDefault)
  check('deja registro en AuditLog',
    (await prisma.auditLog.count({ where: { tenantId: r.tenantId, action: 'tenant.register' } })) === 1)

  console.log('\n4) El usuario recién creado puede entrar y operar')
  check('la contraseña funciona',
    (await verifyCredentials({ email: input.email, password: input.password }))?.id === r.userId)
  const s = await getRouteSession(r.userId)
  check('su sesión resuelve al tenant nuevo', s?.tenantId === r.tenantId)
  check('en trial vigente el acceso es FULL',
    computeAccessLevel({ isActive: true }, {
      status: 'TRIALING', trialEndsAt: tenant.subscription!.trialEndsAt,
      pastDueSince: null, graceDays: 7, currentPeriodEnd: null,
    }, T0) === 'FULL')
  check('el proxy le deja entrar al dashboard',
    resolveRouteAccess({ pathname: '/inventario', session: s }).kind === 'allow')

  console.log('\n5) Correo duplicado')
  const dup = await registerTenant(registerSchema.parse(nuevo({ email: input.email })))
    .then(() => null).catch((e) => e)
  check('se rechaza', dup?.code === 'DUPLICATE_CODE')
  check('el mensaje orienta al login', /Inicia sesión/.test(dup?.message ?? ''))
  check('NO quedó un tenant huérfano por el registro fallido',
    (await prisma.tenant.count({ where: { name: NOMBRE } })) === 1)

  console.log('\n6) Homónimos: dos ferreterías con el mismo nombre')
  const b = await registerTenant(registerSchema.parse(nuevo()))
  check('la segunda obtiene un slug distinto', b.slug !== r.slug, `${r.slug} / ${b.slug}`)
  check('y sigue el patrón esperado', b.slug === `${slugify(NOMBRE)}-2`, b.slug)

  console.log('\n7) Plan')
  const malPlan = await registerTenant(registerSchema.parse(nuevo({ planCode: 'inventado' })))
    .then(() => null).catch((e) => e)
  check('rechaza un plan inexistente', malPlan?.code === 'PLAN_UNAVAILABLE')
  await prisma.plan.update({ where: { code: 'premium' }, data: { isActive: false } })
  const inactivo = await registerTenant(registerSchema.parse(nuevo({ planCode: 'premium' })))
    .then(() => null).catch((e) => e)
  check('rechaza un plan desactivado', inactivo?.code === 'PLAN_UNAVAILABLE')
  await prisma.plan.update({ where: { code: 'premium' }, data: { isActive: true } })
  check('el trial sale del plan elegido, no del cliente',
    (await registerTenant(registerSchema.parse(nuevo({ planCode: 'premium' })), T0)).trialEndsAt
      .toISOString() === new Date('2026-09-23T12:00:00Z').toISOString())

  console.log('\n8) Aislamiento desde el primer segundo')
  const a2 = await registerTenant(registerSchema.parse(nuevo({ businessName: 'Ferretería Norte' })))
  const { getTenantPrisma } = await import('@/lib/tenant-prisma')
  const dbA = getTenantPrisma({ tenantId: r.tenantId, userId: r.userId, role: 'OWNER', access: 'FULL' })
  check('el tenant A no ve el almacén del tenant B',
    (await dbA.warehouse.count()) === 1)
  check('ni sus usuarios', (await dbA.user.count()) === 1)
  check('el slug reservado nunca se asigna',
    !(await prisma.tenant.findFirst({ where: { slug: { in: ['api', 'admin', 'login'] } } })))
  void a2

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
