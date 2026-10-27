import { Prisma } from '@/generated/prisma/client'
import type { UnitType } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import { P2002_UNIQUE } from '@/lib/prisma-errors'
import { exigir } from '@/lib/puede'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { cargarSucursalOperativa, serieDe, verificarAlmacenDeSucursal } from '@/features/branches/queries'
import { hoyEnZona, sumarDias } from '@/features/credito/reglas'
import { ConversionInvalida, convertirCantidad } from '@/features/inventory/conversion'
import { cargarPresentaciones } from '@/features/inventory/presentacion-linea'
import { applyStockMovement } from '@/features/inventory/stock-service'
import type { CreateStockMovementInput } from '@/features/inventory/schemas'
import { claimNextNumber, ensureCounter } from '@/features/pos/sale-service'
import { bloquearProveedor } from '@/features/proveedores/service'
import { puedeVerProveedores } from '@/features/proveedores/permisos'
import { costoBase, costoTrasCompra, costoTrasDevolucion, igvDeCompra, totalDeLinea } from './costo'
import type {
  AnularCompraInput, CrearBorradorInput, EditarBorradorInput, LineaCompraInput, ListarComprasInput, RecibirCompraInput,
} from './schemas'

/**
 * Compras de mercadería. Ciclo de vida ESTRICTO:  BORRADOR → RECIBIDA → ANULADA.
 *
 *  · BORRADOR: se arma y se edita sin tocar stock, costos ni deuda. Se puede anular.
 *  · RECIBIDA (UNA transacción): entra el stock (`applyStockMovement`), se recalcula el costo promedio ponderado móvil SIN IGV y,
 *    si es a crédito, nace la cuenta por pagar y sube lo que se le debe al proveedor. O todo, o nada.
 *  · ANULADA: una recibida solo se anula si el stock de cada línea sigue ahí (no se deja en negativo) y si NO hay pagos aplicados.
 *    Devuelve el stock como DEVOLUCION_PROVEEDOR, revierte el costo y cierra la deuda.
 *
 * ─── Concurrencia ────────────────────────────────────────────────────────
 * Toda operación empieza por TOMAR la fila de la compra (un UPDATE que espera a quien la tenga) y relee el estado ya firme: dos
 * «recibir» simultáneos no se pisan (el segundo ve RECIBIDA y devuelve `replayed`), y «recibir» contra «anular» se serializan.
 * Orden fijo de bloqueos, para que no haya abrazos mortales: compra → proveedor → productos (por id) → filas de stock.
 *
 * ─── Idempotencia ────────────────────────────────────────────────────────
 * Crear: por `idempotencyKey` (única por negocio). Recibir y anular: por estado — repetirlos no repite el efecto.
 */

const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 0)
const invalido = (m: string) => new BusinessError('INVALID_DOCUMENT', m)
const noExiste = () => new BusinessError('NOT_FOUND', 'La compra no existe.')
const OPCIONES_TX = { maxWait: 15_000, timeout: 30_000 } as const

