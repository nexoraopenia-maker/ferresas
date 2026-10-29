import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { crearSucursalConAlmacen, cajaDe } from './fixtures'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Esquema del crédito (migración 20261110120000_credito_cuentas_por_cobrar): cuentas por cobrar, abonos y repartos.
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

const MIGRACION = readFileSync('prisma/migrations/20261110120000_credito_cuentas_por_cobrar/migration.sql', 'utf8')
const SQL = MIGRACION.replace(/--[^\n]*/g, '')
const NUEVAS = ['receivables', 'customer_payments', 'payment_allocations']

function parteA() {
  console.log('\nA1) Aislamiento por diseño: toda referencia dentro del negocio es una FK COMPUESTA con tenantId')
  const fks = [...SQL.matchAll(/ALTER TABLE "(\w+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY \(([^)]+)\) REFERENCES "(\w+)"\(([^)]+)\)/g)]
    .filter((m) => NUEVAS.includes(m[1]!))
  const simples = fks.filter((m) => !m[2]!.includes('"tenantId"')).map((m) => `${m[1]}.${m[2]}→${m[3]}`)
  const compuestas = fks.filter((m) => m[2]!.startsWith('"tenantId", '))
  const destinos = compuestas.map((m) => `${m[1]}→${m[3]}`).sort()
  const esperadas = ['receivables→customers', 'receivables→sales', 'customer_payments→customers', 'customer_payments→branches', 'customer_payments→cash_sessions',
    'payment_allocations→customer_payments', 'payment_allocations→receivables'].sort()
  check('>>> las únicas FKs simples son a usuarios (userId, voidedById) y a tenants; todo lo demás lleva (tenantId, …)', simples.every((s) => s.endsWith('→users')) && simples.length === 2, simples.join(', '))
  check('>>> las 7 referencias dentro del negocio (cliente, venta, sucursal, turno, abono, cuenta) son compuestas', JSON.stringify(destinos) === JSON.stringify(esperadas), destinos.join(' | '))
  check('>>> cada FK compuesta apunta a (tenantId, id) del padre',
    compuestas.every((m) => m[4] === '"tenantId", "id"'), compuestas.filter((m) => m[4] !== '"tenantId", "id"').map((m) => m[1]).join(','))
  check('las tres tablas tienen @@unique([tenantId, id]) para que otras tablas se enganchen de forma compuesta',
    NUEVAS.every((t) => new RegExp(`CREATE UNIQUE INDEX "${t}_tenantId_id_key" ON "${t}"\\("tenantId", "id"\\)`).test(SQL)))
  check('>>> nada se borra en cascada entre tablas de crédito: solo el negocio entero arrastra (ON DELETE CASCADE solo hacia tenants)',
    fks.filter((m) => /ON DELETE CASCADE/.test(SQL.slice(SQL.indexOf(m[0]), SQL.indexOf(';', SQL.indexOf(m[0])))) && m[3] !== 'tenants').length === 0)

  console.log('\nA2) Registro de aislamiento y esquema')
  const registro = readFileSync('src/lib/tenant-prisma.ts', 'utf8')
  for (const m of ['Receivable', 'CustomerPayment', 'PaymentAllocation']) check(`>>> ${m} está en TENANT_SCOPED (deny-by-default)`, new RegExp(`'${m}',`).test(registro))
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  check('una cuenta por venta: @@unique([tenantId, saleId]) y un abono no se duplica: @@unique([tenantId, idempotencyKey])', /model Receivable[\s\S]*?@@unique\(\[tenantId, saleId\]\)/.test(schema) && /model CustomerPayment[\s\S]*?@@unique\(\[tenantId, idempotencyKey\]\)/.test(schema))
  const cuerpo = /enum ReceivableStatus \{([\s\S]*?)\}/.exec(schema)?.[1]?.replace(/\/\/\/[^\n]*/g, '').trim().split(/\s+/).join(',')
  check('«vencida» NO es un estado guardado (se deriva de dueDate): el enum solo tiene ABIERTA, PAGADA y ANULADA', cuerpo === 'ABIERTA,PAGADA,ANULADA', String(cuerpo))

  console.log('\nA3) CHECKs presentes y sin la trampa del NULL')
  for (const c of ['customers_credito_chk', 'customers_deuda_borrado_chk', 'receivables_montos_chk', 'receivables_estado_chk', 'receivables_revision_chk',
    'customer_payments_monto_chk', 'customer_payments_metodo_chk', 'customer_payments_efectivo_caja_chk', 'customer_payments_anulacion_chk', 'payment_allocations_monto_chk']) {
    check(`CHECK ${c}`, SQL.includes(`"${c}"`))
  }
  // length(x) > 0 es NULL si x es NULL, y un CHECK en NULL se da por cumplido: toda condición con length(btrim(col)) pide también col IS NOT NULL
  const trampas = [...SQL.matchAll(/(.*?)length\(btrim\("(\w+)"\)\) > 0/gs)].filter((m) => !new RegExp(`"${m[2]}" IS NOT NULL AND\\s*$`).test(m[1]!) && !new RegExp(`"${m[2]}" IS NULL OR\\s*$`).test(m[1]!)).map((m) => m[2])
  check('>>> toda condición length(btrim(col)) > 0 exige antes col IS NOT NULL (o admite NULL a propósito con IS NULL OR)', trampas.length === 0, trampas.join(','))
  check('la migración es solo expand: no borra ni renombra nada existente', !/DROP (TABLE|COLUMN|TYPE)|RENAME/i.test(SQL))
}

async function parteB() {
  const existe = await prisma.$queryRaw<{ r: string | null }[]>`select to_regclass('public.receivables')::text as r`
  if (!existe[0]?.r) { check('>>> la migración está aplicada en esta base (si falla: aplicar 20261110120000_credito_cuentas_por_cobrar a staging)', false, 'faltan las tablas'); return }

  const mk = async (tag: string) => {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
    const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
    const t = await prisma.tenant.create({ data: { slug: `cr-${tag}-${randomUUID().slice(0, 6)}`, name: `Crédito ${tag}`, taxId, planId: plan.id } })
    const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER' } })
    const cliente = await prisma.customer.create({ data: { tenantId: t.id, name: `Cliente ${tag}`, creditLimit: 1000 } })
    const venta = async () => (await prisma.sale.create({ data: { tenantId: t.id, branchId: branch.id, warehouseId: w.id, userId: u.id, number: `V-${tag}-${randomUUID().slice(0, 6)}`, status: 'COMPLETADA' } })).id
    const caja = await prisma.cashSession.create({ data: { tenantId: t.id, branchId: branch.id, registerId: await cajaDe(t.id, branch.id), openedById: u.id, openingAmount: 0 } })
    const cuenta = (saleId: string, over: Record<string, unknown> = {}) => ({ tenantId: t.id, customerId: cliente.id, saleId, amount: 100, dueDate: new Date('2026-12-31'), ...over })
    const abono = (over: Record<string, unknown> = {}) => ({ tenantId: t.id, customerId: cliente.id, branchId: branch.id, userId: u.id, method: 'YAPE' as const, amount: 10, ...over })
    const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
    return { t, u, branch, cliente, venta, caja, cuenta, abono, ctx }
  }
  const A = await mk('a'); const B = await mk('b')
  const vA = await A.venta(), vA2 = await A.venta(), vB = await B.venta()

  console.log('\nB1) Cuentas por cobrar')
  const rA = await prisma.receivable.create({ data: A.cuenta(vA) })
  const rB = await prisma.receivable.create({ data: B.cuenta(vB) })
  check('una cuenta ABIERTA válida se crea y el saldo arranca en 0 abonado', rA.status === 'ABIERTA' && Number(rA.paidAmount) === 0)
  check('>>> una SEGUNDA cuenta para la misma venta → rechazada (una por venta)', (await falla(prisma.receivable.create({ data: A.cuenta(vA, { amount: 5 }) }))) === 'P2002')
  check('>>> cuenta del negocio A con un CLIENTE del negocio B → rechazada por la FK compuesta', (await falla(prisma.receivable.create({ data: A.cuenta(vA2, { customerId: B.cliente.id }) }))) === 'P2003')
  check('>>> cuenta del negocio A con una VENTA del negocio B → rechazada', (await falla(prisma.receivable.create({ data: A.cuenta(vB) }))) === 'P2003')
  for (const [n, over] of [
    ['monto 0', { amount: 0 }], ['abonado mayor que el monto', { paidAmount: 100.01, status: 'PAGADA', closedAt: new Date() }],
    ['ABIERTA ya abonada por completo', { paidAmount: 100 }], ['PAGADA con saldo', { status: 'PAGADA', paidAmount: 50, closedAt: new Date() }],
    ['ANULADA sin motivo (NULL: la trampa del CHECK)', { status: 'ANULADA', voidedAt: new Date(), closedAt: new Date() }],
    ['ANULADA con motivo en blanco', { status: 'ANULADA', voidedAt: new Date(), closedAt: new Date(), voidReason: '  ' }],
    ['revisión con fecha y sin motivo', { reviewRequestedAt: new Date() }],
  ] as const) check(`>>> cuenta inválida: ${n} → CHECK`, (await falla(prisma.receivable.create({ data: A.cuenta(await A.venta(), over as Record<string, unknown>) }))) === 'CHECK')
  check('ANULADA con motivo, fecha y abono parcial → permitida', !(await falla(prisma.receivable.create({ data: A.cuenta(await A.venta(), { status: 'ANULADA', paidAmount: 10, voidedAt: new Date(), closedAt: new Date(), voidReason: 'nota de crédito total' }) }))))

  console.log('\nB2) Abonos y repartos')
  const pA = await prisma.customerPayment.create({ data: A.abono({ idempotencyKey: 'k-1' }) })
  const pB = await prisma.customerPayment.create({ data: B.abono({ idempotencyKey: 'k-1' }) })
  check('>>> la MISMA clave de idempotencia en OTRO negocio no choca (es única por negocio)', !!pB.id)
  check('>>> el mismo abono reenviado (misma clave, mismo negocio) → rechazado: no se duplica', (await falla(prisma.customerPayment.create({ data: A.abono({ idempotencyKey: 'k-1' }) }))) === 'P2002')
  check('varios abonos sin clave a la vez son válidos (la unicidad ignora NULL)', !(await falla(prisma.customerPayment.create({ data: A.abono() }))) && !(await falla(prisma.customerPayment.create({ data: A.abono() }))))
  check('>>> abono del negocio A a un cliente del negocio B → rechazado', (await falla(prisma.customerPayment.create({ data: A.abono({ customerId: B.cliente.id }) }))) === 'P2003')
  check('>>> abono en efectivo sobre el turno de caja de OTRO negocio → rechazado', (await falla(prisma.customerPayment.create({ data: A.abono({ method: 'EFECTIVO', cashSessionId: B.caja.id }) }))) === 'P2003')
  check('>>> abono en efectivo SIN turno de caja → CHECK', (await falla(prisma.customerPayment.create({ data: A.abono({ method: 'EFECTIVO' }) }))) === 'CHECK')
  check('abono en efectivo con su turno → permitido', !(await falla(prisma.customerPayment.create({ data: A.abono({ method: 'EFECTIVO', cashSessionId: A.caja.id }) }))))
  check('>>> un abono nunca es «a crédito» (CREDITO) → CHECK', (await falla(prisma.customerPayment.create({ data: A.abono({ method: 'CREDITO' }) }))) === 'CHECK')
  check('abono con monto 0 → CHECK', (await falla(prisma.customerPayment.create({ data: A.abono({ amount: 0 }) }))) === 'CHECK')
  check('>>> abono anulado sin motivo (NULL) → CHECK; con quién, cuándo y por qué → permitido',
    (await falla(prisma.customerPayment.create({ data: A.abono({ voidedAt: new Date(), voidedById: A.u.id }) }))) === 'CHECK'
    && !(await falla(prisma.customerPayment.create({ data: A.abono({ voidedAt: new Date(), voidedById: A.u.id, voidReason: 'error de digitación' }) }))))
  const rep = (p: string, r: string, t: string, amount = 5) => ({ tenantId: t, customerPaymentId: p, receivableId: r, amount })
  check('reparto: abono → cuenta del mismo negocio → permitido', !(await falla(prisma.paymentAllocation.create({ data: rep(pA.id, rA.id, A.t.id) }))))
  check('>>> el mismo abono hacia la misma cuenta dos veces → rechazado', (await falla(prisma.paymentAllocation.create({ data: rep(pA.id, rA.id, A.t.id) }))) === 'P2002')
  check('>>> reparto de un abono del negocio A hacia una cuenta del negocio B → rechazado', (await falla(prisma.paymentAllocation.create({ data: rep(pA.id, rB.id, A.t.id) }))) === 'P2003')
  check('>>> reparto de un abono del negocio B hacia una cuenta del negocio A → rechazado', (await falla(prisma.paymentAllocation.create({ data: rep(pB.id, rA.id, A.t.id) }))) === 'P2003')
  check('reparto con monto 0 → CHECK', (await falla(prisma.paymentAllocation.create({ data: { ...rep(pA.id, rA.id, A.t.id, 0), receivableId: rA.id } }))) !== null)

  console.log('\nB3) Cliente')
  const c = (over: Record<string, unknown>) => prisma.customer.create({ data: { tenantId: A.t.id, name: 'x', ...over } })
  check('línea negativa, saldo negativo y plazo fuera de 0–365 → CHECK',
    (await falla(c({ creditLimit: -1 }))) === 'CHECK' && (await falla(c({ creditBalance: -0.01 }))) === 'CHECK' && (await falla(c({ creditTermDays: 366 }))) === 'CHECK' && (await falla(c({ creditTermDays: -1 }))) === 'CHECK')
  const conDeuda = await c({ creditBalance: 50 })
  check('>>> un cliente con deuda viva NO se puede dar de baja (borrado lógico) → CHECK', (await falla(prisma.customer.update({ where: { id: conDeuda.id }, data: { deletedAt: new Date() } }))) === 'CHECK')
  check('sin deuda sí se da de baja', !(await falla(prisma.customer.update({ where: { id: A.cliente.id }, data: { creditBalance: 0, deletedAt: new Date() } }))))

  console.log('\nB4) Borrados: el historial no se pierde')
  check('>>> no se borra un cliente que tiene cuentas', (await falla(prisma.customer.delete({ where: { id: B.cliente.id } }))) === 'P2003')
  check('>>> no se borra una cuenta con repartos', (await falla(prisma.receivable.delete({ where: { id: rA.id } }))) === 'P2003')
  check('>>> no se borra un abono con repartos', (await falla(prisma.customerPayment.delete({ where: { id: pA.id } }))) === 'P2003')

  console.log('\nB5) El cliente aislado por negocio')
  const dbA = getTenantPrisma(A.ctx)
  const vistas = await dbA.receivable.findMany({ select: { id: true, tenantId: true } })
  check('>>> el negocio A solo ve SUS cuentas, abonos y repartos', vistas.length > 0 && vistas.every((v) => v.tenantId === A.t.id)
    && (await dbA.customerPayment.findMany({ select: { tenantId: true } })).every((v) => v.tenantId === A.t.id)
    && (await dbA.paymentAllocation.findMany({ select: { tenantId: true } })).every((v) => v.tenantId === A.t.id))
  check('>>> pedir por id una cuenta ajena devuelve nada (indistinguible de «no existe»)', (await dbA.receivable.findFirst({ where: { id: rB.id } })) === null && (await dbA.customerPayment.findFirst({ where: { id: pB.id } })) === null)
  check('>>> forzar el tenantId de OTRO negocio en el filtro, o al crear, no devuelve ni escribe nada: el cliente aislado lo rechaza (TENANT_MISMATCH)',
    (await falla(dbA.receivable.findMany({ where: { tenantId: B.t.id } }))) === 'TENANT_MISMATCH'
    && (await falla(dbA.customerPayment.create({ data: B.abono() }))) === 'TENANT_MISMATCH'
    && (await prisma.customerPayment.count({ where: { tenantId: B.t.id } })) === 1)

  console.log('\nB6) Borrar un negocio entero')
  check('>>> borrar el negocio arrastra sus cuentas, abonos y repartos sin que las FKs lo impidan, y no toca al otro negocio',
    !(await falla(prisma.tenant.delete({ where: { id: A.t.id } }))) && (await prisma.receivable.count({ where: { tenantId: A.t.id } })) === 0 && (await prisma.receivable.count({ where: { tenantId: B.t.id } })) === 1)
}

async function main() {
  parteA()
  await parteB()
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
