import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { LEASE_MS, MAX_INTENTOS, recortarError, type OperacionCola } from './reglas'

/**
 * Acceso a la cola de envío fiscal con el cliente BASE y SQL directo.
 *
 * Por qué no `getTenantPrisma`: el worker trabaja ENTRE negocios (reclama «la siguiente fila de
 * cualquier negocio»), y eso es justo lo que el cliente aislado impide a propósito. El aislamiento
 * se recupera DESPUÉS del reclamo: cada fila se procesa con un cliente acotado al negocio de la fila.
 * Este archivo está inventariado en `tests/prisma-base.ts`.
 *
 * ─── GARANTÍAS ───────────────────────────────────────────────────────────
 *
 *  · RECLAMO ATÓMICO. Una sola sentencia elige y marca la fila con `FOR UPDATE SKIP LOCKED`: dos
 *    workers simultáneos jamás reciben la misma, y uno no espera al otro.
 *  · LEASE. Reclamar fija `lockedUntil`. Si el worker se cae, la fila queda `EN_CURSO` con el lease
 *    vencido y la RECUPERA el siguiente reclamo: no hace falta ningún proceso aparte.
 *  · FENCING. Cada finalización exige seguir siendo el dueño del lease (`lockedBy` + `EN_CURSO`).
 *    Un worker lento cuyo lease venció y se reasignó no puede pisar el resultado del nuevo.
 *  · QUÉ NUNCA SE RECLAMA: negocios demo, sin facturación real habilitada o en pausa; y documentos
 *    de PRUEBA, aunque alguien hubiera insertado la fila a mano.
 *
 * Las fechas se pasan como texto ISO con zona y se convierten a «UTC sin zona», que es como Prisma
 * guarda `DateTime`: no dependen de la zona horaria del servidor ni del driver.
 */

