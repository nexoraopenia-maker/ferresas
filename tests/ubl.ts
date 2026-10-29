import { construirXmlUbl, ComprobanteInconsistente, escaparXml, verificarTotales } from '../src/features/invoicing/ubl'
import type { ComprobanteFiscal } from '../src/features/invoicing/providers/types'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

/** Verificador mínimo de que el XML está BIEN FORMADO (etiquetas balanceadas). */
function bienFormado(xml: string): { ok: boolean; motivo?: string } {
  const pila: string[] = []
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|<\?xml[^>]*\?>/g
  let m: RegExpExecArray | null
  let ultimo = 0
  while ((m = re.exec(xml))) {
    const entre = xml.slice(ultimo, m.index)
    if (/[<>]/.test(entre.replace(/&(amp|lt|gt|quot|apos);/g, ''))) return { ok: false, motivo: `texto con < o > sin escapar: «${entre.slice(0, 30)}»` }
    ultimo = re.lastIndex
    if (m[0].startsWith('<?')) continue
    const [, cierra, nombre, , autocierra] = m
    if (autocierra) continue
    if (cierra) {
      if (pila.pop() !== nombre) return { ok: false, motivo: `cierra </${nombre}> sin abrir` }
    } else pila.push(nombre!)
  }
  if (xml.slice(ultimo).trim()) return { ok: false, motivo: 'texto suelto al final' }
  return pila.length === 0 ? { ok: true } : { ok: false, motivo: `sin cerrar: ${pila.join(',')}` }
}
const texto = (xml: string, etiqueta: string) => new RegExp(`<${etiqueta}[^>]*>([^<]*)</${etiqueta}>`).exec(xml)?.[1]
const todos = (xml: string, etiqueta: string) => [...xml.matchAll(new RegExp(`<${etiqueta}[^>]*>([^<]*)</${etiqueta}>`, 'g'))].map((m) => m[1]!)

const base = (): ComprobanteFiscal => ({
  tipoComprobante: '03', serie: 'B001', correlativo: 12, fechaEmision: '2026-10-20', moneda: 'PEN',
  emisor: { ruc: '20131312955', razonSocial: 'FERRETERÍA & HIJOS S.A.C.', nombreComercial: 'Ferretería "Sol"', direccion: 'Av. Industrial 123 <Lima>', ubigeo: '150101', codigoEstablecimiento: '0000' },
  receptor: { tipoDocumento: '1', numeroDocumento: '41235678', razonSocial: 'María Flores', direccion: null },
  lineas: [{
    numero: 1, descripcion: 'Cemento Sol 42.5 kg', codigoProducto: 'CEM-01', unidadMedida: 'NIU', cantidad: 2,
    precioUnitario: 32.9, valorUnitario: 27.88, igv: 10.04, tasaIgv: 0.18, tipoAfectacionIgv: '10', importeTotal: 65.8, descuento: 0,
  }],
  totalGravado: 55.76, totalExonerado: 0, totalInafecto: 0, totalIgv: 10.04, totalDescuentos: 0, total: 65.8,
  totalEnLetras: 'SON: SESENTA Y CINCO CON 80/100 SOLES',
})