/** Compras: ver = quien gestiona proveedores, registra compras o paga. */
function exigirVer(ctx: TenantContext): void {
  if (!puedeVerProveedores(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver las compras.')
}

// ─── Líneas ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface LineaResuelta {
  productId: string
  variantId: string | null
  presentationId: string | null
  presentationName: string | null
  enteredQuantity: string | null
  presentationFactor: string | null
  /** Unidades base: lo que mueve el stock. */
  quantity: string
  /** Por unidad base, a 4 decimales. */
  unitCost: number
  taxRate: number
  lineTotal: number
}

/** Valida y calcula todas las líneas en el SERVIDOR: el cliente solo dice cuánto compró y a cuánto. */
async function resolverLineas(t: TenantPrismaClient, items: readonly LineaCompraInput[]): Promise<LineaResuelta[]> {
  const ids = [...new Set(items.map((i) => i.productId))]
  const productos = await t.product.findMany({
    where: { id: { in: ids }, deletedAt: null }, select: { id: true, name: true, trackStock: true, unitType: true, taxRate: true },
  })
  const porId = new Map(productos.map((p) => [p.id, p]))
  const presentaciones = await cargarPresentaciones(t, items.flatMap((i) => (i.presentationId ? [i.presentationId] : [])))

  return items.map((i): LineaResuelta => {
    const p = porId.get(i.productId)
    if (!p) throw new BusinessError('TENANT_MISMATCH', 'Un producto de la compra no existe.')
    if (!p.trackStock) throw invalido(`«${p.name}» no lleva control de stock: no se puede comprar como mercadería.`)
    if (i.variantId) throw invalido(`«${p.name}»: las compras se registran sobre el producto, no sobre una variante.`)
    const pres = i.presentationId ? presentaciones.get(i.presentationId) : null
    if (i.presentationId && (!pres || pres.productId !== i.productId)) {
      throw new BusinessError('TENANT_MISMATCH', 'La presentación no existe o no es de ese producto.')
    }
    let conv
    try {
      conv = convertirCantidad({
        cantidadIngresada: i.enteredQuantity, factor: pres?.factor ?? '1',
        unidadPresentacion: (pres?.unitType ?? p.unitType) as UnitType, unidadBase: p.unitType,
      })
    } catch (e) {
      if (e instanceof ConversionInvalida) throw invalido(`«${p.name}»: ${e.message}`)
      throw e
    }
    const lineTotal = totalDeLinea(conv.cantidadIngresada, i.unitCost)
    return {
      productId: p.id, variantId: null, presentationId: pres?.id ?? null, presentationName: pres?.name ?? null,
      enteredQuantity: pres ? conv.cantidadIngresada : null, presentationFactor: pres ? conv.factor : null,
      quantity: conv.cantidadBase, unitCost: costoBase(lineTotal, conv.cantidadBase), taxRate: num(p.taxRate), lineTotal,
    }
  })
}

const datosLinea = (tenantId: string, purchaseId: string, l: LineaResuelta) => ({
  tenantId, purchaseId, productId: l.productId, variantId: null, quantity: l.quantity, unitCost: l.unitCost,
  presentationId: l.presentationId, enteredQuantity: l.enteredQuantity, presentationFactor: l.presentationFactor,
  presentationName: l.presentationName, taxRate: l.taxRate, lineTotal: l.lineTotal,
})

const totales = (ls: readonly LineaResuelta[]) => igvDeCompra(ls.map((l) => ({ total: l.lineTotal, tasa: l.taxRate })))

/** La cabecera que depende del proveedor: a crédito exige proveedor activo y calcula el vencimiento. */
async function resolverCabecera(
  t: TenantPrismaClient,
  input: { supplierId?: string | null; paymentCondition: 'CONTADO' | 'CREDITO'; vence?: string },
): Promise<{ supplierId: string | null; dueDate: Date | null }> {
  const supplierId = input.supplierId ?? null
  if (!supplierId) {
    if (input.paymentCondition === 'CREDITO') throw invalido('Una compra a crédito necesita proveedor: es a quien se le va a deber.')
    return { supplierId: null, dueDate: null }
  }
  const s = await t.supplier.findFirst({ where: { id: supplierId }, select: { paymentTermDays: true, isActive: true, deletedAt: true } })
  if (!s) throw new BusinessError('TENANT_MISMATCH', 'El proveedor no existe.')
  if (s.deletedAt || !s.isActive) throw invalido('El proveedor está dado de baja.')
  if (input.paymentCondition === 'CONTADO') return { supplierId, dueDate: null }
  if (input.vence) return { supplierId, dueDate: fechaDia(input.vence) }
  const { timezone } = await t.tenant.findFirstOrThrow({ select: { timezone: true } })
  return { supplierId, dueDate: sumarDias(hoyEnZona(timezone), s.paymentTermDays) }
}

function fechaDia(texto: string): Date {
  const [y, m, d] = texto.split('-').map(Number) as [number, number, number]
  const f = new Date(Date.UTC(y, m - 1, d))
  if (f.getUTCFullYear() !== y || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) throw invalido('La fecha de vencimiento no existe.')
  return f
}

async function exigirFacturaLibre(t: TenantPrismaClient, supplierId: string | null, invoiceRef: string | undefined, excepto?: string) {
  if (!supplierId || !invoiceRef) return
  const otra = await t.purchase.findFirst({
    where: { supplierId, invoiceRef, ...(excepto ? { id: { not: excepto } } : {}) }, select: { number: true },
  })
  if (otra) throw new BusinessError('DUPLICATE_CODE', `Ese documento ya está registrado en la compra ${otra.number}.`)
}

// ─── Crear y editar borrador ────────────────────────────────────────────────────────────────────────────────────────

export interface ResultadoCompra { id: string; number: string; replayed: boolean }

export async function crearBorrador(db: TenantPrismaClient, ctx: TenantContext, input: CrearBorradorInput): Promise<ResultadoCompra> {
  exigir(ctx, 'compras.registrar')
  const previa = await compraPorClave(db, input.idempotencyKey)
  if (previa) return previa

  const branchId = requireBranch(ctx)
  const sucursal = await cargarSucursalOperativa(db, branchId)
  await verificarAlmacenDeSucursal(db, branchId, input.warehouseId)
  const serie = serieDe(sucursal, 'PURCHASE')
  await ensureCounter(db, ctx.tenantId, branchId, 'PURCHASE', serie.series, serie.prefix)

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      const lineas = await resolverLineas(t, input.items)
      const cab = await resolverCabecera(t, input)
      await exigirFacturaLibre(t, cab.supplierId, input.invoiceRef)
      const tot = totales(lineas)
      const n = await claimNextNumber(t, ctx.tenantId, 'PURCHASE', serie.series)
      const number = `${n.prefix}-${String(n.correlativo).padStart(8, '0')}`

      const c = await t.purchase.create({
        data: {
          tenantId: ctx.tenantId, warehouseId: input.warehouseId, supplierId: cab.supplierId, userId: ctx.userId, number,
          invoiceRef: input.invoiceRef ?? null, paymentCondition: input.paymentCondition, dueDate: cab.dueDate,
          idempotencyKey: input.idempotencyKey, subtotal: tot.subtotal, taxTotal: tot.igv, total: tot.total, notes: input.notes ?? null,
        },
        select: { id: true },
      })
      await t.purchaseItem.createMany({ data: lineas.map((l) => datosLinea(ctx.tenantId, c.id, l)) })
      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'compra.creada', entityType: 'Purchase', entityId: c.id,
          after: { number, proveedor: cab.supplierId, condicion: input.paymentCondition, total: tot.total, lineas: lineas.length },
          impersonationId: ctx.impersonationId ?? null,
        },
      })
      return { id: c.id, number, replayed: false }
    }, OPCIONES_TX)
  } catch (e) {
    // Reintento (o dos a la vez) con la misma clave: gana el primero y los demás reciben SU compra. La transacción se deshizo entera.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
      const ya = await compraPorClave(db, input.idempotencyKey)
      if (ya) return ya
      throw new BusinessError('DUPLICATE_CODE', 'Ese documento del proveedor ya está registrado.')
    }
    throw e
  }
}

