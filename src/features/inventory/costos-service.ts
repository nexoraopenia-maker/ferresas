import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'

/**
 * Entradas de mercadería con «costo pendiente».
 *
 * Quien registró la entrada no tenía `productos.ver_costo` (típicamente el
 * almacenero): puso la cantidad y la entrada quedó marcada. Mientras falte el
 * costo, esa entrada no alimenta ningún costo promedio. Aquí lo completa quien
 * SÍ puede ver costos (dueño, administrador, contador).
 */

export interface CostoPendiente {
  movementId: string
  producto: string
  sku: string
  unitType: string
  cantidad: number
  almacen: string
  registradaPor: string
  fecha: Date
}

/** Si el contexto trae `branchIds`, solo los almacenes de las sucursales que alcanza. */
const filtroAlmacenes = (ctx: TenantContext) =>
  ctx.branchIds ? { warehouse: { branchId: { in: [...ctx.branchIds] } } } : {}

export async function listarCostosPendientes(
  db: TenantPrismaClient,
  ctx: TenantContext,
  limite = 100,
): Promise<CostoPendiente[]> {
  exigir(ctx, 'productos.ver_costo')
  const filas = await db.stockMovement.findMany({
    where: { type: 'ENTRADA', costPending: true, ...filtroAlmacenes(ctx) },
    orderBy: { createdAt: 'asc' },
    take: limite,
    select: {
      id: true, quantity: true, createdAt: true,
      product: { select: { name: true, sku: true, unitType: true } },
      warehouse: { select: { name: true } },
      user: { select: { name: true } },
    },
  })
  return filas.map((f) => ({
    movementId: f.id, producto: f.product.name, sku: f.product.sku, unitType: f.product.unitType,
    cantidad: Number(f.quantity), almacen: f.warehouse.name, registradaPor: f.user?.name ?? '—', fecha: f.createdAt,
  }))
}

/** Cuántas entradas esperan costo. `null` si el usuario no puede verlos (no se revela ni el número). */
export async function contarCostosPendientes(
  db: TenantPrismaClient,
  ctx: TenantContext,
): Promise<number> {
  exigir(ctx, 'productos.ver_costo')
  return db.stockMovement.count({ where: { type: 'ENTRADA', costPending: true, ...filtroAlmacenes(ctx) } })
}

