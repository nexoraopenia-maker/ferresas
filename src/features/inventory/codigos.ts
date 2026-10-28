import type { ProductCodeType } from '@/generated/prisma/enums'
import { BusinessError } from '@/lib/errors'
import { esGs1Valido } from '@/lib/codigos-barras'
import type { StockStatus } from '@/lib/stock-status'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { estadoDeFila } from './reposicion-reglas'

/**
 * Códigos de producto: tipo, plan de relleno desde las columnas antiguas, resolvedor único y sincronización.
 *
 * ─── EL PROBLEMA QUE RESUELVE ────────────────────────────────────────────
 * Un código vivía en cuatro columnas (barcode y qrCode, de producto y de variante) y escanear significaba preguntarle a
 * cada una. Dos cosas distintas podían tener el MISMO código (el EAN de un producto igual al QR de otro) y el escaneo
 * devolvía uno cualquiera. `ProductCode` pone todos los códigos en una tabla con `(tenantId, code)` ÚNICO: un código tiene
 * exactamente un dueño, y escanear resuelve en una sola consulta.
 *
 * ─── TRANSICIÓN ──────────────────────────────────────────────────────────
 * Las columnas antiguas siguen existiendo y los escritores las mantienen sincronizadas (`registrarCodigosProducto`).
 * El resolvedor consulta primero la tabla y, si el código no está, las columnas antiguas: así un producto que aún no se
 * rellenó sigue encontrándose. Un código que pertenece a VARIOS dueños nunca se adivina: se devuelve `ambiguo`.
 */

// ─── Tipo de un código ───────────────────────────────────────────────────────────────────────────────

/** Deduce el tipo. Un EAN/UPC solo lo es si su dígito de control cuadra; lo demás se trata como CODE128 (texto libre). */
export function tipoDeCodigo(codigo: string, esQr = false): ProductCodeType {
  if (esQr) return 'QR'
  if (/^\d{13}$/.test(codigo) && esGs1Valido(codigo, 13)) return 'EAN13'
  if (/^\d{8}$/.test(codigo) && esGs1Valido(codigo, 8)) return 'EAN8'
  if (/^\d{12}$/.test(codigo) && esGs1Valido(codigo, 12)) return 'UPC'
  return 'CODE128'
}

export const limpiarCodigo = (c: string | null | undefined): string | null => {
  const t = (c ?? '').trim()
  return t === '' ? null : t
}

// ─── Plan de relleno (puro) ───────────────────────────────────────────────────────────────────────────

export interface DuenoLegado {
  productId: string
  variantId: string | null
  /** SKU y nombre: para que el informe diga DE QUIÉN es cada código. */
  sku: string
  nombre: string
  columna: 'barcode' | 'qrCode'
  codigo: string
}

export interface CodigoAInsertar {
  productId: string
  variantId: string | null
  code: string
  type: ProductCodeType
  isPrimary: boolean
}

export interface Colision {
  codigo: string
  duenos: Array<{ productId: string; variantId: string | null; sku: string; nombre: string; columna: 'barcode' | 'qrCode' }>
}

const claveDueno = (d: { productId: string; variantId: string | null }) => `${d.productId}:${d.variantId ?? ''}`

/**
 * Qué filas de `ProductCode` salen de las columnas antiguas, y qué códigos chocan.
 * NUNCA resuelve una colisión: un código con más de un dueño no se inserta para ninguno y se informa. Un mismo dueño
 * con el mismo código en barcode y en qrCode NO es colisión (es una sola fila).
 */
export function planificarCodigos(entrada: readonly DuenoLegado[]): { insertar: CodigoAInsertar[]; colisiones: Colision[] } {
  const porCodigo = new Map<string, DuenoLegado[]>()
  for (const d of entrada) {
    const codigo = limpiarCodigo(d.codigo)
    if (!codigo) continue
    porCodigo.set(codigo, [...(porCodigo.get(codigo) ?? []), { ...d, codigo }])
  }

  const colisiones: Colision[] = []
  /** Por dueño, los códigos que SÍ se insertan (en el orden barcode, qrCode). */
  const porDueno = new Map<string, CodigoAInsertar[]>()
  for (const [codigo, duenos] of porCodigo) {
    const distintos = new Set(duenos.map(claveDueno))
    if (distintos.size > 1) {
      colisiones.push({ codigo, duenos: duenos.map((d) => ({ productId: d.productId, variantId: d.variantId, sku: d.sku, nombre: d.nombre, columna: d.columna })) })
      continue
    }
    // Un solo dueño. Si el código está en las dos columnas, vale como código de barras.
    const base = duenos.find((d) => d.columna === 'barcode') ?? duenos[0]!
    const fila: CodigoAInsertar = { productId: base.productId, variantId: base.variantId, code: codigo, type: tipoDeCodigo(codigo, base.columna === 'qrCode'), isPrimary: false }
    porDueno.set(claveDueno(base), [...(porDueno.get(claveDueno(base)) ?? []), fila])
  }

  const insertar: CodigoAInsertar[] = []
  for (const filas of porDueno.values()) {
    // Principal: el de barras (EAN/UPC/CODE128) si hay; si no, el QR.
    const principal = filas.find((f) => f.type !== 'QR') ?? filas[0]!
    for (const f of filas) insertar.push({ ...f, isPrimary: f === principal })
  }
  insertar.sort((a, b) => a.code.localeCompare(b.code))
  colisiones.sort((a, b) => a.codigo.localeCompare(b.codigo))
  return { insertar, colisiones }
}

