import { readFileSync } from 'node:fs'
import { crearProveedorSunatDirecto } from '../src/features/sunat/proveedor'
import { verificarFirmaXml } from '../src/features/sunat/firma'
import { obtenerProveedor, ErrorConfiguracionProveedor, proveedoresDisponibles } from '../src/features/invoicing/providers'
import type { ComprobanteFiscal, CredencialesProveedor } from '../src/features/invoicing/providers/types'
import { generarCertificadoDePrueba } from './falsos/certificado-prueba'
import { iniciarSunatFalso } from './falsos/sunat-falso'

/**
 * S3 · El proveedor `sunat-directo` contra el SUNAT falso: factura, boleta y nota de crédito por el MISMO envío, todos los desenlaces (aceptado, observado, rechazado, caída, respuesta ilegible,
 * acceso denegado), los problemas de configuración (que NO cambian el estado del comprobante), los archivos fiscales que devuelve y que no filtra secretos.
 * ⚠️ Prueba NUESTRA mecánica, no que SUNAT acepte el XML (docs/SUNAT-SUPUESTOS.md).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const lanza = async (f: () => unknown) => { try { await f(); return null } catch (e) { return e as Error } }

const RUC = '20123456789'
const SOLCLAVE = 'moddatos-SECRETA'
const cert = generarCertificadoDePrueba({ ruc: RUC, clave: 'clave-pfx-SECRETA' })

function comprobante(tipo: '01' | '03' | '07', o: Partial<ComprobanteFiscal> = {}): ComprobanteFiscal {
  const rel = tipo === '07' ? { tipoComprobante: '01' as const, serie: 'F001', correlativo: 3, motivo: '06', descripcionMotivo: 'Devolución total' } : undefined
  return {
    tipoComprobante: tipo, serie: tipo === '01' ? 'F001' : tipo === '03' ? 'B001' : 'FC01', correlativo: 7, fechaEmision: '2026-10-29', moneda: 'PEN',
    emisor: { ruc: RUC, razonSocial: 'FERRETERIA SAC', nombreComercial: 'Ferre', direccion: 'Av. 1', ubigeo: '150101', codigoEstablecimiento: '0000' },
    receptor: { tipoDocumento: tipo === '03' ? '1' : '6', numeroDocumento: tipo === '03' ? '41235678' : '20999999991', razonSocial: 'CLIENTE', direccion: null },
    lineas: [{ numero: 1, descripcion: 'Cemento', codigoProducto: 'C1', unidadMedida: 'NIU', cantidad: 1, precioUnitario: 11.8, valorUnitario: 10, igv: 1.8, tasaIgv: 0.18, tipoAfectacionIgv: '10', importeTotal: 11.8, descuento: 0 }],
    totalGravado: 10, totalExonerado: 0, totalInafecto: 0, totalIgv: 1.8, totalDescuentos: 0, total: 11.8, totalEnLetras: 'ONCE CON 80/100 SOLES',
    ...(rel ? { documentoRelacionado: rel } : {}), ...o,
  }
}
const cred = (url: string, o: Partial<CredencialesProveedor> = {}): CredencialesProveedor => ({
  usuario: '', clave: '', modoPruebas: true, urlBase: url, usuarioSol: 'MODDATOS', claveSol: SOLCLAVE,
  certificadoBase64: cert.pfx.toString('base64'), claveCertificado: cert.clave, ...o,
})

async function main() {
  const falso = await iniciarSunatFalso({ usuarios: { [`${RUC}MODDATOS`]: SOLCLAVE } })
  const p = crearProveedorSunatDirecto()
  const url = falso.url

  console.log('\n1) Factura, boleta y nota de crédito: el mismo envío')
  const f = await p.emitir(comprobante('01'), cred(url))
  const sf = falso.recibidas.at(-1)!
  const digest = /<ds:DigestValue>([^<]+)<\/ds:DigestValue>/.exec(sf.xml!)![1]
  check('>>> factura → ACEPTADO, idExterno = RUC-01-SERIE-N, código 0, no reintentable', f.estado === 'ACEPTADO' && f.idExterno === `${RUC}-01-F001-7` && f.codigoRespuesta === '0' && !f.reintentable)
  check('>>> el hash guardado es el DigestValue de la firma que SE ENVIÓ (el del QR)', f.hashXml === digest)
  check('>>> devuelve el XML firmado TAL COMO se envió, y su firma verifica con el certificado del negocio', f.archivos?.xmlFirmado === sf.xml && sf.firmaValida === true && verificarFirmaXml(f.archivos!.xmlFirmado!, cert.certificadoPem).valida)
  check('>>> y el CDR de SUNAT (el ApplicationResponse con su código)', /<cbc:ResponseCode>0<\/cbc:ResponseCode>/.test(f.archivos?.cdrXml ?? '') && /ApplicationResponse/.test(f.archivos?.cdrXml ?? ''))
  const b = await p.emitir(comprobante('03'), cred(url))
  const sb = falso.recibidas.at(-1)!
  check('>>> la BOLETA va por el mismo sendBill (una por una): ACEPTADA, nombre RUC-03-B001-N y operación sendBill', b.estado === 'ACEPTADO' && sb.operacion === 'sendBill' && sb.nombreZip === `${RUC}-03-B001-7.zip` && b.idExterno === `${RUC}-03-B001-7`)
  const n = await p.emitir(comprobante('07'), cred(url))
  const sn = falso.recibidas.at(-1)!
  check('>>> la NOTA DE CRÉDITO va por el mismo envío: se firma un CreditNote con su referencia y SUNAT la acepta', n.estado === 'ACEPTADO' && sn.nombreZip === `${RUC}-07-FC01-7.zip` && /<CreditNote /.test(sn.xml!) && sn.xml!.includes('F001-3') && sn.firmaValida === true)
  const otra = await p.emitir(comprobante('01'), cred(url))
  check('>>> idempotencia: reemitir el MISMO comprobante devuelve lo mismo (mismo hash, mismo código)', otra.estado === 'ACEPTADO' && otra.hashXml === f.hashXml)

  console.log('\n2) Los desenlaces de SUNAT')
  falso.guion.push('observado')
  const o = await p.emitir(comprobante('01', { correlativo: 8 }), cred(url))
  check('>>> código 0 con observaciones → OBSERVADO (⚠️ así lo entendemos), con las notas en el mensaje y el CDR guardado', o.estado === 'OBSERVADO' && /4252/.test(o.mensaje ?? '') && !!o.archivos?.cdrXml && o.hashXml !== null)
  falso.guion.push('rechazo')
  const r = await p.emitir(comprobante('01', { correlativo: 9 }), cred(url))
  check('>>> rechazo → RECHAZADO, definitivo (no reintentable), sin idExterno ni hash', r.estado === 'RECHAZADO' && !r.reintentable && r.idExterno === null && r.hashXml === null && r.codigoRespuesta === '3030')
  check('>>> y de un rechazo se conserva lo que se envió y lo que SUNAT respondió', !!r.archivos?.xmlFirmado && /3030/.test(r.archivos.cdrXml ?? ''))
  for (const esc of ['servidor', 'http500', 'ilegible', 'sin_cdr'] as const) {
    falso.guion.push(esc)
    const t = await p.emitir(comprobante('01', { correlativo: 10 }), cred(url))
    check(`>>> «${esc}» → PENDIENTE y reintentable, JAMÁS aceptado, y no guarda ningún archivo`, t.estado === 'PENDIENTE' && t.reintentable && t.hashXml === null && t.idExterno === null && t.archivos === undefined, JSON.stringify([t.estado, t.reintentable]))
  }
  falso.guion.push('auth')
  const ea = await lanza(() => p.emitir(comprobante('01', { correlativo: 11 }), cred(url)))
  check('>>> SUNAT rechaza el acceso (0102) → error de CONFIGURACIÓN (el comprobante no se rechaza ni cambia de estado)', ea instanceof ErrorConfiguracionProveedor && /acceso/.test(ea.message))
  const mala = await lanza(() => p.emitir(comprobante('01', { correlativo: 12 }), cred(url, { claveSol: 'otra' })))
  check('>>> una clave SOL equivocada es lo mismo: configuración, no rechazo', mala instanceof ErrorConfiguracionProveedor)
  const fetchFallo = (codigo: string) => async () => new Response(`<s:Envelope><s:Body><s:Fault><faultcode>soap-env:Client.${codigo}</faultcode><faultstring>Error del contenido</faultstring></s:Fault></s:Body></s:Envelope>`, { status: 500 })
  const pc = crearProveedorSunatDirecto({ fetch: fetchFallo('0151') as never })
  const c0151 = await pc.emitir(comprobante('01', { correlativo: 13 }), cred(url))
  check('>>> un fallo 01xx que NO es de acceso (p. ej. 0151, el nombre del archivo) es del contenido: RECHAZADO definitivo, no «configuración»', c0151.estado === 'RECHAZADO' && !c0151.reintentable && c0151.codigoRespuesta === '0151')
  check('>>> un rechazo por fallo SOAP (sin CDR) también conserva lo que se envió, para poder revisarlo', !!c0151.archivos?.xmlFirmado && c0151.archivos.cdrXml === undefined)
  const pa = crearProveedorSunatDirecto({ fetch: fetchFallo('0103') as never })
  check('>>> y uno de acceso (0103) sí es de configuración', (await lanza(() => pa.emitir(comprobante('01', { correlativo: 14 }), cred(url)))) instanceof ErrorConfiguracionProveedor)

  console.log('\n3) Problemas de configuración (no cambian el estado)')
  const cfg = async (c: CredencialesProveedor, comp = comprobante('01', { correlativo: 20 })) => lanza(() => p.emitir(comp, c))
  const antes = falso.recibidas.length
  check('>>> sin usuario SOL', (await cfg(cred(url, { usuarioSol: undefined }))) instanceof ErrorConfiguracionProveedor)
  check('>>> sin clave SOL', (await cfg(cred(url, { claveSol: undefined }))) instanceof ErrorConfiguracionProveedor)
  check('>>> sin certificado', (await cfg(cred(url, { certificadoBase64: undefined }))) instanceof ErrorConfiguracionProveedor)
  check('>>> clave del certificado equivocada', (await cfg(cred(url, { claveCertificado: 'mala' }))) instanceof ErrorConfiguracionProveedor)
  check('>>> endpoint que no es de SUNAT', (await cfg(cred('https://example.com/billService'))) instanceof ErrorConfiguracionProveedor)
  const otroRuc = generarCertificadoDePrueba({ ruc: '20999999991', clave: 'c' })
  check('>>> certificado de OTRO RUC (⚠️ heurística)', /no corresponde al RUC/.test((await cfg(cred(url, { certificadoBase64: otroRuc.pfx.toString('base64'), claveCertificado: 'c' })))?.message ?? ''))
  const vencido = generarCertificadoDePrueba({ ruc: RUC, clave: 'c', desde: new Date(Date.now() - 400 * 86_400_000), hasta: new Date(Date.now() - 86_400_000) })
  check('>>> certificado vencido', /vencido/.test((await cfg(cred(url, { certificadoBase64: vencido.pfx.toString('base64'), claveCertificado: 'c' })))?.message ?? ''))
  check('>>> nada de eso llegó a SUNAT', falso.recibidas.length === antes)
  const mensajes = [await cfg(cred(url, { claveCertificado: 'mala' })), await cfg(cred(url, { usuarioSol: undefined })), ea, mala].map((e) => e?.message ?? '').join('|')
  check('>>> ningún mensaje de error lleva una clave', !mensajes.includes(SOLCLAVE) && !mensajes.includes('clave-pfx-SECRETA') && !mensajes.includes(cert.pfx.toString('base64').slice(0, 40)))

  console.log('\n4) Consultar, anular, descargar y verificar')
  const e1 = await p.consultarEstado({ idExterno: f.idExterno, ticket: null, serie: 'F001', correlativo: 7 }, cred(url))
  check('>>> consultar un comprobante ya aceptado → ACEPTADO con su CDR', e1.estado === 'ACEPTADO' && e1.codigoRespuesta === '0' && /ApplicationResponse/.test(e1.cdrXml ?? ''))
  const eR = await p.consultarEstado({ idExterno: `${RUC}-01-F001-9`, ticket: null, serie: 'F001', correlativo: 9 }, cred(url))
  check('>>> consultar uno que SUNAT RECHAZÓ da RECHAZADO (nunca aceptado) con su CDR', eR.estado === 'RECHAZADO' && eR.codigoRespuesta === '3030' && /3030/.test(eR.cdrXml ?? ''))
  const eO = await p.consultarEstado({ idExterno: `${RUC}-01-F001-8`, ticket: null, serie: 'F001', correlativo: 8 }, cred(url))
  check('>>> y uno aceptado con observaciones, OBSERVADO', eO.estado === 'OBSERVADO')
  const e2 = await p.consultarEstado({ idExterno: `${RUC}-01-F001-999`, ticket: null, serie: 'F001', correlativo: 999 }, cred(url))
  check('>>> consultar uno que SUNAT no conoce no cambia nada: sigue ENVIADO', e2.estado === 'ENVIADO')
  check('>>> sin identificador, tampoco', (await p.consultarEstado({ idExterno: null, ticket: null, serie: 'F001', correlativo: 1 }, cred(url))).estado === 'ENVIADO')
  check('>>> anular (la baja llega en S4) y descargar (sale de lo guardado) avisan con claridad', (await lanza(() => p.anular({ idExterno: null, serie: 'F001', correlativo: 1, tipoComprobante: '01' }, 'x', cred(url)))) instanceof ErrorConfiguracionProveedor && (await lanza(() => p.descargar({ idExterno: null, serie: 'F001', correlativo: 1 }, 'XML', cred(url)))) instanceof ErrorConfiguracionProveedor)
  check('>>> verificar credenciales: bien, vencido y clave mala (solo comprobaciones locales)', (await p.verificarCredenciales(cred(url))).ok && !(await p.verificarCredenciales(cred(url, { certificadoBase64: vencido.pfx.toString('base64'), claveCertificado: 'c' }))).ok && !(await p.verificarCredenciales(cred(url, { claveCertificado: 'mala' }))).ok)

  console.log('\n5) Registro e higiene')
  check('>>> sunat-directo está registrado y el PSE ya no existe', obtenerProveedor('sunat-directo').nombre === 'sunat-directo' && proveedoresDisponibles().join() === 'mock,sunat-directo')
  check('>>> una cuenta demo NUNCA lo usa, aunque se lo pidan', obtenerProveedor('sunat-directo', { esDemo: true }).nombre !== 'sunat-directo')
  const fuente = readFileSync('src/features/sunat/proveedor.ts', 'utf8')
  check('>>> el proveedor no escribe en logs ni toca la base', !/console\.(log|error|warn|info)/.test(fuente) && !/@\/lib\/prisma|from ['"].*prisma/.test(fuente))
  await falso.detener()

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.log(`  ✗ EXCEPCIÓN no controlada: ${e instanceof Error ? e.stack : e}`); process.exit(1) })
