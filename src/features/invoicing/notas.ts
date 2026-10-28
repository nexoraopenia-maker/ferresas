import { BusinessError } from '@/lib/errors'
import { tipoComprobante } from './catalogos'
import type { ComprobanteFiscal } from './providers/types'

/**
 * Reglas para enviar una NOTA de crédito o de débito. Funciones PURAS: no tocan la base.
 *
 * ⚠️ Todo lo normativo de aquí (series, códigos del motivo, que el original deba estar aceptado) está
 * pendiente de validación oficial: ver docs/COMPLIANCE.md §10. Son las reglas que CONSTRUIMOS, no las de SUNAT.
 */

/**
 * La nota llegó antes de que el comprobante original esté aceptado: depende de él y no puede salir todavía.
 * NO es un fallo de la nota: la cola la libera SIN gastar el intento y vuelve a mirar más tarde.
 */
export class NotaEsperaOriginal extends Error {
  constructor(mensaje: string) { super(mensaje); this.name = 'NotaEsperaOriginal' }
}

/**
 * ⚠️ Temporal (fase 1A.3): solo notas de crédito TOTALES, cuyas líneas son las de la venta original.
 * Descuentos, devoluciones por ítem y ajustes necesitan líneas propias (`TaxDocumentItem`, fase 1A.3b).
 * 01 anulación de la operación · 02 anulación por error en el RUC · 06 devolución total.
 */
export const CODIGOS_NOTA_CREDITO_TOTAL: readonly string[] = ['01', '02', '06']

/**
 * Notas de crédito PARCIALES (F6.2): llevan líneas propias (`tax_document_items`) y un importe menor o igual que el del original.
 * 07 devolución por ítem. ⚠️ Código sin validar con SUNAT ni con el contador (docs/COMPLIANCE.md §10).
 */
export const CODIGOS_NOTA_CREDITO_PARCIAL: readonly string[] = ['07']

export interface NotaParaEnviar {
  documentType: 'NOTA_CREDITO' | 'NOTA_DEBITO'
  series: string
  isTrial: boolean
  total: number
  currency: string
  reasonCode: string | null
  reasonDescription: string | null
  relatedDocument: {
    documentType: string
    series: string
    correlativo: number
    status: string
    isTrial: boolean
    total: number
    currency: string
  } | null
}

const invalida = (m: string) => new BusinessError('INVALID_DOCUMENT', m)

/** Valida la nota y devuelve el bloque de referencia. Lanza `BusinessError` (permanente) o `NotaEsperaOriginal` (esperar). */
export function documentoRelacionadoDe(n: NotaParaEnviar): NonNullable<ComprobanteFiscal['documentoRelacionado']> {
  const rel = n.relatedDocument
  if (!rel) throw invalida('La nota no tiene comprobante relacionado.')
  if (!n.reasonCode || !n.reasonDescription?.trim()) throw invalida('La nota necesita el código y el sustento del motivo.')

  // El original debe ser factura (01) o boleta (03): una nota no se relaciona con otra nota ni con un ticket.
  const tipoOriginal = tipoComprobante(rel.documentType as never)
  if (tipoOriginal !== '01' && tipoOriginal !== '03') {
    throw invalida('Una nota solo puede relacionarse con una factura o una boleta.')
  }
  if (n.isTrial !== rel.isTrial) {
    throw invalida('Una nota de prueba solo se relaciona con un comprobante de prueba, y una real con uno real.')
  }
  if (n.currency !== rel.currency) throw invalida('La nota debe estar en la misma moneda que el comprobante original.')

  // ⚠️ Limitación temporal: ver CODIGOS_NOTA_CREDITO_TOTAL.
  if (n.documentType === 'NOTA_DEBITO') {
    throw invalida('Las notas de débito aún no se pueden enviar: necesitan líneas propias (TaxDocumentItem, fase 1A.3b).')
  }
  const esParcial = CODIGOS_NOTA_CREDITO_PARCIAL.includes(n.reasonCode)
  if (!CODIGOS_NOTA_CREDITO_TOTAL.includes(n.reasonCode) && !esParcial) {
    throw invalida(
      `El motivo ${n.reasonCode} aún no se puede enviar: por ahora solo notas de crédito totales ` +
      `(${CODIGOS_NOTA_CREDITO_TOTAL.join(', ')}) y parciales (${CODIGOS_NOTA_CREDITO_PARCIAL.join(', ')}). Los demás necesitan líneas propias (TaxDocumentItem, fase 1A.3b).`,
    )
  }
  if (esParcial) {
    // Una parcial lleva sus propias líneas y nunca supera al original (la suma de todas las parciales la vigila quien las emite).
    if (n.total <= 0 || n.total > rel.total + 0.005) {
      throw invalida(`Una nota parcial debe ser mayor que cero y no superar al comprobante original (${rel.total.toFixed(2)}); esta es por ${n.total.toFixed(2)}.`)
    }
  } else if (Math.abs(n.total - rel.total) > 0.005) {
    throw invalida(`Una nota total debe ser por el importe del comprobante original (${rel.total.toFixed(2)}); esta es por ${n.total.toFixed(2)}.`)
  }

  // La serie hereda la letra del original (F / B) y lleva C (crédito) o D (débito): FC01, FD01, BC01, BD01.
  const letra = rel.series.charAt(0)
  const tipoNota = n.documentType === 'NOTA_CREDITO' ? 'C' : 'D'
  if (!['F', 'B'].includes(letra) || !new RegExp(`^${letra}${tipoNota}[A-Z0-9]{2}$`).test(n.series)) {
    throw invalida(`La serie ${n.series} no es válida para una nota ${tipoNota === 'C' ? 'de crédito' : 'de débito'} sobre ${rel.series}: debe ser ${letra}${tipoNota}.. (por ejemplo ${letra}${tipoNota}01).`)
  }

  // Estado del original. PENDIENTE y ENVIADO se ESPERAN (aún pueden aceptarse). Los demás no cambiarán: error permanente.
  if (rel.status === 'PENDIENTE' || rel.status === 'ENVIADO') {
    throw new NotaEsperaOriginal(`El comprobante original está ${rel.status.toLowerCase()}: la nota espera a que SUNAT lo acepte.`)
  }
  // ACEPTADO y OBSERVADO son comprobantes VÁLIDOS (observado = aceptado con advertencias; suma en el Registro de Ventas). Decisión del dueño
  // (2026-10-27), pendiente de validar con el contador: ⚠️ ver docs/COMPLIANCE.md §10.
  if (rel.status !== 'ACEPTADO' && rel.status !== 'OBSERVADO') {
    throw invalida(`El comprobante original está ${rel.status.toLowerCase()}: no admite notas.`)
  }

  return {
    tipoComprobante: tipoOriginal,
    serie: rel.series,
    correlativo: rel.correlativo,
    motivo: n.reasonCode,
    descripcionMotivo: n.reasonDescription.trim(),
  }
}