// ─── Resolvedor ──────────────────────────────────────────────────────────────────────────────────────

const PRODUCTO = {
  id: true, name: true, sku: true, barcode: true, qrCode: true, unitType: true,
  salePrice: true, taxRate: true, minStock: true, maxStock: true, trackStock: true,
} as const
const VARIANTE = { id: true, name: true, sku: true, barcode: true, qrCode: true, salePrice: true, minStock: true, maxStock: true } as const
const STOCK = { quantity: true, reserved: true, minStock: true, maxStock: true, version: true } as const
// Sin el costo: lo que sale de un escaneo llega a quien cobra, y el costo es solo de quien tiene `productos.ver_costo`.
const PRESENTACION = { id: true, name: true, unitType: true, factor: true, salePrice: true, isActive: true, deletedAt: true } as const

type ProductoSel = { id: string; name: string; sku: string; barcode: string | null; qrCode: string | null; unitType: string; salePrice: { toString(): string }; taxRate: { toString(): string }; minStock: { toString(): string }; maxStock: { toString(): string } | null; trackStock: boolean }
type VarianteSel = { id: string; name: string; sku: string; barcode: string | null; qrCode: string | null; salePrice: { toString(): string } | null; minStock: { toString(): string }; maxStock: { toString(): string } | null }
export type PresentacionSel = { id: string; name: string; unitType: string; factor: { toString(): string }; salePrice: { toString(): string } | null }
type StockSel = { quantity: { toString(): string }; reserved: { toString(): string }; minStock: { toString(): string } | null; maxStock: { toString(): string } | null; version: number }

export interface CodigoResuelto {
  estado: 'ok'
  /** `tabla`: lo dijo ProductCode. `legado`: se encontró en las columnas antiguas (aún sin rellenar). */
  via: 'tabla' | 'legado'
  codigo: string
  tipo: ProductCodeType | null
  producto: ProductoSel
  variante: VarianteSel | null
  /** La presentación (caja, saco…) a la que identifica el código, si es el de una; `null` si identifica al producto o la variante. */
  presentacion: PresentacionSel | null
  /** Existencias del dueño del código en el almacén pedido (`null` si no se pidió almacén o no hay fila). */
  stock: StockSel | null
}

/**
 * El mínimo que rige y el semáforo de lo escaneado, por el criterio único de reposición (almacén → variante → producto; el semáforo juzga lo disponible).
 * Lo comparten el escáner de inventario y el POS: ninguno compara `minStock` por su cuenta.
 */
export function estadoDeCodigo(r: CodigoResuelto): { cantidad: number; minimo: number; estado: StockStatus } {
  const e = estadoDeFila({
    cantidad: r.stock?.quantity, reservado: r.stock?.reserved,
    almacenMin: r.stock?.minStock, almacenMax: r.stock?.maxStock,
    varianteMin: r.variante?.minStock, varianteMax: r.variante?.maxStock,
    productoMin: r.producto.minStock, productoMax: r.producto.maxStock,
  })
  return { cantidad: r.stock ? Number(r.stock.quantity) : 0, minimo: e.minimo, estado: e.estado }
}

export interface CodigoAmbiguo {
  estado: 'ambiguo'
  codigo: string
  candidatos: Array<{ productId: string; variantId: string | null; sku: string; nombre: string }>
}

/**
 * Resuelve lo escaneado o tecleado a `{producto, variante, presentación}`. Busca el código en `ProductCode` (una sola
 * consulta) y, si no está, en las columnas antiguas y por SKU de producto. `null` = el código no existe (no es un error:
 * la pantalla ofrece buscar por nombre o dar de alta). Solo productos y variantes ACTIVOS.
 */
