import forge from 'node-forge'

/**
 * Lectura del certificado digital tributario (.pfx / .p12) de un negocio.
 *
 * Solo LEE y valida: no guarda nada. El almacenamiento cifrado es la fase 1B.4. La clave privada vive en memoria
 * el tiempo justo de firmar y nunca se registra ni se devuelve en un mensaje de error.
 *
 * ⚠️ Lo que NO se comprueba aquí y hay que confirmar con un certificado real: que la cadena sea de una entidad
 * de certificación acreditada ante INDECOPI y que el RUC del titular coincida con el del negocio. La extracción del
 * RUC del sujeto es heurística (11 dígitos): los certificados peruanos lo llevan en campos que varían.
 */

export class CertificadoInvalido extends Error {
  constructor(mensaje: string) { super(mensaje); this.name = 'CertificadoInvalido' }
}

export interface CertificadoCargado {
  clavePrivadaPem: string
  certificadoPem: string
  /** Inicio y fin de validez. */
  desde: Date
  vence: Date
  sujeto: string
  emisor: string
  serie: string
  /** RUC del titular si se pudo deducir del sujeto (heurística ⚠️); si no, null. */
  ruc: string | null
}

export type EstadoCertificado = 'vigente' | 'por_vencer' | 'vencido' | 'aun_no_vigente'

const DIAS_AVISO = 30

export function estadoCertificado(c: Pick<CertificadoCargado, 'desde' | 'vence'>, ahora: Date = new Date()): EstadoCertificado {
  if (ahora < c.desde) return 'aun_no_vigente'
  if (ahora > c.vence) return 'vencido'
  return c.vence.getTime() - ahora.getTime() <= DIAS_AVISO * 86_400_000 ? 'por_vencer' : 'vigente'
}

const nombre = (attrs: forge.pki.CertificateField[]) =>
  attrs.map((a) => `${a.shortName ?? a.name}=${String(a.value)}`).join(', ')

/** Lee el `.pfx`. Lanza `CertificadoInvalido` con un mensaje seguro (sin la clave ni el contenido). */
export function leerPfx(pfx: Buffer, clave: string): CertificadoCargado {
  let p12: forge.pkcs12.Pkcs12Pfx
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')))
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, clave)
  } catch {
    // Mismo mensaje para «archivo corrupto» y «clave equivocada»: no se distingue a quien prueba claves.
    throw new CertificadoInvalido('No se pudo abrir el certificado: el archivo no es un .pfx válido o la clave es incorrecta.')
  }

  const OID_CLAVE_CIFRADA = forge.pki.oids.pkcs8ShroudedKeyBag!
  const OID_CLAVE = forge.pki.oids.keyBag!
  const OID_CERT = forge.pki.oids.certBag!
  const claves = [
    ...(p12.getBags({ bagType: OID_CLAVE_CIFRADA })[OID_CLAVE_CIFRADA] ?? []),
    ...(p12.getBags({ bagType: OID_CLAVE })[OID_CLAVE] ?? []),
  ]
  const certs = p12.getBags({ bagType: OID_CERT })[OID_CERT] ?? []
  const privada = claves[0]?.key as forge.pki.rsa.PrivateKey | undefined
  if (!privada) throw new CertificadoInvalido('El certificado no trae clave privada: no sirve para firmar.')
  if (certs.length === 0) throw new CertificadoInvalido('El archivo no trae ningún certificado.')

  // El certificado del titular es el que corresponde a la clave privada (el resto es la cadena).
  const modulo = privada.n.toString(16)
  const propio = certs
    .map((b: forge.pkcs12.Bag) => b.cert as forge.pki.Certificate)
    .find((c: forge.pki.Certificate) => (c.publicKey as forge.pki.rsa.PublicKey).n.toString(16) === modulo)
  if (!propio) throw new CertificadoInvalido('Ningún certificado del archivo corresponde a su clave privada.')

  const sujeto = nombre(propio.subject.attributes)
  return {
    clavePrivadaPem: forge.pki.privateKeyToPem(privada),
    certificadoPem: forge.pki.certificateToPem(propio),
    desde: propio.validity.notBefore,
    vence: propio.validity.notAfter,
    sujeto,
    emisor: nombre(propio.issuer.attributes),
    serie: propio.serialNumber,
    ruc: /(?<!\d)\d{11}(?!\d)/.exec(sujeto)?.[0] ?? null,
  }
}
