import { randomUUID } from 'node:crypto'
import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { camposDeColision, esColisionUnica } from '@/lib/prisma-errors'
import { puede } from '@/lib/puede'
import type { CreateProductExpressInput } from './schemas'

const P2002_UNIQUE = 'P2002'

export interface ExpressProductResult {
  productId: string
  sku: string
  barcode: string | null
  name: string
  quantity: number
  version: number
  /** El código ya existía: otro dispositivo lo creó primero. */
  alreadyExisted: boolean
}

/**
 * Alta exprés de producto desde el escáner (§5.1).
 *
 * Crea el producto, su fila de Stock y el movimiento INICIAL en UNA sola
 * transacción (§6.2). Si algo falla, no queda un producto fantasma sin stock
 * ni un movimiento apuntando a un producto que no existe.
 *
 * Aquí SÍ se aplica el límite de plan `maxProducts`, porque es un límite de
 * creación de recurso (§5.2) y se comprueba en el servidor, no en la UI.
 * Contrasta con `maxMonthlyTransactions`, que no frena movimientos de
 * inventario por decisión de producto.
 */
export async function createProductExpress(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: CreateProductExpressInput,
): Promise<ExpressProductResult> {
  // El almacenero es justamente quien está en el pasillo con el escáner:
  // si no pudiera crear, el flujo exprés no tendría sentido.
  if (!puede(ctx, 'productos.crear')) {
    throw new BusinessError(
      'FORBIDDEN_ROLE',
      'No tienes permiso para crear productos.',
    )
  }

  // Si el código ya existe, no es un error: otro dispositivo lo registró
  // hace segundos. Se devuelve el existente para que el operario siga en el
  // mismo sheet en vez de toparse con un mensaje sin salida.
  if (input.barcode) {
    const yaExiste = await db.product.findFirst({
      where: { barcode: input.barcode, deletedAt: null },
      select: { id: true, sku: true, barcode: true, name: true },
    })
    if (yaExiste) {
      const stock = await db.stock.findFirst({
        where: { productId: yaExiste.id, variantId: null, warehouseId: input.warehouseId },
        select: { quantity: true, version: true },
      })
      return {
        ...yaExiste,
        productId: yaExiste.id,
        quantity: stock ? Number(stock.quantity) : 0,
        version: stock?.version ?? 0,
        alreadyExisted: true,
      }
    }
  }

  const sku = input.sku ?? input.barcode ?? `SKU-${randomUUID().slice(0, 8).toUpperCase()}`

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient

      // --- Límite de plan (§5.2) -----------------------------------------
      const tenant = await t.tenant.findFirstOrThrow({
        select: {
          plan: { select: { maxProducts: true, name: true } },
          subscription: { select: { plan: { select: { maxProducts: true, name: true } } } },
        },
      })

      // La suscripción manda sobre el plan cacheado en Tenant: es la que el
      // webhook mantiene al día (§5.2).
      const plan = tenant.subscription?.plan ?? tenant.plan

      if (plan?.maxProducts != null) {
        const actuales = await t.product.count({ where: { deletedAt: null } })
        if (actuales >= plan.maxProducts) {
          throw new BusinessError(
            'PLAN_LIMIT_REACHED',
            `Tu plan ${plan.name} permite ${plan.maxProducts} ` +
              `${plan.maxProducts === 1 ? 'producto' : 'productos'}. ` +
              'Mejora el plan para seguir registrando.',
            { limite: plan.maxProducts, actuales },
          )
        }
      }

      const warehouse = await t.warehouse.findFirst({
        where: { id: input.warehouseId, isActive: true, deletedAt: null },
        select: { id: true },
      })
      if (!warehouse) {
        throw new BusinessError('TENANT_MISMATCH', 'El almacén no está disponible.')
      }

      const product = await t.product.create({
        data: {
          tenantId: ctx.tenantId,
          sku,
          barcode: input.barcode ?? null,
          qrCode: input.qrCode ?? null,
          name: input.name,
          unitType: input.unitType,
          salePrice: input.salePrice,
          costPrice: input.costPrice ?? 0,
          minStock: input.minStock,
        },
        select: { id: true, sku: true, barcode: true, name: true },
      })

      const stock = await t.stock.create({
        data: {
          tenantId: ctx.tenantId,
          productId: product.id,
          variantId: null,
          warehouseId: input.warehouseId,
          quantity: input.initialStock,
          reserved: 0,
        },
        select: { quantity: true, version: true },
      })

      // El movimiento INICIAL no es decorativo: sin él, SUM(ledger) dejaría
      // de reconciliar con Stock.quantity y la auditoría de inventario
      // arrancaría con un agujero.
      if (input.initialStock > 0) {
        await t.stockMovement.create({
          data: {
            tenantId: ctx.tenantId,
            productId: product.id,
            variantId: null,
            warehouseId: input.warehouseId,
            userId: ctx.userId,
            type: 'INICIAL',
            source: 'ESCANER',
            quantity: input.initialStock,
            balanceAfter: input.initialStock,
            unitCost: input.costPrice ?? undefined,
            reason: 'Alta exprés desde el escáner',
            referenceType: 'MANUAL',
            idempotencyKey: input.idempotencyKey ?? null,
          },
        })
      }

      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          actorRole: ctx.role,
          action: 'product.create.express',
          entityType: 'Product',
          entityId: product.id,
          after: { name: product.name, sku: product.sku, stockInicial: input.initialStock },
          impersonationId: ctx.impersonationId ?? null,
        },
      })

      return {
        productId: product.id,
        sku: product.sku,
        barcode: product.barcode,
        name: product.name,
        quantity: Number(stock.quantity),
        version: stock.version,
        alreadyExisted: false,
      }
    })
  } catch (e) {
    if (esColisionUnica(e)) {
      /*
       * `e.meta.target` NO lo rellena el driver adapter de pg, así que esta
       * discriminación llevaba tiempo sin funcionar: toda colisión caía en el
       * mensaje del SKU, incluso cuando el duplicado era el código de barras,
       * y se pedía corregir un campo que estaba bien. Lo detectó la depuración
       * del alta de sucursales. Ver src/lib/prisma-errors.ts.
       */
      const campos = camposDeColision(e)
      // Carrera con otro dispositivo entre el chequeo y el insert.
      if (campos.includes('barcode')) {
        throw new BusinessError(
          'DUPLICATE_CODE',
          'Otro dispositivo acaba de registrar este código. Vuelve a escanear.',
        )
      }
      throw new BusinessError(
        'DUPLICATE_CODE',
        'Ya existe un producto con ese código interno (SKU).',
      )
    }
    throw e
  }
}
