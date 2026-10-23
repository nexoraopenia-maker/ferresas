import { BusinessError } from '@/lib/errors'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import {
  enviarComprobante, refrescarEstado, type DependenciasEnvio, type ResultadoEnvio,
} from '@/features/invoicing/envio'
import { bloqueoDeEnvio, modoFiscal } from '@/features/invoicing/modo-fiscal'
import { encolarComprobante } from './encolar'
import { procesarFila } from './procesar'
import { reclamarPorId } from './repositorio'

/**
 * Envío manual desde la pantalla («Enviar» / «Reintentar»).
 *
 * Pasa por la MISMA cola que el worker, no por un camino paralelo: la persona reclama la fila con
 * lease igual que lo haría un worker, así que un clic en «Enviar» mientras el worker procesa ese
 * mismo comprobante no produce dos envíos — uno reclama y el otro recibe «ya se está enviando».
 * La demo no usa cola (envía directo al simulado).
 */
export async function enviarManual(
  db: TenantPrismaClient, ctx: TenantContext, taxDocumentId: string,
  deps: DependenciasEnvio = {}, ahora: Date = new Date(),
): Promise<ResultadoEnvio> {
  exigir(ctx, 'comprobantes.emitir')

  const t = await db.tenant.findFirstOrThrow({ select: { isDemo: true, realBillingEnabledAt: true, realBillingPausedAt: true } })
  const modo = modoFiscal(t)
  if (modo === 'DEMO') return enviarComprobante(db, ctx, taxDocumentId, deps)

  const doc = await db.taxDocument.findFirst({ where: { id: taxDocumentId }, select: { status: true, isTrial: true } })
  if (!doc) throw new BusinessError('NOT_FOUND', 'El comprobante no existe.')
  if (doc.isTrial) throw new BusinessError('INVALID_DOCUMENT', 'Este es un documento de prueba, sin valor tributario: no se envía a ningún proveedor.')
  const bloqueo = bloqueoDeEnvio(modo)
  if (bloqueo) throw new BusinessError('INVALID_DOCUMENT', bloqueo)

  // Ya enviado y esperando respuesta: se consulta (no se vuelve a enviar).
  if (doc.status === 'ENVIADO') return refrescarEstado(db, ctx, taxDocumentId, deps)
  // Aceptado, rechazado…: `enviarComprobante` lo rechaza con el mensaje de siempre.
  if (doc.status !== 'PENDIENTE') return enviarComprobante(db, ctx, taxDocumentId, deps)

  // Fila de la cola: se crea si falta y, si agotó los reintentos, la persona los reabre a propósito.
  const fila = await db.fiscalDispatch.findFirst({ where: { taxDocumentId }, select: { id: true, status: true } })
  if (!fila) await encolarComprobante(db, ctx.tenantId, taxDocumentId, ahora)
  else if (fila.status === 'AGOTADO') {
    await db.fiscalDispatch.updateMany({
      where: { id: fila.id, status: 'AGOTADO' },
      data: { status: 'PENDIENTE', attempts: 0, nextAttemptAt: ahora, exhaustedAt: null, lastError: null },
    })
    await db.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'cola.reintento_manual',
        entityType: 'TaxDocument', entityId: taxDocumentId, impersonationId: ctx.impersonationId ?? null,
      },
    })
  }

  const reclamada = await reclamarPorId(ctx.tenantId, taxDocumentId, `manual:${ctx.userId}`, ahora)
  if (!reclamada) {
    throw new BusinessError('INVALID_DOCUMENT', 'Este comprobante ya se está enviando. Espera unos segundos y consulta de nuevo.')
  }
  const r = await procesarFila(reclamada, deps, ahora)

  const [despues, cola] = await Promise.all([
    db.taxDocument.findFirstOrThrow({ where: { id: taxDocumentId }, select: { status: true, statusMessage: true, responseCode: true } }),
    db.fiscalDispatch.findFirst({ where: { taxDocumentId }, select: { lastError: true } }),
  ])
  return {
    estado: despues.status,
    reintentable: r === 'reintento' || r === 'liberado',
    mensaje: cola?.lastError ?? despues.statusMessage,
    codigoRespuesta: despues.responseCode,
  }
}
