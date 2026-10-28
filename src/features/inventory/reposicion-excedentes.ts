/**
 * Transferir antes de comprar (F6.6c): qué sucursales tienen EXCEDENTE de lo que a otra le falta, y cuánto se les puede pedir sin dejarlas bajo su propio nivel objetivo.
 *
 *  · Un almacén tiene excedente cuando lo DISPONIBLE (existencias − reservado) supera su objetivo (su máximo o, sin máximo, 2 × su mínimo), menos lo que ya le pidieron en transferencias
 *    todavía sin despachar. Un almacén sin ningún umbral (mínimo 0 y sin máximo) NO tiene excedente: sin umbral no hay forma de saber qué le sobra.
 *  · Solo se miran almacenes de OTRA sucursal (una transferencia entre dos almacenes de la misma sucursal es un ajuste) activos y de una sucursal activa.
 *  · Leer el excedente de otra sucursal no abre su inventario: solo se devuelve cuánto sobra, no cuánto hay. Pedir un excedente es `stock.transferir_solicitar` (la acción lo exige).
 *  · Límite conocido: las transferencias pendientes se leen con el alcance de la persona; una solicitud entre otras dos sucursales que ella no alcanza no resta del excedente.
 */
import type { UnitType } from '@/generated/prisma/enums'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { decimalesPermitidos } from './conversion'
import { evaluarReposicion, resolverUmbrales } from './reposicion-reglas'

const num = (v: unknown) => Number(v ?? 0)
const DIEZMIL = 10_000

export interface Excedente {
  warehouseId: string
  almacen: string
  branchId: string
  sucursal: string
  /** Cuánto le sobra sobre su propio objetivo, en unidad base. */
  excedente: number
}

/** Cuánto pedir de un excedente: lo necesario sin pasarse de lo que sobra, y sin partir una unidad que no se parte (unidades enteras: hacia abajo). */
export function cantidadATransferir(necesaria: number, excedente: number, unitType: UnitType | string): number {
  const tope = BigInt(Math.floor(Math.min(necesaria, excedente) * DIEZMIL + 1e-6))
  if (tope <= 0n) return 0
  const paso = BigInt(10 ** (4 - Math.min(4, decimalesPermitidos(unitType as UnitType))))
  return Number((tope / paso) * paso) / DIEZMIL
}

/** El donante con más excedente primero; a igual excedente, por nombre. */
export function ordenarDonantes<T extends { excedente: number; sucursal: string; almacen: string }>(donantes: readonly T[]): T[] {
  return [...donantes].sort((a, b) => b.excedente - a.excedente || a.sucursal.localeCompare(b.sucursal, 'es') || a.almacen.localeCompare(b.almacen, 'es'))
}

export interface PedidoDeExcedente {
  productId: string
  variantId: string | null
  /** El almacén que RECIBIRÍA. */
  warehouseId: string
}

export const claveExcedente = (p: PedidoDeExcedente) => `${p.warehouseId}|${p.productId}|${p.variantId ?? ''}`