export async function resolverCodigo(
  db: TenantPrismaClient, codigoCrudo: string, opciones: { almacenId?: string } = {},
): Promise<CodigoResuelto | CodigoAmbiguo | null> {
  const codigo = limpiarCodigo(codigoCrudo)
  if (!codigo) return null
  const al = opciones.almacenId

  // 1) La tabla: un código, un dueño.
  const fila = await db.productCode.findFirst({
    where: { code: codigo },
    select: {
      code: true, type: true, variantId: true,
      presentation: { select: PRESENTACION },
      product: { select: { ...PRODUCTO, deletedAt: true, isActive: true, stocks: al ? { where: { warehouseId: al, variantId: null }, select: STOCK, take: 1 } : false } },
      variant: { select: { ...VARIANTE, deletedAt: true, isActive: true, stocks: al ? { where: { warehouseId: al }, select: STOCK, take: 1 } : false } },
    },
    relationLoadStrategy: 'join',
  })
  if (fila) {
    const p = fila.product
    const v = fila.variant
    if (p.deletedAt || !p.isActive) return null
    if (fila.variantId && (!v || v.deletedAt || !v.isActive)) return null
    const pr = fila.presentation
    // Una presentación dada de baja o desactivada no se vende: su código no resuelve.
    if (pr && (pr.deletedAt || !pr.isActive)) return null
    const stocks = (fila.variantId ? (v as { stocks?: StockSel[] } | null)?.stocks : (p as { stocks?: StockSel[] }).stocks) ?? []
    return { estado: 'ok', via: 'tabla', codigo, tipo: fila.type, producto: p, variante: fila.variantId ? v : null, presentacion: pr ? { id: pr.id, name: pr.name, unitType: pr.unitType, factor: pr.factor, salePrice: pr.salePrice } : null, stock: stocks[0] ?? null }
  }

  // 2) Respaldo: columnas antiguas. Cada coincidencia es un dueño distinto; si hay más de uno, NO se adivina.
  const [productos, variantes] = await Promise.all([
    db.product.findMany({
      where: { deletedAt: null, isActive: true, OR: [{ barcode: codigo }, { qrCode: codigo }, { sku: codigo }] },
      select: { ...PRODUCTO, stocks: al ? { where: { warehouseId: al, variantId: null }, select: STOCK, take: 1 } : false },
      take: 3,
    }),
    db.productVariant.findMany({
      where: { deletedAt: null, isActive: true, product: { deletedAt: null, isActive: true }, OR: [{ barcode: codigo }, { qrCode: codigo }] },
      select: { ...VARIANTE, product: { select: PRODUCTO }, stocks: al ? { where: { warehouseId: al }, select: STOCK, take: 1 } : false },
      take: 3,
    }),
  ])
  const total = productos.length + variantes.length
  if (total === 0) return null
  if (total > 1) {
    return {
      estado: 'ambiguo', codigo,
      candidatos: [
        ...productos.map((p) => ({ productId: p.id, variantId: null, sku: p.sku, nombre: p.name })),
        ...variantes.map((v) => ({ productId: v.product.id, variantId: v.id, sku: v.sku, nombre: `${v.product.name} ${v.name}` })),
      ],
    }
  }
  if (productos[0]) {
    const p = productos[0] as typeof productos[0] & { stocks?: StockSel[] }
    return { estado: 'ok', via: 'legado', codigo, tipo: null, producto: p, variante: null, presentacion: null, stock: p.stocks?.[0] ?? null }
  }
  const v = variantes[0] as typeof variantes[0] & { stocks?: StockSel[] }
  return { estado: 'ok', via: 'legado', codigo, tipo: null, producto: v.product, variante: v, presentacion: null, stock: v.stocks?.[0] ?? null }
}

/** Mensaje para la pantalla cuando un código pertenece a más de un producto. */
export function mensajeAmbiguo(a: CodigoAmbiguo): string {
  const quienes = a.candidatos.slice(0, 3).map((c) => `${c.sku} «${c.nombre}»`).join(', ')
  return `El código ${a.codigo} pertenece a varios productos (${quienes}). Corrige los códigos en Inventario para poder escanearlo.`
}

// ─── Sincronización de los escritores ───────────────────────────────────────────────────────────────

export class CodigoDeOtro extends BusinessError {
  constructor(codigo: string) {
    super('DUPLICATE_CODE', `El código ${codigo} ya pertenece a otro producto o variante de este negocio.`, { codigo })
  }
}

