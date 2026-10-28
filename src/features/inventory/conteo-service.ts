import { Prisma } from '@/generated/prisma/client'
import type { InventoryCountItemStatus, InventoryCountMode, InventoryCountScope, InventoryCountStatus, UnitType } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import { P2002_UNIQUE } from '@/lib/prisma-errors'
import { exigir, puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { cargarSucursalOperativa, serieDe } from '@/features/branches/queries'
import { claimNextNumber, ensureCounter } from '@/features/pos/sale-service'
import { tieneMaxDecimales } from '@/lib/dinero'
import { decimalesPermitidos } from './conversion'
import { cargarPresentaciones, resolverMovimiento } from './presentacion-linea'
import {
  MAX_LINEAS_CONTEO,
  type AnularPasadaInput, type CancelarConteoInput, type CerrarConteoInput, type CrearConteoInput, type IniciarConteoInput, type RegistrarPasadaInput,
} from './conteo-schemas'

/**
 * Toma de inventario físico (F6.5a): el ciclo de vida del conteo. Diseño: docs/F6.5-DISENO.md.
 *
 *   BORRADOR ──iniciar──▶ EN_CONTEO ──cerrar──▶ EN_REVISION ──(F6.5b: aplicar)──▶ APLICADO        cancelar: desde cualquier estado previo a APLICADO
 *
 *  · Permisos (uno = un poder): `conteo.gestionar` crea, inicia, cierra y cancela y anula pasadas ajenas; `conteo.registrar` cuenta y anula las SUYAS (y se
 *    puede usar con el PIN de operador). Aplicar las diferencias (F6.5b) es `stock.ajustar`.
 *  · Un solo conteo abierto (borrador, en conteo o en revisión) por almacén: lo garantiza la base con un índice único parcial.
 *  · Conteo CIEGO: quien cuenta no recibe la cantidad del sistema (`sistemaAlEmpezar` ni existe en la respuesta, no viene vacía).
 *  · Las pasadas solo se agregan o se anulan. La cantidad contada de una línea es la SUMA de sus pasadas vigentes: varias personas cuentan a la vez sin pisarse.
 *  · Cada operación que cambia el conteo BLOQUEA su cabecera antes de leer su estado: registrar una pasada y cerrar el conteo se serializan, así una pasada que
 *    llega tras el cierre se rechaza (nunca se pierde en silencio).
 *  · Todo se audita, y es idempotente por clave (el móvil reintenta con mala señal).
 */

export const num = (v: { toString(): string } | null | undefined): number => Number(v?.toString() ?? 0)
export const r4 = (n: number): number => Math.round(n * 10_000) / 10_000
export const invalido = (m: string) => new BusinessError('INVALID_DOCUMENT', m)
export const noExiste = () => new BusinessError('NOT_FOUND', 'La toma de inventario no existe.')
export const OPCIONES_TX = { maxWait: 15_000, timeout: 60_000 } as const
const LOTE = 1000

const ESTADO_TEXTO: Record<InventoryCountStatus, string> = {
  BORRADOR: 'todavía no se inició',
  EN_CONTEO: 'está en conteo',
  EN_REVISION: 'ya se cerró y está en revisión',
  APLICADO: 'ya se aplicó',
  CANCELADO: 'está cancelado',
}

/** Quién puede VER un conteo: quien cuenta, quien lo gestiona y quien aprueba las diferencias. */
export const puedeVerConteos = (ctx: TenantContext): boolean => puede(ctx, 'conteo.registrar') || puede(ctx, 'conteo.gestionar') || puede(ctx, 'stock.ajustar')
/** ¿Ve la cantidad del sistema? En un conteo guiado, cualquiera que lo vea; en uno ciego, solo quien gestiona o aprueba (nunca quien solo cuenta). */
export const puedeVerSistema = (ctx: TenantContext, modo: InventoryCountMode): boolean => modo === 'GUIADO' || puede(ctx, 'conteo.gestionar') || puede(ctx, 'stock.ajustar')

export interface ResumenConteo {
  id: string
  number: string
  status: InventoryCountStatus
  scope: InventoryCountScope
  mode: InventoryCountMode
  warehouse: { id: string; name: string }
  categoryId: string | null
  notes: string | null
  /** Líneas que tiene el conteo (en un total o por categoría se generan al empezar). */
  lineas: number
  /** Líneas con al menos una pasada vigente. */
  contadas: number
  pendientes: number
  /** Pasadas vigentes (no anuladas). */
  pasadas: number
  createdAt: string
  startedAt: string | null
  closedAt: string | null
}

export async function resumir(t: TenantPrismaClient, c: { id: string; number: string; status: InventoryCountStatus; scope: InventoryCountScope; mode: InventoryCountMode; categoryId: string | null; notes: string | null; createdAt: Date; startedAt: Date | null; closedAt: Date | null; warehouse: { id: string; name: string } }): Promise<ResumenConteo> {
  const [lineas, contadas, pasadas] = await Promise.all([
    t.inventoryCountItem.count({ where: { countId: c.id } }),
    t.inventoryCountItem.count({ where: { countId: c.id, status: { not: 'PENDIENTE' } } }),
    t.inventoryCountEntry.count({ where: { countId: c.id, voidedAt: null } }),
  ])
  return {
    id: c.id, number: c.number, status: c.status, scope: c.scope, mode: c.mode, warehouse: c.warehouse, categoryId: c.categoryId, notes: c.notes,
    lineas, contadas, pendientes: lineas - contadas, pasadas, createdAt: c.createdAt.toISOString(), startedAt: c.startedAt?.toISOString() ?? null, closedAt: c.closedAt?.toISOString() ?? null,
  }
}

export const SELECCION_CONTEO = { id: true, number: true, status: true, scope: true, mode: true, categoryId: true, notes: true, createdAt: true, startedAt: true, closedAt: true, warehouseId: true, branchId: true, warehouse: { select: { id: true, name: true } } } as const

export async function auditar(t: TenantPrismaClient, ctx: TenantContext, accion: string, entityId: string, opts: { reason?: string; before?: object; after?: object } = {}) {
  await t.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: accion, entityType: 'InventoryCount', entityId, reason: opts.reason ?? null,
      ...(opts.before ? { before: opts.before as never } : {}), ...(opts.after ? { after: opts.after as never } : {}), impersonationId: ctx.impersonationId ?? null,
    },
  })
}

