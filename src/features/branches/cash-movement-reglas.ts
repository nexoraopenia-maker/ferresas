/**
 * Reglas de los movimientos manuales de caja (F6.3), como funciones PURAS. Dinero en céntimos enteros.
 *
 * Un movimiento manual es dinero EN EFECTIVO que entra al cajón o sale de él por una razón que no es una venta, un abono, un pago a proveedor ni
 * una devolución: un gasto menor, un retiro del dueño, una reposición del fondo, la corrección de un arqueo. Siempre dentro del turno abierto.
 *
 * ─── QUIÉN PUEDE QUÉ (un permiso = un poder; cada uno basta por sí solo, nunca se exigen dos a la vez) ─────────────────────────────
 *  · `caja.movimientos`: GASTO_MENOR y OTRO, hasta `TOPE_MOVIMIENTO_SIN_AJUSTE` por movimiento (es lo que hace un cajero).
 *  · `caja.ajuste`: cualquier categoría y cualquier monto (RETIRO_DUENO, REPOSICION_FONDO, CORRECCION_ARQUEO, y lo que pase del tope).
 *    Fuera del PIN de operador.
 */

/** ⚠️ Operativo, decidido por el dueño (2026-10-28): lo máximo que registra quien solo tiene `caja.movimientos`, por movimiento, en soles. */
export const TOPE_MOVIMIENTO_SIN_AJUSTE = 100
/** ⚠️ Operativo: un EGRESO de más de este importe (en soles) exige una referencia o comprobante. */
export const REFERENCIA_OBLIGATORIA_DESDE = 200

export const TIPOS = ['INGRESO', 'EGRESO'] as const
export type TipoMovimiento = (typeof TIPOS)[number]
export const CATEGORIAS_MOVIMIENTO = ['GASTO_MENOR', 'RETIRO_DUENO', 'REPOSICION_FONDO', 'CORRECCION_ARQUEO', 'OTRO'] as const
export type CategoriaMovimiento = (typeof CATEGORIAS_MOVIMIENTO)[number]

/** Un INGRESO no puede ser un gasto ni un retiro; un EGRESO no puede ser una reposición del fondo. La base lo repite con un CHECK. */
export const CATEGORIAS_POR_TIPO: Record<TipoMovimiento, readonly CategoriaMovimiento[]> = {
  INGRESO: ['REPOSICION_FONDO', 'CORRECCION_ARQUEO', 'OTRO'],
  EGRESO: ['GASTO_MENOR', 'RETIRO_DUENO', 'CORRECCION_ARQUEO', 'OTRO'],
}
export const categoriaValida = (tipo: TipoMovimiento, cat: CategoriaMovimiento): boolean => CATEGORIAS_POR_TIPO[tipo].includes(cat)

export const ETIQUETA_CATEGORIA: Record<CategoriaMovimiento, string> = {
  GASTO_MENOR: 'Gasto menor', RETIRO_DUENO: 'Retiro del dueño', REPOSICION_FONDO: 'Reposición del fondo', CORRECCION_ARQUEO: 'Corrección de arqueo', OTRO: 'Otro',
}
export const ETIQUETA_TIPO: Record<TipoMovimiento, string> = { INGRESO: 'Ingreso', EGRESO: 'Egreso' }

const CATEGORIAS_DEL_CAJERO: readonly CategoriaMovimiento[] = ['GASTO_MENOR', 'OTRO']

export type PermisoMovimiento = 'caja.movimientos' | 'caja.ajuste'

/** El permiso MÍNIMO que hace falta para registrar este movimiento. Lo que pasa del tope, o no es gasto menor/otro, es de `caja.ajuste`. */
export function permisoRequerido(cat: CategoriaMovimiento, montoCent: number): PermisoMovimiento {
  return CATEGORIAS_DEL_CAJERO.includes(cat) && montoCent <= TOPE_MOVIMIENTO_SIN_AJUSTE * 100 ? 'caja.movimientos' : 'caja.ajuste'
}

/** ¿Alcanza lo que la persona tiene? `caja.ajuste` basta para todo; `caja.movimientos` solo para lo que se pide con ese permiso. NUNCA se exigen los dos. */
export function alcanza(tiene: { movimientos: boolean; ajuste: boolean }, requerido: PermisoMovimiento): boolean {
  return tiene.ajuste || (requerido === 'caja.movimientos' && tiene.movimientos)
}

export function mensajeSinPermiso(cat: CategoriaMovimiento, montoCent: number, tiene: { movimientos: boolean; ajuste: boolean }): string {
  const tope = `S/ ${TOPE_MOVIMIENTO_SIN_AJUSTE.toFixed(2)}`
  if (!tiene.movimientos) return 'No tienes permiso para registrar movimientos de caja. Pídele a quien administra la caja (dueño o administrador).'
  if (!CATEGORIAS_DEL_CAJERO.includes(cat)) return `${ETIQUETA_CATEGORIA[cat]} solo lo registra quien administra la caja (dueño o administrador). Tú puedes registrar gastos menores y otros movimientos de hasta ${tope}.`
  void montoCent
  return `Con tu permiso puedes registrar movimientos de hasta ${tope} cada uno. Este es mayor: pídele a quien administra la caja (dueño o administrador) que lo registre.`
}

/** Un egreso mayor que `REFERENCIA_OBLIGATORIA_DESDE` necesita referencia (número de comprobante, recibo…) de al menos 3 caracteres. */
export const exigeReferencia = (tipo: TipoMovimiento, montoCent: number): boolean => tipo === 'EGRESO' && montoCent > REFERENCIA_OBLIGATORIA_DESDE * 100
export const referenciaSuficiente = (ref: string | null | undefined): boolean => (ref ?? '').trim().length >= 3

/** ¿Este egreso saca más efectivo del que el sistema espera en el cajón? Se avisa y se pide confirmación expresa: NO se bloquea (puede haber efectivo sin registrar). */
export const excedeEfectivo = (tipo: TipoMovimiento, montoCent: number, esperadoCent: number): boolean => tipo === 'EGRESO' && montoCent > esperadoCent

/**
 * ¿Quién puede anular un movimiento (mientras su turno siga abierto)? Quien tiene `caja.ajuste`; o su propio autor, si por sí solo habría podido
 * registrarlo (tiene `caja.movimientos` y el movimiento era de ese alcance). Nadie anula el movimiento de otro con solo `caja.movimientos`.
 */
export function puedeAnular(e: { tiene: { movimientos: boolean; ajuste: boolean }; esAutor: boolean; categoria: CategoriaMovimiento; montoCent: number }): boolean {
  if (e.tiene.ajuste) return true
  return e.esAutor && e.tiene.movimientos && permisoRequerido(e.categoria, e.montoCent) === 'caja.movimientos'
}
