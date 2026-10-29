import { BusinessError } from '@/lib/errors'
import { diaLocal } from '@/lib/periodos'
import { puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { desgloseDeMovimientos } from '@/features/branches/cash-service'
import { generarCsv, type CeldaCsv } from '@/lib/csv-export'
import { ETIQUETA_CATEGORIA } from '@/features/branches/cash-movement-reglas'
import { ETIQUETA_METODO, METODOS_REPORTE, type DesgloseCierre } from '@/features/branches/cierre-desglose'

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
  /** La caja en la que se trabajó (F6.8). Nula en turnos anteriores a las cajas. */
  caja: string | null
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
  /** Movimientos manuales de efectivo, congelados al cerrar: los que suman al cajón, los que restan y las compensaciones de abonos anulados. */
  ingresosManuales: number
  egresosManuales: number
  compensacionesEfectivo: number
  /** Compensaciones por otros medios: informativas, no tocaron el cajón. */
  compensacionesOtrosMedios: number
  fiado: number
  abonosOtrosMedios: number
  pagosProveedorOtrosMedios: number
  esperado: number
  contado: number
  diferencia: number
  notas: string | null
  /** La foto congelada al cerrar (Yape y Plin aparte, descuentos, devoluciones…). Nula en cierres anteriores a F6.8b: solo existen los totales. Nunca lleva costos. */
  desglose: DesgloseCierre | null
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
      refundsCashTotal: true, refundsOtherTotal: true, manualInTotal: true, manualOutTotal: true, creditSalesTotal: true, cashReceiptsTotal: true, otherReceiptsTotal: true,
      closingBreakdown: true, register: { select: { name: true } },
      branch: { select: { name: true } },
      openedBy: { select: { name: true, email: true } },
      closedBy: { select: { name: true, email: true } },
    },
  })
  if (!s || !s.closedAt) throw new BusinessError('NOT_FOUND', 'El cierre de caja no existe.')
  const t = await db.tenant.findFirstOrThrow({ select: { name: true, legalName: true, taxId: true, address: true, phone: true, timezone: true, locale: true } })
  // Un turno cerrado ya no admite movimientos ni anulaciones: el desglose es estable. Los totales congelados mandan; el desglose solo separa las compensaciones.
  const mov = await desgloseDeMovimientos(db, s.id)
  const nombre = (u: { name: string | null; email: string }) => u.name ?? u.email
  return {
    numero: numeroDeCierre(s.id, diaLocal(t.timezone, s.closedAt)),
    zonaHoraria: t.timezone, locale: t.locale,
    emisor: { nombre: t.name, razonSocial: t.legalName, ruc: t.taxId, direccion: t.address, telefono: t.phone },
    sucursal: s.branch.name, caja: s.register?.name ?? null,
    abrio: nombre(s.openedBy), cerro: s.closedBy ? nombre(s.closedBy) : null,
    abiertoEn: s.openedAt.toISOString(), cerradoEn: s.closedAt.toISOString(),
    fondoInicial: num(s.openingAmount),
    ventasCantidad: s.salesCount, ventasTotal: num(s.salesTotal),
    cobradoEfectivo: num(s.cashTotal), vueltos: num(s.changeTotal),
    abonosEfectivo: num(s.cashReceiptsTotal), pagosProveedorEfectivo: num(s.supplierCashPaymentsTotal),
    devolucionesCajon: num(s.refundsCashTotal), devolucionesOtrosMedios: num(s.refundsOtherTotal),
    ingresosManuales: num(s.manualInTotal), egresosManuales: Math.round((num(s.manualOutTotal) - mov.compensacionesEfectivo) * 100) / 100,
    compensacionesEfectivo: mov.compensacionesEfectivo, compensacionesOtrosMedios: mov.compensacionesOtrosMedios,
    fiado: num(s.creditSalesTotal), abonosOtrosMedios: num(s.otherReceiptsTotal), pagosProveedorOtrosMedios: num(s.supplierOtherPaymentsTotal),
    esperado: num(s.expectedAmount), contado: num(s.countedAmount), diferencia: num(s.difference),
    notas: s.closingNotes,
    desglose: (s.closingBreakdown as DesgloseCierre | null) ?? null,
  }
}

// ─── CSV del cierre (F6.8c) ───────────────────────────────────────────────────────────────────────

const M = (monto: number): CeldaCsv => ({ monto })

/**
 * El cierre de un turno en CSV (Excel es-PE): una fila por concepto, con su sección, la cantidad de operaciones y el monto. Sale de las mismas columnas congeladas y de la foto
 * `closingBreakdown`, así que coincide con el ticket. **Nunca lleva costos, márgenes ni valor de inventario.** Quién lo puede pedir lo decide `getTicketCierre`.
 */
