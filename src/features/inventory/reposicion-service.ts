/**
 * Lectura de las posiciones de stock que alimentan el motor de reposición (F6.6a). Une, por almacén, lo que hay, lo reservado, lo que viene en camino por
 * transferencias EN_TRANSITO y los umbrales con su herencia (almacén → variante → producto). La decisión (semáforo, disparo, sugerida) es de
 * `reposicion-reglas.ts`; aquí solo se leen los datos y se acota por las sucursales que el usuario alcanza.
 *
 * No pide un permiso aparte: es el mismo dato que el POS enseña al vender (cantidad y estado). Nunca lee ni devuelve costos.
 */
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import type { StockStatus } from '@/lib/stock-status'
import { estadoDeFila, evaluarReposicion, resolverUmbrales, type EvaluacionReposicion, type OrigenUmbral } from './reposicion-reglas'

const num = (v: unknown) => Number(v ?? 0)

export interface PosicionStock extends EvaluacionReposicion {
  productId: string
  variantId: string | null
  /** `null` solo en la fila sintética de un producto sin existencias en NINGÚN almacén alcanzable. */
  warehouseId: string | null
  almacen: string | null
  nombre: string
  sku: string
  unitType: string
  /** Proveedor habitual del producto (para agrupar la compra en F6.6b). */
  supplierId: string | null
  origenMinimo: OrigenUmbral
  origenMaximo: OrigenUmbral | null
}

export interface FiltroPosiciones {
  productId?: string
  warehouseId?: string
}

/** Almacenes de las sucursales alcanzables, vivos y activos. */
function filtroAlmacenes(ctx: TenantContext, warehouseId?: string) {
  return {
    deletedAt: null,
    isActive: true,
    ...(ctx.branchIds ? { branchId: { in: [...ctx.branchIds] } } : {}),
    ...(warehouseId ? { id: warehouseId } : {}),
  }
}

const claveEnTransito = (warehouseId: string, productId: string, variantId: string | null) =>
  `${warehouseId}|${productId}|${variantId ?? ''}`

/**
 * Lo que va en camino hacia cada (almacén, producto, variante): lo enviado por transferencias EN_TRANSITO. Una transferencia deja de estar en tránsito al
 * recibirse (pasa a RECIBIDA y la mercadería ya está en el stock), así que no se cuenta dos veces. Los borradores de compra NO cuentan: no son mercadería en camino.
 */
async function enTransitoPorAlmacen(db: TenantPrismaClient, almacenes: string[], filtro: FiltroPosiciones): Promise<Map<string, number>> {
  const mapa = new Map<string, number>()
  if (almacenes.length === 0) return mapa
  const items = await db.branchTransferItem.findMany({
    where: {
      transfer: { status: 'EN_TRANSITO', toWarehouseId: { in: almacenes } },
      ...(filtro.productId ? { productId: filtro.productId } : {}),
    },
    select: { productId: true, variantId: true, quantitySent: true, quantityReceived: true, transfer: { select: { toWarehouseId: true } } },
  })
  for (const i of items) {
    // `quantityReceived` solo se llena al recibir; si alguna vez hubiera algo ya recibido, no es «en camino».
    const pendiente = num(i.quantitySent) - num(i.quantityReceived)
    if (pendiente <= 0) continue
    const k = claveEnTransito(i.transfer.toWarehouseId, i.productId, i.variantId)
    mapa.set(k, (mapa.get(k) ?? 0) + pendiente)
  }
  return mapa
}

/**
 * Una posición por cada fila de stock (almacén × producto × variante) de los almacenes alcanzables, más una fila sintética «agotado» por cada producto con
 * control de stock que no tiene fila en ninguno de ellos (nunca entró mercadería). No filtra por estado: quien lee decide qué mostrar.
 */