async function compraPorClave(db: TenantPrismaClient, key: string): Promise<ResultadoCompra | null> {
  const c = await db.purchase.findFirst({ where: { idempotencyKey: key }, select: { id: true, number: true } })
  return c ? { id: c.id, number: c.number, replayed: true } : null
}

/** Toma la fila de la compra (espera a quien la tenga) y devuelve su estado ya firme. */
async function bloquearCompra(t: TenantPrismaClient, purchaseId: string) {
  try {
    return await t.purchase.update({
      where: { id: purchaseId }, data: { updatedAt: new Date() },
      select: {
        id: true, number: true, status: true, supplierId: true, warehouseId: true, paymentCondition: true, dueDate: true,
        invoiceRef: true, subtotal: true, taxTotal: true, total: true, notes: true,
      },
    })
  } catch (e) {
    if ((e as { code?: string }).code === 'P2025') throw noExiste()
    throw e
  }
}

export async function editarBorrador(db: TenantPrismaClient, ctx: TenantContext, input: EditarBorradorInput): Promise<{ id: string }> {
  exigir(ctx, 'compras.registrar')
  const branchId = requireBranch(ctx)
  await verificarAlmacenDeSucursal(db, branchId, input.warehouseId)

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      const c = await bloquearCompra(t, input.purchaseId)
      if (c.status !== 'BORRADOR') throw invalido('Solo se puede editar una compra en borrador.')
      const lineas = await resolverLineas(t, input.items)
      const cab = await resolverCabecera(t, input)
      await exigirFacturaLibre(t, cab.supplierId, input.invoiceRef, c.id)
      const tot = totales(lineas)

      await t.purchaseItem.deleteMany({ where: { purchaseId: c.id } })
      await t.purchaseItem.createMany({ data: lineas.map((l) => datosLinea(ctx.tenantId, c.id, l)) })
      await t.purchase.update({
        where: { id: c.id },
        data: {
          warehouseId: input.warehouseId, supplierId: cab.supplierId, invoiceRef: input.invoiceRef ?? null,
          paymentCondition: input.paymentCondition, dueDate: cab.dueDate, subtotal: tot.subtotal, taxTotal: tot.igv, total: tot.total,
          notes: input.notes ?? null,
        },
        select: { id: true },
      })
      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'compra.editada', entityType: 'Purchase', entityId: c.id,
          before: { total: num(c.total), proveedor: c.supplierId, condicion: c.paymentCondition },
          after: { total: tot.total, proveedor: cab.supplierId, condicion: input.paymentCondition, lineas: lineas.length },
          impersonationId: ctx.impersonationId ?? null,
        },
      })
      return { id: c.id }
    }, OPCIONES_TX)
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
      throw new BusinessError('DUPLICATE_CODE', 'Ese documento del proveedor ya está registrado.')
    }
    throw e
  }
}

