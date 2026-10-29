import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { redondearCentimos } from '@/lib/dinero'
import type { CloseCashInput, OpenCashInput } from './cash-schemas'
import { exigir, puede } from '@/lib/puede'
import { vencerPedidosDeSucursal } from '@/features/pos/pedido-expiracion'
import { bloquearTurno } from './queries'

const P2002_UNIQUE = 'P2002'
const num = (v: unknown): number => Number(v ?? 0)

export interface CashSessionResult {
  id: string
  branchId: string
  status: 'ABIERTA' | 'CERRADA'
  openingAmount: number
  openedAt: string
}

export interface CashCloseResult extends CashSessionResult {
  countedAmount: number
  expectedAmount: number
  /** contado − esperado. Negativo es faltante; positivo, sobrante. */
  difference: number
  salesCount: number
  salesTotal: number
  cashTotal: number
  changeTotal: number
  /** Vendido a crédito en el turno: NO entró al cajón. */
  creditSalesTotal: number
  /** Abonos de deuda cobrados en efectivo: SÍ entraron al cajón y suman al esperado. */
  cashReceiptsTotal: number
  /** Abonos de deuda por otros medios (Yape, transferencia…): no entraron al cajón. */
  otherReceiptsTotal: number
  /** Pagos a proveedores en EFECTIVO: SALIERON del cajón y restan al esperado. */
  supplierCashPaymentsTotal: number
  /** Pagos a proveedores por otros medios (transferencia, Yape…): no tocaron el cajón. */
  supplierOtherPaymentsTotal: number
  /** Devoluciones de ventas pagadas en EFECTIVO desde el cajón este turno: SALIERON del cajón y restan al esperado. */
  refundsCashTotal: number
  /** Devoluciones por otro medio o sin salida de dinero: no tocaron el cajón. */
  refundsOtherTotal: number
  /** Ingresos manuales de efectivo (F6.3): SUMAN al esperado. */
  manualInTotal: number
  /** Egresos manuales de efectivo (F6.3): RESTAN al esperado. */
  manualOutTotal: number
  /** Los mismos movimientos, separados para enseñarlos (gastos, compensaciones en efectivo, compensaciones informativas). */
  movimientos: DesgloseMovimientos
  closedAt: string
}

/**
 * Los movimientos manuales de un turno (no anulados), separados para enseñarlos con claridad (F6.3c):
 *  · `ingresos`: efectivo que entró a mano (SUMA al esperado).
 *  · `egresos`: efectivo que salió a mano por gastos, retiros, correcciones (RESTA).
 *  · `compensacionesEfectivo`: lo que salió del cajón para compensar abonos anulados de turnos ya cerrados (RESTA).
 *  · `compensacionesOtrosMedios`: compensaciones de abonos que NO fueron en efectivo: solo informativo, no tocan el cajón.
 * `ingresos` y `egresos + compensacionesEfectivo` son exactamente `manualInTotal` y `manualOutTotal` del turno.
 */
export interface DesgloseMovimientos {
  ingresos: number
  egresos: number
  compensacionesEfectivo: number
  compensacionesOtrosMedios: number
}

export async function desgloseDeMovimientos(t: TenantPrismaClient, sessionId: string): Promise<DesgloseMovimientos> {
  const filas = await t.cashMovement.findMany({ where: { cashSessionId: sessionId, voidedAt: null }, select: { kind: true, category: true, method: true, amount: true } })
  const r: DesgloseMovimientos = { ingresos: 0, egresos: 0, compensacionesEfectivo: 0, compensacionesOtrosMedios: 0 }
  for (const m of filas) {
    const monto = num(m.amount)
    if (m.category === 'COMPENSACION_ABONO') {
      if (m.method === 'EFECTIVO') r.compensacionesEfectivo = redondearCentimos(r.compensacionesEfectivo + monto)
      else r.compensacionesOtrosMedios = redondearCentimos(r.compensacionesOtrosMedios + monto)
    } else if (m.kind === 'INGRESO') r.ingresos = redondearCentimos(r.ingresos + monto)
    else r.egresos = redondearCentimos(r.egresos + monto)
  }
  return r
}