const ts = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`

export interface FilaReclamada {
  id: string
  tenantId: string
  taxDocumentId: string
  op: OperacionCola
  /** Intentos contando éste. */
  attempts: number
  idempotencyKey: string
  /** Identificador del worker dueño del lease. */
  lockedBy: string
}

type FilaCruda = Omit<FilaReclamada, 'attempts'> & { attempts: number | bigint }
const aFila = (r: FilaCruda): FilaReclamada => ({ ...r, attempts: Number(r.attempts) })

/**
 * Reclama la siguiente fila vencida (pendiente que ya toca, o en curso con el lease vencido).
 * `null` si no hay trabajo.
 */
export async function reclamarSiguiente(worker: string, ahora: Date): Promise<FilaReclamada | null> {
  const hasta = new Date(ahora.getTime() + LEASE_MS)
  const filas = await prisma.$queryRaw<FilaCruda[]>(Prisma.sql`
    WITH elegida AS (
      SELECT d.id
      FROM fiscal_dispatches d
      JOIN tenants t       ON t.id = d."tenantId"
      JOIN tax_documents td ON td.id = d."taxDocumentId" AND td."tenantId" = d."tenantId"
      WHERE ((d.status = 'PENDIENTE' AND d."nextAttemptAt" <= ${ts(ahora)})
          OR (d.status = 'EN_CURSO'  AND d."lockedUntil"   <  ${ts(ahora)}))
        AND d.attempts < ${MAX_INTENTOS}
        AND t."isDemo" = false
        AND t."deletedAt" IS NULL
        AND t."realBillingEnabledAt" IS NOT NULL
        AND t."realBillingPausedAt" IS NULL
        AND td."isTrial" = false
      ORDER BY d."nextAttemptAt" ASC, d."createdAt" ASC
      LIMIT 1
      FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE fiscal_dispatches f
       SET status = 'EN_CURSO',
           "lockedUntil" = ${ts(hasta)},
           "lockedBy" = ${worker},
           attempts = f.attempts + 1,
           "lastAttemptAt" = ${ts(ahora)},
           "updatedAt" = ${ts(ahora)}
      FROM elegida
     WHERE f.id = elegida.id
    RETURNING f.id, f."tenantId", f."taxDocumentId", f.op::text AS op, f.attempts, f."idempotencyKey", f."lockedBy"
  `)
  return filas[0] ? aFila(filas[0]) : null
}

/**
 * Reclama UNA fila concreta (envío manual desde la pantalla). Ignora `nextAttemptAt` (la persona
 * quiere enviarlo ya) pero respeta el lease de otro worker y excluye los documentos de prueba.
 */
export async function reclamarPorId(tenantId: string, taxDocumentId: string, worker: string, ahora: Date): Promise<FilaReclamada | null> {
  const hasta = new Date(ahora.getTime() + LEASE_MS)
  const filas = await prisma.$queryRaw<FilaCruda[]>(Prisma.sql`
    UPDATE fiscal_dispatches f
       SET status = 'EN_CURSO',
           "lockedUntil" = ${ts(hasta)},
           "lockedBy" = ${worker},
           attempts = f.attempts + 1,
           "lastAttemptAt" = ${ts(ahora)},
           "updatedAt" = ${ts(ahora)}
      FROM tax_documents td
     WHERE f."tenantId" = ${tenantId}
       AND f."taxDocumentId" = ${taxDocumentId}
       AND td.id = f."taxDocumentId" AND td."tenantId" = f."tenantId" AND td."isTrial" = false
       AND (f.status = 'PENDIENTE' OR (f.status = 'EN_CURSO' AND f."lockedUntil" < ${ts(ahora)}))
    RETURNING f.id, f."tenantId", f."taxDocumentId", f.op::text AS op, f.attempts, f."idempotencyKey", f."lockedBy"
  `)
  return filas[0] ? aFila(filas[0]) : null
}

/**
 * Filas cuyo worker se cayó en el ÚLTIMO intento: ya no hay reintentos que gastar, así que pasan a
 * AGOTADO (si no, se quedarían EN_CURSO para siempre, invisibles para la alarma).
 */
export async function agotarVencidos(ahora: Date): Promise<number> {
  const filas = await prisma.$queryRaw<{ id: string; tenantId: string; taxDocumentId: string }[]>(Prisma.sql`
    UPDATE fiscal_dispatches
       SET status = 'AGOTADO', "exhaustedAt" = ${ts(ahora)}, "lockedUntil" = NULL, "lockedBy" = NULL,
           "lastError" = 'El worker se cayó en el último intento: sin respuesta del proveedor.',
           "updatedAt" = ${ts(ahora)}
     WHERE status = 'EN_CURSO' AND "lockedUntil" < ${ts(ahora)} AND attempts >= ${MAX_INTENTOS}
    RETURNING id, "tenantId", "taxDocumentId"
  `)
  for (const f of filas) await auditarAgotado(f.tenantId, f.taxDocumentId, 'worker caído en el último intento')
  return filas.length
}

/**
 * Documentos REALES pendientes que no tienen fila (emitidos antes de la cola, o si el encolado
 * hubiera fallado): se adoptan. Solo de negocios con la facturación real habilitada, nunca de
 * demo ni documentos de prueba.
 */
export async function adoptarHuerfanos(ahora: Date, limite: number): Promise<number> {
  const n = await prisma.$executeRaw(Prisma.sql`
    INSERT INTO fiscal_dispatches (id, "tenantId", "taxDocumentId", op, status, attempts, "nextAttemptAt", "idempotencyKey", "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text, td."tenantId", td.id, 'ENVIAR', 'PENDIENTE', 0, ${ts(ahora)},
           'fiscal:' || td."tenantId" || ':' || td.id || ':ENVIAR', ${ts(ahora)}, ${ts(ahora)}
      FROM tax_documents td
      JOIN tenants t ON t.id = td."tenantId"
     WHERE td.status = 'PENDIENTE' AND td."isTrial" = false
       AND t."isDemo" = false AND t."deletedAt" IS NULL AND t."realBillingEnabledAt" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM fiscal_dispatches d WHERE d."taxDocumentId" = td.id)
     LIMIT ${limite}
    ON CONFLICT DO NOTHING
  `)
  return Number(n)
}

// ─── Finalización, siempre con fencing: solo el dueño del lease puede cerrar la fila ──────────────

const dueño = (f: FilaReclamada) => ({ id: f.id, lockedBy: f.lockedBy, status: 'EN_CURSO' as const })
const sinLease = { lockedUntil: null, lockedBy: null }

/** El proveedor dio una respuesta definitiva. `false` = ya no era dueño del lease (no se toca nada). */
export async function completar(f: FilaReclamada, ahora: Date, nota: string | null = null): Promise<boolean> {
  const r = await prisma.fiscalDispatch.updateMany({
    where: dueño(f),
    data: { status: 'COMPLETADO', completedAt: ahora, lastError: nota ? recortarError(nota) : null, ...sinLease },
  })
  return r.count === 1
}

/** Fallo transitorio: vuelve a la cola para el instante `cuando`. */
export async function reprogramar(f: FilaReclamada, cuando: Date, error: string): Promise<boolean> {
  const r = await prisma.fiscalDispatch.updateMany({
    where: dueño(f),
    data: { status: 'PENDIENTE', nextAttemptAt: cuando, lastError: recortarError(error), ...sinLease },
  })
  return r.count === 1
}

/** Sin más reintentos y SIN respuesta del proveedor: AGOTADO. El comprobante sigue PENDIENTE. */
export async function agotar(f: FilaReclamada, ahora: Date, error: string): Promise<boolean> {
  const r = await prisma.fiscalDispatch.updateMany({
    where: dueño(f),
    data: { status: 'AGOTADO', exhaustedAt: ahora, lastError: recortarError(error), ...sinLease },
  })
  if (r.count === 1) await auditarAgotado(f.tenantId, f.taxDocumentId, error)
  return r.count === 1
}

/** Enviado y a la espera de respuesta: pasa a CONSULTAR su estado, con intentos nuevos. */
export async function pasarAConsulta(f: FilaReclamada, cuando: Date): Promise<boolean> {
  const r = await prisma.fiscalDispatch.updateMany({
    where: dueño(f),
    data: {
      op: 'CONSULTAR', status: 'PENDIENTE', attempts: 0, nextAttemptAt: cuando, lastError: null,
      idempotencyKey: f.idempotencyKey.replace(/:ENVIAR$/, ':CONSULTAR'), ...sinLease,
    },
  })
  return r.count === 1
}

/**
 * No era el momento de enviarlo (el negocio se pausó, o una nota espera a su comprobante original): no se
 * gasta el intento. `motivo` queda en `lastError` para que se vea POR QUÉ espera.
 */
export async function liberar(f: FilaReclamada, cuando: Date, motivo: string | null = null): Promise<boolean> {
  const r = await prisma.fiscalDispatch.updateMany({
    where: dueño(f),
    data: {
      status: 'PENDIENTE', attempts: Math.max(0, f.attempts - 1), nextAttemptAt: cuando, ...sinLease,
      ...(motivo ? { lastError: recortarError(motivo) } : {}),
    },
  })
  return r.count === 1
}

async function auditarAgotado(tenantId: string, taxDocumentId: string, motivo: string) {
  await prisma.auditLog.create({
    data: {
      tenantId, action: 'cola.agotado', entityType: 'TaxDocument', entityId: taxDocumentId,
      after: { motivo: recortarError(motivo), nota: 'Sin respuesta del proveedor tras todos los reintentos: el comprobante sigue PENDIENTE.' },
    },
  })
}

// ─── Comunicaciones de baja (S4) ──────────────────────────────────────────────────────────────────
// Misma idea que arriba, pero cada `TaxVoid` lleva su propia cola (no comparte `fiscal_dispatches`: un comprobante ya tiene su fila de envío). El reclamo es atómico sin SQL
// directo: se leen candidatos y se reclama con un `updateMany` condicionado al estado Y a los intentos leídos; si otro worker llegó antes, no encaja (cuenta 0).

export interface BajaReclamada {
  id: string
  tenantId: string
  taxDocumentId: string
  /** Ya tiene ticket: toca CONSULTAR; si no, ENVIAR. */
  ticket: string | null
  /** Intentos contando éste. */
  attempts: number
  lockedBy: string
}

export async function reclamarBaja(worker: string, ahora: Date): Promise<BajaReclamada | null> {
  const toca = {
    status: { in: ['PENDIENTE', 'ENVIADA'] as ('PENDIENTE' | 'ENVIADA')[] },
    attempts: { lt: MAX_INTENTOS },
    nextAttemptAt: { lte: ahora },
    OR: [{ lockedUntil: null }, { lockedUntil: { lt: ahora } }],
  }
  const candidatos = await prisma.taxVoid.findMany({
    where: {
      ...toca,
      tenant: { isDemo: false, deletedAt: null, realBillingEnabledAt: { not: null }, realBillingPausedAt: null },
      taxDocument: { isTrial: false },
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }], take: 5,
    select: { id: true, tenantId: true, taxDocumentId: true, ticket: true, attempts: true },
  })
  for (const c of candidatos) {
    const r = await prisma.taxVoid.updateMany({
      // Los MISMOS intentos que se leyeron: si alguien la reclamó antes, esto no encaja.
      where: { id: c.id, ...toca, attempts: c.attempts },
      data: { lockedBy: worker, lockedUntil: new Date(ahora.getTime() + LEASE_MS), attempts: { increment: 1 }, lastAttemptAt: ahora },
    })
    if (r.count === 1) return { id: c.id, tenantId: c.tenantId, taxDocumentId: c.taxDocumentId, ticket: c.ticket, attempts: c.attempts + 1, lockedBy: worker }
  }
  return null
}

/** Bajas cuyo worker se cayó en el ÚLTIMO intento: ya no hay más que gastar, así que AGOTADA (visible, y se puede reintentar). */
export async function agotarBajasVencidas(ahora: Date): Promise<number> {
  const filas = await prisma.taxVoid.findMany({
    where: { status: { in: ['PENDIENTE', 'ENVIADA'] }, lockedUntil: { lt: ahora }, attempts: { gte: MAX_INTENTOS } },
    select: { id: true, tenantId: true, taxDocumentId: true },
  })
  let n = 0
  for (const f of filas) {
    const r = await prisma.taxVoid.updateMany({
      where: { id: f.id, status: { in: ['PENDIENTE', 'ENVIADA'] }, lockedUntil: { lt: ahora }, attempts: { gte: MAX_INTENTOS } },
      data: { status: 'AGOTADA', exhaustedAt: ahora, lockedUntil: null, lockedBy: null, lastError: 'El worker se cayó en el último intento: sin respuesta de SUNAT.' },
    })
    if (r.count === 1) {
      n++
      await prisma.auditLog.create({
        data: { tenantId: f.tenantId, action: 'baja.agotada', entityType: 'TaxDocument', entityId: f.taxDocumentId, after: { motivo: 'worker caído en el último intento', nota: 'El comprobante sigue como estaba.' } },
      })
    }
  }
  return n
}
