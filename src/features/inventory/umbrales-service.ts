/**
 * Mínimos y máximos de reposición (F6.6b): la cuadrícula editable, la actualización en bloque y la importación por CSV de umbrales. Todo lo que escribe exige
 * `reposicion.configurar` (fuera del PIN) y deja UNA fila de auditoría por lote. Los umbrales se escriben en tres niveles (almacén, variante, producto) y se heredan
 * en ese orden al leerlos (`reposicion-reglas.ts`).
 */
import { randomUUID } from 'node:crypto'
import { BusinessError } from '@/lib/errors'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { parseCsv } from './csv'
import { resolverUmbrales, type OrigenUmbral } from './reposicion-reglas'
import { aplicarUmbralesSchema, type AplicarUmbralesInput, type CambioUmbralInput, type ListarUmbralesInput, type NivelUmbral, MAX_CAMBIOS_UMBRALES } from './umbrales-schemas'

const num = (v: unknown) => Number(v ?? 0)
const numONull = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const invalido = (m: string) => new BusinessError('INVALID_DOCUMENT', m)
const OPCIONES_TX = { maxWait: 15_000, timeout: 60_000 } as const
export const TAMANO_PAGINA_UMBRALES = 100
export const MAX_FILAS_CSV_UMBRALES = MAX_CAMBIOS_UMBRALES

const almacenesAlcanzables = (ctx: TenantContext) => ({ deletedAt: null, isActive: true, ...(ctx.branchIds ? { branchId: { in: [...ctx.branchIds] } } : {}) })

// ─── La cuadrícula ───────────────────────────────────────────────────────────────────────────────

export interface FilaUmbral {
  productId: string
  variantId: string | null
  warehouseId: string
  nombre: string
  sku: string
  unitType: string
  cantidad: number
  /** Lo fijado en ESTE almacén (`null` = hereda). */
  almacenMin: number | null
  almacenMax: number | null
  /** Lo que rige hoy, con su origen. */
  minimo: number
  maximo: number | null
  origenMinimo: OrigenUmbral
  origenMaximo: OrigenUmbral | null
}

export interface PaginaUmbrales {
  almacenes: { id: string; name: string }[]
  warehouseId: string | null
  filas: FilaUmbral[]
  total: number
  pagina: number
  paginas: number
}

/** Las filas de stock de UN almacén con sus umbrales, de 100 en 100. Exige `reposicion.configurar`. */
export async function listarUmbrales(db: TenantPrismaClient, ctx: TenantContext, f: ListarUmbralesInput = {}): Promise<PaginaUmbrales> {
  exigir(ctx, 'reposicion.configurar')
  const almacenes = await db.warehouse.findMany({ where: almacenesAlcanzables(ctx), select: { id: true, name: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }, { id: 'asc' }] })
  const elegido = almacenes.find((a) => a.id === f.warehouseId) ?? almacenes[0] ?? null
  if (!elegido) return { almacenes, warehouseId: null, filas: [], total: 0, pagina: 0, paginas: 0 }

  const q = f.q?.trim()
  const where = {
    warehouseId: elegido.id,
    product: {
      deletedAt: null, isActive: true, trackStock: true,
      ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { sku: { contains: q, mode: 'insensitive' as const } }, { barcode: { startsWith: q } }] } : {}),
    },
    OR: [{ variantId: null }, { variant: { deletedAt: null, isActive: true } }],
  }
  const pagina = f.pagina ?? 0
  const [total, filas] = await Promise.all([
    db.stock.count({ where }),
    db.stock.findMany({
      where, skip: pagina * TAMANO_PAGINA_UMBRALES, take: TAMANO_PAGINA_UMBRALES,
      orderBy: [{ product: { name: 'asc' } }, { productId: 'asc' }, { variantId: 'asc' }],
      select: {
        productId: true, variantId: true, warehouseId: true, quantity: true, minStock: true, maxStock: true,
        product: { select: { name: true, sku: true, unitType: true, minStock: true, maxStock: true } },
        variant: { select: { name: true, sku: true, minStock: true, maxStock: true } },
      },
    }),
  ])
  return {
    almacenes, warehouseId: elegido.id, total, pagina, paginas: Math.ceil(total / TAMANO_PAGINA_UMBRALES),
    filas: filas.map((s) => {
      const u = resolverUmbrales({
        almacenMin: s.minStock, almacenMax: s.maxStock, varianteMin: s.variant?.minStock, varianteMax: s.variant?.maxStock,
        productoMin: s.product.minStock, productoMax: s.product.maxStock,
      })
      return {
        productId: s.productId, variantId: s.variantId, warehouseId: s.warehouseId,
        nombre: s.variant ? `${s.product.name} ${s.variant.name}` : s.product.name, sku: s.variant?.sku ?? s.product.sku, unitType: s.product.unitType,
        cantidad: num(s.quantity), almacenMin: numONull(s.minStock), almacenMax: numONull(s.maxStock),
        minimo: u.minimo, maximo: u.maximo, origenMinimo: u.origenMinimo, origenMaximo: u.origenMaximo,
      }
    }),
  }
}

