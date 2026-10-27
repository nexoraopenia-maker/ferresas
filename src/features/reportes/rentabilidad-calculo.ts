import { redondearCentimos } from '@/lib/dinero'
import { totalDeLinea } from '@/features/compras/costo'

/**
 * Margen por producto, inventario valorizado y análisis ABC, como funciones PURAS sobre filas ya leídas. Todo en céntimos enteros.
 *
 * ─── LA REGLA QUE MANDA: EL COSTO CERO ES «NO SÉ», NUNCA «GRATIS» ───────────────────────────────────────────────────────────────
 * Un producto nace con costo 0 y una entrada sin costo queda «pendiente»: ese 0 significa «todavía no se sabe lo que costó». Si se
 * tomara por un costo real, la utilidad de esa venta sería el 100 % del precio y el margen del producto —y del negocio— se dispararía.
 * Por eso una línea sin costo NO entra al cálculo del margen: ni su venta ni su costo. Se muestra APARTE y la **cobertura** (qué parte de
 * lo vendido tiene costo) acompaña a TODO margen. Un producto sin ninguna línea con costo no tiene margen («—»), nunca un 100 %.
 *
 * ─── DEFINICIONES ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
 *  · VENTA NETA: el total de la línea (que lleva IGV: el precio de venta se muestra con IGV incluido) sin el IGV, con la MISMA cuenta que
 *    hace el POS al vender (`redondearCentimos(total / (1 + tasa))`). Así la suma de las ventas netas coincide al céntimo con el
 *    subtotal de las ventas. El costo es sin IGV (crédito fiscal), por eso se compara contra la venta neta y no contra el total.
 *  · COSTO DE LA LÍNEA: cantidad vendida (unidad base) × costo unitario con el que se vendió, a céntimos exactos.
 *  · UTILIDAD = venta neta con costo − costo. MARGEN % = utilidad / venta neta con costo (sobre ventas, no sobre costo).
 *  · COBERTURA % = venta neta con costo / venta neta total.
 */

const c = (n: number) => Math.round(n * 100)
const s = (cent: number) => cent / 100
/** Porcentaje con dos decimales sobre céntimos. 0 si no hay base. */
const pct = (parteC: number, totalC: number) => (totalC > 0 ? Math.round((parteC * 10_000) / totalC) / 100 : 0)
const orden = new Intl.Collator('es', { sensitivity: 'base', numeric: true })

// ─── Margen por producto ────────────────────────────────────────────────────────────────────────────────────────────

export interface LineaVentaCosto {
  productId: string
  nombre: string
  sku: string
  unidad: string
  /** En la unidad base del producto. */
  cantidad: number
  /** Costo unitario con el que se vendió, SIN IGV. 0 = no se conocía. */
  costoUnitario: number
  /** Total de la línea, con IGV. */
  totalConIgv: number
  /** 0.18, 0… */
  tasaIgv: number
}

/** Venta neta de IGV de una línea, en SOLES: exactamente la cuenta del POS. */
export const ventaSinIgvDeLinea = (totalConIgv: number, tasaIgv: number): number => redondearCentimos(totalConIgv / (1 + tasaIgv))

export interface FilaMargen {
  productId: string
  nombre: string
  sku: string
  unidad: string
  unidades: number
  lineas: number
  lineasSinCosto: number
  ventaSinIgv: number
  ventaConCosto: number
  ventaSinCosto: number
  costo: number
  utilidad: number
  /** `null` si ninguna venta del producto tiene costo: no hay margen que mostrar. */
  margen: number | null
  cobertura: number
}

export interface TotalesMargen extends Omit<FilaMargen, 'productId' | 'nombre' | 'sku' | 'unidad' | 'unidades'> { productos: number; productosSinCostoAlguno: number }
export interface Margenes {
  filas: FilaMargen[]
  totales: TotalesMargen
  /** Los productos con ventas sin costo, de más a menos importe: lo que hay que completar. */
  sinCosto: FilaMargen[]
}

interface Acc { nombre: string; sku: string; unidad: string; q: number; n: number; nSin: number; venta: number; ventaCon: number; ventaSin: number; costo: number }

function filaDe(productId: string, a: Acc): FilaMargen {
  const utilidadC = a.ventaCon - a.costo
  return {
    productId, nombre: a.nombre, sku: a.sku, unidad: a.unidad, unidades: a.q / 10_000, lineas: a.n, lineasSinCosto: a.nSin,
    ventaSinIgv: s(a.venta), ventaConCosto: s(a.ventaCon), ventaSinCosto: s(a.ventaSin), costo: s(a.costo), utilidad: s(utilidadC),
    margen: a.ventaCon > 0 ? pct(utilidadC, a.ventaCon) : null,
    cobertura: a.venta > 0 ? pct(a.ventaCon, a.venta) : a.nSin === 0 ? 100 : 0,
  }
}

