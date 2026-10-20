import './guard'
import { correr } from './teardown'
import { crearSucursal, asignarSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { resolveTenantContext } from '../src/lib/session'
import { PERMISOS } from '../src/lib/permisos'
import { permisosDe, puede } from '../src/lib/puede'
import { emitirOperadorToken, verificarOperadorToken } from '../src/lib/operator-token'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'
import {
  MAX_INTENTOS_PIN, PERMISOS_FUERA_DEL_PIN, permisosDenegadosAlOperador, validarFormatoPin,
} from '../src/features/seguridad/pin-reglas'
import {
  aplicarOperador, contextoDeOperador, desbloquearPin, establecerPin, listarOperadores, quitarPin, verificarPin,
} from '../src/features/seguridad/pin-service'
import {
  TOQUE_CADA_MS, cerrarDispositivo, cerrarOtrosDispositivos, cerrarSesionActual, cerrarSesionesDeUsuario,
  describirDispositivo, listarDispositivos, registrarDispositivo, tocarDispositivo,
} from '../src/features/seguridad/dispositivos'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const TODOS: Role[] = ['OWNER', 'ADMIN', 'VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR']

async function main() {
  console.log('\n1) Formato del PIN (puro)')
  check('4 a 6 cifras valen', validarFormatoPin('4821').valido && validarFormatoPin('482193').valido)
  check('3 o 7 cifras no', !validarFormatoPin('482').valido && !validarFormatoPin('4821937').valido)
  check('con letras no', !validarFormatoPin('48a1').valido)
  check('>>> 0000 y 1111 (repetido) no', !validarFormatoPin('0000').valido && !validarFormatoPin('1111').valido)
  check('>>> 1234, 4321 y 123456 (secuencia) no', !validarFormatoPin('1234').valido && !validarFormatoPin('4321').valido && !validarFormatoPin('123456').valido)
  check('1357 sí (no es una secuencia de a 1)', validarFormatoPin('1357').valido)
  check('el límite es 5 intentos', MAX_INTENTOS_PIN === 5)

  console.log('\n2) >>> El operador NUNCA tiene más permisos que la sesión ni que él mismo (propiedad exhaustiva)')
  const ctxRol = (role: Role, roles: Role[] = []): TenantContext => ({ tenantId: 't', userId: 's', role, roles, access: 'FULL', branchId: 'b1', branchIds: ['b1', 'b2'] })
  let violaciones = 0, pares = 0
  for (const sesionRol of TODOS) for (const opRol of TODOS) {
    pares++
    const sesion = ctxRol(sesionRol)
    const op = contextoDeOperador(sesion, { id: 'op', role: opRol, extraRoles: [] })
    const efectivos = permisosDe(op)
    const deSesion = permisosDe(sesion)
    const deOperador = permisosDe(ctxRol(opRol))
    for (const p of PERMISOS) {
      const debe = deSesion.has(p) && deOperador.has(p) && !PERMISOS_FUERA_DEL_PIN.includes(p)
      if (efectivos.has(p) !== debe) violaciones++
    }
  }
  check(`>>> ${pares} combinaciones sesión × operador: permisos = intersección − vedados, sin una sola excepción`, violaciones === 0, `${violaciones} violaciones`)
  const vendAdmin = contextoDeOperador(ctxRol('VENDEDOR'), { id: 'op', role: 'ADMIN', extraRoles: [] })
  check('>>> un ADMIN que entra en el dispositivo de un VENDEDOR NO gana nada: no puede gestionar usuarios',
    !puede(vendAdmin, 'usuarios.gestionar') && !puede(vendAdmin, 'reportes.ver') && puede(vendAdmin, 'ventas.crear'))
  const ownerCajero = contextoDeOperador(ctxRol('OWNER'), { id: 'op', role: 'CAJERO', extraRoles: [] })
  check('>>> un CAJERO que entra en el dispositivo del DUEÑO NO hereda sus permisos', !puede(ownerCajero, 'reportes.ver') && puede(ownerCajero, 'ventas.cobrar'))
  const ownerOwner = contextoDeOperador(ctxRol('OWNER'), { id: 'op', role: 'OWNER', extraRoles: [] })
  check('>>> ni el propio dueño por PIN gestiona usuarios, sucursales, plan ni datos fiscales',
    PERMISOS_FUERA_DEL_PIN.every((p) => !puede(ownerOwner, p)) && puede(ownerOwner, 'reportes.ver'))
  check('la identidad es la del operador y queda anotado de quién es el dispositivo',
    vendAdmin.userId === 'op' && vendAdmin.role === 'ADMIN' && vendAdmin.operadorDe === 's')
  check('>>> solo opera en la sucursal activa (no en las otras de la sesión)', JSON.stringify(vendAdmin.branchIds) === '["b1"]')
  check('permisosDenegadosAlOperador quita lo vedado aunque la sesión lo tenga', permisosDenegadosAlOperador(new Set(PERMISOS)).length === PERMISOS_FUERA_DEL_PIN.length)

  console.log('\n3) Cookie del operador (firmada y atada a la sesión)')
  const tk = emitirOperadorToken({ sid: 'sid1', sub: 'u1', op: 'u2' })
  check('un token válido se verifica', verificarOperadorToken(tk)?.op === 'u2')
  check('>>> un token manipulado se rechaza', verificarOperadorToken(tk.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))) === null)
  check('sin firma o vacío, no', verificarOperadorToken(tk.split('.')[0]) === null && verificarOperadorToken('') === null && verificarOperadorToken(undefined) === null)
  check('>>> caduca', verificarOperadorToken(emitirOperadorToken({ sid: 's', sub: 'u', op: 'o' }, new Date(Date.now() - 13 * 3600_000))) === null)
  check('lleva el sid al que está atado', verificarOperadorToken(tk)?.sid === 'sid1')

  console.log('\n4) Preparar el negocio')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `sg-${randomUUID().slice(0, 8)}`, name: 'Seguridad', planId: plan.id } })
  const otroT = await prisma.tenant.create({ data: { slug: `sg2-${randomUUID().slice(0, 8)}`, name: 'Otro', planId: plan.id } })
  const bN = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const bS = await crearSucursal(t.id, { code: 'SUR', name: 'Sur', seriesNumber: 2, isDefault: false, establishmentCode: '0001' })
  const bX = await crearSucursal(otroT.id, { code: 'AJENA' })
  const mk = (tenantId: string, role: Role, tag: string, extra: Partial<{ isActive: boolean }> = {}) =>
    prisma.user.create({ data: { tenantId, email: `${tag}-${randomUUID()}@x.com`.toLowerCase(), name: tag, role, ...extra } })
  const owner = await mk(t.id, 'OWNER', 'dueno')
  const admin = await mk(t.id, 'ADMIN', 'admin')
  const vend = await mk(t.id, 'VENDEDOR', 'vendedor')      // el dispositivo está con su sesión
  const cajero = await mk(t.id, 'CAJERO', 'cajero')
  const cajeroSur = await mk(t.id, 'CAJERO', 'cajerosur')    // otra sucursal
  const inactivo = await mk(t.id, 'CAJERO', 'inactivo', { isActive: false })
  const sinPin = await mk(t.id, 'CAJERO', 'sinpin')
  const ajeno = await mk(otroT.id, 'CAJERO', 'ajeno')
  for (const u of [admin, vend, cajero, inactivo, sinPin]) await asignarSucursal(t.id, u.id, bN.id)
  await asignarSucursal(t.id, owner.id, bN.id)
  await asignarSucursal(t.id, cajeroSur.id, bS.id)
  await asignarSucursal(otroT.id, ajeno.id, bX.id)
  const ctxDe = (u: { id: string }, role: Role, branch = bN.id, all = [bN.id, bS.id]): TenantContext =>
    ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branch, branchIds: role === 'OWNER' || role === 'ADMIN' ? all : [branch] })
  const cOwner = ctxDe(owner, 'OWNER'), cAdmin = ctxDe(admin, 'ADMIN'), cVend = ctxDe(vend, 'VENDEDOR'), cCajero = ctxDe(cajero, 'CAJERO')
  const dbOwner = getTenantPrisma(cOwner), dbAdmin = getTenantPrisma(cAdmin), dbVend = getTenantPrisma(cVend), dbCajero = getTenantPrisma(cCajero)

  console.log('\n5) Poner el PIN')
  await establecerPin(dbAdmin, cAdmin, { userId: cajero.id, pin: '4821' })
  const fCajero = await prisma.user.findUniqueOrThrow({ where: { id: cajero.id } })
  check('>>> se guarda hasheado (bcrypt), nunca en claro', !!fCajero.pinHash && fCajero.pinHash !== '4821' && await bcrypt.compare('4821', fCajero.pinHash))
  check('queda auditado SIN el PIN', !JSON.stringify(await prisma.auditLog.findMany({ where: { tenantId: t.id, action: 'pin.establecer' } })).includes('4821'))
  check('>>> un PIN fácil se rechaza', await code(establecerPin(dbAdmin, cAdmin, { userId: cajero.id, pin: '1234' })) === 'INVALID_DOCUMENT')
  check('>>> el CAJERO no puede poner PIN a nadie', await code(establecerPin(dbCajero, cCajero, { userId: cajero.id, pin: '5937' })) === 'FORBIDDEN_ROLE')
  check('>>> el ADMIN no puede poner PIN al DUEÑO', await code(establecerPin(dbAdmin, cAdmin, { userId: owner.id, pin: '5937' })) === 'FORBIDDEN_ROLE')
  check('el dueño sí puede ponerse el suyo', await code(establecerPin(dbOwner, cOwner, { userId: owner.id, pin: '7391' })) === null)
  await establecerPin(dbAdmin, cAdmin, { userId: cajeroSur.id, pin: '2468' })
  await establecerPin(dbAdmin, cAdmin, { userId: inactivo.id, pin: '3579' }).catch(() => {})
  await prisma.user.update({ where: { id: inactivo.id }, data: { pinHash: await bcrypt.hash('3579', 4) } })

  console.log('\n6) Quién aparece para entrar con PIN')
  const ops = await listarOperadores(dbVend, cVend)
  check('>>> solo asignados a ESTA sucursal, activos y con PIN', ops.some((o) => o.id === cajero.id) && ops.some((o) => o.id === owner.id) &&
    !ops.some((o) => o.id === cajeroSur.id) && !ops.some((o) => o.id === inactivo.id) && !ops.some((o) => o.id === sinPin.id), ops.map((o) => o.nombre).join())

  console.log('\n7) Entrar con el PIN')
  const ok = await verificarPin(dbVend, cVend, { userId: cajero.id, pin: '4821' })
  check('con el PIN correcto identifica al operador', ok.id === cajero.id)
  check('queda auditado el uso (actor = el usuario de la sesión)', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'pin.uso', entityId: cajero.id, actorId: vend.id } })) === 1)
  const msgs = new Set<string>()
  for (const [uid, pin] of [[cajero.id, '9999'], ['no-existe', '4821'], [sinPin.id, '4821'], [cajeroSur.id, '2468'], [inactivo.id, '3579'], [ajeno.id, '1111']] as const) {
    const e = await verificarPin(dbVend, cVend, { userId: uid, pin }).catch((x) => x)
    msgs.add(e.message?.replace(/ Se bloque.*/, ''))
  }
  check('>>> «no existe», «sin PIN», «otra sucursal», «inactivo», «de otro negocio» y «PIN malo» dan el MISMO mensaje', msgs.size === 1, [...msgs].join(' | '))
  check('>>> el de otra sucursal NO entra aunque el PIN sea correcto', await code(verificarPin(dbVend, cVend, { userId: cajeroSur.id, pin: '2468' })) === 'FORBIDDEN_ROLE')
  check('>>> el inactivo tampoco', await code(verificarPin(dbVend, cVend, { userId: inactivo.id, pin: '3579' })) === 'FORBIDDEN_ROLE')
  check('>>> ni uno de OTRO negocio', await code(verificarPin(dbVend, cVend, { userId: ajeno.id, pin: '1111' })) === 'FORBIDDEN_ROLE')
  await prisma.user.update({ where: { id: cajero.id }, data: { pinFailedAttempts: 0 } })

  console.log('\n8) >>> Bloqueo a los 5 intentos')
  for (let i = 1; i <= 4; i++) await verificarPin(dbVend, cVend, { userId: cajero.id, pin: '0000' }).catch(() => {})
  const f4 = await prisma.user.findUniqueOrThrow({ where: { id: cajero.id } })
  check('4 fallos: sigue sin bloquearse', f4.pinFailedAttempts === 4 && f4.pinLockedAt === null)
  const e5 = await verificarPin(dbVend, cVend, { userId: cajero.id, pin: '0000' }).catch((x) => x)
  const f5 = await prisma.user.findUniqueOrThrow({ where: { id: cajero.id } })
  check('>>> el 5.º fallo lo BLOQUEA', f5.pinLockedAt !== null && f5.pinFailedAttempts >= 5 && /bloque/i.test(e5.message))
  check('>>> con el PIN CORRECTO sigue rechazado mientras esté bloqueado', await code(verificarPin(dbVend, cVend, { userId: cajero.id, pin: '4821' })) === 'FORBIDDEN_ROLE')
  check('>>> y no aparece como operador utilizable: aplicarOperador devuelve null', (await aplicarOperador(cVend, cajero.id)) === null)
  const acciones = (await prisma.auditLog.findMany({ where: { tenantId: t.id, entityId: cajero.id, action: { startsWith: 'pin.' } } })).map((a) => a.action)
  check('>>> cada fallo, el bloqueo y el rechazo quedaron auditados', acciones.filter((a) => a === 'pin.fallo').length >= 4 && acciones.includes('pin.bloqueo') && acciones.includes('pin.rechazado_bloqueado'), acciones.join())

  console.log('\n9) Desbloquear')
  check('>>> el CAJERO no puede desbloquear', await code(desbloquearPin(dbCajero, cCajero, cajero.id)) === 'FORBIDDEN_ROLE')
  check('el VENDEDOR tampoco', await code(desbloquearPin(dbVend, cVend, cajero.id)) === 'FORBIDDEN_ROLE')
  await desbloquearPin(dbAdmin, cAdmin, cajero.id)
  const fd = await prisma.user.findUniqueOrThrow({ where: { id: cajero.id } })
  check('>>> el ADMIN sí; limpia el bloqueo y los fallos', fd.pinLockedAt === null && fd.pinFailedAttempts === 0)
  check('queda auditado', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'pin.desbloquear', entityId: cajero.id } })) === 1)
  check('y vuelve a funcionar', (await verificarPin(dbVend, cVend, { userId: cajero.id, pin: '4821' })).id === cajero.id)
  await prisma.user.update({ where: { id: owner.id }, data: { pinLockedAt: new Date(), pinFailedAttempts: 5 } })
  check('>>> el ADMIN no puede desbloquear el PIN del DUEÑO', await code(desbloquearPin(dbAdmin, cAdmin, owner.id)) === 'FORBIDDEN_ROLE')
  check('el dueño sí puede desbloquear el suyo', await code(desbloquearPin(dbOwner, cOwner, owner.id)) === null)

  console.log('\n10) >>> Ráfaga de intentos simultáneos: solo 5 se llegan a comprobar')
  await prisma.user.update({ where: { id: cajero.id }, data: { pinFailedAttempts: 0, pinLockedAt: null } })
  await prisma.auditLog.deleteMany({ where: { tenantId: t.id, entityId: cajero.id, action: { startsWith: 'pin.' } } })
  const rafaga = await Promise.all(Array.from({ length: 12 }, (_, i) => code(verificarPin(dbVend, cVend, { userId: cajero.id, pin: `${5000 + i}` }))))
  const comprobados = await prisma.auditLog.count({ where: { tenantId: t.id, entityId: cajero.id, action: { in: ['pin.fallo', 'pin.bloqueo'] } } })
  const rechazados = await prisma.auditLog.count({ where: { tenantId: t.id, entityId: cajero.id, action: 'pin.rechazado_bloqueado' } })
  check('todos fallaron', rafaga.every((r) => r === 'FORBIDDEN_ROLE'))
  check(`>>> exactamente ${MAX_INTENTOS_PIN} PIN llegaron a compararse (no 12)`, comprobados === MAX_INTENTOS_PIN, `comparados=${comprobados} rechazados sin comparar=${rechazados}`)
  check('y el PIN quedó bloqueado', (await prisma.user.findUniqueOrThrow({ where: { id: cajero.id } })).pinLockedAt !== null)
  await desbloquearPin(dbAdmin, cAdmin, cajero.id)

  console.log('\n11) Aplicar al operador sobre la sesión')
  const conOp = await aplicarOperador(cVend, cajero.id)
  check('>>> operador válido: contexto con su identidad y los permisos recortados', conOp?.userId === cajero.id && conOp.operadorDe === vend.id && !puede(conOp, 'caja.abrir_cerrar') /* el VENDEDOR no la tiene */)
  check('el propio usuario de la sesión no se «cambia» a sí mismo', (await aplicarOperador(cVend, vend.id)) === null)
  check('>>> un operador de otra sucursal no se aplica', (await aplicarOperador(cVend, cajeroSur.id)) === null)
  await prisma.user.update({ where: { id: cajero.id }, data: { isActive: false } })
  check('>>> si se desactiva, la cookie deja de valer', (await aplicarOperador(cVend, cajero.id)) === null)
  await prisma.user.update({ where: { id: cajero.id }, data: { isActive: true } })
  await quitarPin(dbAdmin, cAdmin, cajero.id)
  check('>>> si se le quita el PIN, también', (await aplicarOperador(cVend, cajero.id)) === null)
  await establecerPin(dbAdmin, cAdmin, { userId: cajero.id, pin: '4821' })

  console.log('\n12) Sesiones por dispositivo')
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'
  const sid1 = await registrarDispositivo({ userId: vend.id, tenantId: null, userAgent: ua, ip: '1.2.3.4' })
  const sid2 = await registrarDispositivo({ userId: vend.id, tenantId: t.id, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17) Safari/604.1', ip: '5.6.7.8' })
  const sidAjeno = await registrarDispositivo({ userId: admin.id, tenantId: t.id, userAgent: ua, ip: '9.9.9.9' })
  check('la descripción se entiende', describirDispositivo(ua) === 'Chrome · Windows' && describirDispositivo('Mozilla/5.0 (iPhone) Safari/604.1') === 'Safari · iOS' && describirDispositivo(null) === 'Dispositivo desconocido')
  check('el tenant se toma del usuario si no viene', (await prisma.deviceSession.findUniqueOrThrow({ where: { id: sid1 } })).tenantId === t.id)
  check('>>> con un sid vivo el contexto se resuelve', (await resolveTenantContext(vend.id, new Date(), undefined, undefined, sid1)).userId === vend.id)
  check('sin sid (JWT anteriores) también', (await resolveTenantContext(vend.id)).userId === vend.id)
  check('>>> un sid inventado se RECHAZA', await code(resolveTenantContext(vend.id, new Date(), undefined, undefined, 'inventado')) === 'UNAUTHENTICATED')
  check('>>> un sid de OTRO usuario no vale para este', await code(resolveTenantContext(vend.id, new Date(), undefined, undefined, sidAjeno)) === 'UNAUTHENTICATED')
  const lista = await listarDispositivos(vend.id, sid1)
  check('lista las dos sesiones vivas y marca la actual', lista.length === 2 && lista.find((d) => d.id === sid1)?.actual === true && lista.find((d) => d.id === sid2)?.actual === false)
  check('>>> no se puede cerrar la sesión de OTRO por su id', (await cerrarDispositivo(vend.id, sidAjeno)) === false)
  check('...y la del otro sigue viva', (await prisma.deviceSession.findUniqueOrThrow({ where: { id: sidAjeno } })).revokedAt === null)
  check('cerrar una propia funciona', (await cerrarDispositivo(vend.id, sid2)) === true)
  check('>>> y esa sesión deja de valer en la SIGUIENTE petición', await code(resolveTenantContext(vend.id, new Date(), undefined, undefined, sid2)) === 'UNAUTHENTICATED')
  check('cerrar una ya cerrada devuelve false', (await cerrarDispositivo(vend.id, sid2)) === false)
  const sid3 = await registrarDispositivo({ userId: vend.id, tenantId: t.id, userAgent: ua, ip: '1.1.1.1' })
  const n = await cerrarOtrosDispositivos(vend.id, sid1)
  check('>>> «cerrar las demás» deja viva solo la actual', n === 1 && (await code(resolveTenantContext(vend.id, new Date(), undefined, undefined, sid3))) === 'UNAUTHENTICATED' &&
    (await resolveTenantContext(vend.id, new Date(), undefined, undefined, sid1)).userId === vend.id)
  await cerrarSesionActual(sid1)
  check('cerrar sesión revoca el registro', await code(resolveTenantContext(vend.id, new Date(), undefined, undefined, sid1)) === 'UNAUTHENTICATED')
  const vieja = await prisma.deviceSession.create({ data: { userId: vend.id, tenantId: t.id, createdAt: new Date(Date.now() - 20 * 3600_000) } })
  check('las sesiones de más de 12 h no se listan como vivas', !(await listarDispositivos(vend.id, undefined)).some((d) => d.id === vieja.id))
  const d0 = await prisma.deviceSession.findUniqueOrThrow({ where: { id: sidAjeno } })
  await tocarDispositivo(sidAjeno, d0.lastSeenAt, new Date(d0.lastSeenAt.getTime() + 60_000))
  check('>>> «visto» no se reescribe en cada clic (antes de 5 min)', (await prisma.deviceSession.findUniqueOrThrow({ where: { id: sidAjeno } })).lastSeenAt.getTime() === d0.lastSeenAt.getTime())
  const luego = new Date(d0.lastSeenAt.getTime() + TOQUE_CADA_MS + 1000)
  await tocarDispositivo(sidAjeno, d0.lastSeenAt, luego)
  check('pasados 5 min sí', (await prisma.deviceSession.findUniqueOrThrow({ where: { id: sidAjeno } })).lastSeenAt.getTime() === luego.getTime())

  console.log('\n13) Cerrar las sesiones de un miembro del equipo')
  const sidC1 = await registrarDispositivo({ userId: cajero.id, tenantId: t.id, userAgent: ua, ip: '2.2.2.2' })
  const sidO1 = await registrarDispositivo({ userId: owner.id, tenantId: t.id, userAgent: ua, ip: '3.3.3.3' })
  check('>>> el CAJERO no puede cerrar las sesiones de nadie', await code(cerrarSesionesDeUsuario(dbCajero, cCajero, cajero.id)) === 'FORBIDDEN_ROLE')
  check('>>> el ADMIN no puede cerrar las del DUEÑO', await code(cerrarSesionesDeUsuario(dbAdmin, cAdmin, owner.id)) === 'FORBIDDEN_ROLE')
  check('...que siguen vivas', (await prisma.deviceSession.findUniqueOrThrow({ where: { id: sidO1 } })).revokedAt === null)
  check('el ADMIN cierra las del cajero', (await cerrarSesionesDeUsuario(dbAdmin, cAdmin, cajero.id)) >= 1 && await code(resolveTenantContext(cajero.id, new Date(), undefined, undefined, sidC1)) === 'UNAUTHENTICATED')
  check('queda auditado', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'sesion.cerrar_todas', entityId: cajero.id } })) === 1)
  const dbOtro = getTenantPrisma({ tenantId: otroT.id, userId: ajeno.id, role: 'OWNER', access: 'FULL' })
  check('>>> otro negocio no ve al usuario', await code(cerrarSesionesDeUsuario(dbOtro, { tenantId: otroT.id, userId: ajeno.id, role: 'OWNER', access: 'FULL' }, cajero.id)) === 'NOT_FOUND')

  await prisma.tenant.deleteMany({ where: { id: { in: [t.id, otroT.id] } } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
