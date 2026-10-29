import './guard'
import { correr } from './teardown'
import { crearSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { asegurarCajaPrincipal, cajasDeSucursal, crearCaja, darDeBajaCaja, listarCajas, renombrarCaja } from '../src/features/branches/cajas-service'
import { MAX_CAJAS_POR_SUCURSAL, crearCajaSchema } from '../src/features/branches/cajas-schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.8a · El servicio de cajas contra la base: permisos, el tope de 5 por sucursal (incluso con creaciones simultáneas), nombres, la baja (nunca la última, nunca con turno abierto),
 * el alcance por sucursal, el aislamiento entre negocios y la auditoría.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '').catch((e) => String(e.message ?? e))

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const mkTenant = (n: string) => prisma.tenant.create({ data: { slug: `cs-${randomUUID().slice(0, 8)}`, name: n, planId: plan.id } })
  const t = await mkTenant('Servicio de cajas')
  const ajeno = await mkTenant('Ajeno')
  const bA = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const bB = await crearSucursal(t.id, { code: 'SUR', name: 'Sur', seriesNumber: 2, isDefault: false, establishmentCode: '0001' })
  const bAj = await crearSucursal(ajeno.id, { code: 'AJ', seriesNumber: 1, isDefault: true })
  const mk = (role: Role) => prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role === 'CAJERO' ? 'María Cajera' : role, role } })
  const [owner, adm, caj, cont, alm] = await Promise.all([mk('OWNER'), mk('ADMIN'), mk('CAJERO'), mk('CONTADOR'), mk('ALMACENERO')])
  const ctx = (u: { id: string }, role: Role, branchIds: string[] | undefined, extra: Partial<TenantContext> = {}): TenantContext => ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branchIds?.[0] ?? bA.id, ...(branchIds ? { branchIds } : {}), ...extra })
  const cOwner = ctx(owner, 'OWNER', [bA.id, bB.id]), cAdmA = ctx(adm, 'ADMIN', [bA.id]), cCaj = ctx(caj, 'CAJERO', [bA.id]), cCont = ctx(cont, 'CONTADOR', [bA.id]), cAlm = ctx(alm, 'ALMACENERO', [bA.id])
  const db = (c: TenantContext) => getTenantPrisma(c)
  const vivas = (branchId: string) => prisma.cashRegister.count({ where: { branchId, deletedAt: null } })

  console.log('\n1) Permisos: caja.administrar')
  check('>>> cajero, contador y almacenero no administran cajas', (await Promise.all([cCaj, cCont, cAlm].map((c) => code(crearCaja(db(c), c, { branchId: bA.id, name: 'Caja 2' }))))).every((r) => r === 'FORBIDDEN_ROLE'))
  check('>>> ni la ven en la gestión', (await Promise.all([cCaj, cCont, cAlm].map((c) => code(listarCajas(db(c), c, bA.id))))).every((r) => r === 'FORBIDDEN_ROLE'))
  const [existente] = await prisma.cashRegister.findMany({ where: { branchId: bA.id }, take: 1 })
  check('>>> ni renombran ni dan de baja una caja (cajero, contador, almacenero)', (await Promise.all([cCaj, cCont, cAlm].flatMap((c) => [code(renombrarCaja(db(c), c, { registerId: existente?.id ?? 'x', name: 'Intrusa' })), code(darDeBajaCaja(db(c), c, { registerId: existente?.id ?? 'x' }))]))).every((r) => r === 'FORBIDDEN_ROLE'))
  check('>>> el administrador y el dueño sí', await code(crearCaja(db(cAdmA), cAdmA, { branchId: bA.id, name: 'Caja mostrador' })) === null && await code(crearCaja(db(cOwner), cOwner, { branchId: bB.id, name: 'Caja 1' })) === null)
  check('>>> sin cajas previas, nada impide que el cajero VEA las que hay para abrir su turno (sin permiso aparte)', (await cajasDeSucursal(db(cCaj), cCaj, bA.id)).some((c) => c.name === 'Caja mostrador'))

  console.log('\n2) Crear, renombrar y nombres')
  const [cajaA] = await prisma.cashRegister.findMany({ where: { branchId: bA.id, name: 'Caja mostrador' } })
  check('>>> nombres repetidos (sin distinguir mayúsculas) en la misma sucursal se rechazan', await code(crearCaja(db(cOwner), cOwner, { branchId: bA.id, name: 'CAJA MOSTRADOR' })) === 'DUPLICATE_CODE' && /ese nombre/.test(await msg(crearCaja(db(cOwner), cOwner, { branchId: bA.id, name: ' caja mostrador ' }))))
  check('>>> el mismo nombre en otra sucursal sí', await code(crearCaja(db(cOwner), cOwner, { branchId: bB.id, name: 'Caja mostrador' })) === null)
  check('>>> un nombre de 1 letra o de más de 30 se rechaza antes de la base', await code(crearCaja(db(cOwner), cOwner, { branchId: bA.id, name: 'A' })) === 'INVALID_DOCUMENT' && !crearCajaSchema.safeParse({ branchId: 'b', name: 'x'.repeat(31) }).success)
  await renombrarCaja(db(cOwner), cOwner, { registerId: cajaA!.id, name: 'Caja 1' })
  check('>>> se renombra; cambiar solo las mayúsculas de su propio nombre es válido (es la misma caja)', (await prisma.cashRegister.findUniqueOrThrow({ where: { id: cajaA!.id } })).name === 'Caja 1' && await code(renombrarCaja(db(cOwner), cOwner, { registerId: cajaA!.id, name: 'caja 1' })) === null)
  await renombrarCaja(db(cOwner), cOwner, { registerId: cajaA!.id, name: 'Caja 1' })
  await crearCaja(db(cOwner), cOwner, { branchId: bA.id, name: 'Caja 2' })
  const [cajaA2] = await prisma.cashRegister.findMany({ where: { branchId: bA.id, name: 'Caja 2' } })
  check('>>> renombrar a la de otra caja de la sucursal → duplicado', await code(renombrarCaja(db(cOwner), cOwner, { registerId: cajaA2!.id, name: 'CAJA 1' })) === 'DUPLICATE_CODE')
  check('>>> renombrar una caja que no existe, o sin cambios, es claro', await code(renombrarCaja(db(cOwner), cOwner, { registerId: 'no-existe', name: 'Zeta' })) === 'NOT_FOUND')

  console.log('\n3) El tope de 5 por sucursal')
  check('>>> hasta 5 cajas vivas', await vivas(bA.id) === 2)
  for (const n of ['Caja 3', 'Caja 4', 'Caja 5']) await crearCaja(db(cOwner), cOwner, { branchId: bA.id, name: n })
  check('>>> >>> la sexta se rechaza con un mensaje que dice el tope', await vivas(bA.id) === MAX_CAJAS_POR_SUCURSAL && /hasta 5 cajas/.test(await msg(crearCaja(db(cOwner), cOwner, { branchId: bA.id, name: 'Caja 6' }))))
  check('>>> el tope es por sucursal: otra sucursal sigue pudiendo crear', await code(crearCaja(db(cOwner), cOwner, { branchId: bB.id, name: 'Caja 3' })) === null)
  // Simultáneas: Sur tiene 3 (Caja 1, Caja mostrador, Caja 3). Ocho administradores crean a la vez: solo caben 2 más.
  const resultados = await Promise.all(Array.from({ length: 8 }, (_, i) => code(crearCaja(db(cOwner), cOwner, { branchId: bB.id, name: `Sim ${i}` }))))
  check('>>> >>> con 8 creaciones SIMULTÁNEAS en una sucursal con 3, entran exactamente 2 y la sucursal queda en 5', resultados.filter((r) => r === null).length === 2 && await vivas(bB.id) === 5, JSON.stringify([resultados.filter((r) => r === null).length, await vivas(bB.id)]))
  check('>>> dar de baja una libera un lugar del tope', await (async () => { const [c] = await prisma.cashRegister.findMany({ where: { branchId: bA.id, name: 'Caja 5' } }); await darDeBajaCaja(db(cOwner), cOwner, { registerId: c!.id }); return await code(crearCaja(db(cOwner), cOwner, { branchId: bA.id, name: 'Caja 6' })) === null })())

  console.log('\n4) Dar de baja')
  const bC = await crearSucursal(t.id, { code: 'ESTE', name: 'Este', seriesNumber: 3, isDefault: false, establishmentCode: '0002' })
  const cOwnerC = ctx(owner, 'OWNER', [bA.id, bB.id, bC.id])
  await crearCaja(db(cOwnerC), cOwnerC, { branchId: bC.id, name: 'Única' })
  const [unica] = await prisma.cashRegister.findMany({ where: { branchId: bC.id } })
  check('>>> >>> una sucursal nunca se queda sin cajas: no se da de baja la última', /al menos una caja/.test(await msg(darDeBajaCaja(db(cOwnerC), cOwnerC, { registerId: unica!.id }))) && await vivas(bC.id) === 1)
  await crearCaja(db(cOwnerC), cOwnerC, { branchId: bC.id, name: 'Segunda' })
  const [, segunda] = await prisma.cashRegister.findMany({ where: { branchId: bC.id }, orderBy: { createdAt: 'asc' } })
  const abierto = await prisma.cashSession.create({ data: { tenantId: t.id, branchId: bC.id, registerId: segunda!.id, openedById: caj.id, openingAmount: 100 } })
  check('>>> >>> una caja con turno ABIERTO no se da de baja, y el mensaje dice de quién es', /turno abierto \(de María Cajera\)/.test(await msg(darDeBajaCaja(db(cOwnerC), cOwnerC, { registerId: segunda!.id }))) && await vivas(bC.id) === 2)
  await prisma.cashSession.update({ where: { id: abierto.id }, data: { status: 'CERRADA', closedAt: new Date(), closedById: caj.id, countedAmount: 100, expectedAmount: 100, difference: 0 } })
  await darDeBajaCaja(db(cOwnerC), cOwnerC, { registerId: segunda!.id })
  const baja = await prisma.cashRegister.findUniqueOrThrow({ where: { id: segunda!.id } })
  check('>>> cerrado el turno, se da de baja (lógica: la fila y su historial siguen)', baja.deletedAt !== null && baja.isActive === false && (await prisma.cashSession.findUniqueOrThrow({ where: { id: abierto.id } })).registerId === segunda!.id)
  check('>>> una caja dada de baja ya no aparece para abrir turno ni se puede renombrar o volver a dar de baja', (await cajasDeSucursal(db(cOwnerC), cOwnerC, bC.id)).every((c) => c.id !== segunda!.id) && await code(renombrarCaja(db(cOwnerC), cOwnerC, { registerId: segunda!.id, name: 'Otra' })) === 'NOT_FOUND' && await code(darDeBajaCaja(db(cOwnerC), cOwnerC, { registerId: segunda!.id })) === 'NOT_FOUND')
  check('>>> y su nombre queda libre', await code(crearCaja(db(cOwnerC), cOwnerC, { branchId: bC.id, name: 'Segunda' })) === null)
  // Carrera: dar de baja las dos únicas cajas de una sucursal a la vez no puede dejarla sin ninguna.
  const bD = await crearSucursal(t.id, { code: 'OESTE', name: 'Oeste', seriesNumber: 4, isDefault: false, establishmentCode: '0003' })
  const cOwnerD = ctx(owner, 'OWNER', [bD.id])
  await crearCaja(db(cOwnerD), cOwnerD, { branchId: bD.id, name: 'Uno' }); await crearCaja(db(cOwnerD), cOwnerD, { branchId: bD.id, name: 'Dos' })
  const dos = await prisma.cashRegister.findMany({ where: { branchId: bD.id } })
  const bajas = await Promise.all(dos.map((c) => code(darDeBajaCaja(db(cOwnerD), cOwnerD, { registerId: c.id }))))
  check('>>> >>> dar de baja las DOS cajas de una sucursal a la vez: solo una se va, la otra se queda', bajas.filter((r) => r === null).length === 1 && await vivas(bD.id) === 1, JSON.stringify(bajas))

  console.log('\n5) Alcance por sucursal y aislamiento entre negocios')
  check('>>> un administrador de Norte no crea, ni lista, ni renombra, ni da de baja cajas de Sur', await code(crearCaja(db(cAdmA), cAdmA, { branchId: bB.id, name: 'Intrusa' })) === 'NOT_FOUND' && (await listarCajas(db(cAdmA), cAdmA, bB.id)).length === 0)
  const [deSur] = await prisma.cashRegister.findMany({ where: { branchId: bB.id } })
  check('>>> ni toca la caja de Sur por id', await code(renombrarCaja(db(cAdmA), cAdmA, { registerId: deSur!.id, name: 'Robada' })) === 'NOT_FOUND' && await code(darDeBajaCaja(db(cAdmA), cAdmA, { registerId: deSur!.id })) === 'NOT_FOUND')
  check('>>> una sucursal de otro negocio no existe para este', await code(crearCaja(db(cOwner), cOwner, { branchId: bAj.id, name: 'Ajena' })) === 'NOT_FOUND')
  const cajaAjena = await prisma.cashRegister.create({ data: { tenantId: ajeno.id, branchId: bAj.id, name: 'De otro' } })
  check('>>> ni una caja ajena se renombra o se da de baja', await code(renombrarCaja(db(cOwner), cOwner, { registerId: cajaAjena.id, name: 'Mía' })) === 'NOT_FOUND' && await code(darDeBajaCaja(db(cOwner), cOwner, { registerId: cajaAjena.id })) === 'NOT_FOUND')
  const dueno = ctx(owner, 'OWNER', undefined)
  check('>>> un contexto sin restricción de sucursales (dueño de todo) alcanza cualquiera de SU negocio', await code(crearCaja(db(dueno), dueno, { branchId: bB.id, name: 'Zeta' })) !== 'NOT_FOUND' || (await vivas(bB.id)) === 5)

  console.log('\n6) La caja principal de una sucursal nueva')
  const bN = await crearSucursal(t.id, { code: 'NUEVA', name: 'Nueva', seriesNumber: 11, isDefault: false, establishmentCode: '0010' })
  const id1 = await asegurarCajaPrincipal(db(cOwner), t.id, bN.id)
  const id2 = await asegurarCajaPrincipal(db(cOwner), t.id, bN.id)
  check('>>> se crea una «Caja principal» y repetirlo no crea otra', id1 === id2 && (await prisma.cashRegister.findMany({ where: { branchId: bN.id } })).map((c) => c.name).join() === 'Caja principal')
  const bN2 = await crearSucursal(t.id, { code: 'NUEVA2', name: 'Nueva 2', seriesNumber: 12, isDefault: false, establishmentCode: '0011' })
  await prisma.cashRegister.create({ data: { tenantId: t.id, branchId: bN2.id, name: 'Mía' } })
  check('>>> si la sucursal ya tiene una caja viva, no añade la principal', (await asegurarCajaPrincipal(db(cOwner), t.id, bN2.id)) !== '' && (await prisma.cashRegister.count({ where: { branchId: bN2.id } })) === 1)

  console.log('\n7) Auditoría')
  const aud = await prisma.auditLog.findMany({ where: { tenantId: t.id, entityType: 'CashRegister' } })
  check('>>> crear, renombrar y dar de baja quedan auditados con quién y qué', ['caja.creada', 'caja.renombrada', 'caja.baja'].every((a) => aud.some((x) => x.action === a && x.actorId)))
  check('>>> el renombre guarda el nombre anterior y el nuevo', aud.some((x) => x.action === 'caja.renombrada' && JSON.stringify(x.before) === JSON.stringify({ nombre: 'Caja mostrador' }) && JSON.stringify(x.after) === JSON.stringify({ nombre: 'Caja 1' })))
  const antesAud = await prisma.auditLog.count({ where: { tenantId: t.id, entityType: 'CashRegister' } })
  await code(crearCaja(db(cOwner), cOwner, { branchId: bA.id, name: 'Caja 1' })); await code(crearCaja(db(cAdmA), cAdmA, { branchId: bB.id, name: 'Intrusa' })); await code(darDeBajaCaja(db(cOwner), cOwner, { registerId: id1 }))
  check('>>> una operación rechazada (duplicado, fuera de alcance, última caja) no deja auditoría', (await prisma.auditLog.count({ where: { tenantId: t.id, entityType: 'CashRegister' } })) === antesAud)

  await prisma.tenant.delete({ where: { id: ajeno.id } })
  await prisma.tenant.delete({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

async function main() {
  try { return await cuerpo() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? e.message.slice(0, 200) : e}`, false); return 1 }
}
correr(main)
