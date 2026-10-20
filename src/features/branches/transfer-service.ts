import { BusinessError } from '@/lib/errors'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { applyStockMovement } from '@/features/inventory/stock-service'
import { claimNextNumber, ensureCounter } from '@/features/pos/sale-service'
import { cargarSucursalOperativa, serieDe } from './queries'
import type {
  ApproveTransferInput, CreateTransferInput, ReceiveTransferInput,
  RejectTransferInput, ShipTransferInput,
} from './transfer-schemas'
import { puede } from '@/lib/puede'

const num = (v: unknown): number => Number(v ?? 0)

export interface TransferResult {
  id: string
  number: string
  status: string
  lineas: number
}

/**
 * Transferencias entre sucursales (§2 del pliego).
 *
 * ─── POR QUÉ EL STOCK SE MUEVE EN DOS PASOS ──────────────────────────────
 *
 * Un único movimiento instantáneo —restar del origen y sumar al destino en la
 * misma transacción— es más simple y es MENTIRA: la mercadería tarda horas o
 * días en llegar. Durante todo ese tiempo el destino contaría existencias que
 * no puede vender, y es exactamente ahí donde se pierde material sin que nadie
 * lo note.
 *
 * Así que el stock sale al DESPACHAR y entra al RECIBIR. En medio, la
 * mercadería está EN_TRANSITO y no pertenece a ningún almacén: la fila de la
 * transferencia es su registro. El total del sistema baja mientras viaja, y
 * eso es correcto, no un error de cuadre — lo que viaja no está en ningún
 * estante. El reporte de tránsito lo muestra aparte.
 *
 * Cada paso es atómico por separado: o sale del origen y queda registrado, o
 * no sale. Lo que NO puede pasar es que salga del origen sin dejar rastro.
 */
export async function createTransfer(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: CreateTransferInput,
): Promise<TransferResult> {
  /*
   * SOLICITAR, no despachar. Son dos momentos y dos responsabilidades: el
   * ciclo es solicitar → aprobar → despachar → recibir, y cada paso lo da un
   * permiso distinto. Un vendedor o cajero puede pedir reposición; solo el
   * almacenero o el administrador despacha. Que antes `createTransfer`
   * exigiera `despachar` solo funcionaba porque el almacenero tenía los dos.
   */
  if (!puede(ctx, 'stock.transferir_solicitar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para solicitar transferencias.')
  }
  const fromBranchId = requireBranch(ctx)

  if (input.toBranchId === fromBranchId) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      'El origen y el destino son la misma sucursal. Para mover stock dentro de un local, usa un ajuste.',
    )
  }

  const sucursal = await cargarSucursalOperativa(db, fromBranchId)
  const serie = serieDe(sucursal, 'TRANSFER')
  await ensureCounter(db, ctx.tenantId, fromBranchId, 'TRANSFER', serie.series, serie.prefix)

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient

    // El almacén de origen tiene que ser de MI sucursal; el de destino, de la
    // sucursal destino. Sin estas dos comprobaciones se podría "transferir"
    // entre dos almacenes ajenos pasando sus ids.
    const origen = await t.warehouse.findFirst({
      where: { id: input.fromWarehouseId, branchId: fromBranchId, isActive: true, deletedAt: null },
      select: { id: true },
    })
    if (!origen) {
      throw new BusinessError('TENANT_MISMATCH', 'El almacén de origen no es de tu sucursal.')
    }

    const destino = await t.warehouse.findFirst({
      where: {
        id: input.toWarehouseId, branchId: input.toBranchId,
        isActive: true, deletedAt: null,
        branch: { isActive: true, deletedAt: null },
      },
      select: { id: true },
    })
    if (!destino) {
      throw new BusinessError(
        'TENANT_MISMATCH',
        'El almacén de destino no pertenece a la sucursal indicada o no está disponible.',
      )
    }

    const ids = input.items.map((i) => i.productId)
    const productos = await t.product.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      select: { id: true, name: true, sku: true, unitType: true, trackStock: true },
    })
    const porId = new Map(productos.map((p) => [p.id, p]))

    for (const item of input.items) {
      const p = porId.get(item.productId)
      if (!p) {
        throw new BusinessError('TENANT_MISMATCH', 'Alguno de los productos no existe.')
      }
      if (!p.trackStock) {
        throw new BusinessError(
          'INVALID_DOCUMENT',
          `"${p.name}" no lleva control de stock: no tiene sentido transferirlo.`,
        )
      }
    }

    const { correlativo, prefix, series } = await claimNextNumber(
      t, ctx.tenantId, 'TRANSFER', serie.series,
    )
    const number = `${prefix}${series}-${String(correlativo).padStart(8, '0')}`

    const transfer = await t.branchTransfer.create({
      data: {
        tenantId: ctx.tenantId,
        number,
        fromBranchId,
        fromWarehouseId: origen.id,
        toBranchId: input.toBranchId,
        toWarehouseId: destino.id,
        status: 'SOLICITADA',
        requestedById: ctx.userId,
        notes: input.notes ?? null,
      },
      select: { id: true, number: true, status: true },
    })

    await t.branchTransferItem.createMany({
      data: input.items.map((i) => {
        const p = porId.get(i.productId)!
        return {
          tenantId: ctx.tenantId,
          transferId: transfer.id,
          productId: i.productId,
          variantId: i.variantId ?? null,
          nameSnapshot: p.name,
          skuSnapshot: p.sku,
          unitType: p.unitType,
          quantitySent: i.quantity,
        }
      }),
    })

    await auditar(t, ctx, 'transfer.create', transfer.id, {
      number, destino: input.toBranchId, lineas: input.items.length,
    })

    return { ...transfer, lineas: input.items.length }
  }, { maxWait: 15_000, timeout: 30_000 })
}

