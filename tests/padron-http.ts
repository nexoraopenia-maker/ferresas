import { servidorFalso, json } from './http-falso'
import { completarRuc } from '../src/lib/documentos'
import { consultarPadron, obtenerProveedorPadron } from '../src/features/invoicing/padron'
import { construirUrlPadron, crearPadronHttp, interpretarPadron, TIMEOUT_PADRON_MS } from '../src/features/invoicing/padron-http'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

async function main() {
  const RUC = completarRuc('2051234567')
  const DNI = '41235678'

  console.log('\n1) Interpretar respuestas de distintos proveedores (nombres de campo habituales)')
  check('razonSocial + direccion + estado + condicion', (() => {
    const d = interpretarPadron('RUC', RUC, { razonSocial: 'Ferretería Sol S.A.C.', direccion: 'Av. Lima 1', estado: 'ACTIVO', condicion: 'HABIDO' })
    return d?.nombre === 'FERRETERÍA SOL S.A.C.' && d.direccion === 'AV. LIMA 1' && d.estado === 'ACTIVO' && d.condicion === 'HABIDO'
  })())
  check('nombre_o_razon_social y domicilio_fiscal (snake_case)', interpretarPadron('RUC', RUC, { nombre_o_razon_social: 'X SAC', domicilio_fiscal: 'Jr. 2' })?.direccion === 'JR. 2')
  check('anidado en «data»', interpretarPadron('RUC', RUC, { data: { razon_social: 'Y SAC' } })?.nombre === 'Y SAC')
  check('DNI: nombres + apellidos', interpretarPadron('DNI', DNI, { nombres: 'María', apellidoPaterno: 'Flores', apellidoMaterno: 'Quispe' })?.nombre === 'MARÍA FLORES QUISPE')
  check('DNI: nombreCompleto', interpretarPadron('DNI', DNI, { nombreCompleto: 'Juan Pérez' })?.nombre === 'JUAN PÉREZ')
  check('>>> un DNI no lleva estado ni condición', interpretarPadron('DNI', DNI, { nombreCompleto: 'Juan Pérez', estado: 'ACTIVO' })?.estado === null)
  check('>>> sin nombre reconocible: null (no se inventa nada)', interpretarPadron('RUC', RUC, { foo: 'bar' }) === null && interpretarPadron('RUC', RUC, null) === null && interpretarPadron('RUC', RUC, 'texto') === null && interpretarPadron('DNI', DNI, { nombres: 'Solo nombre' }) === null)
  check('>>> limpia caracteres de control y acota el largo', (() => { const d = interpretarPadron('RUC', RUC, { razonSocial: 'A\u0007\nB' + 'x'.repeat(500) }); return !!d && !/[\u0000-\u001F]/.test(d.nombre) && d.nombre.length <= 200 })())

  console.log('\n2) La URL')
  check('plantilla con {tipo} y {numero}', construirUrlPadron('https://a.pe/v2/{tipo}?numero={numero}', 'RUC', RUC) === `https://a.pe/v2/ruc?numero=${RUC}`)
  check('sin plantilla: añade ?tipo=&numero=', construirUrlPadron('https://a.pe/consulta', 'DNI', DNI) === `https://a.pe/consulta?tipo=dni&numero=${DNI}`)
  check('si ya hay «?» usa «&»', construirUrlPadron('https://a.pe/c?k=1', 'DNI', DNI) === `https://a.pe/c?k=1&tipo=dni&numero=${DNI}`)
  check('el plazo es de 2,5 s', TIMEOUT_PADRON_MS === 2500)

  console.log('\n3) Contra un servidor')
  let modo = 'ok'
  const srv = await servidorFalso(async (req, res) => {
    if (modo === 'ok') return json(res, 200, req.ruta.includes('dni') ? { nombres: 'Rosa', apellidoPaterno: 'Mamani', apellidoMaterno: 'Cruz' } : { razonSocial: 'Empresa Real SAC', direccion: 'Calle 1', estado: 'ACTIVO', condicion: 'HABIDO' })
    if (modo === '404') return json(res, 404, { mensaje: 'no existe' })
    if (modo === '500') return json(res, 500, {})
    if (modo === '401') return json(res, 401, {})
    if (modo === '429') return json(res, 429, {})
    if (modo === 'basura') { res.statusCode = 200; res.end('<html>'); return }
    if (modo === 'lento') return // no responde
  })
  let reloj = 1_000_000
  const p = crearPadronHttp({ url: `${srv.url}/v2/{tipo}?numero={numero}`, token: 'TOKEN-PADRON', timeoutMs: 200, permitirRedLocal: true, ahora: () => reloj })

  const ok = await consultarPadron(RUC, p)
  check('>>> un RUC existente devuelve razón social, dirección, estado y condición', ok.ok && ok.datos.nombre === 'EMPRESA REAL SAC' && ok.datos.condicion === 'HABIDO')
  check('el token va en Authorization: Bearer y no en la URL', srv.peticiones[0]!.cabeceras.authorization === 'Bearer TOKEN-PADRON' && !srv.peticiones[0]!.ruta.includes('TOKEN'))
  const n1 = srv.peticiones.length
  const otra = await consultarPadron(RUC, p)
  check('>>> la segunda consulta sale de la CACHÉ (no paga otra llamada)', otra.ok && srv.peticiones.length === n1)
  check('un DNI se compone con nombres y apellidos', (await consultarPadron(DNI, p)).ok)

  modo = '404'
  const nf = await consultarPadron(completarRuc('2099999998'), p)
  check('>>> 404: NO_ENCONTRADO (no es una caída)', !nf.ok && nf.motivo === 'NO_ENCONTRADO')
  check('...y no activa el cortacircuitos', (() => { modo = 'ok'; return true })() && (await consultarPadron(completarRuc('2088888889'), p)).ok === true)

  for (const m of ['500', '401', '429', 'basura'] as const) {
    const q = crearPadronHttp({ url: `${srv.url}/v2/{tipo}?numero={numero}`, token: 't', timeoutMs: 200, permitirRedLocal: true, ahora: () => reloj })
    modo = m
    const r = await consultarPadron(completarRuc('2077777771'), q)
    check(`>>> ${m}: NO_DISPONIBLE (el cajero teclea el nombre)`, !r.ok && r.motivo === 'NO_DISPONIBLE')
  }

  modo = 'lento'
  const t0 = Date.now()
  const lento = crearPadronHttp({ url: `${srv.url}/v2/{tipo}?numero={numero}`, token: 't', timeoutMs: 250, permitirRedLocal: true, ahora: () => reloj })
  const rl = await consultarPadron(completarRuc('2066666662'), lento)
  const ms = Date.now() - t0
  check(`>>> servicio que no responde: NO_DISPONIBLE en ${ms} ms (no deja colgada la venta)`, !rl.ok && rl.motivo === 'NO_DISPONIBLE' && ms < 1500)

  console.log('\n4) Cortacircuitos')
  modo = '500'
  const cc = crearPadronHttp({ url: `${srv.url}/v2/{tipo}?numero={numero}`, token: 't', timeoutMs: 200, permitirRedLocal: true, ahora: () => reloj })
  await consultarPadron(completarRuc('2055555553'), cc)
  const antes = srv.peticiones.length
  const t1 = Date.now()
  const r2 = await consultarPadron(completarRuc('2033333335'), cc)
  check('>>> tras un fallo, durante 30 s NO se vuelve a llamar (respuesta inmediata)', !r2.ok && srv.peticiones.length === antes && Date.now() - t1 < 100)
  reloj += 31_000
  modo = 'ok'
  check('pasados 30 s se reintenta y se recupera', (await consultarPadron(completarRuc('2022222228'), cc)).ok)

  console.log('\n5) Documento inválido: ni se llama')
  const antes2 = srv.peticiones.length
  const inv = await consultarPadron('20131312956', p)
  check('>>> un RUC con dígito mal se rechaza SIN tocar el servicio', !inv.ok && inv.motivo === 'INVALIDO' && srv.peticiones.length === antes2)

  console.log('\n6) Qué fuente se usa según el entorno')
  const env = { u: process.env.PADRON_API_URL, t: process.env.PADRON_API_TOKEN, p: process.env.PADRON_PROVEEDOR }
  delete process.env.PADRON_API_URL; delete process.env.PADRON_API_TOKEN; delete process.env.PADRON_PROVEEDOR
  check('>>> sin variables: «ninguno» (ingreso manual)', obtenerProveedorPadron().nombre === 'ninguno')
  process.env.PADRON_API_URL = 'https://api.proveedor.pe/v2/{tipo}?numero={numero}'
  check('solo la URL, sin token: sigue «ninguno»', obtenerProveedorPadron().nombre === 'ninguno')
  process.env.PADRON_API_TOKEN = 'tok'
  check('>>> URL + token: «http»', obtenerProveedorPadron().nombre === 'http')
  check('y es la MISMA instancia (conserva caché y cortacircuitos)', obtenerProveedorPadron() === obtenerProveedorPadron())
  process.env.PADRON_PROVEEDOR = 'mock'
  check('PADRON_PROVEEDOR=mock manda sobre el resto', obtenerProveedorPadron().nombre === 'mock')
  process.env.PADRON_PROVEEDOR = 'http'; delete process.env.PADRON_API_TOKEN
  check('>>> «http» sin token degrada a «ninguno» sin lanzar', obtenerProveedorPadron().nombre === 'ninguno')
  for (const [k, v] of [['PADRON_API_URL', env.u], ['PADRON_API_TOKEN', env.t], ['PADRON_PROVEEDOR', env.p]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }

  await srv.cerrar()
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
