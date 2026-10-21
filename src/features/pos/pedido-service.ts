import { BusinessError } from '@/lib/errors'
import { exigir, puede } from '@/lib/puede'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import type { ConvertQuoteInput, RegisterQuoteInput } from './schemas'
import { PEDIDO_BLOQUEO_MS, vencerPedidosDelDia } from './pedido-expiracion'
import { convertQuoteToSale, registerQuote, type QuoteResult } from './quote-service'

/**
 * Venta por pedidos.
 *
 * Quien vende (`ventas.crear`) arma el pedido y lo ENVÍA A CAJA; quien cobra
 * (`ventas.cobrar`) lo toma de la cola de SU sucursal y lo cobra. Separa dos
 * responsabilidades que en un mostrador pequeño hace una sola persona y que en
 * uno grande no debe: el que arma el carrito no toca el dinero.
 *
 * Reglas:
 *  · Cola por sucursal (el cliente aislado acota por `ctx.branchIds`; aquí se
 *    exige además la sucursal ACTIVA).
 *  · Un pedido lo cobra un cajero a la vez: «tomarlo» es una reserva atómica
 *    con caducidad (5 min, renovable). Si el cajero se cae, otro lo toma.
 *  · No reserva stock: la venta lo descuenta al cobrar, con el mismo guard de
 *    siempre. Dos pedidos por la misma última unidad no se pelean hasta que se cobra.
 *  · Vence al cerrar la caja o al acabar el día (ver `pedido-expiracion.ts`).
 *  · Se cobra con los precios CONGELADOS al armarlo.
 */

const num = (v: unknown) => Number(v ?? 0)

export function crearPedido(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: RegisterQuoteInput,
  now: Date = new Date(),
): Promise<QuoteResult> {
  return registerQuote(db, ctx, input, now, 'PEDIDO')
}

export interface PedidoEnCola {
  id: string
  number: string
  total: number
  lineas: number
  creadoEn: Date
  creadoPor: string
  cliente: string | null
  /** Quién lo está cobrando AHORA (reserva vigente), si alguien. */
  cobrando: { userId: string; nombre: string } | null
  /** La reserva vigente es mía. */
  mio: boolean
  /** Lo armé yo. */
  esMio: boolean
}

function reservaVigente(lockedAt: Date | null, ahora: Date): boolean {
  return !!lockedAt && ahora.getTime() - lockedAt.getTime() < PEDIDO_BLOQUEO_MS
}

/**
 * Pedidos pendientes de la sucursal activa.
 *
 * Quien cobra ve TODOS; quien solo vende, solo los SUYOS (no tiene por qué ver
 * lo que armaron otros ni quién los está cobrando).
 */
