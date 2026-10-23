/**
 * Series de documentos por sucursal.
 *
 * ─── EL PROBLEMA QUE RESUELVE ────────────────────────────────────────────
 *
 * Un correlativo sin huecos no basta cuando hay varios locales. Si dos
 * sucursales emiten boletas con la serie "B001", cada una lleva su propio
 * contador y ambas producen B001-00000001: dos comprobantes distintos con el
 * mismo número bajo el mismo RUC. Eso no es un duplicado molesto, es una
 * contingencia tributaria.
 *
 * La solución es que la serie SALGA de la sucursal y no se pueda elegir a
 * mano: cada sucursal tiene un `seriesNumber` de 1 a 999, único dentro del
 * tenant por índice de base de datos, y la serie se deriva de él. Dos
 * sucursales no pueden colisionar porque no pueden compartir el número.
 *
 * ─── POR QUÉ ESTO NO ROMPIÓ NADA ─────────────────────────────────────────
 *
 * La sucursal que creó la migración para los datos existentes lleva
 * seriesNumber = 1, y de ahí sale exactamente la serie "001" (y "B001",
 * "F001") que ya estaban en uso. La retrocompatibilidad no es casualidad:
 * es el motivo de que el número arranque en 1 y no en 0.
 */

import { BusinessError } from '@/lib/errors'

export type CounterScope =
  | 'SALE'
  | 'QUOTE'
  | 'ORDER'
  | 'PURCHASE'
  | 'TRANSFER'
  | 'TAX_BOLETA'
  | 'TAX_FACTURA'
  | 'GUIA_REMISION'

/**
 * Dos convenciones conviven porque los documentos tributarios y los internos
 * se numeran distinto en Perú:
 *
 *   · Tributarios: la letra va DENTRO de la serie — serie "B001", y el número
 *     impreso es "B001-00000123". Es la forma que exige SUNAT.
 *   · Internos: la letra es un prefijo — serie "001", prefijo "V", número
 *     "V001-00000123". No los regula nadie, pero el formato impreso coincide.
 */
const CONFIG: Record<CounterScope, { letra: string; letraEnSerie: boolean }> = {
  SALE: { letra: 'V', letraEnSerie: false },
  QUOTE: { letra: 'C', letraEnSerie: false },
  // Pedidos a caja. La «P» ya es de las compras.
  ORDER: { letra: 'O', letraEnSerie: false },
  PURCHASE: { letra: 'P', letraEnSerie: false },
  TRANSFER: { letra: 'T', letraEnSerie: false },
  TAX_BOLETA: { letra: 'B', letraEnSerie: true },
  TAX_FACTURA: { letra: 'F', letraEnSerie: true },
  // Guía de Remisión electrónica: T001. (La «T» de TRANSFER no choca: es otro scope y no lleva letra en la serie.)
  GUIA_REMISION: { letra: 'T', letraEnSerie: true },
}

export const SERIES_NUMBER_MIN = 1
export const SERIES_NUMBER_MAX = 999

/** Serie y prefijo que le corresponden a una sucursal para un tipo de documento. */
export function serieDeSucursal(
  scope: CounterScope,
  seriesNumber: number,
): { series: string; prefix: string } {
  if (
    !Number.isInteger(seriesNumber) ||
    seriesNumber < SERIES_NUMBER_MIN ||
    seriesNumber > SERIES_NUMBER_MAX
  ) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      `El número de serie de la sucursal debe estar entre ${SERIES_NUMBER_MIN} y ${SERIES_NUMBER_MAX}.`,
      { seriesNumber },
    )
  }

  const cfg = CONFIG[scope]
  if (!cfg) {
    throw new BusinessError('INVALID_DOCUMENT', `Tipo de documento desconocido: ${scope}.`)
  }

  const digitos = String(seriesNumber).padStart(3, '0')
  return cfg.letraEnSerie
    ? { series: `${cfg.letra}${digitos}`, prefix: '' }
    : { series: digitos, prefix: cfg.letra }
}

/** Scope del contador para un comprobante tributario. */
export function scopeTributario(documentType: 'BOLETA' | 'FACTURA'): CounterScope {
  return documentType === 'BOLETA' ? 'TAX_BOLETA' : 'TAX_FACTURA'
}

/**
 * Siguiente número de serie libre, dado los que ya están en uso.
 *
 * Reutiliza huecos a propósito: si existían las sucursales 1, 2 y 3 y se dio
 * de baja la 2, la siguiente sucursal toma el 2. El índice único lo permite
 * porque la baja es lógica pero la fila sigue ahí... y precisamente por eso
 * hay que contar las DADAS DE BAJA también: su serie quedó quemada con los
 * comprobantes que emitió y no se puede reasignar.
 */
export function siguienteSeriesNumber(enUso: readonly number[]): number {
  const usados = new Set(enUso)
  for (let n = SERIES_NUMBER_MIN; n <= SERIES_NUMBER_MAX; n++) {
    if (!usados.has(n)) return n
  }
  throw new BusinessError(
    'PLAN_LIMIT_REACHED',
    `No quedan series libres: el máximo es ${SERIES_NUMBER_MAX} sucursales por negocio.`,
  )
}
