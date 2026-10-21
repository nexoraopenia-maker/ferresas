import QRCode from 'qrcode'
import type { TaxDocumentStatus } from '@/generated/prisma/enums'

/**
 * QR de la representación impresa.
 *
 * Trama pedida por el producto (campos separados por «|», con barra final):
 *
 *   RUC | TIPO_DOC | SERIE | NUMERO | IGV | TOTAL | FECHA | TIPO_DOC_CLIENTE | NUM_DOC_CLIENTE | HASH |
 *
 * ⚠️ NORMATIVO: el orden, el relleno del número (8 cifras) y la inclusión del
 * hash siguen lo solicitado y lo que se conoce de la práctica de SUNAT, pero NO
 * se han contrastado con el anexo vigente de la resolución de comprobantes
 * electrónicos. Está anotado en docs/COMPLIANCE.md. Un QR con una trama
 * equivocada es peor que no tener QR: por eso solo se imprime cuando el
 * proveedor devolvió el hash REAL de un comprobante ya aceptado.
 */

export interface DatosQr {
  ruc: string
  tipoComprobante: '01' | '03' | '07'
  serie: string
  correlativo: number
  igv: number
  total: number
  /** YYYY-MM-DD en la zona del negocio. */
  fecha: string
  /** Catálogo 06: 0 sin documento, 1 DNI, 4 CE, 6 RUC, 7 pasaporte. */
  tipoDocCliente: string
  numDocCliente: string | null
  hash: string
}

export function construirTramaQr(d: DatosQr): string {
  const limpio = (s: string) => s.replace(/[|\r\n]/g, '')
  return [
    limpio(d.ruc), d.tipoComprobante, limpio(d.serie), String(d.correlativo).padStart(8, '0'),
    d.igv.toFixed(2), d.total.toFixed(2), d.fecha,
    d.tipoDocCliente, limpio(d.numDocCliente || '-'), limpio(d.hash),
  ].join('|') + '|'
}

/** Solo un comprobante aceptado y con el hash que devolvió el proveedor lleva QR. */
export function llevaQr(estado: TaxDocumentStatus | string, hash: string | null | undefined): boolean {
  return (estado === 'ACEPTADO' || estado === 'OBSERVADO') && !!hash
}

/** SVG del QR (corrección de errores M, sin margen: el papel ya tiene el suyo). */
export function qrSvg(trama: string): Promise<string> {
  return QRCode.toString(trama, { type: 'svg', errorCorrectionLevel: 'M', margin: 0 })
}