export async function listarPedidos(
  db: TenantPrismaClient,
  ctx: TenantContext,
  ahora: Date = new Date(),
): Promise<PedidoEnCola[]> {
  const puedeCobrar = puede(ctx, 'ventas.cobrar')
  if (!puedeCobrar && !puede(ctx, 'ventas.crear')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver pedidos.')
  }
  const branchId = requireBranch(ctx)
  await vencerPedidosDelDia(db, ahora)

  const filas = await db.quote.findMany({
    where: {
      kind: 'PEDIDO', status: 'ENVIADA', branchId,
      ...(puedeCobrar ? {} : { userId: ctx.userId }),
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: {
      id: true, number: true, total: true, createdAt: true, userId: true,
      lockedById: true, lockedAt: true,
      user: { select: { name: true } },
      customer: { select: { name: true } },
      lockedBy: { select: { name: true } },
      _count: { select: { items: true } },
    },
  })

  return filas.map((f) => {
    const vigente = reservaVigente(f.lockedAt, ahora) && f.lockedById !== null
    return {
      id: f.id, number: f.number, total: num(f.total), lineas: f._count.items,
      creadoEn: f.createdAt, creadoPor: f.user.name, cliente: f.customer?.name ?? null,
      cobrando: vigente && puedeCobrar ? { userId: f.lockedById!, nombre: f.lockedBy?.name ?? 'otro cajero' } : null,
      mio: vigente && f.lockedById === ctx.userId,
      esMio: f.userId === ctx.userId,
    }
  })
}

export interface PedidoTomado {
  id: string
  number: string
  total: number
  warehouseId: string
  cliente: { id: string; name: string; docType: string; docNumber: string | null } | null
  lineas: {
    productId: string; variantId: string | null; nombre: string; sku: string; unitType: string
    cantidad: number; precio: number; descuento: number; taxRate: number; importe: number
  }[]
  /** Hasta cuándo es suya la reserva si no la renueva. */
  reservadoHasta: Date
}

/**
 * «Tomar» un pedido: reserva atómica para cobrarlo.
 *
 * Es un UPDATE condicional, no «leer y luego escribir»: con cinco cajeros
 * pulsando a la vez, exactamente uno cambia la fila. Volver a tomarlo siendo
 * el dueño de la reserva la RENUEVA (es lo que hace la pantalla mientras está
 * abierta).
 */
export async function tomarPedido(
  db: TenantPrismaClient,
  ctx: TenantContext,
  pedidoId: string,
  ahora: Date = new Date(),
): Promise<PedidoTomado> {
  exigir(ctx, 'ventas.cobrar')
  const branchId = requireBranch(ctx)
  await vencerPedidosDelDia(db, ahora)

  const caducadas = new Date(ahora.getTime() - PEDIDO_BLOQUEO_MS)
  const r = await db.quote.updateMany({
    where: {
      id: pedidoId, kind: 'PEDIDO', status: 'ENVIADA', branchId,
      OR: [{ lockedById: null }, { lockedById: ctx.userId }, { lockedAt: { lt: caducadas } }],
    },
    data: { lockedById: ctx.userId, lockedAt: ahora },
  })

  if (r.count !== 1) {
    // Se explica el motivo real, sin revelar nada de otras sucursales.
    const p = await db.quote.findFirst({
      where: { id: pedidoId, kind: 'PEDIDO', branchId },
      select: { status: true, number: true, lockedBy: { select: { name: true } } },
    })
    if (!p) throw new BusinessError('NOT_FOUND', 'El pedido no existe en esta sucursal.')
    if (p.status === 'VENCIDA') throw new BusinessError('DUPLICATE_CODE', `El pedido ${p.number} venció. Que lo arme de nuevo el vendedor.`)
    if (p.status === 'CONVERTIDA') throw new BusinessError('DUPLICATE_CODE', `El pedido ${p.number} ya se cobró.`)
    if (p.status === 'RECHAZADA') throw new BusinessError('DUPLICATE_CODE', `El pedido ${p.number} fue cancelado.`)
    throw new BusinessError('DUPLICATE_CODE', `El pedido ${p.number} lo está cobrando ${p.lockedBy?.name ?? 'otra persona'}.`)
  }

  const p = await db.quote.findFirstOrThrow({
    where: { id: pedidoId },
    select: {
      id: true, number: true, total: true, warehouseId: true,
      customer: { select: { id: true, name: true, docType: true, docNumber: true } },
      items: {
        orderBy: { createdAt: 'asc' },
        select: {
          productId: true, variantId: true, nameSnapshot: true, skuSnapshot: true, unitType: true,
          quantity: true, unitPrice: true, discount: true, taxRate: true, lineTotal: true,
        },
      },
    },
  })
  return {
    id: p.id, number: p.number, total: num(p.total), warehouseId: p.warehouseId, cliente: p.customer,
    lineas: p.items.map((i) => ({
      productId: i.productId, variantId: i.variantId, nombre: i.nameSnapshot, sku: i.skuSnapshot,
      unitType: i.unitType, cantidad: num(i.quantity), precio: num(i.unitPrice), descuento: num(i.discount),
      taxRate: num(i.taxRate), importe: num(i.lineTotal),
    })),
    reservadoHasta: new Date(ahora.getTime() + PEDIDO_BLOQUEO_MS),
  }
}

/** Devuelve el pedido a la cola. Lo suelta quien lo tiene; un administrador (`caja.cerrar_ajeno`) puede soltar el de otro. */
export async function soltarPedido(db: TenantPrismaClient, ctx: TenantContext, pedidoId: string): Promise<void> {
  const branchId = requireBranch(ctx)
  const forzar = puede(ctx, 'caja.cerrar_ajeno')
  if (!forzar) exigir(ctx, 'ventas.cobrar')

  const r = await db.quote.updateMany({
    where: {
      id: pedidoId, kind: 'PEDIDO', status: 'ENVIADA', branchId,
      ...(forzar ? { lockedById: { not: null } } : { lockedById: ctx.userId }),
    },
    data: { lockedById: null, lockedAt: null },
  })
  if (r.count !== 1) throw new BusinessError('NOT_FOUND', 'Ese pedido no está tomado por ti.')
  if (forzar) {
    await db.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
        action: 'pedido.soltar', entityType: 'Quote', entityId: pedidoId,
        impersonationId: ctx.impersonationId ?? null,
      },
    })
  }
}

/**
 * Cancela un pedido pendiente. Lo cancela quien lo armó o un cajero, nunca
 * mientras OTRO lo está cobrando (salvo `caja.cerrar_ajeno`).
 */
export async function cancelarPedido(
  db: TenantPrismaClient,
  ctx: TenantContext,
  pedidoId: string,
  ahora: Date = new Date(),
): Promise<void> {
  const branchId = requireBranch(ctx)
  const p = await db.quote.findFirst({
    where: { id: pedidoId, kind: 'PEDIDO', branchId },
    select: { id: true, status: true, userId: true, lockedById: true, lockedAt: true },
  })
  if (!p) throw new BusinessError('NOT_FOUND', 'El pedido no existe en esta sucursal.')
  if (p.status !== 'ENVIADA') throw new BusinessError('DUPLICATE_CODE', 'Ese pedido ya no está pendiente.')

  const esSuyo = p.userId === ctx.userId
  if (!esSuyo && !puede(ctx, 'ventas.cobrar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'Solo quien armó el pedido o un cajero puede cancelarlo.')
  }
  const lockedPorOtro = p.lockedById !== null && p.lockedById !== ctx.userId && reservaVigente(p.lockedAt, ahora)
  if (lockedPorOtro && !puede(ctx, 'caja.cerrar_ajeno')) {
    throw new BusinessError('DUPLICATE_CODE', 'Alguien lo está cobrando ahora. Espera a que termine o pídele que lo suelte.')
  }

  const r = await db.quote.updateMany({
    where: { id: p.id, kind: 'PEDIDO', status: 'ENVIADA' },
    data: { status: 'RECHAZADA', lockedById: null, lockedAt: null },
  })
  if (r.count === 1) {
    await db.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
        action: 'pedido.cancelar', entityType: 'Quote', entityId: p.id,
        impersonationId: ctx.impersonationId ?? null,
      },
    })
  }
}

/** Cobra el pedido que se tiene tomado. Las reglas del cobro y de la reserva viven en `convertQuoteToSale`. */
export async function cobrarPedido(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: ConvertQuoteInput,
  ahora: Date = new Date(),
) {
  const p = await db.quote.findFirst({ where: { id: input.quoteId }, select: { kind: true } })
  if (!p || p.kind !== 'PEDIDO') throw new BusinessError('NOT_FOUND', 'El pedido no existe.')
  return convertQuoteToSale(db, ctx, input, ahora)
}
