import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { P2002_UNIQUE } from '@/lib/prisma-errors'
import { exigir } from '@/lib/puede'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { bloquearTurno, bloquearTurnoPropio, exigirTurnoPropio } from '@/features/branches/queries'
import { efectivoEsperado, totalesDelTurno } from '@/features/branches/cash-service'
import { repartirAbono } from '@/features/credito/reglas'
import { bloquearProveedor } from '@/features/proveedores/service'
import { MENSAJE_PAGO_SIN_CAJA, MENSAJE_PAGO_SIN_DEUDA, mensajePagoExcede } from './pago-ui'
import type { AnularPagoInput, PrevisualizarPagoInput, RegistrarPagoInput } from './schemas'

/**
 * Pagos a proveedores. Mismo guion que los abonos de clientes, al revés: aquí el dinero SALE.
 *
 *  · Todo empieza BLOQUEANDO AL PROVEEDOR (`bloquearProveedor`) y, después, el turno de caja. Mismo orden que las compras: no hay abrazos.
 *  · Un pago en EFECTIVO sale del cajón: exige un TURNO ABIERTO y se BLOQUEA si supera el efectivo que debería haber (la caja no puede
 *    quedar en negativo). Con otro medio no toca el cajón; si hay turno abierto, queda enlazado para el reporte.
 *  · Se reparte entre las cuentas del proveedor, la más antigua primero (o las elegidas, en ese orden) con `repartirAbono`: la MISMA
 *    función pura que usa la pantalla, así lo que se ve antes de pagar es lo que se registra.
 *  · Un pago nunca supera lo que se le debe en las cuentas a las que se aplica.
 *  · Idempotente: la clave es obligatoria. El mismo envío repetido devuelve el pago original.
 *  · Un turno CERRADO es inmutable: un pago enlazado a él no se anula (el arqueo ya firmado no se reescribe).
 */

const aCentimos = (n: number) => Math.round(n * 100)
const deCentimos = (c: number) => c / 100
const num = (d: { toString(): string } | number | null | undefined) => Number(d?.toString() ?? 0)
const invalido = (m: string, d?: Record<string, string | number>) => new BusinessError('INVALID_DOCUMENT', m, d)
const noExiste = (que: string) => new BusinessError('NOT_FOUND', `${que} no existe.`)
const OPCIONES_TX = { maxWait: 15_000, timeout: 30_000 } as const

export interface RepartoPago {
  payableId: string
  /** N.º de la compra que originó la deuda. */
  compra: string
  monto: number
  saldoDespues: number
  pagada: boolean
}

export interface PagoRegistrado {
  paymentId: string
  supplierId: string
  method: string
  monto: number
  reparto: RepartoPago[]
  /** `null` en un reintento: lo que valía antes ya no se puede reconstruir. */
  deudaAntes: number | null
  /** En un reintento es la deuda ACTUAL del proveedor. */
  deudaDespues: number
  replayed: boolean
}

async function pagoPorClave(t: TenantPrismaClient, idempotencyKey: string): Promise<PagoRegistrado | null> {
  const p = await t.supplierPayment.findFirst({
    where: { idempotencyKey },
    select: {
      id: true, supplierId: true, method: true, amount: true,
      supplier: { select: { payableBalance: true } },
      allocations: { select: { payableId: true, amount: true, payable: { select: { amount: true, paidAmount: true, status: true, purchase: { select: { number: true } } } } } },
    },
  })
  if (!p) return null
  return {
    paymentId: p.id, supplierId: p.supplierId, method: p.method, monto: num(p.amount),
    reparto: p.allocations.map((a) => ({
      payableId: a.payableId, compra: a.payable.purchase.number, monto: num(a.amount),
      saldoDespues: deCentimos(aCentimos(num(a.payable.amount)) - aCentimos(num(a.payable.paidAmount))), pagada: a.payable.status === 'PAGADA',
    })),
    deudaAntes: null, deudaDespues: num(p.supplier.payableBalance), replayed: true,
  }
}

const SELECCION_CUENTA = { id: true, amount: true, paidAmount: true, dueDate: true, purchase: { select: { number: true } } } as const

async function cuentasAbiertas(t: TenantPrismaClient, supplierId: string, ids?: readonly string[]) {
  const abiertas = await t.accountPayable.findMany({
    where: { supplierId, status: 'ABIERTA' },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: SELECCION_CUENTA,
  })
  if (!ids) return abiertas
  const porId = new Map(abiertas.map((c) => [c.id, c]))
  return ids.map((id) => {
    const c = porId.get(id)
    if (!c) throw invalido('Una de las cuentas elegidas no está abierta o no es de este proveedor.')
    return c
  })
}

const saldoDe = (c: { amount: Prisma.Decimal; paidAmount: Prisma.Decimal }) => aCentimos(num(c.amount)) - aCentimos(num(c.paidAmount))

