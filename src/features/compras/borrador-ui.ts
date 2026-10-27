import { igvDeCompra, totalDeLinea } from './costo'

/**
 * Lo que el formulario de compra necesita calcular, PURO. Sin servidor: lo importa el navegador.
 *
 * Los importes salen de `totalDeLinea` e `igvDeCompra`, las MISMAS funciones con las que el servidor guarda la compra: lo que se ve
 * antes de guardar es exactamente lo que queda registrado (el servidor lo vuelve a calcular igual y no se fía del cliente).
 */

export type EstadoCompra = 'BORRADOR' | 'RECIBIDA' | 'ANULADA'
export type CondicionCompra = 'CONTADO' | 'CREDITO'

export const ETIQUETA_ESTADO: Record<EstadoCompra, string> = { BORRADOR: 'Borrador', RECIBIDA: 'Recibida', ANULADA: 'Anulada' }
export const ETIQUETA_CONDICION: Record<CondicionCompra, string> = { CONTADO: 'Al contado', CREDITO: 'A crédito' }
export const FILTROS_COMPRA = ['TODAS', 'BORRADOR', 'RECIBIDA', 'ANULADA'] as const
export type FiltroCompra = (typeof FILTROS_COMPRA)[number]
export const ETIQUETA_FILTRO_COMPRA: Record<FiltroCompra, string> = { TODAS: 'Todas', BORRADOR: 'Borradores', RECIBIDA: 'Recibidas', ANULADA: 'Anuladas' }

export const MENSAJE_CREDITO_SIN_PROVEEDOR = 'Una compra a crédito necesita proveedor: es a quien se le va a deber.'
export const MENSAJE_SIN_LINEAS = 'Agrega al menos un producto.'

/** La dirección de un filtro conservando la búsqueda. «Todas» y sin búsqueda es la dirección limpia. */
export function enlaceFiltroCompras(filtro: FiltroCompra, q: string | undefined): string {
  const p = new URLSearchParams()
  if (filtro !== 'TODAS') p.set('estado', filtro)
  if (q) p.set('q', q)
  const s = p.toString()
  return s ? `/compras?${s}` : '/compras'
}

/**
 * Un número tecleado (cantidad o costo): acepta coma decimal. `null` = vacío; `NaN` = no es válido (letras, negativo, demasiados
 * decimales). `permiteCero`: un costo puede ser 0 (mercadería bonificada); una cantidad, no.
 */
export function leerDecimal(texto: string, decimales: number, permiteCero: boolean): number | null {
  const t = texto.trim().replace(',', '.')
  if (t === '') return null
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimales}})?$`).test(t)) return Number.NaN
  const n = Number(t)
  if (!Number.isFinite(n) || n > 99_999_999) return Number.NaN
  return n > 0 || (permiteCero && n === 0) ? n : Number.NaN
}

export interface LineaEnFormulario {
  /** Lo tecleado: unidades de compra (cajas, sacos o unidades base). */
  cantidad: string
  /** Lo tecleado: costo por unidad de compra, SIN IGV. */
  costo: string
  /** IGV del producto. */
  tasa: number
}

export interface ResumenBorrador {
  /** Total de cada línea (sin IGV), o `null` si todavía no se puede calcular (falta o es inválido un dato). */
  totales: (number | null)[]
  /** Alguna línea tiene un dato inválido (no vacío). */
  hayInvalidas: boolean
  /** Todas las líneas tienen cantidad y costo válidos. */
  completas: boolean
  subtotal: number
  igv: number
  total: number
}

/** Totales de lo que está en pantalla, con las funciones del servidor. Las líneas incompletas no suman. */
export function resumenBorrador(lineas: readonly LineaEnFormulario[]): ResumenBorrador {
  let hayInvalidas = false, completas = lineas.length > 0
  const totales = lineas.map((l) => {
    const q = leerDecimal(l.cantidad, 4, false), c = leerDecimal(l.costo, 4, true)
    if (Number.isNaN(q) || Number.isNaN(c)) hayInvalidas = true
    if (q === null || c === null || Number.isNaN(q) || Number.isNaN(c)) { completas = false; return null }
    return totalDeLinea(q, c)
  })
  const r = igvDeCompra(lineas.flatMap((l, i) => (totales[i] === null ? [] : [{ total: totales[i]!, tasa: l.tasa }])))
  return { totales, hayInvalidas, completas, subtotal: r.subtotal, igv: r.igv, total: r.total }
}

/** El primer motivo que impide guardar el borrador (el mismo que daría el servidor), o `null`. */
export function motivoNoGuardable(f: { condicion: CondicionCompra; proveedorId: string; lineas: readonly LineaEnFormulario[] }): string | null {
  if (f.lineas.length === 0) return MENSAJE_SIN_LINEAS
  if (f.condicion === 'CREDITO' && !f.proveedorId) return MENSAJE_CREDITO_SIN_PROVEEDOR
  const r = resumenBorrador(f.lineas)
  if (r.hayInvalidas) return 'Revisa las cantidades y los costos: hay un valor que no es un número válido.'
  if (!r.completas) return 'Completa la cantidad y el costo de cada producto.'
  return null
}

/** Vencimiento sugerido para una compra a crédito: hoy (día del negocio) + el plazo del proveedor, como AAAA-MM-DD. */
export function venceSugerido(hoy: string, plazoDias: number): string {
  const [y, m, d] = hoy.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + plazoDias)).toISOString().slice(0, 10)
}
