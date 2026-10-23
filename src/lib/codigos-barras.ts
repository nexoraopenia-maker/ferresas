/**
 * Validación de lecturas de códigos de barras (puro).
 *
 * Una cámara de celular lee a veces un dígito mal: un EAN-13 con el dígito de
 * control equivocado se parece a un producto real... que no es el que se
 * apuntó. El dígito de control existe justo para descartar esas lecturas.
 */

export type FormatoLectura =
  | 'ean_13' | 'ean_8' | 'upc_a' | 'upc_e' | 'code_128' | 'code_39' | 'itf' | 'qr_code' | 'otro'

/** Dígito de control GS1 (EAN-8, UPC-A, EAN-13): pesos 3 y 1 alternados desde la derecha. */
export function digitoControlGs1(cuerpo: string): number {
  let suma = 0
  for (let i = 0; i < cuerpo.length; i++) {
    const d = Number(cuerpo[cuerpo.length - 1 - i])
    suma += i % 2 === 0 ? d * 3 : d
  }
  return (10 - (suma % 10)) % 10
}

export function esGs1Valido(codigo: string, largo: 8 | 12 | 13): boolean {
  if (!new RegExp(`^\\d{${largo}}$`).test(codigo)) return false
  return digitoControlGs1(codigo.slice(0, -1)) === Number(codigo[largo - 1])
}

/**
 * ¿Se acepta esta lectura? Los formatos con dígito de control se validan; el
 * resto (Code128, QR, ITF…) no lo tienen y se aceptan tal cual.
 */
export function lecturaValida(codigo: string, formato: FormatoLectura): boolean {
  const c = codigo.trim()
  if (!c) return false
  switch (formato) {
    case 'ean_13': return esGs1Valido(c, 13)
    case 'ean_8': return esGs1Valido(c, 8)
    case 'upc_a': return esGs1Valido(c, 12)
    default: return true
  }
}

/** Nombre del formato de BarcodeDetector → el nuestro. */
export function formatoDeDetector(nombre: string): FormatoLectura {
  const n = nombre.toLowerCase()
  const conocidos: FormatoLectura[] = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code']
  return (conocidos as string[]).includes(n) ? (n as FormatoLectura) : 'otro'
}

export interface UltimaLectura { code: string; seen: number }

/**
 * Anti-rebote del escáner. El mismo código frente a la cámara se lee ~10 veces
 * por segundo; cada avistamiento RENUEVA la ventana, así que sostener el código
 * no suma otra unidad: hay que dejar de verlo `ventanaMs` para volver a contarlo.
 * Muta `seen` de la última lectura cuando es una repetición.
 */
export function esRepeticion(
  ultima: UltimaLectura | null, code: string, ahora: number, ventanaMs: number,
): boolean {
  if (ultima && ultima.code === code && ahora - ultima.seen < ventanaMs) {
    ultima.seen = ahora
    return true
  }
  return false
}