// ─── Registrar ──────────────────────────────────────────────────────────────────────────────────────────────────────

export async function registrarPagoProveedor(db: TenantPrismaClient, ctx: TenantContext, input: RegistrarPagoInput): Promise<PagoRegistrado> {
  exigir(ctx, 'proveedores.pagar')
  const branchId = requireBranch(ctx)

  const previo = await pagoPorClave(db, input.idempotencyKey)
  if (previo) return previo

  // Turno PROPIO obligatorio con cualquier medio (F6.8b). Aviso rápido, sin bloquear nada; la comprobación de verdad se repite dentro de la transacción, con el turno bloqueado.
  await exigirTurnoPropio(db, ctx, branchId, 'registrar un pago a proveedor')

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      const proveedor = await bloquearProveedor(t, input.supplierId)   // ← siempre lo primero
      const dup = await pagoPorClave(t, input.idempotencyKey)           // dos envíos a la vez: el segundo llega aquí tras esperar el bloqueo
      if (dup) return dup
      if (proveedor.deletedAt) throw noExiste('El proveedor')

      // El turno propio se bloquea DESPUÉS del proveedor. Si su cierre ya empezó, esperamos y lo vemos CERRADO: ningún pago se cuela en un turno cuyos totales ya se congelaron.
      const turno = await bloquearTurnoPropio(t, ctx, branchId, 'registrar un pago a proveedor')
      if (input.method === 'EFECTIVO') {
        // Con el turno bloqueado nada más mueve el cajón: lo esperado es firme. La caja no puede quedar en negativo.
        const s = await t.cashSession.findFirstOrThrow({ where: { id: turno }, select: { openingAmount: true } })
        const esperado = efectivoEsperado(num(s.openingAmount), await totalesDelTurno(t, turno))
        if (aCentimos(input.amount) > aCentimos(esperado)) {
          throw invalido(
            `No hay suficiente efectivo en la caja: debería haber S/ ${esperado.toFixed(2)} y el pago es de S/ ${input.amount.toFixed(2)}. Paga por transferencia o registra primero el ingreso a caja.`,
            { esperado, pago: input.amount },
          )
        }
      }

      const destino = await cuentasAbiertas(t, input.supplierId, input.payableIds)
      const saldos = destino.map(saldoDe)
      const deudaElegida = saldos.reduce((a, b) => a + b, 0)
      if (deudaElegida <= 0) throw invalido(MENSAJE_PAGO_SIN_DEUDA)
      const M = aCentimos(input.amount)
      if (M > deudaElegida) {
        throw invalido(
          mensajePagoExcede(deCentimos(M), deCentimos(deudaElegida), !!input.payableIds),
          { pago: deCentimos(M), deuda: deCentimos(deudaElegida) },
        )
      }

      const pago = await t.supplierPayment.create({
        data: {
          tenantId: ctx.tenantId, supplierId: input.supplierId, branchId, cashSessionId: turno, userId: ctx.userId,
          method: input.method, amount: deCentimos(M), reference: input.reference ?? null, notes: input.notes ?? null,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })

      const reparto: RepartoPago[] = []
      for (const parte of repartirAbono(saldos.map(deCentimos), deCentimos(M)).partes) {
        const c = destino[parte.indice]!
        const a = aCentimos(parte.monto)
        const pagado = aCentimos(num(c.paidAmount)) + a
        await t.supplierPaymentAllocation.create({ data: { tenantId: ctx.tenantId, supplierPaymentId: pago.id, payableId: c.id, amount: deCentimos(a) }, select: { id: true } })
        await t.accountPayable.update({
          where: { id: c.id },
          data: parte.pagada ? { paidAmount: deCentimos(pagado), status: 'PAGADA', closedAt: new Date() } : { paidAmount: deCentimos(pagado) },
          select: { id: true },
        })
        reparto.push({ payableId: c.id, compra: c.purchase.number, monto: parte.monto, saldoDespues: deCentimos(aCentimos(num(c.amount)) - pagado), pagada: parte.pagada })
      }

      await t.supplier.update({ where: { id: input.supplierId }, data: { payableBalance: { decrement: deCentimos(M) } }, select: { id: true } })
      const deudaAntes = proveedor.payableBalance
      const deudaDespues = deCentimos(aCentimos(deudaAntes) - M)
      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'proveedor.pago', entityType: 'SupplierPayment', entityId: pago.id,
          after: { proveedor: proveedor.name, monto: deCentimos(M), metodo: input.method, turno, reparto: reparto.map((r) => ({ compra: r.compra, monto: r.monto, pagada: r.pagada })), deudaAntes, deudaDespues },
          impersonationId: ctx.impersonationId ?? null,
        },
      })
      return { paymentId: pago.id, supplierId: input.supplierId, method: input.method, monto: deCentimos(M), reparto, deudaAntes, deudaDespues, replayed: false }
    }, OPCIONES_TX)
  } catch (e) {
    // Dos envíos simultáneos con la misma clave: uno ganó el índice único y el otro se deshizo entero. Solo si de verdad existe.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
      const ganador = await pagoPorClave(db, input.idempotencyKey)
      if (ganador) return ganador
    }
    throw e
  }
}