// ─── Aplicar en bloque ───────────────────────────────────────────────────────────────────────────

export interface ResultadoUmbrales {
  aplicados: number
  /** Cambios que dejaban el valor como estaba. */
  sinCambio: number
}

interface Actual { min: number | null; max: number | null }

const etiqueta = (c: CambioUmbralInput, n: number) => `Cambio ${n + 1} (${c.nivel === 'ALMACEN' ? 'almacén' : c.nivel === 'VARIANTE' ? 'variante' : 'producto'})`

/**
 * Escribe los cambios de umbrales en UNA transacción: o entran todos o ninguno. Valida contra lo que HAY (un máximo no puede quedar por debajo del mínimo del mismo
 * nivel, aunque el cambio solo toque uno de los dos), que el almacén sea de las sucursales de la persona y que la fila de stock exista (esto NO crea filas de stock).
 */
export async function aplicarUmbrales(db: TenantPrismaClient, ctx: TenantContext, entrada: AplicarUmbralesInput): Promise<ResultadoUmbrales> {
  exigir(ctx, 'reposicion.configurar')
  const parsed = aplicarUmbralesSchema.safeParse(entrada)
  if (!parsed.success) throw invalido(parsed.error.issues[0]?.message ?? 'Revisa los cambios.')
  const cambios = parsed.data.cambios

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const antes: object[] = []
    const despues: object[] = []
    let aplicados = 0
    let sinCambio = 0
    const vistos = new Set<string>()

    for (const [i, c] of cambios.entries()) {
      const clave = `${c.nivel}|${c.productId}|${c.variantId ?? ''}|${c.warehouseId ?? ''}`
      if (vistos.has(clave)) throw invalido(`${etiqueta(c, i)}: el mismo producto aparece dos veces en el lote.`)
      vistos.add(clave)

      let actual: Actual | null
      if (c.nivel === 'ALMACEN') {
        const s = await t.stock.findFirst({
          where: { warehouseId: c.warehouseId!, productId: c.productId, variantId: c.variantId ?? null, warehouse: almacenesAlcanzables(ctx), product: { deletedAt: null } },
          select: { id: true, minStock: true, maxStock: true },
        })
        actual = s ? { min: numONull(s.minStock), max: numONull(s.maxStock) } : null
        if (!actual) throw invalido(`${etiqueta(c, i)}: ese producto no tiene existencias registradas en ese almacén (o el almacén no es de tus sucursales).`)
      } else if (c.nivel === 'VARIANTE') {
        const v = await t.productVariant.findFirst({ where: { id: c.variantId!, productId: c.productId, deletedAt: null }, select: { minStock: true, maxStock: true } })
        if (!v) throw invalido(`${etiqueta(c, i)}: la variante no existe.`)
        actual = { min: num(v.minStock), max: numONull(v.maxStock) }
      } else {
        const p = await t.product.findFirst({ where: { id: c.productId, deletedAt: null }, select: { minStock: true, maxStock: true } })
        if (!p) throw invalido(`${etiqueta(c, i)}: el producto no existe.`)
        actual = { min: num(p.minStock), max: numONull(p.maxStock) }
      }

      // Lo que queda: `undefined` = igual que hoy; `null` = quitar el valor propio (en producto y variante, el mínimo vuelve a 0).
      const quitaMin = c.nivel === 'ALMACEN' ? null : 0
      const nuevoMin = c.minimo === undefined ? actual.min : c.minimo === null ? quitaMin : c.minimo
      const nuevoMax = c.maximo === undefined ? actual.max : c.maximo
      if (nuevoMax !== null && nuevoMin !== null && nuevoMax < nuevoMin) {
        throw invalido(`${etiqueta(c, i)}: el máximo (${nuevoMax}) no puede ser menor que el mínimo (${nuevoMin}) de ese nivel.`)
      }
      if (nuevoMin === actual.min && nuevoMax === actual.max) { sinCambio++; continue }

      if (c.nivel === 'ALMACEN') {
        await t.stock.updateMany({ where: { warehouseId: c.warehouseId!, productId: c.productId, variantId: c.variantId ?? null }, data: { minStock: nuevoMin, maxStock: nuevoMax } })
      } else if (c.nivel === 'VARIANTE') {
        await t.productVariant.update({ where: { id: c.variantId! }, data: { minStock: nuevoMin ?? 0, maxStock: nuevoMax }, select: { id: true } })
      } else {
        await t.product.update({ where: { id: c.productId }, data: { minStock: nuevoMin ?? 0, maxStock: nuevoMax }, select: { id: true } })
      }
      const quien = { nivel: c.nivel as NivelUmbral, productId: c.productId, variantId: c.variantId ?? null, warehouseId: c.warehouseId ?? null }
      antes.push({ ...quien, minimo: actual.min, maximo: actual.max })
      despues.push({ ...quien, minimo: nuevoMin, maximo: nuevoMax })
      aplicados++
    }

    if (aplicados > 0) {
      await t.auditLog.create({
        data: {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'reposicion.umbrales', entityType: 'Reposicion', entityId: randomUUID(),
          before: { cambios: antes } as never, after: { cambios: despues, aplicados } as never, impersonationId: ctx.impersonationId ?? null,
        },
      })
    }
    return { aplicados, sinCambio }
  }, OPCIONES_TX)
}

