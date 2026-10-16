import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { BusinessError } from '@/lib/errors'
import { serieDeSucursal, type CounterScope } from './series'

/** Lo mínimo que un servicio necesita saber de la sucursal en la que opera. */
export interface SucursalOperativa {
  id: string
  code: string
  name: string
  seriesNumber: number
  establishmentCode: string
}

/**
 * Carga la sucursal en la que se va a emitir, verificando que sirva.
 *
 * Una sucursal inactiva o dada de baja NO puede emitir: su serie quedó
 * cerrada junto con los comprobantes que ya emitió. Dejarla emitir después
 * de la baja produciría documentos de un establecimiento que el negocio ya
 * declaró cerrado ante SUNAT.
 */
export async function cargarSucursalOperativa(
  db: TenantPrismaClient,
  branchId: string,
): Promise<SucursalOperativa> {
  const b = await db.branch.findFirst({
    where: { id: branchId, isActive: true, deletedAt: null },
    select: {
      id: true, code: true, name: true,
      seriesNumber: true, establishmentCode: true,
    },
  })
  if (!b) {
    throw new BusinessError(
      'TENANT_MISMATCH',
      'La sucursal no está disponible para emitir documentos.',
    )
  }
  return b
}

/** Serie y prefijo de un tipo de documento en una sucursal ya cargada. */
export function serieDe(sucursal: SucursalOperativa, scope: CounterScope) {
  return serieDeSucursal(scope, sucursal.seriesNumber)
}

/**
 * Comprueba que el almacén pertenezca a la sucursal en la que se opera.
 *
 * Sin esta verificación un cajero de la sucursal A podría descontar stock del
 * almacén de la sucursal B pasando su id: el aislamiento por tenant no lo
 * impide, porque ambos almacenes son del mismo negocio. Es la frontera que
 * separa establecimientos DENTRO de un tenant.
 */
export async function verificarAlmacenDeSucursal(
  db: TenantPrismaClient,
  branchId: string,
  warehouseId: string,
): Promise<{ id: string; branchId: string }> {
  const w = await db.warehouse.findFirst({
    where: { id: warehouseId, branchId, isActive: true, deletedAt: null },
    select: { id: true, branchId: true },
  })
  if (!w) {
    throw new BusinessError(
      'TENANT_MISMATCH',
      'El almacén no pertenece a tu sucursal o no está disponible.',
      { warehouseId },
    )
  }
  return w
}

/**
 * Turno de caja abierto en la sucursal, si hay alguno.
 *
 * Devuelve `null` en lugar de fallar cuando no hay caja abierta: vender sin
 * turno abierto es legítimo (un negocio puede no usar arqueo), y bloquear la
 * venta por eso dejaría la tienda parada. Lo que no se puede es inventar un
 * turno: la venta queda con `cashSessionId` nulo y simplemente no entra en
 * ningún arqueo.
 *
 * Vive aquí y no en el servicio de caja para que `registerSale` no tenga que
 * importar la lógica de arqueo —que a su vez necesita leer ventas— y se
 * forme un ciclo entre los dos módulos.
 */
export async function turnoAbiertoId(
  db: TenantPrismaClient,
  branchId: string,
): Promise<string | null> {
  const t = await db.cashSession.findFirst({
    where: { branchId, status: 'ABIERTA' },
    select: { id: true },
  })
  return t?.id ?? null
}

/**
 * Filtro `where` para elegir almacén dentro de la sucursal activa.
 *
 * ─── POR QUÉ EXISTE ──────────────────────────────────────────────────────
 *
 * Antes de multi-sucursal, «el almacén por defecto» era simplemente el
 * primero activo del tenant, y había cuatro copias de esa consulta repartidas
 * por el POS y el inventario. Con varias sucursales esa consulta devuelve el
 * almacén EQUIVOCADO para todo el que no esté en la casa matriz: el cajero ve
 * el nombre de otro local y cada cobro le falla, porque `registerSale` sí
 * comprueba que el almacén sea de su sucursal.
 *
 * Centralizarlo evita que la próxima pantalla vuelva a copiar la versión sin
 * sucursal.
 *
 * Si el contexto no trae sucursal, NO se filtra: el usuario sin asignación ya
 * queda frenado por `requireBranch` al intentar operar, y aquí filtrar por
 * `undefined` devolvería cualquier almacén, que es justo lo que se evita.
 */
export function filtroAlmacen(
  branchId: string | undefined,
  warehouseId?: string | null,
): Record<string, unknown> {
  return {
    isActive: true,
    deletedAt: null,
    /*
     * El centinela va en `branchId` y no en `id` a propósito: si fuera `id`,
     * el spread de `warehouseId` de abajo lo sobrescribiría y un usuario sin
     * sucursal que pasara un id concreto obtendría ese almacén. Sobre
     * `branchId` no hay forma de pisarlo.
     */
    branchId: branchId ?? '__sin_sucursal__',
    ...(warehouseId ? { id: warehouseId } : {}),
  }
}
