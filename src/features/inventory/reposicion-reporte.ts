/**
 * El reporte de reposición sugerida (F6.6b): lo que hay que pedir, agrupado por proveedor habitual, con la cantidad redondeada hacia arriba a la presentación de compra.
 * Exige `reposicion.ver`. Los costos y el valor estimado del pedido solo se LEEN y se devuelven con `productos.ver_costo`: sin ese permiso la respuesta ni siquiera trae
 * las claves de costo.
 *
 * La presentación de compra de un producto es la ÚLTIMA presentación activa con la que se le compró (no hay una «presentación de compra» configurada aparte); sin
 * compras con presentación, se pide en la unidad base.
 */
import { randomUUID } from 'node:crypto'
import { generarCsv, type CeldaCsv } from '@/lib/csv-export'
import { redondearCentimos } from '@/lib/dinero'
import { exigir, puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { agruparPorProveedor, cantidadAPedir, entraAlReporte, esBajoPedido, type CantidadAPedir, type GrupoProveedor, type PresentacionDeCompra } from './reposicion-pedido'
import { cantidadATransferir, claveExcedente, excedentesPara, pendienteDeLlegar, type Excedente } from './reposicion-excedentes'
import { posicionesDeStock } from './reposicion-service'

const num = (v: unknown) => Number(v ?? 0)

export interface LineaReposicion {
  clave: string
  productId: string
  variantId: string | null
  warehouseId: string | null
  /** La sucursal del almacén (para saber si la persona puede pedir o comprar aquí). */
  branchId: string | null
  almacen: string | null
  nombre: string
  sku: string
  unitType: string
  supplierId: string | null
  estado: 'OK' | 'LOW' | 'OUT'
  cantidad: number
  reservado: number
  disponible: number
  enTransito: number
  posicion: number
  minimo: number
  maximo: number | null
  objetivo: number
  /** Lo que sugiere el motor, en unidad base y sin redondear. */
  sugerida: number
  /** Cuánto pedir, redondeado hacia arriba a la presentación de compra (o a los decimales de la unidad). */
  pedir: CantidadAPedir
  /** Sin proveedor ni umbrales, pero con la posición por debajo de cero: se muestra aunque normalmente se trabaje contra pedido. */
  bajoPedidoNegativo: boolean
  /** Otras sucursales a las que les sobra de esto (el que más, primero): conviene pedirles ANTES de comprar. */
  excedentes: Excedente[]
  /** Cuánto se puede pedir al primer donante: lo necesario sin pasar de lo que le sobra. */
  transferible: number
  /** Ya pedido hacia este almacén en transferencias sin despachar (informativo: aún no cuenta como «en camino»). */
  pendienteDeLlegar: number
  /** SOLO con `productos.ver_costo`. */
  costoUnitario?: number | null
  valorEstimado?: number | null
}

export type GrupoReposicion = GrupoProveedor<LineaReposicion> & {
  /** SOLO con `productos.ver_costo`: suma de las líneas con costo. */
  valorEstimado?: number
  sinCosto?: number
}

export interface ReporteReposicion {
  grupos: GrupoReposicion[]
  totalLineas: number
  /** Productos que se trabajan contra pedido y no entran al reporte. */
  omitidosBajoPedido: number
  almacenes: { id: string; name: string }[]
  warehouseId: string | null
  verCostos: boolean
  /** SOLO con `productos.ver_costo`. */
  valorEstimado?: number
  sinCosto?: number
}

export async function reporteDeReposicion(db: TenantPrismaClient, ctx: TenantContext, filtro: { warehouseId?: string } = {}): Promise<ReporteReposicion> {
  exigir(ctx, 'reposicion.ver')
  return calcularReporte(db, ctx, filtro, puede(ctx, 'productos.ver_costo'))
}

/**
 * El cálculo, SIN comprobar permisos: lo usan el reporte (`reposicion.ver`) y las acciones que nacen de él (crear el borrador de compra: `compras.registrar`; pedir una transferencia:
 * `stock.transferir_solicitar`), que comprueban SU permiso y no exigen el de ver el reporte (un permiso = un poder). Quien llama decide `verCostos`.
 */
export async function calcularReporte(db: TenantPrismaClient, ctx: TenantContext, filtro: { warehouseId?: string }, verCostos: boolean): Promise<ReporteReposicion> {

  const almacenes = await db.warehouse.findMany({
    where: { deletedAt: null, isActive: true, ...(ctx.branchIds ? { branchId: { in: [...ctx.branchIds] } } : {}) },
    select: { id: true, name: true, branchId: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }, { id: 'asc' }],
  })
  const sucursalDe = new Map(almacenes.map((a) => [a.id, a.branchId]))
  const elegido = filtro.warehouseId ? almacenes.find((a) => a.id === filtro.warehouseId) ?? null : null

  const posiciones = await posicionesDeStock(db, ctx, elegido ? { warehouseId: elegido.id } : {})
  let omitidosBajoPedido = 0
  const candidatas = posiciones.filter((p) => {
    // La reposición se pide POR ALMACÉN: un producto sin fila de stock en tus almacenes (la fila sintética del panel) no tiene dónde recibirse y no se lista.
    if (p.warehouseId === null) return false
    if (!p.dispara) return false
    if (esBajoPedido(p) && !(p.posicion < 0)) { omitidosBajoPedido++; return false }
    return entraAlReporte(p)
  })

  const productIds = [...new Set(candidatas.map((p) => p.productId))]
  const supplierIds = [...new Set(candidatas.flatMap((p) => (p.supplierId ? [p.supplierId] : [])))]

  const [compras, proveedores, productos, variantes, excedentes, pendientes] = await Promise.all([
    productIds.length === 0 ? [] : db.purchaseItem.findMany({
      where: { productId: { in: productIds }, presentationId: { not: null }, presentation: { isActive: true, deletedAt: null }, purchase: { status: { not: 'ANULADA' } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5000,
      select: { productId: true, presentation: { select: { id: true, name: true, unitType: true, factor: true } } },
    }),
    supplierIds.length === 0 ? [] : db.supplier.findMany({ where: { id: { in: supplierIds }, deletedAt: null }, select: { id: true, name: true } }),
    // El costo solo se lee si la persona puede verlo.
    verCostos && productIds.length > 0 ? db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, costPrice: true } }) : [],
    verCostos && candidatas.some((p) => p.variantId) ? db.productVariant.findMany({ where: { id: { in: candidatas.flatMap((p) => (p.variantId ? [p.variantId] : [])) } }, select: { id: true, costPrice: true } }) : [],
    excedentesPara(db, ctx, candidatas.flatMap((p) => (p.warehouseId ? [{ productId: p.productId, variantId: p.variantId, warehouseId: p.warehouseId }] : []))),
    pendienteDeLlegar(db, [...new Set(candidatas.flatMap((p) => (p.warehouseId ? [p.warehouseId] : [])))], productIds),
  ])

  const presentacionDe = new Map<string, PresentacionDeCompra>()
  for (const c of compras) {
    if (!c.presentation || presentacionDe.has(c.productId)) continue
    presentacionDe.set(c.productId, { id: c.presentation.id, name: c.presentation.name, unitType: c.presentation.unitType, factor: num(c.presentation.factor) })
  }
  const costoProducto = new Map(productos.map((p) => [p.id, num(p.costPrice)]))
  const costoVariante = new Map(variantes.flatMap((v) => (v.costPrice === null ? [] : [[v.id, num(v.costPrice)] as const])))

  const lineas: LineaReposicion[] = candidatas.map((p) => {
    const pedir = cantidadAPedir(p.sugerida, p.unitType, presentacionDe.get(p.productId) ?? null)
    const clave = p.warehouseId ? claveExcedente({ productId: p.productId, variantId: p.variantId, warehouseId: p.warehouseId }) : ''
    const donantes = excedentes.get(clave) ?? []
    const base: LineaReposicion = {
      clave: `${p.warehouseId ?? '-'}:${p.productId}:${p.variantId ?? '-'}`,
      excedentes: donantes, transferible: donantes[0] ? cantidadATransferir(p.sugerida, donantes[0].excedente, p.unitType) : 0, pendienteDeLlegar: pendientes.get(clave) ?? 0,
      productId: p.productId, variantId: p.variantId, warehouseId: p.warehouseId, branchId: p.warehouseId ? sucursalDe.get(p.warehouseId) ?? null : null, almacen: p.almacen, nombre: p.nombre, sku: p.sku, unitType: p.unitType, supplierId: p.supplierId,
      estado: p.estado, cantidad: p.cantidad, reservado: p.reservado, disponible: p.disponible, enTransito: p.enTransito, posicion: p.posicion,
      minimo: p.minimo, maximo: p.maximo, objetivo: p.objetivo, sugerida: p.sugerida, pedir, bajoPedidoNegativo: esBajoPedido(p),
    }
    if (!verCostos) return base
    const costo = (p.variantId ? costoVariante.get(p.variantId) : undefined) ?? costoProducto.get(p.productId) ?? 0
    return { ...base, costoUnitario: costo > 0 ? costo : null, valorEstimado: costo > 0 ? redondearCentimos(pedir.unidadesBase * costo) : null }
  })

  const nombres = new Map(proveedores.map((s) => [s.id, s.name]))
  const grupos: GrupoReposicion[] = agruparPorProveedor(lineas, nombres).map((g) => {
    if (!verCostos) return g
    const conCosto = g.lineas.filter((l) => l.valorEstimado != null)
    return { ...g, valorEstimado: redondearCentimos(conCosto.reduce((s, l) => s + l.valorEstimado!, 0)), sinCosto: g.lineas.length - conCosto.length }
  })

  const reporte: ReporteReposicion = { grupos, totalLineas: lineas.length, omitidosBajoPedido, almacenes, warehouseId: elegido?.id ?? null, verCostos }
  if (verCostos) {
    reporte.valorEstimado = redondearCentimos(grupos.reduce((s, g) => s + (g.valorEstimado ?? 0), 0))
    reporte.sinCosto = grupos.reduce((s, g) => s + (g.sinCosto ?? 0), 0)
  }
  return reporte
}