// ─── Importar umbrales por CSV ───────────────────────────────────────────────────────────────────

/**
 * CSV de umbrales: `sku`, `almacen` (código o nombre, opcional), `minimo`, `maximo`. El `sku` es el de un producto o el de una variante. Sin almacén se escribe el
 * predeterminado del producto (o de la variante); con almacén, el de esa fila de stock. Una celda vacía = no tocar; `-` = quitar el valor propio (hereda).
 */
const ALIAS_CSV: Record<'sku' | 'almacen' | 'minimo' | 'maximo', string[]> = {
  sku: ['sku', 'codigo', 'código', 'cod'],
  almacen: ['almacen', 'almacén', 'warehouse', 'bodega'],
  minimo: ['minimo', 'mínimo', 'min', 'stock minimo', 'stock mínimo', 'minstock'],
  maximo: ['maximo', 'máximo', 'max', 'stock maximo', 'stock máximo', 'maxstock'],
}

export interface FilaUmbralCsv {
  linea: number
  estado: 'ok' | 'error'
  errores: string[]
  /** Lo que se mostrará en la vista previa. */
  sku: string
  almacen: string | null
  cambio: CambioUmbralInput | null
}

export interface AnalisisUmbralesCsv {
  filas: FilaUmbralCsv[]
  resumen: { total: number; ok: number; error: number }
  bloqueos: string[]
  /** Los cambios listos para enviar a `aplicarUmbrales` (solo si no hay errores ni bloqueos). */
  cambios: CambioUmbralInput[]
}

type Celda = { vacia: true } | { vacia: false; quitar: true } | { vacia: false; quitar: false; valor: number } | { error: string }

/** `''` = no tocar, `-` = quitar, número = fijar. Acepta coma decimal. */
export function leerCeldaUmbral(crudo: string | undefined): Celda {
  const s = (crudo ?? '').trim()
  if (s === '') return { vacia: true }
  if (s === '-') return { vacia: false, quitar: true }
  const n = Number(s.replace(',', '.'))
  if (!/^\d+([.,]\d+)?$/.test(s) || !Number.isFinite(n)) return { error: `«${s}» no es un número.` }
  if (Math.round(n * 10_000) / 10_000 !== n) return { error: `«${s}» tiene más de 4 decimales.` }
  return { vacia: false, quitar: false, valor: n }
}

