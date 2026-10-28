/**
 * Lector de CSV para la importación de catálogo.
 *
 * ─── POR QUÉ ESCRITO A MANO Y NO UNA DEPENDENCIA ─────────────────────────
 *
 * Las trampas del CSV real son contadas y todas comprobables: campos entre
 * comillas con el separador dentro, comillas escapadas duplicadas, saltos de
 * línea dentro de un campo, CRLF, BOM y separador variable. Son unas setenta
 * líneas con pruebas, y evitan meter una dependencia para algo tan acotado.
 *
 * ─── LA TRAMPA QUE MÁS DUELE ─────────────────────────────────────────────
 *
 * Excel en español EXPORTA CON PUNTO Y COMA, no con coma. Un lector que
 * asuma la coma lee todo el archivo como una sola columna y le dice al
 * ferretero que su catálogo está mal formado — cuando el archivo está
 * perfecto y el problema es el lector. Por eso el separador se DETECTA.
 *
 * Y el BOM: Excel lo pone al guardar como «CSV UTF-8», así que la primera
 * cabecera llega como "﻿nombre" y ninguna columna coincide. Se quita.
 */

export interface CsvTable {
  headers: string[]
  rows: string[][]
  delimiter: string
}

/** Separadores candidatos, en orden de probabilidad en la región. */
const CANDIDATOS = [';', ',', '\t', '|'] as const

/**
 * Detecta el separador contando apariciones FUERA de comillas en la primera
 * línea. Contarlas sin más elegiría la coma en `"Cemento, 42.5kg";"32.50"`.
 */
export function detectDelimiter(texto: string): string {
  const primeraLinea = texto.split(/\r?\n/)[0] ?? ''
  let mejor = ';'
  let maximo = -1

  for (const d of CANDIDATOS) {
    let cuenta = 0
    let enComillas = false
    for (let i = 0; i < primeraLinea.length; i++) {
      const c = primeraLinea[i]
      if (c === '"') {
        enComillas = !enComillas
      } else if (c === d && !enComillas) {
        cuenta++
      }
    }
    if (cuenta > maximo) {
      maximo = cuenta
      mejor = d
    }
  }
  return mejor
}

/**
 * Parsea el CSV completo. Recorre carácter a carácter porque partir por
 * líneas y luego por el separador rompe en cuanto un campo contiene un salto
 * de línea — y las descripciones de producto los contienen.
 */
export function parseCsv(entrada: string, delimiter?: string): CsvTable {
  // BOM de Excel.
  const texto = entrada.replace(/^﻿/, '')
  const d = delimiter ?? detectDelimiter(texto)

  const filas: string[][] = []
  let campos: string[] = []
  let actual = ''
  let enComillas = false
  let i = 0

  while (i < texto.length) {
    const c = texto[i]!

    if (enComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          // Comilla escapada: "" dentro de un campo entre comillas.
          actual += '"'
          i += 2
          continue
        }
        enComillas = false
        i++
        continue
      }
      actual += c
      i++
      continue
    }

    if (c === '"') {
      enComillas = true
      i++
      continue
    }

    if (c === d) {
      campos.push(actual)
      actual = ''
      i++
      continue
    }

    if (c === '\r') {
      // CRLF o CR suelto: en ambos casos termina la fila.
      if (texto[i + 1] === '\n') i++
      campos.push(actual)
      filas.push(campos)
      campos = []
      actual = ''
      i++
      continue
    }

    if (c === '\n') {
      campos.push(actual)
      filas.push(campos)
      campos = []
      actual = ''
      i++
      continue
    }

    actual += c
    i++
  }

  // Último campo y última fila, si el archivo no termina en salto de línea.
  if (actual !== '' || campos.length > 0) {
    campos.push(actual)
    filas.push(campos)
  }

  // Se descartan las filas totalmente vacías: Excel añade una al final y a
  // veces deja huecos en medio, y no son errores del usuario.
  const utiles = filas.filter((f) => f.some((c) => c.trim() !== ''))

  const headers = (utiles[0] ?? []).map((h) => h.trim().toLowerCase())
  return { headers, rows: utiles.slice(1), delimiter: d }
}

/**
 * Traduce las cabeceras del archivo a los campos del sistema.
 *
 * Acepta varios nombres por campo porque nadie va a renombrar las columnas
 * de su inventario para encajar con nuestro esquema: si el archivo dice
 * «precio» o «p. venta», se entiende igual. Exigir cabeceras exactas es la
 * forma más rápida de que el ferretero abandone la importación.
 */
const ALIAS: Record<string, string[]> = {
  name: ['nombre', 'producto', 'descripcion', 'descripción', 'detalle', 'articulo', 'artículo', 'name'],
  sku: ['sku', 'codigo', 'código', 'codigo interno', 'cod', 'clave'],
  barcode: ['barcode', 'codigo de barras', 'código de barras', 'ean', 'upc', 'barras'],
  qrCode: ['qr', 'qrcode', 'codigo qr', 'código qr'],
  unitType: ['unidad', 'unidad de medida', 'medida', 'um', 'unittype'],
  salePrice: ['precio', 'precio venta', 'precio de venta', 'p. venta', 'pvp', 'saleprice', 'venta'],
  costPrice: ['costo', 'precio costo', 'precio de costo', 'p. costo', 'costprice', 'compra'],
  stock: ['stock', 'cantidad', 'existencia', 'existencias', 'inventario', 'saldo'],
  minStock: ['minimo', 'mínimo', 'stock minimo', 'stock mínimo', 'min', 'minstock', 'alerta'],
  maxStock: ['maximo', 'máximo', 'stock maximo', 'stock máximo', 'max', 'maxstock'],
}