// ─── Productos: bloqueo y fotografía de costo/stock ─────────────────────────────────────────────────────────────────

interface FotoProducto { id: string; name: string; costo: number; stock: number }

/**
 * Toma los productos EN ORDEN DE ID (dos compras con los mismos productos no se cruzan) y fotografía su costo y su stock total
 * (todos los almacenes y variantes) ANTES de mover nada: es la base del promedio.
 */
async function fotografiar(t: TenantPrismaClient, productIds: readonly string[]): Promise<Map<string, FotoProducto>> {
  const mapa = new Map<string, FotoProducto>()
  for (const id of [...new Set(productIds)].sort()) {
    const p = await t.product.update({ where: { id }, data: { updatedAt: new Date() }, select: { id: true, name: true, costPrice: true } })
    const s = await t.stock.aggregate({ where: { productId: id }, _sum: { quantity: true } })
    mapa.set(id, { id, name: p.name, costo: num(p.costPrice), stock: num(s._sum.quantity) })
  }
  return mapa
}

/** Suma por producto (cantidad base y valor sin IGV) de las líneas de la compra. */
function agruparPorProducto(items: readonly { productId: string; quantity: { toString(): string }; lineTotal: { toString(): string } }[]) {
  const m = new Map<string, { cantidad: Prisma.Decimal; valor: Prisma.Decimal }>()
  for (const i of items) {
    const a = m.get(i.productId) ?? { cantidad: new Prisma.Decimal(0), valor: new Prisma.Decimal(0) }
    m.set(i.productId, { cantidad: a.cantidad.plus(i.quantity.toString()), valor: a.valor.plus(i.lineTotal.toString()) })
  }
  return m
}

const ITEMS = {
  productId: true, variantId: true, quantity: true, unitCost: true, lineTotal: true,
  presentationId: true, enteredQuantity: true, presentationFactor: true,
} as const

const entrada = (warehouseId: string, productId: string, quantity: number, type: 'ENTRADA' | 'SALIDA', unitCost?: number) =>
  ({ productId, warehouseId, type, quantity, source: 'MANUAL', ...(unitCost !== undefined ? { unitCost } : {}) }) as CreateStockMovementInput

// ─── Recibir ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ResultadoRecibir { id: string; number: string; replayed: boolean; cuentaPorPagarId: string | null }

