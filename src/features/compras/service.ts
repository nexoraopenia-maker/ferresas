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
import { palabras, relevancia } from '@/features/pos/busqueda'
import { variantesConTilde } from '@/features/pos/resaltado'
import { puedeVerProveedores } from '@/features/proveedores/permisos'
import { validarDocumento, type DocumentoCompra } from './documento'
import { costoBase, costoTrasCompra, costoTrasDevolucion, igvDeCompra, totalDeLinea } from './costo'
import type {
  AnularCompraInput, CompletarDocumentoInput, CrearBorradorInput, EditarBorradorInput, LineaCompraInput, ListarComprasInput, RecibirCompraInput,
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

/** El documento estructurado del formulario, validado con el día de hoy EN LA ZONA DEL NEGOCIO (una factura no se emite mañana). */
async function resolverDocumento(t: TenantPrismaClient, e: { docType?: string; docSeries?: string; docNumber?: string; issueDate?: string }): Promise<DocumentoCompra | null> {
  if (!e.docType && !e.docSeries && !e.docNumber && !e.issueDate) return null
  const { timezone } = await t.tenant.findFirstOrThrow({ select: { timezone: true } })
  const r = validarDocumento(e, hoyEnZona(timezone))
  if (!r.ok) throw invalido(r.mensaje)
  return r.documento
}

/** Las columnas del documento para guardar (todo nulo si no hay documento estructurado). */
const columnasDocumento = (d: DocumentoCompra | null) =>
  d ? { docType: d.docType, docSeries: d.docSeries, docNumber: d.docNumber, issueDate: new Date(`${d.issueDate}T00:00:00.000Z`) } : { docType: null, docSeries: null, docNumber: null, issueDate: null }

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
      const doc = await resolverDocumento(t, input)
      const referencia = doc?.invoiceRef ?? input.invoiceRef
      await exigirFacturaLibre(t, cab.supplierId, referencia)
      const tot = totales(lineas)
      const n = await claimNextNumber(t, ctx.tenantId, 'PURCHASE', serie.series)
      // Prefijo + SERIE de la sucursal, como las ventas, cotizaciones y transferencias («P001-00000007»): sin la serie, dos sucursales numerarían «P-00000001» y
      // la segunda chocaría con el índice único (negocio, número). Las compras anteriores conservan su número «P-0000000N».
      const number = `${n.prefix}${n.series}-${String(n.correlativo).padStart(8, '0')}`

      const c = await t.purchase.create({
        data: {
          tenantId: ctx.tenantId, warehouseId: input.warehouseId, supplierId: cab.supplierId, userId: ctx.userId, number,
          invoiceRef: referencia ?? null, ...columnasDocumento(doc), paymentCondition: input.paymentCondition, dueDate: cab.dueDate,
          idempotencyKey: input.idempotencyKey, subtotal: tot.subtotal, taxTotal: tot.igv, total: tot.total, notes: input.notes ?? null,
        },
        select: { id: true },
      })
      await t.purchaseItem.createMany({ data: lineas.map((l) => datosLinea(ctx.tenantId, c.id, l)) })
      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'compra.creada', entityType: 'Purchase', entityId: c.id,
          after: { number, proveedor: cab.supplierId, condicion: input.paymentCondition, total: tot.total, lineas: lineas.length, documento: doc ? `${doc.docType} ${doc.invoiceRef} · ${doc.issueDate}` : null },
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
      const doc = await resolverDocumento(t, input)
      const referencia = doc?.invoiceRef ?? input.invoiceRef
      await exigirFacturaLibre(t, cab.supplierId, referencia, c.id)
      const tot = totales(lineas)

      await t.purchaseItem.deleteMany({ where: { purchaseId: c.id } })
      await t.purchaseItem.createMany({ data: lineas.map((l) => datosLinea(ctx.tenantId, c.id, l)) })
      await t.purchase.update({
        where: { id: c.id },
        data: {
          warehouseId: input.warehouseId, supplierId: cab.supplierId, invoiceRef: referencia ?? null, ...columnasDocumento(doc),
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

// ─── Completar el documento de una compra ya recibida ───────────────────────────────────────────────────────────────

/**
 * «Completar documento»: asigna (o corrige) el tipo, la serie, el número y la fecha de emisión de una compra RECIBIDA. Es lo que permite
 * estructurar las compras anteriores a F5.4 para el registro de compras SIN reabrirlas: no toca líneas, costos, stock ni deuda, solo estas
 * cuatro columnas y `invoiceRef`. Pide `compras.registrar`. Un borrador se completa editándolo; una anulada ya no tiene documento.
 */
export async function completarDocumento(db: TenantPrismaClient, ctx: TenantContext, input: CompletarDocumentoInput): Promise<{ id: string; invoiceRef: string }> {
  exigir(ctx, 'compras.registrar')
  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      const c = await bloquearCompra(t, input.purchaseId)
      if (c.status !== 'RECIBIDA') throw invalido(c.status === 'BORRADOR' ? 'Un borrador se completa editándolo.' : 'Una compra anulada ya no tiene documento.')
      const doc = await resolverDocumento(t, input)
      if (!doc) throw invalido('Completa el tipo, la serie, el número y la fecha de emisión del documento.')
      await exigirFacturaLibre(t, c.supplierId, doc.invoiceRef, c.id)
      const antes = await t.purchase.findFirstOrThrow({ where: { id: c.id }, select: { docType: true, docSeries: true, docNumber: true, issueDate: true } })
      await t.purchase.update({ where: { id: c.id }, data: { invoiceRef: doc.invoiceRef, ...columnasDocumento(doc) }, select: { id: true } })
      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'compra.documento', entityType: 'Purchase', entityId: c.id,
          before: { documento: c.invoiceRef, tipo: antes.docType, serie: antes.docSeries, numero: antes.docNumber, emision: antes.issueDate ? antes.issueDate.toISOString().slice(0, 10) : null },
          after: { number: c.number, documento: doc.invoiceRef, tipo: doc.docType, serie: doc.docSeries, numero: doc.docNumber, emision: doc.issueDate },
          impersonationId: ctx.impersonationId ?? null,
        },
      })
      return { id: c.id, invoiceRef: doc.invoiceRef }
    }, OPCIONES_TX)
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) throw new BusinessError('DUPLICATE_CODE', 'Ese documento del proveedor ya está registrado.')
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

    const movimientosDe = new Map<string, string[]>()                                  // movimientos por producto: reciben el promedio NUEVO (kardex, F6.4)
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
      movimientosDe.set(i.productId, [...(movimientosDe.get(i.productId) ?? []), mov.movementId])
    }

    // Costo promedio ponderado móvil, por producto (varias líneas del mismo producto cuentan juntas).
    const costos: Record<string, { antes: number; despues: number }> = {}
    for (const [productId, g] of agruparPorProducto(items)) {
      const f = fotos.get(productId)!
      const nuevo = costoTrasCompra({ stock: f.stock, costo: f.costo, cantidad: g.cantidad.toString(), valor: g.valor.toString() })
      if (nuevo !== f.costo) {
        await t.product.update({ where: { id: productId }, data: { costPrice: nuevo }, select: { id: true } })
        await t.stockMovement.updateMany({ where: { id: { in: movimientosDe.get(productId) ?? [] } }, data: { costAfter: nuevo } })
      }
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
      invoiceRef: null, docType: null, docSeries: null, docNumber: null, issueDate: null,
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

    const movimientosDe = new Map<string, string[]>()                                  // movimientos por producto: reciben el promedio NUEVO (kardex, F6.4)
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
      // La mercadería devuelta al proveedor sale al costo de la FACTURA, no al promedio de ese momento (ver costo.ts).
      await t.stockMovement.update({ where: { id: mov.movementId }, data: { referenceType: 'COMPRA', referenceId: c.id, unitCostApplied: num(i.unitCost) }, select: { id: true } })
      movimientosDe.set(i.productId, [...(movimientosDe.get(i.productId) ?? []), mov.movementId])
    }

    const costos: Record<string, { antes: number; despues: number }> = {}
    for (const [productId, g] of agruparPorProducto(items)) {
      const f = fotos.get(productId)!
      const nuevo = costoTrasDevolucion({ stock: f.stock, costo: f.costo, cantidad: g.cantidad.toString(), valor: g.valor.toString() })
      if (nuevo !== null && nuevo !== f.costo) {
        await t.product.update({ where: { id: productId }, data: { costPrice: nuevo }, select: { id: true } })
        await t.stockMovement.updateMany({ where: { id: { in: movimientosDe.get(productId) ?? [] } }, data: { costAfter: nuevo } })
      }
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
      id: true, number: true, status: true, invoiceRef: true, docType: true, docSeries: true, docNumber: true, issueDate: true, paymentCondition: true, dueDate: true, notes: true, warehouseId: true,
      subtotal: true, taxTotal: true, total: true, createdAt: true, receivedAt: true, voidedAt: true, voidReason: true,
      warehouse: { select: { name: true } }, user: { select: { name: true } }, receivedBy: { select: { name: true } }, voidedBy: { select: { name: true } },
      supplier: { select: { id: true, name: true, taxId: true, payableBalance: true } },
      accountPayable: { select: { id: true, amount: true, paidAmount: true, status: true, dueDate: true } },
      items: {
        orderBy: { id: 'asc' },
        select: { id: true, productId: true, quantity: true, unitCost: true, lineTotal: true, taxRate: true, enteredQuantity: true, presentationName: true, product: { select: { name: true, sku: true } } },
      },
    },
  })
  if (!c) throw noExiste()
  return {
    ...c, supplier: c.supplier ? { ...c.supplier, payableBalance: num(c.supplier.payableBalance) } : null,
    subtotal: num(c.subtotal), taxTotal: num(c.taxTotal), total: num(c.total),
    dueDate: c.dueDate ? c.dueDate.toISOString().slice(0, 10) : null,
    issueDate: c.issueDate ? c.issueDate.toISOString().slice(0, 10) : null,
    accountPayable: c.accountPayable ? { ...c.accountPayable, amount: num(c.accountPayable.amount), paidAmount: num(c.accountPayable.paidAmount), dueDate: c.accountPayable.dueDate.toISOString().slice(0, 10) } : null,
    items: c.items.map((i) => ({ ...i, quantity: num(i.quantity), unitCost: num(i.unitCost), lineTotal: num(i.lineTotal), taxRate: num(i.taxRate), enteredQuantity: i.enteredQuantity ? num(i.enteredQuantity) : null })),
  }
}