export interface TotalesTurno {
  salesCount: number
  salesTotal: number
  cashTotal: number
  changeTotal: number
  creditSalesTotal: number
  cashReceiptsTotal: number
  otherReceiptsTotal: number
  supplierCashPaymentsTotal: number
  supplierOtherPaymentsTotal: number
  refundsCashTotal: number
  refundsOtherTotal: number
  manualInTotal: number
  manualOutTotal: number
}

/**
 * Lo que debería haber en el cajón: fondo + cobros en efectivo + abonos de deuda en efectivo + ingresos manuales − vueltos − pagos a proveedores en
 * efectivo − devoluciones de ventas pagadas desde el cajón − egresos manuales. El fiado no entra; las transferencias y el Yape (a clientes o a proveedores) tampoco.
 */
export function efectivoEsperado(
  fondo: number,
  t: Pick<TotalesTurno, 'cashTotal' | 'cashReceiptsTotal' | 'changeTotal' | 'supplierCashPaymentsTotal' | 'refundsCashTotal' | 'manualInTotal' | 'manualOutTotal'>,
): number {
  return redondearCentimos(fondo + t.cashTotal + t.cashReceiptsTotal + t.manualInTotal - t.changeTotal - t.supplierCashPaymentsTotal - t.refundsCashTotal - t.manualOutTotal)
}

/**
 * Totales de un turno, calculados desde las ventas que SE COBRARON en él, sus abonos NO anulados, los pagos a proveedores y las devoluciones.
 *
 * Las ventas cuentan por lo RECIBIDO, no por su estado de hoy: una venta que luego se anula o se devuelve (`ANULADA`/`DEVUELTA`) sigue
 * contando en el turno donde entró el dinero, y el dinero devuelto SALE en el turno abierto cuando se devuelve (`refundsCashTotal`). Así
 * un turno CERRADO no cambia nunca aunque mañana se devuelva una de sus ventas (sus columnas congeladas siguen coincidiendo con este cálculo),
 * y devolver una venta en el mismo turno en que se hizo deja el efectivo neto en cero.
 *
 * Una sola función para el cierre (que los congela) y para la consulta en vivo (que los recalcula), de modo que lo que el cajero ve
 * mientras trabaja y lo que queda firmado al cerrar salgan de las mismas reglas.
 */
export async function totalesDelTurno(t: TenantPrismaClient, sessionId: string): Promise<TotalesTurno> {
  const ventas = await t.sale.findMany({
    where: { cashSessionId: sessionId, status: { in: ['COMPLETADA', 'ANULADA', 'DEVUELTA'] } },
    select: { total: true, payments: { select: { method: true, amount: true, change: true } } },
  })
  const abonos = await t.customerPayment.findMany({
    where: { cashSessionId: sessionId, voidedAt: null },
    select: { method: true, amount: true },
  })

  const pagosProveedor = await t.supplierPayment.findMany({
    where: { cashSessionId: sessionId, voidedAt: null },
    select: { method: true, amount: true },
  })

  const devoluciones = await t.saleReturnRefund.findMany({
    where: { cashSessionId: sessionId },
    select: { mode: true, amount: true },
  })

  // Movimientos manuales de efectivo del turno que NO se anularon (F6.3). Los anulados quedan en el registro pero no cuentan.
  const movimientos = await t.cashMovement.findMany({
    // Solo el EFECTIVO mueve el cajón: la compensación de un abono que no fue en efectivo (F6.3b) queda registrada pero no cuenta aquí.
    where: { cashSessionId: sessionId, voidedAt: null, method: 'EFECTIVO' },
    select: { kind: true, amount: true },
  })

  const r: TotalesTurno = {
    salesCount: ventas.length, salesTotal: 0, cashTotal: 0, changeTotal: 0,
    creditSalesTotal: 0, cashReceiptsTotal: 0, otherReceiptsTotal: 0,
    supplierCashPaymentsTotal: 0, supplierOtherPaymentsTotal: 0,
    refundsCashTotal: 0, refundsOtherTotal: 0, manualInTotal: 0, manualOutTotal: 0,
  }
  for (const v of ventas) {
    r.salesTotal = redondearCentimos(r.salesTotal + num(v.total))
    for (const p of v.payments) {
      if (p.method === 'EFECTIVO') r.cashTotal = redondearCentimos(r.cashTotal + num(p.amount))
      if (p.method === 'CREDITO') r.creditSalesTotal = redondearCentimos(r.creditSalesTotal + num(p.amount))
      // El vuelto se guarda solo en líneas de EFECTIVO (`pagos.ts`): sale del cajón.
      r.changeTotal = redondearCentimos(r.changeTotal + num(p.change))
    }
  }
  for (const a of abonos) {
    if (a.method === 'EFECTIVO') r.cashReceiptsTotal = redondearCentimos(r.cashReceiptsTotal + num(a.amount))
    else r.otherReceiptsTotal = redondearCentimos(r.otherReceiptsTotal + num(a.amount))
  }
  for (const p of pagosProveedor) {
    if (p.method === 'EFECTIVO') r.supplierCashPaymentsTotal = redondearCentimos(r.supplierCashPaymentsTotal + num(p.amount))
    else r.supplierOtherPaymentsTotal = redondearCentimos(r.supplierOtherPaymentsTotal + num(p.amount))
  }
  for (const m of movimientos) {
    if (m.kind === 'INGRESO') r.manualInTotal = redondearCentimos(r.manualInTotal + num(m.amount))
    else r.manualOutTotal = redondearCentimos(r.manualOutTotal + num(m.amount))
  }
  for (const d of devoluciones) {
    if (d.mode === 'CAJA') r.refundsCashTotal = redondearCentimos(r.refundsCashTotal + num(d.amount))
    else r.refundsOtherTotal = redondearCentimos(r.refundsOtherTotal + num(d.amount))
  }
  return r
}

