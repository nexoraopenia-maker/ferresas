import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen, abrirTurno } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { configurarCredito, hoyEnZona, sumarDias, validarFiado, type ClienteCredito } from '../src/features/credito/credito-service'
import { configurarCreditoSchema } from '../src/features/credito/schemas'
import { currentCashSession, openCashSession } from '../src/features/branches/cash-service'
import { openCashSchema } from '../src/features/branches/cash-schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 3, subpaso 3.2: el fiado dentro de registerSale y el control de concurrencia sobre la línea de crédito.
 * Lo que más importa: dos cajas fiando al mismo cliente a la vez NUNCA pasan de su línea, y la deuda nace y muere con la venta.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')

const cli = (over: Partial<ClienteCredito> = {}): ClienteCredito => ({
  name: 'Cliente', docType: 'DNI', docNumber: '41235678', isActive: true, deletedAt: null,
  creditLimit: 1000, creditBalance: 0, creditBlockedAt: null, creditTermDays: 30, ...over,
})
const errDe = (f: () => void) => { try { f(); return null } catch (e) { return e as { code: string; details?: Record<string, number> } } }

function parteA() {
  console.log('\nA) Quién puede recibir fiado (lógica pura)')
  check('un cliente con DNI, línea y sin deuda, para un monto que cabe → permitido', errDe(() => validarFiado(cli(), 1000)) === null)
  check('>>> justo en el límite (deuda 900 + 100 = línea 1000) → permitido; un céntimo más → CREDIT_LIMIT', errDe(() => validarFiado(cli({ creditBalance: 900 }), 100)) === null && errDe(() => validarFiado(cli({ creditBalance: 900 }), 100.01))?.code === 'CREDIT_LIMIT')
  const e = errDe(() => validarFiado(cli({ creditBalance: 850.5 }), 200))
  check('>>> CREDIT_LIMIT trae límite, deuda, monto y disponible para mostrar al cajero', e?.details?.limite === 1000 && e?.details?.deuda === 850.5 && e?.details?.monto === 200 && e?.details?.disponible === 149.5)
  check('sin línea (0) → CREDIT_BLOCKED', errDe(() => validarFiado(cli({ creditLimit: 0 }), 1))?.code === 'CREDIT_BLOCKED')
  check('bloqueado manualmente → CREDIT_BLOCKED, aunque tenga línea de sobra', errDe(() => validarFiado(cli({ creditBlockedAt: new Date() }), 1))?.code === 'CREDIT_BLOCKED')
  check('de baja (borrado lógico o inactivo) → CREDIT_BLOCKED', errDe(() => validarFiado(cli({ deletedAt: new Date() }), 1))?.code === 'CREDIT_BLOCKED' && errDe(() => validarFiado(cli({ isActive: false }), 1))?.code === 'CREDIT_BLOCKED')
  check('>>> sin documento, o con un documento inválido → CREDIT_CUSTOMER (no hay a quién cobrarle)',
    errDe(() => validarFiado(cli({ docType: 'SIN_DOCUMENTO', docNumber: null }), 1))?.code === 'CREDIT_CUSTOMER' && errDe(() => validarFiado(cli({ docNumber: '123' }), 1))?.code === 'CREDIT_CUSTOMER'
    && errDe(() => validarFiado(cli({ docType: 'RUC', docNumber: '20123456789' }), 1))?.code === 'CREDIT_CUSTOMER')
  check('un RUC válido sí', errDe(() => validarFiado(cli({ docType: 'RUC', docNumber: completarRuc('2012345678') }), 1)) === null)
  check('el ruido de flotantes no cuela un céntimo: deuda 0.1+0.2 y línea 0.3 → cabe 0', errDe(() => validarFiado(cli({ creditLimit: 0.3, creditBalance: 0.1 + 0.2 }), 0.01))?.code === 'CREDIT_LIMIT')
  check('vencimiento en la zona del negocio: 23:30 en Lima del 25 ya es el 26 en UTC y sigue siendo el 25 allá',
    hoyEnZona('America/Lima', new Date('2026-10-26T04:30:00Z')) === '2026-10-25' && hoyEnZona('UTC', new Date('2026-10-26T04:30:00Z')) === '2026-10-26')
  check('sumar días cruza meses y años', sumarDias('2026-12-20', 30).toISOString().slice(0, 10) === '2027-01-19' && sumarDias('2026-10-25', 0).toISOString().slice(0, 10) === '2026-10-25')
  check('el esquema de configuración rechaza plazo > 365, línea negativa y 3 decimales',
    !configurarCreditoSchema.safeParse({ customerId: 'c', creditLimit: 1, creditTermDays: 366, bloqueado: false }).success
    && !configurarCreditoSchema.safeParse({ customerId: 'c', creditLimit: -1, creditTermDays: 30, bloqueado: false }).success
    && !configurarCreditoSchema.safeParse({ customerId: 'c', creditLimit: 1.005, creditTermDays: 30, bloqueado: false }).success)
}

