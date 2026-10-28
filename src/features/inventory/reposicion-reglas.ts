/**
 * El criterio ÚNICO de «bajo stock» y de reposición (F6.6a). Funciones puras: sin base de datos ni React. El panel, `/inventario/alertas`, el escáner y el POS
 * leen de aquí; ninguno compara `minStock` por su cuenta.
 *
 *  · Herencia de umbrales, de lo más específico a lo más general. Mínimo: almacén (`Stock.minStock`, si no es NULL; un 0 explícito allí significa «sin umbral en este
 *    almacén») → variante (`ProductVariant.minStock`, solo si es > 0: la columna no admite NULL, así que 0 significa «sin valor propio») → producto. Máximo: almacén →
 *    variante → producto, todos opcionales.
 *  · Disponible = cantidad − reservado. En tránsito = lo enviado por transferencias EN_TRANSITO que aún no llegó a ese almacén. Posición = disponible + en tránsito.
 *  · El semáforo (OK / LOW / OUT) juzga lo DISPONIBLE: es lo que se puede vender hoy. Reponer se decide sobre la POSICIÓN: lo que ya viene en camino no se vuelve a pedir.
 *  · Dispara reposición si hay mínimo (> 0) y la posición está en el mínimo o por debajo (el borde cuenta); sin mínimo, solo si lo disponible se agotó.
 *  · Objetivo = el máximo (nunca por debajo del mínimo) o, si no hay máximo, 2 × el mínimo (aprobado por el dueño). Sugerida = objetivo − posición,
 *    sin bajar de 0. Con stock NEGATIVO la posición es negativa y la fórmula repone también lo vendido sin existencias (objetivo + faltante).
 *  · Todo en 4 decimales exactos (enteros de diezmilésimas): ni 0,1 + 0,2 ≠ 0,3 ni un «justo en el mínimo» que se escapa por coma flotante.
 */
import { getStockStatus, type StockStatus } from '@/lib/stock-status'

/** Cuántas veces el mínimo es el objetivo cuando no se fijó un máximo. */
export const FACTOR_OBJETIVO_SIN_MAXIMO = 2

const DIEZMIL = 10_000
const aEntero = (n: number): bigint => BigInt(Math.round(n * DIEZMIL))
const deEntero = (n: bigint): number => Number(n) / DIEZMIL
const r4 = (n: number): number => Math.round(n * DIEZMIL) / DIEZMIL

/** Un umbral tal como llega de la base: número, texto decimal, Decimal de Prisma o vacío. */
export type ValorUmbral = number | string | { toString(): string } | null | undefined

/** Número finito o `null`: lo vacío y lo que no es un número no es un umbral. */
function aNumero(v: ValorUmbral): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v.toString())
  return Number.isFinite(n) ? n : null
}

export interface UmbralesEntrada {
  /** `Stock.minStock` / `Stock.maxStock`: lo fijado para ese almacén. */
  almacenMin?: ValorUmbral
  almacenMax?: ValorUmbral
  /** `ProductVariant.minStock` / `maxStock`, si la fila es de una variante. */
  varianteMin?: ValorUmbral
  varianteMax?: ValorUmbral
  /** `Product.minStock` / `maxStock`: el predeterminado de todos. */
  productoMin?: ValorUmbral
  productoMax?: ValorUmbral
}

export type OrigenUmbral = 'ALMACEN' | 'VARIANTE' | 'PRODUCTO'

export interface UmbralesResueltos {
  /** Siempre ≥ 0; 0 = sin umbral. */
  minimo: number
  /** `null` = nadie fijó un máximo. */
  maximo: number | null
  origenMinimo: OrigenUmbral
  /** `null` si no hay máximo en ningún nivel. */
  origenMaximo: OrigenUmbral | null
}