export async function recibirCompra(db: TenantPrismaClient, ctx: TenantContext, input: RecibirCompraInput): Promise<ResultadoRecibir> {
  exigir(ctx, 'compras.registrar')
  const branchId = requireBranch(ctx)

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const c = await bloquearCompra(t, input.purchaseId)                               // ① la compra
    if (c.status === 'RECIBIDA') {
      const cxp = await t.accountPayable.findFirst({ where: { purchaseId: c.id }, select: { id: true } })
      return { id: c.id, number: c.number, replayed: true, cuentaPorPagarId: cxp?.id ?? null }
    }
    if (c.status === 'ANULADA') throw invalido('La compra está anulada: no se puede recibir.')
    await verificarAlmacenDeSucursal(t, branchId, c.warehouseId)

    const items = await t.purchaseItem.findMany({ where: { purchaseId: c.id }, select: ITEMS, orderBy: { id: 'asc' } })
    if (items.length === 0) throw invalido('La compra no tiene productos.')
    const total = num(c.total)

    if (c.paymentCondition === 'CREDITO') {
      if (!c.supplierId || !c.dueDate) throw invalido('Una compra a crédito necesita proveedor y vencimiento.')
      const s = await bloquearProveedor(t, c.supplierId)                              // ② el proveedor
      if (s.deletedAt || !s.isActive) throw invalido('El proveedor está dado de baja: reactívalo para recibir esta compra.')
      if (!(total > 0)) throw invalido('Una compra a crédito debe tener un total mayor que cero.')
    }

    const fotos = await fotografiar(t, items.map((i) => i.productId))                 // ③ los productos

    for (const i of items) {                                                           // ④ el stock
      const mov = await applyStockMovement(
        t, ctx,
        {
          ...entrada(c.warehouseId, i.productId, num(i.quantity), 'ENTRADA', num(i.unitCost)),
          ...(i.presentationId ? { traza: { presentationId: i.presentationId, enteredQuantity: i.enteredQuantity!.toString(), factor: i.presentationFactor!.toString() } } : {}),
        },
        'COMPRA',
      )
      await t.stockMovement.update({ where: { id: mov.movementId }, data: { referenceType: 'COMPRA', referenceId: c.id }, select: { id: true } })
    }

    // Costo promedio ponderado móvil, por producto (varias líneas del mismo producto cuentan juntas).
    const costos: Record<string, { antes: number; despues: number }> = {}
    for (const [productId, g] of agruparPorProducto(items)) {
      const f = fotos.get(productId)!
      const nuevo = costoTrasCompra({ stock: f.stock, costo: f.costo, cantidad: g.cantidad.toString(), valor: g.valor.toString() })
      if (nuevo !== f.costo) await t.product.update({ where: { id: productId }, data: { costPrice: nuevo }, select: { id: true } })
      costos[productId] = { antes: f.costo, despues: nuevo }
    }

    let cuentaPorPagarId: string | null = null
    if (c.paymentCondition === 'CREDITO') {
      const cxp = await t.accountPayable.create({
        data: { tenantId: ctx.tenantId, supplierId: c.supplierId!, purchaseId: c.id, amount: total, dueDate: c.dueDate! },
        select: { id: true },
      })
      cuentaPorPagarId = cxp.id
      await t.supplier.update({ where: { id: c.supplierId! }, data: { payableBalance: { increment: total } }, select: { id: true } })
    }

    await t.purchase.update({
      where: { id: c.id }, data: { status: 'RECIBIDA', receivedAt: new Date(), receivedById: ctx.userId }, select: { id: true },
    })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'compra.recibida', entityType: 'Purchase', entityId: c.id,
        after: { number: c.number, total, condicion: c.paymentCondition, cuentaPorPagarId, costos }, impersonationId: ctx.impersonationId ?? null,
      },
    })
    return { id: c.id, number: c.number, replayed: false, cuentaPorPagarId }
  }, OPCIONES_TX)
}