/**
 * Bloquea la cabecera del conteo y la devuelve con su estado ACTUAL. Todo lo que cambia un conteo pasa por aquí antes de decidir: así cerrar y contar no se
 * cruzan. Un conteo que no existe o es de una sucursal que la persona no alcanza es el mismo NOT_FOUND.
 */
export async function bloquear(t: TenantPrismaClient, countId: string) {
  try {
    await t.inventoryCount.update({ where: { id: countId }, data: { updatedAt: new Date() }, select: { id: true } })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw noExiste()
    throw e
  }
  const c = await t.inventoryCount.findFirst({ where: { id: countId }, select: SELECCION_CONTEO })
  if (!c) throw noExiste()
  return c
}

export function exigirEstado(c: { number: string; status: InventoryCountStatus }, ...validos: InventoryCountStatus[]): void {
  if (!validos.includes(c.status)) throw invalido(`La toma de inventario ${c.number} ${ESTADO_TEXTO[c.status]}: no admite esta operación.`)
}

// ─── Crear ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const unidadNombre = (p: { name: string }, v: { name: string } | null) => (v ? `${p.name} · ${v.name}` : p.name)

export async function crearConteo(db: TenantPrismaClient, ctx: TenantContext, input: CrearConteoInput): Promise<ResumenConteo & { previstas: number | null; replayed: boolean }> {
  exigir(ctx, 'conteo.gestionar')
  const existente = await db.inventoryCount.findFirst({ where: { idempotencyKey: input.idempotencyKey }, select: SELECCION_CONTEO })
  if (existente) return { ...(await resumir(db, existente)), previstas: null, replayed: true }

  const almacen = await db.warehouse.findFirst({
    where: { id: input.warehouseId, deletedAt: null, isActive: true, ...(ctx.branchIds ? { branchId: { in: [...ctx.branchIds] } } : {}) },
    select: { id: true, name: true, branchId: true },
  })
  if (!almacen) throw new BusinessError('NOT_FOUND', 'El almacén no existe o no es de tus sucursales.')
  if (input.scope === 'CATEGORIA') {
    const cat = await db.category.findFirst({ where: { id: input.categoryId! }, select: { id: true } })
    if (!cat) throw new BusinessError('NOT_FOUND', 'La categoría no existe.')
  }
  const sucursal = await cargarSucursalOperativa(db, almacen.branchId)
  const serie = serieDe(sucursal, 'INVENTORY_COUNT')
  await ensureCounter(db, ctx.tenantId, almacen.branchId, 'INVENTORY_COUNT', serie.series, serie.prefix)

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      const abierto = await t.inventoryCount.findFirst({ where: { warehouseId: almacen.id, status: { in: ['BORRADOR', 'EN_CONTEO', 'EN_REVISION'] } }, select: { number: true } })
      if (abierto) throw invalido(`Ya hay una toma de inventario abierta en este almacén (${abierto.number}). Ciérrala o cancélala antes de abrir otra.`)

      // Cuántas líneas tendrá: en un total o por categoría salen de las filas de stock al empezar; en una selección, de los productos elegidos ahora.
      let previstas: number | null = null
      let lineas: { productId: string; variantId: string | null; nameSnapshot: string; skuSnapshot: string; unitType: UnitType }[] = []
      if (input.scope === 'SELECCION') {
        const ids = input.productIds!
        const productos = await t.product.findMany({ where: { id: { in: ids }, trackStock: true, deletedAt: null }, select: { id: true, name: true, sku: true, unitType: true } })
        if (productos.length !== ids.length) throw invalido('Algún producto de la selección no existe o no lleva control de stock.')
        const filas = await t.stock.findMany({ where: { warehouseId: almacen.id, productId: { in: ids } }, select: { productId: true, variantId: true, variant: { select: { name: true, sku: true } } }, orderBy: [{ productId: 'asc' }, { variantId: 'asc' }] })
        const conFila = new Set(filas.map((f) => f.productId))
        const porId = new Map(productos.map((p) => [p.id, p]))
        for (const f of filas) { const p = porId.get(f.productId)!; lineas.push({ productId: p.id, variantId: f.variantId, nameSnapshot: unidadNombre(p, f.variant), skuSnapshot: f.variant?.sku ?? p.sku, unitType: p.unitType }) }
        for (const p of productos) if (!conFila.has(p.id)) lineas.push({ productId: p.id, variantId: null, nameSnapshot: p.name, skuSnapshot: p.sku, unitType: p.unitType })
        if (lineas.length > MAX_LINEAS_CONTEO) throw invalido(`La selección tiene ${lineas.length} líneas y el máximo de un conteo es ${MAX_LINEAS_CONTEO}.`)
      } else {
        previstas = await t.stock.count({ where: { warehouseId: almacen.id, product: { trackStock: true, deletedAt: null, ...(input.scope === 'CATEGORIA' ? { categoryId: input.categoryId! } : {}) } } })
        if (previstas > MAX_LINEAS_CONTEO) throw invalido(`Este conteo tendría ${previstas} líneas y el máximo es ${MAX_LINEAS_CONTEO}. Acótalo por categoría o por selección de productos.`)
      }

      const { correlativo, prefix, series } = await claimNextNumber(t, ctx.tenantId, 'INVENTORY_COUNT', serie.series)
      const number = `${prefix}${series}-${String(correlativo).padStart(8, '0')}`
      const c = await t.inventoryCount.create({
        data: {
          tenantId: ctx.tenantId, number, warehouseId: almacen.id, branchId: almacen.branchId, scope: input.scope, categoryId: input.categoryId ?? null, mode: input.mode,
          notes: input.notes ?? null, createdById: ctx.userId, idempotencyKey: input.idempotencyKey,
        },
        select: SELECCION_CONTEO,
      })
      for (let i = 0; i < lineas.length; i += LOTE) {
        await t.inventoryCountItem.createMany({ data: lineas.slice(i, i + LOTE).map((l) => ({ tenantId: ctx.tenantId, countId: c.id, ...l })) })
      }
      await auditar(t, ctx, 'conteo.crear', c.id, { after: { numero: number, almacen: almacen.name, alcance: input.scope, modo: input.mode, lineas: lineas.length, previstas } })
      return { ...(await resumir(t, c)), previstas, replayed: false }
    }, OPCIONES_TX)
  } catch (e) {
    // Dos envíos con la misma clave: gana el primero. Dos conteos distintos para el mismo almacén: la base corta al segundo.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
      const ganador = await db.inventoryCount.findFirst({ where: { idempotencyKey: input.idempotencyKey }, select: SELECCION_CONTEO })
      if (ganador) return { ...(await resumir(db, ganador)), previstas: null, replayed: true }
      throw invalido('Ya hay una toma de inventario abierta en este almacén. Ciérrala o cancélala antes de abrir otra.')
    }
    throw e
  }
}

