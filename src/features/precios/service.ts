/**
 * Listas de precio y precio por volumen (F6.7a): crear y mantener listas, fijar precios y tramos en lote, asignar la lista de un cliente y cargar los datos que el motor
 * (`pos/precios-reglas.ts`) necesita para resolver un precio. La venta y el POS aún NO lo usan (F6.7b); aquí solo se escribe y se lee.
 *
 * Todo lo que escribe exige `precios.gestionar` (fuera del PIN), es todo o nada y deja UNA fila de auditoría por operación. Los precios incluyen IGV, como `Product.salePrice`.
 * Los costos solo se leen para CONTAR cuántos precios quedarían bajo el costo (nunca se devuelven); la columna de costo de la pantalla existe solo con `productos.ver_costo`.
 */
import { randomUUID } from 'node:crypto'
import { Prisma } from '@/generated/prisma/client'
import { BusinessError } from '@/lib/errors'
import { exigir, puede } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { MAX_LISTAS_POR_NEGOCIO, validarTramos, type DatosDePrecio, type Tramo } from '@/features/pos/precios-reglas'
import {
  asignarListaClienteSchema, crearListaSchema, darDeBajaListaSchema, editarListaSchema, guardarPreciosSchema,
  type AsignarListaClienteInput, type CrearListaInput, type DarDeBajaListaInput, type EditarListaInput, type GuardarPreciosInput, type ListarPreciosInput,
} from './schemas'

const num = (v: unknown) => Number(v ?? 0)
const numONull = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const invalido = (m: string) => new BusinessError('INVALID_DOCUMENT', m)
const noExisteLista = () => new BusinessError('NOT_FOUND', 'La lista de precios no existe o está dada de baja.')
const OPCIONES_TX = { maxWait: 15_000, timeout: 60_000 } as const
const P2002 = 'P2002'
export const TAMANO_PAGINA_PRECIOS = 100

async function auditar(t: TenantPrismaClient, ctx: TenantContext, e: { action: string; entityType: string; entityId: string; before?: object; after?: object }) {
  await t.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: e.action, entityType: e.entityType, entityId: e.entityId,
      ...(e.before ? { before: e.before as never } : {}), ...(e.after ? { after: e.after as never } : {}), impersonationId: ctx.impersonationId ?? null,
    },
  })
}

// ─── Las listas ──────────────────────────────────────────────────────────────────────────────────

export interface ListaDePrecio { id: string; name: string; code: string | null; isActive: boolean; entradas: number; clientes: number }

/** Las listas vivas con cuántos productos y clientes tienen. Exige `precios.gestionar`. */
export async function listarListas(db: TenantPrismaClient, ctx: TenantContext): Promise<ListaDePrecio[]> {
  exigir(ctx, 'precios.gestionar')
  const listas = await db.priceList.findMany({
    where: { deletedAt: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, code: true, isActive: true, _count: { select: { entries: true, customers: true } } },
  })
  return listas.map((l) => ({ id: l.id, name: l.name, code: l.code, isActive: l.isActive, entradas: l._count.entries, clientes: l._count.customers }))
}

/**
 * Las listas que se pueden ELEGIR al vender o cotizar: solo id y nombre (los precios se cargan al buscar el producto). No pide un permiso aparte: quien vende o cotiza las ve todas,
 * y un nombre de lista no es información sensible.
 */
export async function listasParaVender(db: TenantPrismaClient): Promise<{ id: string; name: string }[]> {
  return db.priceList.findMany({ where: { deletedAt: null, isActive: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true, name: true } })
}

function traducir(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === P2002) {
    // Según el adaptador, el índice violado viene en `meta` o solo en el mensaje: se mira todo.
    const destino = `${JSON.stringify(e.meta ?? {})} ${e.message}`
    throw new BusinessError('DUPLICATE_CODE', /_code_|"code"/.test(destino) ? 'Ya hay una lista con ese código.' : 'Ya hay una lista con ese nombre.')
  }
  throw e
}