// ─── Anular ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function anularCompra(db: TenantPrismaClient, ctx: TenantContext, input: AnularCompraInput): Promise<{ id: string; replayed: boolean }> {
  exigir(ctx, 'compras.registrar')
  const branchId = requireBranch(ctx)

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const c = await bloquearCompra(t, input.purchaseId)                               // ① la compra
    if (c.status === 'ANULADA') return { id: c.id, replayed: true }

    const ahora = new Date()
    // La factura queda libre para registrarse bien; el número original se conserva en las notas.
    const liberar = {
      invoiceRef: null,
      notes: [c.notes, c.invoiceRef ? `Documento anulado: ${c.invoiceRef}` : null].filter(Boolean).join(' · ') || null,
    }
    const marca = { status: 'ANULADA' as const, voidedAt: ahora, voidedById: ctx.userId, voidReason: input.motivo, ...liberar }

    if (c.status === 'BORRADOR') {
      await t.purchase.update({ where: { id: c.id }, data: marca, select: { id: true } })
      await auditarAnulacion(t, ctx, c.id, c.number, 'BORRADOR', input.motivo, {})
      return { id: c.id, replayed: false }
    }

    // Una compra RECIBIDA devuelve mercadería: es sacar stock, y para eso se exige además el permiso de ajustar el inventario.
    exigir(ctx, 'stock.ajustar')
    await verificarAlmacenDeSucursal(t, branchId, c.warehouseId)

    let cxp: { id: string; paidAmount: Prisma.Decimal; amount: Prisma.Decimal } | null = null
    if (c.paymentCondition === 'CREDITO' && c.supplierId) {
      await bloquearProveedor(t, c.supplierId)                                         // ② el proveedor
      cxp = await t.accountPayable.findFirst({ where: { purchaseId: c.id }, select: { id: true, paidAmount: true, amount: true } })
      if (cxp) {
        // Solo cuentan los pagos VIGENTES: el reparto de un pago anulado se conserva en el historial pero ya no aplica nada.
        const aplicaciones = await t.supplierPaymentAllocation.count({ where: { payableId: cxp.id, supplierPayment: { voidedAt: null } } })
        if (num(cxp.paidAmount) > 0 || aplicaciones > 0) {
          throw invalido('Esta compra ya tiene pagos aplicados. Anula primero esos pagos; luego podrás anular la compra.')
        }
      }
    }

    const items = await t.purchaseItem.findMany({ where: { purchaseId: c.id }, select: ITEMS, orderBy: { id: 'asc' } })
    const fotos = await fotografiar(t, items.map((i) => i.productId))                 // ③ los productos

    for (const i of items) {                                                           // ④ el stock
      const p = fotos.get(i.productId)!
      const mov = await applyStockMovement(
        t, ctx,
        {
          ...entrada(c.warehouseId, i.productId, num(i.quantity), 'SALIDA'),
          reason: `Anulación de la compra ${c.number}`,
          ...(i.presentationId ? { traza: { presentationId: i.presentationId, enteredQuantity: i.enteredQuantity!.toString(), factor: i.presentationFactor!.toString() } } : {}),
        },
        'COMPRA', true, 'DEVOLUCION_PROVEEDOR',
      )
      // Regla propia, SIEMPRE: anular no puede dejar el stock en negativo, aunque la política del negocio lo permita en las ventas.
      // Lanzar aquí deshace la transacción entera (stock, costos, deuda), y el UPDATE ya tomó la fila: el saldo leído es el firme.
      if (mov.balanceAfter < 0) {
        throw new BusinessError('INSUFFICIENT_STOCK', `No se puede anular: de «${p.name}» ya salió mercadería de esta compra. Quedarían ${mov.balanceAfter} en el almacén.`, {
          producto: p.name, faltante: Math.abs(mov.balanceAfter),
        })
      }
      await t.stockMovement.update({ where: { id: mov.movementId }, data: { referenceType: 'COMPRA', referenceId: c.id }, select: { id: true } })
    }

    const costos: Record<string, { antes: number; despues: number }> = {}
    for (const [productId, g] of agruparPorProducto(items)) {
      const f = fotos.get(productId)!
      const nuevo = costoTrasDevolucion({ stock: f.stock, costo: f.costo, cantidad: g.cantidad.toString(), valor: g.valor.toString() })
      if (nuevo !== null && nuevo !== f.costo) await t.product.update({ where: { id: productId }, data: { costPrice: nuevo }, select: { id: true } })
      costos[productId] = { antes: f.costo, despues: nuevo ?? f.costo }
    }

    if (cxp && c.supplierId) {
      await t.accountPayable.update({
        where: { id: cxp.id }, data: { status: 'ANULADA', voidedAt: ahora, closedAt: ahora, voidReason: input.motivo }, select: { id: true },
      })
      await t.supplier.update({ where: { id: c.supplierId }, data: { payableBalance: { decrement: num(cxp.amount) } }, select: { id: true } })
    }
    await t.purchase.update({ where: { id: c.id }, data: marca, select: { id: true } })
    await auditarAnulacion(t, ctx, c.id, c.number, 'RECIBIDA', input.motivo, { costos, cuentaPorPagarId: cxp?.id ?? null })
    return { id: c.id, replayed: false }
  }, OPCIONES_TX)
}

