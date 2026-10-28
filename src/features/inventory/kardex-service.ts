import { BusinessError } from '@/lib/errors'
import { exigir, puede } from '@/lib/puede'
import { medianoche } from '@/lib/periodos'
import { generarCsv, type CeldaCsv } from '@/lib/csv-export'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { hoyEnZona, sumarDias } from '@/features/credito/reglas'
import { puedeVerVentas } from '@/features/ventas/permisos'
import { puedeVerProveedores } from '@/features/proveedores/permisos'
import { DIAS_MAXIMOS_KARDEX, TOPE_FILAS_CSV_KARDEX, type KardexCsvParams, type KardexParams } from './kardex-schemas'

/**
 * Kardex de un producto (F6.4b): cada movimiento de stock, en orden, con su saldo y —solo para quien ve costos— su valor y el saldo valorizado.
 * SOLO LECTURA (la exportación añade una línea de auditoría).
 *
 * ─── SEGURIDAD DE COSTOS ─────────────────────────────────────────────────
 *  · `kardex.ver` da el kardex en UNIDADES. Los costos son `productos.ver_costo` y nada más: un permiso = un poder, nunca los dos a la vez.
 *  · Sin `productos.ver_costo` el servidor NI LEE las columnas de costo (`unitCostApplied`, `costAfter`, `costOrigin`, `costPending`, `Product.costPrice`)
 *    NI las manda: no están en el `select`, no hay clave `costos` en las líneas ni en los totales. No es un campo vacío: no existe.
 *
 * ─── CÓMO SE CALCULA EL SALDO ────────────────────────────────────────────
 *  · Cada movimiento trae `balanceAfter` de SU fila de stock (almacén + variante). El saldo de la consulta es la SUMA de las filas que entran:
 *    saldo inicial = Σ del último `balanceAfter` de cada fila antes de `desde`; cada línea suma su cantidad. Con una sola fila el saldo de la línea
 *    es exactamente su `balanceAfter` (y si no, se marca `descuadre`).
 *  · La paginación es por cursor (`createdAt`, `id`): el saldo de una página se arranca con una suma, no leyendo las anteriores.
 *  · El saldo final por movimientos se compara con el saldo final por `balanceAfter` (integridad del libro) y, si no hay movimientos posteriores, con `Stock.quantity`.
 */

const num = (d: { toString(): string } | null | undefined): number => Number(d?.toString() ?? 0)
const r4 = (n: number): number => Math.round(n * 10_000) / 10_000
const r2 = (n: number): number => Math.round(n * 100) / 100
const TOL = 0.0001
const LOTE_CSV = 1000

export type OrigenCostoKardex = 'EXACTO' | 'RECONSTRUIDO' | 'SIN_DATO'
export type TipoDocumentoKardex = 'VENTA' | 'COMPRA' | 'DEVOLUCION' | 'TRANSFERENCIA' | 'MERMA' | 'MANUAL'

export interface DocumentoKardex {
  tipo: TipoDocumentoKardex
  /** Número del documento; `null` si no hay (movimiento manual) o si esta persona no tiene permiso para ver ese documento. */
  numero: string | null
  /** Enlace a la pantalla del documento; `null` si no existe pantalla, no se encontró o no hay permiso. */
  href: string | null
}

export interface CostosLinea {
  /** Costo por unidad base con el que se valoró el movimiento (`null` si se desconoce: entrada con costo pendiente o sin dato). */
  costoUnitario: number | null
  /** Con signo: positivo entra, negativo sale. */
  valor: number | null
  /** Costo promedio vigente del producto justo después del movimiento. */
  costoPromedio: number | null
  saldoValorizado: number | null
  origen: OrigenCostoKardex
  pendiente: boolean
}

