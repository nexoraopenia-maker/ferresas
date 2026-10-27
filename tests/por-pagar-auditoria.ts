import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { auditarCoherenciaPorPagar, auditarDatosPorPagar, formatearInformePorPagar, type CodigoHallazgoPorPagar, type DatosPorPagar } from '../src/features/por-pagar/auditoria'
import { anularPagoProveedor, registrarPagoProveedor } from '../src/features/por-pagar/pagos'
import { anularPagoSchema, registrarPagoSchema } from '../src/features/por-pagar/schemas'
import { anularCompra, crearBorrador, recibirCompra } from '../src/features/compras/service'
import { anularCompraSchema, crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { crearProveedor } from '../src/features/proveedores/service'
import { crearProveedorSchema } from '../src/features/proveedores/schemas'
import { closeCashSession, openCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 4, subpaso F4.4 (parte 3): auditoría de coherencia de compras y cuentas por pagar. SOLO LECTURA.
 * Lo que más importa: un negocio que opera con normalidad sale LIMPIO, y cada tipo de descuadre se detecta cuando se provoca.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

/** Un mundo mínimo y coherente, fabricado a mano: se rompe una cosa por vez. */
const limpio = (): DatosPorPagar => ({
  proveedores: [{ id: 's1', name: 'Prov 1', payableBalance: 60 }],
  cuentas: [
    { id: 'x1', supplierId: 's1', purchaseId: 'c1', amount: 100, paidAmount: 40, status: 'ABIERTA' },
    { id: 'x2', supplierId: 's1', purchaseId: 'c2', amount: 50, paidAmount: 50, status: 'PAGADA' },
    { id: 'x3', supplierId: 's1', purchaseId: 'c3', amount: 30, paidAmount: 0, status: 'ANULADA' },
  ],
  pagos: [
    { id: 'p1', supplierId: 's1', amount: 90, method: 'EFECTIVO', anulado: false, cashSessionId: 't1' },
    { id: 'p2', supplierId: 's1', amount: 15, method: 'YAPE', anulado: true, cashSessionId: 't1' },
  ],
  repartos: [
    { paymentId: 'p1', payableId: 'x1', amount: 40 }, { paymentId: 'p1', payableId: 'x2', amount: 50 },
    { paymentId: 'p2', payableId: 'x1', amount: 15 },
  ],
  compras: [
    { id: 'c1', number: 'C-1', status: 'RECIBIDA', supplierId: 's1', paymentCondition: 'CREDITO', total: 100, recibida: true },
    { id: 'c2', number: 'C-2', status: 'RECIBIDA', supplierId: 's1', paymentCondition: 'CREDITO', total: 50, recibida: true },
    { id: 'c3', number: 'C-3', status: 'ANULADA', supplierId: 's1', paymentCondition: 'CREDITO', total: 30, recibida: true },
    { id: 'c4', number: 'C-4', status: 'RECIBIDA', supplierId: null, paymentCondition: 'CONTADO', total: 20, recibida: true },
    { id: 'c5', number: 'C-5', status: 'BORRADOR', supplierId: null, paymentCondition: 'CONTADO', total: 5, recibida: false },
  ],
  lineas: [
    { purchaseId: 'c1', productId: 'a', quantity: 10 }, { purchaseId: 'c2', productId: 'a', quantity: 5 }, { purchaseId: 'c3', productId: 'b', quantity: 3 },
    { purchaseId: 'c4', productId: 'b', quantity: 2 }, { purchaseId: 'c5', productId: 'b', quantity: 9 },
  ],
  movimientos: [
    { purchaseId: 'c1', productId: 'a', type: 'ENTRADA', quantity: 10 }, { purchaseId: 'c2', productId: 'a', type: 'ENTRADA', quantity: 5 },
    { purchaseId: 'c3', productId: 'b', type: 'ENTRADA', quantity: 3 }, { purchaseId: 'c3', productId: 'b', type: 'DEVOLUCION_PROVEEDOR', quantity: -3 },
    { purchaseId: 'c4', productId: 'b', type: 'ENTRADA', quantity: 2 },
  ],
  turnosCerrados: [{ id: 't1', openingAmount: 500, expectedAmount: 410, cashTotal: 0, cashReceiptsTotal: 0, changeTotal: 0, supplierCashPaymentsTotal: 90, supplierOtherPaymentsTotal: 0 }],
})
const con = (f: (d: DatosPorPagar) => void): DatosPorPagar => { const d = limpio(); f(d); return d }
const codigos = (d: DatosPorPagar): CodigoHallazgoPorPagar[] => auditarDatosPorPagar(d).hallazgos.map((h) => h.codigo)
const detecta = (n: string, f: (d: DatosPorPagar) => void, esperado: CodigoHallazgoPorPagar) => {
  const c = codigos(con(f))
  check(`>>> ${n} → ${esperado}`, c.includes(esperado), c.join(','))
}

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `pa-${tag}-${randomUUID().slice(0, 6)}`, name: `Audit ${tag}`, taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_pa' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`.toLowerCase(), name: 'Dueño', role: 'OWNER' } })
  await asignarSucursal(t.id, u.id, b1.branch.id)
  const O: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER' as Role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  return { t, b1, O, db: getTenantPrisma(O) }
}

async function main() {
  console.log('\nA) Reglas con datos fabricados')
  check('>>> el mundo coherente de referencia sale LIMPIO (0 hallazgos)', auditarDatosPorPagar(limpio()).errores === 0, codigos(limpio()).join(','))
  detecta('la deuda guardada del proveedor no es la suma de sus cuentas abiertas', (d) => { d.proveedores[0]!.payableBalance = 65 }, 'DEUDA_PROVEEDOR')
  detecta('lo pagado de una cuenta no es la suma de sus repartos vigentes', (d) => { d.cuentas[0]!.paidAmount = 41; d.proveedores[0]!.payableBalance = 59 }, 'PAGADO_CUENTA')
  detecta('un reparto ANULADO contado como vigente', (d) => { d.pagos[1]!.anulado = false }, 'PAGADO_CUENTA')
  detecta('un pago cuyos repartos no suman su monto', (d) => { d.repartos.pop() }, 'REPARTO_PAGO')
  detecta('un pago que cae en la cuenta de OTRO proveedor', (d) => { d.cuentas[1]!.supplierId = 's2' }, 'REPARTO_PROVEEDOR')
  detecta('una cuenta de un proveedor distinto al de su compra', (d) => { d.compras[0]!.supplierId = 's2' }, 'CUENTA_COMPRA_PROVEEDOR')
  detecta('una cuenta con monto distinto al total de su compra', (d) => { d.compras[0]!.total = 101 }, 'CUENTA_COMPRA_MONTO')
  detecta('una compra a crédito recibida sin cuenta por pagar', (d) => { d.cuentas = d.cuentas.filter((x) => x.id !== 'x2'); d.repartos = d.repartos.filter((r) => r.payableId !== 'x2'); d.pagos[0]!.amount = 40; d.turnosCerrados[0]!.supplierCashPaymentsTotal = 40; d.turnosCerrados[0]!.expectedAmount = 460 }, 'COMPRA_CREDITO_SIN_CUENTA')
  detecta('una compra al CONTADO con cuenta por pagar', (d) => { d.compras[0]!.paymentCondition = 'CONTADO' }, 'COMPRA_CONTADO_CON_CUENTA')
  detecta('compra ANULADA con la cuenta todavía viva', (d) => { d.compras[1]!.status = 'ANULADA' }, 'CUENTA_ESTADO_COMPRA')
  detecta('compra RECIBIDA con la cuenta ANULADA', (d) => { d.compras[2]!.status = 'RECIBIDA' }, 'CUENTA_ESTADO_COMPRA')
  detecta('una cuenta que apunta a una compra inexistente', (d) => { d.cuentas[0]!.purchaseId = 'fantasma' }, 'CUENTA_ESTADO_COMPRA')
  detecta('una cuenta de una compra en borrador', (d) => { d.compras[0]!.status = 'BORRADOR' }, 'CUENTA_ESTADO_COMPRA')
  detecta('una compra recibida sin su entrada de stock', (d) => { d.movimientos = d.movimientos.filter((m) => m.purchaseId !== 'c4') }, 'STOCK_COMPRA')
  detecta('una entrada de stock con la cantidad cambiada', (d) => { d.movimientos[0]!.quantity = 9 }, 'STOCK_COMPRA')
  detecta('una entrada DUPLICADA (la compra se recibió dos veces)', (d) => { d.movimientos.push({ purchaseId: 'c1', productId: 'a', type: 'ENTRADA', quantity: 10 }) }, 'STOCK_COMPRA')
  detecta('una compra anulada que no devolvió su stock', (d) => { d.movimientos = d.movimientos.filter((m) => m.type !== 'DEVOLUCION_PROVEEDOR') }, 'STOCK_COMPRA')
  detecta('un BORRADOR que ya movió stock', (d) => { d.movimientos.push({ purchaseId: 'c5', productId: 'b', type: 'ENTRADA', quantity: 9 }) }, 'STOCK_COMPRA')
  detecta('el cierre congeló un efectivo pagado distinto al enlazado al turno', (d) => { d.turnosCerrados[0]!.supplierCashPaymentsTotal = 80; d.turnosCerrados[0]!.expectedAmount = 420 }, 'CIERRE_PAGOS')
  detecta('el cierre congeló pagos por otros medios que no existen', (d) => { d.turnosCerrados[0]!.supplierOtherPaymentsTotal = 15 }, 'CIERRE_PAGOS')
  detecta('el efectivo esperado congelado no sale de sus columnas', (d) => { d.turnosCerrados[0]!.expectedAmount = 500 }, 'CIERRE_ESPERADO')
  check('>>> un pago ANULADO en un turno no cuenta en lo congelado (p2 YAPE 15 anulado: 0 en «otros»)', !codigos(limpio()).includes('CIERRE_PAGOS'))
  const dos = auditarDatosPorPagar(con((d) => { d.proveedores[0]!.payableBalance = 1; d.turnosCerrados[0]!.expectedAmount = 1 }))
  check('>>> varios descuadres a la vez se informan TODOS, todos como ERROR, con el importe esperado y el encontrado', dos.errores === 2 && dos.hallazgos.every((h) => h.gravedad === 'ERROR') && dos.hallazgos[0]!.esperado === 60 && dos.hallazgos[0]!.encontrado === 1)
  check('>>> el informe en texto agrupa por código y recorta a 3 (con --detalle, todos)', (() => {
    const i = auditarDatosPorPagar(con((d) => { d.proveedores = Array.from({ length: 5 }, (_, k) => ({ id: `z${k}`, name: `Z${k}`, payableBalance: 7 })) }))
    return formatearInformePorPagar('demo', i).includes('y 2 más') && !formatearInformePorPagar('demo', i, true).includes('y 2 más') && formatearInformePorPagar('demo', i).includes('DEUDA_PROVEEDOR (ERROR): 5')
  })())

  console.log('\nB) Un negocio real que opera con normalidad sale limpio')
  const e = await negocio('real')
  const sup = (name: string) => crearProveedor(e.db, e.O, crearProveedorSchema.parse({ name, taxId: ruc() }))
  const S1 = await sup('Uno'), S2 = await sup('Dos')
  const prod = (sku: string) => prisma.product.create({ data: { tenantId: e.t.id, sku, name: sku, unitType: 'UNIDAD', salePrice: 30, costPrice: 0 } })
  const p1 = await prod('A'), p2 = await prod('B')
  const comprar = async (supplierId: string | null, items: { productId: string; q: number; c: number }[], cond: 'CONTADO' | 'CREDITO') => {
    const c = await crearBorrador(e.db, e.O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: e.b1.warehouse.id, supplierId, paymentCondition: cond, items: items.map((i) => ({ productId: i.productId, enteredQuantity: i.q, unitCost: i.c })) }))
    await recibirCompra(e.db, e.O, recibirCompraSchema.parse({ purchaseId: c.id }))
    return c
  }
  const pagar = (supplierId: string, amount: number, method: string) => registrarPagoProveedor(e.db, e.O, registrarPagoSchema.parse({ supplierId, amount, method, idempotencyKey: randomUUID() }))
  const turno = await openCashSession(e.db, e.O, openCashSchema.parse({ openingAmount: 1000 }))
  const k1 = await comprar(S1.id, [{ productId: p1.id, q: 10, c: 10 }, { productId: p2.id, q: 5, c: 4 }], 'CREDITO')
  const k2 = await comprar(S2.id, [{ productId: p1.id, q: 3, c: 12 }], 'CREDITO')
  await comprar(null, [{ productId: p2.id, q: 7, c: 3 }], 'CONTADO')
  const k4 = await comprar(S1.id, [{ productId: p1.id, q: 2, c: 9 }], 'CREDITO')
  await pagar(S1.id, 100, 'EFECTIVO'); const pg2 = await pagar(S2.id, 20, 'YAPE'); const pg3 = await pagar(S1.id, 30, 'EFECTIVO')
  await anularPagoProveedor(e.db, e.O, anularPagoSchema.parse({ paymentId: pg2.paymentId, motivo: 'Error' }))
  await anularCompra(e.db, e.O, anularCompraSchema.parse({ purchaseId: k2.id, motivo: 'Devolución' }))
  await anularPagoProveedor(e.db, e.O, anularPagoSchema.parse({ paymentId: pg3.paymentId, motivo: 'Error' }))
  await anularCompra(e.db, e.O, anularCompraSchema.parse({ purchaseId: k4.id, motivo: 'Devolución' }))
  await crearBorrador(e.db, e.O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: e.b1.warehouse.id, items: [{ productId: p1.id, enteredQuantity: 1, unitCost: 1 }] }))
  await closeCashSession(e.db, e.O, closeCashSchema.parse({ sessionId: turno.id, countedAmount: 900 }))
  const real = await auditarCoherenciaPorPagar(e.db)
  check('>>> compras, crédito, pagos (con anulados), devoluciones, un borrador y un cierre de caja: 0 errores', real.errores === 0, formatearInformePorPagar('real', real, true))
  check('>>> y la auditoría de verdad miró algo (4 compras recibidas, 3 cuentas, 3 pagos, 1 turno cerrado, 1 borrador)', real.compras === 5 && real.cuentas === 3 && real.pagos === 3 && real.turnosCerrados === 1 && real.proveedores === 2, JSON.stringify([real.compras, real.cuentas, real.pagos, real.turnosCerrados, real.proveedores]))

  console.log('\nC) Se provoca un descuadre real y se detecta')
  const foto = async () => JSON.stringify([await prisma.supplier.findMany({ where: { tenantId: e.t.id }, orderBy: { id: 'asc' } }), await prisma.accountPayable.findMany({ where: { tenantId: e.t.id }, orderBy: { id: 'asc' } }), await prisma.cashSession.findMany({ where: { tenantId: e.t.id } }), await prisma.auditLog.count({ where: { tenantId: e.t.id } })])
  await prisma.supplier.update({ where: { id: S1.id }, data: { payableBalance: { increment: 5 } } })
  const r1 = await auditarCoherenciaPorPagar(e.db)
  check('>>> sumarle 5 soles de deuda a un proveedor → DEUDA_PROVEEDOR con esperado y encontrado', r1.hallazgos.some((h) => h.codigo === 'DEUDA_PROVEEDOR' && h.id === S1.id && h.encontrado! - h.esperado! === 5))
  await prisma.supplier.update({ where: { id: S1.id }, data: { payableBalance: { decrement: 5 } } })
  const [ent] = await prisma.stockMovement.findMany({ where: { tenantId: e.t.id, referenceId: k1.id, type: 'ENTRADA' }, take: 1 })
  await prisma.stockMovement.delete({ where: { id: ent!.id } })
  const r2 = await auditarCoherenciaPorPagar(e.db)
  check('>>> borrar la entrada de stock de una compra recibida → STOCK_COMPRA', r2.hallazgos.some((h) => h.codigo === 'STOCK_COMPRA' && h.id === k1.id))
  await prisma.cashSession.update({ where: { id: turno.id }, data: { supplierCashPaymentsTotal: 1 } })
  const antes = await foto()
  const r3 = await auditarCoherenciaPorPagar(e.db)
  check('>>> alterar lo congelado de un turno cerrado → CIERRE_PAGOS y CIERRE_ESPERADO', r3.hallazgos.some((h) => h.codigo === 'CIERRE_PAGOS' && h.id === turno.id) && r3.hallazgos.some((h) => h.codigo === 'CIERRE_ESPERADO' && h.id === turno.id))
  check('>>> la auditoría NO escribió nada: proveedores, cuentas, turnos y registro de auditoría idénticos tras leer', (await foto()) === antes)

  console.log('\nD) Aislamiento')
  const o = await negocio('otro')
  const ro = await auditarCoherenciaPorPagar(o.db)
  check('>>> un negocio vacío sale limpio y sin contar nada del otro', ro.errores === 0 && ro.compras === 0 && ro.cuentas === 0 && ro.pagos === 0)
  check('>>> el descuadre provocado en un negocio no aparece en el otro', (await auditarCoherenciaPorPagar(e.db)).errores > 0 && (await auditarCoherenciaPorPagar(o.db)).errores === 0)

  console.log('\nE) Estructura')
  const aud = readFileSync('src/features/por-pagar/auditoria.ts', 'utf8')
  const scr = readFileSync('scripts/auditar-compras.ts', 'utf8')
  check('>>> la auditoría es de solo lectura: ninguna escritura en la base', !/\.(update|create|delete|upsert)(Many)?\(|\$executeRaw|\$queryRaw/.test(aud))
  check('>>> el script de línea de comandos es de solo lectura, usa un cliente aislado por negocio y sale con 3 si hay errores', !/\.(update|create|delete|upsert)(Many)?\(/.test(scr) && scr.includes('getTenantPrisma') && scr.includes('exitCode = 3') && scr.includes('auditarCoherenciaPorPagar'))
  check('>>> compara en céntimos enteros, no con decimales', aud.includes('Math.round(n * 100)') && !/[^=!]==[^=]/.test(aud.replace(/===|!==/g, '')))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