const ETIQUETA_ESTADO = { OUT: 'Agotado', LOW: 'En su mínimo', OK: 'Disponible' } as const

/**
 * El reporte en CSV (Excel es-PE), UNA fila por producto y almacén, ya agrupado por proveedor. Exige `reposicion.ver`. Las columnas de dinero (costo y valor estimado) existen SOLO con
 * `productos.ver_costo`: sin él la cabecera ni las nombra. Deja una línea de auditoría por descarga.
 */
export async function exportarReposicionCsv(db: TenantPrismaClient, ctx: TenantContext, filtro: { warehouseId?: string } = {}): Promise<{ nombre: string; contenido: string; filas: number }> {
  const reporte = await reporteDeReposicion(db, ctx, filtro)
  const { verCostos } = reporte
  const cabecera = [
    'Proveedor', 'Producto', 'SKU', 'Almacén', 'Unidad', 'Estado', 'Existencias', 'Reservado', 'Disponible', 'En camino', 'Posición', 'Mínimo', 'Máximo', 'Objetivo', 'Sugerida',
    'Presentación', 'Cantidad a pedir', 'Unidades a pedir', 'Excedente en otra sucursal', 'Nota',
  ]
  if (verCostos) cabecera.push('Costo unitario', 'Valor estimado')
  const filas: CeldaCsv[][] = reporte.grupos.flatMap((g) => g.lineas.map((l): CeldaCsv[] => [
    g.nombre, l.nombre, l.sku, l.almacen ?? '', l.unitType, ETIQUETA_ESTADO[l.estado], l.cantidad, l.reservado, l.disponible, l.enTransito, l.posicion, l.minimo, l.maximo, l.objetivo, l.sugerida,
    l.pedir.presentacion ? `${l.pedir.presentacion.name} de ${l.pedir.presentacion.factor}` : '', l.pedir.cantidad, l.pedir.unidadesBase,
    l.excedentes[0] ? `${l.excedentes[0].sucursal}: ${l.excedentes[0].excedente}` : '', l.bajoPedidoNegativo ? 'Vendido sin existencias' : '',
    ...(verCostos ? [l.costoUnitario == null ? null : { monto: l.costoUnitario }, l.valorEstimado == null ? null : { monto: l.valorEstimado }] : []),
  ]))
  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'reporte.exportado', entityType: 'Reposicion', entityId: randomUUID(),
      after: { reporte: 'reposicion', filas: filas.length, conCostos: verCostos, almacen: reporte.warehouseId } as never, impersonationId: ctx.impersonationId ?? null,
    },
  })
  return { nombre: 'reposicion-sugerida.csv', contenido: generarCsv(cabecera, filas), filas: filas.length }
}