export async function crearLista(db: TenantPrismaClient, ctx: TenantContext, entrada: CrearListaInput): Promise<{ id: string; name: string }> {
  exigir(ctx, 'precios.gestionar')
  const p = crearListaSchema.safeParse(entrada)
  if (!p.success) throw invalido(p.error.issues[0]?.message ?? 'Revisa los datos.')
  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      const vivas = await t.priceList.count({ where: { deletedAt: null } })
      if (vivas >= MAX_LISTAS_POR_NEGOCIO) throw invalido(`Un negocio admite hasta ${MAX_LISTAS_POR_NEGOCIO} listas de precio. Da de baja alguna para crear otra.`)
      const l = await t.priceList.create({ data: { tenantId: ctx.tenantId, name: p.data.name, code: p.data.code ?? null }, select: { id: true, name: true } })
      await auditar(t, ctx, { action: 'precios.lista_creada', entityType: 'PriceList', entityId: l.id, after: { nombre: l.name, codigo: p.data.code ?? null } })
      return l
    }, OPCIONES_TX)
  } catch (e) { return traducir(e) }
}

export async function editarLista(db: TenantPrismaClient, ctx: TenantContext, entrada: EditarListaInput): Promise<{ id: string }> {
  exigir(ctx, 'precios.gestionar')
  const p = editarListaSchema.safeParse(entrada)
  if (!p.success) throw invalido(p.error.issues[0]?.message ?? 'Revisa los datos.')
  try {
    return await db.$transaction(async (tx) => {
      const t = tx as unknown as TenantPrismaClient
      const antes = await t.priceList.findFirst({ where: { id: p.data.priceListId, deletedAt: null }, select: { id: true, name: true, code: true } })
      if (!antes) throw noExisteLista()
      await t.priceList.update({ where: { id: antes.id }, data: { ...(p.data.name !== undefined ? { name: p.data.name } : {}), ...(p.data.code !== undefined ? { code: p.data.code } : {}) }, select: { id: true } })
      await auditar(t, ctx, { action: 'precios.lista_editada', entityType: 'PriceList', entityId: antes.id, before: { nombre: antes.name, codigo: antes.code }, after: { nombre: p.data.name ?? antes.name, codigo: p.data.code === undefined ? antes.code : p.data.code } })
      return { id: antes.id }
    }, OPCIONES_TX)
  } catch (e) { return traducir(e) }
}

/**
 * Baja LÓGICA: la lista deja de ofrecerse al vender y los clientes que la tenían por defecto se tratan como Base al venderles; sus ventas y cotizaciones pasadas conservan la referencia.
 * Los precios y tramos quedan en la base (no se borran), pero una lista dada de baja no se reactiva: su nombre queda libre para una lista nueva.
 */
export async function darDeBajaLista(db: TenantPrismaClient, ctx: TenantContext, entrada: DarDeBajaListaInput): Promise<{ id: string; clientesAfectados: number }> {
  exigir(ctx, 'precios.gestionar')
  const p = darDeBajaListaSchema.safeParse(entrada)
  if (!p.success) throw invalido(p.error.issues[0]?.message ?? 'Revisa los datos.')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const l = await t.priceList.findFirst({ where: { id: p.data.priceListId, deletedAt: null }, select: { id: true, name: true } })
    if (!l) throw noExisteLista()
    const clientesAfectados = await t.customer.count({ where: { priceListId: l.id } })
    await t.priceList.update({ where: { id: l.id }, data: { isActive: false, deletedAt: new Date() }, select: { id: true } })
    await auditar(t, ctx, { action: 'precios.lista_baja', entityType: 'PriceList', entityId: l.id, before: { nombre: l.name }, after: { clientesAfectados } })
    return { id: l.id, clientesAfectados }
  }, OPCIONES_TX)
}

// ─── Precios y tramos ────────────────────────────────────────────────────────────────────────────

export interface FilaPrecio {
  productId: string
  nombre: string
  sku: string
  unitType: string
  /** El precio Base del producto (con IGV). */
  salePrice: number
  /** La entrada de ESTA lista para el producto; `null` si hereda la Base. En la Base, siempre `null`. */
  entrada: { price: number | null; tiers: Tramo[] } | null
  /** Los tramos de la Base (solo cuando se pide la Base). */
  baseTiers: Tramo[]
  /** SOLO con `productos.ver_costo`: el costo promedio sin IGV. */
  costoUnitario?: number | null
}

