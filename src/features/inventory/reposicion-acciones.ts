/**
 * Del reporte a la acción (F6.6c): crear el BORRADOR de compra de un proveedor y pedir una transferencia a la sucursal con excedente. Las dos recalculan todo en el SERVIDOR a
 * partir de la base: el cliente solo dice QUÉ proveedor/almacén/producto, nunca cuánto ni a qué costo.
 *
 * Cada acción exige SU permiso (`compras.registrar`, `stock.transferir_solicitar`) y NO el de ver el reporte: un permiso = un poder. Los costos del borrador se leen aquí (quien
 * registra compras ya teclea y ve costos) y nunca vuelven al navegador desde esta ruta.
 */
import { BusinessError } from '@/lib/errors'
import { exigir } from '@/lib/puede'
import { requireBranch, type TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { crearBorrador } from '@/features/compras/service'
import { crearBorradorSchema } from '@/features/compras/schemas'
import { createTransfer } from '@/features/branches/transfer-service'
import { createTransferSchema } from '@/features/branches/transfer-schemas'
import { calcularReporte, type LineaReposicion } from './reposicion-reporte'
import { cantidadATransferir } from './reposicion-excedentes'

const num = (v: unknown) => Number(v ?? 0)
const r4 = (n: number) => Math.round(n * 10_000) / 10_000
const invalido = (m: string) => new BusinessError('INVALID_DOCUMENT', m)
export const MAX_LINEAS_BORRADOR = 200
export const NOTA_BORRADOR = 'Generado desde la reposición sugerida. Revisa cantidades y costos antes de recibir.'
export const NOTA_TRANSFERENCIA = 'Pedido desde la reposición sugerida.'

/**
 * El último costo conocido por unidad BASE de cada producto: el de la última compra RECIBIDA (cualquier presentación) y, si nunca se le compró, el costo promedio del producto.
 * `null` = sin dato (el borrador lleva 0 y se completa a mano).
 */
export async function ultimosCostos(db: TenantPrismaClient, productIds: readonly string[]): Promise<Map<string, number | null>> {
  const costos = new Map<string, number | null>()
  if (productIds.length === 0) return costos
  const [compras, productos] = await Promise.all([
    db.purchaseItem.findMany({
      where: { productId: { in: [...productIds] }, purchase: { status: 'RECIBIDA' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5000,
      select: { productId: true, unitCost: true },
    }),
    db.product.findMany({ where: { id: { in: [...productIds] } }, select: { id: true, costPrice: true } }),
  ])
  for (const c of compras) if (!costos.has(c.productId) && num(c.unitCost) > 0) costos.set(c.productId, num(c.unitCost))
  for (const p of productos) if (!costos.has(p.id)) costos.set(p.id, num(p.costPrice) > 0 ? num(p.costPrice) : null)
  return costos
}

export interface ResultadoBorrador {
  id: string
  number: string
  replayed: boolean
  lineas: number
  /** Líneas de variantes que no entraron: las compras se registran sobre el producto. */
  variantesOmitidas: number
  /** Líneas sin ningún costo conocido: el borrador las lleva a 0 para completarlas. */
  sinCosto: number
}

export async function crearBorradorDeCompraDesdeReposicion(
  db: TenantPrismaClient, ctx: TenantContext, entrada: { supplierId: string | null; warehouseId: string; idempotencyKey: string },
): Promise<ResultadoBorrador> {
  exigir(ctx, 'compras.registrar')
  const reporte = await calcularReporte(db, ctx, { warehouseId: entrada.warehouseId }, false)
  if (reporte.warehouseId !== entrada.warehouseId) throw new BusinessError('TENANT_MISMATCH', 'El almacén no existe o no es de tus sucursales.')

  const grupo = reporte.grupos.find((g) => g.supplierId === entrada.supplierId)
  const delAlmacen = (grupo?.lineas ?? []).filter((l) => l.warehouseId === entrada.warehouseId)
  const lineas = delAlmacen.filter((l) => l.variantId === null && l.pedir.cantidad > 0)
  const variantesOmitidas = delAlmacen.length - lineas.length
  if (lineas.length === 0) throw invalido(variantesOmitidas > 0 ? 'Lo que falta es de variantes y las compras se registran sobre el producto: arma el borrador a mano.' : 'No hay nada que pedir a ese proveedor en ese almacén.')
  if (lineas.length > MAX_LINEAS_BORRADOR) throw invalido(`Hay ${lineas.length} productos por pedir y un borrador admite ${MAX_LINEAS_BORRADOR}. Pide por partes desde el filtro de almacén o carga el resto a mano.`)

  const costos = await ultimosCostos(db, lineas.map((l) => l.productId))
  let sinCosto = 0
  const items = lineas.map((l) => {
    const baseCosto = costos.get(l.productId) ?? null
    if (baseCosto === null) sinCosto++
    // El costo de la línea es por unidad de COMPRA (la caja): el último costo por unidad base × las unidades que trae.
    return { productId: l.productId, presentationId: l.pedir.presentacion?.id ?? null, enteredQuantity: l.pedir.cantidad, unitCost: r4((baseCosto ?? 0) * (l.pedir.presentacion?.factor ?? 1)) }
  })
  const entradaCompra = crearBorradorSchema.parse({
    warehouseId: entrada.warehouseId, supplierId: entrada.supplierId, paymentCondition: 'CONTADO', notes: NOTA_BORRADOR, items, idempotencyKey: entrada.idempotencyKey,
  })
  const r = await crearBorrador(db, ctx, entradaCompra)
  return { ...r, lineas: items.length, variantesOmitidas, sinCosto }
}

export interface ResultadoTransferencia { id: string; number: string; lineas: number; desde: string; unidades: Record<string, number> }

/** Pide a la sucursal con excedente lo que a este almacén le falta, sin pasar de lo que a ella le sobra. La sucursal que recibe es SIEMPRE la de la persona (`createTransfer` lo exige). */
export async function solicitarTransferenciaDesdeReposicion(
  db: TenantPrismaClient, ctx: TenantContext, entrada: { fromWarehouseId: string; toWarehouseId: string; items: { productId: string; variantId?: string | null }[] },
): Promise<ResultadoTransferencia> {
  exigir(ctx, 'stock.transferir_solicitar')
  const miSucursal = requireBranch(ctx)
  const reporte = await calcularReporte(db, ctx, { warehouseId: entrada.toWarehouseId }, false)
  if (reporte.warehouseId !== entrada.toWarehouseId) throw new BusinessError('TENANT_MISMATCH', 'El almacén no existe o no es de tus sucursales.')

  const lineas = reporte.grupos.flatMap((g) => g.lineas)
  const pedidos: { linea: LineaReposicion; cantidad: number }[] = []
  let desdeSucursal: string | null = null
  let desdeNombre = ''
  for (const it of entrada.items) {
    const linea = lineas.find((l) => l.warehouseId === entrada.toWarehouseId && l.productId === it.productId && l.variantId === (it.variantId ?? null))
    if (!linea) throw invalido('Ese producto ya no necesita reposición en este almacén.')
    const donante = linea.excedentes.find((e) => e.warehouseId === entrada.fromWarehouseId)
    if (!donante) throw invalido(`«${linea.nombre}»: ese almacén ya no tiene excedente para ofrecer.`)
    const cantidad = cantidadATransferir(linea.sugerida, donante.excedente, linea.unitType)
    if (!(cantidad > 0)) throw invalido(`«${linea.nombre}»: el excedente (${donante.excedente}) no alcanza para una unidad entera.`)
    desdeSucursal = donante.branchId
    desdeNombre = donante.sucursal
    pedidos.push({ linea, cantidad })
  }
  if (!desdeSucursal || desdeSucursal === miSucursal) throw invalido('El excedente tiene que estar en otra sucursal.')

  const input = createTransferSchema.parse({
    sentido: 'PEDIR', fromBranchId: desdeSucursal, fromWarehouseId: entrada.fromWarehouseId, toBranchId: miSucursal, toWarehouseId: entrada.toWarehouseId, notes: NOTA_TRANSFERENCIA,
    items: pedidos.map((p) => ({ productId: p.linea.productId, variantId: p.linea.variantId, quantity: p.cantidad })),
  })
  const t = await createTransfer(db, ctx, input)
  return { id: t.id, number: t.number, lineas: t.lineas, desde: desdeNombre, unidades: Object.fromEntries(pedidos.map((p) => [p.linea.sku, p.cantidad])) }
}
