import { SignedXml } from 'xml-crypto'

/**
 * Firma digital del XML UBL (XMLDSig enveloped) y su verificación.
 *
 * La firma va dentro de `ext:ExtensionContent`, el hueco que `construirXmlUbl` deja vacío, con `Id="SignatureSP"`
 * (a lo que apunta el `cac:Signature` del UBL). Cubre todo el documento (`Reference URI=""`) con la transformación
 * enveloped y canonicalización C14N 1.0. Incluye el certificado en `KeyInfo/X509Data`.
 *
 * ⚠️ SIN VALIDAR CONTRA SUNAT: los algoritmos (RSA-SHA256 por defecto; SUNAT pudo exigir RSA-SHA1), la canonicalización y
 * la forma exacta de `KeyInfo` salen de lo que entendemos de la guía de elaboración del XML, no de una validación real.
 * Lo que SÍ se prueba aquí es que la firma es matemáticamente correcta y verificable: se verifica con la clave
 * pública del certificado, y cualquier cambio en el XML la invalida. Que SUNAT la acepte solo lo dirá su ambiente beta.
 */

export type AlgoritmoFirma = 'sha1' | 'sha256'

const ALG = {
  sha1: { firma: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1', resumen: 'http://www.w3.org/2000/09/xmldsig#sha1' },
  sha256: { firma: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', resumen: 'http://www.w3.org/2001/04/xmlenc#sha256' },
} as const

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
const HUECO = "//*[local-name(.)='ExtensionContent']"

export class XmlSinHuecoDeFirma extends Error {
  constructor() { super('El XML no tiene el hueco ext:ExtensionContent donde va la firma.'); this.name = 'XmlSinHuecoDeFirma' }
}

export interface ResultadoFirma {
  xmlFirmado: string
  /** DigestValue de la firma: es el hash que va en el QR del comprobante. */
  digestValue: string
}

/** Certificado en base64 sin cabeceras PEM ni saltos de línea (lo que va en `X509Certificate`). */
const certificadoBase64 = (pem: string) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')

export function firmarXml(
  xml: string,
  cert: { clavePrivadaPem: string; certificadoPem: string },
  opciones: { algoritmo?: AlgoritmoFirma } = {},
): ResultadoFirma {
  if (!/<ext:ExtensionContent\s*\/>|<ext:ExtensionContent>\s*<\/ext:ExtensionContent>/.test(xml)) throw new XmlSinHuecoDeFirma()
  const alg = ALG[opciones.algoritmo ?? 'sha256']
  const b64 = certificadoBase64(cert.certificadoPem)

  const sig = new SignedXml({
    privateKey: cert.clavePrivadaPem,
    publicCert: cert.certificadoPem,
    signatureAlgorithm: alg.firma,
    canonicalizationAlgorithm: C14N,
    getKeyInfoContent: () => `<ds:X509Data><ds:X509Certificate>${b64}</ds:X509Certificate></ds:X509Data>`,
  })
  sig.addReference({ xpath: '/*', transforms: [ENVELOPED, C14N], digestAlgorithm: alg.resumen, isEmptyUri: true })
  sig.computeSignature(xml, { prefix: 'ds', attrs: { Id: 'SignatureSP' }, location: { reference: HUECO, action: 'append' } })

  const xmlFirmado = sig.getSignedXml()
  const digestValue = /<ds:DigestValue>([^<]+)<\/ds:DigestValue>/.exec(xmlFirmado)?.[1]
  if (!digestValue) throw new Error('La firma no produjo DigestValue.')
  return { xmlFirmado, digestValue }
}

export interface ResultadoVerificacion {
  valida: boolean
  errores: string[]
  digestValue: string | null
  /** El certificado viaja dentro de la firma (X509Certificate). */
  certificadoIncluido: boolean
}

/**
 * Verifica la firma de un XML. Si se pasa `certificadoPem`, se usa ESA clave pública (lo correcto: el que verifica
 * confía en un certificado conocido, no en el que trae el propio XML). Sin él, solo se comprueba la integridad
 * contra el certificado incluido, lo que no prueba QUIÉN firmó.
 */
export function verificarFirmaXml(xmlFirmado: string, certificadoPem?: string): ResultadoVerificacion {
  const digestValue = /<ds:DigestValue>([^<]+)<\/ds:DigestValue>/.exec(xmlFirmado)?.[1] ?? null
  const incluido = /<(?:ds:)?X509Certificate>[^<]+<\/(?:ds:)?X509Certificate>/.test(xmlFirmado)
  const bloque = /<ds:Signature[\s\S]*?<\/ds:Signature>/.exec(xmlFirmado)?.[0]
  if (!bloque) return { valida: false, errores: ['El XML no tiene firma.'], digestValue, certificadoIncluido: incluido }

  try {
    const sig = new SignedXml({ publicCert: certificadoPem })
    if (!certificadoPem) {
      const pem = /<(?:ds:)?X509Certificate>([^<]+)<\/(?:ds:)?X509Certificate>/.exec(xmlFirmado)?.[1]
      if (!pem) return { valida: false, errores: ['No hay certificado con el que verificar.'], digestValue, certificadoIncluido: incluido }
      sig.publicCert = `-----BEGIN CERTIFICATE-----\n${pem.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`
    }
    sig.loadSignature(bloque)
    const valida = sig.checkSignature(xmlFirmado)
    return { valida, errores: valida ? [] : ['La firma no verifica: el XML cambió después de firmarse o la clave no corresponde.'], digestValue, certificadoIncluido: incluido }
  } catch (e) {
    return { valida: false, errores: [e instanceof Error ? e.message : String(e)], digestValue, certificadoIncluido: incluido }
  }
}
