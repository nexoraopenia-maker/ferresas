import { BusinessError } from '@/lib/errors'
import { diaLocal } from '@/lib/periodos'
import { puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'

/**
 * Ticket de cierre de turno de caja. SOLO LECTURA y SOLO de turnos CERRADOS: lee las columnas congeladas al cerrar, de modo que una
 * reimpresión posterior (incluso tras anular una venta del turno) sale idéntica. Es un documento INTERNO, no un comprobante.
 *
 * Quién puede verlo: `caja.arqueo` (ver arqueos y descuadres) cualquier turno de sus sucursales; `caja.abrir_cerrar` solo los turnos que
 * esa persona abrió o cerró. Son dos poderes que se bastan cada uno por sí solo, no dos requisitos a la vez. Un turno que no existe, es
 * de otra sucursal u otro negocio, o no se puede ver, es el mismo NOT_FOUND (no se confirma que exista).
 *
 * Las devoluciones pagadas del cajón (modo CAJA) RESTAN del efectivo esperado y salen como línea aparte; las de otro medio o sin salida
 * son informativas y no tocan el cajón.
 */

const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0)

export interface TicketCierre {
  numero: string
  zonaHoraria: string
  locale: string
  emisor: { nombre: string; razonSocial: string | null; ruc: string | null; direccion: string | null; telefono: string | null }
  sucursal: string
  abrio: string
  cerro: string | null
  abiertoEn: string
  cerradoEn: string
  fondoInicial: number
  ventasCantidad: number
  ventasTotal: number
  cobradoEfectivo: number
  vueltos: number
  abonosEfectivo: number
  pagosProveedorEfectivo: number
  /** Devoluciones pagadas del cajón: restan del esperado. */
  devolucionesCajon: number
  /** Devoluciones por otro medio o sin salida de dinero: informativo, no tocaron el cajón. */
  devolucionesOtrosMedios: number
  fiado: number
  abonosOtrosMedios: number
  pagosProveedorOtrosMedios: number
  esperado: number
  contado: number
  diferencia: number
  notas: string | null
}

export function numeroDeCierre(id: string, fechaLocal: string): string {
  return `CC-${fechaLocal.replaceAll('-', '')}-${id.slice(-6).toUpperCase()}`
}

export async function getTicketCierre(db: TenantPrismaClient, ctx: TenantContext, sessionId: string): Promise<TicketCierre> {
  const arqueo = puede(ctx, 'caja.arqueo')
  const propio = puede(ctx, 'caja.abrir_cerrar')
  if (!arqueo && !propio) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver cierres de caja.')
  const s = await db.cashSession.findFirst({
    where: { id: sessionId, status: 'CERRADA', ...(arqueo ? {} : { OR: [{ openedById: ctx.userId }, { closedById: ctx.userId }] }) },
    select: {
      id: true, openingAmount: true, countedAmount: true, expectedAmount: true, difference: true, openedAt: true, closedAt: true, closingNotes: true,
      salesCount: true, salesTotal: true, cashTotal: true, changeTotal: true, supplierCashPaymentsTotal: true, supplierOtherPaymentsTotal: true,
      refundsCashTotal: true, refundsOtherTotal: true, creditSalesTotal: true, cashReceiptsTotal: true, otherReceiptsTotal: true,
      branch: { select: { name: true } },
      openedBy: { select: { name: true, email: true } },
      closedBy: { select: { name: true, email: true } },
    },
  })
  if (!s || !s.closedAt) throw new BusinessError('NOT_FOUND', 'El cierre de caja no existe.')
  const t = await db.tenant.findFirstOrThrow({ select: { name: true, legalName: true, taxId: true, address: true, phone: true, timezone: true, locale: true } })
  const nombre = (u: { name: string | null; email: string }) => u.name ?? u.email
  return {
    numero: numeroDeCierre(s.id, diaLocal(t.timezone, s.closedAt)),
    zonaHoraria: t.timezone, locale: t.locale,
    emisor: { nombre: t.name, razonSocial: t.legalName, ruc: t.taxId, direccion: t.address, telefono: t.phone },
    sucursal: s.branch.name,
    abrio: nombre(s.openedBy), cerro: s.closedBy ? nombre(s.closedBy) : null,
    abiertoEn: s.openedAt.toISOString(), cerradoEn: s.closedAt.toISOString(),
    fondoInicial: num(s.openingAmount),
    ventasCantidad: s.salesCount, ventasTotal: num(s.salesTotal),
    cobradoEfectivo: num(s.cashTotal), vueltos: num(s.changeTotal),
    abonosEfectivo: num(s.cashReceiptsTotal), pagosProveedorEfectivo: num(s.supplierCashPaymentsTotal),
    devolucionesCajon: num(s.refundsCashTotal), devolucionesOtrosMedios: num(s.refundsOtherTotal),
    fiado: num(s.creditSalesTotal), abonosOtrosMedios: num(s.otherReceiptsTotal), pagosProveedorOtrosMedios: num(s.supplierOtherPaymentsTotal),
    esperado: num(s.expectedAmount), contado: num(s.countedAmount), diferencia: num(s.difference),
    notas: s.closingNotes,
  }
}