// ─── Iniciar ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Empieza el conteo y toma la FOTO del stock (`systemQtyAtStart`). En un total o por categoría las líneas nacen aquí, con la foto ya puesta; en una selección
 * ya existen y se les pone la foto. Las ventas NO se bloquean: la foto es solo informativa (la diferencia real se calcula contra el saldo del kardex al contar).
 */
export async function iniciarConteo(db: TenantPrismaClient, ctx: TenantContext, input: IniciarConteoInput): Promise<ResumenConteo> {
  exigir(ctx, 'conteo.gestionar')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const c = await bloquear(t, input.countId)
    exigirEstado(c, 'BORRADOR')

    const filas = await t.stock.findMany({
      where: {
        warehouseId: c.warehouseId,
        ...(c.scope === 'SELECCION' ? { productId: { in: (await t.inventoryCountItem.findMany({ where: { countId: c.id }, select: { productId: true } })).map((i) => i.productId) } }
          : { product: { trackStock: true, deletedAt: null, ...(c.scope === 'CATEGORIA' ? { categoryId: c.categoryId! } : {}) } }),
      },
      select: { productId: true, variantId: true, quantity: true, product: { select: { name: true, sku: true, unitType: true } }, variant: { select: { name: true, sku: true } } },
      orderBy: [{ productId: 'asc' }, { variantId: 'asc' }],
    })
    const clave = (p: string, v: string | null) => `${p}|${v ?? ''}`

    if (c.scope === 'SELECCION') {
      const items = await t.inventoryCountItem.findMany({ where: { countId: c.id }, select: { id: true, productId: true, variantId: true } })
      const stock = new Map(filas.map((f) => [clave(f.productId, f.variantId), num(f.quantity)]))
      for (const i of items) await t.inventoryCountItem.update({ where: { id: i.id }, data: { systemQtyAtStart: stock.get(clave(i.productId, i.variantId)) ?? 0 }, select: { id: true } })
    } else {
      if (filas.length > MAX_LINEAS_CONTEO) throw invalido(`Este conteo tendría ${filas.length} líneas y el máximo es ${MAX_LINEAS_CONTEO}. Cancélalo y acótalo por categoría o por selección.`)
      const data = filas.map((f) => ({
        tenantId: ctx.tenantId, countId: c.id, productId: f.productId, variantId: f.variantId, nameSnapshot: unidadNombre({ name: f.product.name }, f.variant), skuSnapshot: f.variant?.sku ?? f.product.sku,
        unitType: f.product.unitType, systemQtyAtStart: f.quantity,
      }))
      for (let i = 0; i < data.length; i += LOTE) await t.inventoryCountItem.createMany({ data: data.slice(i, i + LOTE) })
    }

    const ahora = new Date()
    const ok = await t.inventoryCount.updateMany({ where: { id: c.id, status: 'BORRADOR' }, data: { status: 'EN_CONTEO', startedAt: ahora, startedById: ctx.userId } })
    if (ok.count !== 1) throw invalido('La toma de inventario cambió mientras se iniciaba. Vuelve a cargarla.')
    const lineas = await t.inventoryCountItem.count({ where: { countId: c.id } })
    await auditar(t, ctx, 'conteo.iniciar', c.id, { after: { numero: c.number, lineas } })
    const fresco = await t.inventoryCount.findFirstOrThrow({ where: { id: c.id }, select: SELECCION_CONTEO })
    return resumir(t, fresco)
  }, OPCIONES_TX)
}

