import {
  CATEGORIAS_POR_TIPO, ETIQUETA_CATEGORIA, REFERENCIA_OBLIGATORIA_DESDE, TOPE_MOVIMIENTO_SIN_AJUSTE, alcanza, exigeReferencia, mensajeSinPermiso, permisoRequerido, referenciaSuficiente,
  type CategoriaMovimiento, type PermisoMovimiento, type TipoMovimiento,
} from './cash-movement-reglas'

/**
 * Lo que el formulario «Registrar movimiento» comprueba EN VIVO, como funciones PURAS (sin React): qué categorías ofrece según el permiso de quien lo
 * llena, si lo escrito es válido, qué falta, y si hace falta referencia. Usa las mismas reglas que el servicio, que vuelve a comprobarlo todo.
 */

export interface PermisosDeCaja { movimientos: boolean; ajuste: boolean }

/** Las categorías que esta persona puede elegir para este tipo: con `caja.ajuste`, todas las del tipo; con solo `caja.movimientos`, gasto menor y «otro». */
export function categoriasOfrecidas(tipo: TipoMovimiento, tiene: PermisosDeCaja): { valor: CategoriaMovimiento; etiqueta: string }[] {
  return CATEGORIAS_POR_TIPO[tipo]
    .filter((c) => tiene.ajuste || (tiene.movimientos && permisoRequerido(c, 1) === 'caja.movimientos'))
    .map((c) => ({ valor: c, etiqueta: ETIQUETA_CATEGORIA[c] }))
}

export interface EntradaFormulario { tipo: TipoMovimiento; categoria: CategoriaMovimiento; monto: string; descripcion: string; referencia: string }
export interface EvaluacionFormulario {
  ok: boolean
  /** Lo que falta o está mal, en español, para enseñarlo bajo el formulario. */
  errores: string[]
  montoCent: number | null
  /** El permiso mínimo que hace falta para lo escrito (si hay monto válido). */
  permiso: PermisoMovimiento | null
  referenciaObligatoria: boolean
}

export function evaluarFormulario(e: EntradaFormulario, tiene: PermisosDeCaja): EvaluacionFormulario {
  const errores: string[] = []
  const monto = Number(e.monto.replace(',', '.'))
  const montoValido = e.monto.trim() !== '' && Number.isFinite(monto) && monto > 0 && Math.abs(monto * 100 - Math.round(monto * 100)) < 1e-6 && monto <= 9_999_999.99
  const montoCent = montoValido ? Math.round(monto * 100) : null
  if (e.monto.trim() === '') errores.push('Escribe el monto.')
  else if (!montoValido) errores.push('El monto debe ser mayor que cero y llevar como máximo 2 decimales.')
  if (e.descripcion.trim().length < 3) errores.push('Explica el movimiento (mínimo 3 caracteres).')
  const permiso = montoCent === null ? null : permisoRequerido(e.categoria, montoCent)
  if (permiso && !alcanza(tiene, permiso)) errores.push(mensajeSinPermiso(e.categoria, montoCent!, tiene))
  const referenciaObligatoria = montoCent !== null && exigeReferencia(e.tipo, montoCent)
  if (referenciaObligatoria && !referenciaSuficiente(e.referencia)) errores.push(`Un egreso de más de S/ ${REFERENCIA_OBLIGATORIA_DESDE.toFixed(2)} necesita una referencia (número de comprobante o recibo).`)
  return { ok: errores.length === 0, errores, montoCent, permiso, referenciaObligatoria }
}

export { TOPE_MOVIMIENTO_SIN_AJUSTE, REFERENCIA_OBLIGATORIA_DESDE }
