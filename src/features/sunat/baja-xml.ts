import type { SolicitudBaja } from '@/features/invoicing/providers/types'
import { escaparXml } from '@/features/invoicing/ubl'

/**
 * XML de la comunicación de baja (`VoidedDocuments`), SIN firmar. Función PURA: ni base ni red.
 *
 * ⚠️ TODO esto es de memoria y SIN validar contra el esquema ni contra SUNAT (docs/SUNAT-SUPUESTOS.md): el espacio de nombres y la raíz `VoidedDocuments`, los
 * componentes `sac:`, el identificador `RA-AAAAMMDD-N`, `ReferenceDate` (día de emisión del comprobante) frente a `IssueDate` (día de la comunicación), los códigos de
 * tipo de documento, y el largo máximo del motivo. Se confirma con el ambiente beta. Lo que sí es nuestro: una comunicación = UN comprobante.
 */

const NS = {
  raiz: 'urn:sunat:names:specification:ubl:peru:schema:xsd:VoidedDocuments-1',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  sac: 'urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1',
} as const

/** ⚠️ Largo máximo del motivo, que también exige la base (CHECK). */
export const MOTIVO_BAJA_MAX = 100

const IDENTIFICADOR = /^RA-\d{8}-\d{1,5}$/
const DIA = /^\d{4}-\d{2}-\d{2}$/

export class BajaInvalida extends Error {
  constructor(m: string) { super(m); this.name = 'BajaInvalida' }
}

export function identificadorDeBaja(dia: string, seq: number): string {
  if (!DIA.test(dia) || !Number.isInteger(seq) || seq < 1) throw new BajaInvalida('Día o número de la comunicación de baja inválidos.')
  return `RA-${dia.replace(/-/g, '')}-${seq}`
}

export function construirXmlBaja(s: SolicitudBaja): string {
  if (!IDENTIFICADOR.test(s.identificador)) throw new BajaInvalida('El identificador de la comunicación de baja no es RA-AAAAMMDD-N.')
  if (!DIA.test(s.fechaGeneracion) || !DIA.test(s.fechaEmision)) throw new BajaInvalida('Las fechas de la comunicación de baja deben ser AAAA-MM-DD.')
  if (s.identificador.slice(3, 11) !== s.fechaGeneracion.replace(/-/g, '')) throw new BajaInvalida('El identificador no coincide con el día de generación.')
  if (!/^\d{11}$/.test(s.emisor.ruc)) throw new BajaInvalida('El RUC del emisor debe tener 11 dígitos.')
  const motivo = s.motivo.trim()
  if (!motivo) throw new BajaInvalida('Falta el motivo de la baja.')
  if (motivo.length > MOTIVO_BAJA_MAX) throw new BajaInvalida(`El motivo de la baja admite hasta ${MOTIVO_BAJA_MAX} caracteres.`)
  if (!/^[A-Z0-9]{4}$/.test(s.serie) || !Number.isInteger(s.correlativo) || s.correlativo < 1) throw new BajaInvalida('Serie o correlativo del comprobante inválidos.')

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<VoidedDocuments xmlns="${NS.raiz}" xmlns:cac="${NS.cac}" xmlns:cbc="${NS.cbc}" xmlns:ds="${NS.ds}" xmlns:ext="${NS.ext}" xmlns:sac="${NS.sac}">` +
    // Aquí se inserta la firma digital (ds:Signature) al firmar.
    `<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>` +
    `<cbc:UBLVersionID>2.0</cbc:UBLVersionID><cbc:CustomizationID>1.0</cbc:CustomizationID>` +
    `<cbc:ID>${s.identificador}</cbc:ID>` +
    `<cbc:ReferenceDate>${s.fechaEmision}</cbc:ReferenceDate><cbc:IssueDate>${s.fechaGeneracion}</cbc:IssueDate>` +
    `<cac:AccountingSupplierParty><cbc:CustomerAssignedAccountID>${s.emisor.ruc}</cbc:CustomerAssignedAccountID>` +
    `<cbc:AdditionalAccountID>6</cbc:AdditionalAccountID>` +
    `<cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>${escaparXml(s.emisor.razonSocial)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party>` +
    `</cac:AccountingSupplierParty>` +
    `<sac:VoidedDocumentsLine><cbc:LineID>1</cbc:LineID><cbc:DocumentTypeCode>${s.tipoComprobante}</cbc:DocumentTypeCode>` +
    `<sac:DocumentSerialID>${s.serie}</sac:DocumentSerialID><sac:DocumentNumberID>${s.correlativo}</sac:DocumentNumberID>` +
    `<sac:VoidReasonDescription>${escaparXml(motivo)}</sac:VoidReasonDescription></sac:VoidedDocumentsLine>` +
    `</VoidedDocuments>`
  )
}
