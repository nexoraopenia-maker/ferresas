import { servidorFalso, json } from './http-falso'
import { crearProveedorPseRest, ErrorConfiguracionProveedor } from '../src/features/invoicing/providers'
import type { ComprobanteFiscal, CredencialesProveedor } from '../src/features/invoicing/providers/types'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const rechaza = async (f: () => Promise<unknown>) => { try { await f(); return null } catch (e) { return e } }

const comprobante = (n = 12): ComprobanteFiscal => ({
  tipoComprobante: '03', serie: 'B001', correlativo: n, fechaEmision: '2026-10-20', moneda: 'PEN',
  emisor: { ruc: '20131312955', razonSocial: 'FERRETERÍA S.A.C.', nombreComercial: 'Sol', direccion: 'Av. 1', ubigeo: '150101', codigoEstablecimiento: '0000' },
  receptor: { tipoDocumento: '1', numeroDocumento: '41235678', razonSocial: 'María', direccion: null },
  lineas: [{ numero: 1, descripcion: 'Cemento', codigoProducto: 'CEM', unidadMedida: 'BG', cantidad: 2, precioUnitario: 32.9, valorUnitario: 27.88, igv: 10.04, tasaIgv: 0.18, tipoAfectacionIgv: '10', importeTotal: 65.8, descuento: 0 }],
  totalGravado: 55.76, totalExonerado: 0, totalInafecto: 0, totalIgv: 10.04, totalDescuentos: 0, total: 65.8,
  totalEnLetras: 'SON: SESENTA Y CINCO CON 80/100 SOLES',
})

