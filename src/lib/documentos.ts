/**
 * Validación de documentos de identidad peruanos, sin red y sin base de datos.
 *
 * ⚠️ NORMATIVO: el algoritmo del dígito verificador del RUC (módulo 11 con
 * pesos 5,4,3,2,7,6,5,4,3,2) y los prefijos válidos salen de la práctica
 * pública de validación de SUNAT, pero no se han contrastado contra una
 * especificación oficial en esta sesión. Está en docs/COMPLIANCE.md. Se probó
 * contra dos RUC públicos conocidos (el de SUNAT y el de un supermercado).
 *
 * Que un RUC pase esta comprobación NO significa que exista ni que esté
 * activo: solo descarta los errores de tecleo. Que exista lo dice el padrón
 * (ver padron.ts).
 */

const PESOS_RUC = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const
/** 10 persona natural; 15, 16 y 17 otros sujetos; 20 persona jurídica. */
const PREFIJOS_RUC = new Set(['10', '15', '16', '17', '20'])

export const esSoloDigitos = (s: string) => /^\d+$/.test(s)

/** Dígito verificador que le corresponde a los 10 primeros dígitos de un RUC. */
export function digitoVerificadorRuc(primeros10: string): number {
  if (primeros10.length !== 10 || !esSoloDigitos(primeros10)) {
    throw new RangeError('Se necesitan exactamente 10 dígitos.')
  }
  const suma = PESOS_RUC.reduce((s, peso, i) => s + peso * Number(primeros10[i]), 0)
  return (11 - (suma % 11)) % 10
}

/** Completa 10 dígitos con su verificador. Útil para generar RUC de prueba válidos. */
export const completarRuc = (primeros10: string) => `${primeros10}${digitoVerificadorRuc(primeros10)}`

export type MotivoDocumentoInvalido = 'LONGITUD' | 'NO_NUMERICO' | 'PREFIJO' | 'DIGITO_VERIFICADOR'

export type ResultadoValidacion = { valido: true } | { valido: false; motivo: MotivoDocumentoInvalido; mensaje: string }

export function validarRuc(ruc: string): ResultadoValidacion {
  const r = ruc.trim()
  if (!esSoloDigitos(r)) return { valido: false, motivo: 'NO_NUMERICO', mensaje: 'El RUC solo lleva números.' }
  if (r.length !== 11) return { valido: false, motivo: 'LONGITUD', mensaje: 'El RUC tiene 11 dígitos.' }
  if (!PREFIJOS_RUC.has(r.slice(0, 2))) {
    return { valido: false, motivo: 'PREFIJO', mensaje: 'El RUC debe empezar por 10, 15, 16, 17 o 20.' }
  }
  if (digitoVerificadorRuc(r.slice(0, 10)) !== Number(r[10])) {
    return { valido: false, motivo: 'DIGITO_VERIFICADOR', mensaje: 'El RUC no es válido: revisa los dígitos.' }
  }
  return { valido: true }
}

export function validarDni(dni: string): ResultadoValidacion {
  const d = dni.trim()
  if (!esSoloDigitos(d)) return { valido: false, motivo: 'NO_NUMERICO', mensaje: 'El DNI solo lleva números.' }
  if (d.length !== 8) return { valido: false, motivo: 'LONGITUD', mensaje: 'El DNI tiene 8 dígitos.' }
  return { valido: true }
}

/** Valida según el largo: 8 = DNI, 11 = RUC. Lo mismo que hace el mostrador. */
export function validarDocumento(numero: string): ResultadoValidacion & { tipo?: 'DNI' | 'RUC' } {
  const n = numero.trim()
  if (n.length === 8) return { ...validarDni(n), tipo: 'DNI' }
  if (n.length === 11) return { ...validarRuc(n), tipo: 'RUC' }
  return { valido: false, motivo: 'LONGITUD', mensaje: 'El DNI tiene 8 dígitos y el RUC 11.' }
}