/**
 * Abre el turno de caja de la sucursal.
 *
 * Los índices parciales de `cash_sessions` (uno por caja, uno por persona y, para los turnos sin caja, uno por sucursal; F6.8) garantizan que no
 * haya dos turnos abiertos en el mismo local. Es la base de datos la que lo
 * impide, no esta función: dos cajeros pulsando "abrir" a la vez pasarían los
 * dos por cualquier comprobación previa, y entonces las ventas se repartirían
 * entre dos turnos y los dos arqueos cuadrarían por separado estando el
 * conjunto descuadrado.
 */
export async function openCashSession(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: OpenCashInput,
): Promise<CashSessionResult> {
  // El cajero es justamente quien abre su propia caja.
  if (!puede(ctx, 'caja.abrir_cerrar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para abrir caja.')
  }
  const branchId = requireBranch(ctx)

  try {
    const s = await db.cashSession.create({
      data: {
        tenantId: ctx.tenantId,
        branchId,
        openedById: ctx.userId,
        status: 'ABIERTA',
        openingAmount: new Prisma.Decimal(input.openingAmount.toFixed(2)),
        openingNotes: input.notes ?? null,
      },
      select: { id: true, branchId: true, status: true, openingAmount: true, openedAt: true },
    })

    await db.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorRole: ctx.role,
        action: 'cash.open',
        entityType: 'CashSession',
        entityId: s.id,
        after: { branchId, openingAmount: input.openingAmount },
        impersonationId: ctx.impersonationId ?? null,
      },
    })

    return {
      id: s.id,
      branchId: s.branchId,
      status: s.status,
      openingAmount: num(s.openingAmount),
      openedAt: s.openedAt.toISOString(),
    }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
      throw new BusinessError(
        'DUPLICATE_CODE',
        'Ya hay una caja abierta en esta sucursal. Ciérrala antes de abrir otra.',
      )
    }
    throw e
  }
}

/**
 * Cierra el turno y practica el arqueo.
 *
 * El esperado se calcula sumando los PAGOS EN EFECTIVO de las ventas del
 * turno y restando los vueltos entregados. No se usa el total de las ventas:
 * una venta pagada con Yape no pone un sol en el cajón, y contarla haría que
 * todo turno con pagos digitales saliera faltante por ese importe.
 *
 * El resultado se congela en la fila. Si se recalculara al leer, anular una
 * venta mañana cambiaría el arqueo de un turno que el cajero ya firmó hoy, y
 * el arqueo dejaría de probar nada.
 */
