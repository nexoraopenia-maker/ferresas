/**
 * Las reglas PURAS de la revisión de un conteo (F6.5b): la diferencia relativa y los umbrales operativos. Sin base de datos ni React.
 *
 *  · diferencia = contado − sistema al contar (el saldo del kardex a la hora de la última pasada vigente). Positiva = sobrante; negativa = faltante.
 *  · Umbrales ⚠️ OPERATIVOS (a validar con el contador): una diferencia es «grande» si su valor, al costo promedio vigente, es MAYOR que S/ 200, o si es MAYOR que el
 *    10 % de lo que el sistema esperaba. Se compara en enteros (diezmilésimas y BigInt): sin céntimos de más ni de menos por coma flotante. Cuando el sistema esperaba cero
 *    y se contó algo, el porcentaje no está definido y cuenta como grande.
 *  · Sin costo (costo ≤ 0) el valor no se puede calcular: la línea se marca «sin costo» y la regla del valor no aplica (la del porcentaje sí).
 */

export const UMBRAL_VALOR_DIFERENCIA = 200
export const UMBRAL_PORCENTAJE_DIFERENCIA = 0.1
/** Líneas que se aprueban o aplican por tanda: una tanda es una transacción (bloquea esas filas de stock mientras dura). */
export const LOTE_APLICACION = 500
export const LOTE_APROBACION = 500

const DIEZMIL = 10_000
const aDiezmilesimas = (n: number): bigint => BigInt(Math.round(n * DIEZMIL))
const r4 = (n: number): number => Math.round(n * DIEZMIL) / DIEZMIL
const r2 = (n: number): number => Math.round(n * 100) / 100

/** contado − sistema, en 4 decimales exactos. */
export const diferenciaDeConteo = (contado: number, sistema: number): number => Number(aDiezmilesimas(contado) - aDiezmilesimas(sistema)) / DIEZMIL

/** El stock que queda al aplicar una diferencia sobre el stock de AHORA (las ventas hechas después de contar se conservan). */
export const stockTrasAplicar = (actual: number, diferencia: number): number => r4(actual + diferencia)

export type CausaUmbral = 'PORCENTAJE' | 'VALOR'

export interface EvaluacionLinea {
  diferencia: number
  /** |diferencia| / |sistema|; `null` si el sistema esperaba cero (indefinido). */
  porcentaje: number | null
  /** |diferencia| × costo, en soles con 2 decimales; `null` sin costo. */
  valor: number | null
  sinCosto: boolean
  sobrePorcentaje: boolean
  sobreValor: boolean
  sobreUmbral: boolean
  causas: CausaUmbral[]
}

export function evaluarLinea(e: { contado: number; sistema: number; costo: number | null }): EvaluacionLinea {
  const d = aDiezmilesimas(e.contado) - aDiezmilesimas(e.sistema)
  const diferencia = Number(d) / DIEZMIL
  const abs = d < 0n ? -d : d
  const sis = aDiezmilesimas(e.sistema)
  const sisAbs = sis < 0n ? -sis : sis
  const sinCosto = e.costo === null || !(e.costo > 0)

  // |d| / |s| > 10 %  ⇔  10·|d| > |s|   (todo en enteros)
  const porcentaje = sisAbs === 0n ? (abs === 0n ? 0 : null) : Number(abs) / Number(sisAbs)
  const sobrePorcentaje = abs !== 0n && (sisAbs === 0n ? true : abs * 10n > sisAbs)

  // valor = |d|/10^4 × costo > 200  ⇔  |d| × costo(10^4) > 200 × 10^8
  let valor: number | null = null
  let sobreValor = false
  if (!sinCosto) {
    const costoM = aDiezmilesimas(e.costo as number)
    valor = r2((Number(abs) / DIEZMIL) * (e.costo as number))
    sobreValor = abs * costoM > BigInt(UMBRAL_VALOR_DIFERENCIA) * BigInt(DIEZMIL) * BigInt(DIEZMIL)
  }
  const causas: CausaUmbral[] = []
  if (sobrePorcentaje) causas.push('PORCENTAJE')
  if (sobreValor) causas.push('VALOR')
  return { diferencia, porcentaje, valor, sinCosto, sobrePorcentaje, sobreValor, sobreUmbral: causas.length > 0, causas }
}
