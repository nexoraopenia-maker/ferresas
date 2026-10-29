import { randomBytes } from 'node:crypto'
import { CifradoInvalido, ClaveMaestraAusente, cifrar, descifrar, hayClaveMaestra, leerClave, necesitaRecifrado, recifrar, versionDeClave } from '../src/lib/cifrado'
import { UrlNoPermitida, esIpInterna, validarFormaUrl, validarUrlPse } from '../src/features/invoicing/url-segura'
import { construirTramaQr, llevaQr, qrSvg } from '../src/features/invoicing/qr'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const lanza = (f: () => unknown, tipo?: new (...a: never[]) => Error) => { try { f(); return false } catch (e) { return tipo ? e instanceof tipo : true } }
const lanzaAsync = async (f: () => Promise<unknown>) => { try { await f(); return false } catch { return true } }

const K1 = randomBytes(32).toString('base64')
const K2 = randomBytes(32).toString('hex')
const antes = { k: process.env.PSE_MASTER_KEY, p: process.env.PSE_MASTER_KEY_PREVIOUS, h: process.env.PSE_ALLOWED_HOSTS, c: process.env.SECRETOS_CLAVES, a: process.env.SECRETOS_CLAVE_ACTUAL }
delete process.env.SECRETOS_CLAVES; delete process.env.SECRETOS_CLAVE_ACTUAL

