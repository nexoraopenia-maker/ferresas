import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { closeCashSession, openCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { auditarVueltos, evaluarVenta, formatearInformeVueltos, type VentaHistorica } from '../src/features/pos/vueltos-historicos'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * El script de auditoría histórica es de SOLO LECTURA y mide bien el bug del vuelto (Fase 3, Paso 1). Se simula la data
 * antigua corrompiendo a mano los pagos de ventas hechas con el código nuevo.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')

const venta = (total: number, pagos: [string, number, number][]): VentaHistorica => ({
  id: 'v', number: 'V-1', fecha: new Date(), total, cashSessionId: 's', pagos: pagos.map(([method, amount, change]) => ({ method, amount, change })),
})

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `vh-${tag}-${randomUUID().slice(0, 6)}`, name: `Vueltos ${tag}`, planId: plan.id } })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'o', role: 'OWNER' } })
  await asignarSucursal(t.id, u.id, branch.id)
  const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
  const db = getTenantPrisma(ctx)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Producto', salePrice: 100 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: w.id, quantity: 1000 } })
  const vender = (payments: { method: string; amount: number }[]) =>
    registerSale(db, ctx, registerSaleSchema.parse({ warehouseId: w.id, items: [{ productId: prod.id, quantity: 1 }], payments, idempotencyKey: randomUUID() }))
  return { t, db, ctx, vender }
}