/**
 * Aprobación. Todavía no mueve stock: autoriza el despacho.
 *
 * Es un paso aparte porque quien pide no debe ser quien autoriza — si lo
 * fuera, cualquier almacenero podría vaciar el almacén de otra sucursal.
 */
export async function approveTransfer(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: ApproveTransferInput,
): Promise<TransferResult> {
  if (!puede(ctx, 'stock.transferir_aprobar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'Solo un administrador aprueba transferencias.')
  }

  const tr = await cargarTransferencia(db, input.transferId, ['SOLICITADA'])

  const actualizada = await db.branchTransfer.update({
    where: { id: tr.id },
    data: { status: 'APROBADA', approvedById: ctx.userId, approvedAt: new Date() },
    select: { id: true, number: true, status: true },
  })
  await auditar(db, ctx, 'transfer.approve', tr.id, { number: tr.number })
  return { ...actualizada, lineas: tr.items.length }
}

/**
 * Despacho: el stock SALE del origen y la mercadería queda en tránsito.
 *
 * Reutiliza `applyStockMovement`, así que hereda su guard atómico de
 * concurrencia: si dos operaciones intentan sacar la misma unidad a la vez,
 * una falla con INSUFFICIENT_STOCK en lugar de dejar el stock en negativo.
 *
 * `allowNegative` es `false` siempre y a propósito. Una venta forzada con
 * stock negativo es una decisión comercial defendible —el cliente está en el
 * mostrador y el producto existe aunque el sistema no lo sepa—, pero
 * despachar a otra sucursal mercadería que no se tiene no mueve nada: solo
 * crea un faltante en el origen y una expectativa falsa en el destino.
 */
export async function shipTransfer(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: ShipTransferInput,
): Promise<TransferResult> {
  if (!puede(ctx, 'stock.transferir_despachar')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para despachar transferencias.')
  }

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const tr = await cargarTransferencia(t, input.transferId, ['APROBADA'])

    // Solo despacha quien está en la sucursal de origen.
    if (ctx.branchId && ctx.branchId !== tr.fromBranchId && !puede(ctx, 'stock.transferir_aprobar')) {
      throw new BusinessError(
        'FORBIDDEN_ROLE',
        'Solo se despacha desde la sucursal de origen.',
      )
    }

    for (const item of tr.items) {
      await applyStockMovement(
        t,
        ctx,
        {
          type: 'SALIDA',
          productId: item.productId,
          variantId: item.variantId,
          warehouseId: tr.fromWarehouseId,
          quantity: num(item.quantitySent),
          reason: `Transferencia ${tr.number} a sucursal`,
          source: 'MANUAL',
        },
        'TRANSFERENCIA',
        false,
        'TRANSFERENCIA_SALIDA',
      )
    }

    const actualizada = await t.branchTransfer.update({
      where: { id: tr.id },
      data: { status: 'EN_TRANSITO', shippedAt: new Date() },
      select: { id: true, number: true, status: true },
    })
    await auditar(t, ctx, 'transfer.ship', tr.id, { number: tr.number, lineas: tr.items.length })
    return { ...actualizada, lineas: tr.items.length }
  }, { maxWait: 15_000, timeout: 30_000 })
}

