/**
 * Lee de la base lo que ocurrió en un turno y lo entrega a `construirDesglose` (F6.8b). Se llama dentro de la transacción de cierre, con el turno YA bloqueado:
 * nada puede entrar mientras se lee, así que la foto que se congela en `closingBreakdown` es exactamente la del arqueo. Nunca lee costos: lo único que sabe del
 * piso de margen es QUÉ ventas se hicieron con la excepción `sale.below_cost` (el número de venta), no cuánto costaban.
 */
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { construirDesglose, type DesgloseCierre, type EntradaDesglose } from './cierre-desglose'

const num = (v: unknown): number => Number(v ?? 0)

export async function desgloseDelTurno(t: TenantPrismaClient, sessionId: string): Promise<DesgloseCierre> {
  const ventas = await t.sale.findMany({
    where: { cashSessionId: sessionId, status: { in: ['COMPLETADA', 'ANULADA', 'DEVUELTA'] } },
    select: { id: true, number: true, status: true, total: true, discountTotal: true, payments: { select: { method: true, amount: true, change: true } } },
  })
  const abonos = await t.customerPayment.findMany({ where: { cashSessionId: sessionId, voidedAt: null }, select: { method: true, amount: true } })
  const pagosProveedor = await t.supplierPayment.findMany({ where: { cashSessionId: sessionId, voidedAt: null }, select: { method: true, amount: true } })
  const devoluciones = await t.saleReturnRefund.findMany({ where: { cashSessionId: sessionId }, select: { mode: true, method: true, amount: true } })
  // Igual que los totales del turno: solo el EFECTIVO mueve el cajón; la compensación por otro medio queda registrada pero no entra aquí.
  const movimientos = await t.cashMovement.findMany({ where: { cashSessionId: sessionId, voidedAt: null, method: 'EFECTIVO' }, select: { kind: true, category: true, amount: true } })
  const excepciones = ventas.length === 0 ? [] : await t.auditLog.findMany({
    where: { action: 'sale.below_cost', entityType: 'Sale', entityId: { in: ventas.map((v) => v.id) } },
    select: { entityId: true },
  })
  const bajoCosto = new Set(excepciones.map((e) => e.entityId))

  const entrada: EntradaDesglose = {
    ventas: ventas.map((v) => ({ numero: v.number, status: v.status as 'COMPLETADA' | 'ANULADA' | 'DEVUELTA', total: num(v.total), discountTotal: num(v.discountTotal), bajoCosto: bajoCosto.has(v.id) })),
    pagos: ventas.flatMap((v) => v.payments.map((p) => ({ method: p.method, amount: num(p.amount), change: num(p.change) }))),
    devoluciones: devoluciones.map((d) => ({ mode: d.mode, method: d.method, amount: num(d.amount) })),
    abonos: abonos.map((a) => ({ method: a.method, amount: num(a.amount) })),
    pagosProveedor: pagosProveedor.map((p) => ({ method: p.method, amount: num(p.amount) })),
    movimientos: movimientos.map((m) => ({ kind: m.kind, category: m.category, amount: num(m.amount) })),
  }
  return construirDesglose(entrada)
}
