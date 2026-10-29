import './guard'
import { readFileSync } from 'node:fs'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen, abrirTurno } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { registrarAbono } from '../src/features/credito/credito-service'
import { registrarAbonoSchema } from '../src/features/credito/schemas'
import { devolverProductos as accion } from '../src/features/devoluciones/actions'
import { devolverProductosVenta, diagnosticarDevolucionParcial } from '../src/features/devoluciones/parcial-service'
import { diagnosticarDevolucion } from '../src/features/devoluciones/service'
import { devolverProductosSchema } from '../src/features/devoluciones/schemas'
import { permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'
import { PERMISOS } from '../src/lib/permisos'
import { listarVentas, obtenerVenta } from '../src/features/ventas/service'
import { parametrosVentasListaSchema } from '../src/features/ventas/schemas'
import { calcularDevolucionParcial } from '../src/features/ventas/devolucion-parcial'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.2c · La acción de servidor y lo que las pantallas leen, contra la base: validación, sesión, PIN de operador, permisos, errores accionables
 * (tope exacto, lo que queda por devolver), estado «Devolución parcial» → DEVUELTA, progreso por línea, historial con destinos y notas, aviso de 30 días,
 * que el cálculo EN VIVO de la pantalla coincide con el del servidor y que nada de esto lleva costos.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const err = (p: Promise<unknown>) => p.then(() => null).catch((e) => e as { code?: string; message: string })
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const D = (s: string) => new Date(s)

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 400) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-dpa-${randomUUID().slice(0, 6)}`, name: 'Acciones parciales', taxId: ruc(), planId: plan.id, realBillingEnabledAt: D('2026-01-01T00:00:00Z') } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_dpa' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ADMIN', 'CONTADOR', 'CAJERO', 'VENDEDOR'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, x.id, b1.branch.id)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  }
  const O = u.OWNER!
  await abrirTurno(t.id, O.userId, b1.branch.id)
  await abrirTurno(t.id, u.ADMIN!.userId, b1.branch.id)
  const db = (c: TenantContext) => getTenantPrisma(c)
  const P1 = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Cemento', unitType: 'UNIDAD', salePrice: 100, costPrice: 37.7311 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: P1.id, warehouseId: b1.warehouse.id, quantity: 500 } })
  const cliente = await prisma.customer.create({ data: { tenantId: t.id, name: 'Constructora SAC', docType: 'RUC', docNumber: ruc(), creditLimit: 9000 } })
  const vender = (qty: number, payments: unknown[], over: Record<string, unknown> = {}) =>
    registerSale(db(O), O, registerSaleSchema.parse({ warehouseId: b1.warehouse.id, items: [{ productId: P1.id, quantity: qty, discount: 0 }], payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID(), ...over }) as never)
  const item = (saleId: string) => prisma.saleItem.findFirstOrThrow({ where: { saleId } })
  const devolver = (saleId: string, lines: { saleItemId: string; quantity: number; destination?: 'STOCK' | 'MERMA' }[], refunds?: unknown[], ctx: TenantContext = O) =>
    devolverProductosVenta(db(ctx), ctx, devolverProductosSchema.parse({ saleId, reason: 'Devolución de prueba', lines, idempotencyKey: randomUUID(), ...(refunds ? { refunds } : {}) }))
  const yape = (monto: number) => [{ mode: 'EXTERNO', method: 'YAPE', amount: monto }]

  console.log('\nA) La acción: validación, sesión y revisión del código')
  for (const [n, raw] of [
    ['vacío', {}], ['sin líneas', { saleId: 'v1', reason: 'abc', lines: [], idempotencyKey: randomUUID() }],
    ['cantidad cero', { saleId: 'v1', reason: 'abc', lines: [{ saleItemId: 'l1', quantity: 0 }], idempotencyKey: randomUUID() }],
    ['cantidad negativa', { saleId: 'v1', reason: 'abc', lines: [{ saleItemId: 'l1', quantity: -2 }], idempotencyKey: randomUUID() }],
    ['sin motivo', { saleId: 'v1', reason: '', lines: [{ saleItemId: 'l1', quantity: 1 }], idempotencyKey: randomUUID() }],
    ['sin clave de idempotencia', { saleId: 'v1', reason: 'abc', lines: [{ saleItemId: 'l1', quantity: 1 }] }],
    ['clave que no es UUID', { saleId: 'v1', reason: 'abc', lines: [{ saleItemId: 'l1', quantity: 1 }], idempotencyKey: 'x' }],
    ['destino inexistente', { saleId: 'v1', reason: 'abc', lines: [{ saleItemId: 'l1', quantity: 1, destination: 'BASURA' }], idempotencyKey: randomUUID() }],
  ] as const) {
    const r = await accion(raw)
    check(`>>> ${n}: VALIDATION con mensaje en español, antes de tocar la base`, !r.ok && r.code === 'VALIDATION' && r.message.length > 0)
  }
  const sinSesion = await accion({ saleId: 'v1', reason: 'abc', lines: [{ saleItemId: 'l1', quantity: 1 }], idempotencyKey: randomUUID() })
  check('>>> con datos válidos pero SIN sesión devuelve un fallo tipado (no lanza ni opera)', !sinSesion.ok)
  const fuente = readFileSync('src/features/devoluciones/actions.ts', 'utf8')
  const trozo = fuente.slice(fuente.indexOf('export async function devolverProductos'))
  check('>>> la acción valida con zod ANTES de la sesión, no decide permisos (los decide el servicio con `ventas.anular`) y revalida ventas, caja, inventario, reportes, comprobantes y cobranza solo si salió bien', trozo.indexOf('safeParse') < trozo.indexOf('conTenant(') && !/puede\(|ventas\.anular|ctx\.role/.test(trozo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')) && /if \(r\.ok\) \{[\s\S]*revalidatePath\('\/ventas'\)[\s\S]*revalidatePath\('\/caja'\)[\s\S]*revalidatePath\('\/inventario'\)[\s\S]*'\/reportes', 'layout'[\s\S]*'\/comprobantes'[\s\S]*'\/cobranza'/.test(trozo))

  console.log('\nB) Quién puede: permisos, PIN de operador y cuenta en solo lectura')
  const s1 = await vender(4, [{ method: 'EFECTIVO', amount: 400 }])
  const i1 = await item(s1.saleId)
  const foto = async () => ({ d: await prisma.saleReturn.count({ where: { tenantId: t.id } }), st: num((await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id } })).quantity), dev: num((await prisma.saleItem.findUniqueOrThrow({ where: { id: i1.id } })).returnedQuantity) })
  const f0 = await foto()
  const pin: TenantContext = { ...O, operadorDe: O.userId, permisosDenegados: permisosDenegadosAlOperador(new Set(PERMISOS)) }
  for (const [rol, c] of [['CAJERO', u.CAJERO!], ['CONTADOR', u.CONTADOR!], ['VENDEDOR', u.VENDEDOR!], ['OWNER con PIN de operador', pin]] as const) {
    const e = await code(devolver(s1.saleId, [{ saleItemId: i1.id, quantity: 1 }], yape(100), c)), d = await code(diagnosticarDevolucionParcial(db(c), c, s1.saleId))
    check(`>>> ${rol}: NO puede devolver productos ni diagnosticar (FORBIDDEN_ROLE) y no cambia nada`, e === 'FORBIDDEN_ROLE' && d === 'FORBIDDEN_ROLE' && JSON.stringify(await foto()) === JSON.stringify(f0), `${e}/${d}`)
  }
  const ro = { ...O, access: 'READ_ONLY' } as TenantContext
  check('>>> cuenta en SOLO LECTURA: no escribe', (await code(devolver(s1.saleId, [{ saleItemId: i1.id, quantity: 1 }], yape(100), ro))) !== null && JSON.stringify(await foto()) === JSON.stringify(f0))
  check('el administrador (ventas.anular) sí puede', (await code(devolver(s1.saleId, [{ saleItemId: i1.id, quantity: 1 }], yape(100), u.ADMIN!))) === null)

  console.log('\nC) Errores accionables')
  const e1 = await err(devolver(s1.saleId, [{ saleItemId: i1.id, quantity: 5 }], yape(500)))
  check('>>> más de lo que queda: dice cuánto queda (3 de 4 vendidas, 1 ya devuelta)', e1?.code === 'INVALID_DOCUMENT' && /solo quedan 3 por devolver/.test(e1.message) && /se vendieron 4 y ya se devolvieron 1/.test(e1.message), e1?.message)
  const sF = await vender(3, [{ method: 'CREDITO', amount: 300 }], { customerId: cliente.id })
  const iF = await item(sF.saleId)
  await registrarAbono(db(O), O, registrarAbonoSchema.parse({ customerId: cliente.id, method: 'YAPE', amount: 100, idempotencyKey: randomUUID() }))
  const eF = await err(devolver(sF.saleId, [{ saleItemId: iF.id, quantity: 3 }]))
  check('>>> fiado con abonos que excede el saldo: CREDIT_HAS_PAYMENTS con el tope exacto (200.00) en el mensaje y en los detalles', eF?.code === 'CREDIT_HAS_PAYMENTS' && /200\.00/.test(eF.message) && (eF as { details?: { topeDevolvible?: number } }).details?.topeDevolvible === 200, eF?.message)
  const eMs = await err(devolver(s1.saleId, [{ saleItemId: i1.id, quantity: 1 }], [{ mode: 'SIN_SALIDA', amount: 100 }]))
  check('SIN_SALIDA sin motivo: pide el motivo', !!eMs && /motivo/i.test(eMs.message))

  console.log('\nD) El cálculo EN VIVO de la pantalla = el del servidor')
  const vivo = async (saleId: string, cantidad: number, destino: 'STOCK' | 'MERMA' = 'STOCK') => {
    const dg = await diagnosticarDevolucionParcial(db(O), O, saleId)
    return calcularDevolucionParcial(dg.lineas.map((l) => ({ saleItemId: l.saleItemId, nombre: l.nombre, controlaStock: l.controlaStock, calculo: l.calculo })), [{ saleItemId: dg.lineas[0]!.saleItemId, cantidad: String(cantidad), destino }], dg.cuenta, dg.contadoPorMedioCent)
  }
  const sC = await vender(5, [{ method: 'EFECTIVO', amount: 100 }, { method: 'YAPE', amount: 100 }, { method: 'CREDITO', amount: 300 }], { customerId: cliente.id })
  const iC = await item(sC.saleId)
  for (const q of [1, 2, 1]) {
    const v = await vivo(sC.saleId, q)
    const r = await devolver(sC.saleId, [{ saleItemId: iC.id, quantity: q }], v.estado === 'OK' && v.reparto.dineroCent > 0 ? yape(v.reparto.dineroCent / 100) : undefined)
    check(`>>> devolver ${q}: la pantalla calculó ${v.estado === 'OK' ? (v.totalCent / 100).toFixed(2) : v.estado} y el servidor devolvió lo MISMO (total, deuda reducida y dinero)`, v.estado === 'OK' && r.total === v.totalCent / 100 && r.receivableReducedAmount === v.reparto.deudaCent / 100 && r.refunds.reduce((a, x) => a + Math.round(x.amount * 100), 0) === v.reparto.dineroCent, `${JSON.stringify(v.estado === 'OK' ? { t: v.totalCent, d: v.reparto.deudaCent, m: v.reparto.dineroCent } : v)} vs ${r.total}/${r.receivableReducedAmount}`)
  }
  const vBloq = await vivo(sF.saleId, 3)
  check('>>> y cuando la pantalla BLOQUEA (tope 200.00), el servidor también bloquea con el mismo tope', vBloq.estado === 'BLOQUEADO' && vBloq.topeCent === 20_000 && eF?.code === vBloq.code)

  console.log('\nE) Lo que leen las pantallas: estado, progreso e historial')
  const sP = await vender(4, [{ method: 'EFECTIVO', amount: 400 }])
  const iP = await item(sP.saleId)
  const lista0 = await listarVentas(db(O), O, parametrosVentasListaSchema.parse({ q: (await prisma.sale.findUniqueOrThrow({ where: { id: sP.saleId } })).number }))
  const d0 = await obtenerVenta(db(O), O, sP.saleId)
  check('>>> venta COMPLETADA sin devoluciones: sin «Devolución parcial», líneas sin devolver', !d0.parcial && !lista0.filas[0]!.conDevolucionParcial && d0.lineas[0]!.devuelta === 0 && d0.lineas[0]!.pendiente === 4)
  await devolver(sP.saleId, [{ saleItemId: iP.id, quantity: 1, destination: 'MERMA' }], yape(100))
  const lista1 = await listarVentas(db(O), O, parametrosVentasListaSchema.parse({ q: d0.numero }))
  const d1 = await obtenerVenta(db(O), O, sP.saleId)
  check('>>> tras una parcial: sigue COMPLETADA pero rotulada «parcial» (detalle y listado)', d1.estado === 'COMPLETADA' && d1.parcial && lista1.filas[0]!.conDevolucionParcial && lista1.filas[0]!.estado === 'COMPLETADA')
  check('>>> progreso por línea: vendió 4, lleva 1 devuelto por 100.00 y quedan 3', d1.lineas[0]!.devuelta === 1 && d1.lineas[0]!.importeDevuelto === 100 && d1.lineas[0]!.pendiente === 3)
  const h = d1.devoluciones[0]!
  check('>>> el historial: parcial (no total), con su línea devuelta, destino MERMA, importe y reembolso externo', !h.esTotal && h.detalle.length === 1 && h.detalle[0]!.destino === 'MERMA' && h.detalle[0]!.cantidad === 1 && h.detalle[0]!.importe === 100 && h.reembolsos[0]!.modo === 'EXTERNO')
  const dg1 = await diagnosticarDevolucionParcial(db(O), O, sP.saleId)
  check('>>> el diagnóstico: ya tiene devoluciones, queda 3 por devolver y se puede seguir', dg1.puede && dg1.tieneDevoluciones && dg1.lineas[0]!.pendiente === 3 && dg1.lineas[0]!.calculo.yaDevueltaM === 10_000)
  const dTotal = await diagnosticarDevolucion(db(O), O, sP.saleId)
  check('>>> «Anular / devolver todo» (F6.1) queda bloqueado y manda a «Devolver productos»', !dTotal.puede && /Devolver productos/.test(dTotal.bloqueo?.mensaje ?? ''))
  const eAn = await err(devolverProductosVenta(db(O), O, devolverProductosSchema.parse({ saleId: sP.saleId, reason: 'x'.repeat(5), lines: [{ saleItemId: iP.id, quantity: 4 }], idempotencyKey: randomUUID() })))
  check('…y pedir devolver 4 cuando solo quedan 3 se rechaza', !!eAn && /solo quedan 3/.test(eAn.message))
  await devolver(sP.saleId, [{ saleItemId: iP.id, quantity: 1 }], yape(100))
  const d2 = await obtenerVenta(db(O), O, sP.saleId)
  check('>>> con 2 parciales: el historial lista las dos (la más antigua primero) y el progreso es 2 de 4', d2.devoluciones.length === 2 && d2.devoluciones[0]!.numero < d2.devoluciones[1]!.numero && d2.lineas[0]!.devuelta === 2 && d2.parcial)
  await devolver(sP.saleId, [{ saleItemId: iP.id, quantity: 2 }], yape(200))
  const d3 = await obtenerVenta(db(O), O, sP.saleId)
  const lista3 = await listarVentas(db(O), O, parametrosVentasListaSchema.parse({ q: d0.numero }))
  check('>>> la parcial que lo completa deja la venta DEVUELTA, sin la insignia «parcial», con 3 devoluciones y nada por devolver', d3.estado === 'DEVUELTA' && !d3.parcial && !lista3.filas[0]!.conDevolucionParcial && d3.devoluciones.length === 3 && d3.lineas[0]!.pendiente === 0 && d3.devoluciones.at(-1)!.esTotal === false)
  const dgFin = await diagnosticarDevolucionParcial(db(O), O, sP.saleId)
  check('>>> y el diagnóstico de una venta DEVUELTA ya no permite devolver', !dgFin.puede && !!dgFin.bloqueo)

  console.log('\nF) Nota de crédito con sus líneas, antigüedad y costos')
  const sN = await vender(3, [{ method: 'YAPE', amount: 300 }], { documentType: 'BOLETA' })
  const iN = await item(sN.saleId)
  const v = await prisma.sale.findUniqueOrThrow({ where: { id: sN.saleId } })
  await prisma.taxDocument.create({ data: { tenantId: t.id, saleId: sN.saleId, documentType: 'BOLETA', series: 'B001', correlativo: 1, fullNumber: 'B001-00000001', status: 'ACEPTADO', isTrial: false, subtotal: v.subtotal, taxTotal: v.taxTotal, total: v.total, issuedAt: new Date(), receiverDocType: 'SIN_DOCUMENTO', receiverName: 'C', externalId: 'ext-1' } })
  await prisma.sale.update({ where: { id: sN.saleId }, data: { completedAt: new Date(Date.now() - 45 * 86_400_000) } })
  const dgN = await diagnosticarDevolucionParcial(db(O), O, sN.saleId)
  check('>>> una venta de hace 45 días: el diagnóstico AVISA (⚠️ umbral 30) pero se puede devolver', dgN.antiguedad.avisar && dgN.antiguedad.dias >= 45 && dgN.puede && dgN.comprobante?.numero === 'B001-00000001')
  const rN = await devolver(sN.saleId, [{ saleItemId: iN.id, quantity: 1 }], yape(100))
  const dN = await obtenerVenta(db(O), O, sN.saleId)
  check('>>> el historial enlaza la nota de crédito parcial y trae SUS líneas propias (1 unidad, 100.00)', dN.devoluciones[0]!.notaDeCredito === rN.creditNote?.fullNumber && dN.devoluciones[0]!.notaLineas.length === 1 && dN.devoluciones[0]!.notaLineas[0]!.cantidad === 1 && dN.devoluciones[0]!.notaLineas[0]!.total === 100)
  check('>>> el comprobante principal y la nota aparecen en la lista de comprobantes de la venta', dN.comprobantes.length === 2 && dN.comprobantes.some((c) => c.tipo === 'NOTA_CREDITO' && c.relacionado === 'B001-00000001'))
  const salidas = JSON.stringify({ d0, d1, d2, d3, dN, dg1, dgN, dgFin, lista1 })
  const claves = [...salidas.matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]!)
  check('>>> NINGÚN costo en lo que leen las pantallas (ni 37.7311, ni campos de costo, utilidad o margen), aunque lo devuelto haya ido a merma', !salidas.includes('37.73') && !claves.some((k) => /^(cost|unitCost|costo|costPrice|utilidad|margen)/i.test(k)))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