/**
 * Recepción: el stock ENTRA al destino, por lo CONTADO, no por lo enviado.
 *
 * Si lo recibido es menor que lo despachado, la diferencia NO se reparte en
 * silencio: entra lo contado y el faltante se asienta como MERMA en el
 * almacén de origen, con el número de la transferencia como motivo. Así el
 * kardex reconcilia y queda constancia de dónde se perdió. Sin ese asiento,
 * las unidades perdidas quedarían flotando como diferencia inexplicable.
 */
export async function receiveTransfer(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: ReceiveTransferInput,
): Promise<TransferResult & { faltantes: number }> {
  if (!puede(ctx, 'stock.transferir_recibir')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para recibir transferencias.')
  }

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const tr = await cargarTransferencia(t, input.transferId, ['EN_TRANSITO'])

    if (ctx.branchId && ctx.branchId !== tr.toBranchId && !puede(ctx, 'stock.transferir_aprobar')) {
      throw new BusinessError('FORBIDDEN_ROLE', 'Solo se recibe en la sucursal de destino.')
    }

    const contado = new Map(input.items.map((i) => [i.itemId, i.quantityReceived]))
    const sinContar = tr.items.filter((i) => !contado.has(i.id))
    if (sinContar.length > 0) {
      throw new BusinessError(
        'INVALID_DOCUMENT',
        `Faltan ${sinContar.length} ${sinContar.length === 1 ? 'línea' : 'líneas'} por contar. ` +
          'Hay que declarar lo recibido de cada producto, aunque sea cero.',
        { sinContar: sinContar.length },
      )
    }

    let faltantes = 0

    for (const item of tr.items) {
      const recibido = contado.get(item.id)!
      const enviado = num(item.quantitySent)

      if (recibido > enviado) {
        throw new BusinessError(
          'INVALID_DOCUMENT',
          `De "${item.nameSnapshot}" se despacharon ${enviado} y declaras ${recibido} recibidos. ` +
            'No puede llegar más de lo que salió.',
          { producto: item.nameSnapshot, enviado, recibido },
        )
      }

      if (recibido > 0) {
        await applyStockMovement(
          t,
          ctx,
          {
            type: 'ENTRADA',
            productId: item.productId,
            variantId: item.variantId,
            warehouseId: tr.toWarehouseId,
            quantity: recibido,
            reason: `Transferencia ${tr.number} recibida`,
            source: 'MANUAL',
          },
          'TRANSFERENCIA',
          false,
          'TRANSFERENCIA_ENTRADA',
        )
      }

      const perdido = enviado - recibido
      if (perdido > 0) {
        faltantes += 1
        /*
         * NO se asienta ningún movimiento extra por el faltante, y esto es
         * deliberado: hacerlo restaría dos veces.
         *
         * El libro ya refleja la pérdida. Al despachar, el origen descontó
         * TODO lo enviado; al recibir, el destino suma solo lo que llegó. La
         * diferencia desapareció del sistema por construcción — es la
         * mercadería que salió del estante y nunca llegó a otro. Añadir una
         * MERMA en el origen volvería a quitar unas unidades que ya no
         * estaban ahí, y el kardex dejaría de reconciliar con el inventario
         * físico justo en el caso que se quería auditar.
         *
         * El rastro de la pérdida no se pierde: queda en la propia línea
         * (`quantitySent` frente a `quantityReceived`) y en el AuditLog con
         * acción `transfer.receive.faltante`. Lo que falta es un modelo de
         * doble entrada con almacén de tránsito, que convertiría el viaje en
         * un saldo explícito; está anotado como deuda, no resuelto a medias.
         */
      }

      await t.branchTransferItem.update({
        where: { id: item.id },
        data: { quantityReceived: recibido },
      })
    }

    const actualizada = await t.branchTransfer.update({
      where: { id: tr.id },
      data: {
        status: 'RECIBIDA',
        receivedById: ctx.userId,
        receivedAt: new Date(),
        notes: input.notes ?? tr.notes,
      },
      select: { id: true, number: true, status: true },
    })

    await auditar(t, ctx, faltantes > 0 ? 'transfer.receive.faltante' : 'transfer.receive', tr.id, {
      number: tr.number, lineas: tr.items.length, faltantes,
    })

    return { ...actualizada, lineas: tr.items.length, faltantes }
  }, { maxWait: 20_000, timeout: 40_000 })
}