export async function closeCashSession(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: CloseCashInput,
): Promise<CashCloseResult> {
  if (!puede(ctx, 'caja.abrir_cerrar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para cerrar caja.')
  }

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient

    const sesion = await t.cashSession.findFirst({
      where: { id: input.sessionId },
      select: {
        id: true, branchId: true, status: true, openingAmount: true,
        openedAt: true, openedById: true,
      },
    })
    if (!sesion) throw new BusinessError('NOT_FOUND', 'El turno de caja no existe.')
    if (sesion.status === 'CERRADA') {
      throw new BusinessError('INVALID_DOCUMENT', 'Ese turno ya está cerrado.')
    }

    /*
     * Un cajero cierra SU turno; un ADMIN puede cerrar el de cualquiera —hace
     * falta para el turno que alguien se dejó abierto al irse a casa.
     */
    if (sesion.openedById !== ctx.userId && !puede(ctx, 'caja.cerrar_ajeno')) {
      throw new BusinessError(
        'FORBIDDEN_ROLE',
        'Solo quien abrió el turno, o quien supervisa la caja, puede cerrarlo.',
      )
    }

    /*
     * Se bloquea el turno ANTES de sumar. Un abono que se registra o se anula a la vez espera aquí (los abonos bloquean el turno
     * antes de escribir) y, cuando llega, lo ve cerrado; así no hay abonos que entren después de congelar los totales. Dos cierres
     * simultáneos también se serializan: el segundo ve el turno ya cerrado.
     */
    if ((await bloquearTurno(t, sesion.id)).status === 'CERRADA') {
      throw new BusinessError('INVALID_DOCUMENT', 'Ese turno ya está cerrado.')
    }

    // Ventas cobradas en el turno (aunque luego se hayan devuelto: su devolución sale en el turno donde se hace), abonos NO anulados y devoluciones.
    const tot = await totalesDelTurno(t, sesion.id)
    const {
      salesCount, salesTotal, cashTotal, changeTotal, creditSalesTotal, cashReceiptsTotal, otherReceiptsTotal,
      supplierCashPaymentsTotal, supplierOtherPaymentsTotal, refundsCashTotal, refundsOtherTotal, manualInTotal, manualOutTotal,
    } = tot

    const openingAmount = num(sesion.openingAmount)
    const expectedAmount = efectivoEsperado(openingAmount, tot)
    const difference = redondearCentimos(input.countedAmount - expectedAmount)
    const cerrado = new Date()

    const s = await t.cashSession.update({
      where: { id: sesion.id },
      data: {
        status: 'CERRADA',
        closedById: ctx.userId,
        closedAt: cerrado,
        countedAmount: new Prisma.Decimal(input.countedAmount.toFixed(2)),
        expectedAmount: new Prisma.Decimal(expectedAmount.toFixed(2)),
        difference: new Prisma.Decimal(difference.toFixed(2)),
        salesCount,
        salesTotal: new Prisma.Decimal(salesTotal.toFixed(2)),
        cashTotal: new Prisma.Decimal(cashTotal.toFixed(2)),
        changeTotal: new Prisma.Decimal(changeTotal.toFixed(2)),
        creditSalesTotal: new Prisma.Decimal(creditSalesTotal.toFixed(2)),
        cashReceiptsTotal: new Prisma.Decimal(cashReceiptsTotal.toFixed(2)),
        otherReceiptsTotal: new Prisma.Decimal(otherReceiptsTotal.toFixed(2)),
        supplierCashPaymentsTotal: new Prisma.Decimal(supplierCashPaymentsTotal.toFixed(2)),
        supplierOtherPaymentsTotal: new Prisma.Decimal(supplierOtherPaymentsTotal.toFixed(2)),
        refundsCashTotal: new Prisma.Decimal(refundsCashTotal.toFixed(2)),
        refundsOtherTotal: new Prisma.Decimal(refundsOtherTotal.toFixed(2)),
        manualInTotal: new Prisma.Decimal(manualInTotal.toFixed(2)),
        manualOutTotal: new Prisma.Decimal(manualOutTotal.toFixed(2)),
        closingNotes: input.notes ?? null,
      },
      select: { id: true, branchId: true, status: true, openedAt: true },
    })

    // Los pedidos a caja que nadie cobró vencen con el cierre: no deben sobrevivir al turno.
    const pedidosVencidos = await vencerPedidosDeSucursal(t, s.branchId)

    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorRole: ctx.role,
        action: difference === 0 ? 'cash.close' : 'cash.close.descuadre',
        entityType: 'CashSession',
        entityId: sesion.id,
        // El descuadre va al log SIEMPRE, no solo cuando alguien lo mira:
        // es el dato que se consulta cuando falta dinero semanas después.
        after: {
          esperado: expectedAmount,
          contado: input.countedAmount,
          diferencia: difference,
          ventas: salesCount,
          fiado: creditSalesTotal,
          abonosEfectivo: cashReceiptsTotal,
          abonosOtros: otherReceiptsTotal,
          pagosProveedorEfectivo: supplierCashPaymentsTotal,
          pagosProveedorOtros: supplierOtherPaymentsTotal,
          devolucionesEfectivo: refundsCashTotal,
          devolucionesOtros: refundsOtherTotal,
          ingresosManuales: manualInTotal,
          egresosManuales: manualOutTotal,
          pedidosVencidos,
        },
        reason: input.notes ?? null,
        impersonationId: ctx.impersonationId ?? null,
      },
    })

    return {
      id: s.id,
      branchId: s.branchId,
      status: s.status,
      openingAmount,
      openedAt: s.openedAt.toISOString(),
      countedAmount: input.countedAmount,
      expectedAmount,
      difference,
      salesCount,
      salesTotal,
      cashTotal,
      changeTotal,
      creditSalesTotal,
      cashReceiptsTotal,
      otherReceiptsTotal,
      supplierCashPaymentsTotal,
      supplierOtherPaymentsTotal,
      refundsCashTotal,
      refundsOtherTotal,
      manualInTotal,
      manualOutTotal,
      movimientos: await desgloseDeMovimientos(t, sesion.id),
      closedAt: cerrado.toISOString(),
    }
  }, { maxWait: 15_000, timeout: 30_000 })
}

