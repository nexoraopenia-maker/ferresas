import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { verifyCredentials } from '@/lib/credentials'
import { getRouteSession, resolveTenantContext } from '@/lib/session'
import { resolveRouteAccess } from '@/lib/route-access'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({
    data: { slug: `f-${randomUUID().slice(0, 8)}`, name: 'Ferretería Auth', planId: plan.id },
  })
  const email = `owner-${randomUUID().slice(0, 8)}@x.com`
  const password = 'clave-correcta-123'
  const owner = await prisma.user.create({
    data: {
      email, name: 'Dueño', role: 'OWNER', tenantId: t.id,
      passwordHash: await bcrypt.hash(password, 12),
    },
  })

  console.log('\n1) Verificación de credenciales')
  check('acepta la contraseña correcta', (await verifyCredentials({ email, password }))?.id === owner.id)
  check('rechaza contraseña incorrecta', (await verifyCredentials({ email, password: 'mala' })) === null)
  check('rechaza correo inexistente', (await verifyCredentials({ email: 'nadie@x.com', password })) === null)
  check('rechaza input malformado', (await verifyCredentials({ email: 'no-es-correo', password })) === null)
  check('normaliza mayúsculas del correo',
    (await verifyCredentials({ email: email.toUpperCase(), password }))?.id === owner.id)
  check('NO devuelve el hash de contraseña',
    !('passwordHash' in ((await verifyCredentials({ email, password })) ?? {})))

  console.log('\n2) No se puede enumerar cuentas por tiempo de respuesta')
  const medir = async (fn: () => Promise<unknown>) => {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < 5; i++) await fn()
    return Number(process.hrtime.bigint() - t0) / 5e6
  }
  const existe = await medir(() => verifyCredentials({ email, password: 'mala' }))
  const noExiste = await medir(() => verifyCredentials({ email: 'fantasma@x.com', password: 'mala' }))
  const ratio = Math.max(existe, noExiste) / Math.min(existe, noExiste)
  // Umbral 3 y no 2: el ratio real ronda 1.00, pero medir tiempos en una
  // máquina con otros procesos compitiendo por CPU introduce ruido, y un test
  // de seguridad que falla por carga acaba ignorándose. Sin el hash señuelo
  // el ratio sería de ~1000x (0.4 ms contra 400 ms), así que 3 sigue
  // detectando la regresión de forma contundente.
  check('tiempos comparables entre correo real y falso (ratio < 3)',
    ratio < 3, `existe ${existe.toFixed(0)}ms vs no existe ${noExiste.toFixed(0)}ms, ratio ${ratio.toFixed(2)}`)

  console.log('\n3) Usuario desactivado o borrado')
  const baja = await prisma.user.create({
    data: {
      email: `baja-${randomUUID().slice(0, 8)}@x.com`, name: 'Baja', role: 'VENDEDOR',
      tenantId: t.id, passwordHash: await bcrypt.hash(password, 12), isActive: false,
    },
  })
  check('un usuario desactivado no puede entrar',
    (await verifyCredentials({ email: baja.email, password })) === null)
  check('y su sesión de ruta tampoco resuelve', (await getRouteSession(baja.id)) === null)
  const sinClave = await prisma.user.create({
    data: { email: `oauth-${randomUUID().slice(0, 8)}@x.com`, name: 'OAuth', tenantId: t.id },
  })
  check('un usuario sin passwordHash no entra por credenciales',
    (await verifyCredentials({ email: sinClave.email, password: '' })) === null)

  console.log('\n4) La sesión resuelve autorización desde la BD, no del token')
  const s1 = await getRouteSession(owner.id)
  check('trae tenantId y rol reales', s1?.tenantId === t.id && s1?.role === 'OWNER')
  check('sin suscripción -> READ_ONLY', s1?.access === 'READ_ONLY', s1?.access)

  await prisma.subscription.create({
    data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' },
  })
  check('al activar la suscripción, la MISMA sesión pasa a FULL',
    (await getRouteSession(owner.id))?.access === 'FULL')

  await prisma.user.update({ where: { id: owner.id }, data: { role: 'VENDEDOR' } })
  check('un cambio de rol surte efecto de inmediato',
    (await getRouteSession(owner.id))?.role === 'VENDEDOR')
  await prisma.user.update({ where: { id: owner.id }, data: { role: 'OWNER' } })

  console.log('\n5) Bloqueo progresivo end-to-end (§5.2)')
  const escenario = async (label: string, data: any, esperado: string) => {
    await prisma.subscription.update({ where: { tenantId: t.id }, data })
    const s = await getRouteSession(owner.id)
    const d = resolveRouteAccess({ pathname: '/inventario', session: s })
    const real = d.kind === 'redirect' ? `redirect:${d.to}` : `allow:${('notice' in d && d.notice) || 'FULL'}`
    check(label, real === esperado, real)
  }
  const hace = (dias: number) => new Date(Date.now() - dias * 864e5)

  await escenario('ACTIVE -> opera sin fricción', { status: 'ACTIVE', pastDueSince: null }, 'allow:FULL')
  await escenario('PAST_DUE día 3 de 7 -> banner, sigue operando',
    { status: 'PAST_DUE', pastDueSince: hace(3), graceDays: 7 }, 'allow:WARN')
  await escenario('PAST_DUE día 10 de 7 -> solo lectura',
    { status: 'PAST_DUE', pastDueSince: hace(10), graceDays: 7 }, 'allow:READ_ONLY')
  await escenario('CANCELED -> solo lectura', { status: 'CANCELED' }, 'allow:READ_ONLY')
  await escenario('TRIALING vigente -> opera',
    { status: 'TRIALING', trialEndsAt: new Date(Date.now() + 864e5) }, 'allow:FULL')
  await escenario('TRIAL vencido -> solo lectura',
    { status: 'TRIALING', trialEndsAt: hace(1) }, 'allow:READ_ONLY')

  await prisma.subscription.update({ where: { tenantId: t.id }, data: { status: 'ACTIVE' } })
  await prisma.tenant.update({ where: { id: t.id }, data: { isActive: false } })
  {
    const s = await getRouteSession(owner.id)
    const d = resolveRouteAccess({ pathname: '/inventario', session: s })
    check('suspensión del Super Admin gana sobre una suscripción ACTIVE',
      d.kind === 'redirect' && d.to === '/cuenta-suspendida')
  }
  await prisma.tenant.update({ where: { id: t.id }, data: { isActive: true } })

  console.log('\n6) El SUPERADMIN del seed no tiene tenant')
  const sa = await prisma.user.findFirstOrThrow({ where: { role: 'SUPERADMIN' } })
  const saSession = await getRouteSession(sa.id)
  check('su sesión de ruta no lleva tenantId', saSession?.tenantId === null)
  check('el proxy lo saca del dashboard de cliente',
    resolveRouteAccess({ pathname: '/inventario', session: saSession }).kind === 'redirect')
  check('resolveTenantContext se niega a darle contexto de negocio',
    await resolveTenantContext(sa.id).then(() => false).catch((e) => e.code === 'TENANT_MISMATCH'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