export interface PaginaPrecios { filas: FilaPrecio[]; total: number; pagina: number; paginas: number; verCostos: boolean }

/** Una página de productos con sus precios en una lista (o en la Base). Exige `precios.gestionar`; el costo, además, `productos.ver_costo`. */
export async function listarPrecios(db: TenantPrismaClient, ctx: TenantContext, f: ListarPreciosInput): Promise<PaginaPrecios> {
  exigir(ctx, 'precios.gestionar')
  const verCostos = puede(ctx, 'productos.ver_costo')
  if (f.priceListId !== null) {
    const l = await db.priceList.findFirst({ where: { id: f.priceListId, deletedAt: null }, select: { id: true } })
    if (!l) throw noExisteLista()
  }
  const q = f.q?.trim()
  const where = { deletedAt: null, isActive: true, ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { sku: { contains: q, mode: 'insensitive' as const } }, { barcode: { startsWith: q } }] } : {}) }
  const pagina = f.pagina ?? 0
  const [total, productos] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: pagina * TAMANO_PAGINA_PRECIOS, take: TAMANO_PAGINA_PRECIOS,
      select: { id: true, name: true, sku: true, unitType: true, salePrice: true, ...(verCostos ? { costPrice: true } : {}) },
    }),
  ])
  const ids = productos.map((p) => p.id)
  const datos = await cargarDatosDePrecio(db, ids, f.priceListId, { incluirInactivas: true })
  return {
    total, pagina, paginas: Math.ceil(total / TAMANO_PAGINA_PRECIOS), verCostos,
    filas: productos.map((p) => {
      const d = datos.get(p.id)!
      const fila: FilaPrecio = {
        productId: p.id, nombre: p.name, sku: p.sku, unitType: p.unitType, salePrice: num(p.salePrice),
        entrada: d.entrada ? { price: d.entrada.price, tiers: [...d.entrada.tiers] } : null, baseTiers: f.priceListId === null ? [...d.baseTiers] : [],
      }
      if (verCostos) fila.costoUnitario = num((p as { costPrice?: unknown }).costPrice) > 0 ? num((p as { costPrice?: unknown }).costPrice) : null
      return fila
    }),
  }
}

/**
 * Los datos que el motor necesita para resolver el precio de varios productos con UNA lista, en tres consultas. Una lista inexistente, dada de baja o inactiva se trata como la Base
 * (vender nunca se bloquea). Sin permisos: lo usa la venta (F6.7b) en nombre de quien cobra. No lee costos.
 */
export async function cargarDatosDePrecio(
  db: TenantPrismaClient, productIds: readonly string[], priceListId: string | null, opciones: { incluirInactivas?: boolean } = {},
): Promise<Map<string, DatosDePrecio>> {
  const salida = new Map<string, DatosDePrecio>()
  if (productIds.length === 0) return salida
  const ids = [...new Set(productIds)]
  let lista: string | null = null
  if (priceListId) {
    const l = await db.priceList.findFirst({ where: { id: priceListId, deletedAt: null, ...(opciones.incluirInactivas ? {} : { isActive: true }) }, select: { id: true } })
    lista = l?.id ?? null
  }
  const [productos, entradas, tramos] = await Promise.all([
    db.product.findMany({ where: { id: { in: ids } }, select: { id: true, salePrice: true } }),
    lista ? db.priceListEntry.findMany({ where: { priceListId: lista, productId: { in: ids }, ...(opciones.incluirInactivas ? {} : { isActive: true }) }, select: { productId: true, price: true } }) : [],
    db.priceTier.findMany({ where: { productId: { in: ids }, OR: [{ priceListId: null }, ...(lista ? [{ priceListId: lista }] : [])] }, select: { productId: true, priceListId: true, minQuantity: true, unitPrice: true } }),
  ])
  const base = new Map<string, Tramo[]>(), propios = new Map<string, Tramo[]>()
  for (const t of tramos) {
    const destino = t.priceListId === null ? base : propios
    const l = destino.get(t.productId) ?? []
    l.push({ minQuantity: num(t.minQuantity), unitPrice: num(t.unitPrice) })
    destino.set(t.productId, l)
  }
  const entrada = new Map(entradas.map((e) => [e.productId, e]))
  for (const p of productos) {
    const e = entrada.get(p.id)
    salida.set(p.id, { salePrice: num(p.salePrice), baseTiers: base.get(p.id) ?? [], entrada: e ? { price: numONull(e.price), tiers: propios.get(p.id) ?? [] } : null })
  }
  return salida
}

