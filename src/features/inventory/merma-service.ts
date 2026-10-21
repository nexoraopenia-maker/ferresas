import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { puede } from '@/lib/puede'
import { applyStockMovement } from './stock-service'
import type { ResolverMermaInput, SolicitarMermaInput } from './merma-schemas'

const num = (v: unknown): number => Number(v ?? 0)

export interface MermaResultado {
  id: string
  status: 'PENDIENTE' | 'APROBADA' | 'RECHAZADA'
  producto: string
  cantidad: number
}

/**
 * Mermas con aprobación.
 *
 * ─── POR QUÉ DOS PASOS ───────────────────────────────────────────────────
 *
 * Una merma reduce inventario a criterio de quien la registra, y esa es la
 * forma más fácil de tapar un faltante: si el almacenero pudiera aplicarla
 * solo, cualquier diferencia se "explicaría" sin que nadie la revisara.
 *
 * Así que se parte: quien la ve la SOLICITA con cantidad, motivo y
 * opcionalmente una foto; quien tiene `stock.ajustar` la aprueba o la
 * rechaza. Misma regla que en transferencias — quien pide no autoriza.
 *
 * ─── MIENTRAS ESTÁ PENDIENTE, EL STOCK NO SE MUEVE ───────────────────────
 *
 * Y por eso es tabla propia y no un `StockMovement`. Un movimiento es el
 * asiento de algo que ya pasó; una merma pendiente es una petición. Si se
 * guardara como movimiento «que no cuenta», el invariante
 * `SUM(movimientos) = stock` —el que sostiene todo el inventario— dejaría de
 * cumplirse, y con él toda posibilidad de reconciliar.
 */
export async function solicitarMerma(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: SolicitarMermaInput,
): Promise<MermaResultado> {
  if (!puede(ctx, 'stock.merma_solicitar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para solicitar mermas.')
  }
  const branchId = requireBranch(ctx)

  // El almacén tiene que ser de SU sucursal: el aislamiento por tenant no
  // basta, porque todos los almacenes son del mismo negocio.
  const warehouse = await db.warehouse.findFirst({
    where: { id: input.warehouseId, branchId, isActive: true, deletedAt: null },
    select: { id: true },
  })
  if (!warehouse) {
    throw new BusinessError(
      'TENANT_MISMATCH',
      'El almacén no pertenece a tu sucursal o no está disponible.',
    )
  }

  const producto = await db.product.findFirst({
    where: { id: input.productId, deletedAt: null, isActive: true },
    select: { id: true, name: true, sku: true, unitType: true, trackStock: true },
  })
  if (!producto) throw new BusinessError('TENANT_MISMATCH', 'El producto no existe.')
  if (!producto.trackStock) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      `"${producto.name}" no lleva control de stock: no hay nada que mermar.`,
    )
  }

  const merma = await db.merma.create({
    data: {
      tenantId: ctx.tenantId,
      branchId,
      warehouseId: warehouse.id,
      productId: producto.id,
      variantId: input.variantId ?? null,
      // Congelados: el catálogo puede cambiar antes de que alguien la apruebe.
      nameSnapshot: producto.name,
      skuSnapshot: producto.sku,
      unitType: producto.unitType,
      quantity: new Prisma.Decimal(input.quantity.toFixed(4)),
      reason: input.reason,
      photoUrl: input.photoUrl ?? null,
      status: 'PENDIENTE',
      requestedById: ctx.userId,
    },
    select: { id: true, status: true, nameSnapshot: true, quantity: true },
  })

  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorRole: ctx.role,
      action: 'merma.solicitar',
      entityType: 'Merma',
      entityId: merma.id,
      reason: input.reason,
      after: {
        producto: producto.name,
        cantidad: input.quantity,
        conFoto: Boolean(input.photoUrl),
      },
      impersonationId: ctx.impersonationId ?? null,
    },
  })

  return {
    id: merma.id,
    status: merma.status,
    producto: merma.nameSnapshot,
    cantidad: num(merma.quantity),
  }
}

