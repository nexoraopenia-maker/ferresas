import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { redondearCentimos } from '@/lib/dinero'
import { hasRole, requireBranch, type TenantContext } from '@/lib/tenant-context'
import { cargarSucursalOperativa, serieDe } from '@/features/branches/queries'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import {
  claimNextNumber, ensureCounter, overrideKey, registerSale,
  type PriceOverrides,
} from './sale-service'
import type { ConvertQuoteInput, RegisterQuoteInput } from './schemas'

function num(d: Prisma.Decimal | number | null | undefined): number {
  if (d === null || d === undefined) return 0
  return typeof d === 'number' ? d : d.toNumber()
}

/**
 * Redondeo a céntimos, half-up. Único en todo el proyecto.
 *
 * Ver src/lib/dinero.ts para el porqué del `toFixed(4)` intermedio.
 */
const cent = redondearCentimos

export interface QuoteResult {
  quoteId: string
  number: string
  subtotal: number
  taxTotal: number
  total: number
  validUntil: Date
}

/**
 * Guarda el carrito como cotización (§5.4).
 *
 * ─── LA DIFERENCIA CON UNA VENTA ─────────────────────────────────────────
 *
 * Una cotización NO toca el stock. Es una promesa de precio, no un
 * movimiento de mercadería: si reservara inventario, un cliente que pide
 * presupuesto y no vuelve dejaría producto bloqueado indefinidamente, y en
 * una ferretería eso significa no poder vender lo que sí está en el estante.
 *
 * Lo que SÍ congela son los PRECIOS, copiándolos a las líneas. Al convertir
 * se cobra lo cotizado, no lo que marque la lista ese día — que es
 * exactamente para lo que el cliente pidió la cotización.
 */
export async function registerQuote(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: RegisterQuoteInput,
  now: Date = new Date(),
): Promise<QuoteResult> {
  if (!hasRole(ctx.role, 'VENDEDOR')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para cotizar.')
  }

  const branchId = requireBranch(ctx)
  const sucursal = await cargarSucursalOperativa(db, branchId)
  const serie = serieDe(sucursal, 'QUOTE')

  await ensureCounter(db, ctx.tenantId, branchId, 'QUOTE', serie.series, serie.prefix)

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient

    // Mismo motivo que en registerSale: el almacén debe ser de esta sucursal.
    const warehouse = await t.warehouse.findFirst({
      where: { id: input.warehouseId, branchId, isActive: true, deletedAt: null },
      select: { id: true },
    })
    if (!warehouse) {
      throw new BusinessError('TENANT_MISMATCH', 'El almacén no está disponible.')
    }

    if (input.customerId) {
      const c = await t.customer.findFirst({
        where: { id: input.customerId, deletedAt: null },
        select: { id: true },
      })
      if (!c) throw new BusinessError('TENANT_MISMATCH', 'El cliente no existe.')
    }

    const ids = [...new Set(input.items.map((i) => i.productId))]
    const productos = await t.product.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      select: {
        id: true, name: true, sku: true, unitType: true,
        salePrice: true, taxRate: true,
      },
    })
    const porId = new Map(productos.map((p) => [p.id, p]))
    if (ids.some((i) => !porId.has(i))) {
      throw new BusinessError('TENANT_MISMATCH', 'Un producto ya no está disponible.')
    }

    let subtotal = 0
    let taxTotal = 0
    let discountTotal = 0

    const lineas = input.items.map((item) => {
      const p = porId.get(item.productId)!
      const precio = num(p.salePrice)
      const bruto = cent(precio * item.quantity)

      if (item.discount > bruto) {
        throw new BusinessError(
          'INSUFFICIENT_STOCK',
          `El descuento de "${p.name}" supera el importe de la línea.`,
        )
      }

      const neto = cent(bruto - item.discount)
      const tasa = num(p.taxRate)
      // Mismo criterio que en la venta: el precio ya incluye IGV, se extrae.
      const base = cent(neto / (1 + tasa))
      const igv = cent(neto - base)

      subtotal = cent(subtotal + base)
      taxTotal = cent(taxTotal + igv)
      discountTotal = cent(discountTotal + item.discount)

      return { item, producto: p, unitPrice: precio, lineTotal: neto, taxRate: tasa }
    })

    const total = cent(subtotal + taxTotal)
    const { correlativo, prefix, series } = await claimNextNumber(
      t, ctx.tenantId, 'QUOTE', serie.series,
    )
    const number = `${prefix}${series}-${String(correlativo).padStart(8, '0')}`
    const validUntil = new Date(now.getTime() + input.validDays * 86_400_000)

    const quote = await t.quote.create({
      data: {
        tenantId: ctx.tenantId,
        branchId,
        warehouseId: input.warehouseId,
        customerId: input.customerId ?? null,
        userId: ctx.userId,
        number,
        status: 'BORRADOR',
        subtotal, taxTotal, discountTotal, total,
        validUntil,
        notes: input.notes ?? null,
      },
      select: { id: true, number: true },
    })

    await t.quoteItem.createMany({
      data: lineas.map((l) => ({
        tenantId: ctx.tenantId,
        quoteId: quote.id,
        productId: l.producto.id,
        variantId: l.item.variantId ?? null,
        nameSnapshot: l.producto.name,
        skuSnapshot: l.producto.sku,
        unitType: l.producto.unitType,
        quantity: l.item.quantity,
        unitPrice: l.unitPrice,
        discount: l.item.discount,
        taxRate: l.taxRate,
        lineTotal: l.lineTotal,
      })),
    })

    const period = now.toISOString().slice(0, 7)
    await t.usagePeriod.upsert({
      where: { tenantId_period: { tenantId: ctx.tenantId, period } },
      create: { tenantId: ctx.tenantId, period, quotesCount: 1 },
      update: { quotesCount: { increment: 1 } },
    })

    return {
      quoteId: quote.id,
      number: quote.number,
      subtotal, taxTotal, total,
      validUntil,
    }
  }, { maxWait: 15_000, timeout: 30_000 })
}