/**
 * Deja en `ProductCode` los códigos de un producto (o variante) tal como los acaba de escribir el servicio en sus columnas.
 * Va DENTRO de la misma transacción que la escritura. Si un código ya es de OTRO dueño lanza `DUPLICATE_CODE`: la base lo
 * habría rechazado de todos modos (único por negocio), y así el mensaje es claro y la transacción se deshace entera.
 */
export async function registrarCodigosProducto(
  t: TenantPrismaClient, tenantId: string,
  dueno: { productId: string; variantId?: string | null },
  codigos: { barcode?: string | null; qrCode?: string | null },
  /** Lo que tenía antes en sus columnas: lo que ya no tenga se retira de la tabla (si no, el viejo código seguiría resolviendo a él). */
  anteriores: { barcode?: string | null; qrCode?: string | null } = {},
): Promise<void> {
  const variantId = dueno.variantId ?? null
  const barcode = limpiarCodigo(codigos.barcode)
  const qr = limpiarCodigo(codigos.qrCode)
  const deseados: Array<{ code: string; type: ProductCodeType }> = []
  if (barcode) deseados.push({ code: barcode, type: tipoDeCodigo(barcode) })
  if (qr && qr !== barcode) deseados.push({ code: qr, type: 'QR' })

  for (const viejo of [limpiarCodigo(anteriores.barcode), limpiarCodigo(anteriores.qrCode)]) {
    if (viejo && !deseados.some((d) => d.code === viejo)) await retirarCodigoProducto(t, dueno, viejo)
  }

  const propias = await t.productCode.findMany({ where: { productId: dueno.productId, variantId, presentationId: null }, select: { id: true, code: true, isPrimary: true } })
  const principal = deseados.find((d) => d.type !== 'QR') ?? deseados[0]

  for (const d of deseados) {
    const existente = await t.productCode.findFirst({ where: { code: d.code }, select: { id: true, productId: true, variantId: true } })
    if (existente && (existente.productId !== dueno.productId || existente.variantId !== variantId)) throw new CodigoDeOtro(d.code)
    if (!existente) {
      await t.productCode.create({ data: { tenantId, productId: dueno.productId, variantId, code: d.code, type: d.type, isPrimary: false } })
    }
  }
  // El principal: se baja el viejo antes de subir el nuevo (índice único parcial: uno por dueño).
  const idPrincipal = principal ? (await t.productCode.findFirst({ where: { code: principal.code }, select: { id: true } }))?.id : undefined
  for (const p of propias) {
    if (p.isPrimary && p.id !== idPrincipal) await t.productCode.update({ where: { id: p.id }, data: { isPrimary: false } })
  }
  if (idPrincipal) await t.productCode.update({ where: { id: idPrincipal }, data: { isPrimary: true } })
}

/** Quita de `ProductCode` un código que el dueño ya no tiene en sus columnas. */
export async function retirarCodigoProducto(
  t: TenantPrismaClient, dueno: { productId: string; variantId?: string | null }, codigo: string,
): Promise<void> {
  await t.productCode.deleteMany({ where: { code: codigo, productId: dueno.productId, variantId: dueno.variantId ?? null } })
}

// ─── Coherencia ──────────────────────────────────────────────────────────────────────────────────────

export interface CoherenciaCodigos {
  /** Productos con código en las columnas antiguas y sin su fila en la tabla (aún no rellenados). */
  sinFila: number
  /** Filas de la tabla cuyo código ya no está en las columnas de su dueño (desfase). */
  filasHuerfanas: number
}

/** Cuenta cuánto se han separado las columnas antiguas y la tabla. Solo lectura. */
export async function auditarCoherenciaCodigos(db: TenantPrismaClient): Promise<CoherenciaCodigos> {
  const productos = await db.product.findMany({ select: { id: true, barcode: true, qrCode: true, codes: { where: { variantId: null }, select: { code: true } } } })
  let sinFila = 0
  for (const p of productos) {
    const codigos = new Set(p.codes.map((c) => c.code))
    for (const c of [p.barcode, p.qrCode]) if (c && !codigos.has(c.trim())) sinFila++
  }
  const filas = await db.productCode.findMany({ where: { variantId: null }, select: { code: true, product: { select: { barcode: true, qrCode: true } } } })
  const filasHuerfanas = filas.filter((f) => f.code !== f.product.barcode?.trim() && f.code !== f.product.qrCode?.trim()).length
  return { sinFila, filasHuerfanas }
}
