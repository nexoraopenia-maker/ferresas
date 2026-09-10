import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { expireTrials } from '@/features/billing/expire-trials'

/**
 * GET /api/cron/expire-trials — pensado para Vercel Cron.
 *
 * Configuración en vercel.json:
 *   { "crons": [{ "path": "/api/cron/expire-trials", "schedule": "0 3 * * *" }] }
 *
 * ─── AUTENTICACIÓN ───────────────────────────────────────────────────────
 *
 * Vercel Cron manda `Authorization: Bearer $CRON_SECRET`. La ruta es pública
 * —está en la lista de rutas abiertas del proxy, como los webhooks— así que
 * sin esta comprobación cualquiera podría dispararla. No es catastrófico
 * (el job es idempotente y solo cierra trials ya vencidos), pero sí es un
 * gasto de BD que se regala a cualquier script.
 *
 * Si CRON_SECRET no está configurado, la ruta se niega a ejecutar en
 * producción. Un cron sin proteger es peor que un cron que no corre: el
 * segundo se nota, el primero no.
 */
export const dynamic = 'force-dynamic'

function autorizado(req: NextRequest): boolean {
  const secreto = process.env.CRON_SECRET
  if (!secreto) return process.env.NODE_ENV !== 'production'

  const cabecera = req.headers.get('authorization') ?? ''
  const esperado = `Bearer ${secreto}`

  const a = Buffer.from(cabecera)
  const b = Buffer.from(esperado)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function GET(req: NextRequest) {
  if (!autorizado(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const r = await expireTrials()
    console.info('[cron] expire-trials', { expirados: r.expirados })
    return NextResponse.json({ ok: true, expirados: r.expirados }, { status: 200 })
  } catch (e) {
    console.error('[cron] expire-trials falló', {
      error: e instanceof Error ? { name: e.name, message: e.message } : e,
    })
    // 500 para que Vercel lo marque como fallido y sea visible en el panel.
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