async function main() {
  console.log('\n1) Cifrado AES-256-GCM')
  process.env.PSE_MASTER_KEY = K1
  const TOKEN = 'tok_SECRETO_1234567890'
  const c1 = cifrar(TOKEN, 'tenant-A')
  check('>>> ida y vuelta', descifrar(c1, 'tenant-A') === TOKEN)
  check('>>> el texto cifrado NO contiene el token', !c1.includes(TOKEN) && !c1.includes('SECRETO'))
  check('>>> formato v2.kid.iv.etiqueta.cifrado, con la clave «1» por compatibilidad con PSE_MASTER_KEY', /^v2\.1\.[\w-]+\.[\w-]+\.[\w-]+$/.test(c1) && versionDeClave(c1) === '1')
  check('>>> mismo token, distinto texto cada vez (IV aleatorio)', cifrar(TOKEN, 'tenant-A') !== c1)
  check('>>> atado al negocio: otro tenantId NO descifra', lanza(() => descifrar(c1, 'tenant-B'), CifradoInvalido))
  const partes = c1.split('.')
  const manipulado = [partes[0], partes[1], partes[2], partes[3], Buffer.from([...Buffer.from(partes[4]!, 'base64url')].map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64url')].join('.')
  check('>>> un cambio de UN bit se detecta (GCM autentica)', lanza(() => descifrar(manipulado, 'tenant-A'), CifradoInvalido))
  check('un formato ajeno se rechaza', lanza(() => descifrar('v9.a.b.c', 'tenant-A'), CifradoInvalido) && lanza(() => descifrar('basura', 'tenant-A'), CifradoInvalido) && lanza(() => descifrar('v2.1.a', 'tenant-A'), CifradoInvalido))
  check('texto largo y con tildes', descifrar(cifrar('señor ñandú ' + 'x'.repeat(2000), 'a'), 'a') === 'señor ñandú ' + 'x'.repeat(2000))

  console.log('\n2) Claves')
  check('acepta 32 bytes en base64 y en hex', leerClave(K1)?.length === 32 && leerClave(K2)?.length === 32)
  check('>>> rechaza claves de otro tamaño', leerClave('corta') === null && leerClave(randomBytes(16).toString('base64')) === null && leerClave(undefined) === null)
  delete process.env.PSE_MASTER_KEY
  check('>>> sin clave maestra NO se cifra', lanza(() => cifrar(TOKEN, 'a'), ClaveMaestraAusente) && !hayClaveMaestra())
  check('ni se descifra', lanza(() => descifrar(c1, 'tenant-A'), ClaveMaestraAusente))
  process.env.PSE_MASTER_KEY = K2
  check('>>> con OTRA clave no descifra lo guardado con la primera', lanza(() => descifrar(c1, 'tenant-A'), CifradoInvalido))
  const c1v1 = cifrar(TOKEN, 'tenant-A', leerClave(K1)!)   // el formato anterior (sin identificador de clave)
  check('>>> un valor v1 con la clave nueva NO descifra', lanza(() => descifrar(c1v1, 'tenant-A'), CifradoInvalido))
  process.env.PSE_MASTER_KEY_PREVIOUS = K1
  check('>>> ROTACIÓN heredada: con la anterior declarada sí descifra un valor v1', descifrar(c1v1, 'tenant-A') === TOKEN)
  check('y lo nuevo se cifra con la clave actual (no con la anterior)', descifrar(cifrar(TOKEN, 'a'), 'a') === TOKEN && (() => { delete process.env.PSE_MASTER_KEY_PREVIOUS; return descifrar(cifrar(TOKEN, 'a'), 'a') === TOKEN })())

  // El procedimiento de siempre sigue sirviendo para lo que se cifró DESPUÉS de las claves versionadas con la clave «1» (= PSE_MASTER_KEY).
  process.env.PSE_MASTER_KEY = K1
  const v2k1 = cifrar('legado', 'neg-9')
  process.env.PSE_MASTER_KEY = K2; process.env.PSE_MASTER_KEY_PREVIOUS = K1
  check('>>> rotación de SIEMPRE (nueva en PSE_MASTER_KEY, vieja en _PREVIOUS) sigue leyendo también lo v2 de la clave «1»', descifrar(v2k1, 'neg-9') === 'legado')
  delete process.env.PSE_MASTER_KEY_PREVIOUS
  check('>>> y sin la anterior declarada, no', lanza(() => descifrar(v2k1, 'neg-9'), CifradoInvalido))
  process.env.PSE_MASTER_KEY = K1

  console.log('\n2b) Clave versionada: rotar sin perder nada')
  delete process.env.PSE_MASTER_KEY_PREVIOUS
  const KA = randomBytes(32).toString('base64'), KB = randomBytes(32).toString('base64')
  process.env.SECRETOS_CLAVES = JSON.stringify({ a: KA })
  process.env.SECRETOS_CLAVE_ACTUAL = 'a'
  delete process.env.PSE_MASTER_KEY
  const va = cifrar('secreto', 'neg-1')
  check('>>> con SECRETOS_CLAVES el valor lleva el identificador de la clave («a»)', /^v2\.a\./.test(va) && versionDeClave(va) === 'a' && descifrar(va, 'neg-1') === 'secreto')
  process.env.SECRETOS_CLAVES = JSON.stringify({ a: KA, b: KB })
  process.env.SECRETOS_CLAVE_ACTUAL = 'b'
  const vb = cifrar('secreto', 'neg-1')
  check('>>> ROTACIÓN: agregada la clave «b» y declarada actual, lo viejo («a») SIGUE leyéndose y lo nuevo se cifra con «b»', descifrar(va, 'neg-1') === 'secreto' && versionDeClave(vb) === 'b' && descifrar(vb, 'neg-1') === 'secreto')
  check('>>> qué hay que re-cifrar: lo cifrado con «a» sí, con «b» no, y un v1 también', necesitaRecifrado(va) && !necesitaRecifrado(vb) && necesitaRecifrado(cifrar('x', 'n', leerClave(KA)!)) && !necesitaRecifrado('basura'))
  const nuevo = recifrar(va, 'neg-1')
  check('>>> re-cifrar deja el mismo secreto con la clave actual y atado al mismo negocio', versionDeClave(nuevo) === 'b' && descifrar(nuevo, 'neg-1') === 'secreto' && lanza(() => descifrar(nuevo, 'neg-2'), CifradoInvalido))
  process.env.SECRETOS_CLAVES = JSON.stringify({ b: KB })
  check('>>> retirada «a», lo re-cifrado se lee y lo que quedó con «a» falla con un mensaje que dice cuál clave falta', descifrar(nuevo, 'neg-1') === 'secreto' && (() => { try { descifrar(va, 'neg-1'); return false } catch (e) { return e instanceof CifradoInvalido && /«a»/.test(e.message) } })())
  check('>>> un v1 sigue leyéndose con cualquiera de las claves configuradas (no dice cuál lo cifró)', (() => { process.env.SECRETOS_CLAVES = JSON.stringify({ a: KA, b: KB }); return descifrar(cifrar('viejo', 'neg-1', leerClave(KA)!), 'neg-1') === 'viejo' })())
  process.env.SECRETOS_CLAVES = JSON.stringify({ v1: KA })
  process.env.SECRETOS_CLAVE_ACTUAL = 'v1'
  check('>>> «v1» y «v2» no valen como identificador de clave (se confundirían con la versión del formato)', !hayClaveMaestra())
  process.env.SECRETOS_CLAVES = JSON.stringify({ a: KA, b: KB })
  process.env.SECRETOS_CLAVE_ACTUAL = 'z'
  check('>>> si la clave declarada como actual no existe NO se cifra (nunca con otra por sorpresa)', !hayClaveMaestra() && lanza(() => cifrar('x', 'n'), ClaveMaestraAusente))
  process.env.SECRETOS_CLAVE_ACTUAL = 'b'
  process.env.SECRETOS_CLAVES = JSON.stringify({ b: 'corta', 'v2': KA, '../x': KA })
  check('>>> claves mal formadas o con identificador reservado/ilegal se ignoran (no se cifra con basura)', !hayClaveMaestra())
  process.env.SECRETOS_CLAVES = '{no es json'
  check('>>> un JSON ilegible no tumba el servidor: simplemente no hay clave', !hayClaveMaestra() && lanza(() => cifrar('x', 'n'), ClaveMaestraAusente))
  delete process.env.SECRETOS_CLAVES; delete process.env.SECRETOS_CLAVE_ACTUAL
  process.env.PSE_MASTER_KEY = K1

  console.log('\n3) La URL del PSE la escribe un usuario: SSRF')
  const mala = (u: string) => lanza(() => validarFormaUrl(u), UrlNoPermitida)
  check('>>> http (sin TLS) se rechaza', mala('http://api.proveedor.pe'))
  check('>>> localhost', mala('https://localhost/x') && mala('https://app.localhost/x'))
  check('>>> IP literal (v4 y v6)', mala('https://127.0.0.1/') && mala('https://8.8.8.8/') && mala('https://[::1]/'))
  check('>>> metadatos de la nube (169.254.169.254)', mala('https://169.254.169.254/latest/meta-data'))
  check('>>> hosts internos (.local, .internal, sin punto)', mala('https://servicio.local/') && mala('https://db.internal/') && mala('https://intranet/'))
  check('>>> usuario y contraseña en la URL', mala('https://user:pass@api.proveedor.pe/'))
  check('basura y otros esquemas', mala('no es url') && mala('ftp://api.proveedor.pe') && mala('file:///etc/passwd') && mala('javascript:alert(1)'))
  check('una URL pública normal pasa la forma', !mala('https://api.proveedor.pe/v1'))
  const ips = { '10.0.0.1': true, '172.16.5.5': true, '172.31.255.255': true, '192.168.1.1': true, '127.0.0.1': true, '169.254.169.254': true, '100.64.0.1': true, '0.0.0.0': true, '224.0.0.1': true,
    '172.32.0.1': false, '8.8.8.8': false, '1.1.1.1': false, '::1': true, 'fe80::1': true, 'fd00::1': true, '::ffff:10.0.0.1': true, '::ffff:8.8.8.8': false }
  check('>>> clasifica bien IPs internas y públicas', Object.entries(ips).every(([ip, interna]) => esIpInterna(ip) === interna),
    Object.entries(ips).filter(([ip, i]) => esIpInterna(ip) !== i).map(([ip]) => ip).join())
  process.env.PSE_ALLOWED_HOSTS = 'proveedor.pe, otro.com'
  check('>>> con lista de permitidos, solo esos', !mala('https://api.proveedor.pe/') && !mala('https://proveedor.pe/') && mala('https://api.malvado.com/') && mala('https://noproveedor.pe/'))
  delete process.env.PSE_ALLOWED_HOSTS
  check('>>> un nombre que no resuelve se rechaza', await lanzaAsync(() => validarUrlPse('https://no-existe-ferresaas-xyz.invalid/')))

  console.log('\n4) Trama del QR (puro)')
  const base = { ruc: '20131312955', tipoComprobante: '03' as const, serie: 'B001', correlativo: 12, igv: 10.04, total: 65.8, fecha: '2026-10-20', tipoDocCliente: '1', numDocCliente: '41235678', hash: 'AbC123+/=' }
  check('>>> RUC|TIPO|SERIE|NUMERO|IGV|TOTAL|FECHA|TIPO_CLI|NUM_CLI|HASH|',
    construirTramaQr(base) === '20131312955|03|B001|00000012|10.04|65.80|2026-10-20|1|41235678|AbC123+/=|')
  check('termina en barra y tiene 10 campos', construirTramaQr(base).endsWith('|') && construirTramaQr(base).split('|').length === 11)
  check('sin documento del cliente: «-»', construirTramaQr({ ...base, tipoDocCliente: '0', numDocCliente: null }).includes('|0|-|'))
  check('>>> un «|» o salto de línea en un dato no rompe la trama', construirTramaQr({ ...base, hash: 'a|b\nc' }).split('|').length === 11)
  check('importes con 2 decimales siempre', construirTramaQr({ ...base, igv: 18, total: 118 }).includes('|18.00|118.00|'))
  check('>>> solo ACEPTADO u OBSERVADO con hash llevan QR', llevaQr('ACEPTADO', 'h') && llevaQr('OBSERVADO', 'h') && !llevaQr('PENDIENTE', 'h') && !llevaQr('ENVIADO', 'h') && !llevaQr('RECHAZADO', 'h') && !llevaQr('ACEPTADO', null) && !llevaQr('ACEPTADO', ''))
  const svg = await qrSvg(construirTramaQr(base))
  check('genera un SVG', svg.includes('<svg') && svg.includes('</svg>') && svg.length > 500)
  check('>>> el SVG no contiene los datos en claro (solo módulos del QR)', !svg.includes('20131312955') && !svg.includes('AbC123'))
  check('es determinista', svg === (await qrSvg(construirTramaQr(base))))

  Object.assign(process.env, { PSE_MASTER_KEY: antes.k, PSE_MASTER_KEY_PREVIOUS: antes.p, PSE_ALLOWED_HOSTS: antes.h, SECRETOS_CLAVES: antes.c, SECRETOS_CLAVE_ACTUAL: antes.a })
  for (const k of ['PSE_MASTER_KEY', 'PSE_MASTER_KEY_PREVIOUS', 'PSE_ALLOWED_HOSTS', 'SECRETOS_CLAVES', 'SECRETOS_CLAVE_ACTUAL'] as const) if (process.env[k] === undefined || process.env[k] === 'undefined') delete process.env[k]

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.log(`  ✗ EXCEPCIÓN no controlada: ${e instanceof Error ? e.stack : e}`); process.exit(1) })
