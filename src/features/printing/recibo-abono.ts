import { BusinessError } from '@/lib/errors'
import { diaLocal } from '@/lib/periodos'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { puedeVerClientes } from '@/features/clientes/permisos-ver'

/**
 * Recibo de abono: el comprobante de caja de un cliente que paga una deuda. SOLO LECTURA.
 *
 * ─── QUÉ ES Y QUÉ NO ─────────────────────────────────────────────────────
 *
 * Es un recibo INTERNO: prueba que el negocio recibió ese dinero, y se lo lleva el cliente. NO es un comprobante electrónico de SUNAT
 * (la venta ya se declaró cuando se vendió; el abono es el cobro posterior de una deuda) y lo dice en el papel.
 *
 * ─── EL NÚMERO ───────────────────────────────────────────────────────────
 *
 * `AB-AAAAMMDD-XXXXXX`: el día (en la zona del negocio) y los últimos 6 caracteres del identificador del abono. No es correlativo
 * —no hay contador de recibos— pero es único para cada abono, estable (el mismo en toda reimpresión) y se puede buscar. Lo que importa
 * en el mostrador es poder decir «mi recibo AB-…» y encontrar el abono.
 *
 * ─── LA DEUDA RESTANTE ───────────────────────────────────────────────────
 *
 * Se lee del registro de auditoría del abono, donde se guardó EN EL MOMENTO de cobrarlo. Reimprimir días después sigue diciendo lo que
 * quedaba aquella tarde, no la deuda de hoy (que cambió con ventas y otros abonos). Si ese registro faltara, la línea se omite.
 */

const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0)

export interface ReciboAbono {
  numero: string
  /** Instante del cobro, ISO. */
  fecha: string
  zonaHoraria: string
  locale: string
  emisor: { nombre: string; razonSocial: string | null; ruc: string | null; direccion: string | null; telefono: string | null }
  cliente: { nombre: string; docEtiqueta: string | null; docNumero: string | null }
  cobradoPor: string
  metodo: string
  referencia: string | null
  monto: number
  /** A qué ventas se aplicó, con lo aplicado a cada una. */
  reparto: { venta: string; monto: number }[]
  /** Lo que el cliente seguía debiendo al terminar este abono, o `null` si no consta. */
  deudaDespues: number | null
  anulado: boolean
  motivoAnulacion: string | null
}

export function numeroDeRecibo(id: string, fechaLocal: string): string {
  return `AB-${fechaLocal.replaceAll('-', '')}-${id.slice(-6).toUpperCase()}`
}

export async function getReciboAbono(db: TenantPrismaClient, ctx: TenantContext, paymentId: string): Promise<ReciboAbono> {
  if (!puedeVerClientes(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver los recibos de abono.')
  const pago = await db.customerPayment.findFirst({
    where: { id: paymentId },
    select: {
      id: true, amount: true, method: true, reference: true, receivedAt: true, voidedAt: true, voidReason: true,
      user: { select: { name: true, email: true } },
      customer: { select: { name: true, docType: true, docNumber: true } },
      allocations: { orderBy: { createdAt: 'asc' }, select: { amount: true, receivable: { select: { sale: { select: { number: true } } } } } },
    },
  })
  if (!pago) throw new BusinessError('NOT_FOUND', 'El abono no existe.')

  const [t, auditoria] = await Promise.all([
    db.tenant.findFirstOrThrow({ select: { name: true, legalName: true, taxId: true, address: true, phone: true, timezone: true, locale: true } }),
    db.auditLog.findFirst({ where: { action: 'credito.abono', entityId: pago.id }, select: { after: true } }),
  ])
  const despues = (auditoria?.after as { deudaDespues?: unknown } | null)?.deudaDespues
  return {
    numero: numeroDeRecibo(pago.id, diaLocal(t.timezone, pago.receivedAt)),
    fecha: pago.receivedAt.toISOString(), zonaHoraria: t.timezone, locale: t.locale,
    emisor: { nombre: t.name, razonSocial: t.legalName, ruc: t.taxId, direccion: t.address, telefono: t.phone },
    cliente: {
      nombre: pago.customer.name,
      docEtiqueta: pago.customer.docNumber ? pago.customer.docType : null, docNumero: pago.customer.docNumber,
    },
    cobradoPor: pago.user.name ?? pago.user.email, metodo: pago.method, referencia: pago.reference, monto: num(pago.amount),
    reparto: pago.allocations.map((a) => ({ venta: a.receivable.sale.number, monto: num(a.amount) })),
    deudaDespues: typeof despues === 'number' ? despues : null,
    anulado: pago.voidedAt !== null, motivoAnulacion: pago.voidReason,
  }
}