// ─── Para el formulario ─────────────────────────────────────────────────────────────────────────────────────────────

export interface OpcionesCompra {
  almacenes: { id: string; name: string; isDefault: boolean }[]
  /** Proveedores ACTIVOS, en orden alfabético del español. */
  proveedores: { id: string; name: string; taxId: string | null; paymentTermDays: number }[]
}

/** Lo que el formulario necesita para elegir: los almacenes de la sucursal en la que se opera y los proveedores activos. */
export async function opcionesDeCompra(db: TenantPrismaClient, ctx: TenantContext): Promise<OpcionesCompra> {
  exigir(ctx, 'compras.registrar')
  const branchId = requireBranch(ctx)
  const [almacenes, proveedores] = await Promise.all([
    db.warehouse.findMany({ where: { branchId, isActive: true, deletedAt: null }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }], select: { id: true, name: true, isDefault: true } }),
    db.supplier.findMany({ where: { deletedAt: null, isActive: true }, select: { id: true, name: true, taxId: true, paymentTermDays: true }, take: 1000 }),
  ])
  const orden = new Intl.Collator('es', { sensitivity: 'base', numeric: true })
  proveedores.sort((a, b) => orden.compare(a.name, b.name))
  return { almacenes, proveedores }
}

export interface ProductoParaCompra {
  productId: string
  name: string
  sku: string
  unitType: string
  /** IGV del producto (0.18, 0…): con él se calcula el impuesto de la línea. */
  taxRate: number
  /** Costo promedio actual, SIN IGV. 0 = todavía sin costo. */
  costPrice: number
  presentaciones: { id: string; name: string; unitType: string; factor: string }[]
}

