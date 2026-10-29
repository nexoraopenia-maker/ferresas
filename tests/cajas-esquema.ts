import './guard'
import { readFileSync } from 'node:fs'
import { correr } from './teardown'
import { crearSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { openCashSession } from '../src/features/branches/cash-service'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.8a · La migración del paso 1 contra la base: el relleno (una «Caja principal» por sucursal, TODOS los turnos —cerrados y abiertos— quedan en ella, sin tocar nada más y sin duplicar
 * al repetirlo), los índices únicos parciales (por caja y por persona), las restricciones y que el código actual sigue abriendo turnos como siempre.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const rechaza = (p: Promise<unknown>) => p.then(() => false).catch(() => true)
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))

/** Las sentencias del relleno, tal cual están en la migración (entre los marcadores BACKFILL). */
function sentenciasDeRelleno(migracion = '20261123100000_cajas_registradoras'): string[] {
  const sql = readFileSync(`prisma/migrations/${migracion}/migration.sql`, 'utf8')
  const bloque = sql.slice(sql.indexOf('-- BACKFILL INICIO'), sql.indexOf('-- BACKFILL FIN'))
  return bloque.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)
}

/**
 * F6.8d: `registerId` ya es NOT NULL, y el relleno del paso 1 solo se puede ejercitar sobre filas SIN caja. Así que la columna se afloja mientras dura la sección 1 y se restaura al terminar (con el mismo
 * relleno, por si quedó alguna fila). Las pruebas corren una a una sobre esta base.
 */
const aflojar = () => prisma.$executeRawUnsafe('ALTER TABLE "cash_sessions" ALTER COLUMN "registerId" DROP NOT NULL')
async function restaurar() {
  for (const s of sentenciasDeRelleno()) await prisma.$executeRawUnsafe(s)
  await prisma.$executeRawUnsafe('ALTER TABLE "cash_sessions" ALTER COLUMN "registerId" SET NOT NULL')
}

