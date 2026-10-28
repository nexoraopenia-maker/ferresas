import type { StockStatus } from '@/lib/stock-status'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { filtroAlmacen } from '@/features/branches/queries'
import { estadoDeFila } from '@/features/inventory/reposicion-reglas'
import { variantesConTilde } from './resaltado'

/**
 * Búsqueda del punto de venta.
 *
 * Una sola caja para lo que el cajero tenga a mano: el código de barras que
 * leyó a medias, el SKU de la etiqueta o parte del nombre en cualquier orden
 * («sol cemento» encuentra «Cemento Sol 42.5 kg»). Los resultados salen
 * ORDENADOS por lo parecido que son: lo que coincide exactamente con un código
 * va primero, así que teclear un código completo deja el producto en la
 * posición 1 y basta con pulsar Enter.
 *
 * No hace falta una extensión de Postgres: con catálogos de ferretería (miles,
 * no millones de filas) un `contains` acotado por tenant responde en
 * milisegundos. Si un negocio llegara a decenas de miles, el siguiente paso es
 * un índice `pg_trgm`; no se adelanta porque exige una extensión en la base.
 */

export const MIN_CARACTERES = 2
export const MAX_RESULTADOS = 20
/** Se traen más de los que se enseñan para poder ordenar bien antes de recortar. */
const CANDIDATOS = 60

export interface ResultadoPos {
  productId: string
  variantId: string | null
  name: string
  sku: string
  barcode: string | null
  qrCode: string | null
  unitType: string
  salePrice: number
  taxRate: number
  trackStock: boolean
  stock: number
  minStock: number
  stockStatus: StockStatus
  warehouseId: string
  warehouseName: string
  /** 0 = coincide exactamente con un código; mayor = menos parecido. */
  relevancia: number
}

const sinAcentos = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** Palabras sueltas de la búsqueda, sin espacios dobles. */
export function palabras(texto: string): string[] {
  return texto.trim().split(/\s+/).filter((p) => p.length > 0).slice(0, 6)
}

interface Candidato {
  name: string
  sku: string
  barcode: string | null
  qrCode: string | null
}

/**
 * Qué tan buena es la coincidencia. Menor es mejor.
 *   0  código exacto (barras, QR o SKU)
 *   1  el código o el SKU EMPIEZA por lo tecleado
 *   2  el nombre empieza por lo tecleado
 *   3  todas las palabras empiezan una palabra del nombre
 *   4  las palabras aparecen en el nombre o en el SKU
 */
export function relevancia(c: Candidato, texto: string): number {
  const t = sinAcentos(texto.trim())
  const sku = sinAcentos(c.sku)
  const codigos = [c.barcode, c.qrCode].filter((x): x is string => !!x).map(sinAcentos)
  if (sku === t || codigos.includes(t)) return 0
  if (sku.startsWith(t) || codigos.some((x) => x.startsWith(t))) return 1
  const nombre = sinAcentos(c.name)
  if (nombre.startsWith(t)) return 2
  const ps = palabras(t)
  const inicios = nombre.split(/[\s\-/.,()]+/)
  if (ps.every((p) => inicios.some((w) => w.startsWith(p)))) return 3
  return 4
}

export async function buscarProductos(
  db: TenantPrismaClient,
  ctx: TenantContext,
  texto: string,
): Promise<ResultadoPos[]> {
  const t = texto.trim()
  if (t.length < MIN_CARACTERES || t.length > 80) return []

  const warehouse = await db.warehouse.findFirst({
    where: filtroAlmacen(ctx.branchId),
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true },
  })
  if (!warehouse) return []

  const ps = palabras(t)
  const productos = await db.product.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      OR: [
        // Códigos: exactos y por prefijo (el cajero teclea desde el principio).
        { barcode: { startsWith: t } },
        { qrCode: t },
        { sku: { startsWith: t, mode: 'insensitive' } },
        // Nombre: TODAS las palabras, en cualquier orden, en el nombre o en el SKU.
        {
          // Cada palabra, con sus variantes con tilde: «presion» encuentra «presión».
          AND: ps.map((p) => ({
            OR: variantesConTilde(p).flatMap((v) => [
              { name: { contains: v, mode: 'insensitive' as const } },
              { sku: { contains: v, mode: 'insensitive' as const } },
            ]),
          })),
        },
      ],
    },
    take: CANDIDATOS,
    orderBy: { name: 'asc' },
    select: {
      id: true, name: true, sku: true, barcode: true, qrCode: true,
      unitType: true, salePrice: true, taxRate: true, minStock: true, maxStock: true, trackStock: true,
      stocks: {
        where: { warehouseId: warehouse.id, variantId: null },
        select: { quantity: true, reserved: true, minStock: true, maxStock: true },
        take: 1,
      },
    },
  })

  return productos
    .map((p) => {
      const s = p.stocks[0]
      const stock = s ? Number(s.quantity) : 0
      // El criterio único de reposición: almacén → producto, y el semáforo juzga lo disponible.
      const { minimo: minStock, estado } = estadoDeFila({
        cantidad: stock, reservado: s?.reserved,
        almacenMin: s?.minStock, almacenMax: s?.maxStock,
        productoMin: p.minStock, productoMax: p.maxStock,
      })
      return {
        productId: p.id,
        variantId: null,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        qrCode: p.qrCode,
        unitType: p.unitType,
        salePrice: Number(p.salePrice),
        taxRate: Number(p.taxRate),
        trackStock: p.trackStock,
        stock,
        minStock,
        stockStatus: estado,
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        relevancia: relevancia(p, t),
      }
    })
    .sort((a, b) =>
      a.relevancia - b.relevancia ||
      // A igual parecido, lo que hay en el estante antes que lo agotado.
      Number(b.stock > 0) - Number(a.stock > 0) ||
      a.name.localeCompare(b.name, 'es'))
    .slice(0, MAX_RESULTADOS)
}

export type { StockStatus }
