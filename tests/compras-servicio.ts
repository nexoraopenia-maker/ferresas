import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { costoBase, costoTrasCompra, costoTrasDevolucion, igvDeCompra, totalDeLinea } from '../src/features/compras/costo'
import { anularCompraSchema, crearBorradorSchema, editarBorradorSchema, listarComprasSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { anularCompra, crearBorrador, editarBorrador, listarCompras, obtenerCompra, recibirCompra } from '../src/features/compras/service'
import { crearProveedor } from '../src/features/proveedores/service'
import { crearProveedorSchema } from '../src/features/proveedores/schemas'
import { crearPresentacion } from '../src/features/inventory/presentaciones-service'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 4, subpaso F4.3: compras. Ciclo BORRADOR → RECIBIDA → ANULADA.
 * Lo que más importa: recibir es TODO o NADA (stock + costo promedio sin IGV + deuda), recibir dos veces no duplica nada, el costo
 * promedio es el del conjunto sin importar el orden, y anular nunca deja stock en negativo ni borra una deuda con pagos.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => null).catch((e) => (e as Error).message)
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const cerca = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `co-${tag}-${randomUUID().slice(0, 6)}`, name: `Compras ${tag}`, taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_co' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
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
  const producto = (sku: string, o: Record<string, unknown> = {}) =>
    prisma.product.create({ data: { tenantId: t.id, sku, name: `Producto ${sku}`, unitType: 'UNIDAD', salePrice: 20, costPrice: 0, ...o } })
  const proveedor = async (o: Record<string, unknown> = {}) =>
    crearProveedor(dbOf(O), O, crearProveedorSchema.parse({ name: `Prov ${Math.random().toString(36).slice(2, 8)}`, taxId: ruc(), ...o }))
  const stockDe = async (productId: string, warehouseId = b1.warehouse.id) =>
    num((await prisma.stock.findFirst({ where: { tenantId: t.id, productId, warehouseId } }))?.quantity ?? 0)
  const costoDe = async (productId: string) => num((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).costPrice)
  const deudaDe = async (supplierId: string) => num((await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } })).payableBalance)
  const nuevo = (items: unknown[], o: Record<string, unknown> = {}) =>
    crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: b1.warehouse.id, items, ...o })
  const crear = (items: unknown[], o: Record<string, unknown> = {}, c: TenantContext = O) => crearBorrador(dbOf(c), c, nuevo(items, o))
  const recibir = (id: string, c: TenantContext = O) => recibirCompra(dbOf(c), c, recibirCompraSchema.parse({ purchaseId: id }))
  const anular = (id: string, c: TenantContext = O, motivo = 'Error de digitación') => anularCompra(dbOf(c), c, anularCompraSchema.parse({ purchaseId: id, motivo }))
  const L = (productId: string, cantidad: number | string, costo: number, extra: Record<string, unknown> = {}) => ({ productId, enteredQuantity: cantidad, unitCost: costo, ...extra })
  const estado = async (id: string) => (await prisma.purchase.findUniqueOrThrow({ where: { id } })).status
  return { t, b1, b2, ctxs, dbOf, O, producto, proveedor, stockDe, costoDe, deudaDe, crear, recibir, anular, nuevo, L, estado }
}
type E = Awaited<ReturnType<typeof negocio>>

/** SECS=AB,CDE… ejecuta solo esas secciones (para las mutaciones); sin SECS corre todo. */
const sec = (g: string) => !process.env.SECS || process.env.SECS.split(',').includes(g)

