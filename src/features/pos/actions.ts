'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import { getStockStatus, type StockStatus } from '@/lib/stock-status'
import type { TenantContext } from '@/lib/tenant-context'
import {
  convertQuoteSchema,
  customerByDocSchema,
  posLookupSchema,
  registerQuoteSchema,
  registerSaleSchema,
  type ConvertQuoteInput,
  type CustomerByDocInput,
  type PosLookupInput,
  type RegisterQuoteInput,
  type RegisterSaleInput,
} from './schemas'
import { filtroAlmacen } from '@/features/branches/queries'
import { registerSale as runRegisterSale } from './sale-service'
import {
  convertQuoteToSale as runConvertQuote,
  registerQuote as runRegisterQuote,
} from './quote-service'

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

  return withTenant('lookupForPos', async (db, ctx) => {
    const code = parsed.data.code.trim()

    const warehouse = await db.warehouse.findFirst({
      where: filtroAlmacen(ctx.branchId, parsed.data.warehouseId),
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

  return withTenant('searchForPos', async (db, ctx) => {
    const warehouse = await db.warehouse.findFirst({
      where: filtroAlmacen(ctx.branchId),
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

// ---------------------------------------------------------------------------
//  CLIENTE POR DOCUMENTO
// ---------------------------------------------------------------------------

export interface PosCustomer {
  id: string
  docType: string
  docNumber: string | null
  name: string
  /** Se acaba de crear en esta llamada. */
  creado: boolean
}

/**
 * Busca un cliente por DNI/RUC y, si no existe y se dio nombre, lo crea.
 *
 * El tipo de documento se DEDUCE del largo: 8 dígitos es DNI, 11 es RUC.
 * Preguntarlo en un desplegable mientras el cliente espera en el mostrador
 * es fricción que el número ya resolvía.
 *
 * Buscar es una lectura, así que funciona con la suscripción en READ_ONLY;
 * crear es escritura y el cliente aislado la bloqueará si corresponde.
 */
export async function findOrCreateCustomerByDoc(
  raw: CustomerByDocInput,
): Promise<ActionResult<PosCustomer | null>> {
  const parsed = customerByDocSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error)

  return withTenant('findOrCreateCustomerByDoc', async (db, ctx) => {
    const { docNumber, name } = parsed.data
    const docType = docNumber.length === 11 ? 'RUC' : 'DNI'

    const existente = await db.customer.findFirst({
      where: { docType, docNumber, deletedAt: null },
      select: { id: true, docType: true, docNumber: true, name: true },
    })

    if (existente) {
      const dato: PosCustomer = { ...existente, creado: false }
      return { ok: true, data: dato }
    }

    // Sin nombre no se crea: se devuelve null para que la UI lo pida. Crear
    // un cliente llamado "20512345678" ensucia el padrón para siempre.
    if (!name) return { ok: true, data: null }

    const nuevo = await db.customer.create({
      data: { tenantId: ctx.tenantId, docType, docNumber, name },
      select: { id: true, docType: true, docNumber: true, name: true },
    })

    const dato: PosCustomer = { ...nuevo, creado: true }
    return { ok: true, data: dato }
  })
}

// ---------------------------------------------------------------------------
//  COTIZACIONES
// ---------------------------------------------------------------------------

export interface QuoteReceipt {
  quoteId: string
  number: string
  total: number
  validUntil: string
}

export async function registerQuote(
  raw: RegisterQuoteInput,
): Promise<ActionResult<QuoteReceipt>> {
  const parsed = registerQuoteSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error)

  return withTenant('registerQuote', async (db, ctx) => {
    const r = await runRegisterQuote(db, ctx, parsed.data)
    revalidatePath('/cotizaciones')
    return {
      ok: true,
      data: {
        quoteId: r.quoteId,
        number: r.number,
        total: r.total,
        validUntil: r.validUntil.toISOString(),
      },
    }
  })
}

export async function convertQuote(
  raw: ConvertQuoteInput,
): Promise<ActionResult<{ saleId: string; number: string; total: number; quoteNumber: string }>> {
  const parsed = convertQuoteSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error)

  return withTenant('convertQuote', async (db, ctx) => {
    const r = await runConvertQuote(db, ctx, parsed.data)
    revalidatePath('/cotizaciones')
    revalidatePath('/pos')
    return { ok: true, data: r }
  })
}

export interface QuoteListRow {
  id: string
  number: string
  status: string
  customerName: string | null
  customerDoc: string | null
  total: string
  validUntil: string | null
  vencida: boolean
  lineas: number
  createdAt: string
  saleNumber: string | null
}

/** Cotizaciones del negocio, para retomarlas. */
export async function listQuotes(): Promise<ActionResult<QuoteListRow[]>> {
  return withTenant('listQuotes', async (db) => {
    const ahora = new Date()
    const quotes = await db.quote.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, number: true, status: true, total: true,
        validUntil: true, createdAt: true,
        customer: { select: { name: true, docNumber: true } },
        sale: { select: { number: true } },
        _count: { select: { items: true } },
      },
    })

    return {
      ok: true,
      data: quotes.map((q) => ({
        id: q.id,
        number: q.number,
        status: q.status,
        customerName: q.customer?.name ?? null,
        customerDoc: q.customer?.docNumber ?? null,
        total: q.total.toFixed(2),
        validUntil: q.validUntil?.toISOString() ?? null,
        vencida: Boolean(q.validUntil && q.validUntil < ahora && q.status !== 'CONVERTIDA'),
        lineas: q._count.items,
        createdAt: q.createdAt.toISOString(),
        saleNumber: q.sale?.number ?? null,
      })),
    }
  })
}