// ─── Pasadas ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ResultadoPasada {
  entryId: string
  itemId: string
  productId: string
  /** Lo contado de ese producto sumando todas las pasadas vigentes (unidad base). */
  contado: number
  replayed: boolean
}

/** Recalcula la cantidad contada de una línea desde sus pasadas vigentes. Siempre bajo el bloqueo de la cabecera. */
async function recalcularLinea(t: TenantPrismaClient, itemId: string, ahora: Date): Promise<number | null> {
  const agg = await t.inventoryCountEntry.aggregate({ where: { itemId, voidedAt: null }, _sum: { quantity: true }, _count: { _all: true } })
  if (agg._count._all === 0) {
    // Una línea mandada a RECONTAR sigue pendiente de su recuento: solo las demás vuelven a PENDIENTE (en la MISMA sentencia: la base no admite CONTADO sin cantidad).
    const actual = await t.inventoryCountItem.findFirst({ where: { id: itemId }, select: { status: true } })
    await t.inventoryCountItem.update({ where: { id: itemId }, data: { countedQty: null, lastCountedAt: null, status: actual?.status === 'RECONTAR' ? 'RECONTAR' : 'PENDIENTE' }, select: { id: true } })
    return null
  }
  const total = r4(num(agg._sum.quantity))
  await t.inventoryCountItem.update({ where: { id: itemId }, data: { countedQty: total, status: 'CONTADO', lastCountedAt: ahora }, select: { id: true } })
  return total
}