/** Los excedentes de otras sucursales para cada (almacén que necesita, producto, variante). Devuelve solo los pedidos que tienen al menos un donante. */
export async function excedentesPara(db: TenantPrismaClient, ctx: TenantContext, pedidos: readonly PedidoDeExcedente[]): Promise<Map<string, Excedente[]>> {
  const salida = new Map<string, Excedente[]>()
  if (pedidos.length === 0) return salida
  void ctx

  const almacenes = await db.warehouse.findMany({
    where: { deletedAt: null, isActive: true, branch: { isActive: true, deletedAt: null } },
    select: { id: true, name: true, branchId: true, branch: { select: { name: true } } },
  })
  const infoAlmacen = new Map(almacenes.map((a) => [a.id, a]))
  const productIds = [...new Set(pedidos.map((p) => p.productId))]

  const filas = await db.stock.findMany({
    where: { productId: { in: productIds }, warehouseId: { in: almacenes.map((a) => a.id) }, product: { deletedAt: null, isActive: true, trackStock: true }, OR: [{ variantId: null }, { variant: { deletedAt: null, isActive: true } }] },
    select: {
      productId: true, variantId: true, warehouseId: true, quantity: true, reserved: true, minStock: true, maxStock: true,
      product: { select: { minStock: true, maxStock: true } }, variant: { select: { minStock: true, maxStock: true } },
    },
  })

  // Lo ya pedido a cada donante y todavía sin despachar (SOLICITADA o APROBADA): no se vuelve a ofrecer.
  const pendientes = await db.branchTransferItem.findMany({
    where: { productId: { in: productIds }, transfer: { status: { in: ['SOLICITADA', 'APROBADA'] }, fromWarehouseId: { in: [...new Set(filas.map((f) => f.warehouseId))] } } },
    select: { productId: true, variantId: true, quantitySent: true, transfer: { select: { fromWarehouseId: true } } },
  })
  const saliente = new Map<string, number>()
  for (const i of pendientes) {
    const k = `${i.transfer.fromWarehouseId}|${i.productId}|${i.variantId ?? ''}`
    saliente.set(k, (saliente.get(k) ?? 0) + num(i.quantitySent))
  }

  const donantes = new Map<string, { f: (typeof filas)[number]; excedente: number }[]>()
  for (const f of filas) {
    const u = resolverUmbrales({ almacenMin: f.minStock, almacenMax: f.maxStock, varianteMin: f.variant?.minStock, varianteMax: f.variant?.maxStock, productoMin: f.product.minStock, productoMax: f.product.maxStock })
    if (!(u.minimo > 0) && !(u.maximo !== null && u.maximo > 0)) continue
    const ev = evaluarReposicion({ cantidad: num(f.quantity), reservado: num(f.reserved), minimo: u.minimo, maximo: u.maximo })
    const sobra = Math.round((ev.disponible - ev.objetivo - (saliente.get(`${f.warehouseId}|${f.productId}|${f.variantId ?? ''}`) ?? 0)) * DIEZMIL) / DIEZMIL
    if (!(sobra > 0)) continue
    const k = `${f.productId}|${f.variantId ?? ''}`
    const l = donantes.get(k) ?? []
    l.push({ f, excedente: sobra })
    donantes.set(k, l)
  }

  for (const p of pedidos) {
    const receptor = infoAlmacen.get(p.warehouseId)
    if (!receptor) continue
    const lista: Excedente[] = []
    for (const d of donantes.get(`${p.productId}|${p.variantId ?? ''}`) ?? []) {
      const a = infoAlmacen.get(d.f.warehouseId)
      if (!a || a.branchId === receptor.branchId) continue
      lista.push({ warehouseId: a.id, almacen: a.name, branchId: a.branchId, sucursal: a.branch.name, excedente: d.excedente })
    }
    if (lista.length > 0) salida.set(claveExcedente(p), ordenarDonantes(lista))
  }
  return salida
}

/** Lo que ya está pedido hacia un almacén y todavía no se despacha (SOLICITADA o APROBADA): solo informativo, no cambia la posición. */
export async function pendienteDeLlegar(db: TenantPrismaClient, warehouseIds: readonly string[], productIds: readonly string[]): Promise<Map<string, number>> {
  const mapa = new Map<string, number>()
  if (warehouseIds.length === 0 || productIds.length === 0) return mapa
  const items = await db.branchTransferItem.findMany({
    where: { productId: { in: [...productIds] }, transfer: { status: { in: ['SOLICITADA', 'APROBADA'] }, toWarehouseId: { in: [...warehouseIds] } } },
    select: { productId: true, variantId: true, quantitySent: true, transfer: { select: { toWarehouseId: true } } },
  })
  for (const i of items) {
    const k = `${i.transfer.toWarehouseId}|${i.productId}|${i.variantId ?? ''}`
    mapa.set(k, (mapa.get(k) ?? 0) + num(i.quantitySent))
  }
  return mapa
}