/**
 * Estado del turno en curso, con el esperado calculado al vuelo.
 *
 * Esto SÍ se recalcula a cada consulta, al contrario que el cierre: mientras
 * el turno está abierto el cajero necesita saber cuánto debería haber AHORA.
 */
export async function currentCashSession(
  db: TenantPrismaClient,
  ctx: TenantContext,
): Promise<(CashSessionResult & { expectedAmount: number; salesCount: number; refundsCashTotal: number; refundsOtherTotal: number; manualInTotal: number; manualOutTotal: number; movimientos: DesgloseMovimientos }) | null> {
  const branchId = requireBranch(ctx)

  const s = await db.cashSession.findFirst({
    where: { branchId, status: 'ABIERTA' },
    select: { id: true, branchId: true, status: true, openingAmount: true, openedAt: true },
  })
  if (!s) return null

  const tot = await totalesDelTurno(db, s.id)
  return {
    id: s.id,
    branchId: s.branchId,
    status: s.status,
    openingAmount: num(s.openingAmount),
    openedAt: s.openedAt.toISOString(),
    expectedAmount: efectivoEsperado(num(s.openingAmount), tot),
    salesCount: tot.salesCount,
    refundsCashTotal: tot.refundsCashTotal,
    refundsOtherTotal: tot.refundsOtherTotal,
    manualInTotal: tot.manualInTotal,
    manualOutTotal: tot.manualOutTotal,
    movimientos: await desgloseDeMovimientos(db, s.id),
  }
}

/**
 * Activa o desactiva «caja obligatoria» para todo el negocio.
 *
 * Es política del negocio, no del cajero: la decide quien administra
 * sucursales. Queda auditado con el valor anterior.
 */
export async function configurarCajaObligatoria(
  db: TenantPrismaClient,
  ctx: TenantContext,
  activo: boolean,
): Promise<void> {
  exigir(ctx, 'sucursales.gestionar')
  const antes = await db.tenant.findFirstOrThrow({ select: { id: true, cashRequired: true } })
  if (antes.cashRequired === activo) return
  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    await t.tenant.update({ where: { id: antes.id }, data: { cashRequired: activo } })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorRole: ctx.role,
        action: 'caja.obligatoria',
        entityType: 'Tenant',
        entityId: antes.id,
        before: { cashRequired: antes.cashRequired },
        after: { cashRequired: activo },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
  })
}