// ─── Anular ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function anularPagoProveedor(db: TenantPrismaClient, ctx: TenantContext, input: AnularPagoInput): Promise<{ paymentId: string; deudaDespues: number; replayed: boolean }> {
  exigir(ctx, 'proveedores.pagar')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const previo = await t.supplierPayment.findFirst({ where: { id: input.paymentId }, select: { supplierId: true } })
    if (!previo) throw noExiste('El pago')
    const proveedor = await bloquearProveedor(t, previo.supplierId)   // ← primero; luego se vuelve a leer el pago con el estado ya firme

    const pago = await t.supplierPayment.findFirst({
      where: { id: input.paymentId },
      select: { id: true, amount: true, voidedAt: true, cashSessionId: true, allocations: { select: { payableId: true, amount: true } } },
    })
    if (!pago) throw noExiste('El pago')
    if (pago.voidedAt) return { paymentId: pago.id, deudaDespues: proveedor.payableBalance, replayed: true }

    // Se bloquea el turno antes de decidir: si su cierre está en marcha, esperamos y lo vemos cerrado.
    const turno = pago.cashSessionId ? await bloquearTurno(t, pago.cashSessionId) : null
    if (turno && turno.status !== 'ABIERTA') {
      throw invalido('El turno de caja de este pago ya cerró y un turno cerrado no se modifica: haz el ajuste como ingreso o egreso manual justificado por la administración.')
    }
    if (proveedor.deletedAt) throw new BusinessError('CREDIT_BLOCKED', 'El proveedor está dado de baja: no se puede reabrir su deuda.')

    let restituido = 0
    for (const a of pago.allocations) {
      const c = await t.accountPayable.findFirst({ where: { id: a.payableId }, select: { amount: true, paidAmount: true, status: true } })
      if (!c) throw noExiste('La cuenta')
      const monto = aCentimos(num(a.amount))
      const pagado = aCentimos(num(c.paidAmount)) - monto
      await t.accountPayable.update({
        where: { id: a.payableId },
        data: c.status === 'PAGADA' ? { paidAmount: deCentimos(pagado), status: 'ABIERTA', closedAt: null } : { paidAmount: deCentimos(pagado) },
        select: { id: true },
      })
      // Una cuenta ANULADA no cuenta en la deuda: devolverle lo pagado no la reabre ni toca el saldo.
      if (c.status !== 'ANULADA') restituido += monto
    }
    if (restituido > 0) {
      await t.supplier.update({ where: { id: previo.supplierId }, data: { payableBalance: { increment: deCentimos(restituido) } }, select: { id: true } })
    }
    await t.supplierPayment.update({ where: { id: pago.id }, data: { voidedAt: new Date(), voidedById: ctx.userId, voidReason: input.motivo }, select: { id: true } })
    const deudaDespues = deCentimos(aCentimos(proveedor.payableBalance) + restituido)
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'proveedor.pago_anulado', entityType: 'SupplierPayment', entityId: pago.id,
        reason: input.motivo, after: { proveedor: proveedor.name, monto: num(pago.amount), restituido: deCentimos(restituido), deudaAntes: proveedor.payableBalance, deudaDespues },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
    return { paymentId: pago.id, deudaDespues, replayed: false }
  }, OPCIONES_TX)
}

// ─── Vista previa ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface VistaPreviaPago {
  deuda: number
  reparto: { payableId: string; compra: string; vence: string; saldo: number; monto: number; saldoDespues: number; pagada: boolean }[]
  sobrante: number
}

/** Lo que se registraría con este pago, con la MISMA función pura de reparto. No escribe nada. */
export async function previsualizarPago(db: TenantPrismaClient, ctx: TenantContext, input: PrevisualizarPagoInput): Promise<VistaPreviaPago> {
  exigir(ctx, 'proveedores.pagar')
  const p = await db.supplier.findFirst({ where: { id: input.supplierId }, select: { id: true } })
  if (!p) throw noExiste('El proveedor')
  const destino = await cuentasAbiertas(db, input.supplierId, input.payableIds)
  const saldos = destino.map(saldoDe).map(deCentimos)
  const r = repartirAbono(saldos, input.amount)
  return {
    deuda: deCentimos(saldos.reduce((a, s) => a + aCentimos(s), 0)),
    reparto: r.partes.map((x) => {
      const c = destino[x.indice]!
      return { payableId: c.id, compra: c.purchase.number, vence: c.dueDate.toISOString().slice(0, 10), saldo: saldos[x.indice]!, monto: x.monto, saldoDespues: x.saldoDespues, pagada: x.pagada }
    }),
    sobrante: r.sobrante,
  }
}