/**
 * Aprueba o rechaza. Solo con `stock.ajustar`.
 *
 * Al aprobar, el descuento del stock y el cambio de estado van en la MISMA
 * transacción: si no, podría quedar una merma aprobada cuyo stock no bajó, o
 * un stock descontado sin merma que lo justifique.
 */
export async function resolverMerma(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: ResolverMermaInput,
): Promise<MermaResultado> {
  if (!puede(ctx, 'stock.ajustar')) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'No tienes permiso para aprobar o rechazar mermas.',
    )
  }

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient

    const merma = await t.merma.findFirst({
      where: { id: input.mermaId },
      select: {
        id: true, status: true, warehouseId: true, productId: true, variantId: true,
        quantity: true, reason: true, nameSnapshot: true, requestedById: true,
      },
    })
    if (!merma) throw new BusinessError('NOT_FOUND', 'La merma no existe.')

    /*
     * Se comprueba el estado DENTRO de la transacción. Fuera dejaría una
     * ventana para que dos administradores la aprobaran a la vez y el stock
     * se descontara dos veces por la misma merma.
     */
    if (merma.status !== 'PENDIENTE') {
      throw new BusinessError(
        'INVALID_DOCUMENT',
        `Esta merma ya está ${merma.status.toLowerCase()}.`,
        { estado: merma.status },
      )
    }

    /*
     * Quien pide NO autoriza, ni siquiera teniendo los dos permisos.
     *
     * Un OWNER tiene `stock.merma_solicitar` y `stock.ajustar`, así que
     * podría pedir y aprobar lo suyo — y entonces el control no controla
     * nada. Si de verdad solo hay una persona, que la registre y la apruebe
     * otra, o que use un ajuste por conteo, que es la herramienta para eso.
     */
    if (merma.requestedById === ctx.userId) {
      throw new BusinessError(
        'FORBIDDEN_ROLE',
        'No puedes aprobar una merma que solicitaste tú. El control está en que ' +
          'la revise otra persona; si trabajas solo, usa un ajuste por conteo.',
        { solicitante: 'mismo-usuario' },
      )
    }

    const ahora = new Date()

    if (input.decision === 'RECHAZAR') {
      const r = await t.merma.update({
        where: { id: merma.id },
        data: {
          status: 'RECHAZADA',
          rejectReason: input.rejectReason,
          resolvedById: ctx.userId,
          resolvedAt: ahora,
        },
        select: { id: true, status: true, nameSnapshot: true, quantity: true },
      })
      await auditar(t, ctx, 'merma.rechazar', merma.id, input.rejectReason, {
        producto: merma.nameSnapshot,
        cantidad: num(merma.quantity),
      })
      return {
        id: r.id, status: r.status, producto: r.nameSnapshot, cantidad: num(r.quantity),
      }
    }

    /*
     * Aprobada: AHORA sí se mueve el stock, con `applyStockMovement`, que es
     * el mismo código que usa el escáner y la venta. Eso importa: hereda su
     * guard atómico de concurrencia y su asiento en el libro.
     *
     * `typeOverride: 'MERMA'` para que el kardex diga qué fue, no una salida
     * genérica.
     */
    const mov = await applyStockMovement(
      t,
      ctx,
      {
        type: 'SALIDA',
        productId: merma.productId,
        variantId: merma.variantId,
        warehouseId: merma.warehouseId,
        quantity: num(merma.quantity),
        reason: `Merma aprobada: ${merma.reason}`,
        source: 'MANUAL',
      },
      'CONTEO',
      input.permitirNegativo,
      'MERMA',
    )

    const r = await t.merma.update({
      where: { id: merma.id },
      data: {
        status: 'APROBADA',
        resolvedById: ctx.userId,
        resolvedAt: ahora,
        movementId: mov.movementId,
      },
      select: { id: true, status: true, nameSnapshot: true, quantity: true },
    })

    await auditar(t, ctx, 'merma.aprobar', merma.id, merma.reason, {
      producto: merma.nameSnapshot,
      cantidad: num(merma.quantity),
      movimiento: mov.movementId,
      saldoResultante: mov.balanceAfter,
      quedoNegativo: mov.wentNegative,
    })

    return {
      id: r.id, status: r.status, producto: r.nameSnapshot, cantidad: num(r.quantity),
    }
  }, { maxWait: 15_000, timeout: 30_000 })
}