export function margenPorProducto(lineas: readonly LineaVentaCosto[]): Margenes {
  const acc = new Map<string, Acc>()
  for (const l of lineas) {
    const a = acc.get(l.productId) ?? { nombre: l.nombre, sku: l.sku, unidad: l.unidad, q: 0, n: 0, nSin: 0, venta: 0, ventaCon: 0, ventaSin: 0, costo: 0 }
    const ventaC = c(ventaSinIgvDeLinea(l.totalConIgv, l.tasaIgv))
    a.q += Math.round(l.cantidad * 10_000); a.n++; a.venta += ventaC
    if (l.costoUnitario > 0) { a.ventaCon += ventaC; a.costo += c(totalDeLinea(l.cantidad, l.costoUnitario)) }
    else { a.ventaSin += ventaC; a.nSin++ }
    acc.set(l.productId, a)
  }
  const filas = [...acc].map(([id, a]) => filaDe(id, a)).sort((x, y) => y.ventaSinIgv - x.ventaSinIgv || orden.compare(x.nombre, y.nombre) || (x.productId < y.productId ? -1 : 1))
  const T = [...acc.values()].reduce((t, a) => ({ n: t.n + a.n, nSin: t.nSin + a.nSin, venta: t.venta + a.venta, ventaCon: t.ventaCon + a.ventaCon, ventaSin: t.ventaSin + a.ventaSin, costo: t.costo + a.costo }), { n: 0, nSin: 0, venta: 0, ventaCon: 0, ventaSin: 0, costo: 0 })
  const utilidadC = T.ventaCon - T.costo
  return {
    filas,
    totales: {
      productos: filas.length, productosSinCostoAlguno: filas.filter((f) => f.lineasSinCosto > 0).length, lineas: T.n, lineasSinCosto: T.nSin,
      ventaSinIgv: s(T.venta), ventaConCosto: s(T.ventaCon), ventaSinCosto: s(T.ventaSin), costo: s(T.costo), utilidad: s(utilidadC),
      margen: T.ventaCon > 0 ? pct(utilidadC, T.ventaCon) : null, cobertura: T.venta > 0 ? pct(T.ventaCon, T.venta) : T.nSin === 0 ? 100 : 0,
    },
    sinCosto: filas.filter((f) => f.ventaSinCosto > 0 || f.lineasSinCosto > 0).sort((x, y) => y.ventaSinCosto - x.ventaSinCosto || orden.compare(x.nombre, y.nombre)),
  }
}

// ─── Inventario valorizado ──────────────────────────────────────────────────────────────────────────────────────────

export interface FilaStock {
  productId: string
  nombre: string
  sku: string
  unidad: string
  /** El producto está dado de baja pero aún tiene stock físico: se valoriza igual (el inventario existe). */
  eliminado: boolean
  almacenId: string
  almacen: string
  cantidad: number
  /** Costo promedio actual (`Product.costPrice`), sin IGV. 0 = sin costo. */
  costoUnitario: number
}

export interface FilaInventario {
  productId: string
  nombre: string
  sku: string
  unidad: string
  eliminado: boolean
  /** Solo lo positivo: un saldo negativo no es mercadería. */
  cantidad: number
  costoUnitario: number
  /** `null` = no se puede valorizar (hay stock pero no costo). */
  valor: number | null
  sinCosto: boolean
  /** Tiene algún almacén con saldo negativo (excluido de la cantidad y del valor). */
  conSaldoNegativo: boolean
}
export interface FilaAlmacen { almacenId: string; almacen: string; valor: number; productos: number; unidadesSinCosto: number }
export interface InventarioValorizado {
  productos: FilaInventario[]
  almacenes: FilaAlmacen[]
  totales: { valor: number; productosConStock: number; productosValorizados: number; productosSinCosto: number; unidadesSinCosto: number; productosConSaldoNegativo: number; coberturaProductos: number }
}

/**
 * Valor del inventario AL DÍA DE HOY: cada saldo positivo × el costo promedio actual del producto, por almacén. Lo que tiene stock y
 * no tiene costo NO se valoriza (ni se cuenta como 0): se lista aparte con sus unidades. Los saldos negativos no se valorizan ni restan.
 * El valor de un producto es la suma de lo de sus almacenes, así que productos y almacenes siempre suman lo mismo.
 */
