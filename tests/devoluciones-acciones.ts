import './guard'
import { readFileSync } from 'node:fs'
import { correr } from './teardown'
import { abrirTurno, asignarSucursal, cajaLibre, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { closeCashSession, openCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { anularOdevolverVenta as accion } from '../src/features/devoluciones/actions'
import { anularOdevolverVenta } from '../src/features/devoluciones/service'
import { anularOdevolverVentaSchema } from '../src/features/devoluciones/schemas'
import { getTicketCierre } from '../src/features/printing/cierre-caja'
import { PERMISOS_FUERA_DEL_PIN } from '../src/features/seguridad/pin-reglas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.1b · La acción de servidor (validación antes de la base, sin sesión no hace nada, revalida lo que cambia) y el ticket de cierre de caja
 * (quién lo ve, solo turnos cerrados, valores congelados, aislamiento por negocio y sucursal). La autorización de anular vive en el SERVICIO.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-da-${tag}-${randomUUID().slice(0, 6)}`, name: `Acciones ${tag}`, taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_da' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const todas = [b1.branch.id, b2.branch.id]
  const u: Record<string, TenantContext> = {}
  // OWNER2: F6.8b — una persona tiene un solo turno, así que la sucursal 2 la lleva otro dueño con el suyo.
  for (const clave of ['OWNER', 'OWNER2', 'ADMIN', 'CONTADOR', 'CAJERO', 'VENDEDOR', 'ALMACENERO']) {
    const role = (clave === 'OWNER2' ? 'OWNER' : clave) as Role
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${clave}-${randomUUID()}@x.com`.toLowerCase(), name: clave, role } })
    for (const b of todas) await asignarSucursal(t.id, x.id, b)
    u[clave] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: todas, permisosExtra: [] }
  }
  const solo = await prisma.user.create({ data: { tenantId: t.id, email: `solo-${randomUUID()}@x.com`, name: 'Solo B2', role: 'CAJERO' } })
  await asignarSucursal(t.id, solo.id, b2.branch.id)
  u.SOLO_B2 = { tenantId: t.id, userId: solo.id, role: 'CAJERO', access: 'FULL', branchId: b2.branch.id, branchIds: [b2.branch.id], permisosExtra: [] }
  const P1 = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Cemento', unitType: 'UNIDAD', salePrice: 100, costPrice: 61.37 } })
  for (const w of [b1.warehouse, b2.warehouse]) await prisma.stock.create({ data: { tenantId: t.id, productId: P1.id, warehouseId: w.id, quantity: 500 } })
  const db = (c: TenantContext) => getTenantPrisma(c)
  const O = u.OWNER!
  const sedes = { b1: { ctx: O, w: b1.warehouse.id }, b2: { ctx: { ...u.OWNER2!, branchId: b2.branch.id } as TenantContext, w: b2.warehouse.id } }
  const vender = (monto: number, sede: 'b1' | 'b2' = 'b1', metodo = 'EFECTIVO') => {
    const s = sedes[sede]
    return registerSale(db(s.ctx), s.ctx, registerSaleSchema.parse({ warehouseId: s.w, items: [{ productId: P1.id, quantity: monto / 100, discount: 0 }], payments: [{ method: metodo, amount: monto }], documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() }) as never)
  }
  const abrir = async (monto: number, sede: 'b1' | 'b2' = 'b1') => openCashSession(db(sedes[sede].ctx), sedes[sede].ctx, openCashSchema.parse({ openingAmount: monto, ...(await cajaLibre(t.id, sedes[sede].ctx.branchId!)) }))
  const cerrar = (id: string, contado: number, sede: 'b1' | 'b2' = 'b1') => closeCashSession(db(sedes[sede].ctx), sedes[sede].ctx, closeCashSchema.parse({ sessionId: id, countedAmount: contado }))
  const devolver = (saleId: string, ctx: TenantContext = O, over: Record<string, unknown> = {}) => anularOdevolverVenta(db(ctx), ctx, anularOdevolverVentaSchema.parse({ saleId, kind: 'DEVOLUCION', reason: 'Cliente devolvió', idempotencyKey: randomUUID(), ...over }))
  return { t, b1, b2, u, O, db, vender, abrir, cerrar, devolver }
}

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 300) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  console.log('\nA) La acción: validación y sin sesión')
  for (const [n, raw] of [['vacío', {}], ['sin motivo', { saleId: 'venta-1', kind: 'DEVOLUCION', reason: '', idempotencyKey: randomUUID() }], ['tipo desconocido', { saleId: 'venta-1', kind: 'REGALO', reason: 'x'.repeat(10), idempotencyKey: randomUUID() }], ['sin clave de idempotencia', { saleId: 'venta-1', kind: 'ANULACION', reason: 'Error de digitación' }], ['reembolso negativo', { saleId: 'venta-1', kind: 'ANULACION', reason: 'Error', idempotencyKey: randomUUID(), refunds: [{ mode: 'CAJA', method: 'EFECTIVO', amount: -5 }] }]] as const) {
    const r = await accion(raw)
    check(`>>> ${n}: VALIDATION, con mensaje, y sin tocar la base`, !r.ok && r.code === 'VALIDATION' && r.message.length > 0)
  }
  const ok = await accion({ saleId: 'venta-1', kind: 'ANULACION', reason: 'Error de digitación', idempotencyKey: randomUUID() })
  check('>>> datos válidos pero SIN sesión: devuelve un fallo tipado (no lanza ni opera)', !ok.ok)
  const fuente = readFileSync('src/features/devoluciones/actions.ts', 'utf8')
  check("la acción es 'use server', valida con zod ANTES de la sesión y no decide permisos (los decide el servicio)", fuente.startsWith("'use server'") && fuente.indexOf('safeParse') < fuente.indexOf('conTenant(') && !/puede\(|ventas\.anular|ctx\.role/.test(fuente.replace(/\/\*[\s\S]*?\*\//g, '')))
  check('>>> tras el éxito revalida ventas, el detalle, caja, inventario, reportes, comprobantes y cobranza', ['/ventas\'', '`/ventas/${p.data.saleId}`', '/caja', '/inventario', "'/reportes', 'layout'", '/comprobantes', '/cobranza'].every((x) => fuente.includes(x)) && fuente.indexOf('if (r.ok)') < fuente.indexOf("revalidatePath('/ventas')"))
  check('>>> y no revalida nada si falló', /if \(r\.ok\) \{[\s\S]*revalidatePath[\s\S]*\}\s*return r/.test(fuente))
  check('`ventas.anular` está fuera de la sesión de PIN (otra persona no anula con el PIN del cajero)', (PERMISOS_FUERA_DEL_PIN as readonly string[]).includes('ventas.anular'))

  console.log('\nB) Quién puede anular, a nivel de servicio')
  const A = await negocio('a')
  const t1 = await A.abrir(100)
  const tAdmin = await abrirTurno(A.t.id, A.u.ADMIN!.userId, A.b1.branch.id, { fondo: 20 })   // F6.8b: quien devuelve saca el efectivo de SU caja
  const s1 = await A.vender(200)
  for (const rol of ['ADMIN', 'CAJERO', 'CONTADOR', 'VENDEDOR', 'ALMACENERO'] as const) {
    const c = A.u[rol]!
    const antes = await prisma.saleReturn.count({ where: { tenantId: A.t.id } })
    const e = await code(A.devolver(s1.saleId, c))
    check(`>>> ${rol}: ${rol === 'ADMIN' ? 'puede (ventas.anular)' : 'NO puede'} anular`, rol === 'ADMIN' ? e === null : e === 'FORBIDDEN_ROLE', String(e))
    if (rol === 'ADMIN') break
    check(`${rol}: la venta sigue COMPLETADA y no se creó nada`, (await prisma.sale.findUniqueOrThrow({ where: { id: s1.saleId } })).status === 'COMPLETADA' && (await prisma.saleReturn.count({ where: { tenantId: A.t.id } })) === antes)
  }
  const s2 = await A.vender(100)
  const ro = { ...A.O, access: 'READ_ONLY' } as TenantContext
  const eRo = await code(A.devolver(s2.saleId, ro))
  check('>>> cuenta en SOLO LECTURA: no escribe (la venta sigue COMPLETADA)', eRo !== null && (await prisma.sale.findUniqueOrThrow({ where: { id: s2.saleId } })).status === 'COMPLETADA', String(eRo))
  const eAjena = await code(A.devolver(s2.saleId, A.u.SOLO_B2!))
  check('>>> un usuario de OTRA sucursal no puede anular una venta de la sucursal 1', eAjena !== null && (await prisma.sale.findUniqueOrThrow({ where: { id: s2.saleId } })).status === 'COMPLETADA', String(eAjena))

  console.log('\nC) Ticket de cierre de caja')
  const abierto = await code(getTicketCierre(A.db(A.O), A.O, t1.id))
  check('>>> un turno ABIERTO no se imprime (NOT_FOUND)', abierto === 'NOT_FOUND')
  // La devolución de s1 la hizo ADMIN arriba y salió de SU cajón, no del turno del dueño donde se cobró: el turno 1 cierra con todo el efectivo cobrado.
  const cierre = await A.cerrar(t1.id, 400)
  const tk = await getTicketCierre(A.db(A.O), A.O, t1.id)
  check('>>> el ticket trae lo congelado: fondo 100, cobrado 300 (dos ventas), devoluciones del cajón 0 (la sacó ADMIN de SU caja), esperado 400, contado 400, cuadra', tk.fondoInicial === 100 && tk.cobradoEfectivo === 300 && tk.devolucionesCajon === 0 && tk.devolucionesOtrosMedios === 0 && tk.esperado === cierre.expectedAmount && tk.esperado === 400 && tk.contado === 400 && tk.diferencia === 0 && /^CC-\d{8}-[A-Z0-9]{6}$/.test(tk.numero))
  check('>>> el efectivo de esa devolución salió del turno de ADMIN (200)', Number((await prisma.saleReturnRefund.aggregate({ where: { cashSessionId: tAdmin, mode: 'CAJA' }, _sum: { amount: true } }))._sum.amount ?? 0) === 200)
  check('>>> el ticket no contiene costos ni utilidad', !/cost|utilidad|margen/i.test(JSON.stringify(tk)))
  check('(estable) la reimpresión es idéntica', JSON.stringify(await getTicketCierre(A.db(A.O), A.O, t1.id)) === JSON.stringify(tk))
  for (const [rol, esperado] of [['OWNER', null], ['ADMIN', null], ['CONTADOR', null], ['VENDEDOR', 'FORBIDDEN_ROLE'], ['ALMACENERO', 'FORBIDDEN_ROLE']] as const) {
    const c = A.u[rol]!
    check(`>>> ${rol}: ${esperado === null ? 'puede' : 'NO puede'} ver el ticket de cierre`, (await code(getTicketCierre(A.db(c), c, t1.id))) === esperado)
  }
  const cajero = A.u.CAJERO!
  const t2 = await A.abrir(0)   // el dueño abre y cierra este otro turno
  await A.cerrar(t2.id, 0)
  check('>>> el cajero (sin caja.arqueo) NO ve el cierre de un turno que abrió y cerró OTRA persona', (await code(getTicketCierre(A.db(cajero), cajero, t2.id))) === 'NOT_FOUND')
  const t3 = await openCashSession(A.db(cajero), cajero, openCashSchema.parse({ openingAmount: 50, ...(await cajaLibre(A.t.id, cajero.branchId!)) }))
  await closeCashSession(A.db(cajero), cajero, closeCashSchema.parse({ sessionId: t3.id, countedAmount: 50 }))
  check('>>> pero SÍ ve el de su propio turno', (await code(getTicketCierre(A.db(cajero), cajero, t3.id))) === null)
  const B = await negocio('b')
  const tb = await B.abrir(10); await B.cerrar(tb.id, 10)
  check('>>> el ticket de un turno de OTRO negocio es NOT_FOUND', (await code(getTicketCierre(A.db(A.O), A.O, tb.id))) === 'NOT_FOUND')
  const tS2 = await A.abrir(20, 'b2'); await A.cerrar(tS2.id, 20, 'b2')
  const soloB1 = { ...A.u.CONTADOR!, branchIds: [A.b1.branch.id] } as TenantContext
  check('>>> y el de una sucursal que el usuario no tiene asignada también', (await code(getTicketCierre(A.db(soloB1), soloB1, tS2.id))) === 'NOT_FOUND')
  check('>>> un id inexistente da el mismo NOT_FOUND', (await code(getTicketCierre(A.db(A.O), A.O, 'no-existe-123456'))) === 'NOT_FOUND')

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