async function auditarAnulacion(
  t: TenantPrismaClient, ctx: TenantContext, id: string, number: string, estadoAnterior: string, motivo: string, extra: Record<string, unknown>,
) {
  await t.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'compra.anulada', entityType: 'Purchase', entityId: id,
      reason: motivo, before: { estado: estadoAnterior }, after: { number, estado: 'ANULADA', ...extra } as Prisma.InputJsonValue,
      impersonationId: ctx.impersonationId ?? null,
    },
  })
}

// ─── Lectura ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FilaCompra {
  id: string; number: string; status: 'BORRADOR' | 'RECIBIDA' | 'ANULADA'; invoiceRef: string | null; supplierName: string | null
  paymentCondition: 'CONTADO' | 'CREDITO'; dueDate: string | null; total: number; createdAt: Date
}
export interface PaginaCompras { filas: FilaCompra[]; siguiente: string | null }

export async function listarCompras(db: TenantPrismaClient, ctx: TenantContext, input: ListarComprasInput): Promise<PaginaCompras> {
  exigirVer(ctx)
  const where: Prisma.PurchaseWhereInput = {
    ...(input.estado ? { status: input.estado } : {}),
    ...(input.supplierId ? { supplierId: input.supplierId } : {}),
    ...(input.q ? { OR: [{ number: { contains: input.q, mode: 'insensitive' } }, { invoiceRef: { contains: input.q, mode: 'insensitive' } }, { supplier: { name: { contains: input.q, mode: 'insensitive' } } }] } : {}),
  }
  const filas = await db.purchase.findMany({
    where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: input.limite + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: { id: true, number: true, status: true, invoiceRef: true, paymentCondition: true, dueDate: true, total: true, createdAt: true, supplier: { select: { name: true } } },
  })
  const hay = filas.length > input.limite
  return {
    filas: filas.slice(0, input.limite).map((f) => ({
      id: f.id, number: f.number, status: f.status, invoiceRef: f.invoiceRef, supplierName: f.supplier?.name ?? null,
      paymentCondition: f.paymentCondition, dueDate: f.dueDate ? f.dueDate.toISOString().slice(0, 10) : null, total: num(f.total), createdAt: f.createdAt,
    })),
    siguiente: hay ? filas[input.limite - 1]!.id : null,
  }
}

export async function obtenerCompra(db: TenantPrismaClient, ctx: TenantContext, purchaseId: string) {
  exigirVer(ctx)
  const c = await db.purchase.findFirst({
    where: { id: purchaseId },
    select: {
      id: true, number: true, status: true, invoiceRef: true, paymentCondition: true, dueDate: true, notes: true, warehouseId: true,
      subtotal: true, taxTotal: true, total: true, createdAt: true, receivedAt: true, voidedAt: true, voidReason: true,
      supplier: { select: { id: true, name: true, taxId: true } },
      accountPayable: { select: { id: true, amount: true, paidAmount: true, status: true, dueDate: true } },
      items: {
        orderBy: { id: 'asc' },
        select: { id: true, productId: true, quantity: true, unitCost: true, lineTotal: true, taxRate: true, enteredQuantity: true, presentationName: true, product: { select: { name: true, sku: true } } },
      },
    },
  })
  if (!c) throw noExiste()
  return {
    ...c, subtotal: num(c.subtotal), taxTotal: num(c.taxTotal), total: num(c.total),
    dueDate: c.dueDate ? c.dueDate.toISOString().slice(0, 10) : null,
    accountPayable: c.accountPayable ? { ...c.accountPayable, amount: num(c.accountPayable.amount), paidAmount: num(c.accountPayable.paidAmount), dueDate: c.accountPayable.dueDate.toISOString().slice(0, 10) } : null,
    items: c.items.map((i) => ({ ...i, quantity: num(i.quantity), unitCost: num(i.unitCost), lineTotal: num(i.lineTotal), taxRate: num(i.taxRate), enteredQuantity: i.enteredQuantity ? num(i.enteredQuantity) : null })),
  }
}

