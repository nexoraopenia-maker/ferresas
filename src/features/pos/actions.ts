'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import { getStockStatus, type StockStatus } from '@/lib/stock-status'
import type { TenantContext } from '@/lib/tenant-context'
import {
  posLookupSchema,
  registerSaleSchema,
  type PosLookupInput,
  type RegisterSaleInput,
} from './schemas'
import { registerSale as runRegisterSale } from './sale-service'

/**
 * Server Actions del Punto de Venta (§5.4).
 *
 * Mismo guion que inventario: sesión en el servidor, Zod antes de la BD,
 * transacción en el servicio y resultado tipado hacia la UI.
 */

function validationFailure(error: z.ZodError): ActionResult<never> {
  return {
    ok: false,
    code: 'VALIDATION',
    message: 'Revisa los datos de la venta.',
    details: z.flattenError(error).fieldErrors,
  }
}

async function withTenant<T>(
  accion: string,
  fn: (db: TenantPrismaClient, ctx: TenantContext) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  let ctx: TenantContext | null = null
  try {
    ctx = await requireTenantContext()
    return await fn(getTenantPrisma(ctx), ctx)
  } catch (e) {
    if (isBusinessError(e)) {
      return { ok: false, code: e.code, message: e.message, details: e.details }
    }
    console.error('[pos] fallo inesperado', {
      accion,
      tenantId: ctx?.tenantId ?? null,
      error: e instanceof Error ? { name: e.name, message: e.message } : e,
    })
    return {
      ok: false,
      code: 'TENANT_MISMATCH',
      message: 'No pudimos completar la operación. Intenta de nuevo.',
    }
  }
}

export interface PosProduct {
  productId: string
  variantId: string | null
  name: string
  sku: string
  barcode: string | null
  qrCode: string | null
  unitType: string
  salePrice: number
  taxRate: number
  trackStock: boolean
  stock: number
  minStock: number
  stockStatus: StockStatus
  warehouseId: string
  warehouseName: string
}

/**
 * Resuelve lo escaneado o teclado a un producto listo para el carrito.
 *
 * Busca por código de barras, QR y SKU en la MISMA consulta. Un solo viaje a
 * la base importa aquí: el cajero escanea con el cliente delante y tres
 * consultas secuenciales contra Neon se notan.
 */
export async function lookupForPos(
  raw: PosLookupInput,
): Promise<ActionResult<PosProduct | null>> {
  const parsed = posLookupSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error)

  return withTenant('lookupForPos', async (db) => {
    const code = parsed.data.code.trim()

    const warehouse = await db.warehouse.findFirst({
      where: parsed.data.warehouseId
        ? { id: parsed.data.warehouseId, isActive: true, deletedAt: null }
        : { isActive: true, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, name: true },
    })

    if (!warehouse) {
      return {
        ok: false,
        code: 'TENANT_MISMATCH',
        message: 'No tienes ningún almacén activo.',
      }
    }

    const product = await db.product.findFirst({
      where: {
        deletedAt: null,
        isActive: true,
        OR: [{ barcode: code }, { qrCode: code }, { sku: code }],
      },
      select: {
        id: true, name: true, sku: true, barcode: true, qrCode: true,
        unitType: true, salePrice: true, taxRate: true, minStock: true,
        trackStock: true,
        stocks: {
          where: { warehouseId: warehouse.id, variantId: null },
          select: { quantity: true, minStock: true },
          take: 1,
        },
      },
    })

    // `null` es "no existe ese código", no un error: la UI ofrece buscar por
    // nombre o dar de alta el producto.
    if (!product) return { ok: true, data: null }

    const s = product.stocks[0]
    const stock = s ? Number(s.quantity) : 0
    const minStock = Number(s?.minStock ?? product.minStock)

    return {
      ok: true,
      data: {
        productId: product.id,
        variantId: null,
        name: product.name,
        sku: product.sku,
        barcode: product.barcode,
        qrCode: product.qrCode,
        unitType: product.unitType,
        salePrice: Number(product.salePrice),
        taxRate: Number(product.taxRate),
        trackStock: product.trackStock,
        stock,
        minStock,
        stockStatus: getStockStatus(stock, minStock),
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
      },
    }
  })
}

/** Búsqueda por nombre, para cuando el código no se lee o no existe. */
export async function searchForPos(
  texto: string,
): Promise<ActionResult<PosProduct[]>> {
  const parsed = z.string().trim().min(2).max(80).safeParse(texto)
  if (!parsed.success) return { ok: true, data: [] }

  return withTenant('searchForPos', async (db) => {
    const warehouse = await db.warehouse.findFirst({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, name: true },
    })
    if (!warehouse) return { ok: true, data: [] }

    const productos = await db.product.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        name: { contains: parsed.data, mode: 'insensitive' },
      },
      orderBy: { name: 'asc' },
      take: 20,
      select: {
        id: true, name: true, sku: true, barcode: true, qrCode: true,
        unitType: true, salePrice: true, taxRate: true, minStock: true,
        trackStock: true,
        stocks: {
          where: { warehouseId: warehouse.id, variantId: null },
          select: { quantity: true, minStock: true },
          take: 1,
        },
      },
    })

    return {
      ok: true,
      data: productos.map((p) => {
        const s = p.stocks[0]
        const stock = s ? Number(s.quantity) : 0
        const minStock = Number(s?.minStock ?? p.minStock)
        return {
          productId: p.id,
          variantId: null,
          name: p.name,
          sku: p.sku,
          barcode: p.barcode,
          qrCode: p.qrCode,
          unitType: p.unitType,
          salePrice: Number(p.salePrice),
          taxRate: Number(p.taxRate),
          trackStock: p.trackStock,
          stock,
          minStock,
          stockStatus: getStockStatus(stock, minStock),
          warehouseId: warehouse.id,
          warehouseName: warehouse.name,
        }
      }),
    }
  })
}

export interface SaleReceipt {
  saleId: string
  number: string
  subtotal: number
  taxTotal: number
  discountTotal: number
  total: number
  soldBelowStock: boolean
}

export async function registerSale(
  raw: RegisterSaleInput,
): Promise<ActionResult<SaleReceipt>> {
  const parsed = registerSaleSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error)

  return withTenant('registerSale', async (db, ctx) => {
    const r = await runRegisterSale(db, ctx, parsed.data)
    revalidatePath('/pos')
    revalidatePath('/inventario')
    return {
      ok: true,
      data: {
        saleId: r.saleId,
        number: r.number,
        subtotal: r.subtotal,
        taxTotal: r.taxTotal,
        discountTotal: r.discountTotal,
        total: r.total,
        soldBelowStock: r.soldBelowStock,
      },
    }
  })
}