export interface ColumnMap {
  /** campo del sistema -> índice de la columna en el archivo */
  indices: Partial<Record<keyof typeof ALIAS, number>>
  /** Cabeceras del archivo que no se reconocieron. */
  ignoradas: string[]
}

export function mapColumns(entrada: string[]): ColumnMap {
  // Se normaliza AQUÍ y no solo en parseCsv: la función debe ser correcta
  // por sí sola, no depender de que la llamen después de parsear.
  const headers = entrada.map((h) => h.replace(/^\uFEFF/, '').trim().toLowerCase())
  const indices: Record<string, number> = {}
  const usadas = new Set<number>()

  for (const [campo, nombres] of Object.entries(ALIAS)) {
    const idx = headers.findIndex((h, i) => !usadas.has(i) && nombres.includes(h))
    if (idx >= 0) {
      indices[campo] = idx
      usadas.add(idx)
    }
  }

  const ignoradas = entrada.filter((h, i) => !usadas.has(i) && h.trim() !== '')
  return { indices: indices as ColumnMap['indices'], ignoradas }
}

/** Unidades aceptadas en el archivo, con sus abreviaturas habituales. */
const UNIDADES: Record<string, string> = {
  und: 'UNIDAD', unidad: 'UNIDAD', unidades: 'UNIDAD', pza: 'UNIDAD', pieza: 'UNIDAD',
  kg: 'KILOGRAMO', kilo: 'KILOGRAMO', kilos: 'KILOGRAMO', kilogramo: 'KILOGRAMO',
  g: 'GRAMO', gr: 'GRAMO', gramo: 'GRAMO', gramos: 'GRAMO',
  m: 'METRO', metro: 'METRO', metros: 'METRO', ml: 'METRO',
  cm: 'CENTIMETRO', centimetro: 'CENTIMETRO', 'centímetro': 'CENTIMETRO',
  l: 'LITRO', lt: 'LITRO', litro: 'LITRO', litros: 'LITRO',
  gal: 'GALON', galon: 'GALON', 'galón': 'GALON', galones: 'GALON',
  caja: 'CAJA', cj: 'CAJA', cajas: 'CAJA',
  paq: 'PAQUETE', paquete: 'PAQUETE', pack: 'PAQUETE',
  dcn: 'DOCENA', docena: 'DOCENA', doc: 'DOCENA',
  mil: 'MILLAR', millar: 'MILLAR',
  rollo: 'ROLLO', rollos: 'ROLLO',
  plancha: 'PLANCHA', planchas: 'PLANCHA',
  bolsa: 'BOLSA', bolsas: 'BOLSA', bls: 'BOLSA',
  juego: 'JUEGO', jgo: 'JUEGO', set: 'JUEGO',
  par: 'PAR', pares: 'PAR',
  serv: 'SERVICIO', servicio: 'SERVICIO',
}

export function normalizeUnit(valor: string | undefined): string | null {
  if (!valor) return null
  const limpio = valor.trim().toLowerCase().replace(/\.$/, '')
  if (limpio === '') return null
  return UNIDADES[limpio] ?? null
}

/**
 * Convierte un valor del archivo a número.
 *
 * ─── UNA AMBIGÜEDAD QUE NO SE PUEDE RESOLVER A CIEGAS ────────────────────
 *
 * "1.200" puede ser mil doscientos (punto de miles, como se escribe en Perú)
 * o uno punto dos. No hay forma de saberlo mirando solo la cadena.
 *
 * Lo que SÍ se sabe es qué columna se está leyendo, y eso lo decide:
 *
 *   · En un PRECIO, tres decimales no existen en la práctica. "1.200" es
 *     mil doscientos, y leerlo como 1.20 pondría el producto a la venta a
 *     un sol veinte — el ferretero vendería a pérdida sin notarlo.
 *
 *   · En una CANTIDAD, tres decimales son lo normal: "0.250" son 250 gramos
 *     de clavos. Leerlo como 250 metería 250 kg en el inventario.
 *
 * Por eso el tipo de columna es un parámetro y no un detalle. Aun así, el
 * valor interpretado se muestra en la vista previa: ante una ambigüedad, que
 * decida quien conoce su catálogo.
 */
export type AmountKind = 'money' | 'quantity'

export function parseAmount(
  valor: string | undefined,
  kind: AmountKind = 'money',
): number | null {
  if (valor === undefined) return null
  let s = valor.trim().replace(/\s/g, '').replace(/^S\/\.?/i, '').replace(/^\$/, '')
  if (s === '') return null

  const ultimaComa = s.lastIndexOf(',')
  const ultimoPunto = s.lastIndexOf('.')

  /** ¿Un separador suelto con 3 cifras detrás son miles o decimales? */
  const sonMiles = (resto: string) => {
    if (resto.length !== 3) return false
    // En cantidades, 3 decimales son legítimos (0.250 kg).
    if (kind === 'quantity') return false
    return true
  }

  if (ultimaComa >= 0 && ultimoPunto >= 0) {
    // Hay de los dos: el último manda como decimal, el otro son miles.
    if (ultimaComa > ultimoPunto) {
      s = s.replace(/\./g, '').replace(',', '.')
    } else {
      s = s.replace(/,/g, '')
    }
  } else if (ultimaComa >= 0) {
    const trozos = s.split(',')
    s = trozos.length > 2 || sonMiles(trozos[trozos.length - 1]!)
      ? s.replace(/,/g, '')
      : s.replace(',', '.')
  } else if (ultimoPunto >= 0) {
    const trozos = s.split('.')
    // Varios puntos siempre son miles: "1.234.567".
    if (trozos.length > 2 || sonMiles(trozos[trozos.length - 1]!)) {
      s = s.replace(/\./g, '')
    }
  }

  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