export interface ResultadoPrecios {
  aplicados: number
  sinCambio: number
  /** Cuántos de los precios guardados (planos o de tramo) quedan por debajo del costo promedio: no se podrán vender sin `ventas.bajo_costo`. Solo la cuenta, nunca cifras de costo. */
  bajoCosto: number
}

const mismosTramos = (a: readonly Tramo[], b: readonly Tramo[]) => {
  const k = (t: Tramo) => `${Math.round(t.minQuantity * 1e4)}|${Math.round(t.unitPrice * 1e4)}`
  return a.length === b.length && [...a].map(k).sort().join(',') === [...b].map(k).sort().join(',')
}

/**
 * Escribe precios y tramos en lote, todo o nada. En una lista, un cambio crea la entrada si no existía; en la Base solo se editan tramos (su precio plano es `Product.salePrice`).
 * Valida contra lo que HAY: ningún tramo puede costar más que el plano efectivo de su entrada, aunque el cambio solo toque uno de los dos.
 */
export async function guardarPrecios(db: TenantPrismaClient, ctx: TenantContext, entrada: GuardarPreciosInput): Promise<ResultadoPrecios> {
  exigir(ctx, 'precios.gestionar')
  const p = guardarPreciosSchema.safeParse(entrada)
  if (!p.success) throw invalido(p.error.issues[0]?.message ?? 'Revisa los cambios.')
  const { priceListId, cambios } = p.data

  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    if (priceListId !== null) {
      const l = await t.priceList.findFirst({ where: { id: priceListId, deletedAt: null, isActive: true }, select: { id: true } })
      if (!l) throw noExisteLista()
    }
    const ids = cambios.map((c) => c.productId)
    if (new Set(ids).size !== ids.length) throw invalido('El mismo producto aparece dos veces en el lote.')
    const productos = await t.product.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, name: true, salePrice: true, costPrice: true, taxRate: true } })
    const porId = new Map(productos.map((x) => [x.id, x]))
    const actuales = await cargarDatosDePrecio(t, ids, priceListId, { incluirInactivas: true })

    const antes: object[] = [], despues: object[] = []
    let aplicados = 0, sinCambio = 0, bajoCosto = 0
    for (const [i, c] of cambios.entries()) {
      const prod = porId.get(c.productId)
      if (!prod) throw invalido(`Cambio ${i + 1}: el producto no existe.`)
      const hoy = actuales.get(c.productId)!
      const etiqueta = `«${prod.name}»`

      if (priceListId === null) {
        if (c.eliminar) throw invalido(`${etiqueta}: la Base no tiene entradas que quitar.`)
        if (c.price !== undefined) throw invalido(`${etiqueta}: el precio Base se cambia en el producto, aquí solo se editan sus tramos.`)
      }
      if (c.eliminar) {
        if (!hoy.entrada) { sinCambio++; continue }
        await t.priceListEntry.deleteMany({ where: { priceListId: priceListId!, productId: c.productId } })
        antes.push({ producto: c.productId, precio: hoy.entrada.price, tramos: hoy.entrada.tiers }); despues.push({ producto: c.productId, entrada: null })
        aplicados++
        continue
      }

      const precioActual = priceListId === null ? null : hoy.entrada?.price ?? null
      const tramosActuales = priceListId === null ? hoy.baseTiers : hoy.entrada?.tiers ?? []
      const precioNuevo = priceListId === null ? null : c.price === undefined ? precioActual : c.price
      const tramosNuevos: Tramo[] = c.tiers === undefined ? [...tramosActuales] : c.tiers
      const plano = priceListId === null ? num(prod.salePrice) : precioNuevo ?? num(prod.salePrice)
      const error = validarTramos(tramosNuevos, plano)
      if (error) throw invalido(`${etiqueta}: ${error}`)
      if (priceListId !== null && precioNuevo === null && tramosNuevos.length === 0) throw invalido(`${etiqueta}: la entrada necesita un precio o al menos un tramo. Para volver a la Base, quítala de la lista.`)

      const entradaExiste = hoy.entrada !== null
      if (precioNuevo === precioActual && mismosTramos(tramosNuevos, tramosActuales) && (priceListId === null || entradaExiste)) { sinCambio++; continue }

      if (priceListId !== null) {
        if (entradaExiste) await t.priceListEntry.updateMany({ where: { priceListId, productId: c.productId }, data: { price: precioNuevo } })
        else await t.priceListEntry.create({ data: { tenantId: ctx.tenantId, priceListId, productId: c.productId, price: precioNuevo }, select: { id: true } })
      }
      if (c.tiers !== undefined) {
        await t.priceTier.deleteMany({ where: { priceListId, productId: c.productId } })
        if (tramosNuevos.length > 0) await t.priceTier.createMany({ data: tramosNuevos.map((x) => ({ tenantId: ctx.tenantId, priceListId, productId: c.productId, minQuantity: x.minQuantity, unitPrice: x.unitPrice })) })
      }

      const costo = num(prod.costPrice)
      if (costo > 0) {
        const tasa = num(prod.taxRate)
        const precios = [precioNuevo ?? (priceListId === null ? null : num(prod.salePrice)), ...tramosNuevos.map((x) => x.unitPrice)].filter((x): x is number => x !== null)
        bajoCosto += precios.filter((x) => x / (1 + tasa) < costo - 1e-9).length
      }
      antes.push({ producto: c.productId, precio: precioActual, tramos: tramosActuales }); despues.push({ producto: c.productId, precio: precioNuevo, tramos: tramosNuevos })
      aplicados++
    }

    if (aplicados > 0) {
      await auditar(t, ctx, { action: 'precios.cambio', entityType: 'PriceList', entityId: priceListId ?? randomUUID(), before: { lista: priceListId ?? 'BASE', cambios: antes }, after: { lista: priceListId ?? 'BASE', cambios: despues, aplicados } })
    }
    return { aplicados, sinCambio, bajoCosto }
  }, OPCIONES_TX)
}

