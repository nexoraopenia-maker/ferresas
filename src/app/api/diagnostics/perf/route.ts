import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { Medidor } from '@/lib/perf'

/**
 * Perfilado de las consultas de cada pantalla, EJECUTADO EN PRODUCCIÓN.
 *
 * ─── POR QUÉ UN ENDPOINT Y NO CABECERAS EN LAS PÁGINAS ───────────────────
 *
 * En App Router una página o un layout NO pueden poner cabeceras de
 * respuesta: solo un Route Handler puede. Así que para ver el desglose por
 * fases desde fuera hace falta un handler que ejecute EL MISMO conjunto de
 * consultas que cada pantalla y lo mida.
 *
 * No sustituye al TTFB real de la navegación —eso se mide con curl contra la
 * ruta— pero sí responde la pregunta que el TTFB solo no responde: de esos
 * milisegundos, cuántos son base de datos y cuántos son red.
 *
 * Mide con el cliente BASE, sin scope de tenant, y por eso no necesita
 * sesión: le basta un tenant cualquiera para que las consultas tengan datos
 * reales que recorrer.
 */

export const dynamic = 'force-dynamic'

function autorizado(req: Request): boolean {
  const esperado = process.env.CRON_SECRET
  if (!esperado) return false
  const dado = new URL(req.url).searchParams.get('key') ?? ''
  const a = Buffer.from(dado)
  const b = Buffer.from(esperado)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(req: Request) {
  if (!autorizado(req)) {
    return NextResponse.json({ error: 'no autorizado' }, { status: 401 })
  }

  const m = new Medidor()

  // Despertar explícito: la primera consulta paga el arranque en frío de
  // Neon, y mezclarla con las demás falsearía todas las fases siguientes.
  const arranque = await m.fase('neon_arranque', async () => {
    const t = performance.now()
    await prisma.$queryRawUnsafe('SELECT 1')
    return Math.round(performance.now() - t)
  })

  const ping = await m.fase('neon_ping_caliente', async () => {
    const lecturas: number[] = []
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      await prisma.$queryRawUnsafe('SELECT 1')
      lecturas.push(performance.now() - t)
    }
    return Math.round(lecturas.reduce((a, b) => a + b) / lecturas.length)
  })

  const tenant = await m.fase('elegir_tenant', () =>
    prisma.tenant.findFirst({
      where: { deletedAt: null },
      select: { id: true, slug: true },
      orderBy: { createdAt: 'asc' },
    }),
  )

  if (!tenant) {
    return NextResponse.json({ error: 'sin tenants para perfilar' }, { status: 503 })
  }

  const usuario = await m.fase('elegir_usuario', () =>
    prisma.user.findFirst({
      where: { tenantId: tenant.id, isActive: true, deletedAt: null },
      select: { id: true },
    }),
  )

  // ── La consulta de sesión, que corre en CADA navegación ─────────────────
  await m.fase('sesion_USER_SELECT', () =>
    prisma.user.findUnique({
      where: { id: usuario?.id ?? '' },
      select: {
        id: true, role: true, isActive: true, deletedAt: true,
        tenantId: true, passwordChangedAt: true,
        tenant: {
          select: {
            isActive: true,
            subscription: {
              select: {
                status: true, pastDueSince: true, graceDays: true,
                trialEndsAt: true, currentPeriodEnd: true,
              },
            },
          },
        },
        branches: {
          where: { branch: { deletedAt: null, isActive: true } },
          select: { branch: { select: { id: true, code: true, isDefault: true } } },
        },
      },
    }),
  )

  const T = { tenantId: tenant.id }

  // ── El conjunto de consultas de cada pantalla ───────────────────────────
  await m.fase('layout_tenant+sucursales', async () => {
    await Promise.all([
      prisma.tenant.findFirst({ where: { id: tenant.id }, select: { name: true } }),
      prisma.userBranch.findMany({
        where: { tenantId: tenant.id, userId: usuario?.id ?? '' },
        select: { branch: { select: { id: true, code: true, name: true, seriesNumber: true } } },
      }),
    ])
  })

  await m.fase('pos', async () => {
    await Promise.all([
      prisma.warehouse.findFirst({
        where: { ...T, isActive: true, deletedAt: null },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        select: { name: true },
      }),
      prisma.tenant.findFirst({ where: { id: tenant.id }, select: { timezone: true } }),
    ])
  })

  await m.fase('inventario', async () => {
    await prisma.warehouse.findFirst({
      where: { ...T, isActive: true, deletedAt: null },
      select: { id: true, name: true },
    })
  })

  await m.fase('cotizaciones', async () => {
    await Promise.all([
      prisma.tenant.findFirst({ where: { id: tenant.id }, select: { timezone: true } }),
      prisma.quote.findMany({
        where: T, take: 50, orderBy: { createdAt: 'desc' },
        select: {
          id: true, number: true, status: true, total: true, validUntil: true,
          createdAt: true, customer: { select: { name: true, docNumber: true } },
          _count: { select: { items: true } },
        },
      }),
    ])
  })

  await m.fase('comprobantes', async () => {
    await Promise.all([
      prisma.taxDocument.findMany({
        where: T, take: 100, orderBy: { issuedAt: 'desc' },
        select: {
          id: true, fullNumber: true, documentType: true, status: true,
          statusMessage: true, receiverDocNumber: true, receiverName: true,
          currency: true, subtotal: true, taxTotal: true, total: true,
          issuedAt: true, sale: { select: { number: true } },
        },
      }),
      prisma.taxDocument.groupBy({ by: ['status'], where: T, _count: { _all: true } }),
      prisma.tenant.findFirst({ where: { id: tenant.id }, select: { timezone: true } }),
    ])
  })

  await m.fase('mi_plan_facturacion', async () => {
    await Promise.all([
      prisma.tenant.findFirst({ where: { id: tenant.id }, select: { timezone: true } }),
      prisma.subscription.findFirst({
        where: T,
        select: {
          status: true, trialEndsAt: true, currentPeriodEnd: true,
          externalCustomerId: true, plan: { select: { code: true, name: true } },
        },
      }),
      prisma.plan.findMany({
        where: { isActive: true }, orderBy: { sortOrder: 'asc' },
        select: { code: true, name: true, priceMonthly: true, currency: true, description: true },
      }),
    ])
  })

  m.log('api/diagnostics/perf')

  return NextResponse.json(
    {
      region: {
        vercelRegion: process.env.VERCEL_REGION ?? null,
        vercelEnv: process.env.VERCEL_ENV ?? null,
        /** Región de Neon, deducida del host de la conexión. */
        neonHost: (() => {
          try {
            return new URL(process.env.DATABASE_URL!).hostname
          } catch {
            return null
          }
        })(),
      },
      neon: {
        arranqueMs: arranque,
        pingCalienteMs: ping,
        /**
         * Si el arranque es mucho mayor que el ping, el cómputo estaba
         * SUSPENDIDO: eso es el scale-to-zero, no latencia de red.
         */
        estabaSuspendido: arranque > ping * 4,
      },
      tenantPerfilado: tenant.slug,
      fases: m.detalle,
      totalMs: m.total,
    },
    { headers: { 'Server-Timing': m.serverTiming() } },
  )
}