export interface LineaKardex {
  id: string
  cuando: string
  tipo: string
  origen: string
  almacen: { id: string; nombre: string }
  entrada: number
  salida: number
  /** Saldo de la consulta tras este movimiento (suma de las filas de stock que entran). */
  saldo: number
  /** El stock de SU almacén (y variante) tras el movimiento, tal como lo confirmó la base. */
  saldoAlmacen: number
  /** Solo cuando la consulta es de UNA fila de stock: el saldo de la línea no coincide con el de la base (el libro está roto). */
  descuadre: boolean
  stockNegativo: boolean
  motivo: string | null
  usuario: string | null
  presentacion: { nombre: string; cantidad: number; factor: number } | null
  documento: DocumentoKardex
  /** AUSENTE (no vacía) si quien consulta no tiene `productos.ver_costo`. */
  costos?: CostosLinea
}

export interface AlertaKardex { codigo: 'STOCK_NEGATIVO' | 'NO_CUADRA' | 'LIBRO_INCONSISTENTE' | 'COSTO_PENDIENTE' | 'SIN_COSTO'; mensaje: string; cantidad?: number }

export interface SaldoKardex {
  cantidad: number
  /** AUSENTE sin `productos.ver_costo`. */
  costos?: { costoPromedio: number | null; valorizado: number | null; origen: OrigenCostoKardex | null }
}

export interface KardexResultado {
  producto: { id: string; nombre: string; sku: string; unidad: string; controlaStock: boolean; costoActual?: number }
  almacenes: { id: string; nombre: string }[]
  /** El almacén elegido; `null` = todos los que esta persona alcanza. */
  almacenElegido: string | null
  variante: string | null
  desde: string
  hasta: string
  zonaHoraria: string
  conCostos: boolean
  saldoInicial: SaldoKardex
  lineas: LineaKardex[]
  /** Cursor de la página siguiente; `null` si no hay más. */
  siguiente: string | null
  totales: {
    movimientos: number
    entradas: number
    salidas: number
    /** Saldo final por `balanceAfter` (el dato firme de la base). */
    saldoFinal: number
    /** Saldo final por movimientos (saldo inicial + entradas − salidas); debe coincidir con `saldoFinal`. */
    saldoPorMovimientos: number
    consistente: boolean
    stockActual: number
    /** `null` si hay movimientos posteriores al rango (el stock de hoy no es comparable con el de `hasta`). */
    cuadraConStock: boolean | null
    costos?: { saldoFinalValorizado: number | null; costoPromedio: number | null }
  }
  alertas: AlertaKardex[]
}

// ─── Parámetros: rango, cursor ─────────────────────────────────────────────────────────────────────────────────────

const iso = (d: Date): string => d.toISOString().slice(0, 10)
const invalido = (m: string) => new BusinessError('INVALID_DOCUMENT', m)

export interface RangoKardex { desde: string; hasta: string; desdeInst: Date; hastaInst: Date }

/** Sin fechas: los últimos 30 días (hoy incluido) en el día del negocio. Máximo 12 meses. `hasta` incluye todo ese día. */
export function resolverRangoKardex(zona: string, p: { desde?: string; hasta?: string }, ahora: Date = new Date()): RangoKardex {
  const hasta = p.hasta ?? hoyEnZona(zona, ahora)
  const desde = p.desde ?? iso(sumarDias(hasta, -29))
  if (desde > hasta) throw invalido('La fecha inicial no puede ser posterior a la final.')
  const dias = Math.round((sumarDias(hasta, 0).getTime() - sumarDias(desde, 0).getTime()) / 86_400_000) + 1
  if (dias > DIAS_MAXIMOS_KARDEX) throw invalido('El rango es demasiado largo: el máximo es de 12 meses por consulta.')
  const [y, m, d] = desde.split('-').map(Number) as [number, number, number]
  const sig = iso(sumarDias(hasta, 1)).split('-').map(Number) as [number, number, number]
  return { desde, hasta, desdeInst: medianoche(zona, y, m, d), hastaInst: medianoche(zona, sig[0], sig[1], sig[2]) }
}

