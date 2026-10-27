/**
 * El documento del proveedor que respalda una compra (F5.4): tipo, serie, número y fecha de emisión. Puro: sin base ni React.
 *
 * Los cuatro datos van JUNTOS o ninguno (también lo exige un CHECK en la base). Cuando están, `invoiceRef` se compone como
 * «SERIE-NÚMERO» para que el índice único (negocio, proveedor, invoiceRef) siga impidiendo registrar dos veces el mismo documento.
 * ⚠️ Los códigos del catálogo oficial de comprobantes de SUNAT NO se asignan aquí: eso es F5.6, con la especificación vigente y el contador.
 */
export const TIPOS_DOCUMENTO_COMPRA = ['FACTURA', 'BOLETA', 'NOTA_CREDITO', 'NOTA_DEBITO', 'RECIBO_HONORARIOS', 'OTRO'] as const
export type TipoDocumentoCompra = (typeof TIPOS_DOCUMENTO_COMPRA)[number]

export const ETIQUETA_DOCUMENTO_COMPRA: Record<TipoDocumentoCompra, string> = {
  FACTURA: 'Factura', BOLETA: 'Boleta', NOTA_CREDITO: 'Nota de crédito', NOTA_DEBITO: 'Nota de débito', RECIBO_HONORARIOS: 'Recibo por honorarios', OTRO: 'Otro documento',
}

export interface EntradaDocumento { docType?: string | null; docSeries?: string | null; docNumber?: string | null; issueDate?: string | null }
export interface DocumentoCompra { docType: TipoDocumentoCompra; docSeries: string; docNumber: string; issueDate: string; invoiceRef: string }

const FORMATO = /^[A-Z0-9]{1,20}$/
const DIA = /^\d{4}-\d{2}-\d{2}$/
/** Antes de esta fecha no puede haber emisión (evita años tecleados a medias: 0026, 1926). */
export const EMISION_MINIMA = '2000-01-01'

const limpio = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, '').toUpperCase()
const vacio = (v: string | null | undefined) => (v ?? '').trim() === ''

/** ¿La fecha AAAA-MM-DD existe en el calendario? (31 de febrero, 29 de febrero de un año no bisiesto…) */
export function diaValido(dia: string): boolean {
  if (!DIA.test(dia)) return false
  const [y, m, d] = dia.split('-').map(Number) as [number, number, number]
  const f = new Date(Date.UTC(y, m - 1, d))
  return f.getUTCFullYear() === y && f.getUTCMonth() === m - 1 && f.getUTCDate() === d
}

export const componerReferencia = (serie: string, numero: string) => `${serie}-${numero}`

export type ResultadoDocumento = { ok: true; documento: DocumentoCompra | null } | { ok: false; mensaje: string }

/**
 * Valida y normaliza el documento. `hoy` es el día de hoy en la zona del negocio (AAAA-MM-DD): una factura no se emite en el futuro.
 * Sin ningún dato → `documento: null` (la compra queda con su referencia libre, si la hay). Con algún dato, exige los cuatro.
 */
export function validarDocumento(e: EntradaDocumento, hoy: string): ResultadoDocumento {
  const dados = [e.docType, e.docSeries, e.docNumber, e.issueDate].filter((v) => !vacio(v)).length
  if (dados === 0) return { ok: true, documento: null }
  if (dados < 4) return { ok: false, mensaje: 'Completa el tipo, la serie, el número y la fecha de emisión del documento, o deja los cuatro vacíos.' }
  if (!(TIPOS_DOCUMENTO_COMPRA as readonly string[]).includes(e.docType!)) return { ok: false, mensaje: 'Ese tipo de documento no existe.' }
  const serie = limpio(e.docSeries), numero = limpio(e.docNumber), dia = (e.issueDate ?? '').trim()
  if (!FORMATO.test(serie)) return { ok: false, mensaje: 'La serie solo lleva letras y números, sin espacios ni guiones (por ejemplo F001).' }
  if (!FORMATO.test(numero)) return { ok: false, mensaje: 'El número solo lleva letras y números, sin espacios ni guiones (por ejemplo 000123).' }
  if (!diaValido(dia)) return { ok: false, mensaje: 'La fecha de emisión no existe.' }
  if (dia > hoy) return { ok: false, mensaje: 'La fecha de emisión no puede ser futura.' }
  if (dia < EMISION_MINIMA) return { ok: false, mensaje: 'La fecha de emisión es demasiado antigua: revisa el año.' }
  return { ok: true, documento: { docType: e.docType as TipoDocumentoCompra, docSeries: serie, docNumber: numero, issueDate: dia, invoiceRef: componerReferencia(serie, numero) } }
}
