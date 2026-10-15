/**
 * Cantidades decimales para venta a granel.
 *
 * ─── EL BUG QUE ESTO ARREGLA ─────────────────────────────────────────────
 *
 * Los inputs guardaban un `number` en el estado y hacían
 * `Number(e.target.value)` en cada tecla. Teclear "1." daba `Number("1.")`
 * === 1, el estado pasaba a 1, el input se repintaba con "1" y el punto
 * desaparecía. El resultado es que era IMPOSIBLE escribir 1.5: el separador
 * nunca sobrevivía a la siguiente pulsación.
 *
 * La solución es guardar la CADENA mientras se edita y convertir solo al
 * confirmar. Estados como "", "0." o "1," son intermedios válidos y tienen
 * que poder existir.
 *
 * El backend ya aceptaba decimales (Decimal(14,4) en el esquema y hasta 4
 * cifras en Zod): el fallo era solo de interfaz.
 */

/** Tope del esquema: Decimal(14,4). */
export const MAX_DECIMALES = 4

/**
 * Unidades que se venden fraccionadas. Determina los atajos y cuántos
 * decimales se muestran: nadie vende 2.5 martillos, pero 2.5 m de cable es
 * lo normal.
 */
const UNIDADES_GRANEL = new Set([
  'KILOGRAMO', 'GRAMO', 'METRO', 'CENTIMETRO', 'LITRO', 'GALON', 'ROLLO',
])

export function isBulkUnit(unitType: string): boolean {
  return UNIDADES_GRANEL.has(unitType)
}

/**
 * ¿Es un estado intermedio válido mientras se teclea?
 *
 * Acepta la cadena vacía, un separador suelto y un número a medio escribir.
 * Sin esto, el input bloquearía la pulsación del punto.
 */
export function isPartialQuantity(raw: string): boolean {
  return /^$|^[.,]$|^\d*[.,]?\d*$/.test(raw.trim())
}

/**
 * Convierte lo tecleado a número, o `null` si aún no es un número completo.
 *
 * Acepta coma Y punto como separador decimal: en Perú se usan los dos, y el
 * teclado numérico del móvil ofrece uno u otro según el dispositivo. Obligar
 * al punto haría que media gente no pudiera escribir 0,250.
 */
export function parseQuantity(raw: string): number | null {
  const limpio = raw.trim().replace(',', '.')
  if (limpio === '' || limpio === '.') return null
  const n = Number(limpio)
  if (!Number.isFinite(n) || n < 0) return null
  return redondear(n)
}

/** Redondea al tope de decimales del esquema, sin deriva de coma flotante. */
export function redondear(n: number, decimales = MAX_DECIMALES): number {
  const f = 10 ** decimales
  return Math.round(n * f) / f
}

/**
 * Recorta lo tecleado al máximo de decimales, en vez de rechazar la tecla.
 *
 * Rechazar haría que el input se sintiera roto —la tecla no hace nada y no
 * se explica por qué—. Recortando, el usuario ve que el quinto decimal no
 * entra y lo entiende solo.
 */
export function limitarDecimales(raw: string): string {
  const m = raw.match(/^(\d*)([.,])(\d*)$/)
  if (!m) return raw
  const [, enteros, sep, decs] = m
  return `${enteros}${sep}${(decs ?? '').slice(0, MAX_DECIMALES)}`
}

/**
 * Formatea para mostrar. Las unidades discretas no arrastran ceros: "3"
 * en vez de "3.000", que en un ticket se lee como un precio.
 */
export function formatQuantity(n: number, unitType: string): string {
  if (!isBulkUnit(unitType)) {
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '')
  }
  // A granel: hasta 3 decimales, sin ceros de relleno a la derecha.
  return n.toFixed(3).replace(/\.?0+$/, '') || '0'
}

/**
 * Atajos de cantidad según la unidad.
 *
 * Los de antes eran +1/+5/+10/+25 para todo. Para clavos al peso eso es
 * inútil: nadie compra 25 kg de clavos de un botón, compra 0.25. Y para
 * cable, 0.5 m no existe en incrementos de 1.
 */
export function stepsFor(unitType: string): number[] {
  switch (unitType) {
    case 'KILOGRAMO':
      return [0.1, 0.25, 0.5, 1]
    case 'GRAMO':
      return [50, 100, 250, 500]
    case 'METRO':
      return [0.5, 1, 5, 10]
    case 'CENTIMETRO':
      return [10, 25, 50, 100]
    case 'LITRO':
    case 'GALON':
      return [0.25, 0.5, 1, 5]
    case 'ROLLO':
      return [0.5, 1, 2, 5]
    default:
      return [1, 5, 10, 25]
  }
}

/** Incremento de los botones − / + según la unidad. */
export function stepFor(unitType: string): number {
  if (!isBulkUnit(unitType)) return 1
  switch (unitType) {
    case 'GRAMO':
      return 50
    case 'CENTIMETRO':
      return 10
    case 'KILOGRAMO':
    case 'LITRO':
    case 'GALON':
      return 0.25
    default:
      return 0.5
  }
}

/** Abreviatura para el ticket y las etiquetas. */
export function unitLabel(unitType: string): string {
  const abrev: Record<string, string> = {
    UNIDAD: 'und', KILOGRAMO: 'kg', GRAMO: 'g', METRO: 'm',
    CENTIMETRO: 'cm', LITRO: 'L', GALON: 'gal', CAJA: 'caja',
    PAQUETE: 'paq', DOCENA: 'dcn', MILLAR: 'mil', ROLLO: 'rollo',
    PLANCHA: 'plancha', BOLSA: 'bolsa', JUEGO: 'juego', PAR: 'par',
    SERVICIO: 'serv',
  }
  return abrev[unitType] ?? unitType.toLowerCase()
}
