import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readdirSync, existsSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.3a · Lo que la BASE garantiza por sí sola en los movimientos manuales de caja: importes, categorías por tipo, anulación completa, claves
 * compuestas entre negocios, idempotencia y aislamiento por negocio y sucursal.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const falla = (p: Promise<unknown>) => p.then(() => false).catch(() => true)
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 300) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const mk = async (tag: string) => {
    const t = await prisma.tenant.create({ data: { slug: `rp-cme-${tag}-${randomUUID().slice(0, 6)}`, name: `Movimientos ${tag}`, taxId: ruc(), planId: plan.id } })
    await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cme' } })
    const b1 = await crearSucursalConAlmacen(t.id)
    const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`.toLowerCase(), name: 'Dueño', role: 'OWNER' } })
    await asignarSucursal(t.id, u.id, b1.branch.id); await asignarSucursal(t.id, u.id, b2.branch.id)
    const s1 = await prisma.cashSession.create({ data: { tenantId: t.id, branchId: b1.branch.id, openedById: u.id, openingAmount: 100 } })
    // F6.8: una persona tiene como mucho UN turno abierto, así que el de la segunda sucursal es de otra persona.
    const u2 = await prisma.user.create({ data: { tenantId: t.id, email: `o2-${randomUUID()}@x.com`.toLowerCase(), name: 'Dueño 2', role: 'OWNER' } })
    const s2 = await prisma.cashSession.create({ data: { tenantId: t.id, branchId: b2.branch.id, openedById: u2.id, openingAmount: 100 } })
    const O: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: [] }
    return { t, b1, b2, u, s1, s2, O }
  }
  const A = await mk('a'), B = await mk('b')
  const mov = (o: Record<string, unknown> = {}) => prisma.cashMovement.create({ data: { tenantId: A.t.id, branchId: A.b1.branch.id, cashSessionId: A.s1.id, kind: 'EGRESO', category: 'GASTO_MENOR', amount: 25, description: 'Bolsas', userId: A.u.id, idempotencyKey: randomUUID(), ...o } as never })

  console.log('\nA) Importes y descripción')
  check('>>> un movimiento válido se guarda', !(await falla(mov())))
  check('>>> monto cero o negativo se rechaza', await falla(mov({ amount: 0 })) && await falla(mov({ amount: -1 })))
  check('>>> descripción vacía, en blanco o de 2 letras se rechaza', await falla(mov({ description: '' })) && await falla(mov({ description: '   ' })) && await falla(mov({ description: 'ab' })))
  check('>>> clave de idempotencia vacía o en blanco se rechaza', await falla(mov({ idempotencyKey: '' })) && await falla(mov({ idempotencyKey: '   ' })))
  const clave = randomUUID()
  await mov({ idempotencyKey: clave })
  check('>>> la MISMA clave dos veces en el mismo negocio la corta la base (idempotencia)', await falla(mov({ idempotencyKey: clave })))

  console.log('\nB) Categorías por tipo')
  check('>>> INGRESO: reposición, corrección y otro se aceptan', !(await falla(mov({ kind: 'INGRESO', category: 'REPOSICION_FONDO' }))) && !(await falla(mov({ kind: 'INGRESO', category: 'CORRECCION_ARQUEO' }))) && !(await falla(mov({ kind: 'INGRESO', category: 'OTRO' }))))
  check('>>> INGRESO como gasto menor o retiro del dueño se rechaza', await falla(mov({ kind: 'INGRESO', category: 'GASTO_MENOR' })) && await falla(mov({ kind: 'INGRESO', category: 'RETIRO_DUENO' })))
  check('>>> EGRESO: gasto, retiro, corrección y otro se aceptan', !(await falla(mov({ category: 'RETIRO_DUENO' }))) && !(await falla(mov({ category: 'CORRECCION_ARQUEO' }))) && !(await falla(mov({ category: 'OTRO' }))))
  check('>>> EGRESO como reposición del fondo se rechaza', await falla(mov({ kind: 'EGRESO', category: 'REPOSICION_FONDO' })))

  console.log('\nC) Anulación completa')
  const m = await mov()
  check('>>> anular sin motivo, sin quién o sin cuándo se rechaza (las tres cosas van juntas)', await falla(prisma.cashMovement.update({ where: { id: m.id }, data: { voidedAt: new Date() } })) && await falla(prisma.cashMovement.update({ where: { id: m.id }, data: { voidedAt: new Date(), voidedById: A.u.id } })) && await falla(prisma.cashMovement.update({ where: { id: m.id }, data: { voidedById: A.u.id, voidReason: 'Error de monto' } })))
  check('>>> un motivo de 2 letras se rechaza; con quién, cuándo y por qué se acepta', await falla(prisma.cashMovement.update({ where: { id: m.id }, data: { voidedAt: new Date(), voidedById: A.u.id, voidReason: 'ab' } })) && !(await falla(prisma.cashMovement.update({ where: { id: m.id }, data: { voidedAt: new Date(), voidedById: A.u.id, voidReason: 'Error de monto' } }))))
  check('>>> un movimiento no puede «corregir» su propio turno', await falla(mov({ relatedSessionId: A.s1.id })))

  console.log('\nD) Claves compuestas entre negocios')
  check('>>> el turno de OTRO negocio no se puede usar', await falla(mov({ cashSessionId: B.s1.id })))
  check('>>> la sucursal de OTRO negocio no se puede usar', await falla(mov({ branchId: B.b1.branch.id })))
  check('>>> lo que corrige tampoco puede ser de otro negocio (turno ni abono)', await falla(mov({ relatedSessionId: B.s1.id })))
  check('>>> un turno con movimientos no se puede borrar (RESTRICT)', await falla(prisma.cashSession.delete({ where: { id: A.s1.id } })))
  check('>>> la columna congelada del turno no admite negativos', await falla(prisma.cashSession.update({ where: { id: A.s1.id }, data: { manualInTotal: -1 } })) && await falla(prisma.cashSession.update({ where: { id: A.s1.id }, data: { manualOutTotal: -0.01 } })))

  console.log('\nE) Aislamiento por negocio y por sucursal (cliente aislado)')
  await prisma.cashMovement.create({ data: { tenantId: A.t.id, branchId: A.b2.branch.id, cashSessionId: A.s2.id, kind: 'INGRESO', category: 'OTRO', amount: 10, description: 'Sucursal 2', userId: A.u.id, idempotencyKey: randomUUID() } })
  await prisma.cashMovement.create({ data: { tenantId: B.t.id, branchId: B.b1.branch.id, cashSessionId: B.s1.id, kind: 'INGRESO', category: 'OTRO', amount: 10, description: 'Otro negocio', userId: B.u.id, idempotencyKey: randomUUID() } })
  const todos = await prisma.cashMovement.count({ where: { tenantId: A.t.id } }), de2 = await prisma.cashMovement.count({ where: { tenantId: A.t.id, branchId: A.b2.branch.id } })
  const soloB1: TenantContext = { ...A.O, branchIds: [A.b1.branch.id] }
  check('>>> el dueño con las dos sucursales ve todos los movimientos de su negocio; el de una sola NO ve los de la otra', (await getTenantPrisma(A.O).cashMovement.count()) === todos && (await getTenantPrisma(soloB1).cashMovement.count()) === todos - de2)
  check('>>> otro NEGOCIO no ve ninguno de A', (await getTenantPrisma({ ...B.O }).cashMovement.count({ where: { description: 'Sucursal 2' } })) === 0 && (await getTenantPrisma(B.O).cashMovement.count()) === 1)

  console.log('\nF) La migración')
  const dir = 'prisma/migrations/20261116100000_movimientos_caja'
  check('trae su `down.sql` y es posterior a la de la devolución parcial', existsSync(`${dir}/down.sql`) && readdirSync('prisma/migrations').filter((d) => d !== 'migration_lock.toml').sort().indexOf('20261116100000_movimientos_caja') > readdirSync('prisma/migrations').filter((d) => d !== 'migration_lock.toml').sort().indexOf('20261115100000_devolucion_parcial'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