export async function registrarPasada(db: TenantPrismaClient, ctx: TenantContext, input: RegistrarPasadaInput): Promise<ResultadoPasada> {
  exigir(ctx, 'conteo.registrar')
  const variantId = input.variantId ?? null

  const yaEsta = async (): Promise<ResultadoPasada | null> => {
    const previa = await db.inventoryCountEntry.findFirst({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true, itemId: true, countId: true, item: { select: { productId: true, variantId: true, countedQty: true } } } })
    if (!previa) return null
    if (previa.countId !== input.countId || previa.item.productId !== input.productId || previa.item.variantId !== variantId) throw invalido('Esa clave de idempotencia ya se usó para otra pasada.')
    return { entryId: previa.id, itemId: previa.itemId, productId: previa.item.productId, contado: num(previa.item.countedQty), replayed: true }
  }
  const previa = await yaEsta()
  if (previa) return previa

  // La presentación (cajas × factor) se valida ANTES de abrir la transacción: es solo lectura del catálogo.
  let traza: { presentationId: string; enteredQuantity: string; factor: string } | null = null
  if (input.presentationId != null) {
    const producto = await db.product.findFirst({ where: { id: input.productId }, select: { unitType: true } })
    if (!producto) throw new BusinessError('NOT_FOUND', 'El producto no existe.')
    const cargadas = await cargarPresentaciones(db, [input.presentationId])
    const r = resolverMovimiento({ productId: input.productId, variantId, presentationId: input.presentationId, enteredQuantity: input.enteredQuantity!, quantity: input.quantity }, cargadas.get(input.presentationId), producto.unitType)
    traza = { presentationId: r.presentacion.id, enteredQuantity: r.conversion.cantidadIngresada, factor: r.conversion.factor }
  }

  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      const c = await bloquear(t, input.countId)
      exigirEstado(c, 'EN_CONTEO', 'EN_REVISION')

      let linea = await t.inventoryCountItem.findFirst({ where: { countId: c.id, productId: input.productId, variantId }, select: { id: true, productId: true, status: true, unitType: true } })
      // Con el conteo ya cerrado (en revisión) solo se cuenta de nuevo lo que el revisor mandó a recontar (F6.5b).
      if (c.status === 'EN_REVISION' && linea?.status !== 'RECONTAR') throw invalido(`La toma de inventario ${c.number} ya se cerró y está en revisión: solo se cuenta de nuevo lo que se mandó a recontar.`)
      if (!linea) {
        // Mercadería que no estaba en la lista: en un total o por categoría se admite (se halló algo que el sistema no esperaba); en una selección, no.
        if (c.scope === 'SELECCION') throw new BusinessError('NOT_FOUND', 'Ese producto no está en esta toma de inventario.')
        const producto = await t.product.findFirst({ where: { id: input.productId, trackStock: true, deletedAt: null }, select: { id: true, name: true, sku: true, unitType: true, categoryId: true } })
        if (!producto) throw new BusinessError('NOT_FOUND', 'El producto no existe o no lleva control de stock.')
        if (c.scope === 'CATEGORIA' && producto.categoryId !== c.categoryId) throw invalido('Ese producto no es de la categoría que se está contando.')
        const variante = variantId ? await t.productVariant.findFirst({ where: { id: variantId, productId: producto.id }, select: { name: true, sku: true } }) : null
        if (variantId && !variante) throw new BusinessError('NOT_FOUND', 'La variante no existe en ese producto.')
        const stock = await t.stock.findFirst({ where: { warehouseId: c.warehouseId, productId: producto.id, variantId }, select: { quantity: true } })
        linea = await t.inventoryCountItem.create({
          data: {
            tenantId: ctx.tenantId, countId: c.id, productId: producto.id, variantId, nameSnapshot: unidadNombre(producto, variante), skuSnapshot: variante?.sku ?? producto.sku, unitType: producto.unitType,
            systemQtyAtStart: stock?.quantity ?? 0,
          },
          select: { id: true, productId: true, status: true, unitType: true },
        })
      }
      // Las piezas, cajas y bolsas se cuentan enteras; lo que se mide (kg, m, l) admite fracciones: la unidad del producto manda.
      if (!tieneMaxDecimales(input.quantity, decimalesPermitidos(linea.unitType))) {
        throw invalido(decimalesPermitidos(linea.unitType) === 0 ? `Este producto se cuenta en unidades enteras (${linea.unitType}): ${input.quantity} no es válido.` : `Este producto admite hasta ${decimalesPermitidos(linea.unitType)} decimales (${linea.unitType}): ${input.quantity} no es válido.`)
      }

      const ahora = new Date()
      const entrada = await t.inventoryCountEntry.create({
        data: {
          tenantId: ctx.tenantId, itemId: linea.id, countId: c.id, quantity: input.quantity, zone: input.zone ?? null, userId: ctx.userId, idempotencyKey: input.idempotencyKey,
          ...(traza ? { presentationId: traza.presentationId, enteredQuantity: traza.enteredQuantity, presentationFactor: traza.factor } : {}),
        },
        select: { id: true },
      })
      const contado = await recalcularLinea(t, linea.id, ahora)
      return { entryId: entrada.id, itemId: linea.id, productId: linea.productId, contado: contado ?? 0, replayed: false }
    }, OPCIONES_TX)
  } catch (e) {
    // Dos envíos simultáneos con la misma clave: la base corta al segundo y se devuelve el del primero.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002_UNIQUE) {
      const ganador = await yaEsta()
      if (ganador) return ganador
    }
    throw e
  }
}