interface Cursor { t: Date; i: string }
export const codificarCursor = (c: Cursor): string => Buffer.from(JSON.stringify({ t: c.t.toISOString(), i: c.i })).toString('base64url')
export function decodificarCursor(texto: string): Cursor {
  try {
    const o = JSON.parse(Buffer.from(texto, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown }
    const t = typeof o.t === 'string' ? new Date(o.t) : null
    if (!t || Number.isNaN(t.getTime()) || typeof o.i !== 'string' || o.i.length === 0 || o.i.length > 64) throw new Error('forma')
    return { t, i: o.i }
  } catch {
    throw invalido('El cursor de la página no es válido. Vuelve a cargar el kardex.')
  }
}

// ─── Alcance ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Los almacenes de las sucursales que esta persona alcanza (todos si no tiene acotado). Incluye los dados de baja: su historia sigue siendo historia. */
export async function almacenesDelKardex(db: TenantPrismaClient, ctx: TenantContext): Promise<{ id: string; nombre: string }[]> {
  exigir(ctx, 'kardex.ver')
  const filas = await db.warehouse.findMany({ where: ctx.branchIds ? { branchId: { in: [...ctx.branchIds] } } : {}, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
  return filas.map((w) => ({ id: w.id, nombre: w.name }))
}

interface Contexto {
  producto: { id: string; name: string; sku: string; unitType: string; trackStock: boolean; costPrice?: unknown }
  almacenes: { id: string; nombre: string }[]
  almacenIds: string[]
  nombreAlmacen: Map<string, string>
  where: { productId: string; warehouseId: { in: string[] }; variantId?: string }
  rango: RangoKardex
  zona: string
  conCostos: boolean
  filas: { warehouseId: string; variantId: string | null }[]
}

async function prepararContexto(db: TenantPrismaClient, ctx: TenantContext, p: { productId: string; warehouseId?: string; variantId?: string; desde?: string; hasta?: string }): Promise<Contexto> {
  exigir(ctx, 'kardex.ver')
  const conCostos = puede(ctx, 'productos.ver_costo')
  const tenant = await db.tenant.findFirstOrThrow({ select: { timezone: true } })
  const rango = resolverRangoKardex(tenant.timezone, p)

  const producto = await db.product.findFirst({ where: { id: p.productId }, select: { id: true, name: true, sku: true, unitType: true, trackStock: true, ...(conCostos ? { costPrice: true } : {}) } })
  if (!producto) throw new BusinessError('NOT_FOUND', 'El producto no existe.')

  const almacenes = await almacenesDelKardex(db, ctx)
  if (p.warehouseId && !almacenes.some((a) => a.id === p.warehouseId)) throw new BusinessError('NOT_FOUND', 'El almacén no existe o no es de tus sucursales.')
  const almacenIds = p.warehouseId ? [p.warehouseId] : almacenes.map((a) => a.id)
  if (p.variantId) {
    const v = await db.productVariant.findFirst({ where: { id: p.variantId, productId: p.productId }, select: { id: true } })
    if (!v) throw new BusinessError('NOT_FOUND', 'La variante no existe en este producto.')
  }
  const where = { productId: p.productId, warehouseId: { in: almacenIds }, ...(p.variantId ? { variantId: p.variantId } : {}) }
  const filas = await db.stock.findMany({ where, select: { warehouseId: true, variantId: true }, orderBy: [{ warehouseId: 'asc' }, { variantId: 'asc' }] })
  return { producto, almacenes, almacenIds, nombreAlmacen: new Map(almacenes.map((a) => [a.id, a.nombre])), where, rango, zona: tenant.timezone, conCostos, filas }
}

// ─── Saldos ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Saldo (suma de las filas de stock) justo ANTES de `instante`, por el `balanceAfter` del último movimiento de cada fila. */
async function saldoAntesDe(db: TenantPrismaClient, c: Contexto, instante: Date): Promise<number> {
  let suma = 0
  for (const f of c.filas) {
    const ultimo = await db.stockMovement.findFirst({
      where: { ...c.where, warehouseId: f.warehouseId, variantId: f.variantId, createdAt: { lt: instante } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { balanceAfter: true },
    })
    if (ultimo) suma += num(ultimo.balanceAfter)
  }
  return r4(suma)
}

/** El último costo promedio CONOCIDO del producto antes de `instante` (en cualquier almacén: el costo es del producto). Solo con `productos.ver_costo`. */
async function costoAntesDe(db: TenantPrismaClient, productId: string, instante: Date): Promise<{ costoPromedio: number; origen: OrigenCostoKardex } | null> {
  const m = await db.stockMovement.findFirst({
    where: { productId, createdAt: { lt: instante }, costOrigin: { not: 'SIN_DATO' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { costAfter: true, costOrigin: true },
  })
  return m && m.costAfter !== null ? { costoPromedio: num(m.costAfter), origen: m.costOrigin } : null
}

const rangoWhere = (c: Contexto) => ({ createdAt: { gte: c.rango.desdeInst, lt: c.rango.hastaInst } })

// ─── Documentos ────────────────────────────────────────────────────────────────────────────────────────────────────

interface FilaBase { id: string; type: string; reason: string | null; referenceType: string | null; referenceId: string | null }
const REF_TRANSFERENCIA = /^Transferencia (\S+)/

/** Resuelve de cada movimiento su documento origen, respetando el permiso de ver ese documento. Una consulta por tipo, no por línea. */
async function resolverDocumentos(db: TenantPrismaClient, ctx: TenantContext, filas: readonly FilaBase[]): Promise<Map<string, DocumentoKardex>> {
  const verVentas = puedeVerVentas(ctx), verCompras = puedeVerProveedores(ctx)
  const ids = (ref: string) => [...new Set(filas.filter((f) => f.referenceType === ref && f.referenceId).map((f) => f.referenceId!))]
  const ventaIds = verVentas ? ids('VENTA') : [], compraIds = verCompras ? ids('COMPRA') : [], devolIds = verVentas ? ids('DEVOLUCION') : []
  const numerosTransf = [...new Set(filas.filter((f) => f.type.startsWith('TRANSFERENCIA')).map((f) => REF_TRANSFERENCIA.exec(f.reason ?? '')?.[1]).filter((x): x is string => !!x))]

  const [ventas, compras, devoluciones, transferencias] = await Promise.all([
    ventaIds.length ? db.sale.findMany({ where: { id: { in: ventaIds } }, select: { id: true, number: true } }) : [],
    compraIds.length ? db.purchase.findMany({ where: { id: { in: compraIds } }, select: { id: true, number: true } }) : [],
    devolIds.length ? db.saleReturn.findMany({ where: { id: { in: devolIds } }, select: { id: true, number: true, saleId: true } }) : [],
    numerosTransf.length ? db.branchTransfer.findMany({ where: { number: { in: numerosTransf } }, select: { number: true } }) : [],
  ])
  const vm = new Map(ventas.map((v) => [v.id, v])), cm = new Map(compras.map((x) => [x.id, x])), dm = new Map(devoluciones.map((x) => [x.id, x])), tm = new Set(transferencias.map((x) => x.number))

  const out = new Map<string, DocumentoKardex>()
  for (const f of filas) {
    let doc: DocumentoKardex
    if (f.referenceType === 'VENTA') { const v = f.referenceId ? vm.get(f.referenceId) : undefined; doc = { tipo: 'VENTA', numero: v?.number ?? null, href: v ? `/ventas/${v.id}` : null } }
    else if (f.referenceType === 'COMPRA') { const x = f.referenceId ? cm.get(f.referenceId) : undefined; doc = { tipo: 'COMPRA', numero: x?.number ?? null, href: x ? `/compras/${x.id}` : null } }
    else if (f.referenceType === 'DEVOLUCION') { const x = f.referenceId ? dm.get(f.referenceId) : undefined; doc = { tipo: 'DEVOLUCION', numero: x?.number ?? null, href: x ? `/ventas/${x.saleId}` : null } }
    else if (f.type === 'MERMA') doc = { tipo: 'MERMA', numero: null, href: null }
    else if (f.type.startsWith('TRANSFERENCIA')) { const n = REF_TRANSFERENCIA.exec(f.reason ?? '')?.[1]; doc = { tipo: 'TRANSFERENCIA', numero: n && tm.has(n) ? n : null, href: null } }
    else doc = { tipo: 'MANUAL', numero: null, href: null }
    out.set(f.id, doc)
  }
  return out
}

// ─── Búsqueda de producto ──────────────────────────────────────────────────────────────────────────────────────────

export interface ProductoKardex { id: string; nombre: string; sku: string; codigo: string | null; unidad: string }
const MAX_CANDIDATOS = 20

/** Los productos que coinciden con lo tecleado (nombre, SKU o código de barras), para elegir de quién ver el kardex. Solo los que llevan control de stock. */
export async function buscarProductosKardex(db: TenantPrismaClient, ctx: TenantContext, texto: string): Promise<ProductoKardex[]> {
  exigir(ctx, 'kardex.ver')
  const q = texto.trim().slice(0, 80)
  if (q.length < 2) return []
  const filas = await db.product.findMany({
    where: { trackStock: true, deletedAt: null, OR: [{ name: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }, { barcode: { contains: q } }] },
    select: { id: true, name: true, sku: true, barcode: true, unitType: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: MAX_CANDIDATOS,
  })
  return filas.map((p) => ({ id: p.id, nombre: p.name, sku: p.sku, codigo: p.barcode, unidad: p.unitType }))
}

// ─── Lectura ───────────────────────────────────────────────────────────────────────────────────────────────────────

function selectLineas(conCostos: boolean) {
  return {
    id: true, createdAt: true, type: true, source: true, quantity: true, balanceAfter: true, warehouseId: true, reason: true, referenceType: true, referenceId: true,
    enteredQuantity: true, presentationFactor: true, presentation: { select: { name: true } }, user: { select: { name: true, email: true } },
    ...(conCostos ? { unitCostApplied: true, costAfter: true, costOrigin: true, costPending: true } : {}),
  }
}

type FilaLinea = {
  id: string; createdAt: Date; type: string; source: string; quantity: { toString(): string }; balanceAfter: { toString(): string }; warehouseId: string; reason: string | null
  referenceType: string | null; referenceId: string | null; enteredQuantity: { toString(): string } | null; presentationFactor: { toString(): string } | null
  presentation: { name: string } | null; user: { name: string | null; email: string }
  unitCostApplied?: { toString(): string } | null; costAfter?: { toString(): string } | null; costOrigin?: OrigenCostoKardex; costPending?: boolean
}

/** Convierte una tanda de movimientos (ya en orden) en líneas, arrancando el saldo en `saldoPrevio`. */
async function armarLineas(db: TenantPrismaClient, ctx: TenantContext, c: Contexto, filas: readonly FilaLinea[], saldoPrevio: number): Promise<LineaKardex[]> {
  const docs = await resolverDocumentos(db, ctx, filas)
  const unaFila = c.filas.length === 1
  let saldo = saldoPrevio
  return filas.map((f): LineaKardex => {
    const q = num(f.quantity)
    saldo = r4(saldo + q)
    const saldoAlmacen = num(f.balanceAfter)
    const linea: LineaKardex = {
      id: f.id, cuando: f.createdAt.toISOString(), tipo: f.type, origen: f.source,
      almacen: { id: f.warehouseId, nombre: c.nombreAlmacen.get(f.warehouseId) ?? '—' },
      entrada: q > 0 ? q : 0, salida: q < 0 ? -q : 0, saldo, saldoAlmacen,
      descuadre: unaFila && Math.abs(saldo - saldoAlmacen) > TOL, stockNegativo: saldoAlmacen < 0,
      motivo: f.reason, usuario: f.user.name ?? f.user.email,
      presentacion: f.presentation && f.enteredQuantity !== null && f.presentationFactor !== null ? { nombre: f.presentation.name, cantidad: num(f.enteredQuantity), factor: num(f.presentationFactor) } : null,
      documento: docs.get(f.id)!,
    }
    if (c.conCostos) {
      const uc = f.unitCostApplied === null || f.unitCostApplied === undefined ? null : num(f.unitCostApplied)
      const ca = f.costAfter === null || f.costAfter === undefined ? null : num(f.costAfter)
      linea.costos = { costoUnitario: uc, valor: uc === null ? null : r2(q * uc), costoPromedio: ca, saldoValorizado: ca === null ? null : r2(saldo * ca), origen: f.costOrigin ?? 'SIN_DATO', pendiente: f.costPending ?? false }
    }
    return linea
  })
}

export async function kardexDeProducto(db: TenantPrismaClient, ctx: TenantContext, p: KardexParams): Promise<KardexResultado> {
  const c = await prepararContexto(db, ctx, p)
  const { rango } = c

  const saldoIni = await saldoAntesDe(db, c, rango.desdeInst)
  const costoIni = c.conCostos ? await costoAntesDe(db, p.productId, rango.desdeInst) : null

  // Página: del cursor en adelante, en orden cronológico.
  const cursor = p.cursor ? decodificarCursor(p.cursor) : null
  const despuesDelCursor = cursor ? { OR: [{ createdAt: { gt: cursor.t } }, { createdAt: cursor.t, id: { gt: cursor.i } }] } : {}
  const limite = p.limite ?? 50
  const pagina = (await db.stockMovement.findMany({
    where: { ...c.where, AND: [rangoWhere(c), despuesDelCursor] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limite + 1, select: selectLineas(c.conCostos),
  })) as unknown as FilaLinea[]
  const hayMas = pagina.length > limite
  const filas = hayMas ? pagina.slice(0, limite) : pagina

  // El saldo con que arranca la página: el inicial más todo lo que ya pasó dentro del rango hasta el cursor (inclusive).
  let saldoPrevio = saldoIni
  if (cursor) {
    const previo = await db.stockMovement.aggregate({
      where: { ...c.where, AND: [rangoWhere(c), { OR: [{ createdAt: { lt: cursor.t } }, { createdAt: cursor.t, id: { lte: cursor.i } }] }] },
      _sum: { quantity: true },
    })
    saldoPrevio = r4(saldoIni + num(previo._sum.quantity))
  }
  const lineas = await armarLineas(db, ctx, c, filas, saldoPrevio)
  const ultima = filas[filas.length - 1]

  // Totales de TODO el rango (no solo de la página).
  const [entr, sal, cantidadMov, negativos, saldoFinal, posteriores, stockAgg] = await Promise.all([
    db.stockMovement.aggregate({ where: { ...c.where, ...rangoWhere(c), quantity: { gt: 0 } }, _sum: { quantity: true } }),
    db.stockMovement.aggregate({ where: { ...c.where, ...rangoWhere(c), quantity: { lt: 0 } }, _sum: { quantity: true } }),
    db.stockMovement.count({ where: { ...c.where, ...rangoWhere(c) } }),
    db.stockMovement.count({ where: { ...c.where, ...rangoWhere(c), balanceAfter: { lt: 0 } } }),
    saldoAntesDe(db, c, rango.hastaInst),
    db.stockMovement.count({ where: { ...c.where, createdAt: { gte: rango.hastaInst } } }),
    db.stock.aggregate({ where: c.where, _sum: { quantity: true } }),
  ])
  const entradas = r4(num(entr._sum.quantity)), salidas = r4(-num(sal._sum.quantity))
  const porMovimientos = r4(saldoIni + entradas - salidas)
  const consistente = Math.abs(porMovimientos - saldoFinal) <= TOL
  const stockActual = r4(num(stockAgg._sum.quantity))
  const cuadraConStock = posteriores > 0 ? null : Math.abs(saldoFinal - stockActual) <= TOL

  const alertas: AlertaKardex[] = []
  if (negativos > 0) alertas.push({ codigo: 'STOCK_NEGATIVO', mensaje: `${negativos} movimiento(s) dejaron el stock en negativo.`, cantidad: negativos })
  if (cuadraConStock === false) alertas.push({ codigo: 'NO_CUADRA', mensaje: `El saldo final del kardex (${saldoFinal}) no coincide con el stock actual (${stockActual}).` })
  if (!consistente) alertas.push({ codigo: 'LIBRO_INCONSISTENTE', mensaje: 'La suma de los movimientos no coincide con los saldos registrados: hay que revisar este producto.' })

  let costosTotales: KardexResultado['totales']['costos']
  let saldoInicialCostos: SaldoKardex['costos']
  if (c.conCostos) {
    const [pendientes, sinDato, costoFin] = await Promise.all([
      db.stockMovement.count({ where: { ...c.where, ...rangoWhere(c), costPending: true } }),
      db.stockMovement.count({ where: { ...c.where, ...rangoWhere(c), costOrigin: 'SIN_DATO' } }),
      costoAntesDe(db, p.productId, rango.hastaInst),
    ])
    if (pendientes > 0) alertas.push({ codigo: 'COSTO_PENDIENTE', mensaje: `${pendientes} entrada(s) esperan que se les complete el costo.`, cantidad: pendientes })
    if (sinDato > 0) alertas.push({ codigo: 'SIN_COSTO', mensaje: `${sinDato} movimiento(s) no tienen costo conocido (anteriores al kardex valorizado).`, cantidad: sinDato })
    costosTotales = { costoPromedio: costoFin?.costoPromedio ?? null, saldoFinalValorizado: costoFin ? r2(saldoFinal * costoFin.costoPromedio) : null }
    saldoInicialCostos = { costoPromedio: costoIni?.costoPromedio ?? null, valorizado: costoIni ? r2(saldoIni * costoIni.costoPromedio) : null, origen: costoIni?.origen ?? null }
  }

  return {
    producto: { id: c.producto.id, nombre: c.producto.name, sku: c.producto.sku, unidad: c.producto.unitType, controlaStock: c.producto.trackStock, ...(c.conCostos ? { costoActual: num(c.producto.costPrice as { toString(): string }) } : {}) },
    almacenes: c.almacenes, almacenElegido: p.warehouseId ?? null, variante: p.variantId ?? null,
    desde: rango.desde, hasta: rango.hasta, zonaHoraria: c.zona, conCostos: c.conCostos,
    saldoInicial: { cantidad: saldoIni, ...(saldoInicialCostos ? { costos: saldoInicialCostos } : {}) },
    lineas, siguiente: hayMas && ultima ? codificarCursor({ t: ultima.createdAt, i: ultima.id }) : null,
    totales: { movimientos: cantidadMov, entradas, salidas, saldoFinal, saldoPorMovimientos: porMovimientos, consistente, stockActual, cuadraConStock, ...(costosTotales ? { costos: costosTotales } : {}) },
    alertas,
  }
}

// ─── Exportación a CSV ─────────────────────────────────────────────────────────────────────────────────────────────

const hora = (iso: string, zona: string) => new Date(iso).toLocaleString('sv-SE', { timeZone: zona })
const NOMBRE_DOC: Record<TipoDocumentoKardex, string> = { VENTA: 'Venta', COMPRA: 'Compra', DEVOLUCION: 'Devolución', TRANSFERENCIA: 'Transferencia', MERMA: 'Merma', MANUAL: 'Manual' }

/**
 * El kardex del rango completo en CSV (Excel es-PE), con las MISMAS reglas de costos que la lectura. Si el rango trae más de 50.000 movimientos, no
 * corta en silencio: pide acortarlo. Deja una línea de auditoría.
 */
export async function exportarKardexCsv(db: TenantPrismaClient, ctx: TenantContext, p: KardexCsvParams): Promise<{ nombre: string; contenido: string; filas: number }> {
  const c = await prepararContexto(db, ctx, p)
  const { rango } = c
  const total = await db.stockMovement.count({ where: { ...c.where, ...rangoWhere(c) } })
  if (total > TOPE_FILAS_CSV_KARDEX) {
    throw invalido(`El rango tiene ${total} movimientos y el máximo de una exportación es ${TOPE_FILAS_CSV_KARDEX}. Acórtalo por fechas o por almacén.`)
  }
  const saldoIni = await saldoAntesDe(db, c, rango.desdeInst)
  const costoIni = c.conCostos ? await costoAntesDe(db, p.productId, rango.desdeInst) : null

  const cabecera = ['Fecha', 'Almacén', 'Tipo', 'Origen', 'Documento', 'N.º documento', 'Motivo', 'Usuario', 'Entrada', 'Salida', 'Saldo', 'Stock negativo']
  if (c.conCostos) cabecera.push('Costo unitario', 'Valor', 'Costo promedio', 'Saldo valorizado', 'Origen del costo', 'Costo pendiente')
  const vacioCostos = c.conCostos ? [null, null, null, null, null, null] : []
  const filas: CeldaCsv[][] = [[`Saldo inicial al ${rango.desde}`, '', '', '', '', '', '', '', null, null, saldoIni, '',
    ...(c.conCostos ? [null, null, costoIni ? { monto: costoIni.costoPromedio } : null, costoIni ? { monto: r2(saldoIni * costoIni.costoPromedio) } : null, costoIni?.origen ?? '', ''] : [])]]

  let cursor: Cursor | null = null
  let saldo = saldoIni
  let entradas = 0, salidas = 0
  for (;;) {
    const despues: object = cursor ? { OR: [{ createdAt: { gt: cursor.t } }, { createdAt: cursor.t, id: { gt: cursor.i } }] } : {}
    const tanda = (await db.stockMovement.findMany({
      where: { ...c.where, AND: [rangoWhere(c), despues] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: LOTE_CSV, select: selectLineas(c.conCostos),
    })) as unknown as FilaLinea[]
    if (tanda.length === 0) break
    for (const l of await armarLineas(db, ctx, c, tanda, saldo)) {
      saldo = l.saldo; entradas += l.entrada; salidas += l.salida
      filas.push([
        hora(l.cuando, c.zona), l.almacen.nombre, l.tipo, l.origen, NOMBRE_DOC[l.documento.tipo], l.documento.numero ?? '', l.motivo ?? '', l.usuario ?? '',
        l.entrada || null, l.salida || null, l.saldo, l.stockNegativo ? 'SÍ' : '',
        ...(l.costos ? [
          l.costos.costoUnitario === null ? null : { monto: l.costos.costoUnitario }, l.costos.valor === null ? null : { monto: l.costos.valor },
          l.costos.costoPromedio === null ? null : { monto: l.costos.costoPromedio }, l.costos.saldoValorizado === null ? null : { monto: l.costos.saldoValorizado },
          l.costos.origen, l.costos.pendiente ? 'SÍ' : '',
        ] : vacioCostos),
      ])
    }
    const ultima = tanda[tanda.length - 1]!
    cursor = { t: ultima.createdAt, i: ultima.id }
    if (tanda.length < LOTE_CSV) break
  }
  filas.push([`Totales ${rango.desde} a ${rango.hasta}`, '', '', '', '', '', '', '', r4(entradas), r4(salidas), r4(saldo), '', ...vacioCostos])

  await db.auditLog.create({
    data: {
      tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'reporte.exportado', entityType: 'Reporte', entityId: 'kardex',
      after: { reporte: 'kardex', producto: p.productId, almacen: p.warehouseId ?? null, desde: rango.desde, hasta: rango.hasta, filas: total, conCostos: c.conCostos } as never,
      impersonationId: ctx.impersonationId ?? null,
    },
  })
  const nombre = `kardex-${c.producto.sku}-${rango.desde}_${rango.hasta}.csv`
  return { nombre, contenido: generarCsv(cabecera, filas), filas: total }
}
