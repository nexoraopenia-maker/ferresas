import { BusinessError } from '@/lib/errors'
import { diaLocal } from '@/lib/periodos'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { puedeVerPorPagar } from '@/features/por-pagar/permisos'

/**
 * Voucher de pago a un proveedor: el comprobante interno de que el negocio pagó ese dinero. SOLO LECTURA.
 *
 * Es un documento INTERNO (no un comprobante electrónico): sirve para archivar, para el cajón y para conciliar. Mismo trato que el
 * recibo de abono pero al revés: aquí el dinero sale. El número es `PP-AAAAMMDD-XXXXXX` (día del negocio y últimos 6 del id): único,
 * estable en toda reimpresión y buscable. La deuda restante se lee de la auditoría del pago, donde quedó EN EL MOMENTO de pagar.
 */

const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0)

export interface VoucherPago {
  numero: string
  fecha: string
  zonaHoraria: string
  locale: string
  emisor: { nombre: string; razonSocial: string | null; ruc: string | null; direccion: string | null; telefono: string | null }
  proveedor: { nombre: string; ruc: string | null }
  pagadoPor: string
  metodo: string
  referencia: string | null
  monto: number
  /** A qué compras se aplicó, con lo aplicado a cada una. */
  reparto: { compra: string; monto: number }[]
  /** Lo que se le seguía debiendo al proveedor al terminar este pago, o `null` si no consta. */
  deudaDespues: number | null
  anulado: boolean
  motivoAnulacion: string | null
}

export function numeroDeVoucher(id: string, fechaLocal: string): string {
  return `PP-${fechaLocal.replaceAll('-', '')}-${id.slice(-6).toUpperCase()}`
}

export async function getVoucherPago(db: TenantPrismaClient, ctx: TenantContext, paymentId: string): Promise<VoucherPago> {
  if (!puedeVerPorPagar(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver los pagos a proveedores.')
  const pago = await db.supplierPayment.findFirst({
    where: { id: paymentId },
    select: {
      id: true, amount: true, method: true, reference: true, paidAt: true, voidedAt: true, voidReason: true,
      user: { select: { name: true, email: true } },
      supplier: { select: { name: true, taxId: true } },
      allocations: { orderBy: { createdAt: 'asc' }, select: { amount: true, payable: { select: { purchase: { select: { number: true } } } } } },
    },
  })
  if (!pago) throw new BusinessError('NOT_FOUND', 'El pago no existe.')

  const [t, auditoria] = await Promise.all([
    db.tenant.findFirstOrThrow({ select: { name: true, legalName: true, taxId: true, address: true, phone: true, timezone: true, locale: true } }),
    db.auditLog.findFirst({ where: { action: 'proveedor.pago', entityId: pago.id }, select: { after: true } }),
  ])
  const despues = (auditoria?.after as { deudaDespues?: unknown } | null)?.deudaDespues
  return {
    numero: numeroDeVoucher(pago.id, diaLocal(t.timezone, pago.paidAt)),
    fecha: pago.paidAt.toISOString(), zonaHoraria: t.timezone, locale: t.locale,
    emisor: { nombre: t.name, razonSocial: t.legalName, ruc: t.taxId, direccion: t.address, telefono: t.phone },
    proveedor: { nombre: pago.supplier.name, ruc: pago.supplier.taxId },
    pagadoPor: pago.user.name ?? pago.user.email, metodo: pago.method, referencia: pago.reference, monto: num(pago.amount),
    reparto: pago.allocations.map((a) => ({ compra: a.payable.purchase.number, monto: num(a.amount) })),
    deudaDespues: typeof despues === 'number' ? despues : null,
    anulado: pago.voidedAt !== null, motivoAnulacion: pago.voidReason,
  }
}