/** Anula una pasada (nunca la borra): la propia con `conteo.registrar`, cualquiera con `conteo.gestionar`. Solo con el conteo EN_CONTEO. */
export async function anularPasada(db: TenantPrismaClient, ctx: TenantContext, input: AnularPasadaInput): Promise<{ entryId: string; contado: number | null }> {
  const gestiona = puede(ctx, 'conteo.gestionar')
  if (!gestiona && !puede(ctx, 'conteo.registrar')) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para anular pasadas de una toma de inventario.')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const previa = await t.inventoryCountEntry.findFirst({ where: { id: input.entryId }, select: { countId: true } })
    if (!previa) throw new BusinessError('NOT_FOUND', 'La pasada no existe.')
    const c = await bloquear(t, previa.countId)
    exigirEstado(c, 'EN_CONTEO')
    const e = await t.inventoryCountEntry.findFirst({ where: { id: input.entryId }, select: { id: true, itemId: true, userId: true, quantity: true, zone: true, voidedAt: true } })
    if (!e) throw new BusinessError('NOT_FOUND', 'La pasada no existe.')
    if (e.voidedAt) throw invalido('Esa pasada ya está anulada.')
    if (!gestiona && e.userId !== ctx.userId) throw new BusinessError('FORBIDDEN_ROLE', 'Solo puedes anular tus propias pasadas.')
    await t.inventoryCountEntry.update({ where: { id: e.id }, data: { voidedAt: new Date(), voidedById: ctx.userId, voidReason: input.reason }, select: { id: true } })
    const contado = await recalcularLinea(t, e.itemId, new Date())
    await auditar(t, ctx, 'conteo.pasada_anulada', c.id, { reason: input.reason, before: { pasada: e.id, cantidad: num(e.quantity), zona: e.zone, contadoPor: e.userId } })
    return { entryId: e.id, contado }
  }, OPCIONES_TX)
}