/**
 * Rechazo en destino: la mercadería vuelve al origen.
 *
 * El stock se reingresa en el almacén de origen, porque al despachar ya había
 * salido de ahí. Si no se reingresara, el rechazo haría desaparecer el
 * material de los dos locales a la vez.
 */
export async function rejectTransfer(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: RejectTransferInput,
): Promise<TransferResult> {
  if (!puede(ctx, 'stock.transferir_recibir')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para rechazar transferencias.')
  }

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const tr = await cargarTransferencia(t, input.transferId, ['EN_TRANSITO', 'APROBADA'])

    // Solo si ya salió hay que devolverlo. Una APROBADA todavía no movió nada.
    if (tr.status === 'EN_TRANSITO') {
      for (const item of tr.items) {
        await applyStockMovement(
          t,
          ctx,
          {
            type: 'ENTRADA',
            productId: item.productId,
            variantId: item.variantId,
            warehouseId: tr.fromWarehouseId,
            quantity: num(item.quantitySent),
            reason: `Transferencia ${tr.number} rechazada: devolución`,
            source: 'MANUAL',
          },
          'TRANSFERENCIA',
          false,
          'TRANSFERENCIA_ENTRADA',
        )
      }
    }

    const actualizada = await t.branchTransfer.update({
      where: { id: tr.id },
      data: { status: 'RECHAZADA', rejectReason: input.reason, receivedById: ctx.userId },
      select: { id: true, number: true, status: true },
    })
    await auditar(t, ctx, 'transfer.reject', tr.id, { number: tr.number, motivo: input.reason })
    return { ...actualizada, lineas: tr.items.length }
  }, { maxWait: 15_000, timeout: 30_000 })
}

/**
 * Carga la transferencia exigiendo que esté en uno de los estados válidos.
 *
 * La comprobación de estado va aquí y no en cada función para que no haya
 * forma de olvidarla: sin ella se podría despachar dos veces la misma
 * transferencia y el stock saldría del origen por duplicado.
 */
async function cargarTransferencia(
  db: TenantPrismaClient,
  transferId: string,
  permitidos: readonly string[],
) {
  const tr = await db.branchTransfer.findFirst({
    where: { id: transferId },
    select: {
      id: true, number: true, status: true, notes: true,
      fromBranchId: true, fromWarehouseId: true,
      toBranchId: true, toWarehouseId: true,
      items: {
        select: {
          id: true, productId: true, variantId: true,
          nameSnapshot: true, quantitySent: true,
        },
      },
    },
  })
  if (!tr) throw new BusinessError('NOT_FOUND', 'La transferencia no existe.')
  if (!permitidos.includes(tr.status)) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      `La transferencia está ${tr.status.toLowerCase()} y esta acción requiere ` +
        `${permitidos.map((p) => p.toLowerCase()).join(' o ')}.`,
      { estado: tr.status },
    )
  }
  return tr
}

async function auditar(
  db: TenantPrismaClient,
  ctx: TenantContext,
  action: string,
  entityId: string,
  after: Record<string, unknown>,
) {
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorRole: ctx.role,
      action,
      entityType: 'BranchTransfer',
      entityId,
      after: after as never,
      impersonationId: ctx.impersonationId ?? null,
    },
  })
}
