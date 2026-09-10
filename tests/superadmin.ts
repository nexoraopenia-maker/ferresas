import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { computeSaasMetrics } from '@/features/superadmin/metrics'
import { getSuperAdminDashboard } from '@/features/superadmin/queries'
import { resolveImpersonation, IMPERSONATION_MAX_MINUTES } from '@/lib/impersonation'
import { resolveRouteAccess, type RouteSession } from '@/lib/route-access'
import { suspendTenantSchema, startImpersonationSchema } from '@/features/superadmin/schemas'
import { expireTrials } from '@/features/billing/expire-trials'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

const D = (iso: string) => new Date(iso)
const AHORA = D('2026-08-25T12:00:00Z')

async function main() {
  console.log('\n1) MRR — el dinero se suma en céntimos')
  {
    // 49.90 + 99.90 + 199.90 en coma flotante da 349.69999999999993
    const m = computeSaasMetrics([
      { status: 'ACTIVE', isActive: true, priceMonthly: '49.90', createdAt: AHORA, canceledAt: null },
      { status: 'ACTIVE', isActive: true, priceMonthly: '99.90', createdAt: AHORA, canceledAt: null },
      { status: 'ACTIVE', isActive: true, priceMonthly: '199.90', createdAt: AHORA, canceledAt: null },
    ], AHORA)
    check('suma exacta sin deriva de flotantes', m.mrr === 349.7, String(m.mrr))
    check('ARPU correcto', m.arpu === 116.57, String(m.arpu))
  }

  console.log('\n2) Qué cuenta y qué no para el MRR')
  {
    const filas = [
      { status: 'ACTIVE' as const, isActive: true, priceMonthly: '100.00', createdAt: AHORA, canceledAt: null },
      { status: 'TRIALING' as const, isActive: true, priceMonthly: '100.00', createdAt: AHORA, canceledAt: null },
      { status: 'PAST_DUE' as const, isActive: true, priceMonthly: '100.00', createdAt: AHORA, canceledAt: null },
      { status: 'CANCELED' as const, isActive: true, priceMonthly: '100.00', createdAt: AHORA, canceledAt: AHORA },
      // ACTIVE en Stripe pero suspendida a mano por abuso.
      { status: 'ACTIVE' as const, isActive: false, priceMonthly: '100.00', createdAt: AHORA, canceledAt: null },
    ]
    const m = computeSaasMetrics(filas, AHORA)
    check('solo la ACTIVE y no suspendida suma', m.mrr === 100, String(m.mrr))
    check('la mora NO infla el MRR (ese dinero no entró)', m.pastDue === 1 && m.mrr === 100)
    check('una suspendida por abuso no cuenta aunque pague', m.suspended === 1 && m.active === 1)
    check('cuenta los trials aparte', m.trialing === 1)
    check('total de tenants correcto', m.totalTenants === 5)
  }

  console.log('\n3) Churn')
  {
    const viejo = D('2026-01-01T00:00:00Z')
    const m = computeSaasMetrics([
      ...Array.from({ length: 9 }, () => ({
        status: 'ACTIVE' as const, isActive: true, priceMonthly: '50.00',
        createdAt: viejo, canceledAt: null,
      })),
      { status: 'CANCELED' as const, isActive: true, priceMonthly: '50.00',
        createdAt: viejo, canceledAt: D('2026-08-10T00:00:00Z') },
    ], AHORA)
    check('1 baja sobre base de 10 = 10%', m.churnRate === 10, `${m.churnRate}%`)
    check('cuenta las bajas de los últimos 30 días', m.canceledLast30Days === 1)
    check('sin bajas el churn es 0',
      computeSaasMetrics([{ status: 'ACTIVE', isActive: true, priceMonthly: '50.00', createdAt: viejo, canceledAt: null }], AHORA).churnRate === 0)
    check('sin tenants no divide por cero',
      computeSaasMetrics([], AHORA).churnRate === 0 && computeSaasMetrics([], AHORA).arpu === 0)
  }

  console.log('\n4) Validación de las acciones críticas')
  check('suspender exige motivo de 10+ caracteres',
    !suspendTenantSchema.safeParse({ tenantId: 't1', reason: 'porque' }).success)
  check('impersonation exige motivo',
    !startImpersonationSchema.safeParse({ tenantId: 't1' }).success)
  check('un motivo real se acepta',
    startImpersonationSchema.safeParse({ tenantId: 't1', reason: 'Ticket #1290: no ve el stock' }).success)

  // ---- Datos reales ----
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const sa = await prisma.user.findFirstOrThrow({ where: { role: 'SUPERADMIN' } })
  const marca = randomUUID().slice(0, 6)
  const t = await prisma.tenant.create({
    data: { slug: `sa-${marca}`, name: `Ferre SA ${marca}`, planId: plan.id },
  })
  const owner = await prisma.user.create({
    data: {
      email: `own-${marca}@x.com`, name: 'Dueño', role: 'OWNER', tenantId: t.id,
      passwordHash: await bcrypt.hash('clave-larga-123', 12),
    },
  })
  await prisma.subscription.create({
    data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' },
  })

  console.log('\n5) Dashboard sobre datos reales')
  {
    const d = await getSuperAdminDashboard(AHORA)
    const fila = d.tenants.find((x) => x.id === t.id)
    check('el tenant aparece en la tabla', fila !== undefined)
    check('con su plan y su acceso calculado', fila?.planName === 'Pro' && fila?.access === 'FULL')
    check('cuenta sus usuarios', fila?.users === 1)
    check('el MRR incluye su plan', d.metrics.mrr >= Number(plan.priceMonthly))
  }

  console.log('\n6) Impersonation — sesión válida')
  const sesion = await prisma.impersonationSession.create({
    data: {
      superAdminId: sa.id, tenantId: t.id, targetUserId: owner.id,
      reason: 'Ticket #1290: el cliente no ve su stock',
      expiresAt: new Date(Date.now() + IMPERSONATION_MAX_MINUTES * 60_000),
    },
  })
  check('resuelve para el superadmin que la abrió',
    (await resolveImpersonation(sa.id, sesion.id))?.tenantId === t.id)

  console.log('\n7) Impersonation — todo lo que debe rechazar')
  check('OTRO usuario con la misma cookie no obtiene nada',
    (await resolveImpersonation(owner.id, sesion.id)) === null)
  check('una cookie inventada no vale',
    (await resolveImpersonation(sa.id, 'cookie-falsificada')) === null)
  check('sin cookie, nada', (await resolveImpersonation(sa.id, undefined)) === null)

  const caducada = await prisma.impersonationSession.create({
    data: { superAdminId: sa.id, tenantId: t.id, reason: 'sesión ya vencida hace rato',
            expiresAt: new Date(Date.now() - 60_000) },
  })
  check('una sesión caducada no vale', (await resolveImpersonation(sa.id, caducada.id)) === null)

  const cerrada = await prisma.impersonationSession.create({
    data: { superAdminId: sa.id, tenantId: t.id, reason: 'sesión ya cerrada por el admin',
            expiresAt: new Date(Date.now() + 600_000), endedAt: new Date() },
  })
  check('una sesión cerrada no vale', (await resolveImpersonation(sa.id, cerrada.id)) === null)

  console.log('\n8) Enrutado: el panel es invisible, no redirige')
  const s = (o: Partial<RouteSession> = {}): RouteSession =>
    ({ userId: 'u', tenantId: 't', role: 'OWNER', access: 'FULL', ...o })
  check('un OWNER recibe 404 en /superadmin',
    resolveRouteAccess({ pathname: '/superadmin', session: s() }).kind === 'not-found')
  check('un ADMIN también', resolveRouteAccess({ pathname: '/superadmin', session: s({ role: 'ADMIN' }) }).kind === 'not-found')
  check('y en las subrutas',
    resolveRouteAccess({ pathname: '/superadmin/tenants/1', session: s() }).kind === 'not-found')
  check('el SUPERADMIN entra',
    resolveRouteAccess({ pathname: '/superadmin', session: s({ role: 'SUPERADMIN', tenantId: null }) }).kind === 'allow')

  console.log('\n9) El soporte no queda atrapado dentro del cliente')
  const impSession = s({ role: 'OWNER', tenantId: t.id, access: 'READ_ONLY', impersonatorId: sa.id })
  check('durante la impersonation SÍ puede volver a /superadmin',
    resolveRouteAccess({ pathname: '/superadmin', session: impSession }).kind === 'allow')
  check('y /salir-de-soporte está abierto',
    resolveRouteAccess({ pathname: '/salir-de-soporte', session: impSession }).kind === 'allow')
  check('sin impersonation, /salir-de-soporte es 404',
    resolveRouteAccess({ pathname: '/salir-de-soporte', session: s() }).kind === 'not-found')
  check('el soporte puede salir aunque el tenant esté suspendido',
    resolveRouteAccess({ pathname: '/salir-de-soporte',
      session: { ...impSession, access: 'BLOCKED' } }).kind === 'allow')

  console.log('\n10) Expiración de trials')
  const mkTrial = async (fin: Date, estado: any = 'TRIALING') => {
    const x = await prisma.tenant.create({
      data: { slug: `tr-${randomUUID().slice(0, 8)}`, name: 'Trial', planId: plan.id },
    })
    await prisma.subscription.create({
      data: { tenantId: x.id, planId: plan.id, status: estado, trialEndsAt: fin },
    })
    return x.id
  }
  const vencido = await mkTrial(D('2026-08-01T00:00:00Z'))
  const vigente = await mkTrial(D('2026-12-01T00:00:00Z'))
  const yaPago = await mkTrial(D('2026-08-01T00:00:00Z'), 'ACTIVE')

  const r1 = await expireTrials(AHORA)
  check('cierra el trial vencido', r1.tenantIds.includes(vencido))
  check('NO toca el trial vigente', !r1.tenantIds.includes(vigente))
  check('NO toca a quien ya pagó', !r1.tenantIds.includes(yaPago))
  check('el vencido queda CANCELED',
    (await prisma.subscription.findUniqueOrThrow({ where: { tenantId: vencido } })).status === 'CANCELED')
  check('registra canceledAt para el churn',
    (await prisma.subscription.findUniqueOrThrow({ where: { tenantId: vencido } })).canceledAt !== null)
  check('deja rastro en AuditLog',
    (await prisma.auditLog.count({ where: { tenantId: vencido, action: 'trial.expired' } })) === 1)

  const r2 = await expireTrials(AHORA)
  check('ES IDEMPOTENTE: la segunda pasada no hace nada', r2.expirados === 0)
  check('y no duplica el AuditLog',
    (await prisma.auditLog.count({ where: { tenantId: vencido, action: 'trial.expired' } })) === 1)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