// ─── Cerrar y cancelar ──────────────────────────────────────────────────────────────────────────────────────────────

export async function cerrarConteo(db: TenantPrismaClient, ctx: TenantContext, input: CerrarConteoInput): Promise<ResumenConteo> {
  exigir(ctx, 'conteo.gestionar')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const c = await bloquear(t, input.countId)
    exigirEstado(c, 'EN_CONTEO')
    const ok = await t.inventoryCount.updateMany({ where: { id: c.id, status: 'EN_CONTEO' }, data: { status: 'EN_REVISION', closedAt: new Date(), closedById: ctx.userId } })
    if (ok.count !== 1) throw invalido('La toma de inventario cambió mientras se cerraba. Vuelve a cargarla.')
    const fresco = await t.inventoryCount.findFirstOrThrow({ where: { id: c.id }, select: SELECCION_CONTEO })
    const r = await resumir(t, fresco)
    await auditar(t, ctx, 'conteo.cerrar', c.id, { after: { numero: c.number, lineas: r.lineas, contadas: r.contadas, pendientes: r.pendientes, pasadas: r.pasadas } })
    return r
  }, OPCIONES_TX)
}

/** Cancela el conteo desde cualquier estado previo a APLICADO. No toca el stock (el conteo solo lo toca al aplicarse, en F6.5b). */
export async function cancelarConteo(db: TenantPrismaClient, ctx: TenantContext, input: CancelarConteoInput): Promise<ResumenConteo> {
  exigir(ctx, 'conteo.gestionar')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const c = await bloquear(t, input.countId)
    exigirEstado(c, 'BORRADOR', 'EN_CONTEO', 'EN_REVISION')
    if ((await t.inventoryCountItem.count({ where: { countId: c.id, resultingMovementId: { not: null } } })) > 0) throw invalido(`La toma de inventario ${c.number} ya aplicó ajustes al stock: no se puede cancelar.`)
    const ok = await t.inventoryCount.updateMany({ where: { id: c.id, status: { in: ['BORRADOR', 'EN_CONTEO', 'EN_REVISION'] } }, data: { status: 'CANCELADO', cancelledAt: new Date(), cancelledById: ctx.userId, cancelReason: input.reason } })
    if (ok.count !== 1) throw invalido('La toma de inventario cambió mientras se cancelaba. Vuelve a cargarla.')
    const fresco = await t.inventoryCount.findFirstOrThrow({ where: { id: c.id }, select: SELECCION_CONTEO })
    const r = await resumir(t, fresco)
    await auditar(t, ctx, 'conteo.cancelar', c.id, { reason: input.reason, before: { estado: c.status }, after: { numero: c.number, contadas: r.contadas, pasadas: r.pasadas } })
    return r
  }, OPCIONES_TX)
}