/**
 * Búsqueda de productos para una compra: solo los que llevan control de stock (los servicios no se compran como mercadería), con su
 * costo actual y sus presentaciones (para comprar por caja o por saco). Mismo criterio de parecido que el POS.
 */
export async function buscarProductosParaCompra(db: TenantPrismaClient, ctx: TenantContext, texto: string): Promise<ProductoParaCompra[]> {
  exigir(ctx, 'compras.registrar')
  const t = texto.trim()
  if (t.length < 2 || t.length > 80) return []
  const ps = palabras(t)
  const productos = await db.product.findMany({
    where: {
      deletedAt: null, isActive: true, trackStock: true,
      OR: [
        { barcode: { startsWith: t } },
        { qrCode: t },
        { sku: { startsWith: t, mode: 'insensitive' } },
        { AND: ps.map((p) => ({ OR: variantesConTilde(p).flatMap((v) => [{ name: { contains: v, mode: 'insensitive' as const } }, { sku: { contains: v, mode: 'insensitive' as const } }]) })) },
      ],
    },
    take: 60,
    orderBy: { name: 'asc' },
    select: {
      id: true, name: true, sku: true, barcode: true, qrCode: true, unitType: true, taxRate: true, costPrice: true,
      presentations: { where: { isActive: true, deletedAt: null }, orderBy: { factor: 'asc' }, select: { id: true, name: true, unitType: true, factor: true } },
    },
  })
  return productos
    .map((p) => ({ p, r: relevancia(p, t) }))
    .sort((a, b) => a.r - b.r || a.p.name.localeCompare(b.p.name, 'es'))
    .slice(0, 20)
    .map(({ p }) => ({
      productId: p.id, name: p.name, sku: p.sku, unitType: p.unitType, taxRate: num(p.taxRate), costPrice: num(p.costPrice),
      presentaciones: p.presentations.map((x) => ({ id: x.id, name: x.name, unitType: x.unitType, factor: x.factor.toString() })),
    }))
}

