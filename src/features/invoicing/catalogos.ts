import type { CustomerDocType, DocumentType, UnitType } from '@/generated/prisma/enums'

/**
 * Traducción de NUESTROS códigos a los catálogos que usa el comprobante.
 *
 * ⚠️ NORMATIVO: los códigos son los de UN/ECE Rec. 20 (unidades) y los
 * catálogos 01 (tipo de documento) y 06 (tipo de documento de identidad) de
 * SUNAT, tal como se conocen públicamente. SUNAT admite solo un SUBCONJUNTO
 * de las unidades de UN/ECE y esa lista cambia: hay que contrastarla con el
 * catálogo 03 vigente antes de emitir. Está anotado en docs/COMPLIANCE.md.
 */

/** Catálogo 03 (unidad de medida). PLANCHA no tiene un código propio claro: va como unidad. */
export const UNIDAD_SUNAT: Record<UnitType, string> = {
  UNIDAD: 'NIU',
  KILOGRAMO: 'KGM',
  GRAMO: 'GRM',
  METRO: 'MTR',
  CENTIMETRO: 'CMT',
  LITRO: 'LTR',
  GALON: 'GLL',
  CAJA: 'BX',
  PAQUETE: 'PK',
  DOCENA: 'DZN',
  MILLAR: 'MIL',
  ROLLO: 'RO',
  PLANCHA: 'NIU',
  BOLSA: 'BG',
  JUEGO: 'SET',
  PAR: 'PR',
  SERVICIO: 'ZZ',
}

/**
 * Catálogo 01. Las notas de venta y los tickets internos NO son comprobantes electrónicos.
 * ⚠️ 07 (nota de crédito) y 08 (nota de débito): pendiente de validación oficial (docs/COMPLIANCE.md §10).
 */
export function tipoComprobante(t: DocumentType): '01' | '03' | '07' | '08' | null {
  if (t === 'FACTURA') return '01'
  if (t === 'BOLETA') return '03'
  if (t === 'NOTA_CREDITO') return '07'
  if (t === 'NOTA_DEBITO') return '08'
  return null
}

/** Catálogo 06 (documento de identidad del adquirente). */
export const IDENTIDAD_SUNAT: Record<CustomerDocType, '0' | '1' | '4' | '6' | '7'> = {
  SIN_DOCUMENTO: '0',
  DNI: '1',
  CE: '4',
  RUC: '6',
  PASAPORTE: '7',
}