export function inventarioValorizado(stocks: readonly FilaStock[]): InventarioValorizado {
  const prod = new Map<string, { f: FilaStock; cant: number; valorC: number; neg: boolean }>()
  const alm = new Map<string, { nombre: string; valorC: number; prods: Set<string>; sinCosto: number }>()
  for (const f of stocks) {
    const p = prod.get(f.productId) ?? { f, cant: 0, valorC: 0, neg: false }
    const a = alm.get(f.almacenId) ?? { nombre: f.almacen, valorC: 0, prods: new Set<string>(), sinCosto: 0 }
    if (f.cantidad < 0) p.neg = true
    if (f.cantidad > 0) {
      const q = Math.round(f.cantidad * 10_000)
      p.cant += q; a.prods.add(f.productId)
      if (f.costoUnitario > 0) { const v = c(totalDeLinea(f.cantidad, f.costoUnitario)); p.valorC += v; a.valorC += v } else a.sinCosto += q
    }
    prod.set(f.productId, p); alm.set(f.almacenId, a)
  }
  const productos = [...prod.values()].map(({ f, cant, valorC, neg }): FilaInventario => {
    const sinCosto = cant > 0 && f.costoUnitario <= 0
    return { productId: f.productId, nombre: f.nombre, sku: f.sku, unidad: f.unidad, eliminado: f.eliminado, cantidad: cant / 10_000, costoUnitario: f.costoUnitario, valor: cant === 0 ? 0 : sinCosto ? null : s(valorC), sinCosto, conSaldoNegativo: neg }
  }).sort((x, y) => (y.valor ?? -1) - (x.valor ?? -1) || orden.compare(x.nombre, y.nombre) || (x.productId < y.productId ? -1 : 1))
  const almacenes = [...alm].map(([almacenId, a]): FilaAlmacen => ({ almacenId, almacen: a.nombre, valor: s(a.valorC), productos: a.prods.size, unidadesSinCosto: a.sinCosto / 10_000 }))
    .sort((x, y) => y.valor - x.valor || orden.compare(x.almacen, y.almacen))
  const conStock = productos.filter((p) => p.cantidad > 0)
  const valorC = [...alm.values()].reduce((t, a) => t + a.valorC, 0)
  return {
    productos, almacenes,
    totales: {
      valor: s(valorC), productosConStock: conStock.length, productosValorizados: conStock.filter((p) => !p.sinCosto).length,
      productosSinCosto: conStock.filter((p) => p.sinCosto).length, unidadesSinCosto: conStock.filter((p) => p.sinCosto).reduce((t, p) => t + Math.round(p.cantidad * 10_000), 0) / 10_000,
      productosConSaldoNegativo: productos.filter((p) => p.conSaldoNegativo).length,
      coberturaProductos: conStock.length > 0 ? Math.round((conStock.filter((p) => !p.sinCosto).length * 10_000) / conStock.length) / 100 : 100,
    },
  }
}

// ─── Análisis ABC ───────────────────────────────────────────────────────────────────────────────────────────────────

export type ClaseAbc = 'A' | 'B' | 'C'
export interface ItemAbc { id: string; nombre: string; sku: string; /** En soles; puede ser negativo (utilidad). */ valor: number }
export interface FilaAbc { posicion: number; id: string; nombre: string; sku: string; valor: number; participacion: number; acumulado: number; clase: ClaseAbc }
export interface ResumenClase { clase: ClaseAbc; productos: number; participacionProductos: number; valor: number; participacionValor: number }
export interface ResultadoAbc { filas: FilaAbc[]; resumen: ResumenClase[]; total: number; umbrales: { a: number; b: number } }

export const UMBRALES_ABC = { a: 80, b: 95 } as const

/**
 * Pareto. Se ordena de mayor a menor valor y se acumula la participación:
 *  · A: los que reúnen hasta el `a` % del total (el producto que CRUZA el umbral se queda en A);
 *  · B: los siguientes hasta el `b` %;  · C: el resto.
 * Con empates el orden es por nombre y luego por id, de modo que el resultado es siempre el mismo. Los valores ≤ 0 (sin venta, o utilidad
 * negativa) van a C, no suman al total sobre el que se calculan las participaciones y no desplazan a nadie.
 */
export function analisisAbc(items: readonly ItemAbc[], umbrales: { a: number; b: number } = UMBRALES_ABC): ResultadoAbc {
  if (!(umbrales.a > 0 && umbrales.a < umbrales.b && umbrales.b < 100)) throw new RangeError('Los umbrales deben cumplir 0 < A < B < 100.')
  const ordenados = [...items].sort((x, y) => y.valor - x.valor || orden.compare(x.nombre, y.nombre) || (x.id < y.id ? -1 : 1))
  const totalC = ordenados.reduce((t, i) => t + Math.max(0, c(i.valor)), 0)
  const A = Math.round(umbrales.a * 100), B = Math.round(umbrales.b * 100)
  let cumC = 0
  const filas = ordenados.map((i, k): FilaAbc => {
    const vC = c(i.valor)
    let clase: ClaseAbc = 'C'
    if (vC > 0 && totalC > 0) {
      // Se mira lo acumulado ANTES de este producto: el que cruza el umbral pertenece a la clase que está llenando.
      clase = cumC * 10_000 < A * totalC ? 'A' : cumC * 10_000 < B * totalC ? 'B' : 'C'
      cumC += vC
    }
    return { posicion: k + 1, id: i.id, nombre: i.nombre, sku: i.sku, valor: i.valor, participacion: vC > 0 ? pct(vC, totalC) : 0, acumulado: pct(cumC, totalC), clase }
  })
  const resumen = (['A', 'B', 'C'] as const).map((clase): ResumenClase => {
    const f = filas.filter((x) => x.clase === clase)
    const vC = f.reduce((t, x) => t + Math.max(0, c(x.valor)), 0)
    return { clase, productos: f.length, participacionProductos: filas.length > 0 ? Math.round((f.length * 10_000) / filas.length) / 100 : 0, valor: s(vC), participacionValor: pct(vC, totalC) }
  })
  return { filas, resumen, total: s(totalC), umbrales }
}
