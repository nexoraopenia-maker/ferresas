import './guard'
import { correr } from './teardown'
import { abrirTurno, asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { anularPagoSchema, previsualizarPagoSchema, registrarPagoSchema } from '../src/features/por-pagar/schemas'
import { anularPagoProveedor, previsualizarPago, registrarPagoProveedor } from '../src/features/por-pagar/pagos'
import { anularCompra, crearBorrador, recibirCompra } from '../src/features/compras/service'
import { anularCompraSchema, crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { crearProveedor } from '../src/features/proveedores/service'
import { crearProveedorSchema } from '../src/features/proveedores/schemas'
import { closeCashSession, currentCashSession, openCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 4, subpaso F4.4 (parte 1): pagos a proveedores y egreso de caja.
 * Lo que más importa: el efectivo que sale del cajón nunca lo deja en negativo, un pago repetido no paga dos veces, un turno cerrado no se
 * reescribe, y deuda, cuentas y caja cuadran siempre entre sí.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => null).catch((e) => (e as Error).message)
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `pp-${tag}-${randomUUID().slice(0, 6)}`, name: `PorPagar ${tag}`, taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_pp' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const ctxs: Record<string, TenantContext> = {}
  for (const r of ['OWNER', 'ADMIN', 'CAJERO', 'VENDEDOR', 'ALMACENERO', 'CONTADOR'] as Role[]) {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${r}-${randomUUID()}@x.com`.toLowerCase(), name: r, role: r } })
    await asignarSucursal(t.id, u.id, b1.branch.id)
    ctxs[r] = { tenantId: t.id, userId: u.id, role: r, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  }
  ctxs.ALMACENERO_CON_COMPRAS = { ...ctxs.ALMACENERO!, permisosExtra: ['compras.registrar'] }
  ctxs.ALMACENERO_CON_TODO = { ...ctxs.ALMACENERO!, permisosExtra: ['compras.registrar', 'stock.ajustar'] }
  const dbOf = (c: TenantContext) => getTenantPrisma(c)
  const O = ctxs.OWNER!
  const proveedor = () => crearProveedor(dbOf(O), O, crearProveedorSchema.parse({ name: `Prov ${Math.random().toString(36).slice(2, 8)}`, taxId: ruc() }))
  // Producto exonerado de IGV: el total de la compra es exactamente el costo tecleado.
  const producto = (sku: string) => prisma.product.create({ data: { tenantId: t.id, sku, name: `Producto ${sku}`, unitType: 'UNIDAD', salePrice: 20, costPrice: 0, taxRate: 0 } })
  /** Una compra a crédito RECIBIDA por el servicio real, por `monto` exacto. Devuelve la compra y su cuenta por pagar. */
  const credito = async (supplierId: string, monto: number, vence = '2027-06-01') => {
    const p = await producto(`P-${randomUUID().slice(0, 6)}`)
    const c = await crearBorrador(dbOf(O), O, crearBorradorSchema.parse({
      idempotencyKey: randomUUID(), warehouseId: b1.warehouse.id, supplierId, paymentCondition: 'CREDITO', vence,
      items: [{ productId: p.id, enteredQuantity: 1, unitCost: monto }],
    }))
    await recibirCompra(dbOf(O), O, recibirCompraSchema.parse({ purchaseId: c.id }))
    const cxp = await prisma.accountPayable.findFirstOrThrow({ where: { purchaseId: c.id } })
    return { compra: c, cxp }
  }
  const pagar = (supplierId: string, amount: number, method = 'TRANSFERENCIA', extra: Record<string, unknown> = {}, c: TenantContext = O) =>
    registrarPagoProveedor(dbOf(c), c, registrarPagoSchema.parse({ supplierId, amount, method, idempotencyKey: randomUUID(), ...extra }))
  const anular = (paymentId: string, c: TenantContext = O, motivo = 'Error de digitación') => anularPagoProveedor(dbOf(c), c, anularPagoSchema.parse({ paymentId, motivo }))
  const abrirCaja = (fondo: number, c: TenantContext = O) => openCashSession(dbOf(c), c, openCashSchema.parse({ openingAmount: fondo }))
  const cerrarCaja = (sessionId: string, contado: number, c: TenantContext = O) => closeCashSession(dbOf(c), c, closeCashSchema.parse({ sessionId, countedAmount: contado }))
  const esperado = async () => (await currentCashSession(dbOf(O), O))!.expectedAmount
  const deuda = async (id: string) => num((await prisma.supplier.findUniqueOrThrow({ where: { id } })).payableBalance)
  const cuenta = (id: string) => prisma.accountPayable.findUniqueOrThrow({ where: { id } })
  return { t, b1, ctxs, dbOf, O, proveedor, producto, credito, pagar, anular, abrirCaja, cerrarCaja, esperado, deuda, cuenta }
}
type E = Awaited<ReturnType<typeof negocio>>

/** SECS=ABCD,EFG,H,I,J,K ejecuta solo esos grupos (para las mutaciones); sin SECS corre todo. */
const sec = (g: string) => !process.env.SECS || process.env.SECS.split(',').includes(g)

async function main() {
  if (sec('ABCD')) try {
  // ─── A) Pago y reparto ────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nA) Pago y reparto (la más antigua primero)')
  const e = await negocio('uno')
  await e.abrirCaja(0) // F6.8b: todo pago, también por transferencia, entra al turno propio
  const s1 = await e.proveedor()
  const a = await e.credito(s1.id, 100, '2027-01-10'), b = await e.credito(s1.id, 200, '2027-02-10'), c3 = await e.credito(s1.id, 300, '2027-03-10')
  check('(preparación) deuda 600 en 3 cuentas', (await e.deuda(s1.id)) === 600)
  const p1 = await e.pagar(s1.id, 150, 'TRANSFERENCIA', { reference: 'OP-123' })
  check('>>> 150 se reparte: la 1.ª (100) queda PAGADA y la 2.ª paga 50', p1.reparto.length === 2 && p1.reparto[0]!.monto === 100 && p1.reparto[0]!.pagada && p1.reparto[1]!.monto === 50 && !p1.reparto[1]!.pagada && p1.reparto[1]!.saldoDespues === 150)
  const ca = await e.cuenta(a.cxp.id), cb = await e.cuenta(b.cxp.id), cc = await e.cuenta(c3.cxp.id)
  check('>>> las cuentas: PAGADA cerrada, ABIERTA con 50 pagados, y la 3.ª intacta', ca.status === 'PAGADA' && ca.closedAt !== null && num(ca.paidAmount) === 100 && cb.status === 'ABIERTA' && num(cb.paidAmount) === 50 && num(cc.paidAmount) === 0)
  check('>>> baja la deuda del proveedor en el mismo monto (600 → 450) y el resultado lo dice', (await e.deuda(s1.id)) === 450 && p1.deudaAntes === 600 && p1.deudaDespues === 450)
  const f1 = await prisma.supplierPayment.findUniqueOrThrow({ where: { id: p1.paymentId }, include: { allocations: true } })
  check('>>> el pago guarda método, referencia, quién y la suma de sus repartos = su monto', f1.method === 'TRANSFERENCIA' && f1.reference === 'OP-123' && f1.userId === e.O.userId && f1.allocations.reduce((x, y) => x + num(y.amount), 0) === 150 && f1.cashSessionId !== null)
  const au = await prisma.auditLog.findFirst({ where: { tenantId: e.t.id, action: 'proveedor.pago', entityId: p1.paymentId } })
  check('>>> queda en la auditoría con la deuda antes y después', JSON.stringify(au?.after).includes('"deudaAntes":600') && JSON.stringify(au?.after).includes('"deudaDespues":450'))

  console.log('\nB) Cuentas elegidas y rechazos')
  const p2 = await e.pagar(s1.id, 120, 'YAPE', { payableIds: [c3.cxp.id] })
  check('>>> con cuentas elegidas, el pago va SOLO a esas (la 3.ª paga 120)', p2.reparto.length === 1 && p2.reparto[0]!.payableId === c3.cxp.id && num((await e.cuenta(c3.cxp.id)).paidAmount) === 120 && num((await e.cuenta(b.cxp.id)).paidAmount) === 50)
  const antes = { d: await e.deuda(s1.id), n: await prisma.supplierPayment.count({ where: { tenantId: e.t.id } }) }
  check('>>> un pago mayor que la deuda (330 > 330+…: deuda 330) se rechaza', await code(e.pagar(s1.id, 330.01)) === 'INVALID_DOCUMENT')
  check('>>> un pago mayor que lo debido en las cuentas ELEGIDAS se rechaza (aunque el total del proveedor alcance)', await code(e.pagar(s1.id, 200, 'TRANSFERENCIA', { payableIds: [b.cxp.id] })) === 'INVALID_DOCUMENT')
  check('>>> cuenta que no es de ese proveedor / ya pagada / inexistente → rechazada', await code(e.pagar(s1.id, 10, 'TRANSFERENCIA', { payableIds: [a.cxp.id] })) === 'INVALID_DOCUMENT' && await code(e.pagar(s1.id, 10, 'TRANSFERENCIA', { payableIds: ['no-existe'] })) === 'INVALID_DOCUMENT')
  check('>>> y no se escribió NADA con esos rechazos', (await e.deuda(s1.id)) === antes.d && (await prisma.supplierPayment.count({ where: { tenantId: e.t.id } })) === antes.n)
  const sLimpio = await e.proveedor()
  check('>>> a un proveedor sin deuda no se le paga', await code(e.pagar(sLimpio.id, 10)) === 'INVALID_DOCUMENT')
  const pf = await e.pagar(s1.id, 330)
  check('>>> pagar EXACTO lo debido deja todo en cero y todas las cuentas PAGADAS', (await e.deuda(s1.id)) === 0 && pf.reparto.every((r) => r.pagada) && (await prisma.accountPayable.count({ where: { supplierId: s1.id, status: 'ABIERTA' } })) === 0)
  check('>>> esquema: CREDITO no es medio de pago, monto 0/negativo/3 decimales y clave sin UUID se rechazan', [{ method: 'CREDITO' }, { amount: 0 }, { amount: -5 }, { amount: 1.005 }, { idempotencyKey: 'x' }].every((o) => !registrarPagoSchema.safeParse({ supplierId: 's', method: 'EFECTIVO', amount: 10, idempotencyKey: randomUUID(), ...o }).success))

  console.log('\nC) Vista previa = lo que se registra')
  const s2 = await e.proveedor()
  const q1 = await e.credito(s2.id, 80, '2027-01-01'), q2 = await e.credito(s2.id, 70, '2027-02-01')
  const vp = await previsualizarPago(e.dbOf(e.O), e.O, previsualizarPagoSchema.parse({ supplierId: s2.id, amount: 100 }))
  const escrito = await e.pagar(s2.id, 100)
  check('>>> la vista previa dice exactamente lo que después se escribe (cuenta, monto, saldo, pagada)', JSON.stringify(vp.reparto.map((r) => [r.payableId, r.monto, r.saldoDespues, r.pagada])) === JSON.stringify(escrito.reparto.map((r) => [r.payableId, r.monto, r.saldoDespues, r.pagada])) && vp.deuda === 150)
  check('>>> la vista previa no escribe nada y avisa del sobrante', (await previsualizarPago(e.dbOf(e.O), e.O, previsualizarPagoSchema.parse({ supplierId: s2.id, amount: 999 }))).sobrante === 949 && (await e.deuda(s2.id)) === 50 && q1.cxp.id.length > 0 && q2.cxp.id.length > 0)

  // ─── D) Idempotencia ──────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nD) Idempotencia')
  const s3 = await e.proveedor(); await e.credito(s3.id, 500)
  const key = randomUUID()
  const i1 = await registrarPagoProveedor(e.dbOf(e.O), e.O, registrarPagoSchema.parse({ supplierId: s3.id, amount: 100, method: 'OTRO', idempotencyKey: key }))
  const i2 = await registrarPagoProveedor(e.dbOf(e.O), e.O, registrarPagoSchema.parse({ supplierId: s3.id, amount: 300, method: 'OTRO', idempotencyKey: key }))
  check('>>> el mismo envío repetido devuelve el pago original (replayed), no paga otra vez', i2.paymentId === i1.paymentId && i2.replayed && !i1.replayed && (await e.deuda(s3.id)) === 400 && i2.monto === 100)
  const keyC = randomUUID()
  const seis = await Promise.all(Array.from({ length: 6 }, () => registrarPagoProveedor(e.dbOf(e.O), e.O, registrarPagoSchema.parse({ supplierId: s3.id, amount: 50, method: 'OTRO', idempotencyKey: keyC })).catch((x) => ({ error: x.code ?? String(x) }))))
  check('>>> 6 envíos SIMULTÁNEOS de la misma clave → se paga UNA vez (deuda 350) y los 6 reciben el mismo pago', (await e.deuda(s3.id)) === 350 && (await prisma.supplierPayment.count({ where: { tenantId: e.t.id, idempotencyKey: keyC } })) === 1 && new Set(seis.map((x) => ('paymentId' in x ? x.paymentId : 'err'))).size === 1, JSON.stringify(seis.filter((x) => 'error' in x)))
  const dos = await Promise.all([e.pagar(s3.id, 200), e.pagar(s3.id, 200)].map((p) => p.catch((x) => ({ error: x.code }))))
  check('>>> dos pagos DISTINTOS a la vez que juntos superan la deuda (350): solo cabe uno; la deuda nunca queda negativa', dos.filter((x) => 'paymentId' in x).length === 1 && (await e.deuda(s3.id)) === 150, JSON.stringify(dos))

  } catch (x) { check(`>>> el grupo ABCD terminó sin excepciones`, false, String((x as Error)?.message ?? x).slice(0, 200)) }
  if (sec('EFG')) try {
  // ─── E) Efectivo y caja ───────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nE) Efectivo: sale del cajón')
  const e2 = await negocio('caja')
  const sc = await e2.proveedor()
  for (const m of [400, 300, 250, 200]) await e2.credito(sc.id, m)
  check('>>> pago en EFECTIVO sin turno propio abierto → CASH_REQUIRED (nada que pagar con el cajón cerrado)', await code(e2.pagar(sc.id, 50, 'EFECTIVO')) === 'CASH_REQUIRED' && (await e2.deuda(sc.id)) === 1150)
  check('>>> F6.8b: tampoco por TRANSFERENCIA: todo pago pasa por el turno de quien lo ejecuta', await code(e2.pagar(sc.id, 50, 'TRANSFERENCIA')) === 'CASH_REQUIRED' && (await e2.deuda(sc.id)) === 1150)
  const turno = await e2.abrirCaja(500)
  const pe = await e2.pagar(sc.id, 300, 'EFECTIVO')
  const fe = await prisma.supplierPayment.findUniqueOrThrow({ where: { id: pe.paymentId } })
  check('>>> pago en efectivo con turno: queda enlazado al turno y el esperado baja (500 → 200)', fe.cashSessionId === turno.id && (await e2.esperado()) === 200)
  const m0 = { d: await e2.deuda(sc.id), n: await prisma.supplierPayment.count({ where: { tenantId: e2.t.id } }) }
  check('>>> un efectivo mayor que lo que hay (250 > 200) se BLOQUEA, y el mensaje dice cuánto hay', await code(e2.pagar(sc.id, 250, 'EFECTIVO')) === 'INVALID_DOCUMENT' && ((await msg(e2.pagar(sc.id, 250, 'EFECTIVO'))) ?? '').includes('S/ 200.00'))
  check('>>> y el bloqueo no escribió nada (deuda, pagos y esperado iguales)', (await e2.deuda(sc.id)) === m0.d && (await prisma.supplierPayment.count({ where: { tenantId: e2.t.id } })) === m0.n && (await e2.esperado()) === 200)
  check('>>> por TRANSFERENCIA sí se puede pagar más de lo que hay en el cajón (no sale de ahí)', await code(e2.pagar(sc.id, 250, 'TRANSFERENCIA')) === null && (await e2.esperado()) === 200)
  const po = await prisma.supplierPayment.findFirstOrThrow({ where: { tenantId: e2.t.id, method: 'TRANSFERENCIA', amount: 250 } })
  check('>>> y queda enlazado al turno abierto (informativo) sin tocar el esperado', po.cashSessionId === turno.id)
  check('>>> pagar EXACTO lo que hay (200) se permite y deja el esperado en 0', await code(e2.pagar(sc.id, 200, 'EFECTIVO')) === null && (await e2.esperado()) === 0)
  check('>>> con la caja en 0, 0.01 más se bloquea', await code(e2.pagar(sc.id, 0.01, 'EFECTIVO')) === 'INVALID_DOCUMENT')

  console.log('\nE2) El turno cierra JUSTO entre la comprobación rápida y la transacción')
  {
    const e8 = await negocio('entremedias')
    const sx = await e8.proveedor(); await e8.credito(sx.id, 300)
    const t8 = await e8.abrirCaja(500)
    const real = e8.dbOf(e8.O)
    // Un cliente que, justo después de que el servicio vea el turno abierto, lo cierra de verdad: es el hueco que la comprobación rápida deja.
    let cerrado = false
    const conCierreEntreMedias = new Proxy(real, {
      get(objetivo, prop) {
        const v = (objetivo as never)[prop] as unknown
        if (prop !== 'cashSession') return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(objetivo) : v
        return new Proxy(v as object, {
          get(d, dp) {
            const f = (d as never)[dp] as unknown
            if (dp !== 'findFirst') return typeof f === 'function' ? (f as (...a: unknown[]) => unknown).bind(d) : f
            return async (...a: unknown[]) => {
              const r = await (f as (...a: unknown[]) => Promise<{ id: string } | null>).apply(d, a)
              if (!cerrado && r) { cerrado = true; await e8.cerrarCaja(r.id, 500) }
              return r
            }
          },
        })
      },
    }) as typeof real
    const antes8 = { d: await e8.deuda(sx.id), n: await prisma.supplierPayment.count({ where: { tenantId: e8.t.id } }) }
    const r8 = await registrarPagoProveedor(conCierreEntreMedias, e8.O, registrarPagoSchema.parse({ supplierId: sx.id, amount: 100, method: 'EFECTIVO', idempotencyKey: randomUUID() })).then(() => null).catch((x) => ({ code: x.code as string, message: (x as Error).message }))
    check('>>> el turno se cerró de verdad en ese hueco', cerrado && (await prisma.cashSession.findUniqueOrThrow({ where: { id: t8.id } })).status === 'CERRADA')
    check('>>> el pago en efectivo se rechaza con el mensaje de «abre la caja» (no con un error cualquiera) y no escribe nada', r8?.code === 'CASH_REQUIRED' && (r8?.message ?? '').includes('turno de caja') && (await e8.deuda(sx.id)) === antes8.d && (await prisma.supplierPayment.count({ where: { tenantId: e8.t.id } })) === antes8.n, JSON.stringify(r8))
  }

  console.log('\nF) Dos pagos en efectivo a la vez')
  const e3 = await negocio('carrera')
  const sd = await e3.proveedor(); await e3.credito(sd.id, 400); await e3.credito(sd.id, 400)
  const t3 = await e3.abrirCaja(500)
  const dosE = await Promise.all([e3.pagar(sd.id, 300, 'EFECTIVO'), e3.pagar(sd.id, 300, 'EFECTIVO')].map((p) => p.catch((x) => ({ error: x.code }))))
  check('>>> con 500 en caja, dos pagos simultáneos de 300: SOLO uno pasa (la caja no queda en negativo)', dosE.filter((x) => 'paymentId' in x).length === 1 && dosE.filter((x) => 'error' in x).length === 1 && (await e3.esperado()) === 200, JSON.stringify(dosE))

  console.log('\nG) Cierre de caja: la columna se congela')
  const sef = await prisma.supplierPayment.aggregate({ where: { cashSessionId: t3.id, voidedAt: null, method: 'EFECTIVO' }, _sum: { amount: true } })
  await e3.pagar(sd.id, 50, 'YAPE')
  const cierre = await e3.cerrarCaja(t3.id, 200)
  const ft = await prisma.cashSession.findUniqueOrThrow({ where: { id: t3.id } })
  check('>>> cierra con pagos en efectivo congelados (300) y por otros medios (50)', num(ft.supplierCashPaymentsTotal) === 300 && num(ft.supplierOtherPaymentsTotal) === 50 && cierre.supplierCashPaymentsTotal === 300 && cierre.supplierOtherPaymentsTotal === 50 && num(sef._sum.amount) === 300)
  check('>>> el esperado congelado RESTA el efectivo pagado (500 − 300 = 200) y la diferencia sale de ahí', num(ft.expectedAmount) === 200 && num(ft.difference) === 0 && cierre.expectedAmount === 200)
  const auC = await prisma.auditLog.findFirst({ where: { tenantId: e3.t.id, action: 'cash.close', entityId: t3.id } })
  check('>>> la auditoría del cierre guarda los pagos a proveedores', JSON.stringify(auC?.after).includes('"pagosProveedorEfectivo":300'))
  check('>>> tras el cierre, un pago en efectivo ya no encuentra turno (sin caja abierta)', await code(e3.pagar(sd.id, 10, 'EFECTIVO')) === 'CASH_REQUIRED')
  const idEf = (await prisma.supplierPayment.findFirstOrThrow({ where: { cashSessionId: t3.id, method: 'EFECTIVO' } })).id
  check('>>> un pago de un turno CERRADO no se anula (el arqueo firmado no se reescribe)', await code(e3.anular(idEf)) === 'INVALID_DOCUMENT' && !(await prisma.supplierPayment.findUniqueOrThrow({ where: { id: idEf } })).voidedAt)
  check('>>> y lo congelado sigue igual después del intento', num((await prisma.cashSession.findUniqueOrThrow({ where: { id: t3.id } })).supplierCashPaymentsTotal) === 300)

  console.log('\nG2) Cierre contra pago a la vez')
  const e4 = await negocio('cierre')
  const se = await e4.proveedor(); await e4.credito(se.id, 1000)
  const t4 = await e4.abrirCaja(500)
  const [rp, rc] = await Promise.all([e4.pagar(se.id, 200, 'EFECTIVO').catch((x) => ({ error: x.code })), e4.cerrarCaja(t4.id, 500).catch((x) => ({ error: x.code }))])
  const t4f = await prisma.cashSession.findUniqueOrThrow({ where: { id: t4.id } })
  const enlazado = await prisma.supplierPayment.aggregate({ where: { cashSessionId: t4.id, voidedAt: null, method: 'EFECTIVO' }, _sum: { amount: true } })
  check('>>> el turno quedó CERRADO y lo congelado = lo enlazado (el pago entró entero o no entró; nunca se cuela después)', t4f.status === 'CERRADA' && num(t4f.supplierCashPaymentsTotal) === (num(enlazado._sum.amount ?? 0)) && num(t4f.expectedAmount) === 500 - num(enlazado._sum.amount ?? 0), JSON.stringify([rp, 'paymentId' in rc ? 'cierre' : rc]))

  } catch (x) { check(`>>> el grupo EFG terminó sin excepciones`, false, String((x as Error)?.message ?? x).slice(0, 200)) }
  if (sec('H')) try {
  // ─── H) Anular pago ───────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nH) Anular un pago')
  const e5 = await negocio('anula')
  const sf = await e5.proveedor(); const x1 = await e5.credito(sf.id, 100, '2027-01-01'), x2 = await e5.credito(sf.id, 200, '2027-02-01')
  await e5.abrirCaja(1000)
  const pg = await e5.pagar(sf.id, 150, 'EFECTIVO')
  check('(preparación) caja 850, deuda 150, 1.ª PAGADA', (await e5.esperado()) === 850 && (await e5.deuda(sf.id)) === 150 && (await e5.cuenta(x1.cxp.id)).status === 'PAGADA')
  check('>>> anular exige motivo y permiso: el cajero no puede; el dueño sí', await code(e5.anular(pg.paymentId, e5.ctxs.CAJERO!)) === 'FORBIDDEN_ROLE' && !anularPagoSchema.safeParse({ paymentId: 'x', motivo: ' ' }).success)
  const an = await e5.anular(pg.paymentId)
  const cx1 = await e5.cuenta(x1.cxp.id), cx2 = await e5.cuenta(x2.cxp.id)
  check('>>> restituye la deuda (150 → 300), reabre la PAGADA y deja los pagados en 0', an.deudaDespues === 300 && (await e5.deuda(sf.id)) === 300 && cx1.status === 'ABIERTA' && cx1.closedAt === null && num(cx1.paidAmount) === 0 && num(cx2.paidAmount) === 0)
  const fp = await prisma.supplierPayment.findUniqueOrThrow({ where: { id: pg.paymentId } })
  check('>>> el pago se CONSERVA marcado con quién, cuándo y por qué (nunca se borra)', fp.voidedAt !== null && fp.voidedById === e5.O.userId && fp.voidReason === 'Error de digitación')
  check('>>> el efectivo vuelve al cajón (el esperado sube a 1000)', (await e5.esperado()) === 1000)
  const rep = await e5.anular(pg.paymentId)
  check('>>> anular de nuevo → replayed, sin restituir dos veces', rep.replayed && (await e5.deuda(sf.id)) === 300)
  check('>>> un pago inexistente → NOT_FOUND', await code(e5.anular('no-existe')) === 'NOT_FOUND')
  const seis2 = await e5.pagar(sf.id, 100, 'EFECTIVO')
  const cuatro = await Promise.all(Array.from({ length: 4 }, () => e5.anular(seis2.paymentId).catch((x) => ({ error: x.code }))))
  check('>>> 4 anulaciones SIMULTÁNEAS del mismo pago → se restituye UNA vez', (await e5.deuda(sf.id)) === 300 && cuatro.filter((x) => 'replayed' in x && !x.replayed).length === 1, JSON.stringify(cuatro.filter((x) => 'error' in x)))

  } catch (x) { check(`>>> el grupo H terminó sin excepciones`, false, String((x as Error)?.message ?? x).slice(0, 200)) }
  if (sec('I')) try {
  console.log('\nI) Con las compras (F4.3)')
  const e6 = await negocio('compras')
  await e6.abrirCaja(0)
  const sg = await e6.proveedor(); const y1 = await e6.credito(sg.id, 100)
  const pagoY = await e6.pagar(sg.id, 40)
  const anularC = () => anularCompra(e6.dbOf(e6.O), e6.O, anularCompraSchema.parse({ purchaseId: y1.compra.id, motivo: 'Me equivoqué' }))
  check('>>> con un pago VIGENTE no se puede anular la compra', await code(anularC()) === 'INVALID_DOCUMENT')
  await e6.anular(pagoY.paymentId)
  check('>>> con el pago ANULADO sí (su reparto queda de historial pero ya no cuenta)', await code(anularC()) === null && (await e6.deuda(sg.id)) === 0)
  check('>>> y no se puede pagar una cuenta de una compra anulada', await code(e6.pagar(sg.id, 10)) === 'INVALID_DOCUMENT')

  } catch (x) { check(`>>> el grupo I terminó sin excepciones`, false, String((x as Error)?.message ?? x).slice(0, 200)) }
  if (sec('J')) try {
  // ─── J) Permisos y aislamiento ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nJ) Permisos y aislamiento')
  const e7 = await negocio('permisos')
  await e7.abrirCaja(0); await abrirTurno(e7.t.id, e7.ctxs.ADMIN!.userId, e7.b1.branch.id)
  const sh = await e7.proveedor(); await e7.credito(sh.id, 1000)
  for (const r of ['CAJERO', 'VENDEDOR', 'ALMACENERO', 'ALMACENERO_CON_COMPRAS', 'ALMACENERO_CON_TODO', 'CONTADOR']) {
    check(`>>> ${r} no puede pagar a un proveedor`, await code(e7.pagar(sh.id, 10, 'TRANSFERENCIA', {}, e7.ctxs[r]!)) === 'FORBIDDEN_ROLE')
  }
  check('>>> el ADMIN sí paga (de fábrica)', await code(e7.pagar(sh.id, 10, 'TRANSFERENCIA', {}, e7.ctxs.ADMIN!)) === null)
  check('>>> la vista previa también exige el permiso', await code(previsualizarPago(e7.dbOf(e7.ctxs.CAJERO!), e7.ctxs.CAJERO!, previsualizarPagoSchema.parse({ supplierId: sh.id, amount: 5 }))) === 'FORBIDDEN_ROLE')
  const aj = await negocio('ajeno'); await aj.abrirCaja(0); const sAj = await aj.proveedor(); const cAj = await aj.credito(sAj.id, 100)
  const pAj = await aj.pagar(sAj.id, 10)
  check('>>> el proveedor de OTRO negocio no existe: ni pagarle, ni previsualizar, ni anular sus pagos', (await Promise.all([e7.pagar(sAj.id, 5), previsualizarPago(e7.dbOf(e7.O), e7.O, previsualizarPagoSchema.parse({ supplierId: sAj.id, amount: 5 })), e7.anular(pAj.paymentId)].map(code))).every((x) => x === 'NOT_FOUND' || x === 'TENANT_MISMATCH'))
  check('>>> una cuenta de OTRO negocio no se puede elegir', await code(e7.pagar(sh.id, 5, 'TRANSFERENCIA', { payableIds: [cAj.cxp.id] })) === 'INVALID_DOCUMENT')
  check('>>> y lo del otro negocio sigue intacto', (await aj.deuda(sAj.id)) === 90)

  } catch (x) { check(`>>> el grupo J terminó sin excepciones`, false, String((x as Error)?.message ?? x).slice(0, 200)) }
  if (sec('K')) try {
  // ─── K) Estructura ────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nK) Estructura')
  const pag = readFileSync('src/features/por-pagar/pagos.ts', 'utf8')
  const act = readFileSync('src/features/por-pagar/actions.ts', 'utf8')
  const cash = readFileSync('src/features/branches/cash-service.ts', 'utf8')
  const cuerpo = (src: string, n: string) => { const i = src.indexOf(`function ${n}(`); const j = src.indexOf('\nexport ', i + 10); return src.slice(i, j < 0 ? undefined : j) }
  const reg = cuerpo(pag, 'registrarPagoProveedor'), anu = cuerpo(pag, 'anularPagoProveedor')
  check('>>> registrar y anular BLOQUEAN al proveedor antes que al turno, y al turno antes de escribir; sin SQL crudo',
    reg.indexOf('bloquearProveedor(t,') > 0 && reg.indexOf('bloquearProveedor(t,') < reg.indexOf('bloquearTurnoPropio(') && anu.indexOf('bloquearProveedor(t,') > 0 && anu.indexOf('bloquearProveedor(t,') < anu.indexOf('bloquearTurno(') && reg.indexOf('bloquearTurnoPropio(') < reg.indexOf('supplierPayment.create') && !/\$queryRaw|\$executeRaw/.test(pag))
  check('>>> el límite de efectivo se calcula con el MISMO esperado del cierre (efectivoEsperado + totalesDelTurno), con el turno ya bloqueado', reg.indexOf('bloquearTurnoPropio(') < reg.indexOf('efectivoEsperado(') && reg.includes('totalesDelTurno(t,'))
  check('>>> el reparto usa la misma función pura que la vista previa (repartirAbono)', reg.includes('repartirAbono(') && cuerpo(pag, 'previsualizarPago').includes('repartirAbono('))
  check('>>> la deuda del proveedor solo se escribe con decrement (pagar) e increment (anular)', /payableBalance: \{ decrement: deCentimos\(M\) \}/.test(reg) && /payableBalance: \{ increment: deCentimos\(restituido\) \}/.test(anu) && (pag.replace(/payableBalance: true/g, '').match(/payableBalance:/g) ?? []).length === 2)
  check('>>> pagar exige proveedores.pagar; anular también; la vista previa también', [reg, anu, cuerpo(pag, 'previsualizarPago')].every((c) => c.includes("exigir(ctx, 'proveedores.pagar')")))
  check('>>> el cierre de caja suma los pagos NO anulados del turno y congela las dos columnas', cuerpo(cash, 'totalesDelTurno').includes('supplierPayment.findMany') && cuerpo(cash, 'totalesDelTurno').includes('voidedAt: null') && /supplierCashPaymentsTotal: new Prisma\.Decimal/.test(cuerpo(cash, 'closeCashSession')) && /supplierOtherPaymentsTotal: new Prisma\.Decimal/.test(cuerpo(cash, 'closeCashSession')))
  check('>>> el esperado RESTA el efectivo pagado a proveedores', /- t\.supplierCashPaymentsTotal/.test(cuerpo(cash, 'efectivoEsperado')))
  const cuerpoAccion = (n: string) => { const i = act.indexOf(`export async function ${n}(`); const j = act.indexOf('export async function', i + 10); return act.slice(i, j < 0 ? undefined : j) }
  const conEsquema: [string, string][] = [['registrarPagoProveedor', 'registrarPagoSchema'], ['anularPagoProveedor', 'anularPagoSchema'], ['previsualizarPagoProveedor', 'previsualizarPagoSchema'], ['estadoDeCuentaDelProveedor', 'estadoCuentaProveedorSchema'], ['descargarEstadoCuentaProveedorCsv', 'estadoCuentaProveedorSchema']]
  check('>>> las acciones son "use server", validan con SU esquema antes de tocar nada, no deciden permisos y solo exportan funciones async', act.startsWith("'use server'") && act.includes('requireTenantContext') && !/puede\(|exigir\(/.test(act) && !/export (const|let|class)/.test(act) && conEsquema.every(([n, esq]) => { const c = cuerpoAccion(n); return c.includes(`${esq}.safeParse(`) && /if \(!p\.success\) return invalida\(p\.error\)/.test(c) && c.indexOf('safeParse(') < c.indexOf('conTenant(') }))

  } catch (x) { check(`>>> el grupo K terminó sin excepciones`, false, String((x as Error)?.message ?? x).slice(0, 200)) }
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
