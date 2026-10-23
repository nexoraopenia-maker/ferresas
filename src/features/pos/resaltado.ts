/**
 * Piezas puras del autocompletado del POS: variantes con tilde para consultar
 * la base y troceado del texto para resaltar la coincidencia.
 */

export const sinTildes = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

const CON_TILDE: Record<string, string[]> = {
  a: ['á'], e: ['é'], i: ['í'], o: ['ó'], u: ['ú', 'ü'], n: ['ñ'],
}

/**
 * Formas en que pudo guardarse una palabra que alguien tecleó sin tildes.
 *
 * `contains … insensitive` de la base ignora mayúsculas pero NO tildes: «presion»
 * no encuentra «presión». Se parte de la palabra SIN tildes y se genera la
 * original, luego una variante por cada vocal (o ñ) con marca y luego las
 * combinaciones de DOS marcas («cañería» = ñ + í). Más de dos en una palabra es
 * raro y haría crecer la consulta sin control, de ahí el `tope`. Si el catálogo
 * guardó la palabra sin tilde, la original también está en la lista.
 */
export function variantesConTilde(palabra: string, tope = 24): string[] {
  const base = sinTildes(palabra)
  const salida = new Set<string>([base])
  const sustituciones: Array<[number, string]> = []
  for (let i = 0; i < base.length; i++) {
    for (const v of CON_TILDE[base[i]!] ?? []) sustituciones.push([i, v])
  }
  for (const [i, v] of sustituciones) {
    if (salida.size >= tope) break
    salida.add(base.slice(0, i) + v + base.slice(i + 1))
  }
  for (let x = 0; x < sustituciones.length && salida.size < tope; x++) {
    for (let y = x + 1; y < sustituciones.length && salida.size < tope; y++) {
      const [i, v] = sustituciones[x]!
      const [j, w] = sustituciones[y]!
      if (i === j) continue
      const c = base.split('')
      c[i] = v
      c[j] = w
      salida.add(c.join(''))
    }
  }
  return [...salida]
}

export interface Trozo { texto: string; coincide: boolean }

/**
 * Parte `texto` en trozos marcando los que coinciden con alguna palabra
 * buscada, sin importar tildes ni mayúsculas. Los índices se mapean al texto
 * ORIGINAL, así que lo que se muestra conserva sus tildes y su forma.
 */
export function trocearResaltado(texto: string, buscadas: readonly string[]): Trozo[] {
  const claves = buscadas.map(sinTildes).filter((p) => p.length > 0)
  if (!texto || claves.length === 0) return [{ texto, coincide: false }]

  // Texto normalizado carácter a carácter, recordando de qué carácter original viene.
  let norm = ''
  const origen: number[] = []
  let k = 0
  for (const ch of texto) {
    const n = sinTildes(ch)
    for (let j = 0; j < n.length; j++) origen.push(k)
    norm += n
    k += ch.length
  }

  const marcado = new Array<boolean>(texto.length).fill(false)
  for (const clave of claves) {
    for (let desde = norm.indexOf(clave); desde !== -1; desde = norm.indexOf(clave, desde + 1)) {
      const ini = origen[desde]!
      const fin = (origen[desde + clave.length - 1] ?? texto.length - 1)
      // El último carácter original puede ocupar más de una unidad (pares sustitutos).
      let hasta = fin + 1
      while (hasta < texto.length && texto.charCodeAt(hasta) >= 0xdc00 && texto.charCodeAt(hasta) <= 0xdfff) hasta++
      for (let x = ini; x < hasta; x++) marcado[x] = true
    }
  }

  const trozos: Trozo[] = []
  for (let x = 0; x < texto.length; x++) {
    const ultimo = trozos[trozos.length - 1]
    if (ultimo && ultimo.coincide === marcado[x]) ultimo.texto += texto[x]
    else trozos.push({ texto: texto[x]!, coincide: marcado[x]! })
  }
  return trozos
}
