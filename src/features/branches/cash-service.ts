import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { redondearCentimos } from '@/lib/dinero'
import type { CloseCashInput, OpenCashInput } from './cash-schemas'
import { exigir, puede } from '@/lib/puede'
import { vencerPedidosDeSucursal } from '@/features/pos/pedido-expiracion'

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
  closedAt: string
}

/**
 * Abre el turno de caja de la sucursal.
 *
 * El índice parcial `cash_sessions_una_abierta_por_sucursal` garantiza que no
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

    // Ventas del turno, con sus pagos. Las ANULADAS no cuentan: su dinero
    // salió del cajón o nunca entró.
    const ventas = await t.sale.findMany({
      where: { cashSessionId: sesion.id, status: 'COMPLETADA' },
      select: {
        total: true,
        payments: { select: { method: true, amount: true, change: true } },
      },
    })

    let salesTotal = 0
    let cashTotal = 0
    let changeTotal = 0
    for (const v of ventas) {
      salesTotal = redondearCentimos(salesTotal + num(v.total))
      for (const p of v.payments) {
        if (p.method === 'EFECTIVO') {
          cashTotal = redondearCentimos(cashTotal + num(p.amount))
        }
        // El vuelto se guarda solo en líneas de EFECTIVO (`pagos.ts`): sale del cajón.
        changeTotal = redondearCentimos(changeTotal + num(p.change))
      }
    }

    const openingAmount = num(sesion.openingAmount)
    const expectedAmount = redondearCentimos(openingAmount + cashTotal - changeTotal)
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
        salesCount: ventas.length,
        salesTotal: new Prisma.Decimal(salesTotal.toFixed(2)),
        cashTotal: new Prisma.Decimal(cashTotal.toFixed(2)),
        changeTotal: new Prisma.Decimal(changeTotal.toFixed(2)),
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
          ventas: ventas.length,
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
      salesCount: ventas.length,
      salesTotal,
      cashTotal,
      changeTotal,
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
): Promise<(CashSessionResult & { expectedAmount: number; salesCount: number }) | null> {
  const branchId = requireBranch(ctx)

  const s = await db.cashSession.findFirst({
    where: { branchId, status: 'ABIERTA' },
    select: {
      id: true, branchId: true, status: true, openingAmount: true, openedAt: true,
      sales: {
        where: { status: 'COMPLETADA' },
        select: { payments: { select: { method: true, amount: true, change: true } } },
      },
    },
  })
  if (!s) return null

  let cash = 0
  let vuelto = 0
  for (const v of s.sales) {
    for (const p of v.payments) {
      if (p.method === 'EFECTIVO') cash = redondearCentimos(cash + num(p.amount))
      vuelto = redondearCentimos(vuelto + num(p.change))
    }
  }

  return {
    id: s.id,
    branchId: s.branchId,
    status: s.status,
    openingAmount: num(s.openingAmount),
    openedAt: s.openedAt.toISOString(),
    expectedAmount: redondearCentimos(num(s.openingAmount) + cash - vuelto),
    salesCount: s.sales.length,
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
