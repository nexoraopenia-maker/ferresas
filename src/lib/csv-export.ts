/**
 * Generador de CSV para descargas que se abren en Excel (es-PE).
 *
 *  · Separador «;» y BOM UTF-8: Excel en español separa por punto y coma, y sin el BOM rompe tildes y la «ñ».
 *  · Saltos CRLF y campos entre comillas cuando llevan separador, comillas o saltos de línea.
 *  · INYECCIÓN DE FÓRMULAS: una celda de TEXTO que empieza por «=», «+», «-», «@», tabulador o retorno se interpreta como fórmula en
 *    Excel (`=HYPERLINK(...)`, `=cmd|...`). El nombre de un cliente lo teclea cualquiera, así que se antepone un apóstrofo para que se
 *    lea como texto. Los NÚMEROS y los montos no pasan por ahí: un saldo negativo legítimo sigue siendo un número.
 *  · Los montos siempre con 2 decimales y punto decimal, sin separador de miles.
 */

export type CeldaCsv = string | number | null | undefined | { monto: number }

const PELIGROSA = /^[=+\-@\t\r]/

export function celdaCsv(valor: CeldaCsv, separador = ';'): string {
  if (valor === null || valor === undefined) return ''
  let texto: string
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) return ''
    texto = String(valor)
  } else if (typeof valor === 'object') {
    if (!Number.isFinite(valor.monto)) return ''
    texto = valor.monto.toFixed(2)
  } else {
    texto = PELIGROSA.test(valor) ? `'${valor}` : valor
  }
  return texto.includes(separador) || /["\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto
}

export function generarCsv(cabecera: readonly string[], filas: readonly (readonly CeldaCsv[])[], separador = ';'): string {
  const linea = (f: readonly CeldaCsv[]) => f.map((c) => celdaCsv(c, separador)).join(separador)
  return `\uFEFF${[cabecera, ...filas].map(linea).join('\r\n')}\r\n`
}
