import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { guardarDatosFiscales, leerDatosFiscales } from '../src/features/sunat/datos-fiscales'
import { guardarDatosFiscalesSchema } from '../src/features/invoicing/schemas'
import { guardarCredencialesSunat, quitarCredencialesSunat } from '../src/features/sunat/credenciales'
import { generarCertificadoDePrueba } from './falsos/certificado-prueba'
import { credencialSunatFalsa, crearSucursalConAlmacen } from './fixtures'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Datos fiscales del propio negocio (RUC y razón social) que el dueño completa antes de cargar el certificado de SUNAT.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '', (e) => String(e.message))
const rucNuevo = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const creados: string[] = []
  const claveEnv = { c: process.env.SECRETOS_CLAVES, a: process.env.SECRETOS_CLAVE_ACTUAL }
  process.env.SECRETOS_CLAVES = JSON.stringify({ a: Buffer.alloc(32, 7).toString('base64') })
  process.env.SECRETOS_CLAVE_ACTUAL = 'a'

  async function negocio(tag: string, o: { ruc?: string | null; real?: boolean } = {}) {
    const t = await prisma.tenant.create({ data: { slug: `df-${tag}-${randomUUID().slice(0, 6)}`, name: `Datos ${tag}`, planId: plan.id, taxId: o.ruc === undefined ? null : o.ruc, realBillingEnabledAt: o.real ? new Date(Date.now() - 864e5) : null } })
    creados.push(t.id)
    const mk = (role: Role) => prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`, name: role, role } })
    const [owner, caj] = [await mk('OWNER'), await mk('CAJERO')]
    const { branch, warehouse } = await crearSucursalConAlmacen(t.id)
    const ctxDe = (u: { id: string }, role: Role): TenantContext => ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branch.id, branchIds: [branch.id], permisosExtra: [] })
    const O = ctxDe(owner, 'OWNER'), C = ctxDe(caj, 'CAJERO')
    return { t, O, C, db: getTenantPrisma(O), branch, warehouse, owner, tt: () => prisma.tenant.findUniqueOrThrow({ where: { id: t.id } }) }
  }
  const E = (ruc: string, razonSocial = 'FERRETERÍA EL SOL S.A.C.') => ({ ruc, razonSocial })

  console.log('\n1) Validaciones y permisos')
  const A = await negocio('a')
  const ruc1 = rucNuevo()
  check('el esquema acota el largo de los textos', !guardarDatosFiscalesSchema.safeParse({ ruc: 'x'.repeat(21), razonSocial: 'a' }).success && guardarDatosFiscalesSchema.safeParse(E(ruc1)).success)
  check('>>> el cajero NO puede guardar datos fiscales (FORBIDDEN_ROLE) y no cambia nada', await code(guardarDatosFiscales(getTenantPrisma(A.C), A.C, E(ruc1))) === 'FORBIDDEN_ROLE' && (await A.tt()).taxId === null)
  check('>>> durante una suplantación de soporte tampoco', await code(guardarDatosFiscales(A.db, { ...A.O, impersonationId: 'imp-1' }, E(ruc1))) === 'FORBIDDEN_ROLE' && (await A.tt()).taxId === null)
  check('>>> un RUC con dígito de control malo, corto o con letras se rechaza', await code(guardarDatosFiscales(A.db, A.O, E('20123456780'))) === 'INVALID_DOCUMENT' && await code(guardarDatosFiscales(A.db, A.O, E('2012345'))) === 'INVALID_DOCUMENT' && await code(guardarDatosFiscales(A.db, A.O, E('20ABCDEFGH1'))) === 'INVALID_DOCUMENT')
  check('una razón social vacía, de 2 letras o de 201 se rechaza', await code(guardarDatosFiscales(A.db, A.O, E(ruc1, '   '))) === 'INVALID_DOCUMENT' && await code(guardarDatosFiscales(A.db, A.O, E(ruc1, 'ab'))) === 'INVALID_DOCUMENT' && await code(guardarDatosFiscales(A.db, A.O, E(ruc1, 'x'.repeat(201)))) === 'INVALID_DOCUMENT')
  check('y nada de eso cambió el negocio', (await A.tt()).taxId === null && (await A.tt()).legalName === null)

  console.log('\n2) Guardar')
  const antes = await leerDatosFiscales(A.db)
  check('un negocio nuevo no tiene RUC ni razón social y su RUC se puede editar', antes.ruc === null && antes.razonSocial === null && antes.rucBloqueadoPor === null)
  const r1 = await guardarDatosFiscales(A.db, A.O, { ruc: ` ${ruc1.slice(0, 5)} ${ruc1.slice(5)} `, razonSocial: '  FERRETERÍA   EL SOL   S.A.C.  ' })
  const tA = await A.tt()
  check('>>> guarda el RUC (sin espacios) y la razón social (espacios normalizados)', tA.taxId === ruc1 && tA.legalName === 'FERRETERÍA EL SOL S.A.C.' && r1.ruc === ruc1)
  const aud = await prisma.auditLog.findFirst({ where: { tenantId: A.t.id, action: 'fiscal.datos_guardados' } })
  check('>>> queda auditado con el antes y el después y quién lo hizo', JSON.stringify(aud?.after).includes(ruc1) && JSON.stringify(aud?.before).includes('null') && aud?.actorId === A.owner.id)
  check('la razón social se puede corregir cuando quiera (sin tocar el RUC)', (await guardarDatosFiscales(A.db, A.O, E(ruc1, 'FERRETERÍA EL SOL E.I.R.L.'))).razonSocial === 'FERRETERÍA EL SOL E.I.R.L.' && (await A.tt()).legalName === 'FERRETERÍA EL SOL E.I.R.L.')
  check('mientras no haya nada que lo ate, el RUC se puede corregir', (await guardarDatosFiscales(A.db, A.O, E(rucNuevo()))).rucBloqueadoPor === null)
  const B = await negocio('b')
  const rucB = rucNuevo()
  await guardarDatosFiscales(B.db, B.O, E(rucB))
  check('>>> el RUC es único en todo el sistema: el de otra cuenta se rechaza con un mensaje claro y no cambia nada', /ya está registrado en otra cuenta/.test(await msg(guardarDatosFiscales(A.db, A.O, E(rucB)))) && (await A.tt()).taxId !== rucB)
  check('>>> y guardar los datos de A no toca a B', (await B.tt()).taxId === rucB)

  console.log('\n3) Cuándo se bloquea el RUC')
  const C1 = await negocio('c1', { ruc: rucNuevo() })
  await credencialSunatFalsa(C1.t.id, { ruc: (await C1.tt()).taxId })
  const bloqueoCert = (await leerDatosFiscales(C1.db)).rucBloqueadoPor
  check('>>> con un certificado cargado el RUC queda bloqueado y dice qué hacer', /Quita el certificado/.test(bloqueoCert ?? ''))
  check('>>> cambiar el RUC con certificado se rechaza', /Quita el certificado/.test(await msg(guardarDatosFiscales(C1.db, C1.O, E(rucNuevo())))))
  check('pero la razón social sí se puede corregir (mismo RUC)', (await guardarDatosFiscales(C1.db, C1.O, E((await C1.tt()).taxId!, 'OTRA RAZÓN SOCIAL SAC'))).razonSocial === 'OTRA RAZÓN SOCIAL SAC')
  const C2 = await negocio('c2', { ruc: rucNuevo(), real: true })
  check('>>> con la facturación real habilitada, el RUC lo cambia soporte', /solo lo cambia soporte/.test(await msg(guardarDatosFiscales(C2.db, C2.O, E(rucNuevo())))))
  const C3 = await negocio('c3', { ruc: rucNuevo() })
  const sale = await prisma.sale.create({ data: { tenantId: C3.t.id, branchId: C3.branch.id, warehouseId: C3.warehouse.id, userId: C3.owner.id, number: `V-${randomUUID().slice(0, 6)}`, status: 'COMPLETADA' } })
  const docPrueba = await prisma.taxDocument.create({ data: { tenantId: C3.t.id, saleId: sale.id, documentType: 'BOLETA', series: 'PB001', correlativo: 1, fullNumber: 'PB001-00000001', isTrial: true, receiverDocType: 'SIN_DOCUMENTO', subtotal: 1, taxTotal: 0.18, total: 1.18 } })
  check('un documento de PRUEBA no ata el RUC', (await leerDatosFiscales(C3.db)).rucBloqueadoPor === null)
  await prisma.taxDocument.update({ where: { id: docPrueba.id }, data: { isTrial: false, series: 'B001', fullNumber: 'B001-00000001' } })
  const msgReal = await msg(guardarDatosFiscales(C3.db, C3.O, E(rucNuevo())))
  check('>>> un comprobante REAL emitido sí lo ata', /comprobantes reales/.test(msgReal), msgReal.slice(0, 120))

  console.log('\n4) Con el RUC completo ya se puede cargar el certificado (el flujo de punta a punta)')
  const D = await negocio('d')
  const rucD = rucNuevo()
  const cert = generarCertificadoDePrueba({ ruc: rucD, clave: 'Clave-Pfx-9X' })
  const entrada = { pfxBase64: cert.pfx.toString('base64'), claveCertificado: 'Clave-Pfx-9X', usuarioSol: 'USERSOL1', claveSol: 'ClaveSol-7Z' }
  check('>>> sin RUC en el negocio no se puede cargar el certificado (lo dice)', /RUC/.test(await msg(guardarCredencialesSunat(D.db, D.O, entrada))))
  await guardarDatosFiscales(D.db, D.O, E(rucD))
  const est = await guardarCredencialesSunat(D.db, D.O, entrada)
  check('>>> completado el RUC, el certificado (.pfx/.p12) se guarda CIFRADO y solo salen sus metadatos', est.configurado && est.certificado?.ruc === rucD && !JSON.stringify(est).includes('ClaveSol-7Z'))
  const fila = await prisma.sunatCredential.findUniqueOrThrow({ where: { tenantId: D.t.id } })
  check('>>> en la base el certificado, su clave y la clave SOL están cifrados (v1./v2.), nunca en claro', [fila.pfxEnc, fila.pfxPasswordEnc, fila.solPasswordEnc].every((v) => /^v[12]\./.test(v)) && !fila.pfxEnc.includes(entrada.pfxBase64.slice(0, 40)))
  await quitarCredencialesSunat(D.db, D.O)
  check('quitando el certificado, el RUC vuelve a poder cambiarse', (await leerDatosFiscales(D.db)).rucBloqueadoPor === null)

  console.log('\n5) La pantalla')
  const pagina = readFileSync('src/app/(dashboard)/comprobantes/page.tsx', 'utf8')
  const comp = readFileSync('src/features/invoicing/components/DatosFiscalesForm.tsx', 'utf8')
  const accion = readFileSync('src/features/invoicing/actions.ts', 'utf8')
  check('>>> el formulario solo se ofrece a quien tiene config.fiscal y con acceso completo', /const datosFiscales = puedeSeries \? await leerDatosFiscales\(db\) : null/.test(pagina) && /puedeOperar=\{ctx\.access === 'FULL' \|\| ctx\.access === 'WARN'\}/.test(pagina.slice(pagina.indexOf('<DatosFiscalesForm'))))
  check('el RUC se desactiva cuando hay bloqueo y solo admite dígitos', /disabled=\{!!rucBloqueadoPor \|\| pendiente\}/.test(comp) && /replace\(\/\\D\/g, ''\)/.test(comp) && /maxLength=\{11\}/.test(comp))
  check('la acción pasa por el servicio (que exige el permiso), no escribe en la base por su cuenta', /guardarDatosFiscales\(db, ctx, parsed\.data\)/.test(accion) && !/tenant\.update/.test(accion.slice(accion.indexOf('guardarDatosFiscalesAction'), accion.indexOf('guardarDatosFiscalesAction') + 700)))

  await prisma.tenant.deleteMany({ where: { id: { in: creados } } })
  Object.assign(process.env, { SECRETOS_CLAVES: claveEnv.c, SECRETOS_CLAVE_ACTUAL: claveEnv.a })
  for (const k of ['SECRETOS_CLAVES', 'SECRETOS_CLAVE_ACTUAL'] as const) if (process.env[k] === undefined || process.env[k] === 'undefined') delete process.env[k]
}

async function main() {
  try { await cuerpo() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? (e.stack ?? e.message).slice(0, 500) : e}`, false) }
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
