import type { TenantPrismaClient } from '@/lib/tenant-prisma'

/**
 * Vencimiento de pedidos a caja.
 *
 * Un pedido NO es una cotización: no informa un precio que valga quince días,
 * es una venta que alguien armó y que alguien debe cobrar HOY. Lo que no se
 * cobra se descarta, porque un pedido que sobrevive a la jornada se cobraría
 * mañana con un stock y una intención que ya no existen.
 *
 * Vence cuando ocurre lo PRIMERO de esto:
 *   · se cierra la caja de su sucursal (`vencerPedidosDeSucursal`), o
 *   · acaba el día del negocio (`validUntil`, fijado al crearlo; se aplica de
 *     forma perezosa en cada consulta, sin necesitar un cron).
 * No reserva stock en ningún momento, así que vencer no libera nada.
 */

/** Cuánto dura el «lo estoy cobrando». Pasado ese tiempo, otro cajero puede tomarlo. */
export const PEDIDO_BLOQUEO_MS = 5 * 60_000

/** Marca VENCIDOS los pedidos pendientes cuyo día ya acabó. Devuelve cuántos. */
export async function vencerPedidosDelDia(db: TenantPrismaClient, ahora: Date = new Date()): Promise<number> {
  const r = await db.quote.updateMany({
    where: { kind: 'PEDIDO', status: 'ENVIADA', validUntil: { lt: ahora } },
    data: { status: 'VENCIDA', lockedById: null, lockedAt: null },
  })
  return r.count
}

/** Al cerrar la caja: vencen TODOS los pedidos pendientes de esa sucursal. */
export async function vencerPedidosDeSucursal(
  db: TenantPrismaClient,
  branchId: string,
): Promise<number> {
  const r = await db.quote.updateMany({
    where: { kind: 'PEDIDO', status: 'ENVIADA', branchId },
    data: { status: 'VENCIDA', lockedById: null, lockedAt: null },
  })
  return r.count
}