async function main() {
  parteA()

  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `cs-${randomUUID().slice(0, 6)}`, name: 'Crédito servicio', planId: plan.id } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { seriesNumber: 2, branchCode: 'S2', almacenCode: 'A2', establishmentCode: '0002' })
  const mk = async (role: Role, branches = [b1.branch.id, b2.branch.id]) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    for (const b of branches) await asignarSucursal(t.id, u.id, b)
    return u
  }
  const owner = await mk('OWNER'), owner2 = await mk('OWNER'), cajeroU = await mk('CAJERO')
  await abrirTurno(t.id, cajeroU.id, b1.branch.id)
  await abrirTurno(t.id, owner2.id, b2.branch.id) // F6.8b: la sucursal 2 la cobra otra persona con su turno
  const ctxDe = (u: { id: string }, role: Role, branchId: string, extra: TenantContext['permisosExtra'] = []): TenantContext =>
    ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: extra })
  const O1 = ctxDe(owner, 'OWNER', b1.branch.id), O2 = ctxDe(owner2, 'OWNER', b2.branch.id)
  const C1 = ctxDe(cajeroU, 'CAJERO', b1.branch.id), C1fia = ctxDe(cajeroU, 'CAJERO', b1.branch.id, ['credito.otorgar'])
  const dbO1 = getTenantPrisma(O1), dbO2 = getTenantPrisma(O2)

  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Producto', salePrice: 100 } })
  for (const w of [b1.warehouse, b2.warehouse]) await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: w.id, quantity: 1000 } })
  const escaso = await prisma.product.create({ data: { tenantId: t.id, sku: 'P2', name: 'Escaso', salePrice: 100 } })
  for (const w of [b1.warehouse, b2.warehouse]) await prisma.stock.create({ data: { tenantId: t.id, productId: escaso.id, warehouseId: w.id, quantity: 1 } })
  let dni = 41235600
  const cliente = (over: Record<string, unknown> = {}) => prisma.customer.create({ data: { tenantId: t.id, name: `Cliente ${dni}`, docType: 'DNI', docNumber: String(dni++), creditLimit: 500, ...over } })
  const stockTotal = async (p = prod.id) => (await prisma.stock.findMany({ where: { tenantId: t.id, productId: p } })).reduce((s, x) => s + num(x.quantity), 0)

  type Sede = { ctx: TenantContext; db: ReturnType<typeof getTenantPrisma>; w: string }
  const S1: Sede = { ctx: O1, db: dbO1, w: b1.warehouse.id }, S2: Sede = { ctx: O2, db: dbO2, w: b2.warehouse.id }
  const vender = (s: Sede, customerId: string | null, pagos: { method: string; amount: number }[], over: Record<string, unknown> = {}, cantidad = 1, producto = prod.id) =>
    registerSale(s.db, s.ctx, { warehouseId: s.w, customerId, items: [{ productId: producto, quantity: cantidad, discount: 0 }], payments: pagos, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID(), ...over } as never)
  const fiar = (s: Sede, customerId: string | null, monto: number, over: Record<string, unknown> = {}) => vender(s, customerId, [{ method: 'CREDITO', amount: monto }], over, monto / 100)
  const foto = async (cid?: string) => ({
    ventas: await prisma.sale.count({ where: { tenantId: t.id } }), pagos: await prisma.payment.count({ where: { tenantId: t.id } }),
    cuentas: await prisma.receivable.count({ where: { tenantId: t.id } }), movs: await prisma.stockMovement.count({ where: { tenantId: t.id } }), stock: await stockTotal(),
    deuda: cid ? num((await prisma.customer.findUniqueOrThrow({ where: { id: cid } })).creditBalance) : 0,
  })

  console.log('\nB) Configurar el crédito de un cliente')
  const K = await cliente({ creditLimit: 0 })
  const cfg = (customerId: string, over: Record<string, unknown> = {}) => configurarCredito(dbO1, O1, configurarCreditoSchema.parse({ customerId, creditLimit: 500, creditTermDays: 15, bloqueado: false, ...over }))
  check('>>> el CAJERO no puede cambiar la línea de nadie (credito.limite)', await code(configurarCredito(getTenantPrisma(C1), C1, configurarCreditoSchema.parse({ customerId: K.id, creditLimit: 500, creditTermDays: 15, bloqueado: false }))) === 'FORBIDDEN_ROLE')
  const r0 = await cfg(K.id, { motivo: 'Maestro de obra conocido' })
  const k0 = await prisma.customer.findUniqueOrThrow({ where: { id: K.id } })
  check('el dueño sí: línea 500, plazo 15 días', r0.creditLimit === 500 && num(k0.creditLimit) === 500 && k0.creditTermDays === 15 && k0.creditBlockedAt === null)
  const aud = await prisma.auditLog.findFirst({ where: { tenantId: t.id, action: 'credito.configurado', entityId: K.id } })
  check('>>> queda auditado con el antes y el después, y el motivo', (aud?.before as { creditLimit: number })?.creditLimit === 0 && (aud?.after as { creditLimit: number })?.creditLimit === 500 && aud?.reason === 'Maestro de obra conocido')
  await cfg(K.id, { bloqueado: true })
  check('bloquear marca la fecha y conserva la línea', !!(await prisma.customer.findUniqueOrThrow({ where: { id: K.id } })).creditBlockedAt && num((await prisma.customer.findUniqueOrThrow({ where: { id: K.id } })).creditLimit) === 500)
  await cfg(K.id, { bloqueado: false })
  check('liberar quita el bloqueo', (await prisma.customer.findUniqueOrThrow({ where: { id: K.id } })).creditBlockedAt === null)
  const sinDoc = await prisma.customer.create({ data: { tenantId: t.id, name: 'Sin documento', creditLimit: 0 } })
  check('>>> dar línea a un cliente SIN documento → CREDIT_CUSTOMER', await code(cfg(sinDoc.id)) === 'CREDIT_CUSTOMER')
  check('quitar la línea (0) a un cliente sin documento sí se permite', (await code(cfg(sinDoc.id, { creditLimit: 0 }))) === null)

  console.log('\nC) Vender a crédito')
  const A = await cliente({ creditLimit: 1000, creditTermDays: 30 })
  await abrirTurno(t.id, owner.id, b1.branch.id, { fondo: 100 })
  const caja0 = (await currentCashSession(dbO1, O1))!.expectedAmount
  const stock0 = await stockTotal()
  const v1 = await fiar(S1, A.id, 300)
  const cuenta1 = await prisma.receivable.findFirstOrThrow({ where: { saleId: v1.saleId } })
  check('>>> todo a crédito: la venta se registra, con su cuenta por cobrar ABIERTA por 300 y 0 abonado', num(cuenta1.amount) === 300 && num(cuenta1.paidAmount) === 0 && cuenta1.status === 'ABIERTA' && cuenta1.customerId === A.id)
  const esperadoVence = sumarDias(hoyEnZona('America/Lima'), 30).toISOString().slice(0, 10)
  check('>>> vence hoy + plazo del cliente (30 días) en la fecha del negocio', cuenta1.dueDate.toISOString().slice(0, 10) === esperadoVence && v1.credito?.vence === esperadoVence, `${cuenta1.dueDate.toISOString().slice(0, 10)} / ${esperadoVence}`)
  check('>>> la deuda del cliente sube a 300 y el resultado de la venta la informa', num((await prisma.customer.findUniqueOrThrow({ where: { id: A.id } })).creditBalance) === 300 && v1.credito?.monto === 300 && v1.credito?.deudaCliente === 300)
  const pagos1 = await prisma.payment.findMany({ where: { saleId: v1.saleId } })
  check('el pago queda como CREDITO por 300, sin vuelto', pagos1.length === 1 && pagos1[0]!.method === 'CREDITO' && num(pagos1[0]!.amount) === 300 && num(pagos1[0]!.change) === 0)
  check('el stock bajó 3 unidades y el fiado NO entró al cajón (el esperado sigue igual)', (await stockTotal()) === stock0 - 3 && (await currentCashSession(dbO1, O1))!.expectedAmount === caja0)
  const aud2 = await prisma.auditLog.findFirst({ where: { tenantId: t.id, action: 'credito.otorgado', entityId: cuenta1.id } })
  check('>>> auditado: quién, a quién, cuánto y la deuda antes y después', (aud2?.after as { monto: number; deudaAntes: number; deudaDespues: number })?.monto === 300 && (aud2?.after as { deudaDespues: number })?.deudaDespues === 300 && aud2?.actorId === owner.id)

  const v2 = await vender(S1, A.id, [{ method: 'EFECTIVO', amount: 30 }, { method: 'YAPE', amount: 20 }, { method: 'CREDITO', amount: 50 }], {}, 1)
  const cuenta2 = await prisma.receivable.findFirstOrThrow({ where: { saleId: v2.saleId } })
  check('>>> mixto: 30 en efectivo + 20 Yape + 50 fiados → la cuenta es solo por los 50 y la deuda total pasa a 350', num(cuenta2.amount) === 50 && num((await prisma.customer.findUniqueOrThrow({ where: { id: A.id } })).creditBalance) === 350)
  check('>>> en caja entran solo los 30 de efectivo (lo fiado y el Yape no)', (await currentCashSession(dbO1, O1))!.expectedAmount === caja0 + 30)

  console.log('\nD) Lo que se rechaza no deja NADA escrito')
  const B = await cliente({ creditLimit: 200 })
  const rechazos: [string, () => Promise<unknown>, string][] = [
    ['supera la línea (disponible 200, pide 300)', () => fiar(S1, B.id, 300), 'CREDIT_LIMIT'],
    ['cliente bloqueado', async () => { const X = await cliente({ creditBlockedAt: new Date() }); return fiar(S1, X.id, 100) }, 'CREDIT_BLOCKED'],
    ['cliente sin línea (0)', async () => { const X = await cliente({ creditLimit: 0 }); return fiar(S1, X.id, 100) }, 'CREDIT_BLOCKED'],
    ['cliente sin documento', async () => { const X = await prisma.customer.create({ data: { tenantId: t.id, name: 'Sin doc', creditLimit: 500 } }); return fiar(S1, X.id, 100) }, 'CREDIT_CUSTOMER'],
    ['sin cliente (público general)', () => fiar(S1, null, 100), 'CREDIT_CUSTOMER'],
    ['con FACTURA', () => fiar(S1, B.id, 100, { documentType: 'FACTURA' }), 'INVALID_DOCUMENT'],
    ['fiado con sobrepago en efectivo', () => vender(S1, B.id, [{ method: 'EFECTIVO', amount: 80 }, { method: 'CREDITO', amount: 60 }]), 'INVALID_DOCUMENT'],
    ['cliente de baja (borrado lógico)', async () => { const X = await cliente({ deletedAt: new Date() }); return fiar(S1, X.id, 100) }, 'TENANT_MISMATCH'],
    ['el cajero SIN el permiso de fiar', () => registerSale(getTenantPrisma(C1), C1, { warehouseId: b1.warehouse.id, customerId: B.id, items: [{ productId: prod.id, quantity: 1, discount: 0 }], payments: [{ method: 'CREDITO', amount: 100 }], documentType: 'NOTA_VENTA', allowNegativeStock: false } as never), 'FORBIDDEN_ROLE'],
  ]
  for (const [n, f, esperado] of rechazos) {
    const antes = await foto(B.id)
    const c = await code(f())
    const despues = await foto(B.id)
    // los clientes auxiliares se crean antes de la venta rechazada; solo se compara lo de la venta
    check(`>>> ${n} → ${esperado}, sin venta, pago, cuenta, movimiento ni stock tocados`, c === esperado && JSON.stringify(antes) === JSON.stringify(despues), `${c} ${JSON.stringify(antes) === JSON.stringify(despues) ? '' : JSON.stringify([antes, despues])}`)
  }
  const conPermiso = await registerSale(getTenantPrisma(C1fia), C1fia, { warehouseId: b1.warehouse.id, customerId: B.id, items: [{ productId: prod.id, quantity: 1, discount: 0 }], payments: [{ method: 'CREDITO', amount: 100 }], documentType: 'NOTA_VENTA', allowNegativeStock: false } as never)
  check('>>> el mismo CAJERO con credito.otorgar activado por el dueño SÍ puede fiar', conPermiso.credito?.monto === 100)

  console.log('\nE) Atomicidad: la deuda nace y muere con la venta')
  const G = await cliente({ creditLimit: 1000 })
  const antesG = await foto(G.id)
  const sinStock = await code(vender(S1, G.id, [{ method: 'CREDITO', amount: 300 }], {}, 3, escaso.id))
  check('>>> si el stock falla DESPUÉS de crear la deuda, la deuda se deshace entera: sin cuenta, sin saldo, sin venta', sinStock === 'INSUFFICIENT_STOCK' && JSON.stringify(await foto(G.id)) === JSON.stringify(antesG))

  console.log('\nF) Reintento seguro del fiado')
  const kF = randomUUID()
  const F = await cliente({ creditLimit: 1000 })
  const f1 = await fiar(S1, F.id, 200, { idempotencyKey: kF })
  const f2 = await fiar(S1, F.id, 200, { idempotencyKey: kF })
  const f3 = await Promise.all([fiar(S2, F.id, 200, { idempotencyKey: kF }), fiar(S1, F.id, 200, { idempotencyKey: kF })])
  check('>>> el mismo envío repetido devuelve la misma venta con su fiado y NO duplica la deuda', f2.replayed && f2.saleId === f1.saleId && f2.credito?.monto === 200 && f3.every((r) => r.saleId === f1.saleId)
    && (await prisma.receivable.count({ where: { customerId: F.id } })) === 1 && num((await prisma.customer.findUniqueOrThrow({ where: { id: F.id } })).creditBalance) === 200)

  console.log('\nG) CONCURRENCIA: dos cajas, un cliente, una línea')
  const H = await cliente({ creditLimit: 300 })
  const stockAntes = await stockTotal()
  const tareas = [S1, S2, S1, S2, S1, S2, S1, S2].map((s) => fiar(s, H.id, 100))
  const rs = await Promise.allSettled(tareas)
  const ok = rs.filter((r) => r.status === 'fulfilled'), ko = rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  check('>>> 8 ventas fiadas de 100 a la vez, desde las dos sucursales, a un cliente con línea 300: pasan EXACTAMENTE 3', ok.length === 3, `${ok.length} pasaron / ${ko.length} rechazadas`)
  check('>>> las otras 5 se rechazan por la línea (CREDIT_LIMIT), no por un fallo raro (interbloqueo, timeout…)', ko.length === 5 && ko.every((r) => (r.reason as { code?: string }).code === 'CREDIT_LIMIT'), ko.map((r) => (r.reason as Error).message.slice(0, 50)).join(' | '))
  const hDeuda = num((await prisma.customer.findUniqueOrThrow({ where: { id: H.id } })).creditBalance)
  check('>>> la deuda quedó EXACTAMENTE en 300: nunca pasó la línea', hDeuda === 300, String(hDeuda))
  check('3 cuentas, 3 pagos de crédito y el stock bajó solo 3 (las rechazadas no tocaron nada)', (await prisma.receivable.count({ where: { customerId: H.id } })) === 3 && (await stockTotal()) === stockAntes - 3)

  console.log('\nH) Propiedad: una secuencia aleatoria de ventas, cambios de línea y bloqueos contra un modelo')
  const M = await cliente({ creditLimit: 1200 })
  let semilla = 20261126
  const azar = (n: number) => { semilla = (semilla * 1664525 + 1013904223) % 4294967296; return Math.floor((semilla / 4294967296) * n) }
  let limite = 1200, bloqueado = false, deudaModelo = 0, aceptadas = 0, rechazadas = 0, malas: string[] = []
  for (let i = 0; i < 45; i++) {
    const op = azar(10)
    if (op < 2) {
      limite = [0, 600, 1200, 2500, 4000][azar(5)]!
      await configurarCredito(dbO1, O1, configurarCreditoSchema.parse({ customerId: M.id, creditLimit: limite, creditTermDays: 30, bloqueado }))
    } else if (op === 2) {
      bloqueado = !bloqueado
      await configurarCredito(dbO1, O1, configurarCreditoSchema.parse({ customerId: M.id, creditLimit: limite, creditTermDays: 30, bloqueado }))
    } else {
      const monto = (1 + azar(3)) * 100
      const cabe = !bloqueado && limite > 0 && deudaModelo + monto <= limite
      const c = await code(fiar(azar(2) ? S1 : S2, M.id, monto))
      if (cabe ? c !== null : c === null) malas.push(`#${i} monto ${monto} deuda ${deudaModelo} línea ${limite} bloqueado ${bloqueado} → ${c}`)
      if (c === null) { deudaModelo += monto; aceptadas++ } else rechazadas++
    }
  }
  const mReal = await prisma.customer.findUniqueOrThrow({ where: { id: M.id } })
  check(`>>> 45 operaciones al azar: el sistema y un modelo independiente coinciden en CADA decisión (${aceptadas} fiadas, ${rechazadas} rechazadas)`, malas.length === 0 && aceptadas > 8 && rechazadas > 5, malas.slice(0, 2).join('; '))
  check('y la deuda final coincide con el modelo', num(mReal.creditBalance) === deudaModelo, `${mReal.creditBalance} vs ${deudaModelo}`)

  console.log('\nI) Coherencia global: la caché de deuda = Σ de las cuentas abiertas')
  const clientes = await prisma.customer.findMany({ where: { tenantId: t.id } })
  const cuentas = await prisma.receivable.findMany({ where: { tenantId: t.id, status: 'ABIERTA' } })
  const desfases = clientes.filter((c) => Math.abs(num(c.creditBalance) - cuentas.filter((r) => r.customerId === c.id).reduce((s, r) => s + num(r.amount) - num(r.paidAmount), 0)) > 1e-9)
  check(`>>> los ${clientes.length} clientes: creditBalance coincide con Σ (monto − abonado) de sus cuentas abiertas`, desfases.length === 0, desfases.map((c) => c.name).join(','))
  const ventasCredito = await prisma.payment.findMany({ where: { tenantId: t.id, method: 'CREDITO' } })
  const sumaPagos = ventasCredito.reduce((s, p) => s + num(p.amount), 0), sumaCuentas = (await prisma.receivable.findMany({ where: { tenantId: t.id } })).reduce((s, r) => s + num(r.amount), 0)
  check('>>> lo fiado en pagos (Σ líneas CREDITO) = lo registrado en cuentas por cobrar (Σ montos): ni deuda sin venta ni venta sin deuda', Math.abs(sumaPagos - sumaCuentas) < 1e-9 && ventasCredito.length === (await prisma.receivable.count({ where: { tenantId: t.id } })), `${sumaPagos} vs ${sumaCuentas}`)
  const deudores = await prisma.receivable.findMany({ where: { tenantId: t.id }, include: { sale: { select: { customerId: true } } } })
  check('>>> el deudor de cada cuenta es el cliente de su venta', deudores.every((r) => r.sale.customerId === r.customerId))

  console.log('\nJ) Aislamiento y estructura')
  const otro = await prisma.tenant.create({ data: { slug: `cs-x-${randomUUID().slice(0, 6)}`, name: 'Otro negocio', planId: plan.id } })
  const ajeno = await prisma.customer.create({ data: { tenantId: otro.id, name: 'Ajeno', docType: 'DNI', docNumber: '41235999', creditLimit: 9999 } })
  const antesX = await foto()
  check('>>> fiar a un cliente de OTRO negocio → rechazado, sin escribir nada', await code(fiar(S1, ajeno.id, 100)) === 'TENANT_MISMATCH' && JSON.stringify(await foto()) === JSON.stringify(antesX)
    && num((await prisma.customer.findUniqueOrThrow({ where: { id: ajeno.id } })).creditBalance) === 0)
  const svc = readFileSync('src/features/credito/credito-service.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  check('>>> otorgarCredito BLOQUEA al cliente antes de leer o crear nada', svc.indexOf('await bloquearCliente(t, input.customerId)') > 0 && svc.indexOf('await bloquearCliente(t, input.customerId)') < svc.indexOf('t.receivable.create'))
  check('el servicio no usa SQL crudo (pasa por el aislamiento por negocio)', !/\$queryRaw|\$executeRaw|\$queryRawUnsafe/.test(svc))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
