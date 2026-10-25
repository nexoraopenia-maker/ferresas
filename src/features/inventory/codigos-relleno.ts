import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { planificarCodigos, type CodigoAInsertar, type Colision, type DuenoLegado } from './codigos'

/**
 * Rellena `ProductCode` desde las columnas antiguas de UN negocio (`barcode` y `qrCode` de productos y de variantes).
 *
 * NO MUTA LOS DATOS ANTIGUOS. Si un código tiene más de un dueño, no se inserta para ninguno y se informa con los dueños y
 * sus columnas: arreglarlo es una decisión humana (¿cuál es el producto correcto?). Es idempotente: repetirlo no duplica
 * nada. Por defecto es un ensayo; con `ejecutar` escribe.
 */

export interface InformeRelleno {
  ejecutado: boolean
  productos: number
  variantes: number
  /** Códigos a insertar (o insertados). */
  insertados: number
  /** Ya estaban en la tabla con el mismo dueño. */
  yaExistian: number
  /** Códigos con más de un dueño en las columnas antiguas. */
  colisiones: Colision[]
  /** Códigos que la tabla ya tiene a nombre de OTRO dueño distinto del que dicen las columnas. */
  desfases: Array<{ codigo: string; enTabla: string; enColumnas: string }>
}

const POR_LOTE = 500

export async function poblarCodigos(db: TenantPrismaClient, tenantId: string, opciones: { ejecutar?: boolean } = {}): Promise<InformeRelleno> {
  // TODOS los productos, también los dados de baja: el único de las columnas antiguas no mira `deletedAt`, así que sus
  // códigos siguen ocupados.
  const productos = await db.product.findMany({
    select: { id: true, sku: true, name: true, barcode: true, qrCode: true, variants: { select: { id: true, sku: true, name: true, barcode: true, qrCode: true } } },
    orderBy: { id: 'asc' },
  })

  const duenos: DuenoLegado[] = []
  let nVariantes = 0
  for (const p of productos) {
    if (p.barcode) duenos.push({ productId: p.id, variantId: null, sku: p.sku, nombre: p.name, columna: 'barcode', codigo: p.barcode })
    if (p.qrCode) duenos.push({ productId: p.id, variantId: null, sku: p.sku, nombre: p.name, columna: 'qrCode', codigo: p.qrCode })
    for (const v of p.variants) {
      nVariantes++
      if (v.barcode) duenos.push({ productId: p.id, variantId: v.id, sku: v.sku, nombre: `${p.name} ${v.name}`, columna: 'barcode', codigo: v.barcode })
      if (v.qrCode) duenos.push({ productId: p.id, variantId: v.id, sku: v.sku, nombre: `${p.name} ${v.name}`, columna: 'qrCode', codigo: v.qrCode })
    }
  }

  const plan = planificarCodigos(duenos)

  const existentes = await db.productCode.findMany({ select: { code: true, productId: true, variantId: true } })
  const enTabla = new Map(existentes.map((e) => [e.code, e]))
  const nuevos: CodigoAInsertar[] = []
  const desfases: InformeRelleno['desfases'] = []
  let yaExistian = 0
  for (const c of plan.insertar) {
    const e = enTabla.get(c.code)
    if (!e) { nuevos.push(c); continue }
    if (e.productId === c.productId && e.variantId === c.variantId) yaExistian++
    else desfases.push({ codigo: c.code, enTabla: `${e.productId}${e.variantId ? `/${e.variantId}` : ''}`, enColumnas: `${c.productId}${c.variantId ? `/${c.variantId}` : ''}` })
  }

  if (opciones.ejecutar && nuevos.length > 0) {
    // Dueños que ya tienen un principal en la tabla: no se les pone otro (índice único parcial).
    const conPrincipal = new Set((await db.productCode.findMany({ where: { isPrimary: true }, select: { productId: true, variantId: true } })).map((x) => `${x.productId}:${x.variantId ?? ''}`))
    const filas = nuevos.map((n) => ({ tenantId, productId: n.productId, variantId: n.variantId, code: n.code, type: n.type, isPrimary: n.isPrimary && !conPrincipal.has(`${n.productId}:${n.variantId ?? ''}`) }))
    for (let i = 0; i < filas.length; i += POR_LOTE) {
      await db.productCode.createMany({ data: filas.slice(i, i + POR_LOTE), skipDuplicates: false })
    }
  }

  return { ejecutado: !!opciones.ejecutar, productos: productos.length, variantes: nVariantes, insertados: nuevos.length, yaExistian, colisiones: plan.colisiones, desfases }
}

/** El informe en texto para el operador: qué se hizo y, sobre todo, qué códigos chocan y de quién son. */
export function formatearInforme(slug: string, i: InformeRelleno): string {
  const l = [`${slug}: ${i.productos} productos, ${i.variantes} variantes · ${i.ejecutado ? 'insertados' : 'a insertar'} ${i.insertados} · ya estaban ${i.yaExistian}`]
  for (const c of i.colisiones) {
    l.push(`  ⚠ COLISIÓN ${c.codigo} (no se inserta para ninguno):`)
    for (const d of c.duenos) l.push(`      · ${d.sku} «${d.nombre}» (columna ${d.columna}${d.variantId ? ', variante' : ''})`)
  }
  for (const d of i.desfases) l.push(`  ⚠ DESFASE ${d.codigo}: la tabla lo tiene a ${d.enTabla} y las columnas a ${d.enColumnas}`)
  return l.join('\n')
}