// ─── La lista de un cliente ──────────────────────────────────────────────────────────────────────

/** Asigna (o quita, con `null`) la lista de precios por defecto de un cliente. Es un poder de precios, no de clientes: exige `precios.gestionar`. */
export async function asignarListaACliente(db: TenantPrismaClient, ctx: TenantContext, entrada: AsignarListaClienteInput): Promise<{ customerId: string; priceListId: string | null }> {
  exigir(ctx, 'precios.gestionar')
  const p = asignarListaClienteSchema.safeParse(entrada)
  if (!p.success) throw invalido(p.error.issues[0]?.message ?? 'Revisa los datos.')
  return db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const c = await t.customer.findFirst({ where: { id: p.data.customerId, deletedAt: null }, select: { id: true, name: true, priceListId: true } })
    if (!c) throw new BusinessError('NOT_FOUND', 'El cliente no existe.')
    if (p.data.priceListId !== null) {
      const l = await t.priceList.findFirst({ where: { id: p.data.priceListId, deletedAt: null, isActive: true }, select: { id: true } })
      if (!l) throw noExisteLista()
    }
    if (c.priceListId === p.data.priceListId) return { customerId: c.id, priceListId: c.priceListId }
    await t.customer.update({ where: { id: c.id }, data: { priceListId: p.data.priceListId }, select: { id: true } })
    await auditar(t, ctx, { action: 'precios.cliente_lista', entityType: 'Customer', entityId: c.id, before: { lista: c.priceListId }, after: { lista: p.data.priceListId, cliente: c.name } })
    return { customerId: c.id, priceListId: p.data.priceListId }
  }, OPCIONES_TX)
}