export interface BorradorParaEditar {
  id: string
  number: string
  warehouseId: string
  supplierId: string | null
  invoiceRef: string | null
  /** Documento estructurado (F5.4); `null` si el borrador solo tiene referencia libre. */
  documento: { docType: string; docSeries: string; docNumber: string; issueDate: string } | null
  paymentCondition: 'CONTADO' | 'CREDITO'
  /** AAAA-MM-DD o `null`. */
  vence: string | null
  notes: string | null
  lineas: {
    producto: ProductoParaCompra
    presentationId: string | null
    /** Lo que se tecleó: unidades de compra (cajas) o unidades base si no hubo presentación. */
    cantidad: string
    /** Costo por unidad de COMPRA, sin IGV: total de la línea / cantidad tecleada. */
    costo: string
  }[]
}

/**
 * Un borrador listo para el formulario de edición. Solo `compras.registrar` y solo BORRADOR (una recibida o anulada no se edita).
 * El costo por unidad de compra se reconstruye del total de la línea, que es lo que se guardó exacto.
 */
export async function borradorParaEditar(db: TenantPrismaClient, ctx: TenantContext, purchaseId: string): Promise<BorradorParaEditar> {
  exigir(ctx, 'compras.registrar')
  const c = await db.purchase.findFirst({
    where: { id: purchaseId },
    select: {
      id: true, number: true, status: true, warehouseId: true, supplierId: true, invoiceRef: true, docType: true, docSeries: true, docNumber: true, issueDate: true, paymentCondition: true, dueDate: true, notes: true,
      items: {
        orderBy: { id: 'asc' },
        select: {
          presentationId: true, enteredQuantity: true, quantity: true, lineTotal: true,
          product: {
            select: {
              id: true, name: true, sku: true, unitType: true, taxRate: true, costPrice: true,
              presentations: { where: { isActive: true, deletedAt: null }, orderBy: { factor: 'asc' }, select: { id: true, name: true, unitType: true, factor: true } },
            },
          },
        },
      },
    },
  })
  if (!c) throw noExiste()
  if (c.status !== 'BORRADOR') throw invalido('Solo se puede editar una compra en borrador.')
  return {
    id: c.id, number: c.number, warehouseId: c.warehouseId, supplierId: c.supplierId, invoiceRef: c.invoiceRef, paymentCondition: c.paymentCondition,
    documento: c.docType && c.docSeries && c.docNumber && c.issueDate ? { docType: c.docType, docSeries: c.docSeries, docNumber: c.docNumber, issueDate: c.issueDate.toISOString().slice(0, 10) } : null,
    vence: c.dueDate ? c.dueDate.toISOString().slice(0, 10) : null, notes: c.notes,
    lineas: c.items.map((i) => {
      const cantidad = (i.enteredQuantity ?? i.quantity).toString()
      const costo = new Prisma.Decimal(i.lineTotal.toString()).div(cantidad).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
      return {
        producto: {
          productId: i.product.id, name: i.product.name, sku: i.product.sku, unitType: i.product.unitType, taxRate: num(i.product.taxRate), costPrice: num(i.product.costPrice),
          presentaciones: i.product.presentations.map((x) => ({ id: x.id, name: x.name, unitType: x.unitType, factor: x.factor.toString() })),
        },
        presentationId: i.presentationId,
        cantidad: new Prisma.Decimal(cantidad).toString(),
        costo: costo.toString(),
      }
    }),
  }
}
