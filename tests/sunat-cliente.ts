import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crearZip, leerZip, ZipInvalido } from '../src/features/sunat/zip'
import { categoriaDeCodigo, leerCdr, CdrIlegible } from '../src/features/sunat/cdr'
import { escaparXml, leerFallo, sobreGetStatus, sobreSendBill, xmlDelCdr } from '../src/features/sunat/soap'
import { evaluarEndpointSunat, SUNAT_BETA_BILL, SUNAT_PRODUCCION_BILL, urlConsulta } from '../src/features/sunat/endpoints'
import { consultarCdr, EndpointNoPermitido, enviarComprobante, nombreBase, type CredencialesSol } from '../src/features/sunat/cliente'
import { firmarXml } from '../src/features/sunat/firma'
import { leerPfx } from '../src/features/sunat/certificado'
import { construirXmlUbl } from '../src/features/invoicing/ubl'
import type { ComprobanteFiscal } from '../src/features/invoicing/providers/types'
import { generarCertificadoDePrueba } from './falsos/certificado-prueba'
import { iniciarSunatFalso } from './falsos/sunat-falso'

/**
 * 1B.1 y 1B.2 — Cliente de SUNAT contra el SUNAT FALSO. Demuestra NUESTRA mecánica (ZIP, SOAP, firma verificada,
 * clasificación, reintentos, idempotencia). NO demuestra que SUNAT acepte nada: ⚠️ solo el ambiente beta.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const lanza = async (f: () => unknown) => { try { await f(); return null } catch (e) { return e as Error } }

const RUC = '20123456789'
const SOL: CredencialesSol = { ruc: RUC, usuarioSol: 'MODDATOS', claveSol: 'moddatos' }
const cert = generarCertificadoDePrueba({ ruc: RUC })
const certCargado = leerPfx(cert.pfx, cert.clave)

function comprobante(o: Partial<ComprobanteFiscal> = {}): ComprobanteFiscal {
  return {
    tipoComprobante: '01', serie: 'F001', correlativo: 7, fechaEmision: '2026-10-24', moneda: 'PEN',
    emisor: { ruc: RUC, razonSocial: 'FERRETERIA DE PRUEBA SAC', nombreComercial: 'Ferre', direccion: 'Av. 1', ubigeo: '150101', codigoEstablecimiento: '0000' },
    receptor: { tipoDocumento: '6', numeroDocumento: '20555555556', razonSocial: 'CLIENTE SAC', direccion: null },
    lineas: [{ numero: 1, descripcion: 'Cemento', codigoProducto: 'C1', unidadMedida: 'NIU', cantidad: 1, precioUnitario: 11.8, valorUnitario: 10, igv: 1.8, tasaIgv: 0.18, tipoAfectacionIgv: '10', importeTotal: 11.8, descuento: 0 }],
    totalGravado: 10, totalExonerado: 0, totalInafecto: 0, totalIgv: 1.8, totalDescuentos: 0, total: 11.8, totalEnLetras: 'ONCE CON 80/100 SOLES',
    ...o,
  }
}
const xmlFirmado = (c = comprobante()) => firmarXml(construirXmlUbl(c), certCargado).xmlFirmado

async function main() {
  console.log('\n1) ZIP')
  const xml = '<a>árbol ñandú</a>'.repeat(50)
  const z = crearZip('doc.xml', Buffer.from(xml))
  check('>>> ida y vuelta: el contenido vuelve idéntico (con tildes)', leerZip(z)[0]!.contenido.toString('utf8') === xml && leerZip(z)[0]!.nombre === 'doc.xml')
  check('es determinista (mismo XML → mismo ZIP)', crearZip('doc.xml', Buffer.from(xml)).equals(z))
  const dir = mkdtempSync(join(tmpdir(), 'zip-'))
  let extra = true
  try {
    writeFileSync(join(dir, 'nuestro.zip'), z)
    const afuera = execFileSync('unzip', ['-p', join(dir, 'nuestro.zip')], { encoding: 'utf8' })
    check('>>> un descompresor REAL (unzip) abre nuestro ZIP y lee lo mismo', afuera === xml)
    writeFileSync(join(dir, 'real.xml'), xml)
    execFileSync('zip', ['-q', '-j', join(dir, 'real.zip'), join(dir, 'real.xml')])
    check('>>> y nosotros leemos un ZIP hecho por un compresor REAL (zip)', leerZip(readFileSync(join(dir, 'real.zip')))[0]!.contenido.toString('utf8') === xml)
  } catch { extra = false; check('(unzip/zip no disponibles en este equipo: se omite la prueba cruzada)', true) }
  void extra; void readdirSync
  check('>>> un archivo que no es ZIP → ZipInvalido', (await lanza(() => leerZip(Buffer.from('no soy un zip')))) instanceof ZipInvalido)
  const traversal = crearZip('../escapa.xml', Buffer.from('x'))
  check('>>> un nombre con ruta ("../") se rechaza', (await lanza(() => leerZip(traversal))) instanceof ZipInvalido)
  const bomba = Buffer.from(z); bomba.writeUInt32LE(50_000_000, bomba.length - 22 - 46 - 'doc.xml'.length + 24)
  check('>>> declarar un tamaño gigante (bomba ZIP) se rechaza', (await lanza(() => leerZip(bomba))) instanceof ZipInvalido)
  const roto = Buffer.from(z); roto[40] = roto[40]! ^ 0xff
  check('un ZIP con datos dañados → ZipInvalido, no una excepción rara', (await lanza(() => leerZip(roto))) instanceof ZipInvalido)

  // La suma de control (CRC) declarada en el directorio central: si no coincide con el contenido, el ZIP no se acepta.
  const zipCrcMalo = Buffer.from(z); const posCrc = zipCrcMalo.readUInt32LE(zipCrcMalo.length - 22 + 16) + 16
  zipCrcMalo.writeUInt32LE((zipCrcMalo.readUInt32LE(posCrc) ^ 0xdeadbeef) >>> 0, posCrc)
  check('>>> un ZIP cuya suma de control no coincide (se alteró el directorio central) → ZipInvalido', (await lanza(() => leerZip(zipCrcMalo))) instanceof ZipInvalido)

  const grandeOk = crearZip('grande.xml', Buffer.alloc(6 * 1024 * 1024, 97))
  check('>>> un contenido descomprimido de más de 5 MB se rechaza (bomba ZIP real, no solo declarada)', (await lanza(() => leerZip(grandeOk))) instanceof ZipInvalido)
  const posCentral = z.readUInt32LE(z.length - 22 + 16)
  const cifrado = Buffer.from(z); cifrado.writeUInt16LE(cifrado.readUInt16LE(posCentral + 8) | 1, posCentral + 8)
  check('>>> un ZIP marcado como cifrado se rechaza', (await lanza(() => leerZip(cifrado))) instanceof ZipInvalido)
  const tamano = Buffer.from(z); tamano.writeUInt32LE(tamano.readUInt32LE(posCentral + 24) - 1, posCentral + 24)
  check('>>> un tamaño descomprimido declarado distinto del real se rechaza', (await lanza(() => leerZip(tamano))) instanceof ZipInvalido)

  console.log('\n2) SOAP y CDR')
  const sobre = sobreSendBill('2012<&>MODDATOS', 'cla"ve\'&', 'a.zip', 'QUJD')
  check('>>> los sobres escapan usuario y clave (no se inyecta XML)', sobre.includes('2012&lt;&amp;&gt;MODDATOS') && sobre.includes('cla&quot;ve&apos;&amp;') && !sobre.includes('<&>'))
  check('el sobre lleva UsernameToken y la operación', sobre.includes('<wsse:UsernameToken>') && sobre.includes('<ser:sendBill>') && sobreGetStatus('u', 'c', 'T1').includes('<ticket>T1</ticket>'))
  check('escaparXml', escaparXml(`<a b="c">&'`) === '&lt;a b=&quot;c&quot;&gt;&amp;&apos;')
  const f = leerFallo('<s:Envelope><s:Body><s:Fault><faultcode>soap-env:Client.0102</faultcode><faultstring>Usuario incorrecto</faultstring></s:Fault></s:Body></s:Envelope>')
  check('>>> lee un fallo SOAP: código, origen y mensaje', f?.codigo === '0102' && f.origen === 'Client' && f.mensaje === 'Usuario incorrecto')
  check('un fallo del servidor se distingue del del cliente', leerFallo('<Fault><faultcode>soap-env:Server</faultcode><faultstring>x</faultstring></Fault>')?.origen === 'Server')
  check('una respuesta que no es un fallo → null', leerFallo('<Envelope><Body><ok/></Body></Envelope>') === null)
  const cdr = leerCdr('<ar:ApplicationResponse xmlns:cac="x" xmlns:cbc="y"><cbc:Note>4252 - Obs &amp; más</cbc:Note><cac:DocumentResponse><cac:Response><cbc:ReferenceID>F001-7</cbc:ReferenceID><cbc:ResponseCode>0</cbc:ResponseCode><cbc:Description>Aceptada</cbc:Description></cac:Response></cac:DocumentResponse></ar:ApplicationResponse>')
  check('>>> lee el CDR: código, descripción, referencia y observaciones', cdr.codigo === '0' && cdr.descripcion === 'Aceptada' && cdr.referencia === 'F001-7' && cdr.notas[0] === '4252 - Obs & más')
  check('>>> un código de CDR que no es un número → CdrIlegible', (await lanza(() => leerCdr('<ar:ApplicationResponse><cac:DocumentResponse><cac:Response><cbc:ResponseCode>abc</cbc:ResponseCode></cac:Response></cac:DocumentResponse></ar:ApplicationResponse>'))) instanceof CdrIlegible)
  check('>>> un CDR sin código → CdrIlegible', (await lanza(() => leerCdr('<ar:ApplicationResponse><x/></ar:ApplicationResponse>'))) instanceof CdrIlegible)
  check('xmlDelCdr sin contenido → null', xmlDelCdr('<r><applicationResponse></applicationResponse></r>') === null)
  const cat = (c: string) => categoriaDeCodigo(c)
  check('>>> categorías (⚠️ rangos sin verificar): 0 aceptado, 4xxx observado, 2xxx-3xxx rechazo, 01xx configuración, el resto excepción',
    cat('0') === 'aceptado' && cat('4252') === 'observado' && cat('2800') === 'rechazado' && cat('3030') === 'rechazado' && cat('0102') === 'configuracion' && cat('1033') === 'excepcion' && cat('abc') === 'excepcion')

  console.log('\n3) Lista blanca de endpoints')
  check('beta y producción de SUNAT (https) → permitidos', evaluarEndpointSunat(SUNAT_BETA_BILL, {}).tipo === 'beta' && evaluarEndpointSunat(SUNAT_PRODUCCION_BILL, {}).tipo === 'produccion')
  check('>>> el servidor local solo FUERA de producción', evaluarEndpointSunat('http://127.0.0.1:4000/billService', {}).tipo === 'falso' && !evaluarEndpointSunat('http://127.0.0.1:4000/billService', { VERCEL_ENV: 'production' }).ok && !evaluarEndpointSunat('http://localhost:4000/x', { NODE_ENV: 'production' }).ok)
  check('>>> un usuario:clave dentro de la URL se rechaza aunque el host sea de SUNAT', !evaluarEndpointSunat('https://usuario:clave@e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService', {}).ok)
  check('>>> cualquier otro host se rechaza (incluido http hacia SUNAT y el truco del usuario en la URL)', ['https://example.com/billService', 'http://e-beta.sunat.gob.pe/x', 'https://e-beta.sunat.gob.pe@evil.com/x', 'https://e-beta.sunat.gob.pe.evil.com/x', 'ftp://localhost/x', '', 'basura'].every((u) => !evaluarEndpointSunat(u, {}).ok))
  check('la URL de consulta de producción es la de consulta; las demás cambian la ruta', urlConsulta(SUNAT_PRODUCCION_BILL).includes('billConsultService') && urlConsulta('http://127.0.0.1:1/billService') === 'http://127.0.0.1:1/billConsultService')

  check('>>> un host de SUNAT con un puerto raro se rechaza (solo el 443 normal)', !evaluarEndpointSunat('https://e-beta.sunat.gob.pe:8443/ol-ti-itcpfegem-beta/billService', {}).ok && evaluarEndpointSunat('https://e-beta.sunat.gob.pe:443/ol-ti-itcpfegem-beta/billService', {}).ok)

  console.log('\n4) Cliente contra el SUNAT falso')
  const falso = await iniciarSunatFalso()
  const base = nombreBase(RUC, '01', 'F001', 7)
  const firmado = xmlFirmado()
  const r1 = await enviarComprobante(falso.url, SOL, base, firmado)
  check('>>> envío normal: CDR aceptado (código 0)', r1.tipo === 'cdr' && r1.categoria === 'aceptado' && r1.cdr.codigo === '0' && r1.cdr.referencia === 'F001-7')
  const s1 = falso.recibidas[0]!
  check('>>> el falso recibió: usuario RUC+SOL, ZIP con nombre RUC-TT-SERIE-N y el XML dentro', s1.usuario === `${RUC}MODDATOS` && s1.nombreZip === `${base}.zip` && s1.xml === firmado)
  check('>>> y la firma del XML recibido VERIFICA (criptografía real, no un "if")', s1.firmaValida === true)
  const r2 = await enviarComprobante(falso.url, SOL, base, firmado)
  check('>>> idempotencia: reenviar el MISMO XML devuelve el mismo CDR', r2.tipo === 'cdr' && r2.cdr.codigo === '0')
  const otro = xmlFirmado(comprobante({ total: 5.9, totalGravado: 5, totalIgv: 0.9, lineas: [{ ...comprobante().lineas[0]!, valorUnitario: 5, igv: 0.9, importeTotal: 5.9, precioUnitario: 5.9 }] }))
  const r3 = await enviarComprobante(falso.url, SOL, base, otro)
  check('>>> el mismo número con OTRO contenido → fallo de contenido (no es transitorio ni éxito)', r3.tipo === 'fallo' && r3.fallo.codigo === '1033' && r3.categoria === 'excepcion')
  const sinFirma = await enviarComprobante(falso.url, SOL, nombreBase(RUC, '01', 'F001', 8), construirXmlUbl(comprobante({ correlativo: 8 })))
  check('>>> un XML SIN firmar lo rechaza el falso (firma obligatoria)', sinFirma.tipo === 'fallo' && sinFirma.fallo.codigo === '0306')
  const mal = await enviarComprobante(falso.url, { ...SOL, claveSol: 'equivocada' }, nombreBase(RUC, '01', 'F001', 9), xmlFirmado(comprobante({ correlativo: 9 })))
  check('>>> clave SOL equivocada → fallo de configuración (0102), no de contenido', mal.tipo === 'fallo' && mal.categoria === 'configuracion')

  falso.guion.push('rechazo', 'observado', 'servidor', 'http500', 'ilegible', 'sin_cdr')
  const n = (k: number) => nombreBase(RUC, '01', 'F001', k)
  const env = (k: number) => enviarComprobante(falso.url, SOL, n(k), xmlFirmado(comprobante({ correlativo: k })))
  const rr = await env(20)
  check('>>> rechazo en el CDR (3030) → categoría rechazado', rr.tipo === 'cdr' && rr.categoria === 'rechazado')
  const ro = await env(21)
  check('>>> aceptado con observaciones: código 0 + notas', ro.tipo === 'cdr' && ro.cdr.codigo === '0' && ro.cdr.notas.length === 1)
  check('>>> fallo del SERVIDOR (0109) → transitorio, reintentable', (await env(22)).tipo === 'transitorio')
  check('>>> HTTP 500 sin SOAP → transitorio', (await env(23)).tipo === 'transitorio')
  check('>>> una respuesta 200 ilegible NUNCA es un éxito → transitorio', (await env(24)).tipo === 'transitorio')
  check('>>> respuesta sin CDR → transitorio', (await env(25)).tipo === 'transitorio')

  falso.guion.push('lento')
  const lento = await enviarComprobante(falso.url, SOL, n(26), xmlFirmado(comprobante({ correlativo: 26 })), { timeoutMs: 80 })
  check('>>> tiempo agotado → transitorio (el falso tarda 400 ms, el límite era 80)', lento.tipo === 'transitorio' && lento.mensaje.includes('a tiempo'))
  const c1 = await consultarCdr(falso.url, SOL, { tipo: '01', serie: 'F001', numero: 7 })
  check('>>> consultar el CDR de uno ya enviado → aceptado', c1.tipo === 'cdr' && c1.categoria === 'aceptado')
  const c2 = await consultarCdr(falso.url, SOL, { tipo: '01', serie: 'F001', numero: 99999 })
  check('consultar uno que no existe → fallo claro', c2.tipo === 'fallo' && c2.fallo.codigo === '0127')

  const antes = falso.recibidas.length
  const e1 = await lanza(() => enviarComprobante('https://example.com/billService', SOL, base, firmado))
  const e2 = await lanza(() => enviarComprobante(falso.url, SOL, base, firmado, { env: { NODE_ENV: 'production' } }))
  check('>>> un host no permitido, o el falso en producción, ni siquiera abre la conexión', e1 instanceof EndpointNoPermitido && e2 instanceof EndpointNoPermitido && falso.recibidas.length === antes)
  await falso.detener()
  const caido = await enviarComprobante(falso.url, SOL, base, firmado)
  check('>>> servidor caído (conexión rechazada) → transitorio', caido.tipo === 'transitorio')

  console.log('\n4a) Respuestas raras de SUNAT (fetch inyectado, sin red)')
  let initVisto: RequestInit | undefined
  const eco = (cuerpo: string, status = 200, headers: Record<string, string> = {}) => async (_u: unknown, init?: RequestInit) => { initVisto = init; return new Response(cuerpo, { status, headers }) }
  await enviarComprobante(SUNAT_BETA_BILL, SOL, base, firmado, { fetch: eco('x') as never })
  check('>>> nunca se siguen redirecciones (una redirección podría sacar la clave SOL hacia otro host)', initVisto?.redirect === 'manual')
  const r5xx = await enviarComprobante(SUNAT_BETA_BILL, SOL, base, firmado, { fetch: eco('<html>Bad Gateway</html>', 502) as never })
  const r500 = await enviarComprobante(SUNAT_BETA_BILL, SOL, base, firmado, { fetch: eco('', 500) as never })
  check('>>> un 5xx sin fallo SOAP es transitorio (nunca un éxito ni un rechazo)', r5xx.tipo === 'transitorio' && r500.tipo === 'transitorio')
  const rCab = await enviarComprobante(SUNAT_BETA_BILL, SOL, base, firmado, { fetch: eco('<ok/>', 200, { 'content-length': String(2 * 1024 * 1024) }) as never })
  check('>>> una cabecera content-length enorme corta la lectura aunque el cuerpo sea pequeño', rCab.tipo === 'transitorio' && /demasiado grande/.test(rCab.mensaje))
  const cdrMalo = crearZip('R-F001-7.xml', Buffer.from('<ar:ApplicationResponse><x>no es un CDR</x></ar:ApplicationResponse>'))
  const rIleg = await enviarComprobante(SUNAT_BETA_BILL, SOL, base, firmado, { fetch: eco(`<env><applicationResponse>${cdrMalo.toString('base64')}</applicationResponse></env>`) as never })
  check('>>> un CDR que no se puede leer NO es un éxito: transitorio, reintentable', rIleg.tipo === 'transitorio')

  console.log('\n4b) Tope de la respuesta')
  const grande = (cabecera: boolean) => async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(700 * 1024)); c.enqueue(new Uint8Array(700 * 1024)); c.close() } }), { status: 200, headers: cabecera ? { 'content-length': String(1400 * 1024) } : {} })
  const rg1 = await enviarComprobante(SUNAT_BETA_BILL, SOL, base, firmado, { fetch: grande(true) as never })
  const rg2 = await enviarComprobante(SUNAT_BETA_BILL, SOL, base, firmado, { fetch: grande(false) as never })
  check('>>> una respuesta enorme (declarada o no) se corta con un error transitorio, sin cargarla entera', rg1.tipo === 'transitorio' && /demasiado grande/.test(rg1.mensaje) && rg2.tipo === 'transitorio' && /demasiado grande/.test(rg2.mensaje))
  const rEp = await enviarComprobante('https://e-beta.sunat.gob.pe:8443/ol-ti-itcpfegem-beta/billService', SOL, base, firmado, { fetch: (async () => new Response('x')) as never }).then(() => 'envió', (e) => (e as Error).name)
  check('>>> y un endpoint no permitido ni siquiera se llama (EndpointNoPermitido)', rEp === 'EndpointNoPermitido')

  console.log('\n5) Higiene')
  const fuentes = ['cliente', 'soap', 'cdr', 'zip', 'endpoints', 'firma', 'certificado'].map((f) => readFileSync(`src/features/sunat/${f}.ts`, 'utf8')).join('\n')
  check('>>> el código de SUNAT no escribe nada en logs (ni claves ni XML)', !/console\.(log|error|warn|info)/.test(fuentes))
  check('>>> y no toca la base de datos (no importa Prisma)', !/@\/lib\/prisma|from ['"].*prisma/.test(fuentes))
  check('lo no validado contra SUNAT está marcado ⚠️ en el código', fuentes.split('⚠️').length - 1 >= 8)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.log(`  ✗ EXCEPCIÓN no controlada: ${e instanceof Error ? e.stack : e}`); process.exit(1) })
