/**
 * Importe en letras para comprobantes peruanos.
 *
 * ─── POR QUÉ ES OBLIGATORIO ──────────────────────────────────────────────
 *
 * El Reglamento de Comprobantes de Pago exige que boletas y facturas lleven
 * el importe total expresado en letras ("SON: CIENTO TREINTA CON 50/100
 * SOLES"). No es decoración: es el control contra la alteración del monto en
 * cifras, que es trivial sobre papel térmico.
 *
 * Se implementa a mano y no con una dependencia porque son ~70 líneas de
 * reglas fijas del castellano y traer un paquete por esto añadiría superficie
 * de supply chain a cambio de nada.
 */

import { aCentimos } from './dinero'

const UNIDADES = [
  '', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE',
  'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS',
  'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIUNO', 'VEINTIDÓS',
  'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE',
  'VEINTIOCHO', 'VEINTINUEVE',
]

const DECENAS = [
  '', '', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA',
  'OCHENTA', 'NOVENTA',
]

const CENTENAS = [
  '', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS',
  'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS',
]

/** Nombre de la moneda tal como lo pide el catálogo 02 de SUNAT. */
const MONEDAS: Record<string, string> = {
  PEN: 'SOLES',
  USD: 'DÓLARES AMERICANOS',
  EUR: 'EUROS',
}

/** 0..99. */
function dosDigitos(n: number): string {
  if (n < 30) return UNIDADES[n]!
  const d = Math.floor(n / 10)
  const u = n % 10
  return u === 0 ? DECENAS[d]! : `${DECENAS[d]} Y ${UNIDADES[u]}`
}

/** 1..999. */
function tresDigitos(n: number): string {
  if (n === 100) return 'CIEN' // "CIENTO" solo cuando le sigue algo
  const c = Math.floor(n / 100)
  const r = n % 100
  const partes = [CENTENAS[c], r > 0 ? dosDigitos(r) : '']
  return partes.filter(Boolean).join(' ')
}

/**
 * Apócope delante de sustantivo: "VEINTIÚN MIL", no "VEINTIUNO MIL".
 * Solo aplica cuando "uno" precede a MIL o MILLÓN; en posición final se
 * queda como "UNO" ("CIENTO UNO").
 */
function apocope(texto: string): string {
  if (texto.endsWith('VEINTIUNO')) return `${texto.slice(0, -9)}VEINTIÚN`
  if (texto.endsWith('UNO')) return `${texto.slice(0, -3)}UN`
  return texto
}

/** Parte entera en letras. Soporta hasta 999 999 999. */
export function enteroALetras(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new RangeError('Importe no representable.')
  const entero = Math.floor(n)
  if (entero === 0) return 'CERO'
  if (entero > 999_999_999) throw new RangeError('Importe fuera de rango.')

  const millones = Math.floor(entero / 1_000_000)
  const resto = entero % 1_000_000
  const miles = Math.floor(resto / 1000)
  const unidades = resto % 1000

  const partes: string[] = []

  if (millones === 1) partes.push('UN MILLÓN')
  else if (millones > 1) partes.push(`${apocope(tresDigitos(millones))} MILLONES`)

  if (miles === 1) partes.push('MIL') // "MIL", nunca "UN MIL"
  else if (miles > 1) partes.push(`${apocope(tresDigitos(miles))} MIL`)

  if (unidades > 0) partes.push(tresDigitos(unidades))

  return partes.join(' ')
}

/**
 * Importe completo tal como va impreso: `SON: TREINTA Y DOS CON 50/100 SOLES`.
 *
 * Los céntimos se escriben en cifras sobre 100 (la convención de SUNAT), no
 * en letras.
 */
export function montoALetras(monto: number, moneda = 'PEN'): string {
  const centavosTotales = aCentimos(monto)
  const entero = Math.floor(centavosTotales / 100)
  const centavos = centavosTotales % 100
  const nombre = MONEDAS[moneda] ?? moneda.toUpperCase()
  const signo = monto < 0 ? 'MENOS ' : ''
  return `SON: ${signo}${enteroALetras(entero)} CON ${String(centavos).padStart(2, '0')}/100 ${nombre}`
}
