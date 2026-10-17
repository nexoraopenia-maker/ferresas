import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { changePasswordSchema, changeTenantPlanSchema, extendTrialSchema } from '@/features/superadmin/schemas'
import { changeSuperAdminPassword } from '@/features/superadmin/account-service'
import { changeTenantPlan, extendTrial } from '@/features/superadmin/billing-service'
import { getRouteSession, resolveTenantContext } from '@/lib/session'
import { verifyCredentials } from '@/lib/credentials'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const seg = (d: Date) => Math.floor(d.getTime() / 1000)

async function main() {
  console.log('\n1) Validación del cambio de contraseña')
  const ok = { currentPassword: 'vieja-123456', newPassword: 'nueva-larga-123456', confirmPassword: 'nueva-larga-123456' }
  check('un cambio correcto se acepta', changePasswordSchema.safeParse(ok).success)
  check('exige 12 caracteres para esta cuenta',
    !changePasswordSchema.safeParse({ ...ok, newPassword: 'corta12', confirmPassword: 'corta12' }).success)
  check('rechaza si la confirmación no coincide',
    !changePasswordSchema.safeParse({ ...ok, confirmPassword: 'otra-cosa-12345' }).success)
  check('rechaza reusar la contraseña actual',
    !changePasswordSchema.safeParse({ currentPassword: 'misma-clave-12345', newPassword: 'misma-clave-12345', confirmPassword: 'misma-clave-12345' }).success)
  check('rechaza solo espacios',
    !changePasswordSchema.safeParse({ ...ok, newPassword: '              ', confirmPassword: '              ' }).success)

  console.log('\n2) Cambio real y REVOCACIÓN de sesiones (lo que importa)')
  const marca = randomUUID().slice(0, 8)
  const vieja = 'contrasena-vieja-1'
  const nueva = 'contrasena-nueva-9'
  const sa = await prisma.user.create({
    data: {
      email: `sa-${marca}@x.com`, name: 'SA Test', role: 'SUPERADMIN',
      passwordHash: await bcrypt.hash(vieja, 12),
    },
  })

  // Token emitido ANTES del cambio.
  const antes = seg(new Date(Date.now() - 60_000))
  check('la sesión previa es válida al principio',
    (await getRouteSession(sa.id, undefined, new Date(), antes)) !== null)

  const malActual = await changeSuperAdminPassword(sa.id, {
    currentPassword: 'no-es-la-mia-123', newPassword: nueva, confirmPassword: nueva,
  }).then(() => null).catch((e) => e)
  check('sin la contraseña ACTUAL no se puede cambiar', malActual?.code === 'UNAUTHENTICATED')
  check('el mensaje es claro (ya sabemos quién es)', /actual no coincide/.test(malActual?.message ?? ''))

  await changeSuperAdminPassword(sa.id, {
    currentPassword: vieja, newPassword: nueva, confirmPassword: nueva,
  })

  check('la contraseña nueva funciona',
    (await verifyCredentials({ email: sa.email, password: nueva })) !== null)
  check('la vieja ya NO funciona',
    (await verifyCredentials({ email: sa.email, password: vieja })) === null)
  check('se grabó passwordChangedAt',
    (await prisma.user.findUniqueOrThrow({ where: { id: sa.id } })).passwordChangedAt !== null)

  check('>>> la sesión emitida ANTES queda REVOCADA',
    (await getRouteSession(sa.id, undefined, new Date(), antes)) === null)
  const despues = seg(new Date(Date.now() + 5000))
  check('una sesión posterior sí vale',
    (await getRouteSession(sa.id, undefined, new Date(), despues)) !== null)
  check('un token sin iat no se bloquea (compatibilidad)',
    (await getRouteSession(sa.id, undefined, new Date(), undefined)) !== null)
  check('queda auditado sin guardar la contraseña',
    await prisma.auditLog.findFirst({
      where: { actorId: sa.id, action: 'superadmin.password.change' },
    }).then((a) => a !== null && !JSON.stringify(a.after).includes(nueva)))

  console.log('\n3) La revocación también afecta al contexto de tenant')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({
    data: { slug: `ac-${marca}`, name: `Ferre Cuenta ${marca}`, planId: plan.id },
  })
  await prisma.subscription.create({
    data: { tenantId: t.id, planId: plan.id, status: 'TRIALING', trialEndsAt: new Date(Date.now() + 5 * 864e5) },
  })
  const owner = await prisma.user.create({
    data: {
      email: `ow-${marca}@x.com`, name: 'Dueño', role: 'OWNER', tenantId: t.id,
      passwordHash: await bcrypt.hash('clave-owner-12345', 12),
      passwordChangedAt: new Date(),
    },
  })
  const err = await resolveTenantContext(owner.id, new Date(), antes)
    .then(() => null).catch((e) => e)
  check('un token viejo de un OWNER también se rechaza', err?.code === 'UNAUTHENTICATED')
  check('y el mensaje le dice qué hacer', /Vuelve a iniciar sesión/.test(err?.message ?? ''))

  console.log('\n4) Cambio manual de plan')
  check('exige motivo de 10+',
    !changeTenantPlanSchema.safeParse({ tenantId: t.id, planCode: 'premium', reason: 'porque' }).success)
  const r = await changeTenantPlan(
    { tenantId: t.id, planCode: 'premium', reason: 'Negoció condiciones especiales' },
    { id: sa.id, email: sa.email },
  )
  check('mueve al plan nuevo', r.planName === 'Premium')
  const sub = await prisma.subscription.findUniqueOrThrow({
    where: { tenantId: t.id }, include: { plan: true },
  })
  check('la suscripción apunta al plan nuevo', sub.plan.code === 'premium')
  check('y el plan cacheado en Tenant también (no divergen)',
    (await prisma.tenant.findUniqueOrThrow({ where: { id: t.id }, include: { plan: true } })).plan?.code === 'premium')
  check('queda auditado con antes y después',
    await prisma.auditLog.findFirst({
      where: { tenantId: t.id, action: 'tenant.plan.change' },
    }).then((a) => JSON.stringify(a?.before) === '{"plan":"Pro"}' && JSON.stringify(a?.after) === '{"plan":"Premium"}'))
  check('avisa de que el cobro en la pasarela NO se movió', r.cobroSincronizado === true,
    'sin externalSubscriptionId = alta manual, nada que sincronizar')
  check('repetir el mismo plan se rechaza',
    await changeTenantPlan({ tenantId: t.id, planCode: 'premium', reason: 'otra vez lo mismo' },
      { id: sa.id, email: sa.email }).then(() => null).catch((e) => e.code) === 'DUPLICATE_CODE')

  console.log('\n5) Extensión de prueba')
  check('exige entre 1 y 90 días',
    !extendTrialSchema.safeParse({ tenantId: t.id, days: 200, reason: 'demasiados dias' }).success &&
    !extendTrialSchema.safeParse({ tenantId: t.id, days: 0, reason: 'cero dias no vale' }).success)

  const fin = (await prisma.subscription.findUniqueOrThrow({ where: { tenantId: t.id } })).trialEndsAt!
  const e1 = await extendTrial({ tenantId: t.id, days: 10, reason: 'Se le cayó internet toda la semana' },
    { id: sa.id, email: sa.email })
  check('suma sobre la fecha vigente',
    Math.round((e1.trialEndsAt.getTime() - fin.getTime()) / 864e5) === 10)

  // Prueba YA vencida: debe contar desde hoy, no desde el pasado.
  await prisma.subscription.update({
    where: { tenantId: t.id },
    data: { status: 'CANCELED', trialEndsAt: new Date('2026-01-01'), canceledAt: new Date() },
  })
  const e2 = await extendTrial({ tenantId: t.id, days: 7, reason: 'Reactivación acordada con el cliente' },
    { id: sa.id, email: sa.email })
  const diasDesdeHoy = Math.round((e2.trialEndsAt.getTime() - Date.now()) / 864e5)
  check('en una prueba VENCIDA cuenta desde hoy, no desde el pasado',
    diasDesdeHoy === 7, `${diasDesdeHoy} días`)
  const reactivada = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: t.id } })
  check('devuelve la cuenta a TRIALING', reactivada.status === 'TRIALING')
  check('y limpia canceledAt', reactivada.canceledAt === null)

  await prisma.subscription.update({ where: { tenantId: t.id }, data: { status: 'ACTIVE' } })
  check('no se extiende la prueba de quien ya paga',
    await extendTrial({ tenantId: t.id, days: 5, reason: 'no deberia poder hacerse' },
      { id: sa.id, email: sa.email }).then(() => null).catch((e) => e.code) === 'DUPLICATE_CODE')

  console.log('\n6) Limpieza')
  await prisma.tenant.delete({ where: { id: t.id } })
  await prisma.user.delete({ where: { id: sa.id } })
  check('datos de prueba eliminados',
    (await prisma.user.count({ where: { id: { in: [sa.id, owner.id] } } })) === 0)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