/** Aplica la herencia almacén → variante → producto. */
export function resolverUmbrales(e: UmbralesEntrada): UmbralesResueltos {
  const aMin = aNumero(e.almacenMin)
  const vMin = aNumero(e.varianteMin)
  let minimo: number
  let origenMinimo: OrigenUmbral
  if (aMin !== null) { minimo = aMin; origenMinimo = 'ALMACEN' }
  else if (vMin !== null && vMin > 0) { minimo = vMin; origenMinimo = 'VARIANTE' }
  else { minimo = aNumero(e.productoMin) ?? 0; origenMinimo = 'PRODUCTO' }

  const aMax = aNumero(e.almacenMax)
  const vMax = aNumero(e.varianteMax)
  const pMax = aNumero(e.productoMax)
  let maximo: number | null
  let origenMaximo: OrigenUmbral | null
  if (aMax !== null) { maximo = aMax; origenMaximo = 'ALMACEN' }
  else if (vMax !== null) { maximo = vMax; origenMaximo = 'VARIANTE' }
  else if (pMax !== null) { maximo = pMax; origenMaximo = 'PRODUCTO' }
  else { maximo = null; origenMaximo = null }

  // Un umbral negativo no existe: se trata como «sin umbral».
  return { minimo: Math.max(0, minimo), maximo: maximo === null ? null : Math.max(0, maximo), origenMinimo, origenMaximo }
}

export interface PosicionEntrada {
  /** Lo que hay en el estante (puede ser negativo: se vendió sin existencias). */
  cantidad: number
  /** Reservado por cotizaciones aceptadas o ventas en curso. */
  reservado?: number
  /** Enviado por transferencias EN_TRANSITO hacia este almacén y todavía no recibido. */
  enTransito?: number
  minimo: number
  maximo: number | null
}

export interface EvaluacionReposicion {
  cantidad: number
  reservado: number
  disponible: number
  enTransito: number
  posicion: number
  minimo: number
  maximo: number | null
  /** El semáforo, sobre lo disponible. */
  estado: StockStatus
  /** ¿Hay que reponer? Sobre la posición. */
  dispara: boolean
  objetivo: number
  /** Cuánto pedir para llegar al objetivo; 0 si no dispara. En la unidad base, sin redondear a presentaciones. */
  sugerida: number
}

/** El objetivo al que se repone: el máximo (nunca bajo el mínimo) o 2 × el mínimo. */
export function objetivoDeReposicion(minimo: number, maximo: number | null): number {
  const min = Math.max(0, minimo)
  if (maximo === null) return r4(min * FACTOR_OBJETIVO_SIN_MAXIMO)
  return Math.max(r4(maximo), r4(min))
}

export function evaluarReposicion(e: PosicionEntrada): EvaluacionReposicion {
  const minimo = Math.max(0, e.minimo)
  const reservado = e.reservado ?? 0
  const enTransito = Math.max(0, e.enTransito ?? 0)
  const disponible = deEntero(aEntero(e.cantidad) - aEntero(reservado))
  const posicion = deEntero(aEntero(disponible) + aEntero(enTransito))

  // `<=`: estar justo en el mínimo YA es señal de reponer. Comparar en enteros evita que 0,1 + 0,2 se pase de largo.
  const dispara = minimo > 0 ? aEntero(posicion) <= aEntero(minimo) : disponible <= 0
  const objetivo = objetivoDeReposicion(minimo, e.maximo)
  const falta = deEntero(aEntero(objetivo) - aEntero(posicion))
  return {
    cantidad: r4(e.cantidad),
    reservado: r4(reservado),
    disponible,
    enTransito: r4(enTransito),
    posicion,
    minimo: r4(minimo),
    maximo: e.maximo === null ? null : r4(e.maximo),
    estado: getStockStatus(disponible, minimo),
    dispara,
    objetivo,
    sugerida: dispara ? Math.max(0, falta) : 0,
  }
}

/** Atajo para quien solo necesita el semáforo de UNA fila (escáner, POS): resuelve la herencia y juzga lo disponible. */
export function estadoDeFila(
  fila: { cantidad: ValorUmbral; reservado?: ValorUmbral } & UmbralesEntrada,
): { minimo: number; maximo: number | null; disponible: number; estado: StockStatus } {
  const u = resolverUmbrales(fila)
  const cantidad = aNumero(fila.cantidad) ?? 0
  const e = evaluarReposicion({ cantidad, reservado: aNumero(fila.reservado) ?? 0, minimo: u.minimo, maximo: u.maximo })
  return { minimo: u.minimo, maximo: u.maximo, disponible: e.disponible, estado: e.estado }
}
