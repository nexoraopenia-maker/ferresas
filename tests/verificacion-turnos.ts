import './guard'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { correr } from './teardown'
import { cajaDe, crearSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { usuariosConVariosTurnosAbiertos } from '../src/features/branches/verificacion-turnos'

/**
 * F6.8a · El script de verificación previo al paso 1: `verificar-turnos-abiertos`. Solo lectura, con su código de salida (0 = se puede seguir, 3 = no) y el detalle de quién y dónde. (F6.8d retiró
 * `verificar-turnos-sin-caja`: con `registerId` obligatorio ya no puede haber turnos sin caja.)
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }

const correrScript = (nombre: string) => spawnSync('npx', ['tsx', `scripts/${nombre}.ts`], { env: { ...process.env }, encoding: 'utf8', timeout: 120_000 })

async function cuerpo() {
  console.log('\nA) La lógica, con turnos simulados (la base real ya no deja crear dos abiertos de una persona)')
  const abierto = (id: string, tenantId: string, userId: string, branchId: string, nombre: string, dia: number) => ({ id, tenantId, branchId, openedById: userId, openedAt: new Date(Date.UTC(2026, 9, dia)), openedBy: { name: nombre }, status: 'ABIERTA' })
  const lector = (filas: ReturnType<typeof abierto>[]) => ({ cashSession: { findMany: async () => filas } }) as never
  const dos = await usuariosConVariosTurnosAbiertos(lector([abierto('t1', 'N1', 'u1', 'bA', 'María', 1), abierto('t2', 'N1', 'u1', 'bB', 'María', 2), abierto('t3', 'N1', 'u2', 'bA', 'José', 3)]))
  check('>>> encuentra a la persona con dos turnos abiertos y dice dónde y desde cuándo', dos.length === 1 && dos[0]!.nombre === 'María' && dos[0]!.turnos.map((x) => x.branchId).join() === 'bA,bB' && dos[0]!.turnos[0]!.abiertoEn.toISOString().startsWith('2026-10-01'))
  check('>>> quien tiene un solo turno no aparece', !dos.some((x) => x.userId === 'u2'))
  check('>>> la misma persona en DOS negocios distintos no se confunde (son cuentas distintas)', (await usuariosConVariosTurnosAbiertos(lector([abierto('t1', 'N1', 'u1', 'bA', 'X', 1), abierto('t2', 'N2', 'u1', 'bB', 'X', 2)]))).length === 0)
  check('>>> sin turnos abiertos no hay nada que reportar', (await usuariosConVariosTurnosAbiertos(lector([]))).length === 0)
  check('>>> tres turnos de una persona se cuentan juntos', (await usuariosConVariosTurnosAbiertos(lector([abierto('a', 'N', 'u', 'b1', 'Z', 1), abierto('b', 'N', 'u', 'b2', 'Z', 2), abierto('c', 'N', 'u', 'b3', 'Z', 3)])))[0]?.turnos.length === 3)

  console.log('\nB) Contra la base de pruebas')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `vt-${randomUUID().slice(0, 8)}`, name: 'Verificación de turnos', planId: plan.id } })
  const b = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const u = await prisma.user.create({ data: { tenantId: t.id, email: `u-${randomUUID()}@x.com`, name: 'Cajero', role: 'CAJERO' } })
  await prisma.cashSession.create({ data: { tenantId: t.id, branchId: b.id, registerId: await cajaDe(t.id, b.id), openedById: u.id, openingAmount: 10 } })
  const r0 = correrScript('verificar-turnos-abiertos')
  check('>>> >>> el script de «turnos abiertos» sale con código 0 cuando nadie tiene dos (el índice de la base ya lo impide)', r0.status === 0 && /SOLO LECTURA/.test(r0.stdout) && /nadie tiene más de uno/.test(r0.stdout), `${r0.status} ${r0.stdout.slice(0, 160)} ${r0.stderr.slice(0, 120)}`)

  console.log('\nC) Solo lectura')
  check('>>> el script de «sin caja» se retiró junto con la columna nula', !existsSync('scripts/verificar-turnos-sin-caja.ts') && !/turnosSinCaja/.test(readFileSync('src/features/branches/verificacion-turnos.ts', 'utf8')))
  for (const f of ['verificar-turnos-abiertos']) {
    const src = readFileSync(`scripts/${f}.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    check(`>>> ${f} no escribe nada (sin create/update/delete/upsert/raw)`, !/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(|\$executeRaw|\$queryRawUnsafe/.test(src))
  }
  const lib = readFileSync('src/features/branches/verificacion-turnos.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  check('>>> y la lógica que usan tampoco', !/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(|\$executeRaw/.test(lib))

  await prisma.tenant.delete({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

async function main() {
  try { return await cuerpo() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? e.message.slice(0, 200) : e}`, false); return 1 }
}
correr(main)
