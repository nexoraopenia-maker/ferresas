'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getTenantPrisma, type TenantPrismaClient } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { isBusinessError, type ActionResult } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
import { getStockStatus, type StockStatus } from '@/lib/stock-status'
import {
  createProductExpressSchema,
  createStockMovementSchema,
  findProductByCodeSchema,
  type CreateProductExpressInput,
  type CreateStockMovementInput,
  type FindProductByCodeInput,
} from './schemas'
import { createStockMovement as runCreateStockMovement } from './stock-service'
import { createProductExpress as runCreateProductExpress } from './product-service'
import {
  analyzeImport as runAnalyze,
  commitImport as runCommit,
  MAX_FILAS,
  type AnalisisImport,
} from './import-service'

/**
 * Server Actions de inventario (§5.1, §6).
 *
 * Cada una hace exactamente lo mismo en el mismo orden:
 *   1. Resolver el contexto en el SERVIDOR (nunca del cliente).
 *   2. Validar el input con Zod ANTES de tocar la BD.
 *   3. Delegar en el servicio, que corre dentro de $transaction.
 *   4. Traducir errores a un resultado TIPADO — nunca lanzar hacia el cliente.
 *
 * Nada devuelve excepciones al navegador: un throw en una Server Action llega
 * al cliente como "An error occurred in the Server Components render", que no
 * le sirve ni al almacenero ni a quien depure (§6.7).
 */

/** Convierte un ZodError en algo que la UI puede pintar campo por campo. */
function validationFailure(error: z.ZodError): ActionResult<never> {
  return {
    ok: false,
    code: 'VALIDATION',
    message: 'Revisa los datos ingresados.',
    details: z.flattenError(error).fieldErrors,
  }
}

function businessFailure(
  e: unknown,
  accion: string,
  tenantId: string | null,
): ActionResult<never> {
  if (isBusinessError(e)) {
    return { ok: false, code: e.code, message: e.message, details: e.details }
  }

  // Error inesperado: al log va el contexto completo, al cliente solo un
  // mensaje genérico. Nunca se filtra el tenantId ni IDs internos (§6.8).
  console.error('[inventory] fallo inesperado', {
    accion,
    tenantId,
    error: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
  })

  return {
    ok: false,
    code: 'TENANT_MISMATCH',
    message: 'No pudimos completar la operación. Intenta de nuevo.',
  }
}

/**
 * Envoltorio común: resuelve la sesión, construye el cliente aislado y
 * traduce cualquier fallo a un ActionResult.
 *
 * La resolución de sesión va DENTRO del try porque también puede fallar —
 * sesión expirada, usuario desactivado a media jornada, tenant borrado. Si
 * quedara fuera, esos casos se escaparían como excepción hacia el navegador.
 */
async function withTenant<T>(
  accion: string,
  fn: (db: TenantPrismaClient, ctx: TenantContext) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  let ctx: TenantContext | null = null
  try {
    ctx = await requireTenantContext()
    return await fn(getTenantPrisma(ctx), ctx)
  } catch (e) {
    return businessFailure(e, accion, ctx?.tenantId ?? null)
  }
}

// ---------------------------------------------------------------------------

export interface ScannedProduct {
  productId: string
  variantId: string | null
  name: string
  sku: string
  barcode: string | null
  unitType: string
  salePrice: string
  warehouseId: string
  warehouseName: string
  quantity: number
  minStock: number
  status: StockStatus
  /** Necesaria para el bloqueo optimista de un AJUSTE. */
  version: number
}

/**
 * Resuelve el código leído por el escáner a un producto con su stock.
 *
 * Es una lectura, así que funciona incluso con la suscripción en READ_ONLY:
 * un ferretero moroso debe poder seguir consultando su inventario (§5.2).
 */
export async function findProductByCode(
  raw: FindProductByCodeInput,
): Promise<ActionResult<ScannedProduct | null>> {
  const parsed = findProductByCodeSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error)

  return withTenant('findProductByCode', async (db) => {
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
        message: 'No tienes ningún almacén activo. Crea uno para empezar.',
      }
    }

    // Se busca por código de barras, QR y SKU en la misma consulta: el
    // operario no sabe —ni tiene por qué— qué clase de código está leyendo.
    const product = await db.product.findFirst({
      where: {
        deletedAt: null,
        isActive: true,
        OR: [{ barcode: code }, { qrCode: code }, { sku: code }],
      },
      select: {
        id: true,
        name: true,
        sku: true,
        barcode: true,
        qrCode: true,
        unitType: true,
        salePrice: true,
        minStock: true,
        stocks: {
          where: { warehouseId: warehouse.id, variantId: null },
          select: { quantity: true, minStock: true, version: true },
          take: 1,
        },
      },
    })

    // `null` no es un error: es "este código todavía no existe" y dispara el
    // alta exprés en la UI (§5.1). Devolverlo como error obligaría a la UI a
    // distinguir un fallo real de un caso de uso normal.
    if (!product) return { ok: true, data: null }

    const stock = product.stocks[0]
    const quantity = stock ? Number(stock.quantity) : 0
    const minStock = Number(stock?.minStock ?? product.minStock)

    return {
      ok: true,
      data: {
        productId: product.id,
        variantId: null,
        name: product.name,
        sku: product.sku,
        barcode: product.barcode,
        unitType: product.unitType,
        salePrice: product.salePrice.toString(),
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        quantity,
        minStock,
        status: getStockStatus(quantity, minStock),
        version: stock?.version ?? 0,
      },
    }
  })
}