async function main() {
  const TOKEN = 'tok_secreto_abcdef'
  let modo = 'acepta'
  const srv = await servidorFalso(async (req, res) => {
    if (req.ruta.startsWith('/redir-destino')) return json(res, 200, { estado: 'ACEPTADO', hash: 'h' })
    if (req.ruta === '/salud') return json(res, 200, { ok: true, mensaje: 'Todo bien', certificado_vence_en: '2027-03-01' })
    if (req.ruta.endsWith('/baja')) return json(res, 200, { estado: 'ANULADO', ticket: 'T-BAJA', mensaje: 'Baja recibida' })
    if (req.ruta.includes('/descarga/')) return json(res, 200, { contenido_base64: Buffer.from('<xml/>').toString('base64'), nombre: 'B001-12.xml', mime: 'application/xml' })
    if (req.metodo === 'GET' && req.ruta.startsWith('/comprobantes/')) return json(res, 200, { estado: 'ACEPTADO', hash: 'HASH-CONSULTA', codigo: '0', mensaje: 'Aceptada' })
    switch (modo) {
      case 'acepta': return json(res, 200, { estado: 'ACEPTADO', hash: 'DigestValueABC=', codigo: '0', mensaje: 'La Boleta numero B001-12 ha sido aceptada', id: 'ext-1' })
      case 'observa': return json(res, 200, { estado: 'OBSERVADO', hash: 'DigestValueXYZ=', codigo: '4000', mensaje: 'Observación: dirección sin ubigeo' })
      case 'rechaza': return json(res, 422, { mensaje: 'RUC del receptor no existe\u0007\n(2800)' })
      case 'async': return json(res, 202, { estado: 'PENDIENTE', ticket: 'TK-9', id: 'ext-9' })
      case 'sin-token': return json(res, 401, { mensaje: 'token inválido' })
      case 'prohibido': return json(res, 403, {})
      case 'caido': return json(res, 503, { mensaje: 'mantenimiento' })
      case 'limite': return json(res, 429, {})
      case 'basura': res.statusCode = 200; res.end('<html>no soy json</html>'); return
      case 'estado-raro': return json(res, 200, { estado: 'QUIEN_SABE' })
      case 'redirige': res.statusCode = 302; res.setHeader('Location', `${srv.url}/redir-destino`); res.end(); return
      case 'enorme': res.statusCode = 200; res.end('x'.repeat(2_000_000)); return
      case 'cuelga': return // nunca responde
      case 'rechazado-con-hash': return json(res, 200, { estado: 'RECHAZADO', hash: 'NO-DEBE-GUARDARSE', codigo: '2800', mensaje: 'rechazado' })
    }
  })
  const cred: CredencialesProveedor = { usuario: '', clave: '', modoPruebas: true, urlBase: srv.url, token: TOKEN }
  const p = crearProveedorPseRest({ permitirRedLocal: true, timeoutMs: 400 })

  console.log('\n1) La petición que sale')
  modo = 'acepta'
  const r = await p.emitir(comprobante(), cred)
  const req = srv.peticiones[0]!
  check('POST /comprobantes', req.metodo === 'POST' && req.ruta === '/comprobantes')
  check('>>> el token va como Authorization: Bearer', req.cabeceras.authorization === `Bearer ${TOKEN}`)
  check('>>> lleva Idempotency-Key = RUC-tipo-serie-correlativo', req.cabeceras['idempotency-key'] === '20131312955-03-B001-12')
  const cuerpo = JSON.parse(req.cuerpo)
  check('el cuerpo trae el comprobante y el UBL en base64', cuerpo.version === 1 && cuerpo.comprobante.serie === 'B001' && Buffer.from(cuerpo.xml_ubl_base64, 'base64').toString().includes('<cbc:ID>B001-12</cbc:ID>'))
  check('>>> el token NO viaja en el cuerpo ni en la URL', !req.cuerpo.includes(TOKEN) && !req.ruta.includes(TOKEN))

  console.log('\n2) Respuestas')
  check('>>> ACEPTADO: guarda el hash (DigestValue), el código y el mensaje', r.estado === 'ACEPTADO' && r.hashXml === 'DigestValueABC=' && r.codigoRespuesta === '0' && !!r.mensaje && r.idExterno === 'ext-1' && !r.reintentable)
  modo = 'observa'
  const o = await p.emitir(comprobante(13), cred)
  check('>>> OBSERVADO: válido, con hash y con la advertencia', o.estado === 'OBSERVADO' && o.hashXml === 'DigestValueXYZ=' && o.codigoRespuesta === '4000' && !o.reintentable)
  modo = 'rechaza'
  const rc = await p.emitir(comprobante(14), cred)
  check('>>> RECHAZADO (422): no reintentable y con el motivo, sin caracteres de control', rc.estado === 'RECHAZADO' && !rc.reintentable && !!rc.mensaje?.includes('RUC del receptor') && !/[\u0000-\u001F]/.test(rc.mensaje ?? ''), rc.mensaje ?? '')
  check('un rechazado no guarda hash', rc.hashXml === null)
  modo = 'rechazado-con-hash'
  check('>>> si el proveedor manda hash en un RECHAZADO, se ignora', (await p.emitir(comprobante(15), cred)).hashXml === null)
  modo = 'async'
  const a = await p.emitir(comprobante(16), cred)
  check('asíncrono: queda ENVIADO con su ticket', a.estado === 'ENVIADO' && a.ticket === 'TK-9' && a.idExterno === 'ext-9' && !a.reintentable)

  console.log('\n3) Cuando algo falla')
  for (const [m, que] of [['caido', '503'], ['limite', '429'], ['basura', 'respuesta que no es JSON'], ['estado-raro', 'estado desconocido'], ['redirige', 'redirección'], ['enorme', 'respuesta de 2 MB'], ['cuelga', 'sin respuesta (timeout)']] as const) {
    modo = m
    const x = await p.emitir(comprobante(20), cred)
    check(`>>> ${que}: PENDIENTE y reintentable, NUNCA aceptado`, x.estado === 'PENDIENTE' && x.reintentable && x.hashXml === null, `${x.estado} ${x.mensaje}`)
  }
  check('>>> la redirección NO se siguió', !srv.peticiones.some((q) => q.ruta.startsWith('/redir-destino')))
  for (const m of ['sin-token', 'prohibido']) {
    modo = m
    const e = await rechaza(() => p.emitir(comprobante(21), cred))
    check(`>>> ${m === 'sin-token' ? '401' : '403'}: es un problema de CONFIGURACIÓN, no un rechazo del comprobante`, e instanceof ErrorConfiguracionProveedor)
  }
  const cerrado = await servidorFalso(() => {})
  const urlMuerta = cerrado.url
  await cerrado.cerrar()
  const sinServidor = await p.emitir(comprobante(22), { ...cred, urlBase: urlMuerta })
  check('>>> conexión rechazada: reintentable', sinServidor.estado === 'PENDIENTE' && sinServidor.reintentable)
  check('faltan URL o token: error de configuración', (await rechaza(() => p.emitir(comprobante(), { ...cred, token: undefined }))) instanceof ErrorConfiguracionProveedor && (await rechaza(() => p.emitir(comprobante(), { ...cred, urlBase: undefined }))) instanceof ErrorConfiguracionProveedor)
  check('>>> un comprobante con totales que no cuadran NO sale', (await rechaza(() => p.emitir({ ...comprobante(), total: 1 }, cred))) !== null)

  console.log('\n4) Consultar, anular, descargar, probar')
  const c = await p.consultarEstado({ idExterno: 'ext-1', ticket: null, serie: 'B001', correlativo: 12 }, cred)
  check('consultar: estado y hash', c.estado === 'ACEPTADO' && c.hashXml === 'HASH-CONSULTA')
  check('usa el id externo en la ruta (codificado)', srv.peticiones.some((q) => q.ruta === '/comprobantes/ext-1'))
  await p.consultarEstado({ idExterno: null, ticket: null, serie: 'B001', correlativo: 12 }, cred)
  check('sin id externo usa SERIE-CORRELATIVO', srv.peticiones.some((q) => q.ruta === '/comprobantes/B001-12'))
  modo = 'caido'
  const cx = await p.consultarEstado({ idExterno: 'caido', ticket: null, serie: 'B001', correlativo: 12 }, { ...cred, urlBase: urlMuerta })
  check('>>> consultar con el proveedor caído deja el estado como ENVIADO (no inventa)', cx.estado === 'ENVIADO')
  const baja = await p.anular({ idExterno: 'ext-1', serie: 'B001', correlativo: 12, tipoComprobante: '03' }, 'Error en el monto', cred)
  check('anular: ticket de baja', baja.ticket === 'T-BAJA')
  check('descargar: archivo', (await p.descargar({ idExterno: 'ext-1', serie: 'B001', correlativo: 12 }, 'XML', cred)).nombreArchivo === 'B001-12.xml')
  const salud = await p.verificarCredenciales(cred)
  check('probar conexión: ok y vencimiento del certificado', salud.ok && salud.certificadoVenceEn === '2027-03-01')
  check('probar con token mal: error de configuración', (modo = 'sin-token', true) && (await rechaza(() => p.verificarCredenciales({ ...cred, token: undefined }))) instanceof ErrorConfiguracionProveedor)

  console.log('\n5) >>> Sin el atajo de pruebas, el servidor NO llega a redes internas')
  const antes = srv.peticiones.length
  const real = crearProveedorPseRest()
  for (const url of [srv.url, 'https://127.0.0.1', 'https://169.254.169.254/latest', 'https://localhost:8443', 'http://api.proveedor.pe']) {
    check(`${url} se rechaza antes de conectar`, (await rechaza(() => real.emitir(comprobante(), { ...cred, urlBase: url }))) instanceof ErrorConfiguracionProveedor)
  }
  check('y no llegó ninguna petición al servidor local', srv.peticiones.length === antes)

  await srv.cerrar()
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