// ─── Lectura ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function obtenerConteo(db: TenantPrismaClient, ctx: TenantContext, countId: string): Promise<ResumenConteo> {
  if (!puedeVerConteos(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver tomas de inventario.')
  const c = await db.inventoryCount.findFirst({ where: { id: countId }, select: SELECCION_CONTEO })
  if (!c) throw noExiste()
  return resumir(db, c)
}

export async function listarConteos(db: TenantPrismaClient, ctx: TenantContext, opts: { estado?: InventoryCountStatus; limite?: number } = {}): Promise<ResumenConteo[]> {
  if (!puedeVerConteos(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver tomas de inventario.')
  const filas = await db.inventoryCount.findMany({ where: opts.estado ? { status: opts.estado } : {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: Math.min(opts.limite ?? 50, 200), select: SELECCION_CONTEO })
  return Promise.all(filas.map((c) => resumir(db, c)))
}

export interface LineaConteo {
  id: string
  productId: string
  variantId: string | null
  nombre: string
  sku: string
  unidad: UnitType
  estado: InventoryCountItemStatus
  /** Lo contado hasta ahora (suma de pasadas vigentes); `null` si no hay ninguna. */
  contado: number | null
  ultimaPasada: string | null
  /** AUSENTE (no vacía) en un conteo ciego para quien solo cuenta. */
  sistemaAlEmpezar?: number | null
}

/** Las líneas del conteo, ordenadas por nombre, por tandas (cursor = id de la última). */
export async function lineasDelConteo(db: TenantPrismaClient, ctx: TenantContext, countId: string, opts: { estado?: InventoryCountItemStatus; limite?: number; cursor?: string } = {}): Promise<{ lineas: LineaConteo[]; siguiente: string | null }> {
  if (!puedeVerConteos(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver tomas de inventario.')
  const c = await db.inventoryCount.findFirst({ where: { id: countId }, select: { id: true, mode: true } })
  if (!c) throw noExiste()
  const verSistema = puedeVerSistema(ctx, c.mode)
  const limite = Math.min(opts.limite ?? 100, 500)
  const filas = await db.inventoryCountItem.findMany({
    where: { countId: c.id, ...(opts.estado ? { status: opts.estado } : {}) },
    orderBy: [{ nameSnapshot: 'asc' }, { id: 'asc' }], take: limite + 1, ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: { id: true, productId: true, variantId: true, nameSnapshot: true, skuSnapshot: true, unitType: true, status: true, countedQty: true, lastCountedAt: true, ...(verSistema ? { systemQtyAtStart: true } : {}) },
  })
  const hayMas = filas.length > limite
  const pagina = hayMas ? filas.slice(0, limite) : filas
  return {
    lineas: pagina.map((f): LineaConteo => ({
      id: f.id, productId: f.productId, variantId: f.variantId, nombre: f.nameSnapshot, sku: f.skuSnapshot, unidad: f.unitType, estado: f.status,
      contado: f.countedQty === null ? null : num(f.countedQty), ultimaPasada: f.lastCountedAt?.toISOString() ?? null,
      ...(verSistema ? { sistemaAlEmpezar: (f as { systemQtyAtStart?: { toString(): string } | null }).systemQtyAtStart == null ? null : num((f as { systemQtyAtStart?: { toString(): string } | null }).systemQtyAtStart) } : {}),
    })),
    siguiente: hayMas ? pagina[pagina.length - 1]!.id : null,
  }
}

export interface PasadaConteo {
  id: string
  cantidad: number
  presentacion: { nombre: string; cantidad: number; factor: number } | null
  zona: string | null
  usuario: string
  cuando: string
  anulada: boolean
  motivoAnulacion: string | null
}

/** Las pasadas de una línea (anuladas incluidas, tachadas en pantalla): quién contó qué, cuándo y dónde. */
export async function pasadasDeLinea(db: TenantPrismaClient, ctx: TenantContext, itemId: string): Promise<PasadaConteo[]> {
  if (!puedeVerConteos(ctx)) throw new BusinessError('FORBIDDEN_ROLE', 'No tienes permiso para ver tomas de inventario.')
  const item = await db.inventoryCountItem.findFirst({ where: { id: itemId }, select: { id: true } })
  if (!item) throw new BusinessError('NOT_FOUND', 'La línea no existe.')
  const filas = await db.inventoryCountEntry.findMany({
    where: { itemId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, quantity: true, enteredQuantity: true, presentationFactor: true, presentation: { select: { name: true } }, zone: true, user: { select: { name: true, email: true } }, createdAt: true, voidedAt: true, voidReason: true },
  })
  return filas.map((f) => ({
    id: f.id, cantidad: num(f.quantity), zona: f.zone, usuario: f.user.name ?? f.user.email, cuando: f.createdAt.toISOString(), anulada: f.voidedAt !== null, motivoAnulacion: f.voidReason,
    presentacion: f.presentation && f.enteredQuantity !== null && f.presentationFactor !== null ? { nombre: f.presentation.name, cantidad: num(f.enteredQuantity), factor: num(f.presentationFactor) } : null,
  }))
}
