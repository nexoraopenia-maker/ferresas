import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { crearSucursalConAlmacen } from './fixtures'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Esquema de compras y cuentas por pagar (migración 20261112100000_compras_cuentas_por_pagar).
 * Lo que se prueba es lo que garantiza LA BASE, no el código: son las últimas líneas de defensa.
 *
 *   Parte A — estructural, sin base de datos (lee la migración, el schema y el registro de aislamiento).
 *   Parte B — contra la base: aislamiento entre negocios, CHECKs, índices únicos y borrados. Exige la migración aplicada.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const falla = (p: Promise<unknown>) => p.then(() => null).catch((e) => {
  const txt = JSON.stringify({ c: e.code, m: String(e.message), meta: e.meta, cause: String(e.cause?.message ?? ''), d: String(e.meta?.driverAdapterError?.cause?.kind ?? '') })
  return e.code === 'P2002' ? 'P2002' : e.code === 'P2003' ? 'P2003' : /check|chk|23514/i.test(txt) ? 'CHECK' : String(e.code ?? e.name)
})

const MIGRACION = readFileSync('prisma/migrations/20261112100000_compras_cuentas_por_pagar/migration.sql', 'utf8')
const SQL = MIGRACION.replace(/--[^\n]*/g, '')
const NUEVAS = ['account_payables', 'supplier_payments', 'supplier_payment_allocations']