export async function exportarCierreCsv(db: TenantPrismaClient, ctx: TenantContext, sessionId: string): Promise<{ nombre: string; contenido: string }> {
  const c = await getTicketCierre(db, ctx, sessionId)
  const filas: CeldaCsv[][] = []
  const f = (seccion: string, concepto: string, operaciones: number | null, monto: number | null) => filas.push([seccion, concepto, operaciones, monto === null ? null : M(monto)])
  const fecha = (iso: string) => formatearIso(iso, c.zonaHoraria)
  filas.push(['Cierre', 'Número', null, c.numero], ['Cierre', 'Sucursal', null, c.sucursal], ['Cierre', 'Caja', null, c.caja ?? '—'], ['Cierre', 'Abrió', null, c.abrio], ['Cierre', 'Cerró', null, c.cerro ?? '—'],
    ['Cierre', 'Desde', null, fecha(c.abiertoEn)], ['Cierre', 'Hasta', null, fecha(c.cerradoEn)])
  f('Cajón', 'Fondo inicial', null, c.fondoInicial); f('Cajón', 'Cobrado en efectivo', null, c.cobradoEfectivo); f('Cajón', 'Vueltos', null, c.vueltos)
  f('Cajón', 'Abonos en efectivo', null, c.abonosEfectivo); f('Cajón', 'Pagos a proveedores en efectivo', null, c.pagosProveedorEfectivo); f('Cajón', 'Devoluciones pagadas del cajón', null, c.devolucionesCajon)
  f('Cajón', 'Ingresos manuales', null, c.ingresosManuales); f('Cajón', 'Egresos manuales', null, c.egresosManuales); f('Cajón', 'Compensaciones de abonos anulados', null, c.compensacionesEfectivo)
  f('Arqueo', 'Esperado', null, c.esperado); f('Arqueo', 'Contado', null, c.contado); f('Arqueo', c.diferencia < 0 ? 'Faltante' : c.diferencia > 0 ? 'Sobrante' : 'Diferencia', null, Math.abs(c.diferencia))
  const d = c.desglose
  if (d) {
    f('Ventas', 'Ventas del turno', d.ventas.cantidad, d.ventas.total)
    for (const m of METODOS_REPORTE) if (d.ventasPorMetodo[m].operaciones > 0) f('Ventas por medio', ETIQUETA_METODO[m], d.ventasPorMetodo[m].operaciones, d.ventasPorMetodo[m].monto)
    f('Ventas', 'Cobrado neto (sin fiado, sin vueltos)', null, d.cobradoNeto)
    f('Ventas', 'Descuentos', d.ventas.descuentos.ventasConDescuento, d.ventas.descuentos.total)
    f('Ventas', 'Ventas anuladas o devueltas', d.ventas.anuladas.cantidad, d.ventas.anuladas.monto)
    if (d.ventas.bajoCosto.cantidad > 0) filas.push(['Ventas', 'Vendidas bajo el piso de margen (números de venta)', d.ventas.bajoCosto.cantidad, d.ventas.bajoCosto.ventas.join(' ')])
    for (const m of METODOS_REPORTE) if (d.devoluciones.porMetodo[m].operaciones > 0) f('Devoluciones por medio', ETIQUETA_METODO[m], d.devoluciones.porMetodo[m].operaciones, d.devoluciones.porMetodo[m].monto)
    if (d.devoluciones.sinSalida > 0) f('Devoluciones', 'Sin salida de dinero', null, d.devoluciones.sinSalida)
    for (const m of METODOS_REPORTE) if (d.abonosPorMetodo[m].operaciones > 0) f('Abonos por medio', ETIQUETA_METODO[m], d.abonosPorMetodo[m].operaciones, d.abonosPorMetodo[m].monto)
    for (const m of METODOS_REPORTE) if (d.pagosProveedorPorMetodo[m].operaciones > 0) f('Pagos a proveedores por medio', ETIQUETA_METODO[m], d.pagosProveedorPorMetodo[m].operaciones, d.pagosProveedorPorMetodo[m].monto)
    for (const [k, v] of Object.entries(d.movimientos.ingresos)) f('Ingresos manuales', ETIQUETA_CATEGORIA[k as keyof typeof ETIQUETA_CATEGORIA] ?? k, null, v)
    for (const [k, v] of Object.entries(d.movimientos.egresos)) f('Egresos manuales', ETIQUETA_CATEGORIA[k as keyof typeof ETIQUETA_CATEGORIA] ?? k, null, v)
  } else {
    f('Ventas', 'Ventas del turno', c.ventasCantidad, c.ventasTotal); f('Ventas', 'Fiado', null, c.fiado)
    filas.push(['Aviso', 'Cierre anterior al detalle por medio de pago: solo existen los totales', null, null])
  }
  return { nombre: `${c.numero}.csv`, contenido: generarCsv(['Sección', 'Concepto', 'Operaciones', 'Monto'], filas) }
}

function formatearIso(iso: string, zona: string): string {
  return new Intl.DateTimeFormat('es-PE', { timeZone: zona, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso))
}