console.log('\n1) Boleta')
const xml = construirXmlUbl(base())
check('>>> el XML está bien formado', bienFormado(xml).ok, bienFormado(xml).motivo)
check('empieza con la declaración XML', xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
check('raíz Invoice con los espacios de nombres UBL 2.1', xml.includes('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"') && xml.includes('xmlns:cac=') && xml.includes('xmlns:cbc=') && xml.includes('xmlns:ext='))
check('versión UBL 2.1 y personalización 2.0', texto(xml, 'cbc:UBLVersionID') === '2.1' && texto(xml, 'cbc:CustomizationID') === '2.0')
check('>>> identificador SERIE-CORRELATIVO', texto(xml, 'cbc:ID') === 'B001-12')
check('>>> el tipo de operación (catálogo 51) lleva listID=0101 Y su listSchemeURI, en factura y boleta (SUNAT BETA: 3244)', /listID="0101"[^>]*listSchemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo51"/.test(xml))
check('tipo de documento 03', texto(xml, 'cbc:InvoiceTypeCode') === '03')
check('fecha de emisión', texto(xml, 'cbc:IssueDate') === '2026-10-20')
check('moneda', texto(xml, 'cbc:DocumentCurrencyCode') === 'PEN')
check('importe en letras como leyenda 1000', xml.includes('<cbc:Note languageLocaleID="1000">SON: SESENTA Y CINCO CON 80/100 SOLES</cbc:Note>'))
check('hay un espacio vacío para la firma digital', xml.includes('<ext:ExtensionContent/>'))
check('>>> el emisor lleva su RUC con tipo de documento 6', xml.includes('schemeID="6"') && xml.includes('>20131312955</cbc:ID>'))
check('el receptor (DNI) lleva tipo 1', xml.includes('schemeID="1"') && xml.includes('>41235678</cbc:ID>'))
check('>>> total a pagar y total con IGV', texto(xml, 'cbc:PayableAmount') === '65.80' && texto(xml, 'cbc:TaxInclusiveAmount') === '65.80')
check('base imponible e IGV del documento', texto(xml, 'cbc:LineExtensionAmount') === '55.76' && xml.includes('<cbc:TaxAmount currencyID="PEN">10.04</cbc:TaxAmount>'))
check('tributo IGV (1000/VAT)', xml.includes('>1000</cbc:ID>') && xml.includes('<cbc:TaxTypeCode>VAT</cbc:TaxTypeCode>'))
check('línea: cantidad, unidad y precio con IGV', xml.includes('unitCode="NIU"') && xml.includes('>2</cbc:InvoicedQuantity>') && xml.includes('<cbc:PriceAmount currencyID="PEN">32.90</cbc:PriceAmount>'))
check('línea: afectación 10 (gravado) y valor unitario sin IGV', xml.includes('>10</cbc:TaxExemptionReasonCode>') && xml.includes('<cbc:PriceAmount currencyID="PEN">27.88</cbc:PriceAmount>'))
check('conteo de líneas', texto(xml, 'cbc:LineCountNumeric') === '1')

console.log('\n2) Texto con caracteres peligrosos')
check('>>> & < > " \' se escapan en nombres y direcciones', xml.includes('FERRETERÍA &amp; HIJOS S.A.C.') && xml.includes('Av. Industrial 123 &lt;Lima&gt;') && xml.includes('Ferretería &quot;Sol&quot;'))
check('las tildes y la ñ se conservan (UTF-8)', xml.includes('María Flores') && xml.includes('FERRETERÍA'))
check('escaparXml quita caracteres de control prohibidos', escaparXml('a\u0001b\u0008c') === 'abc')
const inyeccion = base(); inyeccion.lineas[0]!.descripcion = '</cbc:Description><cac:Evil/>'
check('>>> un nombre de producto malicioso no inyecta etiquetas', bienFormado(construirXmlUbl(inyeccion)).ok && !construirXmlUbl(inyeccion).includes('<cac:Evil/>'))

console.log('\n3) Factura con RUC')
const f = base(); f.tipoComprobante = '01'; f.serie = 'F001'; f.receptor = { tipoDocumento: '6', numeroDocumento: '20100070970', razonSocial: 'CLIENTE S.A.', direccion: 'Jr. Lima 1' }
const xf = construirXmlUbl(f)
check('la factura también lleva el catálogo 51', /listID="0101"[^>]*catalogo51"/.test(xf))
check('tipo 01 y receptor con tipo 6', texto(xf, 'cbc:InvoiceTypeCode') === '01' && xf.includes('>20100070970</cbc:ID>') && bienFormado(xf).ok)

console.log('\n3b) Forma de pago de la factura (SUNAT BETA 3244)')
const terminos = (x: string) => x.match(/<cac:PaymentTerms>[\s\S]*?<\/cac:PaymentTerms>/g) ?? []
check('>>> una factura SIN forma de pago explícita sale como Contado (una sola marca FormaPago)', terminos(xf).length === 1 && terminos(xf)[0]!.includes('<cbc:ID>FormaPago</cbc:ID>') && terminos(xf)[0]!.includes('<cbc:PaymentMeansID>Contado</cbc:PaymentMeansID>') && !terminos(xf)[0]!.includes('Amount'))
check('el bloque va después del cliente y antes de los impuestos (orden del esquema)', xf.indexOf('</cac:AccountingCustomerParty>') < xf.indexOf('<cac:PaymentTerms>') && xf.indexOf('<cac:PaymentTerms>') < xf.indexOf('<cac:TaxTotal>'))
const fc = base(); fc.tipoComprobante = '01'; fc.serie = 'F001'; fc.receptor = f.receptor; fc.formaPago = { tipo: 'Credito', monto: 40, vence: '2026-11-30' }
const xc = construirXmlUbl(fc)
check('>>> a crédito: una marca Credito con el monto financiado y UNA cuota (Cuota001) con su vencimiento', terminos(xc).length === 2 && terminos(xc)[0]!.includes('<cbc:PaymentMeansID>Credito</cbc:PaymentMeansID>') && terminos(xc)[0]!.includes('<cbc:Amount currencyID="PEN">40.00</cbc:Amount>') && terminos(xc)[1]!.includes('<cbc:PaymentMeansID>Cuota001</cbc:PaymentMeansID>') && terminos(xc)[1]!.includes('<cbc:PaymentDueDate>2026-11-30</cbc:PaymentDueDate>') && bienFormado(xc).ok)
const sinVence = base(); sinVence.tipoComprobante = '01'; sinVence.serie = 'F001'; sinVence.receptor = f.receptor
check('>>> un crédito sin monto o con un vencimiento mal escrito se rechaza', (() => { for (const fp of [{ tipo: 'Credito' as const, monto: 0, vence: '2026-11-30' }, { tipo: 'Credito' as const, monto: 10, vence: '30/11/2026' }]) { try { construirXmlUbl({ ...sinVence, formaPago: fp }); return false } catch (e) { if (!(e instanceof ComprobanteInconsistente)) return false } } return true })())
check('>>> la boleta NO lleva forma de pago (solo las facturas)', terminos(xml).length === 0)

console.log('\n4) Sin documento y mezcla de afectaciones')
const sd = base(); sd.receptor = { tipoDocumento: '0', numeroDocumento: null, razonSocial: 'CLIENTES VARIOS', direccion: null }
check('consumidor final: documento «-» con tipo 0', construirXmlUbl(sd).includes('schemeID="0"') && construirXmlUbl(sd).includes('>-</cbc:ID>'))
const mix = base()
mix.lineas.push({ numero: 2, descripcion: 'Servicio exonerado', codigoProducto: 'SRV', unidadMedida: 'ZZ', cantidad: 1, precioUnitario: 10, valorUnitario: 10, igv: 0, tasaIgv: 0, tipoAfectacionIgv: '20', importeTotal: 10, descuento: 0 })
mix.totalExonerado = 10; mix.total = 75.8
const xm = construirXmlUbl(mix)
check('>>> con una línea exonerada aparece su subtotal (9997/EXO)', xm.includes('>9997</cbc:ID>') && xm.includes('<cbc:Name>EXO</cbc:Name>') && bienFormado(xm).ok)
check('y el total a pagar la incluye', texto(xm, 'cbc:PayableAmount') === '75.80' && texto(xm, 'cbc:LineExtensionAmount') === '65.76')
check('conteo de líneas 2', texto(xm, 'cbc:LineCountNumeric') === '2' && todos(xm, 'cbc:ID').includes('2'))

console.log('\n5) >>> Totales que no cuadran se rechazan ANTES de generar')
const mal = base(); mal.total = 70
check('total distinto de la suma de las líneas', (() => { try { verificarTotales(mal); return false } catch (e) { return e instanceof ComprobanteInconsistente } })())
const mal2 = base(); mal2.totalIgv = 12
check('IGV distinto del de las líneas', (() => { try { construirXmlUbl(mal2); return false } catch (e) { return e instanceof ComprobanteInconsistente } })())
const vacio = base(); vacio.lineas = []
check('sin líneas', (() => { try { construirXmlUbl(vacio); return false } catch (e) { return e instanceof ComprobanteInconsistente } })())
const tol = base(); tol.total = 65.81
check('un céntimo de diferencia por redondeo se tolera', (() => { try { verificarTotales(tol); return true } catch { return false } })())

console.log('\n6) Nota de crédito')
const nc = base()
nc.tipoComprobante = '07'; nc.serie = 'BC01'; nc.correlativo = 1
nc.documentoRelacionado = { tipoComprobante: '03', serie: 'B001', correlativo: 12, motivo: '01', descripcionMotivo: 'Anulación de la operación' }
const xn = construirXmlUbl(nc)
check('raíz CreditNote y líneas CreditNoteLine', xn.includes('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"') && xn.includes('<cac:CreditNoteLine>') && xn.includes('CreditedQuantity'))
check('>>> referencia al comprobante que modifica y al motivo', xn.includes('<cbc:ReferenceID>B001-12</cbc:ReferenceID>') && xn.includes('>01</cbc:ResponseCode>') && xn.includes('<cac:BillingReference>'))
check('no lleva InvoiceTypeCode', !xn.includes('InvoiceTypeCode') && bienFormado(xn).ok)
const sinRel = base(); sinRel.tipoComprobante = '07'
check('>>> una nota de crédito sin comprobante relacionado se rechaza', (() => { try { construirXmlUbl(sinRel); return false } catch (e) { return e instanceof ComprobanteInconsistente } })())

console.log('\n6b) Orden de los elementos del esquema UBL 2.1 (SUNAT BETA: 0306)')
const ORDEN = ['<ext:UBLExtensions>', '<cbc:UBLVersionID>', '<cbc:CustomizationID>', '<cbc:ID>', '<cbc:IssueDate>', '<cbc:DocumentCurrencyCode', '<cbc:LineCountNumeric>', '<cac:DiscrepancyResponse>', '<cac:BillingReference>', '<cac:Signature>', '<cac:AccountingSupplierParty>', '<cac:AccountingCustomerParty>', '<cac:PaymentTerms>', '<cac:TaxTotal>']
const ordenOk = (x: string, cierre: string) => {
  const tags = [...ORDEN, cierre, x.includes('<cac:CreditNoteLine>') ? '<cac:CreditNoteLine>' : x.includes('<cac:DebitNoteLine>') ? '<cac:DebitNoteLine>' : '<cac:InvoiceLine>']
  const pos = tags.map((t) => x.indexOf(t)).filter((i) => i >= 0)
  return pos.length >= 9 && pos.every((p, i) => i === 0 || p > pos[i - 1]!)
}
check('>>> la nota de crédito respeta el orden del esquema (LineCountNumeric ANTES de DiscrepancyResponse y BillingReference)', ordenOk(xn, '<cac:LegalMonetaryTotal>') && xn.indexOf('<cbc:LineCountNumeric>') < xn.indexOf('<cac:DiscrepancyResponse>'))
const nd = base(); nd.tipoComprobante = '08'; nd.serie = 'BD01'; nd.correlativo = 1
nd.documentoRelacionado = { tipoComprobante: '03', serie: 'B001', correlativo: 12, motivo: '01', descripcionMotivo: 'Intereses por mora' }
check('la nota de débito también', ordenOk(construirXmlUbl(nd), '<cac:RequestedMonetaryTotal>'))
check('la factura y la boleta también', ordenOk(xf, '<cac:LegalMonetaryTotal>') && ordenOk(xml, '<cac:LegalMonetaryTotal>'))

console.log('\n7) Determinismo')
check('el mismo comprobante produce SIEMPRE el mismo XML (sirve para el hash)', construirXmlUbl(base()) === construirXmlUbl(base()))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
