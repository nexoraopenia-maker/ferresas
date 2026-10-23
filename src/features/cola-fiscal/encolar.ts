import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import type { ModoFiscal } from '@/features/invoicing/modo-fiscal'
import { claveIdempotencia } from './reglas'

/**
 * Entrada a la cola. Usa el cliente ACOTADO al negocio (no el base): encolar es una escritura
 * normal de negocio y va dentro de la MISMA transacción que emite el comprobante (patrón outbox):
 * o existen el comprobante y su fila, o ninguno de los dos.
 */

/**
 * ¿Entra este documento a la cola? SOLO los reales de un negocio real (REAL o PAUSADO: en pausa se
 * encolan igual y esperan). Un documento de PRUEBA no entra nunca; la demo envía por su propio camino
 * (al simulado) y tampoco.
 */
export function seEncola(doc: { isTrial: boolean }, modo: ModoFiscal): boolean {
  return !doc.isTrial && (modo === 'REAL' || modo === 'PAUSADO')
}

export async function encolarComprobante(
  t: TenantPrismaClient, tenantId: string, taxDocumentId: string, ahora: Date = new Date(),
): Promise<void> {
  await t.fiscalDispatch.create({
    data: {
      tenantId, taxDocumentId, op: 'ENVIAR', status: 'PENDIENTE', nextAttemptAt: ahora,
      idempotencyKey: claveIdempotencia(tenantId, taxDocumentId, 'ENVIAR'),
    },
  })
}
