import type { ComprobanteFiscal, LineaFiscal } from './providers/types'

/**
 * XML UBL 2.1 de un comprobante electrónico (factura, boleta, nota de crédito).
 *
 * Función PURA: recibe el comprobante ya calculado (`ComprobanteFiscal`) y
 * devuelve el XML SIN FIRMAR. No toca la base ni la red, así que se puede
 * probar a fondo y reutilizar con cualquier vía de emisión:
 *
 *   · un PSE/OSE que acepte UBL: se le manda este XML y él lo firma y lo envía;
 *   · emisión propia (SEE-Del Contribuyente): este XML se firma con el
 *     certificado del contribuyente (XMLDSig) en el `ext:ExtensionContent` que
 *     aquí queda vacío, y se envía a SUNAT.
 *
 * ─── ⚠️ LO QUE ESTO NO ES ────────────────────────────────────────────────
 *
 * Este XML NO está validado contra el esquema (XSD) ni contra las reglas de
 * validación de SUNAT, ni firmado, ni aceptado por ningún OSE. La estructura
 * sigue UBL 2.1 y el perfil peruano tal como se conocen públicamente, pero
 * cualquier campo, catálogo o regla puede haber cambiado. Antes de emitir de
 * verdad hay que pasarlo por la validación del PSE/OSE elegido o por el
 * ambiente de pruebas de SUNAT. Ver docs/COMPLIANCE.md.
 *
 * Los códigos de los catálogos que se usan aquí (documento 01, identidad 06,
 * afectación IGV 07, tributos 05, unidades de medida) están nombrados en
 * COMPLIANCE.md con el mismo aviso.
 */

const NS = {
  inv: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  nc: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  nd: 'urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
} as const

/** Escapa lo que XML no admite en texto y en atributos. */
export function escaparXml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Caracteres de control prohibidos en XML 1.0 (se conservan \t \n \r).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

const monto = (n: number) => (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2)
/** Cantidad con hasta 4 decimales (la base guarda 4), sin ceros de relleno. */
const cantidad = (n: number) => String(Number(n.toFixed(4)))

/** Catálogo 05 (tributos) según la afectación del IGV de la línea (catálogo 07). */
function tributo(afectacion: string): { id: string; nombre: string; codigo: string } {
  if (afectacion.startsWith('2')) return { id: '9997', nombre: 'EXO', codigo: 'VAT' }  // exonerado
  if (afectacion.startsWith('3')) return { id: '9998', nombre: 'INA', codigo: 'FRE' }  // inafecto
  return { id: '1000', nombre: 'IGV', codigo: 'VAT' }                                  // gravado
}

const esquemaTributo = (t: ReturnType<typeof tributo>) =>
  `<cac:TaxScheme><cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">${t.id}</cbc:ID>` +
  `<cbc:Name>${t.nombre}</cbc:Name><cbc:TaxTypeCode>${t.codigo}</cbc:TaxTypeCode></cac:TaxScheme>`

function parte(
  etiqueta: 'AccountingSupplierParty' | 'AccountingCustomerParty',
  doc: { tipo: string; numero: string },
  razonSocial: string,
  nombreComercial: string | null,
  direccion: string | null,
  extra?: { ubigeo: string | null; establecimiento: string },
): string {
  const domicilio = direccion || extra
    ? `<cac:RegistrationAddress>` +
      (extra?.ubigeo ? `<cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${escaparXml(extra.ubigeo)}</cbc:ID>` : '') +
      (extra ? `<cbc:AddressTypeCode listAgencyName="PE:SUNAT" listName="Establecimientos anexos">${escaparXml(extra.establecimiento)}</cbc:AddressTypeCode>` : '') +
      (direccion ? `<cac:AddressLine><cbc:Line>${escaparXml(direccion)}</cbc:Line></cac:AddressLine>` : '') +
      `<cac:Country><cbc:IdentificationCode>PE</cbc:IdentificationCode></cac:Country></cac:RegistrationAddress>`
    : ''
  return `<cac:${etiqueta}><cac:Party>` +
    `<cac:PartyIdentification><cbc:ID schemeID="${doc.tipo}" schemeName="Documento de Identidad" ` +
    `schemeAgencyName="PE:SUNAT" schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06">${escaparXml(doc.numero)}</cbc:ID></cac:PartyIdentification>` +
    (nombreComercial ? `<cac:PartyName><cbc:Name>${escaparXml(nombreComercial)}</cbc:Name></cac:PartyName>` : '') +
    `<cac:PartyLegalEntity><cbc:RegistrationName>${escaparXml(razonSocial)}</cbc:RegistrationName>${domicilio}</cac:PartyLegalEntity>` +
    `</cac:Party></cac:${etiqueta}>`
}