// ---------------------------------------------------------------------------

export interface StockMovementSuccess {
  movementId: string
  balanceAfter: number
  version: number
  status: StockStatus
  replayed: boolean
  wentNegative: boolean
}

/**
 * Registra una entrada, salida o ajuste de inventario.
 * Toda la mutación ocurre dentro de un $transaction (§6.2).
 */
export async function createStockMovement(
  raw: CreateStockMovementInput,
): Promise<ActionResult<StockMovementSuccess>> {
  const parsed = createStockMovementSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error)

  return withTenant('createStockMovement', async (db, ctx) => {
    const result = await runCreateStockMovement(db, ctx, parsed.data)

    // El mínimo se relee del producto porque el movimiento pudo cambiarlo.
    const product = await db.product.findFirst({
      where: { id: result.productId },
      select: { minStock: true },
    })
    const minStock = Number(product?.minStock ?? 0)

    revalidatePath('/inventario')

    return {
      ok: true,
      data: {
        movementId: result.movementId,
        balanceAfter: result.balanceAfter,
        version: result.version,
        status: getStockStatus(result.balanceAfter, minStock),
        replayed: result.replayed,
        wentNegative: result.wentNegative,
      },
    }
  })
}

// ---------------------------------------------------------------------------

/**
 * Alta exprés de producto desde el escáner (§5.1).
 *
 * Devuelve el producto ya listo para operar: la UI encadena directamente con
 * el selector de cantidad sin volver a consultar ni sacar al operario del
 * bottom sheet.
 */
export async function createProductExpress(
  raw: CreateProductExpressInput,
): Promise<ActionResult<ScannedProduct & { alreadyExisted: boolean }>> {
  const parsed = createProductExpressSchema.safeParse(raw)
  if (!parsed.success) return validationFailure(parsed.error)

  return withTenant('createProductExpress', async (db, ctx) => {
    const created = await runCreateProductExpress(db, ctx, parsed.data)

    const warehouse = await db.warehouse.findFirstOrThrow({
      where: { id: parsed.data.warehouseId },
      select: { id: true, name: true },
    })

    revalidatePath('/inventario')

    return {
      ok: true,
      data: {
        productId: created.productId,
        variantId: null,
        name: created.name,
        sku: created.sku,
        barcode: created.barcode,
        unitType: parsed.data.unitType,
        salePrice: String(parsed.data.salePrice),
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        quantity: created.quantity,
        minStock: parsed.data.minStock,
        status: getStockStatus(created.quantity, parsed.data.minStock),
        version: created.version,
        alreadyExisted: created.alreadyExisted,
      },
    }
  })
}

/**
 * Almacén por defecto del tenant. Lo necesita el alta exprés, que ocurre
 * antes de que exista un producto al que colgarse.
 */
export async function getDefaultWarehouse(): Promise<
  ActionResult<{ id: string; name: string }>
> {
  return withTenant('getDefaultWarehouse', async (db) => {
    const w = await db.warehouse.findFirst({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, name: true },
    })
    if (!w) {
      return {
        ok: false,
        code: 'TENANT_MISMATCH',
        message: 'No tienes ningún almacén activo. Crea uno para empezar.',
      }
    }
    return { ok: true, data: w }
  })
}

// ---------------------------------------------------------------------------
//  IMPORTACIÓN MASIVA DE CATÁLOGO
// ---------------------------------------------------------------------------

/** Tope del contenido que se acepta, para no agotar la memoria del servidor. */
const MAX_BYTES = 4 * 1024 * 1024

/**
 * Analiza el archivo SIN escribir nada y devuelve el resultado fila por fila.
 *
 * El contenido llega como texto y no como `File`: el navegador ya lo leyó,
 * así que la Server Action recibe una cadena y no hay que montar un endpoint
 * de subida con `multipart`. Para catálogos de unos pocos megas es lo más
 * simple que funciona.
 */
export async function analyzeCatalogImport(
  contenido: string,
): Promise<ActionResult<AnalisisImport>> {
  if (typeof contenido !== 'string' || contenido.trim() === '') {
    return { ok: false, code: 'VALIDATION', message: 'El archivo está vacío.' }
  }
  if (contenido.length > MAX_BYTES) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: `El archivo pasa de 4 MB. Párte el catálogo en varios de hasta ${MAX_FILAS} filas.`,
    }
  }

  return withTenant('analyzeCatalogImport', async (db, ctx) => {
    const analisis = await runAnalyze(db, ctx, contenido)
    return { ok: true, data: analisis }
  })
}

/**
 * Escribe lo analizado.
 *
 * Recibe el ANÁLISIS y no el archivo porque es lo que la persona revisó y
 * aprobó. Volver a parsear aquí abriría la puerta a que se escribiera algo
 * distinto de lo que se vio en la vista previa.
 *
 * Aun así se revalida el rol y los bloqueos en el servicio: el análisis llega
 * del cliente y podría venir manipulado.
 */
export async function commitCatalogImport(
  analisis: AnalisisImport,
  warehouseId: string,
): Promise<ActionResult<{ creados: number; actualizados: number; omitidos: number }>> {
  if (!analisis || !Array.isArray(analisis.filas)) {
    return { ok: false, code: 'VALIDATION', message: 'Análisis no válido.' }
  }

  return withTenant('commitCatalogImport', async (db, ctx) => {
    const r = await runCommit(db, ctx, analisis, warehouseId)
    revalidatePath('/inventario')
    return { ok: true, data: r }
  })
}
