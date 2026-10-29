import { generateKeyPairSync } from 'node:crypto'
import forge from 'node-forge'

/**
 * Certificado AUTOGENERADO para pruebas. No es un certificado tributario ni lo reconoce ninguna entidad: sirve para
 * ejercitar la lectura del .pfx y la firma. Solo vive en `tests/`.
 */
export interface CertificadoDePrueba {
  pfx: Buffer
  clave: string
  clavePrivadaPem: string
  certificadoPem: string
}

export function generarCertificadoDePrueba(o: { ruc?: string; nombre?: string; clave?: string; desde?: Date; hasta?: Date; conCadena?: boolean; sinClave?: boolean } = {}): CertificadoDePrueba {
  const clave = o.clave ?? 'clave-de-prueba'
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  const priv = forge.pki.privateKeyFromPem(privateKey)
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey)
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8))
  cert.validity.notBefore = o.desde ?? new Date(Date.now() - 86_400_000)
  cert.validity.notAfter = o.hasta ?? new Date(Date.now() + 365 * 86_400_000)
  const attrs = [
    { name: 'commonName', value: o.nombre ?? 'FERRETERIA DE PRUEBA SAC' },
    { name: 'organizationName', value: `RUC ${o.ruc ?? '20123456789'}` },
    { name: 'countryName', value: 'PE' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(priv, forge.md.sha256.create())
  const certificadoPem = forge.pki.certificateToPem(cert)
  // `conCadena`: antes del certificado del titular va OTRO certificado (de otra clave), como la cadena de una entidad de certificación.
  // `sinClave`: un archivo con certificados pero sin clave privada.
  const otro = o.conCadena ? generarCertificadoDePrueba({ nombre: 'ENTIDAD DE CERTIFICACION DE PRUEBA' }).certificadoPem : null
  const certs = otro ? [forge.pki.certificateFromPem(otro), cert] : [cert]
  const p12 = forge.pkcs12.toPkcs12Asn1(o.sinClave ? null : priv, certs, clave, { algorithm: '3des' })
  return { pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'), clave, clavePrivadaPem: forge.pki.privateKeyToPem(priv), certificadoPem }
}
