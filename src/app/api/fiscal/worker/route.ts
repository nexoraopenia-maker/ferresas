import { NextResponse, type NextRequest } from 'next/server'
import { secretosIguales } from '@/lib/comparar-secreto'
import { ejecutarWorker } from '@/features/cola-fiscal/worker'

/**
 * POST /api/fiscal/worker — procesa una tanda de la cola de envío fiscal.
 *
 * ─── QUIÉN LO LLAMA ──────────────────────────────────────────────────────
 *
 * Un programador EXTERNO (QStash, n8n con cron, cualquiera que sepa hacer un POST cada minuto).
 * NO depende del cron de Vercel. La ruta es pública para el proxy (no hay sesión) y se autentica con
 * un SECRETO COMPARTIDO: `Authorization: Bearer <FISCAL_WORKER_SECRET>` o la cabecera
 * `x-worker-secret`. (La validación de firmas de QStash queda para más adelante.)
 *
 * ─── GARANTÍAS ───────────────────────────────────────────────────────────
 *
 *  · El secreto se compara en TIEMPO CONSTANTE y sin filtrar su longitud.
 *  · Sin secreto configurado (o demasiado corto) la ruta se niega a ejecutar: 503. Un worker sin
 *    proteger sería peor que uno que no corre.
 *  · 200 siempre que haya autorización, también cuando NO hay trabajo (el programador no debe
 *    reintentar por eso). Un 5xx real solo ocurre ante un fallo del propio proceso.
 *  · Es SEGURO llamarlo dos veces a la vez o solapado: cada fila se reclama de forma atómica y con
 *    lease, así que dos ejecuciones jamás envían el mismo comprobante.
 *  · El lote tiene tope de TIEMPO, derivado de la duración máxima de la función: no empieza un envío
 *    que no pueda terminar. Si queda trabajo, lo dice (`restante: true`) y el programador vuelve.
 */
export const dynamic = 'force-dynamic'

/** Duración máxima de la función en Vercel. De ella sale el presupuesto del lote. */
export const maxDuration = 60
const MARGEN_FUNCION_MS = 12_000

const LONGITUD_MINIMA_SECRETO = 16

function secretoRecibido(req: NextRequest): string {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  return bearer ?? req.headers.get('x-worker-secret') ?? ''
}

export async function POST(req: NextRequest) {
  const esperado = process.env.FISCAL_WORKER_SECRET
  if (!esperado || esperado.length < LONGITUD_MINIMA_SECRETO) {
    // Sin detalles al exterior: solo que el servicio no está disponible.
    return NextResponse.json({ ok: false, error: 'worker no disponible' }, { status: 503 })
  }
  if (!secretosIguales(secretoRecibido(req), esperado)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  try {
    const r = await ejecutarWorker({ presupuestoMs: maxDuration * 1000 - MARGEN_FUNCION_MS })
    return NextResponse.json({ ok: true, ...r }, { status: 200 })
  } catch (e) {
    console.error('[fiscal-worker] la pasada falló', { error: e instanceof Error ? { name: e.name, message: e.message } : e })
    return NextResponse.json({ ok: false, error: 'interno' }, { status: 500 })
  }
}

/** Un GET con efectos secundarios es una trampa (prefetch, rastreadores): solo POST. */
export async function GET() {
  return NextResponse.json({ ok: false, error: 'method not allowed' }, { status: 405, headers: { Allow: 'POST' } })
}