async function main() {
  // F6.8d: el estado que deja la migración del paso 2, ANTES de aflojar nada.
  console.log('\n0) El esquema tras el paso 2 (F6.8d)')
  const unaFila = async <T,>(q: string): Promise<T> => (await prisma.$queryRawUnsafe<T[]>(q))[0]!
  check('>>> `registerId` es obligatorio (NOT NULL)', (await unaFila<{ is_nullable: string }>(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'cash_sessions' AND column_name = 'registerId'`)).is_nullable === 'NO')
  check('>>> el índice de los turnos sin caja ya no existe y el de «uno por caja» no tiene la condición sobrante', (await unaFila<{ n: number }>(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'cash_sessions_una_abierta_sin_caja'`)).n === 0 && !/IS NOT NULL/.test((await unaFila<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'cash_sessions_una_abierta_por_caja'`)).indexdef))
  check('>>> la columna heredada `cashRequired` ya no existe', (await unaFila<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'cashRequired'`)).n === 0)
  await aflojar()
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const mkTenant = (n: string) => prisma.tenant.create({ data: { slug: `cj-${randomUUID().slice(0, 8)}`, name: n, planId: plan.id } })
  const t = await mkTenant('Cajas')
  const ajeno = await mkTenant('Cajas ajeno')
  const bA = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const bB = await crearSucursal(t.id, { code: 'SUR', name: 'Sur', seriesNumber: 2, isDefault: false, establishmentCode: '0001' })
  const bC = await crearSucursal(t.id, { code: 'ESTE', name: 'Este', seriesNumber: 3, isDefault: false, establishmentCode: '0002' })
  const bAj = await crearSucursal(ajeno.id, { code: 'AJ', seriesNumber: 1, isDefault: true })
  const mk = (role: 'CAJERO' | 'OWNER' = 'CAJERO', tenantId = t.id) => prisma.user.create({ data: { tenantId, email: `u-${randomUUID()}@x.com`, name: 'Cajero', role } })
  const [u1, u2, u3, u4, uAj] = await Promise.all([mk(), mk(), mk(), mk(), mk('OWNER', ajeno.id)])
  const turno = async (branchId: string, openedById: string, extra: Record<string, unknown> = {}, tenantId = t.id) => {
    if (extra.registerId !== undefined) return prisma.cashSession.create({ data: { tenantId, branchId, openedById, openingAmount: 100, ...extra } as never })
    // Un turno SIN caja (solo para ejercitar el relleno, con la columna aflojada): Prisma ya no deja crearlo, así que se crea con una caja de paso y se le quita.
    const k = await prisma.cashRegister.create({ data: { tenantId, branchId, name: `paso-${randomUUID().slice(0, 8)}` } })
    const s = await prisma.cashSession.create({ data: { tenantId, branchId, registerId: k.id, openedById, openingAmount: 100, ...extra } as never })
    await prisma.$executeRaw`UPDATE cash_sessions SET "registerId" = NULL WHERE id = ${s.id}`
    await prisma.cashRegister.delete({ where: { id: k.id } })
    return s
  }
  const caja = (branchId: string, name: string, extra: Record<string, unknown> = {}, tenantId = t.id) => prisma.cashRegister.create({ data: { tenantId, branchId, name, ...extra } })

  console.log('\n1) El relleno de la migración')
  const cerradoA = await turno(bA.id, u1.id, { status: 'CERRADA', closedAt: new Date(), closedById: u1.id, countedAmount: 100, expectedAmount: 100, difference: 0 })
  const abiertoA = await turno(bA.id, u2.id)
  const cerradoB = await turno(bB.id, u3.id, { status: 'CERRADA', closedAt: new Date(), closedById: u3.id, countedAmount: 50, expectedAmount: 50, difference: 0 })
  const abiertoAj = await turno(bAj.id, uAj.id, {}, ajeno.id)
  const antesCerrado = await prisma.cashSession.findUniqueOrThrow({ where: { id: cerradoA.id } })
  // La sucursal Este no tiene turnos; la Sur ya tiene una caja propia creada a mano (no debe recibir otra «Caja principal»).
  const propiaB = await caja(bB.id, 'Caja del mostrador')
  const ejecutar = async () => { for (const s of sentenciasDeRelleno()) await prisma.$executeRawUnsafe(s) }
  check('>>> el relleno está en la migración como DOS sentencias (insertar cajas y asignar turnos)', sentenciasDeRelleno().length === 2 && /^INSERT INTO "cash_registers"/.test(sentenciasDeRelleno()[0]!) && /^UPDATE "cash_sessions"/.test(sentenciasDeRelleno()[1]!))
  await ejecutar()
  const cajasDe = (branchId: string) => prisma.cashRegister.findMany({ where: { branchId }, orderBy: { createdAt: 'asc' } })
  const cA = await cajasDe(bA.id), cB = await cajasDe(bB.id), cC = await cajasDe(bC.id), cAj = await cajasDe(bAj.id)
  check('>>> >>> cada sucursal SIN cajas recibe UNA «Caja principal», viva y activa', [cA, cC, cAj].every((c) => c.length === 1 && c[0]!.name === 'Caja principal' && c[0]!.isActive && c[0]!.deletedAt === null))
  check('>>> la sucursal que ya tenía una caja propia NO recibe otra', cB.length === 1 && cB[0]!.id === propiaB.id)
  const sesion = (id: string) => prisma.cashSession.findUniqueOrThrow({ where: { id } })
  check('>>> >>> los turnos CERRADOS y el ABIERTO de Norte quedan en la Caja principal de Norte', (await sesion(cerradoA.id)).registerId === cA[0]!.id && (await sesion(abiertoA.id)).registerId === cA[0]!.id)
  check('>>> el turno de Sur queda en la caja de Sur que ya existía', (await sesion(cerradoB.id)).registerId === propiaB.id)
  check('>>> el turno de OTRO negocio queda en una caja de SU negocio, nunca de este', (await sesion(abiertoAj.id)).registerId === cAj[0]!.id && cAj[0]!.tenantId === ajeno.id)
  const abiertoDespues = await sesion(abiertoA.id)
  check('>>> >>> el turno abierto sigue ABIERTO, del mismo cajero y con el mismo fondo (sigue operando)', abiertoDespues.status === 'ABIERTA' && abiertoDespues.openedById === u2.id && Number(abiertoDespues.openingAmount) === 100 && abiertoDespues.closedAt === null)
  const despuesCerrado = await sesion(cerradoA.id)
  check('>>> un turno cerrado conserva TODAS sus cifras y su fecha de actualización (no parece modificado)', Number(despuesCerrado.difference) === 0 && Number(despuesCerrado.countedAmount) === 100 && despuesCerrado.updatedAt.getTime() === antesCerrado.updatedAt.getTime() && despuesCerrado.closingBreakdown === null)
  await ejecutar(); await ejecutar()
  check('>>> >>> repetir el relleno NO duplica cajas ni cambia las asignaciones (idempotente)', (await cajasDe(bA.id)).length === 1 && (await cajasDe(bC.id)).length === 1 && (await cajasDe(bB.id)).length === 1 && (await sesion(abiertoA.id)).registerId === cA[0]!.id)
  check('>>> el id de la caja principal es determinista (la misma sucursal siempre el mismo id)', cA[0]!.id.startsWith('caja_') && cA[0]!.id.length === 37)
  // Una sucursal cuyas cajas están todas dadas de baja: el relleno solo asigna a una caja VIVA.
  const bD = await crearSucursal(t.id, { code: 'OESTE', name: 'Oeste', seriesNumber: 4, isDefault: false, establishmentCode: '0003' })
  const muerta = await caja(bD.id, 'Vieja', { isActive: false, deletedAt: new Date() })
  const viva = await caja(bD.id, 'Nueva')
  const tD = await turno(bD.id, (await mk()).id, { status: 'CERRADA', closedAt: new Date(), closedById: u1.id, countedAmount: 1, expectedAmount: 1, difference: 0 })
  await ejecutar()
  check('>>> con cajas vivas y muertas, el turno va a la VIVA más antigua (no a la dada de baja)', (await sesion(tD.id)).registerId === viva.id && muerta.id !== viva.id)

  // El paso 2 (F6.8d) repite el mismo relleno por si quedara algún turno sin caja: tiene que dejarlo en la caja viva más antigua de SU sucursal antes de exigir NOT NULL.
  const huerfano = await turno(bB.id, u4.id, { status: 'CERRADA', closedAt: new Date(), closedById: u4.id, countedAmount: 1, expectedAmount: 1, difference: 0 })
  check('>>> (preparación) el turno de prueba quedó SIN caja', (await sesion(huerfano.id)).registerId === null)
  const paso2 = sentenciasDeRelleno('20261124100000_cajas_obligatorias')
  check('>>> el paso 2 trae el mismo relleno defensivo (insertar cajas y asignar turnos)', paso2.length === 2 && /^INSERT INTO "cash_registers"/.test(paso2[0]!) && /^UPDATE "cash_sessions"/.test(paso2[1]!))
  for (const q of paso2) await prisma.$executeRawUnsafe(q)
  check('>>> y deja el turno sin caja en la caja viva más antigua de SU sucursal (no cruza sucursales ni negocios)', (await sesion(huerfano.id)).registerId === propiaB.id)
  await restaurar()

  console.log('\n2) Los índices únicos parciales')
  const bE = await crearSucursal(t.id, { code: 'NORTE2', name: 'Norte 2', seriesNumber: 5, isDefault: false, establishmentCode: '0004' })
  const [k1, k2] = [await caja(bE.id, 'Caja 1'), await caja(bE.id, 'Caja 2')]
  const [p1, p2, p3, p4] = await Promise.all([mk(), mk(), mk(), mk()])
  const t1 = await turno(bE.id, p1.id, { registerId: k1.id })
  check('>>> dos cajas de la MISMA sucursal pueden tener turno abierto a la vez (dos personas)', !(await rechaza(turno(bE.id, p2.id, { registerId: k2.id }))))
  check('>>> >>> la misma caja no puede tener dos turnos abiertos', await rechaza(turno(bE.id, p3.id, { registerId: k1.id })))
  check('>>> >>> una persona no puede tener dos turnos abiertos (ni en cajas distintas de la misma sucursal)', await rechaza(turno(bE.id, p1.id, { registerId: k2.id })))
  const bF = await crearSucursal(t.id, { code: 'OTRA', name: 'Otra', seriesNumber: 6, isDefault: false, establishmentCode: '0005' })
  const kF = await caja(bF.id, 'Caja F')
  check('>>> ni en OTRA sucursal (es por persona en toda la cuenta)', await rechaza(turno(bF.id, p1.id, { registerId: kF.id })))
  check('>>> otra persona sí puede abrir en la otra sucursal', !(await rechaza(turno(bF.id, p4.id, { registerId: kF.id }))))
  await prisma.cashSession.update({ where: { id: t1.id }, data: { status: 'CERRADA', closedAt: new Date(), closedById: p1.id, countedAmount: 1, expectedAmount: 1, difference: 0 } })
  check('>>> al cerrar el turno, la caja y la persona quedan libres', !(await rechaza(turno(bE.id, p3.id, { registerId: k1.id }))) && !(await rechaza(turno(bF.id, p1.id, { registerId: (await caja(bF.id, 'Caja G')).id }))))

  console.log('\n3) Restricciones')
  const k3 = await caja(bE.id, 'Caja 3')
  check('>>> la foto del desglose NO puede existir en un turno ABIERTO', await rechaza(turno(bE.id, (await mk()).id, { registerId: k3.id, closingBreakdown: { version: 1 } })))
  const cerr = await turno(bE.id, (await mk()).id, { registerId: k3.id, status: 'CERRADA', closedAt: new Date(), closedById: u1.id, countedAmount: 1, expectedAmount: 1, difference: 0, closingBreakdown: { version: 1 } })
  check('>>> en un turno CERRADO sí, y se lee igual', JSON.stringify((await sesion(cerr.id)).closingBreakdown) === JSON.stringify({ version: 1 }))
  check('>>> abrir un turno y ponerle la foto de golpe también se rechaza', await rechaza(prisma.cashSession.update({ where: { id: t1.id === cerr.id ? cerr.id : (await turno(bE.id, (await mk()).id, { registerId: (await caja(bE.id, 'Caja 4')).id })).id }, data: { closingBreakdown: { x: 1 } } })))
  const bI = await crearSucursal(t.id, { code: 'I', name: 'I', seriesNumber: 9, isDefault: false, establishmentCode: '0008' })
  await caja(bI.id, 'Mostrador')
  check('>>> el nombre de una caja es único SIN distinguir mayúsculas dentro de la sucursal', await rechaza(caja(bI.id, 'MOSTRADOR')) && await rechaza(caja(bI.id, 'mostrador')))
  check('>>> el mismo nombre en otra sucursal sí', !(await rechaza(caja(bA.id, 'Mostrador'))))
  const vieja = await caja(bI.id, 'Temporal')
  await prisma.cashRegister.update({ where: { id: vieja.id }, data: { isActive: false, deletedAt: new Date() } })
  check('>>> dar de baja una caja libera su nombre', !(await rechaza(caja(bI.id, 'Temporal'))))
  check('>>> un nombre de 1 letra o de más de 30 no entra ni por la puerta de atrás', await rechaza(caja(bI.id, 'A')) && await rechaza(caja(bI.id, 'x'.repeat(31))) && await rechaza(caja(bI.id, '   ')))
  check('>>> un turno no puede apuntar a una caja de OTRO negocio (clave compuesta)', await rechaza(turno(bI.id, (await mk()).id, { registerId: cAj[0]!.id })))
  check('>>> una caja con turnos no se puede borrar de verdad (la baja es lógica)', await rechaza(prisma.cashRegister.delete({ where: { id: k1.id } })))

  console.log('\n4) El código de hoy sigue funcionando sobre el esquema nuevo')
  const bJ = await crearSucursal(t.id, { code: 'J', name: 'J', seriesNumber: 10, isDefault: false, establishmentCode: '0009' })
  const cajero1 = await prisma.user.create({ data: { tenantId: t.id, email: `c1-${randomUUID()}@x.com`, name: 'C1', role: 'CAJERO' } })
  const cajero2 = await prisma.user.create({ data: { tenantId: t.id, email: `c2-${randomUUID()}@x.com`, name: 'C2', role: 'CAJERO' } })
  const ctx = (u: { id: string }): TenantContext => ({ tenantId: t.id, userId: u.id, role: 'CAJERO', access: 'FULL', branchId: bJ.id, branchIds: [bJ.id] })
  const abierto = await openCashSession(getTenantPrisma(ctx(cajero1)), ctx(cajero1), { openingAmount: 50 })
  check('>>> F6.8b: openCashSession abre el turno EN una caja (la única de la sucursal)', (await sesion(abierto.id)).status === 'ABIERTA' && (await sesion(abierto.id)).registerId !== null)
  check('>>> y un segundo cajero en la misma sucursal sigue recibiendo «esa caja ya tiene un turno» (el índice por caja)', await code(openCashSession(getTenantPrisma(ctx(cajero2)), ctx(cajero2), { openingAmount: 10 })) === 'DUPLICATE_CODE')

  await prisma.tenant.delete({ where: { id: ajeno.id } })
  await prisma.tenant.delete({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

async function seguro() {
  try { return await main() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? e.message.slice(0, 200) : e}`, false); await restaurar().catch(() => undefined); return 1 }
}
correr(seguro)