export async function analizarUmbralesCsv(db: TenantPrismaClient, ctx: TenantContext, contenido: string): Promise<AnalisisUmbralesCsv> {
  exigir(ctx, 'reposicion.configurar')
  const bloqueos: string[] = []
  const tabla = parseCsv(contenido)
  const idx: Partial<Record<keyof typeof ALIAS_CSV, number>> = {}
  for (const [campo, nombres] of Object.entries(ALIAS_CSV) as [keyof typeof ALIAS_CSV, string[]][]) {
    const i = tabla.headers.findIndex((h) => nombres.includes(h.replace(/^﻿/, '').trim().toLowerCase()))
    if (i >= 0) idx[campo] = i
  }
  if (idx.sku === undefined) bloqueos.push('No se encontró la columna del SKU. Debe llamarse «sku» o «código».')
  if (idx.minimo === undefined && idx.maximo === undefined) bloqueos.push('No se encontró ninguna columna de «mínimo» ni de «máximo».')
  if (tabla.rows.length === 0) bloqueos.push('El archivo no tiene filas de datos, solo cabeceras.')
  if (tabla.rows.length > MAX_FILAS_CSV_UMBRALES) bloqueos.push(`El archivo tiene ${tabla.rows.length} filas y el máximo por importación es ${MAX_FILAS_CSV_UMBRALES}. Pártelo en varios.`)
  if (bloqueos.length > 0) return { filas: [], resumen: { total: 0, ok: 0, error: 0 }, bloqueos, cambios: [] }

  const [productos, variantes, almacenes] = await Promise.all([
    db.product.findMany({ where: { deletedAt: null }, select: { id: true, sku: true } }),
    db.productVariant.findMany({ where: { deletedAt: null, product: { deletedAt: null } }, select: { id: true, sku: true, productId: true } }),
    db.warehouse.findMany({ where: almacenesAlcanzables(ctx), select: { id: true, code: true, name: true } }),
  ])
  const porSkuProducto = new Map(productos.map((p) => [p.sku.toLowerCase(), p]))
  const porSkuVariante = new Map(variantes.map((v) => [v.sku.toLowerCase(), v]))
  const porAlmacen = new Map<string, { id: string; code: string; name: string }>()
  for (const a of almacenes) { porAlmacen.set(a.code.toLowerCase(), a); if (!porAlmacen.has(a.name.toLowerCase())) porAlmacen.set(a.name.toLowerCase(), a) }

  const filas: FilaUmbralCsv[] = []
  const vistos = new Map<string, number>()
  for (const [f, fila] of tabla.rows.entries()) {
    const linea = f + 2
    const errores: string[] = []
    const sku = (fila[idx.sku!] ?? '').trim()
    const almacenTexto = idx.almacen === undefined ? '' : (fila[idx.almacen] ?? '').trim()
    if (!sku) errores.push('Falta el SKU.')

    const delProducto = sku ? porSkuProducto.get(sku.toLowerCase()) : undefined
    const delaVariante = sku ? porSkuVariante.get(sku.toLowerCase()) : undefined
    if (sku && delProducto && delaVariante) errores.push(`El SKU «${sku}» es a la vez de un producto y de una variante: no se sabe a cuál te refieres.`)
    else if (sku && !delProducto && !delaVariante) errores.push(`No existe un producto ni una variante con el SKU «${sku}».`)

    let almacen: { id: string; name: string } | null = null
    if (almacenTexto) {
      almacen = porAlmacen.get(almacenTexto.toLowerCase()) ?? null
      if (!almacen) errores.push(`El almacén «${almacenTexto}» no existe o no es de tus sucursales.`)
    }

    const min = idx.minimo === undefined ? ({ vacia: true } as Celda) : leerCeldaUmbral(fila[idx.minimo])
    const max = idx.maximo === undefined ? ({ vacia: true } as Celda) : leerCeldaUmbral(fila[idx.maximo])
    if ('error' in min) errores.push(`Mínimo: ${min.error}`)
    if ('error' in max) errores.push(`Máximo: ${max.error}`)
    if (!('error' in min) && !('error' in max) && min.vacia && max.vacia) errores.push('No trae ni mínimo ni máximo.')
    if (!('error' in min) && !('error' in max) && !min.vacia && !min.quitar && !max.vacia && !max.quitar && max.valor < min.valor) errores.push('El máximo no puede ser menor que el mínimo.')

    const clave = `${sku.toLowerCase()}|${almacen?.id ?? ''}`
    if (sku && vistos.has(clave)) errores.push(`El SKU «${sku}» se repite para el mismo almacén (ya aparece en la línea ${vistos.get(clave)}).`)
    else if (sku) vistos.set(clave, linea)

    let cambio: CambioUmbralInput | null = null
    if (errores.length === 0) {
      const valor = (c: Celda) => ('error' in c || c.vacia ? undefined : c.quitar ? null : c.valor)
      const productId = (delProducto?.id ?? delaVariante!.productId)
      const variantId = delaVariante?.id ?? null
      cambio = almacen
        ? { nivel: 'ALMACEN', productId, variantId, warehouseId: almacen.id, minimo: valor(min), maximo: valor(max) }
        : variantId
          ? { nivel: 'VARIANTE', productId, variantId, minimo: valor(min), maximo: valor(max) }
          : { nivel: 'PRODUCTO', productId, minimo: valor(min), maximo: valor(max) }
    }
    filas.push({ linea, estado: errores.length > 0 ? 'error' : 'ok', errores, sku, almacen: almacen?.name ?? null, cambio })
  }

  const error = filas.filter((x) => x.estado === 'error').length
  return {
    filas, resumen: { total: filas.length, ok: filas.length - error, error }, bloqueos,
    cambios: error === 0 ? filas.map((x) => x.cambio!).filter(Boolean) : [],
  }
}
