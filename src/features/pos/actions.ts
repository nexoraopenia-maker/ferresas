'use server'

import { resolverCodigo, mensajeAmbiguo } from '@/features/inventory/codigos'
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
import { buscarProductos, MIN_CARACTERES } from './busqueda'
import { resolverCliente } from './cliente-service'
import {
  cancelarPedido as runCancelarPedido, cobrarPedido as runCobrarPedido, crearPedido as runCrearPedido,
  listarPedidos as runListarPedidos, soltarPedido as runSoltarPedido, tomarPedido as runTomarPedido,
  type PedidoTomado,
} from './pedido-service'
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
  /** Solo en la búsqueda: 0 = coincide exactamente con un código. Menor = mejor. */
  relevancia?: number
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

    // Un código, un dueño: la tabla de códigos resuelve a {producto, variante, presentación} en UNA consulta (con el
    // respaldo de las columnas antiguas mientras no se haya rellenado). Un código de varios dueños no se adivina.
    const r = await resolverCodigo(db, code, { almacenId: warehouse.id })

    // `null` es "no existe ese código", no un error: la UI ofrece buscar por
    // nombre o dar de alta el producto.
    if (!r) return { ok: true, data: null }
    if (r.estado === 'ambiguo') return { ok: false, code: 'DUPLICATE_CODE', message: mensajeAmbiguo(r) }

    const { producto: product, variante } = r
    const stock = r.stock ? Number(r.stock.quantity) : 0
    const minStock = Number(r.stock?.minStock ?? variante?.minStock ?? product.minStock)

    return {
      ok: true,
      data: {
        productId: product.id,
        variantId: variante?.id ?? null,
        name: variante ? `${product.name} ${variante.name}` : product.name,
        sku: variante?.sku ?? product.sku,
        barcode: variante?.barcode ?? product.barcode,
        qrCode: variante?.qrCode ?? product.qrCode,
        unitType: product.unitType,
        // La venta cobra el precio del PRODUCTO (el de la variante aún no lo usa `registerSale`): se muestra el mismo.
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

/**
 * Búsqueda del POS: código de barras, SKU o nombre parcial, ordenada por lo
 * parecido que es (ver `busqueda.ts`).
 */
export async function searchForPos(
  texto: string,
): Promise<ActionResult<PosProduct[]>> {
  const parsed = z.string().trim().min(MIN_CARACTERES).max(80).safeParse(texto)
  if (!parsed.success) return { ok: true, data: [] }

  return withTenant('searchForPos', async (db, ctx) => {
    const data = await buscarProductos(db, ctx, parsed.data)
    return { ok: true, data }
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
  /** Si es nuevo: de dónde salió el nombre. */
  origen?: 'TECLEADO' | 'PADRON'
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
    // Sin nombre y sin padrón devuelve null: la pantalla pide el nombre a mano.
    const { cliente } = await resolverCliente(db, ctx, parsed.data)
    return { ok: true, data: cliente }
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
      // Los pedidos a caja tienen su propio listado (/pedidos).
      where: { kind: 'COTIZACION' },
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

// ═══════════════════════════════════════════════════════════════════════════
//  PEDIDOS A CAJA
// ═══════════════════════════════════════════════════════════════════════════

/** El vendedor envía el carrito a la cola de caja. */
export async function registerPedido(
  raw: RegisterQuoteInput,
): Promise<ActionResult<{ quoteId: string; number: string; total: number }>> {
  const parsed = registerQuoteSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error)

  return withTenant('registerPedido', async (db, ctx) => {
    const r = await runCrearPedido(db, ctx, parsed.data)
    revalidatePath('/pedidos')
    return { ok: true, data: { quoteId: r.quoteId, number: r.number, total: r.total } }
  })
}

export interface PedidoColaRow {
  id: string
  number: string
  total: number
  lineas: number
  creadoEn: string
  creadoPor: string
  cliente: string | null
  cobrando: string | null
  mio: boolean
  esMio: boolean
}

export async function listarPedidosPendientes(): Promise<ActionResult<PedidoColaRow[]>> {
  return withTenant('listarPedidosPendientes', async (db, ctx) => {
    const filas = await runListarPedidos(db, ctx)
    return {
      ok: true,
      data: filas.map((f) => ({
        id: f.id, number: f.number, total: f.total, lineas: f.lineas, creadoEn: f.creadoEn.toISOString(),
        creadoPor: f.creadoPor, cliente: f.cliente, cobrando: f.cobrando?.nombre ?? null, mio: f.mio, esMio: f.esMio,
      })),
    }
  })
}

export type PedidoTomadoDto = Omit<PedidoTomado, 'reservadoHasta'> & { reservadoHasta: string }

/** Reserva el pedido para cobrarlo (y la renueva si ya era tuya). */
export async function tomarPedido(pedidoId: string): Promise<ActionResult<PedidoTomadoDto>> {
  if (!z.string().min(1).max(64).safeParse(pedidoId).success) return { ok: false, code: 'VALIDATION', message: 'Pedido no válido.' }
  return withTenant('tomarPedido', async (db, ctx) => {
    const p = await runTomarPedido(db, ctx, pedidoId)
    return { ok: true, data: { ...p, reservadoHasta: p.reservadoHasta.toISOString() } }
  })
}

export async function soltarPedido(pedidoId: string): Promise<ActionResult<null>> {
  if (!z.string().min(1).max(64).safeParse(pedidoId).success) return { ok: false, code: 'VALIDATION', message: 'Pedido no válido.' }
  return withTenant('soltarPedido', async (db, ctx) => {
    await runSoltarPedido(db, ctx, pedidoId)
    revalidatePath('/pedidos')
    return { ok: true, data: null }
  })
}

export async function cancelarPedido(pedidoId: string): Promise<ActionResult<null>> {
  if (!z.string().min(1).max(64).safeParse(pedidoId).success) return { ok: false, code: 'VALIDATION', message: 'Pedido no válido.' }
  return withTenant('cancelarPedido', async (db, ctx) => {
    await runCancelarPedido(db, ctx, pedidoId)
    revalidatePath('/pedidos')
    return { ok: true, data: null }
  })
}

export async function cobrarPedido(
  raw: ConvertQuoteInput,
): Promise<ActionResult<{ saleId: string; number: string; total: number; quoteNumber: string }>> {
  const parsed = convertQuoteSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error)

  return withTenant('cobrarPedido', async (db, ctx) => {
    const r = await runCobrarPedido(db, ctx, parsed.data)
    revalidatePath('/pedidos')
    revalidatePath('/pos')
    return { ok: true, data: r }
  })
}