/**
 * Mermas pendientes, para el contador del panel del administrador.
 *
 * Una merma pendiente es inventario que el sistema dice que existe y que
 * alguien ya reportó como perdido. Cuanto más tiempo pase sin resolverse,
 * menos fiable es el stock — de ahí que el contador vaya a la vista, y no
 * escondido en una pantalla a la que hay que acordarse de entrar.
 */
export async function contarMermasPendientes(
  db: TenantPrismaClient,
  branchId?: string,
): Promise<number> {
  return db.merma.count({
    where: { status: 'PENDIENTE', ...(branchId ? { branchId } : {}) },
  })
}

async function auditar(
  db: TenantPrismaClient,
  ctx: TenantContext,
  action: string,
  entityId: string,
  reason: string,
  after: Record<string, unknown>,
) {
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorRole: ctx.role,
      action,
      entityType: 'Merma',
      entityId,
      reason,
      after: after as never,
      impersonationId: ctx.impersonationId ?? null,
    },
  })
}

export interface MermaFila {
  id: string
  estado: 'PENDIENTE' | 'APROBADA' | 'RECHAZADA'
  producto: string
  sku: string
  unitType: string
  cantidad: number
  motivo: string
  fotoUrl: string | null
  solicitante: string
  solicitadaEn: Date
  resolvio: string | null
  resueltaEn: Date | null
  motivoRechazo: string | null
  /** La pedí yo: no puedo aprobarla ni rechazarla (requisito de control). */
  esMia: boolean
}

/**
 * Mermas de la sucursal activa.
 *
 * Quien aprueba (`stock.ajustar`) ve todas las de la sucursal; quien solo
 * solicita (`stock.merma_solicitar`) ve las SUYAS. Las pendientes primero.
 */
export async function listarMermas(
  db: TenantPrismaClient,
  ctx: TenantContext,
  limite = 100,
): Promise<MermaFila[]> {
  const aprueba = puede(ctx, 'stock.ajustar')
  if (!aprueba && !puede(ctx, 'stock.merma_solicitar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver mermas.')
  }
  const branchId = requireBranch(ctx)

  const filas = await db.merma.findMany({
    where: { branchId, ...(aprueba ? {} : { requestedById: ctx.userId }) },
    orderBy: [{ requestedAt: 'desc' }],
    take: limite,
    select: {
      id: true, status: true, nameSnapshot: true, skuSnapshot: true, unitType: true, quantity: true,
      reason: true, photoUrl: true, requestedAt: true, resolvedAt: true, rejectReason: true, requestedById: true,
      requestedBy: { select: { name: true } },
      resolvedBy: { select: { name: true } },
    },
  })
  const orden = { PENDIENTE: 0, APROBADA: 1, RECHAZADA: 1 } as const
  return filas
    .map((f) => ({
      id: f.id, estado: f.status, producto: f.nameSnapshot, sku: f.skuSnapshot, unitType: f.unitType,
      cantidad: num(f.quantity), motivo: f.reason, fotoUrl: f.photoUrl, solicitante: f.requestedBy.name,
      solicitadaEn: f.requestedAt, resolvio: f.resolvedBy?.name ?? null, resueltaEn: f.resolvedAt,
      motivoRechazo: f.rejectReason, esMia: f.requestedById === ctx.userId,
    }))
    .sort((a, b) => orden[a.estado] - orden[b.estado])
}
