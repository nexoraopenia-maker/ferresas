/**
 * Del motor de reposición al pedido (F6.6b). Funciones PURAS: sin base de datos ni React.
 *
 *  · «Bajo pedido»: un producto sin proveedor habitual y sin umbrales (mínimo 0 y sin máximo) no se repone solo; se pide cuando un cliente lo encarga. Queda fuera del reporte, salvo
 *    que su posición haya caído por debajo de cero (se vendió sin existencias: ahí sí hay un faltante que cubrir).
 *  · Redondeo HACIA ARRIBA: con presentación de compra (caja de 12) se pide el número entero de presentaciones que cubre lo sugerido (14 → 2 cajas = 24); sin presentación, la
 *    unidad base se redondea hacia arriba a los decimales que su unidad admite (unidades enteras: 2,3 → 3). Nunca se pide de menos.
 *  · Todo en enteros (BigInt): ni 0,1 + 0,2 ni un 12,0000001 que pida una caja de más.
 *  · Agrupar por proveedor habitual; los productos sin proveedor, en «Otros / Sin proveedor», siempre al final.
 */
import type { UnitType } from '@/generated/prisma/enums'
import { decimalesPermitidos } from './conversion'

export const NOMBRE_SIN_PROVEEDOR = 'Otros / Sin proveedor'

const DIEZMIL = 10_000
const MILLON = 1_000_000

export interface UmbralesDeProducto {
  supplierId: string | null
  minimo: number
  maximo: number | null
}

/** Sin proveedor habitual y sin umbrales: se trabaja contra pedido. */
export function esBajoPedido(p: UmbralesDeProducto): boolean {
  return p.supplierId === null && p.minimo <= 0 && (p.maximo === null || p.maximo <= 0)
}

export interface ParaReporte extends UmbralesDeProducto {
  dispara: boolean
  /** Lo que sugiere el motor, en la unidad base. */
  sugerida: number
  posicion: number
}

/** ¿Entra esta fila al reporte? Dispara, hay algo que pedir y no es «bajo pedido» (salvo posición negativa). */
export function entraAlReporte(p: ParaReporte): boolean {
  if (!p.dispara || !(p.sugerida > 0)) return false
  if (esBajoPedido(p)) return p.posicion < 0
  return true
}

export interface PresentacionDeCompra {
  id: string
  name: string
  unitType: string
  /** Unidades BASE por presentación (> 0). */
  factor: number
}

export interface CantidadAPedir {
  /** En la unidad en que se pide: presentaciones (cajas) o unidades base. */
  cantidad: number
  /** Lo mismo en la unidad BASE (lo que mueve el stock). */
  unidadesBase: number
  presentacion: PresentacionDeCompra | null
  /** Cuánto se pide de más por redondear hacia arriba, en unidad base (0 si cuadra exacto). */
  sobrante: number
}

const aDiezmilesimas = (n: number): bigint => BigInt(Math.round(n * DIEZMIL))
const dividirHaciaArriba = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

/**
 * Cuánto pedir para cubrir `sugerida` (unidad base). Con presentación: presentaciones enteras hacia arriba. Sin ella: la unidad base hacia arriba a los decimales de su
 * unidad. Una sugerida ≤ 0 no pide nada.
 */
export function cantidadAPedir(sugerida: number, unitType: UnitType | string, presentacion: PresentacionDeCompra | null = null): CantidadAPedir {
  const s = aDiezmilesimas(sugerida)
  if (s <= 0n) return { cantidad: 0, unidadesBase: 0, presentacion, sobrante: 0 }

  if (presentacion && presentacion.factor > 0) {
    const f = BigInt(Math.round(presentacion.factor * MILLON))
    if (f > 0n) {
      // presentaciones = ceil(sugerida / factor), con sugerida en 1e-4 y factor en 1e-6.
      const n = dividirHaciaArriba(s * 100n, f)
      const base = (n * f) / 100n // en 1e-4, exacto para factores de hasta 4 decimales (los de compra reales)
      return { cantidad: Number(n), unidadesBase: Number(base) / DIEZMIL, presentacion, sobrante: Number(base - s) / DIEZMIL }
    }
  }

  const decimales = decimalesPermitidos(unitType as UnitType)
  const paso = BigInt(10 ** (4 - Math.min(4, decimales)))
  const redondeada = dividirHaciaArriba(s, paso) * paso
  const cantidad = Number(redondeada) / DIEZMIL
  return { cantidad, unidadesBase: cantidad, presentacion: null, sobrante: Number(redondeada - s) / DIEZMIL }
}

export interface LineaAgrupable {
  supplierId: string | null
  nombre: string
  estado: 'OK' | 'LOW' | 'OUT'
}

export interface GrupoProveedor<L> {
  supplierId: string | null
  /** El nombre del proveedor, o «Otros / Sin proveedor». */
  nombre: string
  lineas: L[]
}

const ORDEN_ESTADO = { OUT: 0, LOW: 1, OK: 2 } as const

/**
 * Agrupa por proveedor habitual. Los grupos van por nombre; «Otros / Sin proveedor» al final. Dentro de cada grupo, lo agotado primero y luego por nombre.
 * Un `supplierId` sin nombre conocido (proveedor dado de baja y no cargado) cae en «Otros / Sin proveedor»: nunca se pierde una línea.
 */
export function agruparPorProveedor<L extends LineaAgrupable>(lineas: readonly L[], nombres: ReadonlyMap<string, string>): GrupoProveedor<L>[] {
  const grupos = new Map<string | null, GrupoProveedor<L>>()
  for (const l of lineas) {
    const nombre = l.supplierId ? nombres.get(l.supplierId) : undefined
    const clave = nombre !== undefined ? l.supplierId : null
    let g = grupos.get(clave)
    if (!g) { g = { supplierId: clave, nombre: clave === null ? NOMBRE_SIN_PROVEEDOR : nombre!, lineas: [] }; grupos.set(clave, g) }
    g.lineas.push(l)
  }
  const orden = [...grupos.values()]
  for (const g of orden) g.lineas.sort((a, b) => ORDEN_ESTADO[a.estado] - ORDEN_ESTADO[b.estado] || a.nombre.localeCompare(b.nombre, 'es'))
  return orden.sort((a, b) => (a.supplierId === null ? 1 : 0) - (b.supplierId === null ? 1 : 0) || a.nombre.localeCompare(b.nombre, 'es'))
}