/** ⚠️ Nombres de línea y de cantidad de cada raíz UBL (Invoice / CreditNote / DebitNote): sin validar contra el XSD. */
const LINEA = {
  '01': { tag: 'InvoiceLine', cant: 'InvoicedQuantity' },
  '03': { tag: 'InvoiceLine', cant: 'InvoicedQuantity' },
  '07': { tag: 'CreditNoteLine', cant: 'CreditedQuantity' },
  '08': { tag: 'DebitNoteLine', cant: 'DebitedQuantity' },
} as const

function linea(l: LineaFiscal, c: ComprobanteFiscal): string {
  const t = tributo(l.tipoAfectacionIgv)
  const moneda = c.moneda
  const base = l.valorUnitario * l.cantidad
  const { tag, cant } = LINEA[c.tipoComprobante]
  return `<cac:${tag}><cbc:ID>${l.numero}</cbc:ID>` +
    `<cbc:${cant} unitCode="${escaparXml(l.unidadMedida)}" unitCodeListID="UN/ECE rec 20" ` +
    `unitCodeListAgencyName="United Nations Economic Commission for Europe">${cantidad(l.cantidad)}</cbc:${cant}>` +
    `<cbc:LineExtensionAmount currencyID="${moneda}">${monto(base - l.descuento)}</cbc:LineExtensionAmount>` +
    // Precio de venta unitario CON IGV (tipo de precio 01 = precio unitario incluido el impuesto).
    `<cac:PricingReference><cac:AlternativeConditionPrice><cbc:PriceAmount currencyID="${moneda}">${monto(l.precioUnitario)}</cbc:PriceAmount>` +
    `<cbc:PriceTypeCode listName="Tipo de Precio" listAgencyName="PE:SUNAT" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo16">01</cbc:PriceTypeCode>` +
    `</cac:AlternativeConditionPrice></cac:PricingReference>` +
    `<cac:TaxTotal><cbc:TaxAmount currencyID="${moneda}">${monto(l.igv)}</cbc:TaxAmount><cac:TaxSubtotal>` +
    `<cbc:TaxableAmount currencyID="${moneda}">${monto(base - l.descuento)}</cbc:TaxableAmount>` +
    `<cbc:TaxAmount currencyID="${moneda}">${monto(l.igv)}</cbc:TaxAmount><cac:TaxCategory>` +
    `<cbc:Percent>${monto(l.tasaIgv * 100)}</cbc:Percent>` +
    `<cbc:TaxExemptionReasonCode listAgencyName="PE:SUNAT" listName="Afectacion del IGV" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo07">${escaparXml(l.tipoAfectacionIgv)}</cbc:TaxExemptionReasonCode>` +
    esquemaTributo(t) + `</cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>` +
    `<cac:Item><cbc:Description>${escaparXml(l.descripcion)}</cbc:Description>` +
    `<cac:SellersItemIdentification><cbc:ID>${escaparXml(l.codigoProducto)}</cbc:ID></cac:SellersItemIdentification></cac:Item>` +
    `<cac:Price><cbc:PriceAmount currencyID="${moneda}">${monto(l.valorUnitario)}</cbc:PriceAmount></cac:Price>` +
    `</cac:${tag}>`
}

export class ComprobanteInconsistente extends Error {
  constructor(mensaje: string) { super(mensaje); this.name = 'ComprobanteInconsistente' }
}

/**
 * Comprueba que los totales cuadran ANTES de generar nada: un XML con totales
 * que no suman lo rechaza SUNAT con un código críptico y el comprobante ya
 * habría salido del sistema. Tolerancia de un céntimo por redondeo.
 */
export function verificarTotales(c: ComprobanteFiscal): void {
  const cent = 0.011
  const sum = (f: (l: LineaFiscal) => number) => c.lineas.reduce((s, l) => s + f(l), 0)
  const base = (l: LineaFiscal) => l.valorUnitario * l.cantidad - l.descuento
  const gravado = sum((l) => (l.tipoAfectacionIgv.startsWith('1') ? base(l) : 0))
  const exo = sum((l) => (l.tipoAfectacionIgv.startsWith('2') ? base(l) : 0))
  const ina = sum((l) => (l.tipoAfectacionIgv.startsWith('3') ? base(l) : 0))
  const igv = sum((l) => l.igv)
  const revisar = (nombre: string, a: number, b: number) => {
    if (Math.abs(a - b) > cent) throw new ComprobanteInconsistente(`${nombre}: las líneas suman ${monto(a)} y el comprobante dice ${monto(b)}.`)
  }
  if (c.lineas.length === 0) throw new ComprobanteInconsistente('El comprobante no tiene líneas.')
  revisar('Total gravado', gravado, c.totalGravado)
  revisar('Total exonerado', exo, c.totalExonerado)
  revisar('Total inafecto', ina, c.totalInafecto)
  revisar('IGV', igv, c.totalIgv)
  revisar('Total', c.totalGravado + c.totalExonerado + c.totalInafecto + c.totalIgv, c.total)
  if ((c.tipoComprobante === '07' || c.tipoComprobante === '08') && !c.documentoRelacionado) {
    throw new ComprobanteInconsistente(`Una nota de ${c.tipoComprobante === '07' ? 'crédito' : 'débito'} necesita el comprobante que modifica.`)
  }
  if ((c.tipoComprobante === '01' || c.tipoComprobante === '03') && c.documentoRelacionado) {
    throw new ComprobanteInconsistente('Una factura o boleta no lleva comprobante relacionado.')
  }
}

