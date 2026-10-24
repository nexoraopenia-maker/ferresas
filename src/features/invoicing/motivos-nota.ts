import { CODIGOS_NOTA_CREDITO_TOTAL } from './notas'

/**
 * Motivos que la interfaz ofrece para una nota de crédito TOTAL, y cuándo se puede ofrecer la nota.
 *
 * ⚠️ Los códigos y sus nombres son del catálogo 09 de SUNAT, escritos de memoria y SIN validar (docs/COMPLIANCE.md §10).
 * Solo los de una nota total: los demás necesitan líneas propias (`TaxDocumentItem`, fase 1A.3b).
 */
export const MOTIVOS_NOTA_CREDITO_TOTAL = [
  { codigo: '01', nombre: 'Anulación de la operación', ayuda: 'La venta no se concretó o se cancela por completo.' },
  { codigo: '02', nombre: 'Anulación por error en el RUC', ayuda: 'El comprobante se emitió con un RUC equivocado; se anula y se emite uno nuevo.' },
  { codigo: '06', nombre: 'Devolución total', ayuda: 'El cliente devuelve toda la mercadería.' },
] as const

export type CodigoMotivoNota = (typeof MOTIVOS_NOTA_CREDITO_TOTAL)[number]['codigo']

export const nombreMotivo = (codigo: string | null): string | null =>
  MOTIVOS_NOTA_CREDITO_TOTAL.find((m) => m.codigo === codigo)?.nombre ?? null

// Una sola fuente de verdad: lo que la interfaz ofrece es lo que el servicio acepta.
for (const m of MOTIVOS_NOTA_CREDITO_TOTAL) {
  if (!CODIGOS_NOTA_CREDITO_TOTAL.includes(m.codigo)) throw new Error(`Motivo ${m.codigo} fuera de los códigos de nota total`)
}

export interface DocParaNota {
  documentType: string
  isTrial: boolean
  status: string
  series: string
  /** Número de la nota total viva de este comprobante, si ya la tiene. */
  notaTotal: string | null
  /** El proveedor le dio un identificador (prueba de que lo conoce). */
  tieneIdProveedor: boolean
}

/**
 * ¿Por qué NO se puede emitir la nota de este comprobante? `null` = se puede.
 * Es solo la cara visible: el servicio vuelve a comprobar TODO (`emitirNotaCreditoTotal`).
 */
export function razonSinNota(d: DocParaNota, facturacionActiva: boolean): string | null {
  if (d.documentType !== 'BOLETA' && d.documentType !== 'FACTURA') return 'Solo las boletas y facturas admiten una nota de crédito.'
  if (d.isTrial) return 'Es un comprobante de prueba, sin valor tributario: no admite notas.'
  if (d.notaTotal) return `Ya tiene la nota de crédito ${d.notaTotal}.`
  if (d.status === 'PENDIENTE' || d.status === 'ENVIADO') return 'Disponible cuando SUNAT acepte el comprobante.'
  if (d.status !== 'ACEPTADO') return `Un comprobante ${d.status.toLowerCase()} no admite notas.`
  if (!/^[FB]0\d{2}$/.test(d.series)) return 'La serie de esta sucursal no permite derivar la de la nota (solo sucursales 1 a 99).'
  if (facturacionActiva && !d.tieneIdProveedor) return 'Falta el identificador del proveedor: usa «Consultar» para sincronizarlo.'
  return null
}
