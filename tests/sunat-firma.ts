import { readFileSync } from 'node:fs'
import { construirXmlUbl } from '../src/features/invoicing/ubl'
import type { ComprobanteFiscal } from '../src/features/invoicing/providers/types'
import { CertificadoInvalido, estadoCertificado, leerPfx } from '../src/features/sunat/certificado'
import { firmarXml, verificarFirmaXml, XmlSinHuecoDeFirma } from '../src/features/sunat/firma'
import { generarCertificadoDePrueba } from './falsos/certificado-prueba'

/**
 * 1B.3 — Certificado y firma. Lo que SÍ se demuestra aquí es matemática: la firma se verifica con la clave pública y
 * cualquier cambio la rompe. Que SUNAT la acepte (algoritmos, forma del KeyInfo) NO se prueba: ⚠️ solo el ambiente beta.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const lanza = (f: () => unknown) => { try { f(); return null } catch (e) { return e as Error } }

const comprobante: ComprobanteFiscal = {
  tipoComprobante: '01', serie: 'F001', correlativo: 7, fechaEmision: '2026-10-24', moneda: 'PEN',
  emisor: { ruc: '20123456789', razonSocial: 'FERRETERIA DE PRUEBA SAC', nombreComercial: 'Ferre', direccion: 'Av. 1', ubigeo: '150101', codigoEstablecimiento: '0000' },
  receptor: { tipoDocumento: '6', numeroDocumento: '20555555556', razonSocial: 'CLIENTE & HIJOS <SAC>', direccion: null },
  lineas: [{ numero: 1, descripcion: 'Cemento "Sol" 42,5 kg', codigoProducto: 'C1', unidadMedida: 'NIU', cantidad: 1, precioUnitario: 11.8, valorUnitario: 10, igv: 1.8, tasaIgv: 0.18, tipoAfectacionIgv: '10', importeTotal: 11.8, descuento: 0 }],
  totalGravado: 10, totalExonerado: 0, totalInafecto: 0, totalIgv: 1.8, totalDescuentos: 0, total: 11.8, totalEnLetras: 'ONCE CON 80/100 SOLES',
}

const prueba = generarCertificadoDePrueba({ ruc: '20123456789' })
const xml = construirXmlUbl(comprobante)

console.log('\n1) Leer el .pfx')
const cert = leerPfx(prueba.pfx, prueba.clave)
check('>>> abre el .pfx y devuelve la clave y el certificado en PEM', cert.clavePrivadaPem.includes('PRIVATE KEY') && cert.certificadoPem.includes('BEGIN CERTIFICATE'))
check('sujeto, emisor, serie y vigencia', cert.sujeto.includes('FERRETERIA DE PRUEBA SAC') && cert.emisor.length > 0 && cert.serie.length > 0 && cert.vence > cert.desde)
check('deduce el RUC del titular (heurística ⚠️)', cert.ruc === '20123456789')
check('>>> clave equivocada → CertificadoInvalido, sin revelar nada', lanza(() => leerPfx(prueba.pfx, 'otra')) instanceof CertificadoInvalido)
check('>>> archivo que no es un .pfx → el MISMO mensaje (no se distingue de la clave mala)', lanza(() => leerPfx(Buffer.from('esto no es un pfx'), 'x'))?.message === lanza(() => leerPfx(prueba.pfx, 'otra'))?.message)
const mensajeDe = (f: () => unknown) => String((lanza(f) as Error | null)?.message)
check('>>> clave equivocada y archivo corrupto dan EXACTAMENTE el mismo mensaje (no se le dice a quien prueba claves cuál falló)', mensajeDe(() => leerPfx(prueba.pfx, 'otra')) === mensajeDe(() => leerPfx(Buffer.from('basura'), 'otra')))
const conCadena = generarCertificadoDePrueba({ conCadena: true, nombre: 'TITULAR REAL SAC' })
check('>>> un .pfx con la cadena ANTES del certificado del titular devuelve el del titular (el que corresponde a la clave privada)', leerPfx(conCadena.pfx, conCadena.clave).sujeto.includes('TITULAR REAL SAC') && leerPfx(conCadena.pfx, conCadena.clave).certificadoPem === conCadena.certificadoPem)
const sinClavePriv = generarCertificadoDePrueba({ sinClave: true })
check('>>> un .pfx sin clave privada se rechaza: no sirve para firmar', /clave privada/.test(mensajeDe(() => leerPfx(sinClavePriv.pfx, sinClavePriv.clave))))
check('el mensaje de error no contiene la clave', !String(lanza(() => leerPfx(prueba.pfx, 'secreta-123'))?.message).includes('secreta-123'))

console.log('\n2) Estado del certificado')
const ahora = new Date()
check('vigente', estadoCertificado({ desde: new Date(+ahora - 1e9), vence: new Date(+ahora + 200 * 86_400_000) }, ahora) === 'vigente')
check('>>> por vencer (≤ 30 días)', estadoCertificado({ desde: new Date(+ahora - 1e9), vence: new Date(+ahora + 10 * 86_400_000) }, ahora) === 'por_vencer')
check('>>> vencido', estadoCertificado({ desde: new Date(+ahora - 2e9), vence: new Date(+ahora - 1000) }, ahora) === 'vencido')
check('aún no vigente', estadoCertificado({ desde: new Date(+ahora + 1e6), vence: new Date(+ahora + 1e9) }, ahora) === 'aun_no_vigente')
const vencido = leerPfx(generarCertificadoDePrueba({ desde: new Date(Date.now() - 400 * 86_400_000), hasta: new Date(Date.now() - 86_400_000) }).pfx, 'clave-de-prueba')
check('un .pfx realmente vencido se detecta al leerlo', estadoCertificado(vencido) === 'vencido')

console.log('\n3) Firmar el XML UBL')
const f = firmarXml(xml, cert)
check('>>> el XML firmado lleva ds:Signature con Id="SignatureSP" DENTRO de ext:ExtensionContent', /<ext:ExtensionContent>\s*<ds:Signature[^>]*Id="SignatureSP"/.test(f.xmlFirmado) && f.xmlFirmado.includes('</ds:Signature></ext:ExtensionContent>'))
check('lleva el certificado en X509Certificate y un DigestValue', f.xmlFirmado.includes('<ds:X509Certificate>') && f.digestValue.length > 20)
check('la firma cubre TODO el documento (Reference URI="") con enveloped + C14N', f.xmlFirmado.includes('<ds:Reference URI="">') && f.xmlFirmado.includes('enveloped-signature') && f.xmlFirmado.includes('REC-xml-c14n-20010315'))
// xml-crypto reserializa el DOM: en texto, &quot; y &apos; pasan a " y ' (equivalentes en XML). Se compara sin esa diferencia.
  const sinEntidades = (x: string) => x.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  check('el contenido del comprobante no se tocó (solo se rellenó el hueco)', sinEntidades(f.xmlFirmado.replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, '')) === sinEntidades(xml.replace('<ext:ExtensionContent/>', '<ext:ExtensionContent></ext:ExtensionContent>')))
check('es XML bien formado (los caracteres especiales siguen escapados)', f.xmlFirmado.includes('CLIENTE &amp; HIJOS &lt;SAC&gt;'))
check('>>> firmar es repetible: el mismo XML da el mismo DigestValue', firmarXml(xml, cert).digestValue === f.digestValue)
check('>>> por defecto se firma con RSA-SHA256 (⚠️ el algoritmo exigido se confirma con la guía oficial)', firmarXml(xml, cert).xmlFirmado.includes('rsa-sha256') && !firmarXml(xml, cert).xmlFirmado.includes('rsa-sha1'))
check('RSA-SHA1 también (⚠️ por si SUNAT lo exige)', firmarXml(xml, cert, { algoritmo: 'sha1' }).xmlFirmado.includes('rsa-sha1'))
check('>>> un XML sin el hueco de firma no se firma', lanza(() => firmarXml('<Invoice><a/></Invoice>', cert)) instanceof XmlSinHuecoDeFirma)

console.log('\n4) Verificar la firma (lo que SÍ es demostrable)')
const v = verificarFirmaXml(f.xmlFirmado, cert.certificadoPem)
check('>>> verifica con la clave pública del certificado', v.valida && v.errores.length === 0 && v.digestValue === f.digestValue)
check('también con el certificado incluido en el XML (integridad, no autoría)', verificarFirmaXml(f.xmlFirmado).valida)
check('>>> cambiar UN carácter del contenido invalida la firma', !verificarFirmaXml(f.xmlFirmado.replace('<cbc:ID>F001-7</cbc:ID>', '<cbc:ID>F001-8</cbc:ID>'), cert.certificadoPem).valida)
check('>>> cambiar el importe invalida la firma', !verificarFirmaXml(f.xmlFirmado.replace('>11.80<', '>1.80<'), cert.certificadoPem).valida)
const otro = generarCertificadoDePrueba({ nombre: 'OTRA EMPRESA' })
check('>>> otro certificado NO verifica (no basta con que la firma sea válida: importa QUIÉN firmó)', !verificarFirmaXml(f.xmlFirmado, otro.certificadoPem).valida)
check('>>> sin firma → no válida, con motivo', (() => { const r = verificarFirmaXml(xml); return !r.valida && r.errores[0] === 'El XML no tiene firma.' })())
const robada = f.xmlFirmado.replace(/(<ds:SignatureValue>)([^<]{10})/, '$1AAAAAAAAAA')
check('>>> alterar el valor de la firma la invalida', !verificarFirmaXml(robada, cert.certificadoPem).valida)

console.log('\n5) Higiene')
const codigo = readFileSync('src/features/sunat/firma.ts', 'utf8') + readFileSync('src/features/sunat/certificado.ts', 'utf8')
check('>>> el código no escribe la clave privada en logs', !/console\.(log|error|warn)/.test(codigo))
check('el módulo marca ⚠️ lo no validado contra SUNAT', readFileSync('src/features/sunat/firma.ts', 'utf8').includes('SIN VALIDAR CONTRA SUNAT'))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