function formaDePago(f: NonNullable<ComprobanteFiscal['formaPago']>, moneda: string): string {
  if (f.tipo === 'Contado') return `<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms>`
  if (!(f.monto > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(f.vence)) throw new ComprobanteInconsistente('Una factura a crédito necesita el monto financiado y el día de vencimiento de la cuota.')
  return `<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Credito</cbc:PaymentMeansID><cbc:Amount currencyID="${moneda}">${monto(f.monto)}</cbc:Amount></cac:PaymentTerms>` +
    `<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Cuota001</cbc:PaymentMeansID><cbc:Amount currencyID="${moneda}">${monto(f.monto)}</cbc:Amount><cbc:PaymentDueDate>${f.vence}</cbc:PaymentDueDate></cac:PaymentTerms>`
}

export function construirXmlUbl(c: ComprobanteFiscal): string {
  verificarTotales(c)

  const esCredito = c.tipoComprobante === '07'
  const esDebito = c.tipoComprobante === '08'
  const esNota = esCredito || esDebito
  const raiz = esCredito ? 'CreditNote' : esDebito ? 'DebitNote' : 'Invoice'
  const nsRaiz = esCredito ? NS.nc : esDebito ? NS.nd : NS.inv
  const id = `${c.serie}-${c.correlativo}`
  const moneda = c.moneda
  const rel = c.documentoRelacionado

  const receptorDoc = {
    tipo: c.receptor.tipoDocumento,
    // Sin documento (consumidor final en boleta pequeña) se declara «-».
    numero: c.receptor.numeroDocumento || '-',
  }

  // Subtotales de IGV por categoría presente en el comprobante.
  const subtotales: string[] = []
  const agregar = (afectacion: string, base: number, igv: number) => {
    if (base === 0 && igv === 0) return
    const t = tributo(afectacion)
    subtotales.push(
      `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="${moneda}">${monto(base)}</cbc:TaxableAmount>` +
      `<cbc:TaxAmount currencyID="${moneda}">${monto(igv)}</cbc:TaxAmount>` +
      `<cac:TaxCategory>${esquemaTributo(t)}</cac:TaxCategory></cac:TaxSubtotal>`,
    )
  }
  agregar('10', c.totalGravado, c.totalIgv)
  agregar('20', c.totalExonerado, 0)
  agregar('30', c.totalInafecto, 0)

  const tieneHora = c.fechaEmision.includes('T')
  const fecha = c.fechaEmision.slice(0, 10)
  const hora = tieneHora ? c.fechaEmision.slice(11, 19) : null

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<${raiz} xmlns="${nsRaiz}" xmlns:cac="${NS.cac}" xmlns:cbc="${NS.cbc}" xmlns:ds="${NS.ds}" xmlns:ext="${NS.ext}">` +
    // Aquí se inserta la firma digital (ds:Signature) al firmar. Vacío = sin firmar.
    `<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>` +
    `<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID>` +
    `<cbc:ID>${escaparXml(id)}</cbc:ID>` +
    `<cbc:IssueDate>${fecha}</cbc:IssueDate>` +
    (hora ? `<cbc:IssueTime>${hora}</cbc:IssueTime>` : '') +
    // Tipo de operación (catálogo 51): 0101 = venta interna. SUNAT BETA devolvió el 3244 («debe consignar la información del tipo de transacción») cuando el atributo `listID` iba
    // SIN `listSchemeURI` del catálogo 51; esa es la hipótesis de la corrección (⚠️ docs/SUNAT-SUPUESTOS.md #31, a confirmar en BETA).
    (esNota
      ? ''
      : `<cbc:InvoiceTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01" listID="0101" name="Tipo de Operacion" listSchemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo51">${c.tipoComprobante}</cbc:InvoiceTypeCode>`) +
    `<cbc:Note languageLocaleID="1000">${escaparXml(c.totalEnLetras)}</cbc:Note>` +
    `<cbc:DocumentCurrencyCode listID="ISO 4217 Alpha" listName="Currency" listAgencyName="United Nations Economic Commission for Europe">${moneda}</cbc:DocumentCurrencyCode>` +
    // Orden del esquema UBL 2.1 (CreditNote/DebitNote/Invoice): LineCountNumeric va ANTES de DiscrepancyResponse y BillingReference. SUNAT BETA rechazó la nota de crédito con el 0306
    // («found LineCountNumeric but next item should be AccountingSupplierParty») cuando iba después (docs/SUNAT-SUPUESTOS.md #34).
    `<cbc:LineCountNumeric>${c.lineas.length}</cbc:LineCountNumeric>` +
    (esNota && rel
      ? `<cac:DiscrepancyResponse><cbc:ReferenceID>${escaparXml(`${rel.serie}-${rel.correlativo}`)}</cbc:ReferenceID>` +
        // ⚠️ Catálogo 09 (crédito) o 10 (débito): códigos y nombres de lista sin validar.
        `<cbc:ResponseCode listName="${esCredito ? 'Tipo de nota de credito' : 'Tipo de nota de debito'}" listAgencyName="PE:SUNAT" ` +
        `listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo${esCredito ? '09' : '10'}">${escaparXml(rel.motivo)}</cbc:ResponseCode>` +
        `<cbc:Description>${escaparXml(rel.descripcionMotivo)}</cbc:Description></cac:DiscrepancyResponse>` +
        `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${escaparXml(`${rel.serie}-${rel.correlativo}`)}</cbc:ID>` +
        `<cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">${rel.tipoComprobante}</cbc:DocumentTypeCode>` +
        `</cac:InvoiceDocumentReference></cac:BillingReference>`
      : '') +
    `<cac:Signature><cbc:ID>${escaparXml(c.emisor.ruc)}</cbc:ID>` +
    `<cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${escaparXml(c.emisor.ruc)}</cbc:ID></cac:PartyIdentification>` +
    `<cac:PartyName><cbc:Name>${escaparXml(c.emisor.razonSocial)}</cbc:Name></cac:PartyName></cac:SignatoryParty>` +
    `<cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#SignatureSP</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>` +
    parte('AccountingSupplierParty', { tipo: '6', numero: c.emisor.ruc }, c.emisor.razonSocial, c.emisor.nombreComercial, c.emisor.direccion,
      { ubigeo: c.emisor.ubigeo, establecimiento: c.emisor.codigoEstablecimiento }) +
    parte('AccountingCustomerParty', receptorDoc, c.receptor.razonSocial, null, c.receptor.direccion) +
    // Forma de pago (solo facturas). ⚠️ #32: SUNAT BETA rechazó una factura SIN este bloque con el 3244 («debe consignar la información del tipo de transacción»); la hipótesis es que
    // «tipo de transacción» = Contado o Crédito. Contado lleva solo la marca; Crédito lleva el monto financiado y UNA cuota con su vencimiento.
    (c.tipoComprobante === '01' ? formaDePago(c.formaPago ?? { tipo: 'Contado' }, moneda) : '') +
    `<cac:TaxTotal><cbc:TaxAmount currencyID="${moneda}">${monto(c.totalIgv)}</cbc:TaxAmount>${subtotales.join('')}</cac:TaxTotal>` +
    // ⚠️ La nota de débito lleva RequestedMonetaryTotal en lugar de LegalMonetaryTotal (sin validar contra el XSD).
    `<cac:${esDebito ? 'RequestedMonetaryTotal' : 'LegalMonetaryTotal'}>` +
    `<cbc:LineExtensionAmount currencyID="${moneda}">${monto(c.totalGravado + c.totalExonerado + c.totalInafecto)}</cbc:LineExtensionAmount>` +
    `<cbc:TaxInclusiveAmount currencyID="${moneda}">${monto(c.total)}</cbc:TaxInclusiveAmount>` +
    (c.totalDescuentos > 0 ? `<cbc:AllowanceTotalAmount currencyID="${moneda}">${monto(c.totalDescuentos)}</cbc:AllowanceTotalAmount>` : '') +
    `<cbc:PayableAmount currencyID="${moneda}">${monto(c.total)}</cbc:PayableAmount></cac:${esDebito ? 'RequestedMonetaryTotal' : 'LegalMonetaryTotal'}>` +
    c.lineas.map((l) => linea(l, c)).join('') +
    `</${raiz}>`

  return xml
}
