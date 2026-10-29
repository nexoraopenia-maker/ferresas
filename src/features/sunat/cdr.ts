/**
 * Constancia de Recepción (CDR): el `ApplicationResponse` que SUNAT devuelve dentro de un ZIP.
 *
 * Lectura mínima y tolerante a prefijos de espacio de nombres. ⚠️ La estructura exacta (dónde van el código, la
 * descripción y las observaciones) es lo que entendemos de la guía de SUNAT, sin validar contra un CDR real: se
 * confirma con el primer CDR del ambiente beta.
 */

export interface Cdr {
  /** "0" = aceptado. Otros: ver `categoriaDeCodigo`. */
  codigo: string
  descripcion: string
  /** Comprobante al que responde, "F001-7". */
  referencia: string | null
  /** Observaciones (`cbc:Note`). */
  notas: string[]
}

const etiqueta = (xml: string, nombre: string) =>
  new RegExp(`<(?:[A-Za-z0-9_-]+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${nombre}>`).exec(xml)?.[1]
const desescapar = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim()

export class CdrIlegible extends Error {
  constructor() { super('El CDR no se pudo interpretar.'); this.name = 'CdrIlegible' }
}

export function leerCdr(xml: string): Cdr {
  const respuesta = etiqueta(xml, 'DocumentResponse')
  const codigo = respuesta ? etiqueta(respuesta, 'ResponseCode') : undefined
  if (codigo === undefined || !/^\d{1,5}$/.test(desescapar(codigo))) throw new CdrIlegible()
  const notas = [...xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?Note(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?Note>/g)].map((m) => desescapar(m[1]!)).filter(Boolean)
  return {
    codigo: desescapar(codigo),
    descripcion: desescapar(etiqueta(respuesta!, 'Description') ?? ''),
    referencia: respuesta ? desescapar(etiqueta(respuesta, 'ReferenceID') ?? '') || null : null,
    notas,
  }
}

export type CategoriaCodigo = 'aceptado' | 'observado' | 'rechazado' | 'configuracion' | 'servidor' | 'excepcion'

/**
 * ⚠️ RANGOS DE CÓDIGOS, de memoria y SIN verificar en la fuente oficial: 0 aceptado; 4000 en adelante, aceptado con
 * observaciones; 2000-3999, rechazo; 0100-0199, problemas de acceso o de configuración (usuario, clave, perfil), y el
 * resto de los de excepción (0200-1999), error en el contenido que se corrige y se vuelve a enviar. Cada rango se
 * confirma contra la tabla oficial de códigos de error antes de quitar el ⚠️.
 */
export function categoriaDeCodigo(codigo: string): CategoriaCodigo {
  const n = Number(codigo)
  if (!Number.isInteger(n) || n < 0) return 'excepcion'
  if (n === 0) return 'aceptado'
  if (n >= 4000) return 'observado'
  if (n >= 2000) return 'rechazado'
  if (n >= 100 && n < 200) return 'configuracion'
  return 'excepcion'
}

/**
 * ⚠️ CÓDIGOS DE FALLO DE ACCESO (usuario o clave SOL incorrectos, usuario inexistente o inactivo, encabezado de seguridad mal formado), de memoria y SIN
 * verificar en la tabla oficial de errores. Es MÁS ESTRECHA que la categoría `configuracion` (0100–0199) a propósito: «el comprobante no existe» u otro fallo
 * de contenido también cae en 01xx y NO significa que las credenciales estén mal. La usa la prueba de conexión (docs/SUNAT-SUPUESTOS.md #13).
 */
export const CODIGOS_DE_ACCESO: readonly string[] = ['0101', '0102', '0103', '0104', '0105', '0106']

export const esFalloDeAcceso = (codigo: string | null | undefined): boolean => codigo != null && CODIGOS_DE_ACCESO.includes(codigo.padStart(4, '0'))
