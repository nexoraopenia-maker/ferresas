import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { resolveTenantContext } from '../src/lib/session'
import { verifyCredentialsDetailed } from '../src/lib/credentials'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'
import {
  base32Decode, base32Encode, generarCodigosRecuperacion, generarSecreto, hashCodigoRecuperacion,
  hotp, normalizarCodigo, otpauthUrl, totp, verificarTotp,
} from '../src/lib/totp'
import { BLOQUEO_MFA_MS, MAX_INTENTOS_MFA, mfaObligatorio } from '../src/features/seguridad/mfa-reglas'
import {
  confirmarActivacionMfa, desactivarMfa, estadoMfa, iniciarActivacionMfa, regenerarCodigosRecuperacion,
  restablecerMfaDeUsuario, verificarSegundoFactor,
} from '../src/features/seguridad/mfa-service'
import { registrarDispositivo } from '../src/features/seguridad/dispositivos'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const TODOS: Role[] = ['OWNER', 'ADMIN', 'VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR']
const claveAntes = process.env.PSE_MASTER_KEY

async function main() {
  process.env.PSE_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')

  console.log('\n1) TOTP: vectores del RFC 6238 (puro)')
  const rfc = Buffer.from('12345678901234567890')
  const seis = (t: number) => hotp(rfc, Math.floor(t / 30))
  check('T=59 → 287082', seis(59) === '287082')
  check('T=1111111109 → 081804', seis(1111111109) === '081804')
  check('T=1234567890 → 005924', seis(1234567890) === '005924')
  check('base32 ida y vuelta', base32Decode(base32Encode(rfc)).equals(rfc))
  check('base32 de RFC 4648: "foobar" → MZXW6YTBOI', base32Encode(Buffer.from('foobar')) === 'MZXW6YTBOI')
  const sec = generarSecreto()
  const t0 = new Date('2026-10-22T12:00:00Z')
  check('secreto de 32 caracteres base32 (160 bits)', /^[A-Z2-7]{32}$/.test(sec))
  check('acepta el código actual', verificarTotp(sec, totp(sec, t0), t0) !== null)
  check('acepta ±1 paso (reloj desfasado)', verificarTotp(sec, totp(sec, new Date(t0.getTime() - 30_000)), t0) !== null
    && verificarTotp(sec, totp(sec, new Date(t0.getTime() + 30_000)), t0) !== null)
  check('>>> rechaza ±2 pasos', verificarTotp(sec, totp(sec, new Date(t0.getTime() - 60_000)), t0) === null
    && verificarTotp(sec, totp(sec, new Date(t0.getTime() + 60_000)), t0) === null)
  check('rechaza formato inválido', verificarTotp(sec, '12345', t0) === null && verificarTotp(sec, 'abcdef', t0) === null)
  const uri = otpauthUrl(sec, 'a@b.com', 'FerreSaaS')
  check('otpauth lleva secreto, emisor, SHA1, 6 dígitos y 30 s', uri.startsWith('otpauth://totp/') && uri.includes(`secret=${sec}`)
    && uri.includes('issuer=FerreSaaS') && uri.includes('digits=6') && uri.includes('period=30'))

  console.log('\n2) Códigos de recuperación (puro)')
  const cods = generarCodigosRecuperacion()
  check('10 códigos únicos con formato XXXXX-XXXXX', cods.length === 10 && new Set(cods).size === 10 && cods.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c)))
  check('sin caracteres ambiguos (0 O 1 I L)', cods.every((c) => !/[01OIL]/.test(c)))
  check('se normaliza minúsculas, espacios y guiones', normalizarCodigo(' ab cde-fghjk ') === 'ABCDEFGHJK')
  check('>>> el hash depende del usuario', hashCodigoRecuperacion('u1', cods[0]!) !== hashCodigoRecuperacion('u2', cods[0]!))
  check('mismo código con otro formato, mismo hash', hashCodigoRecuperacion('u1', cods[0]!) === hashCodigoRecuperacion('u1', cods[0]!.toLowerCase().replace('-', ' ')))

  console.log('\n3) Qué roles lo exigen (tabla, sin literales de rol en la lógica)')
  const exigen = TODOS.filter((r) => mfaObligatorio([r]))
  check('>>> obligatorio solo para OWNER y ADMIN', exigen.join() === 'OWNER,ADMIN', exigen.join())
  check('opcional para vendedor, cajero, almacenero y contador', !mfaObligatorio(['VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR']))
  check('>>> un rol adicional que lo exige basta', mfaObligatorio(['CAJERO', 'ADMIN']))

  console.log('\n4) Preparar el negocio')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `mf-${randomUUID().slice(0, 8)}`, name: 'MFA', planId: plan.id } })
  const otroT = await prisma.tenant.create({ data: { slug: `mf2-${randomUUID().slice(0, 8)}`, name: 'Otro', planId: plan.id } })
  const mk = (tenantId: string, role: Role, tag: string, extra: object = {}) =>
    prisma.user.create({ data: { tenantId, email: `${tag}-${randomUUID()}@x.com`.toLowerCase(), name: tag, role, ...extra } })
  const owner = await mk(t.id, 'OWNER', 'dueno')
  const admin = await mk(t.id, 'ADMIN', 'admin')
  const admin2 = await mk(t.id, 'ADMIN', 'admin2')
  const vend = await mk(t.id, 'VENDEDOR', 'vend')
  const cajero = await mk(t.id, 'CAJERO', 'cajero')
  const ajeno = await mk(otroT.id, 'OWNER', 'ajeno')
  const ctxDe = (u: { id: string; role: Role }, tenantId = t.id): TenantContext =>
    ({ tenantId, userId: u.id, role: u.role, access: 'FULL', branchIds: [] })

  console.log('\n5) Activación')
  check('>>> sin confirmar, no está activo', !(await estadoMfa(vend.id)).activo)
  check('confirmar sin haber iniciado falla', await code(confirmarActivacionMfa(vend.id, '123456')) === 'NOT_FOUND')
  const { secreto, otpauth } = await iniciarActivacionMfa(vend.id)
  check('el otpauth lleva el correo de la cuenta', otpauth.includes(encodeURIComponent((await prisma.user.findUniqueOrThrow({ where: { id: vend.id } })).email)))
  const fila = await prisma.user.findUniqueOrThrow({ where: { id: vend.id } })
  check('>>> el secreto se guarda CIFRADO, no en claro', fila.mfaSecretEnc !== null && !fila.mfaSecretEnc.includes(secreto) && fila.mfaSecretEnc.startsWith('v1.'))
  const ahora = new Date()
  check('un código incorrecto no activa', await code(confirmarActivacionMfa(vend.id, '000000')) === 'UNAUTHENTICATED' || totp(secreto, ahora) === '000000')
  check('...y sigue sin estar activo', !(await estadoMfa(vend.id)).activo)
  const { codigosRecuperacion } = await confirmarActivacionMfa(vend.id, totp(secreto, ahora), ahora)
  const act = await estadoMfa(vend.id)
  check('con el código correcto queda activo y con 10 códigos', act.activo && codigosRecuperacion.length === 10 && act.codigosRestantes === 10)
  const guardado = await prisma.user.findUniqueOrThrow({ where: { id: vend.id } })
  check('>>> los códigos de recuperación se guardan solo como hash', codigosRecuperacion.every((c) => !guardado.mfaRecoveryHashes.includes(c)) && guardado.mfaRecoveryHashes.length === 10)
  check('quedó auditado', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'mfa.activar', entityId: vend.id } })) === 1)
  check('ya activo, no se puede reiniciar', await code(iniciarActivacionMfa(vend.id)) === 'FORBIDDEN_ROLE')

  console.log('\n6) Verificación en el login')
  const t1 = new Date(ahora.getTime() + 30_000)
  check('el código del paso siguiente entra', (await verificarSegundoFactor(vend.id, totp(secreto, t1), t1)).ok)
  check('>>> el MISMO código no vuelve a valer (repetición)', !(await verificarSegundoFactor(vend.id, totp(secreto, t1), t1)).ok)
  check('>>> uno de un paso anterior tampoco', !(await verificarSegundoFactor(vend.id, totp(secreto, ahora), t1)).ok)
  const t2 = new Date(ahora.getTime() + 90_000)
  check('el siguiente paso sí', (await verificarSegundoFactor(vend.id, totp(secreto, t2), t2)).ok)
  check('sin MFA activo → NO_ACTIVO', (await verificarSegundoFactor(cajero.id, '123456', t2)).ok === false)

  console.log('\n7) Códigos de recuperación')
  const cod = codigosRecuperacion[0]!
  const r1 = await verificarSegundoFactor(vend.id, cod.toLowerCase(), t2)
  check('un código de recuperación entra (tolera minúsculas)', r1.ok && r1.recuperacion)
  check('>>> y solo UNA vez', !(await verificarSegundoFactor(vend.id, cod, t2)).ok)
  check('quedan 9 y el uso se auditó', (await estadoMfa(vend.id)).codigosRestantes === 9
    && (await prisma.auditLog.count({ where: { action: 'mfa.codigo_recuperacion_usado', entityId: vend.id } })) === 1)
  const cod2 = codigosRecuperacion[1]!
  const carrera = await Promise.all(Array.from({ length: 5 }, () => verificarSegundoFactor(vend.id, cod2, t2)))
  check('>>> 5 peticiones simultáneas con el mismo código: gana UNA', carrera.filter((r) => r.ok).length === 1, `${carrera.filter((r) => r.ok).length}`)
  check('>>> el código de OTRO usuario no vale', !(await verificarSegundoFactor(vend.id, generarCodigosRecuperacion(1)[0]!, t2)).ok)
  await prisma.user.update({ where: { id: vend.id }, data: { mfaFailedAttempts: 0, mfaLockedUntil: null } })

  console.log('\n8) Bloqueo por intentos')
  let ultimo: Awaited<ReturnType<typeof verificarSegundoFactor>> = { ok: true, recuperacion: false }
  for (let i = 0; i < MAX_INTENTOS_MFA; i++) ultimo = await verificarSegundoFactor(vend.id, '000000', t2)
  check(`>>> al ${MAX_INTENTOS_MFA}º fallo seguido se bloquea`, !ultimo.ok && ultimo.motivo === 'BLOQUEADO')
  const t3 = new Date(t2.getTime() + 120_000)
  const bloqueado = await verificarSegundoFactor(vend.id, totp(secreto, t3), t3)
  check('>>> bloqueado, ni el código CORRECTO entra', !bloqueado.ok && bloqueado.motivo === 'BLOQUEADO')
  check('el bloqueo quedó auditado', (await prisma.auditLog.count({ where: { action: 'mfa.bloqueo', entityId: vend.id } })) >= 1)
  const t4 = new Date(t2.getTime() + BLOQUEO_MFA_MS + 60_000)
  check('pasado el bloqueo vuelve a entrar', (await verificarSegundoFactor(vend.id, totp(secreto, t4), t4)).ok)
  const tras = await prisma.user.findUniqueOrThrow({ where: { id: vend.id } })
  check('un acierto limpia los fallos', tras.mfaFailedAttempts === 0 && tras.mfaLockedUntil === null)
  const ataque = await Promise.all(Array.from({ length: 12 }, () => verificarSegundoFactor(vend.id, '111111', t4)))
  check('>>> 12 intentos en paralelo no pasan de 5 comprobaciones reales',
    ataque.filter((r) => !r.ok && r.motivo === 'INVALIDO').length <= MAX_INTENTOS_MFA)
  await prisma.user.update({ where: { id: vend.id }, data: { mfaFailedAttempts: 0, mfaLockedUntil: null } })

  console.log('\n9) El secreto está atado al usuario (AAD)')
  await prisma.user.update({ where: { id: cajero.id }, data: { mfaSecretEnc: guardado.mfaSecretEnc, mfaEnabledAt: new Date() } })
  check('>>> copiar el secreto cifrado a otra cuenta no sirve', await code(verificarSegundoFactor(cajero.id, totp(secreto, t4), t4)) === 'CifradoInvalido')
  await prisma.user.update({ where: { id: cajero.id }, data: { mfaSecretEnc: null, mfaEnabledAt: null } })

  console.log('\n10) Regenerar y desactivar')
  const tr = new Date(t4.getTime() + 60_000)
  check('regenerar exige un código válido', await code(regenerarCodigosRecuperacion(vend.id, '000000', tr)) === 'UNAUTHENTICATED')
  const nuevos = await regenerarCodigosRecuperacion(vend.id, totp(secreto, tr), tr)
  check('da 10 nuevos', nuevos.codigosRecuperacion.length === 10 && (await estadoMfa(vend.id)).codigosRestantes === 10)
  const tr2 = new Date(tr.getTime() + 60_000)
  check('>>> los códigos viejos dejan de valer', !(await verificarSegundoFactor(vend.id, codigosRecuperacion[5]!, tr2)).ok)
  await prisma.user.update({ where: { id: vend.id }, data: { mfaFailedAttempts: 0 } })
  check('>>> un ADMIN no puede desactivarlo por su cuenta (rol obligatorio)', await code(desactivarMfa(admin.id, '123456')) === 'FORBIDDEN_ROLE')
  check('desactivar exige código', await code(desactivarMfa(vend.id, '000000', tr2)) === 'UNAUTHENTICATED')
  await prisma.user.update({ where: { id: vend.id }, data: { mfaFailedAttempts: 0 } })
  await desactivarMfa(vend.id, nuevos.codigosRecuperacion[0]!, tr2)
  const off = await prisma.user.findUniqueOrThrow({ where: { id: vend.id } })
  check('un vendedor lo desactiva: no queda secreto ni códigos', off.mfaEnabledAt === null && off.mfaSecretEnc === null && off.mfaRecoveryHashes.length === 0)

  console.log('\n11) >>> Obligatorio para OWNER/ADMIN en el contexto')
  const ctxAdmin = await resolveTenantContext(admin.id)
  const ctxOwner = await resolveTenantContext(owner.id)
  const ctxCajero = await resolveTenantContext(cajero.id)
  check('ADMIN sin MFA → mfaPendiente', ctxAdmin.mfaPendiente === true)
  check('OWNER sin MFA → mfaPendiente', ctxOwner.mfaPendiente === true)
  check('>>> CAJERO sin MFA → NO pendiente (no se frena el mostrador)', ctxCajero.mfaPendiente === false)
  await prisma.tenant.update({ where: { id: t.id }, data: { isDemo: true } })
  check('>>> en un negocio DEMO no se exige (la cuenta pública de prueba)', (await resolveTenantContext(admin.id)).mfaPendiente === false)
  await prisma.tenant.update({ where: { id: t.id }, data: { isDemo: false } })
  await prisma.user.update({ where: { id: admin.id }, data: { mfaEnabledAt: new Date(), mfaSecretEnc: 'x' } })
  check('ADMIN con MFA → ya no pendiente', (await resolveTenantContext(admin.id)).mfaPendiente === false)
  await prisma.user.update({ where: { id: admin.id }, data: { mfaEnabledAt: null, mfaSecretEnc: null } })

  console.log('\n12) Contraseña correcta, falta el código')
  const pw = await bcrypt.hash('Clave-segura-123', 4)
  const u = await mk(t.id, 'CAJERO', 'login', { passwordHash: pw })
  const sinMfa = await verifyCredentialsDetailed({ email: u.email, password: 'Clave-segura-123' })
  check('sin MFA: mfaActivo=false', sinMfa.ok && sinMfa.user.mfaActivo === false)
  await prisma.user.update({ where: { id: u.id }, data: { mfaEnabledAt: new Date(), mfaSecretEnc: 'x' } })
  const conMfa = await verifyCredentialsDetailed({ email: u.email, password: 'Clave-segura-123' })
  check('con MFA: mfaActivo=true (el login pedirá el código)', conMfa.ok && conMfa.user.mfaActivo === true)
  check('el campo "codigo" opcional no rompe la validación', (await verifyCredentialsDetailed({ email: u.email, password: 'Clave-segura-123', codigo: '123456' })).ok)

  console.log('\n13) Restablecimiento por un administrador')
  for (const x of [cajero, owner, admin2]) await prisma.user.update({ where: { id: x.id }, data: { mfaEnabledAt: new Date(), mfaSecretEnc: 'x', mfaRecoveryHashes: ['h'] } })
  const sidC = await registrarDispositivo({ userId: cajero.id, tenantId: t.id, userAgent: 'x', ip: '1.1.1.1' })
  const dbAdmin = getTenantPrisma(ctxDe(admin))
  check('>>> el CAJERO no puede restablecer a nadie', await code(restablecerMfaDeUsuario(getTenantPrisma(ctxDe(cajero)), ctxDe(cajero), vend.id)) === 'FORBIDDEN_ROLE')
  check('>>> un ADMIN no restablece al DUEÑO', await code(restablecerMfaDeUsuario(dbAdmin, ctxDe(admin), owner.id)) === 'FORBIDDEN_ROLE')
  check('>>> ni a sí mismo por esta vía', await code(restablecerMfaDeUsuario(dbAdmin, ctxDe(admin), admin.id)) === 'FORBIDDEN_ROLE')
  check('>>> otro negocio no ve al usuario', await code(restablecerMfaDeUsuario(getTenantPrisma(ctxDe(ajeno, otroT.id)), ctxDe(ajeno, otroT.id), cajero.id)) === 'NOT_FOUND')
  await restablecerMfaDeUsuario(dbAdmin, ctxDe(admin), cajero.id)
  const rest = await prisma.user.findUniqueOrThrow({ where: { id: cajero.id } })
  check('el ADMIN restablece al cajero: sin secreto, sin códigos', rest.mfaEnabledAt === null && rest.mfaSecretEnc === null && rest.mfaRecoveryHashes.length === 0)
  check('...y le cierra las sesiones', (await prisma.deviceSession.findUniqueOrThrow({ where: { id: sidC } })).revokedAt !== null)
  check('...y queda auditado', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'mfa.restablecer', entityId: cajero.id } })) === 1)
  const ctxDueno = ctxDe(owner)
  await restablecerMfaDeUsuario(getTenantPrisma(ctxDueno), ctxDueno, admin2.id)
  check('el DUEÑO restablece a un administrador, que deberá activarlo de nuevo', (await resolveTenantContext(admin2.id)).mfaPendiente === true)

  await prisma.tenant.deleteMany({ where: { id: { in: [t.id, otroT.id] } } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(async () => {
  try { return await main() } finally {
    if (claveAntes === undefined) delete process.env.PSE_MASTER_KEY; else process.env.PSE_MASTER_KEY = claveAntes
  }
})
