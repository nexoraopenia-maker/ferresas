import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { BusinessError } from '@/lib/errors'
import type { TenantContext } from '@/lib/tenant-context'
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

/** El turno ABIERTO de ESTA persona en la sucursal (F6.8b): el único donde puede entrar dinero que ella mueve. `null` si no tiene uno ahí. */
export async function turnoPropioId(db: TenantPrismaClient, userId: string, branchId: string): Promise<string | null> {
  const t = await db.cashSession.findFirst({ where: { branchId, openedById: userId, status: 'ABIERTA' }, select: { id: true } })
  return t?.id ?? null
}

/**
 * El turno propio de quien ejecuta, o `CASH_REQUIRED`. Toda operación que mueve dinero (cobros de cualquier medio, abonos, pagos a proveedor, movimientos,
 * compensaciones y devoluciones que sacan dinero) entra por aquí: el dinero va al turno de QUIEN lo ejecuta, no al de «quien abrió la caja del local».
 * `que` completa el mensaje («cobrar», «registrar un abono»…). Distingue «no tienes turno» de «tu turno está en otra sucursal» para que el cajero sepa qué hacer.
 */
export async function exigirTurnoPropio(db: TenantPrismaClient, ctx: Pick<TenantContext, 'userId'>, branchId: string, que: string): Promise<string> {
  const id = await turnoPropioId(db, ctx.userId, branchId)
  if (id) return id
  const otro = await db.cashSession.findFirst({ where: { openedById: ctx.userId, status: 'ABIERTA' }, select: { id: true } })
  throw new BusinessError(
    'CASH_REQUIRED',
    otro
      ? `Tu turno de caja está abierto en otra sucursal. Para ${que} aquí, ciérralo allí y abre tu caja en esta sucursal.`
      : `Para ${que} hace falta que tengas tu propio turno de caja abierto. Abre tu caja primero.`,
  )
}

/**
 * Dentro de la transacción: bloquea el turno propio y lo devuelve YA firme. Si su cierre empezó (o lo cerró un supervisor) mientras tanto, esto espera, lo ve
 * cerrado y niega con `CASH_REQUIRED`: ni un centavo entra a un turno cuyos totales ya se congelaron. Se bloquea DESPUÉS de cliente/proveedor/venta (orden único).
 */
export async function bloquearTurnoPropio(t: TenantPrismaClient, ctx: Pick<TenantContext, 'userId'>, branchId: string, que: string): Promise<string> {
  const id = await exigirTurnoPropio(t, ctx, branchId, que)
  if ((await bloquearTurno(t, id)).status !== 'ABIERTA') {
    throw new BusinessError('CASH_REQUIRED', `Tu turno de caja se cerró mientras tanto: abre uno nuevo para ${que}.`)
  }
  return id
}

/**
 * Bloquea la fila del turno hasta el final de la transacción y devuelve su estado YA firme.
 *
 * El cierre de caja y todo lo que mete o saca dinero de un turno por un camino que lo exige (abonos y su anulación) empiezan por
 * aquí: si el cierre ya empezó, quien llega después espera, ve `CERRADA` y no escribe en un turno cuyos totales ya se congelaron.
 * Orden de bloqueos de todo el crédito: cliente primero, turno después (el cierre solo toma el turno: no hay ciclos).
 */
export async function bloquearTurno(
  t: TenantPrismaClient,
  sessionId: string,
): Promise<{ id: string; status: 'ABIERTA' | 'CERRADA' }> {
  return t.cashSession.update({
    where: { id: sessionId },
    data: { updatedAt: new Date() },
    select: { id: true, status: true },
  })
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
