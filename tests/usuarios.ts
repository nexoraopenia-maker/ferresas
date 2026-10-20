import './guard'
import { correr } from './teardown'
import { crearSucursal, asignarSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { resolveTenantContext } from '../src/lib/session'
import { MATRIZ, permisosDeRol } from '../src/lib/permisos'
import { puede, permisosDe } from '../src/lib/puede'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'
import { puedeAsignar, puedeCambiarPassword, puedeGestionarA, rolesAsignables } from '../src/features/usuarios/asignacion'
import {
  aceptarInvitacion, cambiarEstado, cambiarPasswordUsuario, cambiarRoles, crearUsuarioDirecto,
  hashToken, invitar, listarEquipo, revocarInvitacion,
} from '../src/features/usuarios/service'
import { cambiarEstadoSchema, cambiarPasswordSchema, cambiarRolesSchema, crearDirectoSchema, invitarSchema } from '../src/features/usuarios/schemas'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const ctxDe = (role: Role, roles: Role[] = []): TenantContext =>
  ({ tenantId: 't', userId: 'u-actor', role, roles, access: 'FULL' })

async function main() {
  console.log('\n1) >>> Nadie concede más poder del que tiene (reglas puras)')
  const TODOS: Role[] = ['OWNER', 'ADMIN', 'VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR']
  const sorted = (a: Role[]) => [...a].sort().join()
  check('OWNER puede dar los 5 roles de negocio',
    sorted(rolesAsignables(ctxDe('OWNER'))) === sorted(['ADMIN', 'VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR']))
  check('>>> ADMIN puede dar ADMIN y los demás, pero NO el de DUEÑO',
    rolesAsignables(ctxDe('ADMIN')).length === 5 && !puedeAsignar(ctxDe('ADMIN'), ['OWNER']))
  check('>>> ni el OWNER concede OWNER por esta vía', !puedeAsignar(ctxDe('OWNER'), ['OWNER']))
  check('nadie concede SUPERADMIN', TODOS.every((r) => !puedeAsignar(ctxDe(r), ['SUPERADMIN'])))
  check('un CAJERO no puede dar el rol de ADMIN', !puedeAsignar(ctxDe('CAJERO'), ['ADMIN']))
  check('>>> ADMIN + CONTADOR (varios roles) sigue sin poder dar OWNER',
    !puedeAsignar(ctxDe('ADMIN', ['CONTADOR']), ['OWNER']))

  // Propiedad: para TODA combinación de hasta dos roles del actor y todo rol R,
  // si se puede asignar, los permisos de R están contenidos en los del actor.
  let violaciones = 0, combos = 0
  for (const a of TODOS) for (const b of [undefined, ...TODOS]) {
    const actor = ctxDe(a, b ? [b] : [])
    const propios = permisosDe(actor)
    for (const r of TODOS) {
      combos++
      if (puedeAsignar(actor, [r]) && ![...permisosDeRol(r)].every((p) => propios.has(p))) violaciones++
    }
  }
  check(`>>> PROPIEDAD en ${combos} combinaciones: nunca se concede lo que no se tiene`, violaciones === 0, String(violaciones))

  const objetivo = (role: Role, extra: Role[] = []) => ({ id: 'u-otro', role, extraRoles: extra })
  check('nadie gestiona a un OWNER', TODOS.every((r) => !puedeGestionarA(ctxDe(r), objetivo('OWNER'))))
  check('nadie se gestiona a sí mismo',
    !puedeGestionarA(ctxDe('OWNER'), { id: 'u-actor', role: 'CAJERO', extraRoles: [] }))
  check('ADMIN gestiona a un cajero', puedeGestionarA(ctxDe('ADMIN'), objetivo('CAJERO')))
  check('>>> un CAJERO con rol extra de ADMIN sí es gestionable por un ADMIN (no supera su poder)',
    puedeGestionarA(ctxDe('ADMIN'), objetivo('CAJERO', ['ADMIN'])))
  check('>>> un CAJERO NO gestiona a un VENDEDOR (le faltan permisos, y no tiene usuarios.gestionar)',
    !puedeGestionarA(ctxDe('CAJERO'), objetivo('VENDEDOR')) || !puede(ctxDe('CAJERO'), 'usuarios.gestionar'))
  check('MATRIZ: solo OWNER y ADMIN tienen usuarios.gestionar',
    TODOS.filter((r) => MATRIZ[r].includes('usuarios.gestionar')).sort().join() === 'ADMIN,OWNER')

  console.log('\n2) Esquemas')
  check('el esquema no admite OWNER como rol invitable',
    !invitarSchema.safeParse({ email: 'a@b.com', role: 'OWNER' }).success)
  check('ni como rol adicional',
    !invitarSchema.safeParse({ email: 'a@b.com', role: 'CAJERO', extraRoles: ['OWNER'] }).success)
  check('el rol extra repetido o igual al principal se limpia',
    JSON.stringify(invitarSchema.parse({ email: 'A@B.com ', role: 'CAJERO', extraRoles: ['CAJERO', 'CONTADOR', 'CONTADOR'] }).extraRoles) === '["CONTADOR"]')
  check('el correo se normaliza', invitarSchema.parse({ email: ' A@B.COM ', role: 'CAJERO' }).email === 'a@b.com')
  void cambiarRolesSchema; void cambiarEstadoSchema

  console.log('\n3) Invitar')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const planTest = await prisma.plan.create({
    data: {
      code: `t-usr-${randomUUID().slice(0, 6)}`, name: 'Plan 4 usuarios',
      priceMonthly: 0, priceYearly: 0, maxUsers: 4, sortOrder: 999, isActive: false,
    },
  })
  const t = await prisma.tenant.create({
    data: { slug: `us-${randomUUID().slice(0, 8)}`, name: 'Equipo Test', planId: planTest.id },
  })
  const tB = await prisma.tenant.create({
    data: { slug: `usb-${randomUUID().slice(0, 8)}`, name: 'Otro negocio', planId: plan.id },
  })
  const bN = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const bS = await crearSucursal(t.id, { code: 'SUR', name: 'Sur', seriesNumber: 2, isDefault: false, establishmentCode: '0001' })
  const bB = await crearSucursal(tB.id, { code: 'AJENA' })
  const mk = (tenantId: string, role: Role, extra: Role[] = [], tag = role as string) =>
    prisma.user.create({
      data: { tenantId, email: `${tag}-${randomUUID()}@x.com`.toLowerCase(), name: tag, role, extraRoles: extra },
    })
  const owner = await mk(t.id, 'OWNER')
  const admin = await mk(t.id, 'ADMIN')
  const cajero = await mk(t.id, 'CAJERO')
  const adminB = await mk(tB.id, 'ADMIN', [], 'ADMIN-B')
  await asignarSucursal(t.id, admin.id, bN.id)
  await asignarSucursal(t.id, cajero.id, bN.id)
  const mkCtx = (u: { id: string; role: Role; extraRoles: Role[] }, tenantId = t.id, branchIds?: string[]): TenantContext =>
    ({ tenantId, userId: u.id, role: u.role, roles: u.extraRoles, access: 'FULL', branchId: branchIds?.[0], branchIds })
  const cOwner = mkCtx(owner, t.id, [bN.id, bS.id])
  const cAdmin = mkCtx(admin, t.id, [bN.id, bS.id])      // gestiona sucursales → alcanza todas
  const cCajero = mkCtx(cajero, t.id, [bN.id])
  const cAdminB = mkCtx(adminB, tB.id, [bB.id])
  const dbOwner = getTenantPrisma(cOwner)
  const dbAdmin = getTenantPrisma(cAdmin)
  const dbCajero = getTenantPrisma(cCajero)
  const dbAdminB = getTenantPrisma(cAdminB)
  const datos = (o: Record<string, unknown>) => invitarSchema.parse({ role: 'CAJERO', ...o })
  const crudo = (o: Record<string, unknown>) => ({ role: 'CAJERO', extraRoles: [], branchIds: [], ...o }) as never

  const inv1 = await invitar(dbAdmin, cAdmin, datos({ email: 'nuevo1@x.com', branchIds: [bN.id] }))
  check('ADMIN invita a un CAJERO', inv1.token.length >= 40 && inv1.enlace === `/invitacion/${inv1.token}`)
  const fila1 = await prisma.invitation.findUniqueOrThrow({ where: { id: inv1.id } })
  check('>>> en la base solo está el HASH del token, nunca el token',
    fila1.tokenHash === hashToken(inv1.token) && fila1.tokenHash !== inv1.token &&
    !JSON.stringify(fila1).includes(inv1.token))
  check('vence en 7 días', Math.round((fila1.expiresAt.getTime() - Date.now()) / 86_400_000) === 7)
  check('>>> ADMIN NO puede invitar a un DUEÑO (saltándose Zod)',
    await code(invitar(dbAdmin, cAdmin, crudo({ email: 'dueno@x.com', role: 'OWNER' }))) === 'FORBIDDEN_ROLE')
  check('>>> ni el OWNER invita a otro OWNER',
    await code(invitar(dbOwner, cOwner, crudo({ email: 'dueno2@x.com', role: 'OWNER' }))) === 'FORBIDDEN_ROLE')
  check('>>> ni como rol adicional',
    await code(invitar(dbAdmin, cAdmin, crudo({ email: 'x1@x.com', extraRoles: ['OWNER'] }))) === 'FORBIDDEN_ROLE')
  check('>>> un CAJERO no puede invitar a nadie',
    await code(invitar(dbCajero, cCajero, datos({ email: 'x2@x.com' }))) === 'FORBIDDEN_ROLE')
  check('un correo que ya es del equipo se rechaza',
    await code(invitar(dbAdmin, cAdmin, datos({ email: owner.email }))) === 'DUPLICATE_CODE')
  check('>>> una sucursal de OTRO negocio se rechaza',
    await code(invitar(dbAdmin, cAdmin, datos({ email: 'x3@x.com', branchIds: [bB.id] }))) === 'TENANT_MISMATCH')
  const cAcotado = mkCtx(admin, t.id, [bN.id])
  check('>>> y una sucursal fuera del alcance de quien invita también',
    await code(invitar(getTenantPrisma(cAcotado), cAcotado, datos({ email: 'x4@x.com', branchIds: [bS.id] }))) === 'TENANT_MISMATCH')

  const inv1b = await invitar(dbAdmin, cAdmin, datos({ email: 'nuevo1@x.com' }))
  check('>>> reinvitar al mismo correo ANULA la invitación anterior',
    (await prisma.invitation.findUniqueOrThrow({ where: { id: inv1.id } })).revokedAt !== null &&
    (await prisma.invitation.findUniqueOrThrow({ where: { id: inv1b.id } })).revokedAt === null)
  check('>>> el enlace anulado ya no sirve',
    await code(aceptarInvitacion({ token: inv1.token, name: 'Alguien', password: 'clave-larga-1' })) === 'NOT_FOUND')

  console.log('\n4) Cupo del plan (usuarios activos + invitaciones vivas)')
  // 3 usuarios del equipo + 1 invitación viva = 4 = el tope del plan.
  check('>>> con el cupo lleno, otra invitación se rechaza',
    await code(invitar(dbAdmin, cAdmin, datos({ email: 'extra@x.com' }))) === 'PLAN_LIMIT_REACHED')
  await revocarInvitacion(dbAdmin, cAdmin, inv1b.id)
  const inv2 = await invitar(dbAdmin, cAdmin, datos({
    email: 'nuevo2@x.com', role: 'CONTADOR', extraRoles: ['CAJERO'], branchIds: [bN.id, bS.id],
  }))
  check('al cancelar una invitación el cupo se libera', inv2.id.length > 0)

  await prisma.plan.update({ where: { id: planTest.id }, data: { maxUsers: 12 } }) // el resto no prueba el cupo

  console.log('\n5) Aceptar la invitación')
  const nueva = await aceptarInvitacion({ token: inv2.token, name: 'Rosa Contadora', password: 'clave-larga-2' })
  const creado = await prisma.user.findUniqueOrThrow({
    where: { id: nueva.userId }, include: { branches: true },
  })
  check('crea el usuario en el negocio con el rol de la invitación',
    creado.tenantId === t.id && creado.role === 'CONTADOR' && creado.extraRoles.join() === 'CAJERO')
  check('>>> y con las sucursales de la invitación', creado.branches.length === 2)
  check('la contraseña queda hasheada y es la elegida',
    !!creado.passwordHash && creado.passwordHash !== 'clave-larga-2' && await bcrypt.compare('clave-larga-2', creado.passwordHash))
  check('el correo viene de la invitación, no de quien acepta', creado.email === 'nuevo2@x.com')
  check('>>> el enlace es de UN SOLO USO',
    await code(aceptarInvitacion({ token: inv2.token, name: 'Otra Persona', password: 'clave-larga-3' })) === 'NOT_FOUND')
  check('queda auditado',
    (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'usuario.aceptar_invitacion', entityId: creado.id } })) === 1)

  const ctxNuevo = await resolveTenantContext(creado.id)
  check('>>> la sesión del usuario trae sus roles adicionales (TenantContext.roles)',
    ctxNuevo.roles?.join() === 'CAJERO')
  check('>>> y sus permisos son la UNIÓN de los dos roles',
    puede(ctxNuevo, 'caja.arqueo') && puede(ctxNuevo, 'ventas.cobrar') && puede(ctxNuevo, 'productos.ver_costo'))
  check('>>> y NO tiene lo que ninguno de sus roles da', !puede(ctxNuevo, 'usuarios.gestionar') && !puede(ctxNuevo, 'plan.gestionar'))
  check('el ADMIN que gestiona sucursales alcanza todas sin estar asignado a la Sur',
    (await resolveTenantContext(admin.id)).branchIds?.length === 2)

  console.log('\n6) Invitaciones inválidas')
  const inv3 = await invitar(dbOwner, cOwner, datos({ email: 'tarde@x.com' }))
  check('>>> una invitación caducada no sirve',
    await code(aceptarInvitacion({ token: inv3.token, name: 'Tarde', password: 'clave-larga-4' }, new Date(Date.now() + 8 * 86_400_000))) === 'NOT_FOUND')
  check('un token inventado no sirve',
    await code(aceptarInvitacion({ token: 'x'.repeat(43), name: 'Nadie', password: 'clave-larga-5' })) === 'NOT_FOUND')
  const yaRegistrado = await mk(tB.id, 'VENDEDOR', [], 'ya')
  await prisma.invitation.create({
    data: {
      tenantId: t.id, email: yaRegistrado.email, role: 'CAJERO', tokenHash: hashToken('tok-correo-ya-registrado-0123456789'),
      expiresAt: new Date(Date.now() + 86_400_000), invitedById: owner.id,
    },
  })
  check('>>> si el correo ya tiene cuenta en la plataforma, falla con el mismo mensaje genérico',
    await code(aceptarInvitacion({ token: 'tok-correo-ya-registrado-0123456789', name: 'Ya', password: 'clave-larga-6' })) === 'NOT_FOUND')
  await prisma.invitation.create({
    data: {
      tenantId: t.id, email: 'manipulada@x.com', role: 'OWNER', tokenHash: hashToken('tok-fila-manipulada-0123456789abcd'),
      expiresAt: new Date(Date.now() + 86_400_000), invitedById: owner.id,
    },
  })
  check('>>> una fila manipulada con rol OWNER NO crea un dueño',
    await code(aceptarInvitacion({ token: 'tok-fila-manipulada-0123456789abcd', name: 'Intruso', password: 'clave-larga-7' })) === 'NOT_FOUND' &&
    (await prisma.user.count({ where: { email: 'manipulada@x.com' } })) === 0)

  await prisma.invitation.create({
    data: {
      tenantId: t.id, email: 'carrera@x.com', role: 'VENDEDOR', tokenHash: hashToken('tok-carrera-0123456789abcdefghij'),
      expiresAt: new Date(Date.now() + 86_400_000), invitedById: owner.id,
    },
  })
  const resultados = await Promise.all([1, 2, 3].map((n) =>
    code(aceptarInvitacion({ token: 'tok-carrera-0123456789abcdefghij', name: `Persona ${n}`, password: `clave-larga-9${n}` }))))
  check('>>> tres clics simultáneos: exactamente UNO crea la cuenta',
    resultados.filter((r) => r === null).length === 1 && (await prisma.user.count({ where: { email: 'carrera@x.com' } })) === 1,
    JSON.stringify(resultados))

  console.log('\n7) Cambiar roles y desactivar')
  check('>>> ADMIN cambia el rol de un cajero a almacenero',
    await code(cambiarRoles(dbAdmin, cAdmin, cambiarRolesSchema.parse({ userId: cajero.id, role: 'ALMACENERO' }))) === null &&
    (await prisma.user.findUniqueOrThrow({ where: { id: cajero.id } })).role === 'ALMACENERO')
  check('el cambio queda auditado con antes y después',
    JSON.stringify((await prisma.auditLog.findFirst({ where: { tenantId: t.id, action: 'usuario.cambiar_roles', entityId: cajero.id } }))?.before).includes('CAJERO'))
  check('>>> ADMIN NO puede tocar al DUEÑO',
    await code(cambiarRoles(dbAdmin, cAdmin, cambiarRolesSchema.parse({ userId: owner.id, role: 'VENDEDOR' }))) === 'FORBIDDEN_ROLE')
  check('>>> ni desactivarlo',
    await code(cambiarEstado(dbAdmin, cAdmin, { userId: owner.id, activo: false })) === 'FORBIDDEN_ROLE' &&
    (await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).isActive)
  check('>>> nadie cambia su propio rol',
    await code(cambiarRoles(dbAdmin, cAdmin, cambiarRolesSchema.parse({ userId: admin.id, role: 'CONTADOR' }))) === 'FORBIDDEN_ROLE')
  check('>>> ni se desactiva a sí mismo',
    await code(cambiarEstado(dbOwner, cOwner, { userId: owner.id, activo: false })) === 'FORBIDDEN_ROLE')
  check('>>> el CAJERO no gestiona usuarios',
    await code(cambiarRoles(dbCajero, cCajero, cambiarRolesSchema.parse({ userId: admin.id, role: 'VENDEDOR' }))) === 'FORBIDDEN_ROLE')
  await cambiarEstado(dbAdmin, cAdmin, { userId: cajero.id, activo: false })
  const desact = await prisma.user.findUniqueOrThrow({ where: { id: cajero.id } })
  check('>>> desactivar marca inactivo e INVALIDA las sesiones abiertas (passwordChangedAt)',
    !desact.isActive && desact.passwordChangedAt !== null)
  check('un usuario desactivado ya no obtiene contexto',
    await resolveTenantContext(cajero.id).then(() => false).catch(() => true))
  await cambiarEstado(dbAdmin, cAdmin, { userId: cajero.id, activo: true })
  check('reactivar lo devuelve', (await prisma.user.findUniqueOrThrow({ where: { id: cajero.id } })).isActive)

  console.log('\n8) >>> Aislamiento entre negocios')
  check('el ADMIN de otro negocio no ve al usuario ajeno',
    await code(cambiarRoles(dbAdminB, cAdminB, cambiarRolesSchema.parse({ userId: cajero.id, role: 'VENDEDOR' }))) === 'NOT_FOUND')
  check('ni cancela invitaciones ajenas',
    await code(revocarInvitacion(dbAdminB, cAdminB, inv3.id)) === 'NOT_FOUND')
  const equipoB = await listarEquipo(dbAdminB, cAdminB)
  const idsB = new Set((await prisma.user.findMany({ where: { tenantId: tB.id }, select: { id: true } })).map((u) => u.id))
  check('>>> el listado de B trae SOLO a los usuarios de B y ninguna invitación de A',
    equipoB.miembros.length === idsB.size && equipoB.miembros.every((m) => idsB.has(m.id)) && equipoB.invitaciones.length === 0)

  console.log('\n9) El listado no filtra secretos')
  const equipo = await listarEquipo(dbAdmin, cAdmin)
  const plano = JSON.stringify(equipo)
  check('>>> ni hashes de contraseña ni de token',
    !plano.includes('passwordHash') && !plano.includes('tokenHash') && !plano.includes('$2'))
  check('el listado indica a quién puede gestionar',
    equipo.miembros.find((m) => m.id === owner.id)?.gestionable === false &&
    equipo.miembros.find((m) => m.id === cajero.id)?.gestionable === true)
  check('un CAJERO no puede ni listar el equipo',
    await code(listarEquipo(dbCajero, cCajero)) === 'FORBIDDEN_ROLE')

  console.log('\n10) >>> Contraseñas: quién puede poner la de quién (reglas puras)')
  const objetivoDe = (id: string, role: Role, extra: Role[] = []) => ({ id, role, extraRoles: extra })
  check('cualquiera puede cambiar la SUYA', TODOS.every((r) => puedeCambiarPassword(ctxDe(r), objetivoDe('u-actor', r))))
  check('>>> el DUEÑO puede cambiar la suya', puedeCambiarPassword(ctxDe('OWNER'), objetivoDe('u-actor', 'OWNER')))
  check('>>> NADIE más puede cambiar la clave del dueño',
    TODOS.every((r) => !puedeCambiarPassword(ctxDe(r), objetivoDe('u-otro', 'OWNER'))))
  check('>>> ni la de un SUPERADMIN', TODOS.every((r) => !puedeCambiarPassword(ctxDe(r), objetivoDe('u-otro', 'SUPERADMIN'))))
  check('un ADMIN puede cambiar la de un cajero', puedeCambiarPassword(ctxDe('ADMIN'), objetivoDe('u-otro', 'CAJERO')))
  check('>>> un ADMIN no puede cambiar la de quien tenga un rol extra de DUEÑO',
    !puedeCambiarPassword(ctxDe('ADMIN'), objetivoDe('u-otro', 'CAJERO', ['OWNER'])))
  check('un VENDEDOR no puede cambiar la de nadie más', !puedeCambiarPassword(ctxDe('VENDEDOR'), objetivoDe('u-otro', 'CAJERO')))

  console.log('\n11) Cambiar la contraseña')
  const NUEVA = 'clave-nueva-9876'
  const antesHash = (await prisma.user.findUniqueOrThrow({ where: { id: cajero.id } })).passwordHash
  const t0 = new Date()
  await cambiarPasswordUsuario(dbAdmin, cAdmin, { userId: cajero.id, password: NUEVA })
  const trasCambio = await prisma.user.findUniqueOrThrow({ where: { id: cajero.id } })
  check('>>> la guarda con bcrypt (no en claro) y es la elegida',
    !!trasCambio.passwordHash && trasCambio.passwordHash !== NUEVA && trasCambio.passwordHash !== antesHash &&
    await bcrypt.compare(NUEVA, trasCambio.passwordHash))
  check('fija passwordChangedAt', trasCambio.passwordChangedAt !== null && trasCambio.passwordChangedAt.getTime() >= t0.getTime() - 1000)
  const emitidaAntes = Math.floor((t0.getTime() - 60_000) / 1000)
  check('>>> una sesión abierta ANTES del cambio deja de valer',
    await code(resolveTenantContext(cajero.id, new Date(), emitidaAntes)) === 'UNAUTHENTICATED')
  check('y una iniciada DESPUÉS sí', (await resolveTenantContext(cajero.id, new Date(), Math.floor(Date.now() / 1000) + 5)).userId === cajero.id)
  const audPw = await prisma.auditLog.findFirst({ where: { tenantId: t.id, action: 'usuario.cambiar_password', entityId: cajero.id } })
  check('>>> queda auditado SIN la contraseña', !!audPw && !JSON.stringify(audPw).includes(NUEVA) && audPw.actorId === admin.id)

  console.log('\n12) Quién NO puede')
  check('>>> el ADMIN no puede cambiar la clave del DUEÑO',
    await code(cambiarPasswordUsuario(dbAdmin, cAdmin, { userId: owner.id, password: NUEVA })) === 'FORBIDDEN_ROLE')
  check('y la del dueño no cambió', !(await bcrypt.compare(NUEVA, (await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).passwordHash ?? '')))
  check('>>> el DUEÑO sí puede cambiar la suya', await code(cambiarPasswordUsuario(dbOwner, cOwner, { userId: owner.id, password: NUEVA + 'x' })) === null)
  check('el DUEÑO también puede cambiar la de un cajero', await code(cambiarPasswordUsuario(dbOwner, cOwner, { userId: cajero.id, password: NUEVA + 'y' })) === null)
  check('>>> el CAJERO no puede cambiar ninguna (no gestiona usuarios)',
    await code(cambiarPasswordUsuario(dbCajero, cCajero, { userId: cajero.id, password: NUEVA })) === 'FORBIDDEN_ROLE')
  check('>>> otro negocio no ve al usuario', await code(cambiarPasswordUsuario(dbAdminB, cAdminB, { userId: cajero.id, password: NUEVA })) === 'NOT_FOUND')
  check('una contraseña débil se rechaza en el esquema', !cambiarPasswordSchema.safeParse({ userId: 'x', password: 'corta' }).success && !cambiarPasswordSchema.safeParse({ userId: 'x', password: '         ' }).success)

  console.log('\n13) Alta directa con contraseña')
  const dir = (o: Record<string, unknown>) => crearDirectoSchema.parse({ name: 'Pedro Directo', email: 'directo@x.com', password: 'clave-directa-1', role: 'CAJERO', ...o })
  const nuevoDir = await crearUsuarioDirecto(dbAdmin, cAdmin, dir({ branchIds: [bN.id] }))
  const filaDir = await prisma.user.findUniqueOrThrow({ where: { id: nuevoDir.userId }, include: { branches: true } })
  check('>>> crea la cuenta lista para entrar, con el rol y la sucursal', filaDir.role === 'CAJERO' && filaDir.tenantId === t.id && filaDir.branches.length === 1 && filaDir.isActive)
  check('con la contraseña hasheada y verificable', await bcrypt.compare('clave-directa-1', filaDir.passwordHash ?? ''))
  check('>>> y sin dejar la contraseña en la auditoría',
    !JSON.stringify(await prisma.auditLog.findMany({ where: { tenantId: t.id, action: 'usuario.crear_directo' } })).includes('clave-directa-1'))
  check('puede iniciar sesión: obtiene contexto', (await resolveTenantContext(nuevoDir.userId)).role === 'CAJERO')
  check('>>> un correo ya usado se rechaza con mensaje neutro', await code(crearUsuarioDirecto(dbAdmin, cAdmin, dir({}))) === 'DUPLICATE_CODE')
  check('>>> el ADMIN no puede crear un DUEÑO (saltándose Zod)', await code(crearUsuarioDirecto(dbAdmin, cAdmin, { ...dir({ email: 'o@x.com' }), role: 'OWNER' } as never)) === 'FORBIDDEN_ROLE')
  check('ni con el rol extra', await code(crearUsuarioDirecto(dbAdmin, cAdmin, { ...dir({ email: 'o2@x.com' }), extraRoles: ['OWNER'] } as never)) === 'FORBIDDEN_ROLE')
  check('>>> el CAJERO no puede crear usuarios', await code(crearUsuarioDirecto(dbCajero, cCajero, dir({ email: 'o3@x.com' }))) === 'FORBIDDEN_ROLE')
  check('>>> una sucursal ajena se rechaza', await code(crearUsuarioDirecto(dbAdmin, cAdmin, dir({ email: 'o4@x.com', branchIds: [bB.id] }))) === 'TENANT_MISMATCH')
  check('una invitación viva a ese correo se anula al crearlo directamente', await (async () => {
    await invitar(dbAdmin, cAdmin, invitarSchema.parse({ email: 'conflicto@x.com', role: 'CAJERO' }))
    await crearUsuarioDirecto(dbAdmin, cAdmin, dir({ email: 'conflicto@x.com' }))
    return (await prisma.invitation.count({ where: { tenantId: t.id, email: 'conflicto@x.com', revokedAt: null, acceptedAt: null } })) === 0
  })())
  await prisma.plan.update({ where: { id: planTest.id }, data: { maxUsers: 1 } })
  check('>>> con el cupo lleno no se puede crear otro', await code(crearUsuarioDirecto(dbAdmin, cAdmin, dir({ email: 'cupo@x.com' }))) === 'PLAN_LIMIT_REACHED')

  await prisma.tenant.deleteMany({ where: { id: { in: [t.id, tB.id] } } })
  await prisma.plan.delete({ where: { id: planTest.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