export async function posicionesDeStock(
  db: TenantPrismaClient,
  ctx: TenantContext,
  filtro: FiltroPosiciones = {},
): Promise<PosicionStock[]> {
  const almacenes = filtroAlmacenes(ctx, filtro.warehouseId)
  const productoVivo = {
    deletedAt: null, isActive: true, trackStock: true,
    ...(filtro.productId ? { id: filtro.productId } : {}),
  }

  const [filas, sinFila] = await Promise.all([
    db.stock.findMany({
      where: {
        warehouse: almacenes,
        product: productoVivo,
        // Una variante dada de baja ya no se vende ni se repone.
        OR: [{ variantId: null }, { variant: { deletedAt: null, isActive: true } }],
        ...(filtro.productId ? { productId: filtro.productId } : {}),
      },
      select: {
        productId: true, variantId: true, warehouseId: true,
        quantity: true, reserved: true, minStock: true, maxStock: true,
        warehouse: { select: { name: true } },
        product: { select: { name: true, sku: true, unitType: true, minStock: true, maxStock: true, supplierId: true } },
        variant: { select: { name: true, sku: true, minStock: true, maxStock: true } },
      },
      orderBy: [{ productId: 'asc' }, { warehouseId: 'asc' }],
    }),
    // Un producto sin fila de stock en los almacenes alcanzables está agotado (no hay nada que contar): se conserva el aviso de siempre.
    filtro.warehouseId
      ? Promise.resolve([] as Array<{ id: string; name: string; sku: string; unitType: string; minStock: unknown; maxStock: unknown; supplierId: string | null }>)
      : db.product.findMany({
          where: { ...productoVivo, stocks: { none: { warehouse: almacenes } } },
          select: { id: true, name: true, sku: true, unitType: true, minStock: true, maxStock: true, supplierId: true },
        }),
  ])

  const transito = await enTransitoPorAlmacen(db, [...new Set(filas.map((f) => f.warehouseId))], filtro)

  const posiciones: PosicionStock[] = filas.map((f) => {
    const u = resolverUmbrales({
      almacenMin: f.minStock, almacenMax: f.maxStock,
      varianteMin: f.variant?.minStock, varianteMax: f.variant?.maxStock,
      productoMin: f.product.minStock, productoMax: f.product.maxStock,
    })
    const ev = evaluarReposicion({
      cantidad: num(f.quantity), reservado: num(f.reserved),
      enTransito: transito.get(claveEnTransito(f.warehouseId, f.productId, f.variantId)) ?? 0,
      minimo: u.minimo, maximo: u.maximo,
    })
    return {
      ...ev,
      productId: f.productId, variantId: f.variantId, warehouseId: f.warehouseId, almacen: f.warehouse.name,
      nombre: f.variant ? `${f.product.name} ${f.variant.name}` : f.product.name,
      sku: f.variant?.sku ?? f.product.sku,
      unitType: f.product.unitType, supplierId: f.product.supplierId,
      origenMinimo: u.origenMinimo, origenMaximo: u.origenMaximo,
    }
  })

  for (const p of sinFila) {
    const u = resolverUmbrales({ productoMin: p.minStock as never, productoMax: p.maxStock as never })
    posiciones.push({
      ...evaluarReposicion({ cantidad: 0, minimo: u.minimo, maximo: u.maximo }),
      productId: p.id, variantId: null, warehouseId: null, almacen: null,
      nombre: p.name, sku: p.sku, unitType: p.unitType, supplierId: p.supplierId,
      origenMinimo: u.origenMinimo, origenMaximo: u.origenMaximo,
    })
  }
  return posiciones
}

/**
 * El semáforo de UNA fila de stock tras un movimiento, con los umbrales de AHORA (almacén → variante → producto): el movimiento pudo cambiarlos y lo reservado
 * puede haber cambiado. `cantidad` es el saldo que dejó el movimiento.
 */
export async function estadoTrasMovimiento(
  db: TenantPrismaClient,
  e: { warehouseId: string; productId: string; variantId: string | null; cantidad: number },
): Promise<StockStatus> {
  const fila = await db.stock.findFirst({
    where: { warehouseId: e.warehouseId, productId: e.productId, variantId: e.variantId },
    select: {
      reserved: true, minStock: true, maxStock: true,
      product: { select: { minStock: true, maxStock: true } },
      variant: { select: { minStock: true, maxStock: true } },
    },
  })
  // Sin fila de stock todavía (el primer movimiento aún no la creó): los umbrales son los del producto y la variante.
  const [producto, variante] = fila ? [fila.product, fila.variant] : await Promise.all([
    db.product.findFirst({ where: { id: e.productId }, select: { minStock: true, maxStock: true } }),
    e.variantId ? db.productVariant.findFirst({ where: { id: e.variantId }, select: { minStock: true, maxStock: true } }) : null,
  ])
  return estadoDeFila({
    cantidad: e.cantidad, reservado: fila?.reserved,
    almacenMin: fila?.minStock, almacenMax: fila?.maxStock,
    varianteMin: variante?.minStock, varianteMax: variante?.maxStock,
    productoMin: producto?.minStock, productoMax: producto?.maxStock,
  }).estado
}
