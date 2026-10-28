import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { serieDeSucursal } from '../src/features/branches/series'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.1a · El esquema de las devoluciones: la migración es aditiva y usa los nombres reales de las tablas, la base rechaza lo imposible
 * (CHECK, índice parcial), y los modelos nuevos quedan aislados por negocio y por sucursal.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const falla = (p: Promise<unknown>) => p.then(() => false).catch(() => true)
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const NOMBRE = '20261114100000_devoluciones_venta'

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 300) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  console.log('\nA) La migración (sin base)')
  const dir = `prisma/migrations/${NOMBRE}`
  const sql = readFileSync(`${dir}/migration.sql`, 'utf8').replace(/--[^\n]*/g, '')
  check('>>> es posterior a todas las demás y trae su `down.sql`', readdirSync('prisma/migrations').filter((d) => d !== 'migration_lock.toml').sort().pop() === NOMBRE && existsSync(`${dir}/down.sql`))
  check('>>> ADITIVA: no borra tablas ni columnas, no cambia ni borra datos', !/DROP |DELETE |UPDATE |TRUNCATE |RENAME/i.test(sql.replace(/ON (DELETE|UPDATE) (CASCADE|RESTRICT|NO ACTION|SET NULL)/g, '')) && !/ALTER COLUMN/i.test(sql))
  check('>>> las columnas nuevas de tablas existentes llevan valor por defecto (no rompen filas anteriores)', /ALTER TABLE "cash_sessions" ADD COLUMN\s+"refundsCashTotal" DECIMAL\(14,2\) NOT NULL DEFAULT 0,\s+ADD COLUMN\s+"refundsOtherTotal" DECIMAL\(14,2\) NOT NULL DEFAULT 0/.test(sql))
  check('>>> usa los nombres REALES de las tablas (@@map), no los de los modelos', ['"sale_returns"', '"sale_return_items"', '"sale_return_refunds"', '"cash_sessions"', '"sales"'].every((n) => sql.includes(n)) && !/"SaleReturn"|"CashSession"|ALTER TABLE "Sale"/.test(sql))
  check('trae el índice parcial (una devolución completa por venta) y los cinco CHECK', sql.includes('"sale_returns_una_completa_por_venta"') && sql.includes('WHERE "isFull"') && ['sale_returns_importes_chk', 'sale_return_items_importes_chk', 'sale_return_refunds_forma_chk', 'cash_sessions_reembolsos_chk', 'sales_anulada_devuelta_chk'].every((c) => sql.includes(c)))
  check('el aviso previo al despliegue (comprobar ventas ANULADA/DEVUELTA) está en la cabecera de la migración', readFileSync(`${dir}/migration.sql`, 'utf8').includes('verificar-ventas-anuladas'))

  console.log('\nB) Lo que la base rechaza')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const montar = async (tag: string) => {
    const t = await prisma.tenant.create({ data: { slug: `rp-dve-${tag}-${randomUUID().slice(0, 6)}`, name: `Esquema ${tag}`, taxId: ruc(), planId: plan.id } })
    const b1 = await crearSucursalConAlmacen(t.id)
    const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`.toLowerCase(), name: 'Dueño', role: 'OWNER' } })
    await asignarSucursal(t.id, x.id, b1.branch.id)
    const venta = (b: typeof b1, n: string, status: 'COMPLETADA' | 'ANULADA' | 'DEVUELTA' = 'COMPLETADA', extra: Record<string, unknown> = {}) =>
      prisma.sale.create({ data: { tenantId: t.id, branchId: b.branch.id, warehouseId: b.warehouse.id, userId: x.id, number: n, documentType: 'NOTA_VENTA', status, subtotal: 84.75, taxTotal: 15.25, total: 100, completedAt: new Date(), ...extra } })
    return { t, b1, b2, x, venta }
  }
  const A = await montar('a'), B = await montar('b')
  const ok = (extra: Record<string, unknown> = {}) => ({ voidedAt: new Date(), voidReason: 'Error de digitación', ...extra })
  check('>>> una venta ANULADA o DEVUELTA sin fecha, sin motivo o con motivo en blanco → la base la rechaza', await falla(A.venta(A.b1, 'S-1', 'ANULADA')) && await falla(A.venta(A.b1, 'S-2', 'DEVUELTA', { voidedAt: new Date() })) && await falla(A.venta(A.b1, 'S-3', 'ANULADA', { voidedAt: new Date(), voidReason: '   ' })) && await falla(A.venta(A.b1, 'S-4', 'DEVUELTA', { voidReason: 'x' })))
  check('…con fecha y motivo se acepta; una COMPLETADA no necesita nada', !(await falla(A.venta(A.b1, 'S-5', 'ANULADA', ok()))) && !(await falla(A.venta(A.b1, 'S-6', 'DEVUELTA', ok()))) && !(await falla(A.venta(A.b1, 'S-7'))))
  const sv = await A.venta(A.b1, 'S-10', 'DEVUELTA', ok())
  const devolucion = (o: Record<string, unknown> = {}) => prisma.saleReturn.create({ data: { tenantId: A.t.id, saleId: sv.id, kind: 'DEVOLUCION', number: `D-${randomUUID().slice(0, 6)}`, reason: 'Motivo', isFull: true, userId: A.x.id, saleTotal: 100, paidNet: 100, idempotencyKey: randomUUID(), ...o } })
  check('>>> importes imposibles: pagado mayor que el total, negativos, motivo de 2 letras → rechazados', await falla(devolucion({ paidNet: 100.01 })) && await falla(devolucion({ saleTotal: -1, paidNet: 0 })) && await falla(devolucion({ reason: 'ab' })) && await falla(devolucion({ receivableVoidedAmount: 101 })))
  const d1 = await devolucion()
  check('>>> una sola devolución COMPLETA por venta (índice parcial): la segunda, aunque sea con otra clave, se rechaza', await falla(devolucion()))
  const s2 = await A.venta(A.b1, 'S-11', 'DEVUELTA', ok())
  check('…pero las parciales (isFull = false, F6.2) pueden ser varias', !(await falla(prisma.saleReturn.create({ data: { tenantId: A.t.id, saleId: s2.id, kind: 'DEVOLUCION', number: 'P-1', reason: 'Parcial 1', isFull: false, userId: A.x.id, saleTotal: 100, paidNet: 10, idempotencyKey: randomUUID() } }))) && !(await falla(prisma.saleReturn.create({ data: { tenantId: A.t.id, saleId: s2.id, kind: 'DEVOLUCION', number: 'P-2', reason: 'Parcial 2', isFull: false, userId: A.x.id, saleTotal: 100, paidNet: 10, idempotencyKey: randomUUID() } }))))
  check('el número y la clave de idempotencia son únicos por negocio', await falla(devolucion({ number: d1.number })) && await falla(devolucion({ idempotencyKey: d1.idempotencyKey })))
  const sesion = await prisma.cashSession.create({ data: { tenantId: A.t.id, branchId: A.b1.branch.id, openedById: A.x.id, openingAmount: 0 } })
  const reembolso = (o: Record<string, unknown>) => prisma.saleReturnRefund.create({ data: { tenantId: A.t.id, returnId: d1.id, amount: 10, ...o } as never })
  check('>>> CAJA solo con efectivo y con turno: sin turno, o con Yape, se rechaza', await falla(reembolso({ mode: 'CAJA', method: 'EFECTIVO' })) && await falla(reembolso({ mode: 'CAJA', method: 'YAPE', cashSessionId: sesion.id })) && !(await falla(reembolso({ mode: 'CAJA', method: 'EFECTIVO', cashSessionId: sesion.id }))))
  check('>>> EXTERNO exige un medio que no sea efectivo ni crédito; con turno anotado es válido', await falla(reembolso({ mode: 'EXTERNO' })) && await falla(reembolso({ mode: 'EXTERNO', method: 'EFECTIVO' })) && await falla(reembolso({ mode: 'EXTERNO', method: 'CREDITO' })) && !(await falla(reembolso({ mode: 'EXTERNO', method: 'YAPE' }))) && !(await falla(reembolso({ mode: 'EXTERNO', method: 'PLIN', cashSessionId: sesion.id }))))
  check('>>> SIN_SALIDA no lleva medio; importe cero o negativo se rechaza', await falla(reembolso({ mode: 'SIN_SALIDA', method: 'YAPE' })) && !(await falla(reembolso({ mode: 'SIN_SALIDA', reference: 'Vale' }))) && await falla(reembolso({ mode: 'EXTERNO', method: 'YAPE', amount: 0 })) && await falla(reembolso({ mode: 'EXTERNO', method: 'YAPE', amount: -5 })))
  const si = await A.venta(A.b1, 'S-12', 'COMPLETADA')
  const it = await prisma.saleItem.create({ data: { tenantId: A.t.id, saleId: si.id, productId: (await prisma.product.create({ data: { tenantId: A.t.id, sku: 'X', name: 'X', salePrice: 100 } })).id, nameSnapshot: 'X', skuSnapshot: 'X', quantity: 1, unitPrice: 100, lineTotal: 100 } })
  check('>>> líneas devueltas: cantidad cero o importe negativo se rechaza; la misma línea no se repite en una devolución', await falla(prisma.saleReturnItem.create({ data: { tenantId: A.t.id, returnId: d1.id, saleItemId: it.id, quantity: 0, amount: 1 } })) && await falla(prisma.saleReturnItem.create({ data: { tenantId: A.t.id, returnId: d1.id, saleItemId: it.id, quantity: 1, amount: -1 } })) && !(await falla(prisma.saleReturnItem.create({ data: { tenantId: A.t.id, returnId: d1.id, saleItemId: it.id, quantity: 1, amount: 100 } }))) && await falla(prisma.saleReturnItem.create({ data: { tenantId: A.t.id, returnId: d1.id, saleItemId: it.id, quantity: 1, amount: 100 } })))
  check('>>> el turno no acepta devoluciones negativas', await falla(prisma.cashSession.update({ where: { id: sesion.id }, data: { refundsCashTotal: -1 } })) && await falla(prisma.cashSession.update({ where: { id: sesion.id }, data: { refundsOtherTotal: -0.01 } })))
  check('>>> una línea de OTRO negocio no se puede enlazar (llave foránea compuesta con el negocio)', await falla(prisma.saleReturnItem.create({ data: { tenantId: B.t.id, returnId: d1.id, saleItemId: it.id, quantity: 1, amount: 1 } })))

  console.log('\nC) Aislamiento por negocio y por sucursal')
  const ctx = (N: typeof A, ids?: string[]): TenantContext => ({ tenantId: N.t.id, userId: N.x.id, role: 'OWNER', access: 'FULL', branchId: N.b1.branch.id, ...(ids ? { branchIds: ids } : {}), permisosExtra: [] })
  const dbA = getTenantPrisma(ctx(A, [A.b1.branch.id, A.b2.branch.id]))
  const sb2 = await A.venta(A.b2, 'S-20', 'DEVUELTA', ok())
  const rb2 = await prisma.saleReturn.create({ data: { tenantId: A.t.id, saleId: sb2.id, kind: 'ANULACION', number: 'D-B2', reason: 'En la sucursal 2', isFull: true, userId: A.x.id, saleTotal: 100, paidNet: 100, idempotencyKey: randomUUID() } })
  await prisma.saleReturnItem.create({ data: { tenantId: A.t.id, returnId: rb2.id, saleItemId: (await prisma.saleItem.create({ data: { tenantId: A.t.id, saleId: sb2.id, productId: it.productId, nameSnapshot: 'X', skuSnapshot: 'X', quantity: 1, unitPrice: 100, lineTotal: 100 } })).id, quantity: 1, amount: 100 } })
  await prisma.saleReturnRefund.create({ data: { tenantId: A.t.id, returnId: rb2.id, mode: 'EXTERNO', method: 'YAPE', amount: 100 } })
  check('>>> el negocio B no ve nada del A: ni devoluciones, ni líneas, ni reembolsos', await (async () => { const dbB = getTenantPrisma(ctx(B)); return (await dbB.saleReturn.count()) === 0 && (await dbB.saleReturnItem.count()) === 0 && (await dbB.saleReturnRefund.count()) === 0 })())
  check('>>> el cliente aislado no deja escribir en otro negocio (TenantIsolationError)', await falla(dbA.saleReturn.create({ data: { tenantId: B.t.id, saleId: sv.id, kind: 'DEVOLUCION', number: 'X', reason: 'xxx', userId: A.x.id, saleTotal: 1, paidNet: 1, idempotencyKey: randomUUID() } })))
  const dbA1 = getTenantPrisma(ctx(A, [A.b1.branch.id]))
  check('>>> acotado por sucursal: con la sucursal 1 solo se ven las devoluciones de ventas de la 1 (también sus líneas y reembolsos, por la ruta sale → devolución)', (await dbA1.saleReturn.findMany({ select: { number: true } })).every((r) => r.number !== 'D-B2') && (await dbA1.saleReturn.count()) === (await dbA.saleReturn.count()) - 1 && (await dbA1.saleReturnItem.count()) === (await dbA.saleReturnItem.count()) - 1 && (await dbA1.saleReturnRefund.count()) === (await dbA.saleReturnRefund.count()) - 1)
  check('y con la sucursal 2 solo la suya', (await getTenantPrisma(ctx(A, [A.b2.branch.id])).saleReturn.count()) === 1)

  console.log('\nD) Contador, esquema y script')
  check("el contador de devoluciones sale de la serie de la sucursal: prefijo «D» y la serie «001» / «002»", JSON.stringify(serieDeSucursal('RETURN', 1)) === '{"series":"001","prefix":"D"}' && serieDeSucursal('RETURN', 2).series === '002')
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  check('el esquema declara los tres modelos con `@@map` y la unicidad por negocio de la línea de venta', ['@@map("sale_returns")', '@@map("sale_return_items")', '@@map("sale_return_refunds")'].every((m) => schema.includes(m)) && /model SaleItem \{[\s\S]*?@@unique\(\[tenantId, id\]\)[\s\S]*?@@map\("sale_items"\)/.test(schema))
  const r = spawnSync('npx', ['tsx', 'scripts/verificar-ventas-anuladas.ts'], { env: { ...process.env }, encoding: 'utf8', timeout: 120_000 })
  check('>>> el script de verificación previa (solo lectura) responde 0 cuando ninguna venta rompe el CHECK', r.status === 0 && r.stdout.includes('SOLO LECTURA') && r.stdout.includes('se puede aplicar'), `${r.status} ${r.stderr.slice(0, 120)}`)
  const script = readFileSync('scripts/verificar-ventas-anuladas.ts', 'utf8')
  check('…y no escribe nada (sin create/update/delete)', !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany|\$executeRaw)/.test(script + readFileSync('src/features/devoluciones/verificacion.ts', 'utf8')) && script.includes('process.exitCode = 3'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