async function main() {
  console.log('\n1) Clasificación de una venta (lógica pura)')
  check('bien guardado: efectivo con vuelto correcto → sin hallazgo', evaluarVenta(venta(100, [['EFECTIVO', 120, 20]])) === null)
  check('bien guardado: pago exacto con Yape → sin hallazgo', evaluarVenta(venta(100, [['YAPE', 100, 0]])) === null)
  const perdido = evaluarVenta(venta(100, [['YAPE', 50, 0], ['EFECTIVO', 60, 0]]))
  check('>>> [Yape 50 + efectivo 60] sin vuelto: PERDIDO por 10 (el bug)', perdido?.categoria === 'PERDIDO' && perdido.faltante === 10 && perdido.vueltoCorrecto === 10)
  check('>>> vuelto de más → EXCESO (faltante negativo)', evaluarVenta(venta(100, [['EFECTIVO', 100, 5]]))?.faltante === -5 && evaluarVenta(venta(100, [['EFECTIVO', 100, 5]]))?.categoria === 'EXCESO')
  check('>>> sobrepago con Yape (no hay efectivo que devolver) → SIN_EFECTIVO, a revisar a mano', evaluarVenta(venta(100, [['YAPE', 120, 0]]))?.categoria === 'SIN_EFECTIVO')
  check('el ruido de flotantes no inventa hallazgos (0.1 + 0.2)', evaluarVenta(venta(0.3, [['EFECTIVO', 0.1, 0], ['EFECTIVO', 0.2, 0]])) === null)

  console.log('\n2) Contra la base: turnos, categorías y aislamiento')
  const A = await negocio('a')
  const B = await negocio('b')
  const caja = await openCashSession(A.db, A.ctx, openCashSchema.parse({ openingAmount: 100 }))
  const vA = await A.vender([{ method: 'YAPE', amount: 50 }, { method: 'EFECTIVO', amount: 60 }])   // con el código nuevo: vuelto 10 bien guardado
  const vOk = await A.vender([{ method: 'EFECTIVO', amount: 100 }])
  const vYape = await A.vender([{ method: 'YAPE', amount: 100 }])
  // Se simula la DATA ANTIGUA: el vuelto perdido y un sobrepago con Yape.
  await prisma.payment.updateMany({ where: { saleId: vA.saleId }, data: { change: 0 } })
  await prisma.payment.updateMany({ where: { saleId: vYape.saleId }, data: { amount: 120 } })
  // El cajero cuenta lo REAL (150 + 100 = 250 billetes); el sistema esperaba 260 por el vuelto perdido: faltante falso de 10.
  await closeCashSession(A.db, A.ctx, closeCashSchema.parse({ sessionId: caja.id, countedAmount: 250 }))
  const cerrada = await prisma.cashSession.findUniqueOrThrow({ where: { id: caja.id } })
  check('(preparación) el cierre histórico quedó con un faltante falso de 10', num(cerrada.expectedAmount) === 260 && num(cerrada.difference) === -10, `${cerrada.expectedAmount} / ${cerrada.difference}`)
  // Y una venta ajena en el otro negocio, también «corrupta»: no debe aparecer en el informe de A.
  const bCaja = await openCashSession(B.db, B.ctx, openCashSchema.parse({ openingAmount: 0 }))
  void bCaja
  const vB = await B.vender([{ method: 'YAPE', amount: 50 }, { method: 'EFECTIVO', amount: 60 }])
  await prisma.payment.updateMany({ where: { saleId: vB.saleId }, data: { change: 0 } })

  const antes = await prisma.payment.findMany({ where: { tenantId: { in: [A.t.id, B.t.id] } }, orderBy: { id: 'asc' }, select: { id: true, method: true, amount: true, change: true, createdAt: true } })
  const nSales = await prisma.sale.count({ where: { tenantId: { in: [A.t.id, B.t.id] } } })
  const informe = await auditarVueltos(A.db)
  check('>>> revisó las 3 ventas del negocio (y ninguna del otro)', informe.ventasRevisadas === 3)
  check('>>> encontró exactamente 2: el vuelto PERDIDO y el sobrepago SIN_EFECTIVO; la venta bien guardada no sale',
    informe.hallazgos.length === 2 && informe.hallazgos.some((h) => h.saleId === vA.saleId && h.categoria === 'PERDIDO' && h.faltante === 10)
    && informe.hallazgos.some((h) => h.saleId === vYape.saleId && h.categoria === 'SIN_EFECTIVO') && !informe.hallazgos.some((h) => h.saleId === vOk.saleId))
  check('>>> aislamiento: la venta defectuosa del OTRO negocio no aparece', !informe.hallazgos.some((h) => h.saleId === vB.saleId))
  const turno = informe.turnos[0]
  check('>>> el turno cerrado: diferencia registrada −10 → corregida 0 (el faltante era falso); el sobrepago sin efectivo no entra en la corrección',
    informe.turnos.length === 1 && turno?.cashSessionId === caja.id && turno.diferenciaRegistrada === -10 && turno.faltante === 10 && turno.diferenciaCorregida === 0 && turno.ventas === 2, JSON.stringify(turno))
  const salida = formatearInformeVueltos('negocio-a', informe, true)
  check('el informe es legible: dice PERDIDO, el turno y la diferencia corregida', salida.includes('PERDIDO') && salida.includes('SIN_EFECTIVO') && salida.includes('diferencia registrada S/ -10.00 → corregida S/ 0.00') && salida.includes(vA.number))
  const informeB = await auditarVueltos(B.db)
  check('el otro negocio ve SOLO lo suyo', informeB.hallazgos.length === 1 && informeB.hallazgos[0]!.saleId === vB.saleId)
  check('(la foto previa tiene datos: 6 pagos entre los dos negocios)', Array.isArray(antes) && antes.length === 6, String(antes?.length))
  check('>>> SOLO LECTURA: después de auditar, pagos y ventas están exactamente igual (nada se corrigió)',
    JSON.stringify(antes) === JSON.stringify(await prisma.payment.findMany({ where: { tenantId: { in: [A.t.id, B.t.id] } }, orderBy: { id: 'asc' }, select: { id: true, method: true, amount: true, change: true, createdAt: true } }))
    && nSales === (await prisma.sale.count({ where: { tenantId: { in: [A.t.id, B.t.id] } } })))
  const cerradaDespues = await prisma.cashSession.findUniqueOrThrow({ where: { id: caja.id } })
  check('>>> y el cierre de caja histórico NO se tocó', num(cerradaDespues.difference) === -10 && num(cerradaDespues.expectedAmount) === 260)

  console.log('\n3) El script real')
  const r = spawnSync('npx', ['tsx', 'scripts/listar-vueltos-historicos.ts', '--negocio', A.t.slug], { encoding: 'utf8', timeout: 120000 })
  check('>>> el script imprime el hallazgo, declara «SOLO LECTURA» y sale con código 3 (hay ventas afectadas)', r.status === 3 && r.stdout.includes('PERDIDO') && r.stdout.includes('SOLO LECTURA (no se escribió nada)'), `status=${r.status} ${r.stderr.slice(-200)}`)
  const limpio = spawnSync('npx', ['tsx', 'scripts/listar-vueltos-historicos.ts', '--negocio', A.t.slug, '--desde', '2999-01-01'], { encoding: 'utf8', timeout: 120000 })
  check('con un filtro que no deja ventas, sale con 0', limpio.status === 0 && limpio.stdout.includes('0 con el vuelto mal guardado'), `status=${limpio.status}`)
  const mala = spawnSync('npx', ['tsx', 'scripts/listar-vueltos-historicos.ts', '--desde', 'ayer'], { encoding: 'utf8', timeout: 120000 })
  check('una fecha mala se rechaza con un mensaje, sin tocar nada', mala.status === 1 && mala.stderr.includes('AAAA-MM-DD'))

  console.log('\n4) Estructura: ni el módulo ni el script escriben')
  const codigo = ['src/features/pos/vueltos-historicos.ts', 'scripts/listar-vueltos-historicos.ts'].map((f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).join('\n')
  check('>>> no hay create/update/upsert/delete ni SQL crudo; tampoco pide permiso de escritura', !/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$execute|\$queryRaw|assertWritableEnvironment/.test(codigo))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