function parteA() {
  console.log('\nA1) Aislamiento por diseño: toda referencia dentro del negocio es una FK COMPUESTA con tenantId')
  const fks = [...SQL.matchAll(/ALTER TABLE "(\w+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY \(([^)]+)\) REFERENCES "(\w+)"\(([^)]+)\)/g)]
  const simples = fks.filter((m) => !m[2]!.includes('"tenantId"')).map((m) => `${m[1]}.${m[2]}→${m[3]}`).sort()
  const compuestas = fks.filter((m) => m[2]!.startsWith('"tenantId", '))
  const destinos = compuestas.map((m) => `${m[1]}→${m[3]}`).sort()
  const esperadas = ['account_payables→suppliers', 'account_payables→purchases', 'supplier_payments→suppliers', 'supplier_payments→branches', 'supplier_payments→cash_sessions',
    'supplier_payment_allocations→supplier_payments', 'supplier_payment_allocations→account_payables'].sort()
  check('>>> las únicas FKs simples de la migración son a usuarios (quién pagó, anuló o recibió) y a tenants',
    simples.every((s) => s.endsWith('→users') || s.endsWith('→tenants')) && simples.filter((s) => s.endsWith('→users')).length === 4, simples.join(', '))
  check('>>> las 7 referencias dentro del negocio (proveedor, compra, sucursal, turno, pago, cuenta) son compuestas', JSON.stringify(destinos) === JSON.stringify(esperadas), destinos.join(' | '))
  check('>>> cada FK compuesta apunta a (tenantId, id) del padre', compuestas.every((m) => m[4] === '"tenantId", "id"'), compuestas.filter((m) => m[4] !== '"tenantId", "id"').map((m) => m[1]).join(','))
  check('las tres tablas nuevas tienen @@unique([tenantId, id]) para que otras tablas se enganchen de forma compuesta',
    NUEVAS.every((t) => new RegExp(`CREATE UNIQUE INDEX "${t}_tenantId_id_key" ON "${t}"\\("tenantId", "id"\\)`).test(SQL)))
  check('>>> nada se borra en cascada entre tablas de pagos: solo el negocio entero arrastra (ON DELETE CASCADE solo hacia tenants)',
    fks.filter((m) => NUEVAS.includes(m[1]!) && /ON DELETE CASCADE/.test(SQL.slice(SQL.indexOf(m[0]), SQL.indexOf(';', SQL.indexOf(m[0])))) && m[3] !== 'tenants').length === 0)

  console.log('\nA2) Registro de aislamiento y esquema')
  const registro = readFileSync('src/lib/tenant-prisma.ts', 'utf8')
  for (const m of ['Supplier', 'Purchase', 'PurchaseItem', 'AccountPayable', 'SupplierPayment', 'SupplierPaymentAllocation']) check(`>>> ${m} está en TENANT_SCOPED (deny-by-default)`, new RegExp(`'${m}',`).test(registro))
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  check('una cuenta por compra (@@unique([tenantId, purchaseId])) y un pago no se duplica (@@unique([tenantId, idempotencyKey]))',
    /model AccountPayable[\s\S]*?@@unique\(\[tenantId, purchaseId\]\)/.test(schema) && /model SupplierPayment \{[\s\S]*?@@unique\(\[tenantId, idempotencyKey\]\)/.test(schema))
  check('la compra no se recibe dos veces (@@unique([tenantId, idempotencyKey])) y la factura del proveedor no se registra dos veces (@@unique([tenantId, supplierId, invoiceRef]))',
    /model Purchase \{[\s\S]*?@@unique\(\[tenantId, idempotencyKey\]\)[\s\S]*?@@unique\(\[tenantId, supplierId, invoiceRef\]\)/.test(schema))
  const estados = /enum PayableStatus \{([\s\S]*?)\}/.exec(schema)?.[1]?.replace(/\/\/\/[^\n]*/g, '').trim().split(/\s+/).join(',')
  check('«vencida» NO es un estado guardado (se deriva de dueDate): el enum solo tiene ABIERTA, PAGADA y ANULADA', estados === 'ABIERTA,PAGADA,ANULADA', String(estados))
  check('la condición de pago es CONTADO o CREDITO', /enum PurchaseCondition \{([\s\S]*?)\}/.exec(schema)?.[1]?.replace(/\/\/\/[^\n]*/g, '').trim().split(/\s+/).join(',') === 'CONTADO,CREDITO')

  console.log('\nA3) CHECKs presentes y sin la trampa del NULL')
  for (const c of ['suppliers_pagar_chk', 'suppliers_deuda_borrado_chk', 'purchases_montos_chk', 'purchases_estado_chk', 'purchases_credito_chk', 'purchases_referencias_chk',
    'purchase_items_montos_chk', 'account_payables_montos_chk', 'account_payables_estado_chk', 'supplier_payments_monto_chk', 'supplier_payments_metodo_chk',
    'supplier_payments_efectivo_caja_chk', 'supplier_payments_anulacion_chk', 'supplier_payments_clave_chk', 'supplier_payment_allocations_monto_chk', 'cash_sessions_proveedores_chk']) {
    check(`CHECK ${c}`, SQL.includes(`"${c}"`))
  }
  const trampas = [...SQL.matchAll(/(.*?)length\(btrim\("(\w+)"\)\) > 0/gs)].filter((m) => !new RegExp(`"${m[2]}" IS NOT NULL AND\\s*$`).test(m[1]!) && !new RegExp(`"${m[2]}" IS NULL OR\\s*$`).test(m[1]!)).map((m) => m[2])
  check('>>> toda condición length(btrim(col)) > 0 exige antes col IS NOT NULL (o admite NULL a propósito con IS NULL OR)', trampas.length === 0, trampas.join(','))
  check('la migración es solo expand: no borra ni renombra nada existente', !/DROP (TABLE|COLUMN|TYPE)|RENAME/i.test(SQL))
}

async function parteB() {
  const existe = await prisma.$queryRaw<{ r: string | null }[]>`select to_regclass('public.account_payables')::text as r`
  if (!existe[0]?.r) { check('>>> la migración está aplicada en esta base (si falla: aplicar 20261112100000_compras_cuentas_por_pagar a staging)', false, 'faltan las tablas'); return }

  const mk = async (tag: string) => {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
    const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
    const t = await prisma.tenant.create({ data: { slug: `cp-${tag}-${randomUUID().slice(0, 6)}`, name: `Compras ${tag}`, taxId, planId: plan.id } })
    const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER' } })
    const prov = await prisma.supplier.create({ data: { tenantId: t.id, name: `Proveedor ${tag}`, taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`) } })
    const producto = await prisma.product.create({ data: { tenantId: t.id, sku: `P-${tag}`, name: 'Producto', salePrice: 10 } })
    const compra = (over: Record<string, unknown> = {}) => ({ tenantId: t.id, warehouseId: w.id, userId: u.id, number: `C-${tag}-${randomUUID().slice(0, 8)}`, ...over })
    const caja = await prisma.cashSession.create({ data: { tenantId: t.id, branchId: branch.id, openedById: u.id, openingAmount: 0 } })
    const cuenta = (supplierId: string, purchaseId: string, over: Record<string, unknown> = {}) => ({ tenantId: t.id, supplierId, purchaseId, amount: 100, dueDate: new Date('2026-12-31'), ...over })
    const pago = (over: Record<string, unknown> = {}) => ({ tenantId: t.id, supplierId: prov.id, branchId: branch.id, userId: u.id, method: 'YAPE' as const, amount: 10, ...over })
    const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
    return { t, u, branch, w, prov, producto, compra, caja, cuenta, pago, ctx }
  }
  const A = await mk('a'); const B = await mk('b')

  console.log('\nB1) Compras')
  const cA = await prisma.purchase.create({ data: A.compra({ paymentCondition: 'CREDITO', dueDate: new Date('2026-12-31'), supplierId: A.prov.id, status: 'RECIBIDA', receivedAt: new Date(), receivedById: A.u.id, subtotal: 100, taxTotal: 18, total: 118, invoiceRef: 'F001-1', idempotencyKey: 'k-1' }) })
  const cB = await prisma.purchase.create({ data: B.compra({ paymentCondition: 'CREDITO', dueDate: new Date('2026-12-31'), supplierId: B.prov.id, status: 'RECIBIDA', receivedAt: new Date(), receivedById: B.u.id, idempotencyKey: 'k-1' }) })
  check('>>> la MISMA clave de recepción en OTRO negocio no choca (es única por negocio)', !!cB.id)
  check('>>> la misma clave de recepción en el mismo negocio → rechazada: no se recibe dos veces', (await falla(prisma.purchase.create({ data: A.compra({ idempotencyKey: 'k-1' }) }))) === 'P2002')
  check('>>> la MISMA factura del MISMO proveedor dos veces → rechazada', (await falla(prisma.purchase.create({ data: A.compra({ supplierId: A.prov.id, invoiceRef: 'F001-1' }) }))) === 'P2002')
  const otroProv = await prisma.supplier.create({ data: { tenantId: A.t.id, name: 'Otro proveedor' } })
  check('la misma factura de OTRO proveedor sí; compras sin factura del mismo proveedor, también (NULL no choca)',
    !(await falla(prisma.purchase.create({ data: A.compra({ supplierId: otroProv.id, invoiceRef: 'F001-1' }) }))) && !(await falla(prisma.purchase.create({ data: A.compra({ supplierId: A.prov.id }) }))) && !(await falla(prisma.purchase.create({ data: A.compra({ supplierId: A.prov.id }) }))))
  check('>>> compra del negocio A con un PROVEEDOR del negocio B → rechazada por la FK compuesta', (await falla(prisma.purchase.create({ data: A.compra({ supplierId: B.prov.id }) }))) === 'P2003')
  check('>>> línea de compra del negocio A sobre una compra del negocio B → rechazada', (await falla(prisma.purchaseItem.create({ data: { tenantId: A.t.id, purchaseId: cB.id, productId: A.producto.id, quantity: 1, unitCost: 1, lineTotal: 1 } }))) === 'P2003')
  for (const [n, over] of [
    ['total distinto de subtotal + IGV', { subtotal: 100, taxTotal: 18, total: 119 }], ['subtotal negativo', { subtotal: -1, total: -1 }],
    ['RECIBIDA sin quién la recibió', { status: 'RECIBIDA', receivedAt: new Date() }], ['BORRADOR con fecha de recepción', { receivedAt: new Date() }],
    ['ANULADA sin motivo (NULL: la trampa del CHECK)', { status: 'ANULADA', voidedAt: new Date(), voidedById: A.u.id }],
    ['ANULADA con motivo en blanco', { status: 'ANULADA', voidedAt: new Date(), voidedById: A.u.id, voidReason: '  ' }],
    ['a CRÉDITO sin vencimiento', { paymentCondition: 'CREDITO', supplierId: A.prov.id }], ['de CONTADO con vencimiento', { dueDate: new Date('2026-12-31') }],
    ['a CRÉDITO sin proveedor', { paymentCondition: 'CREDITO', dueDate: new Date('2026-12-31') }], ['clave de reintento en blanco', { idempotencyKey: '  ' }], ['n.º de factura en blanco', { invoiceRef: '  ' }],
  ] as const) check(`>>> compra inválida: ${n} → CHECK`, (await falla(prisma.purchase.create({ data: A.compra(over as Record<string, unknown>) }))) === 'CHECK')
  check('ANULADA con quién, cuándo y por qué (recibida y luego devuelta) → permitida', !(await falla(prisma.purchase.create({ data: A.compra({ status: 'ANULADA', receivedAt: new Date(), receivedById: A.u.id, voidedAt: new Date(), voidedById: A.u.id, voidReason: 'devolución al proveedor' }) }))))
  for (const [n, over] of [['cantidad 0', { quantity: 0 }], ['costo negativo', { unitCost: -1 }], ['IGV de 150 %', { taxRate: 1.5 }], ['total negativo', { lineTotal: -1 }]] as const) {
    check(`>>> línea de compra inválida: ${n} → CHECK`, (await falla(prisma.purchaseItem.create({ data: { tenantId: A.t.id, purchaseId: cA.id, productId: A.producto.id, quantity: 1, unitCost: 1, lineTotal: 1, ...over } }))) === 'CHECK')
  }

  console.log('\nB2) Cuentas por pagar')
  const aA = await prisma.accountPayable.create({ data: A.cuenta(A.prov.id, cA.id) })
  const aB = await prisma.accountPayable.create({ data: B.cuenta(B.prov.id, cB.id) })
  check('una cuenta ABIERTA válida se crea y arranca con 0 pagado', aA.status === 'ABIERTA' && Number(aA.paidAmount) === 0)
  check('>>> una SEGUNDA cuenta por pagar para la misma compra → rechazada (una por compra)', (await falla(prisma.accountPayable.create({ data: A.cuenta(A.prov.id, cA.id, { amount: 5 }) }))) === 'P2002')
  const cA2 = await prisma.purchase.create({ data: A.compra({ paymentCondition: 'CREDITO', dueDate: new Date('2026-12-31'), supplierId: A.prov.id }) })
  check('>>> cuenta del negocio A con un PROVEEDOR del negocio B → rechazada por la FK compuesta', (await falla(prisma.accountPayable.create({ data: A.cuenta(B.prov.id, cA2.id) }))) === 'P2003')
  check('>>> cuenta del negocio A con una COMPRA del negocio B → rechazada', (await falla(prisma.accountPayable.create({ data: A.cuenta(A.prov.id, cB.id) }))) === 'P2003')
  for (const [n, over] of [
    ['monto 0', { amount: 0 }], ['pagado mayor que el monto', { paidAmount: 100.01, status: 'PAGADA', closedAt: new Date() }],
    ['ABIERTA ya pagada por completo', { paidAmount: 100 }], ['PAGADA con saldo', { status: 'PAGADA', paidAmount: 50, closedAt: new Date() }],
    ['ANULADA sin motivo (NULL: la trampa del CHECK)', { status: 'ANULADA', voidedAt: new Date(), closedAt: new Date() }],
    ['ANULADA con motivo en blanco', { status: 'ANULADA', voidedAt: new Date(), closedAt: new Date(), voidReason: '  ' }],
  ] as const) check(`>>> cuenta inválida: ${n} → CHECK`, (await falla(prisma.accountPayable.create({ data: A.cuenta(A.prov.id, cA2.id, over as Record<string, unknown>) }))) === 'CHECK')
  check('ANULADA con motivo, fecha y pago parcial → permitida', !(await falla(prisma.accountPayable.create({ data: A.cuenta(A.prov.id, cA2.id, { status: 'ANULADA', paidAmount: 10, voidedAt: new Date(), closedAt: new Date(), voidReason: 'compra anulada' }) }))))

  console.log('\nB3) Pagos y repartos')
  const pA = await prisma.supplierPayment.create({ data: A.pago({ idempotencyKey: 'k-1' }) })
  const pB = await prisma.supplierPayment.create({ data: B.pago({ idempotencyKey: 'k-1' }) })
  check('>>> la MISMA clave de pago en OTRO negocio no choca (es única por negocio)', !!pB.id)
  check('>>> el mismo pago reenviado (misma clave, mismo negocio) → rechazado: no se duplica', (await falla(prisma.supplierPayment.create({ data: A.pago({ idempotencyKey: 'k-1' }) }))) === 'P2002')
  check('varios pagos sin clave a la vez son válidos (la unicidad ignora NULL)', !(await falla(prisma.supplierPayment.create({ data: A.pago() }))) && !(await falla(prisma.supplierPayment.create({ data: A.pago() }))))
  check('>>> pago del negocio A a un proveedor del negocio B → rechazado', (await falla(prisma.supplierPayment.create({ data: A.pago({ supplierId: B.prov.id }) }))) === 'P2003')
  check('>>> pago en efectivo sobre el turno de caja de OTRO negocio → rechazado', (await falla(prisma.supplierPayment.create({ data: A.pago({ method: 'EFECTIVO', cashSessionId: B.caja.id }) }))) === 'P2003')
  check('>>> pago en efectivo SIN turno de caja → CHECK (el efectivo que sale del cajón tiene que constar en un turno)', (await falla(prisma.supplierPayment.create({ data: A.pago({ method: 'EFECTIVO' }) }))) === 'CHECK')
  check('pago en efectivo con su turno → permitido; por Yape sin turno → permitido (no toca el cajón)',
    !(await falla(prisma.supplierPayment.create({ data: A.pago({ method: 'EFECTIVO', cashSessionId: A.caja.id }) }))) && !(await falla(prisma.supplierPayment.create({ data: A.pago({ method: 'YAPE' }) }))))
  check('>>> un pago nunca es «a crédito» (CREDITO) → CHECK; con monto 0 → CHECK', (await falla(prisma.supplierPayment.create({ data: A.pago({ method: 'CREDITO' }) }))) === 'CHECK' && (await falla(prisma.supplierPayment.create({ data: A.pago({ amount: 0 }) }))) === 'CHECK')
  check('>>> pago anulado sin motivo (NULL) → CHECK; con quién, cuándo y por qué → permitido',
    (await falla(prisma.supplierPayment.create({ data: A.pago({ voidedAt: new Date(), voidedById: A.u.id }) }))) === 'CHECK'
    && !(await falla(prisma.supplierPayment.create({ data: A.pago({ voidedAt: new Date(), voidedById: A.u.id, voidReason: 'error de digitación' }) }))))
  const rep = (p: string, r: string, t: string, amount = 5) => ({ tenantId: t, supplierPaymentId: p, payableId: r, amount })
  check('reparto: pago → cuenta del mismo negocio → permitido', !(await falla(prisma.supplierPaymentAllocation.create({ data: rep(pA.id, aA.id, A.t.id) }))))
  check('>>> el mismo pago hacia la misma cuenta dos veces → rechazado', (await falla(prisma.supplierPaymentAllocation.create({ data: rep(pA.id, aA.id, A.t.id) }))) === 'P2002')
  check('>>> reparto de un pago del negocio A hacia una cuenta del negocio B → rechazado', (await falla(prisma.supplierPaymentAllocation.create({ data: rep(pA.id, aB.id, A.t.id) }))) === 'P2003')
  check('>>> reparto de un pago del negocio B hacia una cuenta del negocio A → rechazado', (await falla(prisma.supplierPaymentAllocation.create({ data: rep(pB.id, aA.id, A.t.id) }))) === 'P2003')
  check('reparto con monto 0 → CHECK', (await falla(prisma.supplierPaymentAllocation.create({ data: rep(pA.id, aA.id, A.t.id, 0) }))) !== null)

  console.log('\nB4) Proveedor y turno de caja')
  const s = (over: Record<string, unknown>) => prisma.supplier.create({ data: { tenantId: A.t.id, name: 'x', ...over } })
  check('deuda negativa y plazo fuera de 0–365 → CHECK', (await falla(s({ payableBalance: -0.01 }))) === 'CHECK' && (await falla(s({ paymentTermDays: 366 }))) === 'CHECK' && (await falla(s({ paymentTermDays: -1 }))) === 'CHECK')
  const conDeuda = await s({ payableBalance: 50 })
  check('>>> un proveedor con deuda viva NO se puede dar de baja (borrado lógico) → CHECK', (await falla(prisma.supplier.update({ where: { id: conDeuda.id }, data: { deletedAt: new Date() } }))) === 'CHECK')
  check('sin deuda sí se da de baja', !(await falla(prisma.supplier.update({ where: { id: conDeuda.id }, data: { payableBalance: 0, deletedAt: new Date() } }))))
  check('>>> los totales de pagos a proveedores del turno nunca son negativos → CHECK; positivos se guardan',
    (await falla(prisma.cashSession.update({ where: { id: A.caja.id }, data: { supplierCashPaymentsTotal: -1 } }))) === 'CHECK'
    && (await falla(prisma.cashSession.update({ where: { id: A.caja.id }, data: { supplierOtherPaymentsTotal: -0.01 } }))) === 'CHECK'
    && !(await falla(prisma.cashSession.update({ where: { id: A.caja.id }, data: { supplierCashPaymentsTotal: 250.5, supplierOtherPaymentsTotal: 80 } }))))

  console.log('\nB5) Borrados: el historial no se pierde')
  check('>>> no se borra un proveedor que tiene cuentas por pagar', (await falla(prisma.supplier.delete({ where: { id: B.prov.id } }))) === 'P2003')
  check('>>> no se borra una compra que tiene cuenta por pagar', (await falla(prisma.purchase.delete({ where: { id: cA.id } }))) === 'P2003')
  check('>>> no se borra una cuenta con repartos', (await falla(prisma.accountPayable.delete({ where: { id: aA.id } }))) === 'P2003')
  check('>>> no se borra un pago con repartos', (await falla(prisma.supplierPayment.delete({ where: { id: pA.id } }))) === 'P2003')
  check('>>> no se borra un turno de caja que tiene pagos a proveedores enlazados', (await falla(prisma.cashSession.delete({ where: { id: A.caja.id } }))) === 'P2003')

  console.log('\nB6) El cliente aislado por negocio')
  const dbA = getTenantPrisma(A.ctx)
  check('>>> el negocio A solo ve SUS proveedores, compras, cuentas, pagos y repartos',
    (await dbA.supplier.findMany({ select: { tenantId: true } })).every((v) => v.tenantId === A.t.id)
    && (await dbA.purchase.findMany({ select: { tenantId: true } })).every((v) => v.tenantId === A.t.id)
    && (await dbA.accountPayable.findMany({ select: { tenantId: true } })).length > 0
    && (await dbA.accountPayable.findMany({ select: { tenantId: true } })).every((v) => v.tenantId === A.t.id)
    && (await dbA.supplierPayment.findMany({ select: { tenantId: true } })).every((v) => v.tenantId === A.t.id)
    && (await dbA.supplierPaymentAllocation.findMany({ select: { tenantId: true } })).every((v) => v.tenantId === A.t.id))
  check('>>> pedir por id una cuenta, un pago o una compra ajena devuelve nada (indistinguible de «no existe»)',
    (await dbA.accountPayable.findFirst({ where: { id: aB.id } })) === null && (await dbA.supplierPayment.findFirst({ where: { id: pB.id } })) === null && (await dbA.purchase.findFirst({ where: { id: cB.id } })) === null)
  check('>>> forzar el tenantId de OTRO negocio en el filtro, o al crear, lo rechaza el cliente aislado (TENANT_MISMATCH) y no escribe nada',
    (await falla(dbA.accountPayable.findMany({ where: { tenantId: B.t.id } }))) === 'TENANT_MISMATCH'
    && (await falla(dbA.supplierPayment.create({ data: B.pago() }))) === 'TENANT_MISMATCH'
    && (await prisma.supplierPayment.count({ where: { tenantId: B.t.id } })) === 1)

  console.log('\nB7) Borrar un negocio entero')
  check('>>> borrar el negocio arrastra sus proveedores, compras, cuentas, pagos y repartos sin que las FKs lo impidan, y no toca al otro negocio',
    !(await falla(prisma.tenant.delete({ where: { id: A.t.id } })))
    && (await prisma.accountPayable.count({ where: { tenantId: A.t.id } })) + (await prisma.supplierPayment.count({ where: { tenantId: A.t.id } })) + (await prisma.supplierPaymentAllocation.count({ where: { tenantId: A.t.id } })) + (await prisma.purchase.count({ where: { tenantId: A.t.id } })) === 0
    && (await prisma.accountPayable.count({ where: { tenantId: B.t.id } })) === 1 && (await prisma.supplierPayment.count({ where: { tenantId: B.t.id } })) === 1)
}

async function main() {
  parteA()
  await parteB()
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