async function main() {
  if (sec('AB')) try {
  // ─── A) Matemática del costo ──────────────────────────────────────────────────────────────────────────────────────
  console.log('\nA) Costo promedio ponderado móvil (puro, exacto)')
  check('>>> 10 u a S/ 5 + 10 u a S/ 7 → 6.0000', costoTrasCompra({ stock: 10, costo: 5, cantidad: 10, valor: 70 }) === 6)
  check('>>> sin stock previo el costo es el de la compra', costoTrasCompra({ stock: 0, costo: 99, cantidad: 4, valor: 10 }) === 2.5)
  check('>>> un stock NEGATIVO no pesa (no hay unidades que valorar)', costoTrasCompra({ stock: -5, costo: 99, cantidad: 4, valor: 10 }) === 2.5)
  check('>>> costo actual 0 = «sin costo»: el stock existente no diluye el promedio', costoTrasCompra({ stock: 100, costo: 0, cantidad: 10, valor: 50 }) === 5)
  check('>>> redondea mitad hacia arriba a 4 decimales (10 u a 1.00 + 1 u a 1.0001... exacto en enteros)', costoTrasCompra({ stock: 2, costo: 1, cantidad: 1, valor: 1.01 }) === 1.0033)
  check('>>> el promedio no depende del orden de las compras', (() => {
    const a = costoTrasCompra({ stock: 10, costo: 5, cantidad: 10, valor: 70 })
    const a2 = costoTrasCompra({ stock: 20, costo: a, cantidad: 5, valor: 60 })
    const b = costoTrasCompra({ stock: 10, costo: 5, cantidad: 5, valor: 60 })
    const b2 = costoTrasCompra({ stock: 15, costo: b, cantidad: 10, valor: 70 })
    return cerca(a2, b2, 0.0002)
  })())
  check('>>> propiedad: 200 compras al azar → el costo siempre queda entre el mínimo y el máximo de lo pagado', (() => {
    for (let k = 0; k < 200; k++) {
      const s = Math.floor(Math.random() * 500), c = 1 + Math.floor(Math.random() * 90), q = 1 + Math.floor(Math.random() * 300), pu = 1 + Math.floor(Math.random() * 90)
      const r = costoTrasCompra({ stock: s, costo: c, cantidad: q, valor: q * pu })
      if (r < Math.min(c, pu) - 0.0001 || r > Math.max(c, pu) + 0.0001) return false
    }
    return true
  })())
  check('>>> devolver una compra restituye el costo anterior (ida y vuelta)', (() => {
    const despues = costoTrasCompra({ stock: 10, costo: 5, cantidad: 10, valor: 70 })
    return costoTrasDevolucion({ stock: 20, costo: despues, cantidad: 10, valor: 70 }) === 5
  })())
  check('>>> si la devolución deja el stock en 0 NO se toca el costo (null)', costoTrasDevolucion({ stock: 10, costo: 6, cantidad: 10, valor: 60 }) === null)
  check('>>> si la fórmula saldría negativa (costos editados a mano) NO se toca el costo', costoTrasDevolucion({ stock: 12, costo: 1, cantidad: 10, valor: 500 }) === null)
  check('>>> cantidad cero o negativa → error (no hay compra de nada)', (() => { try { costoTrasCompra({ stock: 1, costo: 1, cantidad: 0, valor: 1 }); return false } catch { return true } })())
  check('>>> total de línea: 3 cajas × 60.005 = 180.02 (mitad hacia arriba)', totalDeLinea(3, 60.005) === 180.02)
  check('>>> costo base = total / unidades base: 180.00 / 36 = 5.0000; 100 / 3 = 33.3333', costoBase(180, 36) === 5 && costoBase(100, 3) === 33.3333)
  check('>>> IGV sobre la BASE de cada tasa, no línea a línea: 3 × 0.05 al 18 % = 0.03, no 3 × 0.01', (() => {
    const r = igvDeCompra([{ total: 0.05, tasa: 0.18 }, { total: 0.05, tasa: 0.18 }, { total: 0.05, tasa: 0.18 }])
    return r.subtotal === 0.15 && r.igv === 0.03 && r.total === 0.18
  })())
  check('>>> mezcla de tasas (18 % y exonerado) suma por separado', (() => { const r = igvDeCompra([{ total: 100, tasa: 0.18 }, { total: 50, tasa: 0 }]); return r.subtotal === 150 && r.igv === 18 && r.total === 168 })())

  // ─── B) Esquemas ──────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nB) Esquemas')
  const base = { idempotencyKey: randomUUID(), warehouseId: 'w', items: [{ productId: 'p', enteredQuantity: 1, unitCost: 1 }] }
  check('>>> un borrador válido pasa; condición por defecto CONTADO', crearBorradorSchema.safeParse(base).data?.paymentCondition === 'CONTADO')
  check('>>> sin productos, sin clave o con clave que no es UUID → rechazado', !crearBorradorSchema.safeParse({ ...base, items: [] }).success && !crearBorradorSchema.safeParse({ ...base, idempotencyKey: undefined }).success && !crearBorradorSchema.safeParse({ ...base, idempotencyKey: 'x' }).success)
  check('>>> costo negativo, con 5 decimales o NaN → rechazado', [-1, 0.00001, NaN].every((c) => !crearBorradorSchema.safeParse({ ...base, items: [{ productId: 'p', enteredQuantity: 1, unitCost: c }] }).success))
  check('>>> el vencimiento exige AAAA-MM-DD; vacío cuenta como «sin dato»', !crearBorradorSchema.safeParse({ ...base, vence: '31/12/2026' }).success && crearBorradorSchema.safeParse({ ...base, vence: '' }).success)
  check('>>> anular exige motivo; recibir exige id; editar exige id; listar acota el límite', !anularCompraSchema.safeParse({ purchaseId: 'x', motivo: 'a' }).success && !recibirCompraSchema.safeParse({}).success && !editarBorradorSchema.safeParse(base).success && !listarComprasSchema.safeParse({ limite: 1000 }).success)

  } catch (x) { check(`>>> la sección AB terminó sin excepciones`, false, String((x as Error)?.message ?? x).slice(0, 200)) }
  if (sec('CDE')) try {
  // ─── C) Crear borrador ────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nC) Crear borrador')
  const e = await negocio('uno')
  const p1 = await e.producto('P1'); const p2 = await e.producto('P2', { taxRate: 0 })
  const sup = await e.proveedor({ paymentTermDays: 15 })
  const c1 = await e.crear([e.L(p1.id, 10, 5), e.L(p2.id, 4, 2.5)], { supplierId: sup.id, invoiceRef: 'F001-100' })
  const f1 = await prisma.purchase.findUniqueOrThrow({ where: { id: c1.id }, include: { items: true } })
  check('>>> nace en BORRADOR, con número correlativo y sin recibir', f1.status === 'BORRADOR' && /^[A-Z0-9]+-0*1$/.test(f1.number) && f1.receivedAt === null && f1.receivedById === null, f1.number)
  check('>>> totales: 10×5 + 4×2.5 = 60.00 base; IGV solo al producto gravado (50 × 18 % = 9.00); total 69.00', num(f1.subtotal) === 60 && num(f1.taxTotal) === 9 && num(f1.total) === 69)
  check('>>> el IGV NO entra al costo de la línea: costo base = 5.0000 y 2.5000', f1.items.some((i) => num(i.unitCost) === 5) && f1.items.some((i) => num(i.unitCost) === 2.5))
  check('>>> un borrador NO mueve stock, ni costos, ni deuda, ni movimientos', (await e.stockDe(p1.id)) === 0 && (await e.costoDe(p1.id)) === 0 && (await prisma.stockMovement.count({ where: { tenantId: e.t.id } })) === 0)
  const c2 = await e.crear([e.L(p1.id, 1, 5)])
  check('>>> el correlativo avanza de uno en uno', Number(c2.number.split('-')[1]) === Number(c1.number.split('-')[1]) + 1)
  const key = randomUUID()
  const r1 = await e.crear([e.L(p1.id, 1, 1)], { idempotencyKey: key }); const r2 = await e.crear([e.L(p1.id, 99, 99)], { idempotencyKey: key })
  check('>>> reintento con la MISMA clave devuelve la compra original (replayed) sin crear otra', r2.id === r1.id && r2.replayed && !r1.replayed && (await prisma.purchase.count({ where: { tenantId: e.t.id, idempotencyKey: key } })) === 1)
  const keyC = randomUUID()
  const seis = await Promise.all(Array.from({ length: 6 }, () => e.crear([e.L(p1.id, 1, 1)], { idempotencyKey: keyC }).catch((x) => ({ error: x.code ?? String(x) }))))
  check('>>> 6 envíos SIMULTÁNEOS de la misma clave → una sola compra y los 6 reciben su id', (await prisma.purchase.count({ where: { tenantId: e.t.id, idempotencyKey: keyC } })) === 1 && new Set(seis.map((x) => ('id' in x ? x.id : 'err'))).size === 1, JSON.stringify(seis.filter((x) => 'error' in x)))
  check('>>> el número del documento del proveedor no se repite (mismo proveedor)', await code(e.crear([e.L(p1.id, 1, 1)], { supplierId: sup.id, invoiceRef: 'F001-100' })) === 'DUPLICATE_CODE')
  check('>>> y lo dice la VALIDACIÓN (nombra la compra que ya lo tiene), no solo la restricción de la base', ((await msg(e.crear([e.L(p1.id, 1, 1)], { supplierId: sup.id, invoiceRef: 'F001-100' }))) ?? '').includes(`en la compra ${c1.number}`))
  check('>>> sí puede repetirse en OTRO proveedor', (await (async () => { const s2 = await e.proveedor(); return e.crear([e.L(p1.id, 1, 1)], { supplierId: s2.id, invoiceRef: 'F001-100' }) })()).id.length > 0)
  const ant = await prisma.documentCounter.findFirstOrThrow({ where: { tenantId: e.t.id, scope: 'PURCHASE' } })
  await code(e.crear([e.L(p1.id, 1, 1), e.L('no-existe', 1, 1)]))
  check('>>> si falla, el correlativo NO se quema (sin huecos)', (await prisma.documentCounter.findFirstOrThrow({ where: { tenantId: e.t.id, scope: 'PURCHASE' } })).next === ant.next)
  check('>>> producto inexistente → TENANT_MISMATCH', await code(e.crear([e.L('no-existe', 1, 1)])) === 'TENANT_MISMATCH')
  check('>>> producto sin control de stock → rechazado', await (async () => { const sv = await e.producto('SERV', { trackStock: false }); return code(e.crear([e.L(sv.id, 1, 1)])) })() === 'INVALID_DOCUMENT')
  check('>>> a crédito sin proveedor → rechazado', await code(e.crear([e.L(p1.id, 1, 1)], { paymentCondition: 'CREDITO' })) === 'INVALID_DOCUMENT')
  check('>>> proveedor de OTRO negocio → TENANT_MISMATCH', await (async () => { const o = await negocio('ajeno'); const sa = await o.proveedor(); return code(e.crear([e.L(p1.id, 1, 1)], { supplierId: sa.id })) })() === 'TENANT_MISMATCH')
  check('>>> almacén de OTRA sucursal → rechazado', await code(e.crear([e.L(p1.id, 1, 1)], { warehouseId: e.b2.warehouse.id })) === 'TENANT_MISMATCH')
  check('>>> vencimiento inexistente (31 de febrero) → rechazado', await code(e.crear([e.L(p1.id, 1, 1)], { supplierId: sup.id, paymentCondition: 'CREDITO', vence: '2026-02-31' })) === 'INVALID_DOCUMENT')
  const cc = await e.crear([e.L(p1.id, 1, 1)], { supplierId: sup.id, paymentCondition: 'CREDITO' })
  const dd = (await prisma.purchase.findUniqueOrThrow({ where: { id: cc.id } })).dueDate!
  const esperado = new Date(); esperado.setUTCDate(esperado.getUTCDate() + 15)
  check('>>> a crédito sin fecha: vence hoy + plazo del proveedor (15 días, ±1 por zona horaria)', Math.abs((dd.getTime() - esperado.getTime()) / 86_400_000) <= 1.01)
  const bajaS = await e.proveedor(); await prisma.supplier.update({ where: { id: bajaS.id }, data: { isActive: false, deletedAt: new Date() } })
  check('>>> proveedor dado de baja → rechazado', await code(e.crear([e.L(p1.id, 1, 1)], { supplierId: bajaS.id })) === 'INVALID_DOCUMENT')

  // ─── D) Presentaciones ────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nD) Compra por presentación (cajas)')
  const pc = await e.producto('PCAJA')
  const caja = await crearPresentacion(e.dbOf(e.O), e.O, { productId: pc.id, name: 'Caja x 12', unitType: 'CAJA', factor: '12' })
  const cp = await e.crear([e.L(pc.id, 3, 60, { presentationId: caja.id })])
  const ip = (await prisma.purchaseItem.findMany({ where: { purchaseId: cp.id } }))[0]!
  check('>>> 3 cajas × 12 = 36 unidades base; total 180.00; costo base 5.0000', num(ip.quantity) === 36 && num(ip.lineTotal) === 180 && num(ip.unitCost) === 5 && num(ip.enteredQuantity) === 3 && num(ip.presentationFactor) === 12)
  check('>>> presentación de otro producto → rechazada', await code(e.crear([e.L(p1.id, 1, 1, { presentationId: caja.id })])) === 'TENANT_MISMATCH')
  check('>>> fracción de caja (1.5 cajas, unidad CAJA entera) → rechazada', await code(e.crear([e.L(pc.id, 1.5, 60, { presentationId: caja.id })])) === 'INVALID_DOCUMENT')
  check('>>> unidades fraccionadas sin presentación (2.5 en UNIDAD) → rechazadas', await code(e.crear([e.L(p1.id, 2.5, 1)])) === 'INVALID_DOCUMENT')
  await recibirOk(e, cp.id)
  const mp = await prisma.stockMovement.findFirstOrThrow({ where: { tenantId: e.t.id, productId: pc.id } })
  check('>>> el movimiento guarda la presentación (3 cajas × 12) y cumple quantity = entered × factor', num(mp.quantity) === 36 && num(mp.enteredQuantity) === 3 && num(mp.presentationFactor) === 12 && mp.presentationId === caja.id)

  // ─── E) Editar borrador ───────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nE) Editar borrador')
  const ed = await e.crear([e.L(p1.id, 2, 10)], { invoiceRef: 'ED-1', supplierId: sup.id })
  await editarBorrador(e.dbOf(e.O), e.O, editarBorradorSchema.parse({ purchaseId: ed.id, warehouseId: e.b1.warehouse.id, supplierId: sup.id, invoiceRef: 'ED-2', items: [e.L(p1.id, 5, 4), e.L(p2.id, 1, 3)] }))
  const fe = await prisma.purchase.findUniqueOrThrow({ where: { id: ed.id }, include: { items: true } })
  check('>>> reemplaza las líneas y recalcula los totales (20 + 3 = 23 base; IGV 3.60)', fe.items.length === 2 && num(fe.subtotal) === 23 && num(fe.taxTotal) === 3.6 && num(fe.total) === 26.6 && fe.invoiceRef === 'ED-2')
  check('>>> conserva su número y su estado', fe.number === (await prisma.purchase.findUniqueOrThrow({ where: { id: ed.id } })).number && fe.status === 'BORRADOR')
  check('>>> editar NO choca con su propia factura al guardarla igual', await code(editarBorrador(e.dbOf(e.O), e.O, editarBorradorSchema.parse({ purchaseId: ed.id, warehouseId: e.b1.warehouse.id, supplierId: sup.id, invoiceRef: 'ED-2', items: [e.L(p1.id, 5, 4)] }))) === null)
  check('>>> editar con la factura de OTRA compra del proveedor → DUPLICATE_CODE', await code(editarBorrador(e.dbOf(e.O), e.O, editarBorradorSchema.parse({ purchaseId: ed.id, warehouseId: e.b1.warehouse.id, supplierId: sup.id, invoiceRef: 'F001-100', items: [e.L(p1.id, 5, 4)] }))) === 'DUPLICATE_CODE')
  await e.recibir(ed.id)
  check('>>> una compra RECIBIDA ya no se edita', await code(editarBorrador(e.dbOf(e.O), e.O, editarBorradorSchema.parse({ purchaseId: ed.id, warehouseId: e.b1.warehouse.id, items: [e.L(p1.id, 1, 1)] }))) === 'INVALID_DOCUMENT')
  check('>>> editar una compra inexistente → NOT_FOUND', await code(editarBorrador(e.dbOf(e.O), e.O, editarBorradorSchema.parse({ purchaseId: 'no-existe', warehouseId: e.b1.warehouse.id, items: [e.L(p1.id, 1, 1)] }))) === 'NOT_FOUND')

  } catch (x) { check(`>>> la sección CDE terminó sin excepciones`, false, String((x as Error)?.message ?? x).slice(0, 200)) }
  if (sec('FG')) try {
  // ─── F) Recibir al contado ────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nF) Recibir al contado')
  const e2 = await negocio('contado')
  const q1 = await e2.producto('Q1', { costPrice: 5 })
  await prisma.stock.create({ data: { tenantId: e2.t.id, productId: q1.id, warehouseId: e2.b1.warehouse.id, quantity: 10 } })
  const k1 = await e2.crear([e2.L(q1.id, 10, 7)])
  const rr = await e2.recibir(k1.id)
  check('>>> recibir: stock 10 + 10 = 20 y costo (10×5 + 70)/20 = 6.0000', (await e2.stockDe(q1.id)) === 20 && (await e2.costoDe(q1.id)) === 6)
  const fk = await prisma.purchase.findUniqueOrThrow({ where: { id: k1.id } })
  check('>>> pasa a RECIBIDA con quién y cuándo', fk.status === 'RECIBIDA' && fk.receivedById === e2.O.userId && fk.receivedAt !== null && !rr.replayed)
  const mk = await prisma.stockMovement.findFirstOrThrow({ where: { tenantId: e2.t.id, referenceId: k1.id } })
  check('>>> el movimiento es ENTRADA de origen COMPRA, referencia COMPRA→compra, con el costo base y sin «costo pendiente»', mk.type === 'ENTRADA' && mk.source === 'COMPRA' && mk.referenceType === 'COMPRA' && num(mk.unitCost) === 7 && mk.costPending === false && num(mk.quantity) === 10 && num(mk.balanceAfter) === 20)
  check('>>> al contado: sin cuenta por pagar y sin deuda', (await prisma.accountPayable.count({ where: { tenantId: e2.t.id } })) === 0 && rr.cuentaPorPagarId === null)
  const rep = await e2.recibir(k1.id)
  check('>>> recibir DE NUEVO devuelve replayed y NO duplica stock, movimientos ni costo', rep.replayed && (await e2.stockDe(q1.id)) === 20 && (await e2.costoDe(q1.id)) === 6 && (await prisma.stockMovement.count({ where: { tenantId: e2.t.id, referenceId: k1.id } })) === 1)
  const au = await prisma.auditLog.findFirst({ where: { tenantId: e2.t.id, action: 'compra.recibida', entityId: k1.id } })
  check('>>> la auditoría guarda el costo antes y después', JSON.stringify(au?.after).includes('"antes":5') && JSON.stringify(au?.after).includes('"despues":6'))
  const k2 = await e2.crear([e2.L(q1.id, 5, 4), e2.L(q1.id, 5, 6)])
  await e2.recibir(k2.id)
  check('>>> dos líneas del MISMO producto cuentan juntas: (20×6 + 20 + 30)/30 = 5.6667', (await e2.stockDe(q1.id)) === 30 && (await e2.costoDe(q1.id)) === 5.6667)
  const q0 = await e2.producto('Q0'); const k0 = await e2.crear([e2.L(q0.id, 3, 4)]); await e2.recibir(k0.id)
  check('>>> producto sin costo previo: queda con el de la compra', (await e2.costoDe(q0.id)) === 4)
  check('>>> recibir una compra inexistente → NOT_FOUND; una ANULADA → rechazada', await code(e2.recibir('no-existe')) === 'NOT_FOUND' && await (async () => { const a = await e2.crear([e2.L(q0.id, 1, 1)]); await e2.anular(a.id); return code(e2.recibir(a.id)) })() === 'INVALID_DOCUMENT')

  // ─── G) Recibir a crédito ─────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nG) Recibir a crédito')
  const sc = await e2.proveedor({ paymentTermDays: 30 }); const q2 = await e2.producto('Q2')
  const g1 = await e2.crear([e2.L(q2.id, 10, 10)], { supplierId: sc.id, paymentCondition: 'CREDITO', vence: '2027-03-15' })
  const rg = await e2.recibir(g1.id)
  const cx = await prisma.accountPayable.findFirstOrThrow({ where: { purchaseId: g1.id } })
  check('>>> nace UNA cuenta por pagar ABIERTA por el TOTAL con IGV (118.00), con el vencimiento indicado', num(cx.amount) === 118 && num(cx.paidAmount) === 0 && cx.status === 'ABIERTA' && cx.dueDate.toISOString().slice(0, 10) === '2027-03-15' && rg.cuentaPorPagarId === cx.id)
  check('>>> sube lo que se le debe al proveedor en el mismo total', (await e2.deudaDe(sc.id)) === 118)
  check('>>> el COSTO sigue siendo sin IGV (10.0000), aunque la deuda lleve IGV', (await e2.costoDe(q2.id)) === 10)
  await e2.recibir(g1.id)
  check('>>> recibir otra vez NO duplica la deuda ni la cuenta', (await e2.deudaDe(sc.id)) === 118 && (await prisma.accountPayable.count({ where: { purchaseId: g1.id } })) === 1)
  const g2 = await e2.crear([e2.L(q2.id, 1, 5)], { supplierId: sc.id, paymentCondition: 'CREDITO' }); await e2.recibir(g2.id)
  check('>>> la deuda del proveedor acumula varias compras (118 + 5.90 = 123.90)', (await e2.deudaDe(sc.id)) === 123.9)
  const g3 = await e2.crear([e2.L(q2.id, 1, 0)], { supplierId: sc.id, paymentCondition: 'CREDITO' })
  check('>>> a crédito con total 0 → rechazado al recibir, y la compra sigue en borrador', await code(e2.recibir(g3.id)) === 'INVALID_DOCUMENT' && (await e2.estado(g3.id)) === 'BORRADOR')
  const g4 = await e2.crear([e2.L(q2.id, 1, 5)], { supplierId: sc.id, paymentCondition: 'CREDITO' })
  await prisma.supplier.update({ where: { id: sc.id }, data: { isActive: false } })
  check('>>> si el proveedor se dio de baja entre el borrador y la recepción → rechazado, sin tocar stock', await code(e2.recibir(g4.id)) === 'INVALID_DOCUMENT' && (await e2.estado(g4.id)) === 'BORRADOR')
  await prisma.supplier.update({ where: { id: sc.id }, data: { isActive: true } })

  } catch (x) { check(`>>> la sección FG terminó sin excepciones`, false, String((x as Error)?.message ?? x).slice(0, 200)) }
  if (sec('H')) try {
  // ─── H) Atomicidad ────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nH) Todo o nada')
  const e3 = await negocio('atomico')
  const s3 = await e3.proveedor(); const a1 = await e3.producto('A1', { costPrice: 3 }); const a2 = await e3.producto('A2')
  const h1 = await e3.crear([e3.L(a1.id, 10, 9), e3.L(a2.id, 5, 2)], { supplierId: s3.id, paymentCondition: 'CREDITO' })
  await prisma.product.update({ where: { id: a2.id }, data: { deletedAt: new Date() } })   // la segunda línea fallará a mitad de la recepción
  const antes = { st: await e3.stockDe(a1.id), co: await e3.costoDe(a1.id), mov: await prisma.stockMovement.count({ where: { tenantId: e3.t.id } }), de: await e3.deudaDe(s3.id) }
  const fallo = await code(e3.recibir(h1.id))
  check('>>> falla la 2.ª línea → error de negocio', fallo === 'TENANT_MISMATCH', String(fallo))
  check('>>> y NADA quedó a medias: stock, costo, movimientos, deuda, cuenta por pagar y estado intactos', (await e3.stockDe(a1.id)) === antes.st && (await e3.costoDe(a1.id)) === antes.co && (await prisma.stockMovement.count({ where: { tenantId: e3.t.id } })) === antes.mov && (await e3.deudaDe(s3.id)) === antes.de && (await prisma.accountPayable.count({ where: { tenantId: e3.t.id } })) === 0 && (await e3.estado(h1.id)) === 'BORRADOR')
  check('>>> sin rastro en la auditoría de una recepción que no ocurrió', (await prisma.auditLog.count({ where: { tenantId: e3.t.id, action: 'compra.recibida' } })) === 0)

  } catch (x) { check(`>>> la sección H terminó sin excepciones`, false, String((x as Error)?.message ?? x).slice(0, 200)) }
  if (sec('I')) try {
  // ─── I) Concurrencia ──────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nI) Concurrencia')
  const e4 = await negocio('conc')
  const s4 = await e4.proveedor(); const b4 = await e4.producto('B4', { costPrice: 10 })
  await prisma.stock.create({ data: { tenantId: e4.t.id, productId: b4.id, warehouseId: e4.b1.warehouse.id, quantity: 10 } })
  const i1 = await e4.crear([e4.L(b4.id, 10, 20)], { supplierId: s4.id, paymentCondition: 'CREDITO' })
  const res = await Promise.all(Array.from({ length: 6 }, () => e4.recibir(i1.id).catch((x) => ({ error: x.code ?? String(x) }))))
  check('>>> 6 «recibir» SIMULTÁNEOS de la misma compra → el efecto ocurre UNA vez', (await e4.stockDe(b4.id)) === 20 && (await prisma.stockMovement.count({ where: { tenantId: e4.t.id, referenceId: i1.id } })) === 1 && (await prisma.accountPayable.count({ where: { purchaseId: i1.id } })) === 1 && (await e4.deudaDe(s4.id)) === 236 && (await e4.costoDe(b4.id)) === 15, JSON.stringify(res.filter((r) => 'error' in r)))
  check('>>> exactamente uno lo recibió de verdad; los demás recibieron replayed', res.filter((r) => 'replayed' in r && !r.replayed).length === 1 && res.filter((r) => 'replayed' in r && r.replayed).length === 5)
  const b5 = await e4.producto('B5'); const i2 = await e4.crear([e4.L(b5.id, 10, 10)]); const i3 = await e4.crear([e4.L(b5.id, 10, 20)])
  await Promise.all([e4.recibir(i2.id), e4.recibir(i3.id)])
  check('>>> dos compras SIMULTÁNEAS del mismo producto → stock 20 y costo promedio del conjunto (15.0000), no el de la última', (await e4.stockDe(b5.id)) === 20 && (await e4.costoDe(b5.id)) === 15)
  const b6 = await e4.producto('B6'); const i4 = await e4.crear([e4.L(b6.id, 10, 10)])
  const [rx, ax] = await Promise.all([e4.recibir(i4.id).catch((x) => ({ error: x.code })), e4.anular(i4.id).catch((x) => ({ error: x.code }))])
  const st = await e4.estado(i4.id); const stock6 = await e4.stockDe(b6.id)
  check('>>> «recibir» contra «anular» a la vez → resultado coherente: o queda ANULADA con stock 0, o RECIBIDA con 10 (nunca a medias)', (st === 'ANULADA' && stock6 === 0) || (st === 'RECIBIDA' && stock6 === 10), `${st} stock=${stock6} ${JSON.stringify([rx, ax])}`)
  const b7 = await e4.producto('B7'); const i5 = await e4.crear([e4.L(b7.id, 5, 10)]); await e4.recibir(i5.id)
  const an = await Promise.all(Array.from({ length: 4 }, () => e4.anular(i5.id).catch((x) => ({ error: x.code ?? String(x) }))))
  check('>>> 4 «anular» SIMULTÁNEOS → se devuelve el stock UNA sola vez', (await e4.stockDe(b7.id)) === 0 && (await prisma.stockMovement.count({ where: { tenantId: e4.t.id, referenceId: i5.id, type: 'DEVOLUCION_PROVEEDOR' } })) === 1 && an.filter((r) => 'replayed' in r && !r.replayed).length === 1, JSON.stringify(an.filter((r) => 'error' in r)))

  } catch (x) { check(`>>> la sección I terminó sin excepciones`, false, String((x as Error)?.message ?? x).slice(0, 200)) }
  if (sec('JKL')) try {
  // ─── J) Anular ────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nJ) Anular')
  const e5 = await negocio('anula')
  const s5 = await e5.proveedor(); const z1 = await e5.producto('Z1', { costPrice: 5 })
  await prisma.stock.create({ data: { tenantId: e5.t.id, productId: z1.id, warehouseId: e5.b1.warehouse.id, quantity: 10 } })
  const bor = await e5.crear([e5.L(z1.id, 1, 1)], { supplierId: s5.id, invoiceRef: 'ANU-1' })
  await e5.anular(bor.id, e5.ctxs.ALMACENERO_CON_COMPRAS!)
  const fb = await prisma.purchase.findUniqueOrThrow({ where: { id: bor.id } })
  check('>>> un BORRADOR se anula solo con «compras.registrar» (sin tocar stock ni costos)', fb.status === 'ANULADA' && fb.voidReason === 'Error de digitación' && fb.voidedById === e5.ctxs.ALMACENERO_CON_COMPRAS!.userId && (await e5.stockDe(z1.id)) === 10)
  check('>>> al anular, la factura queda libre para registrarse bien y el original se conserva en notas', fb.invoiceRef === null && (fb.notes ?? '').includes('ANU-1') && (await e5.crear([e5.L(z1.id, 1, 1)], { supplierId: s5.id, invoiceRef: 'ANU-1' })).id.length > 0)
  const ra = await e5.crear([e5.L(z1.id, 10, 7)], { supplierId: s5.id, paymentCondition: 'CREDITO' }); await e5.recibir(ra.id)
  check('(preparación) tras recibir: stock 20, costo 6, deuda 82.60', (await e5.stockDe(z1.id)) === 20 && (await e5.costoDe(z1.id)) === 6 && (await e5.deudaDe(s5.id)) === 82.6)
  check('>>> anular una RECIBIDA exige además «stock.ajustar» (sale mercadería): el almacenero con compras NO puede', await code(e5.anular(ra.id, e5.ctxs.ALMACENERO_CON_COMPRAS!)) === 'FORBIDDEN_ROLE' && (await e5.estado(ra.id)) === 'RECIBIDA')
  check('>>> con compras + ajustar sí puede', await (async () => { const x = await e5.crear([e5.L(z1.id, 1, 6)]); await e5.recibir(x.id); return code(e5.anular(x.id, e5.ctxs.ALMACENERO_CON_TODO!)) })() === null)
  const antesStock = await e5.stockDe(z1.id), antesCosto = await e5.costoDe(z1.id)
  const out = await e5.anular(ra.id)
  const mv = await prisma.stockMovement.findFirstOrThrow({ where: { tenantId: e5.t.id, referenceId: ra.id, type: 'DEVOLUCION_PROVEEDOR' } })
  check('>>> anular RECIBIDA: devuelve el stock como DEVOLUCION_PROVEEDOR (−10, origen COMPRA, referencia a la compra)', !out.replayed && (await e5.stockDe(z1.id)) === antesStock - 10 && num(mv.quantity) === -10 && mv.source === 'COMPRA' && mv.referenceType === 'COMPRA')
  check('>>> revierte el costo promedio (6.0000 → 5.0000)', antesCosto === 6 && (await e5.costoDe(z1.id)) === 5)
  const cxa = await prisma.accountPayable.findFirstOrThrow({ where: { purchaseId: ra.id } })
  check('>>> cierra la cuenta por pagar (ANULADA, con fecha y motivo) y baja la deuda del proveedor a 0', cxa.status === 'ANULADA' && cxa.voidedAt !== null && cxa.closedAt !== null && cxa.voidReason === 'Error de digitación' && (await e5.deudaDe(s5.id)) === 0)
  const fa = await prisma.purchase.findUniqueOrThrow({ where: { id: ra.id } })
  check('>>> la compra conserva cuándo y quién la recibió, y suma quién y cuándo la anuló', fa.status === 'ANULADA' && fa.receivedAt !== null && fa.receivedById !== null && fa.voidedAt !== null && fa.voidedById === e5.O.userId)
  check('>>> anular de nuevo → replayed, sin devolver el stock otra vez', (await e5.anular(ra.id)).replayed && (await prisma.stockMovement.count({ where: { tenantId: e5.t.id, referenceId: ra.id, type: 'DEVOLUCION_PROVEEDOR' } })) === 1)
  check('>>> la auditoría de la anulación guarda motivo, estado anterior y costos', await (async () => { const a = await prisma.auditLog.findFirst({ where: { tenantId: e5.t.id, action: 'compra.anulada', entityId: ra.id } }); return a?.reason === 'Error de digitación' && JSON.stringify(a.before).includes('RECIBIDA') && JSON.stringify(a.after).includes('costos') })())

  console.log('\nK) Anular: stock insuficiente (aunque la política permita negativos) y pagos')
  const z2 = await e5.producto('Z2'); const kz = await e5.crear([e5.L(z2.id, 10, 10)]); await e5.recibir(kz.id)
  await prisma.stock.updateMany({ where: { tenantId: e5.t.id, productId: z2.id }, data: { quantity: 4 } })   // se vendieron 6
  await prisma.tenant.update({ where: { id: e5.t.id }, data: { stockPolicy: 'PERMITIR_CON_ADVERTENCIA' } })
  const m0 = await prisma.stockMovement.count({ where: { tenantId: e5.t.id } })
  check('>>> con 4 en stock de 10 comprados → NO se puede anular (INSUFFICIENT_STOCK), AUN con política que permite negativos', await code(e5.anular(kz.id)) === 'INSUFFICIENT_STOCK')
  check('>>> y no quedó nada hecho: stock 4, costo, movimientos y estado intactos', (await e5.stockDe(z2.id)) === 4 && (await e5.costoDe(z2.id)) === 10 && (await prisma.stockMovement.count({ where: { tenantId: e5.t.id } })) === m0 && (await e5.estado(kz.id)) === 'RECIBIDA')
  check('>>> el mensaje dice cuánto falta', (await msg(e5.anular(kz.id)))?.includes('6') === true)
  await prisma.stock.updateMany({ where: { tenantId: e5.t.id, productId: z2.id }, data: { quantity: 10 } })
  check('>>> con el stock completo (10) sí se puede', await code(e5.anular(kz.id)) === null && (await e5.stockDe(z2.id)) === 0)
  await prisma.tenant.update({ where: { id: e5.t.id }, data: { stockPolicy: 'BLOQUEAR' } })
  const z3 = await e5.producto('Z3'); const ky = await e5.crear([e5.L(z3.id, 10, 10)], { supplierId: s5.id, paymentCondition: 'CREDITO' }); await e5.recibir(ky.id)
  const cxy = await prisma.accountPayable.findFirstOrThrow({ where: { purchaseId: ky.id } })
  const pago = await prisma.supplierPayment.create({ data: { tenantId: e5.t.id, supplierId: s5.id, branchId: e5.b1.branch.id, userId: e5.O.userId, method: 'TRANSFERENCIA', amount: 50 } })
  await prisma.supplierPaymentAllocation.create({ data: { tenantId: e5.t.id, supplierPaymentId: pago.id, payableId: cxy.id, amount: 50 } })
  await prisma.accountPayable.update({ where: { id: cxy.id }, data: { paidAmount: 50 } })
  await prisma.supplier.update({ where: { id: s5.id }, data: { payableBalance: { decrement: 50 } } })
  const deudaPrev = await e5.deudaDe(s5.id)
  check('>>> con un pago aplicado NO se puede anular (hay que anular el pago primero)', await code(e5.anular(ky.id)) === 'INVALID_DOCUMENT' && (await e5.estado(ky.id)) === 'RECIBIDA' && (await e5.stockDe(z3.id)) === 10 && (await e5.deudaDe(s5.id)) === deudaPrev)
  await prisma.accountPayable.update({ where: { id: cxy.id }, data: { paidAmount: 0 } })
  check('>>> aunque el monto pagado figure en 0, una APLICACIÓN existente también lo bloquea', await code(e5.anular(ky.id)) === 'INVALID_DOCUMENT')
  check('>>> anular una inexistente → NOT_FOUND; sin motivo el esquema la rechaza', await code(e5.anular('no-existe')) === 'NOT_FOUND' && !anularCompraSchema.safeParse({ purchaseId: 'x', motivo: ' ' }).success)

  // ─── L) Permisos, aislamiento y lectura ───────────────────────────────────────────────────────────────────────────
  console.log('\nL) Permisos, aislamiento y lectura')
  const X = await e5.crear([e5.L(z1.id, 1, 1)])
  for (const r of ['CAJERO', 'VENDEDOR', 'CONTADOR', 'ALMACENERO']) {
    const c = e5.ctxs[r]!
    check(`>>> ${r} (sin el permiso) no puede crear, editar, recibir ni anular`, (await Promise.all([e5.crear([e5.L(z1.id, 1, 1)], {}, c), e5.recibir(X.id, c), e5.anular(X.id, c), editarBorrador(e5.dbOf(c), c, editarBorradorSchema.parse({ purchaseId: X.id, warehouseId: e5.b1.warehouse.id, items: [e5.L(z1.id, 1, 1)] }))].map(code))).every((x) => x === 'FORBIDDEN_ROLE'))
  }
  check('>>> el ADMIN y el almacenero con «compras.registrar» sí registran', await code(e5.crear([e5.L(z1.id, 1, 1)], {}, e5.ctxs.ADMIN!)) === null && await code(e5.crear([e5.L(z1.id, 1, 1)], {}, e5.ctxs.ALMACENERO_CON_COMPRAS!)) === null)
  check('>>> ver las compras: dueño, admin y quien registra; no cajero, vendedor ni almacenero común; el CONTADOR todavía no (llega con las cuentas por pagar)', await (async () => {
    const ok = async (c: TenantContext) => (await code(listarCompras(e5.dbOf(c), c, listarComprasSchema.parse({})))) === null
    return (await ok(e5.O)) && (await ok(e5.ctxs.ADMIN!)) && (await ok(e5.ctxs.ALMACENERO_CON_COMPRAS!)) && !(await ok(e5.ctxs.CAJERO!)) && !(await ok(e5.ctxs.VENDEDOR!)) && !(await ok(e5.ctxs.ALMACENERO!))
  })())
  const ajeno = await negocio('ajeno2'); const pa = await ajeno.producto('AJ'); const ca = await ajeno.crear([ajeno.L(pa.id, 1, 1)])
  check('>>> la compra de OTRO negocio no existe: ni verla, ni recibirla, ni anularla, ni editarla', (await Promise.all([obtenerCompra(e5.dbOf(e5.O), e5.O, ca.id), e5.recibir(ca.id), e5.anular(ca.id)].map(code))).every((x) => x === 'NOT_FOUND'))
  check('>>> y la de otro negocio sigue en BORRADOR, intacta', (await ajeno.estado(ca.id)) === 'BORRADOR')
  check('>>> productos de otro negocio no se pueden comprar', await code(e5.crear([e5.L(pa.id, 1, 1)])) === 'TENANT_MISMATCH')
  const lista = await listarCompras(e5.dbOf(e5.O), e5.O, listarComprasSchema.parse({ estado: 'RECIBIDA' }))
  check('>>> la lista filtra por estado, trae proveedor y total, y jamás mezcla negocios', lista.filas.length > 0 && lista.filas.every((f) => f.status === 'RECIBIDA') && !lista.filas.some((f) => f.id === ca.id))
  const pag = await listarCompras(e5.dbOf(e5.O), e5.O, listarComprasSchema.parse({ limite: 2 }))
  const pag2 = await listarCompras(e5.dbOf(e5.O), e5.O, listarComprasSchema.parse({ limite: 2, cursor: pag.siguiente! }))
  check('>>> paginación por cursor sin repetir filas', pag.filas.length === 2 && pag.siguiente !== null && pag2.filas.every((f) => !pag.filas.some((g) => g.id === f.id)))
  const det = await obtenerCompra(e5.dbOf(e5.O), e5.O, ra.id)
  check('>>> el detalle trae líneas, cuenta por pagar y totales numéricos', det.items.length === 1 && det.accountPayable?.status === 'ANULADA' && det.total === 82.6 && det.items[0]!.quantity === 10)
  const busca = await listarCompras(e5.dbOf(e5.O), e5.O, listarComprasSchema.parse({ q: 'ANU-1' }))
  check('>>> buscar por documento del proveedor encuentra la compra', busca.filas.some((f) => f.invoiceRef === 'ANU-1'))

  } catch (x) { check(`>>> la sección JKL terminó sin excepciones`, false, String((x as Error)?.message ?? x).slice(0, 200)) }
  if (sec('M')) try {
  // ─── M) Estructura ────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nM) Estructura')
  const svc = readFileSync('src/features/compras/service.ts', 'utf8')
  const act = readFileSync('src/features/compras/actions.ts', 'utf8')
  const cuerpo = (n: string) => { const i = svc.indexOf(`export async function ${n}(`); const j = svc.indexOf('\nexport ', i + 10); return svc.slice(i, j < 0 ? undefined : j) }
  check('>>> recibir, anular y editar TOMAN la compra antes de leer su estado, sin SQL crudo', ['recibirCompra', 'anularCompra', 'editarBorrador'].every((f) => { const c = cuerpo(f); return c.includes('bloquearCompra(t,') && c.indexOf('bloquearCompra(t,') < c.indexOf('c.status') }) && !/\$queryRaw|\$executeRaw/.test(svc))
  check('>>> el orden de bloqueo es compra → proveedor → productos → stock, en recibir y en anular', ['recibirCompra', 'anularCompra'].every((f) => { const c = cuerpo(f); const a = c.indexOf('bloquearCompra(t,'), b = c.indexOf('bloquearProveedor(t,'), p = c.indexOf('fotografiar(t,'), s = c.indexOf('applyStockMovement('); return a < b && b < p && p < s }))
  check('>>> los productos se bloquean ORDENADOS por id (sin abrazos mortales entre compras)', /\[\.\.\.new Set\(productIds\)\]\.sort\(\)/.test(svc))
  check('>>> la entrada de stock pasa por applyStockMovement con origen COMPRA y la salida por DEVOLUCION_PROVEEDOR; nunca escribe Stock a mano', cuerpo('recibirCompra').includes("'COMPRA'") && cuerpo('anularCompra').includes("'DEVOLUCION_PROVEEDOR'") && !/t\.stock\.(update|create|upsert)/.test(svc))
  check('>>> anular tiene su propia guardia de stock negativo, independiente de la política del negocio', /balanceAfter < 0/.test(cuerpo('anularCompra')) && /INSUFFICIENT_STOCK/.test(cuerpo('anularCompra')))
  check('>>> anular comprueba pagos aplicados (monto pagado Y aplicaciones) antes de mover nada', (() => { const c = cuerpo('anularCompra'); return c.includes('paidAmount') && c.includes('supplierPaymentAllocation.count') && c.indexOf('supplierPaymentAllocation.count') < c.indexOf('applyStockMovement(') })())
  check('>>> el costo se calcula SIN IGV: usa lineTotal (base), no el total con impuesto', cuerpo('recibirCompra').includes('agruparPorProducto(items)') && /valor: g\.valor/.test(cuerpo('recibirCompra')) && !/taxTotal/.test(cuerpo('recibirCompra').split('costoTrasCompra')[1] ?? ''))
  check('>>> la deuda del proveedor se sube y baja con el MISMO monto de la cuenta por pagar', /payableBalance: \{ increment: total \}/.test(svc) && /payableBalance: \{ decrement: num\(cxp\.amount\) \}/.test(svc))
  check('>>> crear usa la clave de idempotencia y el correlativo se toma DENTRO de la transacción', /compraPorClave\(db, input\.idempotencyKey\)/.test(cuerpo('crearBorrador')) && cuerpo('crearBorrador').indexOf('$transaction') < cuerpo('crearBorrador').indexOf('claimNextNumber('))
  const cuerpoAccion = (n: string) => { const i = act.indexOf(`export async function ${n}(`); const j = act.indexOf('export async function', i + 10); return act.slice(i, j < 0 ? undefined : j) }
  const conEsquema: [string, string][] = [['crearBorrador', 'crearBorradorSchema'], ['editarBorrador', 'editarBorradorSchema'], ['recibirCompra', 'recibirCompraSchema'], ['anularCompra', 'anularCompraSchema'], ['listarCompras', 'listarComprasSchema'], ['verCompra', 'verCompraSchema']]
  check('>>> las acciones son "use server", validan con SU esquema antes de tocar nada, no deciden permisos y solo exportan 6 funciones', act.startsWith("'use server'") && act.includes('requireTenantContext') && !/puede\(|exigir\(/.test(act) && (act.match(/export async function/g) ?? []).length === 6 && !/export (const|let|class)/.test(act) && conEsquema.every(([n, esq]) => { const c = cuerpoAccion(n); return c.includes(`${esq}.safeParse(`) && /if \(!p\.success\) return invalida\(p\.error\)/.test(c) && c.indexOf('safeParse(') < c.indexOf('conTenant(') }))

  } catch (x) { check(`>>> la sección M terminó sin excepciones`, false, String((x as Error)?.message ?? x).slice(0, 200)) }
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

async function recibirOk(e: E, id: string) { await e.recibir(id) }
correr(main)
