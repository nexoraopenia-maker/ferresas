import './guard'
import { correr } from './teardown'
import { randomBytes, randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { CifradoInvalido, descifrar, versionDeClave } from '../src/lib/cifrado'
import {
  ESPERA_ENTRE_PRUEBAS_MS, alertaDeCertificado, credencialesSunatDelNegocio, estadoCredencialesSunat, guardarCredencialesSunat, probarConexionSunat, quitarCredencialesSunat,
} from '../src/features/sunat/credenciales'
import { recifrarSecretos } from '../src/features/seguridad/recifrado'
import { permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'
import { PERMISOS } from '../src/lib/permisos'
import { generarCertificadoDePrueba } from './falsos/certificado-prueba'
import { iniciarSunatFalso } from './falsos/sunat-falso'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * S2 · Las credenciales de SUNAT directo contra la base: quién puede (solo `config.fiscal`; ni el administrador, ni el PIN, ni quien suplanta), qué se valida
 * al cargar el certificado, que los secretos se guardan cifrados y NUNCA salen (ni en el estado, ni en errores, ni en la auditoría), la rotación de la clave
 * maestra, la prueba de conexión contra el SUNAT falso y el aislamiento entre negocios.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '').catch((e) => String(e.message ?? e))

const SECRETOS = { claveCert: 'Clave-Cert-Secreta-9X', claveSol: 'ClaveSol-Secreta-7Z' }
const KA = randomBytes(32).toString('base64'), KB = randomBytes(32).toString('base64')
const antes = { k: process.env.PSE_MASTER_KEY, c: process.env.SECRETOS_CLAVES, a: process.env.SECRETOS_CLAVE_ACTUAL }

async function cuerpo() {
  process.env.SECRETOS_CLAVES = JSON.stringify({ a: KA })
  process.env.SECRETOS_CLAVE_ACTUAL = 'a'
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const ruc = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: { slug: `cr-sunat-${randomUUID().slice(0, 6)}`, name: 'Cred SUNAT', taxId: ruc, planId: plan.id } })
  const ajeno = await prisma.tenant.create({ data: { slug: `cr-sunat-aj-${randomUUID().slice(0, 6)}`, name: 'Otro', taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`), planId: plan.id } })
  const mk = (role: Role, tenantId = t.id) => prisma.user.create({ data: { tenantId, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
  const [owner, adm, caj, ownerAj] = [await mk('OWNER'), await mk('ADMIN'), await mk('CAJERO'), await mk('OWNER', ajeno.id)]
  const ctx = (u: { id: string }, role: Role, tenantId = t.id): TenantContext => ({ tenantId, userId: u.id, role, access: 'FULL', permisosExtra: [] })
  const O = ctx(owner, 'OWNER'), AD = ctx(adm, 'ADMIN'), C = ctx(caj, 'CAJERO'), OA = ctx(ownerAj, 'OWNER', ajeno.id)
  const db = (c: TenantContext) => getTenantPrisma(c)
  const filas = () => prisma.sunatCredential.count({ where: { tenantId: t.id } })
  const certOk = generarCertificadoDePrueba({ ruc, clave: SECRETOS.claveCert, nombre: 'FERRETERIA TITULAR SAC' })
  const entrada = (o: Partial<{ pfx: Buffer; claveCertificado: string; usuarioSol: string; claveSol: string }> = {}) => ({
    pfxBase64: (o.pfx ?? certOk.pfx).toString('base64'), claveCertificado: o.claveCertificado ?? SECRETOS.claveCert, usuarioSol: o.usuarioSol ?? 'USERSOL1', claveSol: o.claveSol ?? SECRETOS.claveSol,
  })

  console.log('\n1) Quién puede cargar, quitar y probar')
  const PIN: TenantContext = { ...O, operadorDe: O.userId, permisosDenegados: permisosDenegadosAlOperador(new Set(PERMISOS)) }
  const SUPLANTA: TenantContext = { ...O, impersonationId: 'imp-1' }
  const quien: [string, TenantContext][] = [['el ADMINISTRADOR', AD], ['el CAJERO', C], ['el dueño con PIN de operador', PIN]]
  const r1 = await Promise.all(quien.map(([, c]) => code(guardarCredencialesSunat(db(c), c, entrada()))))
  check('>>> el administrador, el cajero y el dueño con PIN NO cargan credenciales (FORBIDDEN_ROLE) y no se escribe nada', r1.every((r) => r === 'FORBIDDEN_ROLE') && await filas() === 0, JSON.stringify(r1))
  check('>>> quien SUPLANTA al dueño (soporte) tampoco: lo dice con claridad y no se escribe nada', await code(guardarCredencialesSunat(db(SUPLANTA), SUPLANTA, entrada())) === 'FORBIDDEN_ROLE' && /suplantación/.test(await msg(guardarCredencialesSunat(db(SUPLANTA), SUPLANTA, entrada()))) && await filas() === 0)
  check('>>> cuenta en solo lectura no escribe', await code(guardarCredencialesSunat(db({ ...O, access: 'READ_ONLY' }), { ...O, access: 'READ_ONLY' }, entrada())) !== null && await filas() === 0)

  console.log('\n2) Qué se valida al cargar el certificado')
  const rechazos: [string, ReturnType<typeof entrada>, RegExp][] = [
    ['clave del certificado equivocada', entrada({ claveCertificado: 'otra' }), /no se pudo abrir el certificado/i],
    ['un archivo que no es un .pfx', { ...entrada(), pfxBase64: Buffer.alloc(400, 7).toString('base64') }, /no se pudo abrir el certificado/i],
    ['un .pfx diminuto', { ...entrada(), pfxBase64: Buffer.alloc(50, 1).toString('base64') }, /tamaño|válido/i],
    ['base64 inválido', { ...entrada(), pfxBase64: 'no es base64 !!' }, /no llegó bien/i],
    ['certificado vencido', entrada({ pfx: generarCertificadoDePrueba({ ruc, clave: SECRETOS.claveCert, desde: new Date(Date.now() - 400 * 86_400_000), hasta: new Date(Date.now() - 86_400_000) }).pfx }), /vencido/i],
    ['certificado aún no vigente', entrada({ pfx: generarCertificadoDePrueba({ ruc, clave: SECRETOS.claveCert, desde: new Date(Date.now() + 86_400_000), hasta: new Date(Date.now() + 400 * 86_400_000) }).pfx }), /todavía no está vigente/i],
    ['certificado de OTRO RUC', entrada({ pfx: generarCertificadoDePrueba({ ruc: completarRuc('2011111111'), clave: SECRETOS.claveCert }).pfx }), /no corresponde al RUC/i],
    ['pfx sin clave privada', entrada({ pfx: generarCertificadoDePrueba({ ruc, clave: SECRETOS.claveCert, sinClave: true }).pfx }), /clave privada/i],
    ['usuario SOL con símbolos', entrada({ usuarioSol: 'US ER!' }), /solo lleva letras y números/i],
    ['usuario SOL demasiado corto', entrada({ usuarioSol: 'ab' }), /letras y números/i],
    ['clave SOL demasiado corta', entrada({ claveSol: 'abc' }), /clave SOL/i],
    ['sin clave del certificado', entrada({ claveCertificado: '' }), /clave del certificado/i],
  ]
  for (const [n, e, re] of rechazos) {
    const m = await msg(guardarCredencialesSunat(db(O), O, e))
    check(`>>> ${n} → se rechaza con un mensaje claro y no se guarda nada`, re.test(m) && await filas() === 0, m.slice(0, 120))
  }
  const sinRuc = await prisma.tenant.update({ where: { id: t.id }, data: { taxId: null } })
  check('>>> sin RUC del negocio se pide completarlo', /RUC/.test(await msg(guardarCredencialesSunat(db(O), O, entrada()))) && await filas() === 0)
  await prisma.tenant.update({ where: { id: sinRuc.id }, data: { taxId: ruc } })
  const mClave = await msg(guardarCredencialesSunat(db(O), O, entrada({ claveCertificado: 'otra-clave-secreta' })))
  check('>>> ningún mensaje de error revela una clave (la del certificado ni la SOL)', mClave.length > 0 && !mClave.includes('otra-clave-secreta') && !mClave.includes(SECRETOS.claveSol), mClave.slice(0, 100))

  console.log('\n3) Se guarda CIFRADO y nunca sale')
  const estado = await guardarCredencialesSunat(db(O), O, entrada())
  const fila = await prisma.sunatCredential.findUniqueOrThrow({ where: { tenantId: t.id } })
  check('>>> queda configurado, en ambiente BETA, con los metadatos del certificado', estado.configurado && estado.ambiente === 'BETA' && estado.usuarioSol === 'USERSOL1' && estado.certificado?.estado === 'vigente' && estado.certificado.ruc === ruc && estado.certificado.sujeto.includes('FERRETERIA TITULAR SAC'))
  check('>>> el .pfx, su clave y la clave SOL están cifrados con la clave versionada («a»), no en claro', [fila.pfxEnc, fila.pfxPasswordEnc, fila.solPasswordEnc].every((v) => /^v2\.a\./.test(v) && versionDeClave(v) === 'a') && !fila.pfxPasswordEnc.includes(SECRETOS.claveCert) && !fila.solPasswordEnc.includes(SECRETOS.claveSol) && !fila.pfxEnc.includes(certOk.pfx.toString('base64').slice(0, 40)))
  check('>>> descifra atado a SU negocio: con otro negocio no', descifrar(fila.solPasswordEnc, t.id) === SECRETOS.claveSol && (() => { try { descifrar(fila.solPasswordEnc, ajeno.id); return false } catch (e) { return e instanceof CifradoInvalido } })())
  const volcado = JSON.stringify(estado) + JSON.stringify(await estadoCredencialesSunat(db(O))) + JSON.stringify(await alertaDeCertificado(db(O)))
  check('>>> el estado que ve la pantalla no lleva ningún secreto (ni el .pfx, ni las claves, ni los textos cifrados)', !volcado.includes(SECRETOS.claveSol) && !volcado.includes(SECRETOS.claveCert) && !volcado.includes(fila.pfxEnc) && !volcado.includes('v2.a.') && !volcado.includes(certOk.pfx.toString('base64').slice(0, 40)))
  const auditoria = await prisma.auditLog.findMany({ where: { tenantId: t.id, action: { startsWith: 'sunat.' } } })
  const textoAuditoria = JSON.stringify(auditoria)
  check('>>> la auditoría deja quién y qué certificado, sin ningún secreto', auditoria.some((a) => a.action === 'sunat.credenciales_guardadas' && a.actorId === owner.id) && !textoAuditoria.includes(SECRETOS.claveSol) && !textoAuditoria.includes(SECRETOS.claveCert) && !textoAuditoria.includes('v2.a.') && !textoAuditoria.includes(certOk.pfx.toString('base64').slice(0, 40)))
  const desc = await credencialesSunatDelNegocio(db(O), t.id)
  check('>>> para usarlas en el servidor (S3) se leen descifradas: el .pfx abre con su clave y apunta al ambiente beta', desc?.pfx.equals(certOk.pfx) === true && desc.claveSol === SECRETOS.claveSol && desc.ambiente === 'BETA' && /e-beta\.sunat\.gob\.pe/.test(desc.urlBill))
  check('>>> el administrador puede LEER el estado (sin secretos) pero no escribir', (await estadoCredencialesSunat(db(AD))).configurado === true)

  console.log('\n4) Cambiar, quitar y aislamiento')
  await prisma.sunatCredential.update({ where: { tenantId: t.id }, data: { ambiente: 'PRODUCCION', lastTestAt: new Date(), lastTestOk: true, lastTestMessage: 'ok' } })
  const cert2 = generarCertificadoDePrueba({ ruc, clave: 'otra-clave-2', nombre: 'FERRETERIA TITULAR SAC' })
  const e2 = await guardarCredencialesSunat(db(O), O, entrada({ pfx: cert2.pfx, claveCertificado: 'otra-clave-2', usuarioSol: 'NUEVOSOL' }))
  check('>>> cambiar el certificado REEMPLAZA (una sola fila), vuelve a BETA y borra la prueba anterior (ya no vale)', await filas() === 1 && e2.ambiente === 'BETA' && e2.usuarioSol === 'NUEVOSOL' && e2.ultimaPrueba === null)
  const aud2 = await prisma.auditLog.findFirst({ where: { tenantId: t.id, action: 'sunat.credenciales_guardadas' }, orderBy: { createdAt: 'desc' } })
  check('>>> la auditoría del cambio trae el ANTES (serie y usuario) y el DESPUÉS', JSON.stringify(aud2?.before).includes('USERSOL1') && JSON.stringify(aud2?.after).includes('NUEVOSOL'))
  check('>>> otro negocio no ve ni descifra nada de este', (await estadoCredencialesSunat(db(OA))).configurado === false && await credencialesSunatDelNegocio(db(OA), ajeno.id) === null)
  check('>>> el administrador y el que suplanta NO quitan las credenciales', await code(quitarCredencialesSunat(db(AD), AD)) === 'FORBIDDEN_ROLE' && await code(quitarCredencialesSunat(db(SUPLANTA), SUPLANTA)) === 'FORBIDDEN_ROLE' && await filas() === 1)
  await guardarCredencialesSunat(db(O), O, entrada())
  await quitarCredencialesSunat(db(O), O)
  check('>>> el dueño las quita: ya no hay fila, y queda el rastro (sin secretos)', await filas() === 0 && (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'sunat.credenciales_quitadas' } })) === 1)
  await quitarCredencialesSunat(db(O), O)
  check('>>> quitar cuando no hay nada no hace ruido ni deja otra auditoría', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'sunat.credenciales_quitadas' } })) === 1)

  console.log('\n5) Rotar la clave maestra sin volver a pedir nada')
  await guardarCredencialesSunat(db(O), O, entrada())
  process.env.SECRETOS_CLAVES = JSON.stringify({ a: KA, b: KB })
  process.env.SECRETOS_CLAVE_ACTUAL = 'b'
  check('>>> agregada la clave «b», lo guardado con «a» SIGUE funcionando', (await credencialesSunatDelNegocio(db(O), t.id))?.claveSol === SECRETOS.claveSol)
  const seco = await recifrarSecretos(prisma as never)
  const trasSeco = await prisma.sunatCredential.findUniqueOrThrow({ where: { tenantId: t.id } })
  check('>>> el modo «solo mirar» cuenta lo pendiente y NO escribe', !seco.aplicado && seco.recifrados >= 3 && versionDeClave(trasSeco.pfxEnc) === 'a')
  const aplicado = await recifrarSecretos(prisma as never, { aplicar: true })
  const trasAplicar = await prisma.sunatCredential.findUniqueOrThrow({ where: { tenantId: t.id } })
  check('>>> «aplicar» re-cifra los tres secretos con «b»', aplicado.aplicado && [trasAplicar.pfxEnc, trasAplicar.pfxPasswordEnc, trasAplicar.solPasswordEnc].every((v) => versionDeClave(v) === 'b'))
  process.env.SECRETOS_CLAVES = JSON.stringify({ b: KB })
  const retirada = await credencialesSunatDelNegocio(db(O), t.id)
  check('>>> retirada la clave vieja, todo se sigue leyendo (nadie tuvo que volver a subir su certificado)', retirada?.claveSol === SECRETOS.claveSol && retirada.pfx.equals(certOk.pfx))
  const otra = await recifrarSecretos(prisma as never, { aplicar: true })
  check('>>> volver a correrlo no encuentra nada por hacer en este negocio (idempotente)', otra.recifrados === 0 || (await prisma.sunatCredential.findUniqueOrThrow({ where: { tenantId: t.id } })).pfxEnc === trasAplicar.pfxEnc)
  process.env.SECRETOS_CLAVES = JSON.stringify({ z: randomBytes(32).toString('base64') })
  process.env.SECRETOS_CLAVE_ACTUAL = 'z'
  const sinClave = await msg(credencialesSunatDelNegocio(db(O), t.id))
  check('>>> si se pierde la clave con que se cifró, el error es genérico (pide volver a cargar) y NO revela secretos', /Vuelve a cargarlas/.test(sinClave) && !sinClave.includes(SECRETOS.claveSol) && !sinClave.includes('v2.'))
  const ilegibles = await recifrarSecretos(prisma as never, { aplicar: true })
  check('>>> el re-cifrado reporta lo ilegible y NO lo toca', ilegibles.ilegibles.some((i) => i.tabla === 'sunat_credentials') && (await prisma.sunatCredential.findUniqueOrThrow({ where: { tenantId: t.id } })).pfxEnc === trasAplicar.pfxEnc)
  process.env.SECRETOS_CLAVES = JSON.stringify({ a: KA, b: KB })
  process.env.SECRETOS_CLAVE_ACTUAL = 'b'

  console.log('\n6) Probar la conexión (contra el SUNAT falso)')
  const falso = await iniciarSunatFalso({ usuarios: { [`${ruc}USERSOL1`]: SECRETOS.claveSol } })
  const t0 = new Date('2026-10-30T12:00:00Z')
  await quitarCredencialesSunat(db(O), O)
  check('>>> sin credenciales: pide cargarlas', (await probarConexionSunat(db(O), O, { urlBill: falso.url, ahora: t0 })).ok === false)
  await guardarCredencialesSunat(db(O), O, entrada(), t0)
  const p1 = await probarConexionSunat(db(O), O, { urlBill: falso.url, ahora: t0 })
  check('>>> con usuario y clave aceptados: «SUNAT aceptó las credenciales»', p1.ok && /aceptó/.test(p1.mensaje), JSON.stringify(p1) + JSON.stringify(falso.recibidas.at(-1)) + JSON.stringify(Object.keys(falso.usuarios)))
  check('>>> usó el RUC + usuario SOL como usuario y consultó (no emitió ni envió ningún comprobante)', falso.recibidas.at(-1)?.usuario === `${ruc}USERSOL1` && falso.recibidas.every((r) => r.operacion === 'getStatusCdr'))
  const e3 = await estadoCredencialesSunat(db(O))
  check('>>> queda guardada la última prueba (bien) y su auditoría', e3.ultimaPrueba?.ok === true && (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'sunat.prueba_conexion' } })) >= 1)
  check('>>> probar de nuevo enseguida se frena (SUNAT bloquea a quien prueba claves a ráfagas)', await code(probarConexionSunat(db(O), O, { urlBill: falso.url, ahora: new Date(t0.getTime() + 1000) })) === 'RATE_LIMITED')
  const t1 = new Date(t0.getTime() + ESPERA_ENTRE_PRUEBAS_MS + 1)
  falso.guion.push('auth')
  const p2 = await probarConexionSunat(db(O), O, { urlBill: falso.url, ahora: t1 })
  check('>>> si SUNAT rechaza el acceso (familia 01xx) dice que revise el usuario SOL y su clave', !p2.ok && /usuario SOL o su clave/.test(p2.mensaje))
  const t2 = new Date(t1.getTime() + ESPERA_ENTRE_PRUEBAS_MS + 1)
  falso.guion.push('servidor')
  const p3 = await probarConexionSunat(db(O), O, { urlBill: falso.url, ahora: t2 })
  check('>>> si SUNAT no responde bien no culpa a las credenciales: «no se pudo comunicar»', !p3.ok && /No se pudo comunicar/.test(p3.mensaje))
  const t3 = new Date(t2.getTime() + ESPERA_ENTRE_PRUEBAS_MS + 1)
  const p4 = await probarConexionSunat(db(O), O, { urlBill: 'https://example.com/billService', ahora: t3 })
  check('>>> una dirección que no es de SUNAT se rechaza sin llamarla', !p4.ok && /no está permitida/.test(p4.mensaje))
  const t4 = new Date(t3.getTime() + ESPERA_ENTRE_PRUEBAS_MS + 1)
  const p5 = await probarConexionSunat(db(O), O, { urlBill: falso.url, ahora: new Date(t4.getTime() + 3 * 365 * 86_400_000) })
  check('>>> con el certificado vencido a la fecha de la prueba, lo dice (y no consulta a SUNAT)', !p5.ok && /vencido/.test(p5.mensaje))
  check('>>> el administrador no puede probar (la prueba usa los secretos)', await code(probarConexionSunat(db(AD), AD, { urlBill: falso.url, ahora: new Date(t4.getTime() + 10 * ESPERA_ENTRE_PRUEBAS_MS) })) === 'FORBIDDEN_ROLE')
  const todo = JSON.stringify([p1, p2, p3, p4, p5, await estadoCredencialesSunat(db(O)), await prisma.auditLog.findMany({ where: { tenantId: t.id } })])
  check('>>> ni los resultados de la prueba, ni el estado, ni toda la auditoría del negocio contienen un secreto', !todo.includes(SECRETOS.claveSol) && !todo.includes(SECRETOS.claveCert) && !todo.includes('v2.'))
  await falso.detener()

  console.log('\n7) Alerta de vencimiento')
  const cercano = generarCertificadoDePrueba({ ruc, clave: 'c', desde: new Date(Date.now() - 86_400_000), hasta: new Date(Date.now() + 10 * 86_400_000) })
  await guardarCredencialesSunat(db(O), O, entrada({ pfx: cercano.pfx, claveCertificado: 'c' }))
  const al = await alertaDeCertificado(db(O))
  check('>>> un certificado que vence en 10 días da «por vencer» con los días que quedan', al?.estado === 'por_vencer' && al.diasRestantes >= 9 && al.diasRestantes <= 10)
  await prisma.sunatCredential.update({ where: { tenantId: t.id }, data: { certValidTo: new Date(Date.now() - 86_400_000), certValidFrom: new Date(Date.now() - 400 * 86_400_000) } })
  check('>>> si ya venció, la alerta lo dice', (await alertaDeCertificado(db(O)))?.estado === 'vencido')
  check('>>> sin credenciales no hay alerta', (await alertaDeCertificado(db(OA))) === null)

  console.log('\n8) La base también defiende')
  const ok = (p: Promise<unknown>) => p.then(() => true, () => false)
  const base = await prisma.sunatCredential.findUniqueOrThrow({ where: { tenantId: t.id } })
  check('>>> la base rechaza guardar un secreto SIN cifrar', !(await ok(prisma.sunatCredential.update({ where: { tenantId: t.id }, data: { solPasswordEnc: 'clave-en-claro' } }))) && !(await ok(prisma.sunatCredential.update({ where: { tenantId: t.id }, data: { pfxEnc: 'MIIC...' } }))))
  check('>>> y un usuario SOL con símbolos, o una vigencia al revés, o una prueba a medias', !(await ok(prisma.sunatCredential.update({ where: { tenantId: t.id }, data: { solUser: 'a b!' } }))) && !(await ok(prisma.sunatCredential.update({ where: { tenantId: t.id }, data: { certValidTo: new Date(base.certValidFrom.getTime() - 1000) } }))) && !(await ok(prisma.sunatCredential.update({ where: { tenantId: t.id }, data: { lastTestAt: new Date(), lastTestOk: null } }))))
  check('>>> una sola fila de credenciales por negocio', !(await ok(prisma.sunatCredential.create({ data: { tenantId: t.id, pfxEnc: 'v2.a.x.y.z', pfxPasswordEnc: 'v2.a.x.y.z', solUser: 'ABC', solPasswordEnc: 'v2.a.x.y.z', certSubject: 's', certIssuer: 'i', certSerial: '1', certValidFrom: new Date(0), certValidTo: new Date() } }))))
  await prisma.tenant.deleteMany({ where: { id: { in: [t.id, ajeno.id] } } })
}

async function main() {
  try { await cuerpo() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? (e.stack ?? e.message).slice(0, 500) : e}`, false) }
  Object.assign(process.env, { PSE_MASTER_KEY: antes.k, SECRETOS_CLAVES: antes.c, SECRETOS_CLAVE_ACTUAL: antes.a })
  for (const k of ['PSE_MASTER_KEY', 'SECRETOS_CLAVES', 'SECRETOS_CLAVE_ACTUAL'] as const) if (process.env[k] === undefined || process.env[k] === 'undefined') delete process.env[k]
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
