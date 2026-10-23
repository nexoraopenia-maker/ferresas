import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Compara dos secretos en TIEMPO CONSTANTE y sin filtrar su longitud.
 *
 * `timingSafeEqual` exige buffers del mismo tamaño y, si se comprueba la longitud antes, el
 * tiempo de respuesta delata cuántos caracteres tiene el secreto. Se comparan los SHA-256 de
 * ambos: siempre 32 bytes, la misma comparación.
 */
export function secretosIguales(dado: string, esperado: string): boolean {
  const a = createHash('sha256').update(dado).digest()
  const b = createHash('sha256').update(esperado).digest()
  return timingSafeEqual(a, b)
}