/**
 * Convierte una cotización en venta.
 *
 * Reutiliza `registerSale`, que es donde vive el descuento de stock con su
 * guard de concurrencia. Duplicar esa lógica aquí habría significado dos
 * caminos para vender, y el día que se corrigiera uno el otro quedaría
 * dejando el inventario en negativo sin avisar.
 *
 * Las CANTIDADES y los PRECIOS salen de la cotización, no de la lista
 * actual: el cliente pidió un presupuesto precisamente para que el precio
 * no se mueva.
 */
export async function convertQuoteToSale(
  db: TenantPrismaClient,
  ctx: TenantContext,
  input: ConvertQuoteInput,
  now: Date = new Date(),
): Promise<{ saleId: string; number: string; total: number; quoteNumber: string }> {
  if (!hasRole(ctx.role, 'VENDEDOR')) {
    throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para vender.')
  }

  const quote = await db.quote.findFirst({
    where: { id: input.quoteId },
    select: {
      id: true, number: true, status: true, validUntil: true,
      warehouseId: true, customerId: true,
      sale: { select: { id: true, number: true, total: true } },
      items: {
        select: {
          productId: true, variantId: true, quantity: true,
          discount: true, unitPrice: true,
        },
      },
    },
  })

  if (!quote) throw new BusinessError('TENANT_MISMATCH', 'La cotización no existe.')

  // Reintento o doble clic: se devuelve la venta que ya se generó.
  if (quote.sale) {
    return {
      saleId: quote.sale.id,
      number: quote.sale.number,
      total: num(quote.sale.total),
      quoteNumber: quote.number,
    }
  }

  if (quote.status === 'RECHAZADA') {
    throw new BusinessError(
      'DUPLICATE_CODE',
      'Esta cotización fue rechazada. Crea una nueva.',
    )
  }

  // Una cotización vencida NO se convierte en silencio: sus precios son de
  // otro momento. Hay que renovarla, que es una decisión del negocio.
  if (quote.validUntil && quote.validUntil < now) {
    throw new BusinessError(
      'DUPLICATE_CODE',
      `La cotización ${quote.number} venció el ${quote.validUntil.toLocaleDateString('es-PE')}. Vuelve a cotizar con los precios de hoy.`,
      { vencio: quote.validUntil.toISOString() },
    )
  }

  if (quote.items.length === 0) {
    throw new BusinessError('TENANT_MISMATCH', 'La cotización no tiene líneas.')
  }

  // Los precios CONGELADOS en la cotización, no los de la lista de hoy.
  const precios: PriceOverrides = new Map(
    quote.items.map((i) => [overrideKey(i.productId, i.variantId), num(i.unitPrice)]),
  )

  const venta = await registerSale(db, ctx, {
    warehouseId: quote.warehouseId,
    customerId: quote.customerId,
    items: quote.items.map((i) => ({
      productId: i.productId,
      variantId: i.variantId,
      quantity: num(i.quantity),
      discount: num(i.discount),
    })),
    payments: input.payments,
    documentType: input.documentType,
    allowNegativeStock: input.allowNegativeStock,
    idempotencyKey: input.idempotencyKey,
    notes: `Convertida de la cotización ${quote.number}`,
  }, precios)

  await db.$transaction([
    db.sale.update({
      where: { id: venta.saleId },
      data: { quoteId: quote.id },
    }),
    db.quote.update({
      where: { id: quote.id },
      data: { status: 'CONVERTIDA' },
    }),
  ])

  return {
    saleId: venta.saleId,
    number: venta.number,
    total: venta.total,
    quoteNumber: quote.number,
  }
}
