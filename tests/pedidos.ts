import './guard'
import { correr } from './teardown'
import { abrirTurno, crearSucursal, asignarSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { PEDIDO_BLOQUEO_MS } from '../src/features/pos/pedido-expiracion'
import { cancelarPedido, cobrarPedido, crearPedido, listarPedidos, soltarPedido, tomarPedido } from '../src/features/pos/pedido-service'
import { registerQuote, convertQuoteToSale } from '../src/features/pos/quote-service'
import { registerQuoteSchema, convertQuoteSchema } from '../src/features/pos/schemas'
import { closeCashSession, openCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '').catch((e) => String(e.message))

// Martes 20/oct/2026, 10:00 en Lima (15:00 UTC).
const T0 = new Date('2026-10-20T15:00:00Z')
const min = (n: number, base = T0) => new Date(base.getTime() + n * 60_000)

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `pd-${randomUUID().slice(0, 8)}`, name: 'Pedidos', planId: plan.id } })
  const bA = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const bB = await crearSucursal(t.id, { code: 'SUR', name: 'Sur', seriesNumber: 2, isDefault: false, establishmentCode: '0001' })
  const wA = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WA', name: 'A', isDefault: true } })
  const wB = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bB.id, code: 'WB', name: 'B', isDefault: true } })
  const mk = async (role: Role, branches: string[], tag: string) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${tag}-${randomUUID()}@x.com`.toLowerCase(), name: tag, role } })
    for (const b of branches) await asignarSucursal(t.id, u.id, b)
    return u
  }
  const ctxDe = (u: { id: string }, role: Role, branch: string, all = [branch]): TenantContext =>
    ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branch, branchIds: all })
  const vend = await mk('VENDEDOR', [bA.id], 'vendedor')
  const vend2 = await mk('VENDEDOR', [bA.id], 'vendedor2')
  const c1 = await mk('CAJERO', [bA.id], 'cajero1')
  const c2 = await mk('CAJERO', [bA.id], 'cajero2')
  const cB = await mk('CAJERO', [bB.id], 'cajeroB')
  const admin = await mk('ADMIN', [bA.id], 'admin')
  const conta = await mk('CONTADOR', [bA.id], 'contador')
  const cV = ctxDe(vend, 'VENDEDOR', bA.id), cV2 = ctxDe(vend2, 'VENDEDOR', bA.id)
  const cC1 = ctxDe(c1, 'CAJERO', bA.id), cC2 = ctxDe(c2, 'CAJERO', bA.id), cCB = ctxDe(cB, 'CAJERO', bB.id)
  const cAd = ctxDe(admin, 'ADMIN', bA.id, [bA.id, bB.id]), cCo = ctxDe(conta, 'CONTADOR', bA.id)
  await abrirTurno(t.id, c1.id, bA.id, { fondo: 100 })   // F6.8b: quien cobra un pedido necesita su turno propio
  const g = (c: TenantContext) => getTenantPrisma(c)

  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Cemento', salePrice: 30 } })
  const prod2 = await prisma.product.create({ data: { tenantId: t.id, sku: 'P2', name: 'Clavos', salePrice: 10 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: wA.id, quantity: 5 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod2.id, warehouseId: wA.id, quantity: 100 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: wB.id, quantity: 5 } })

  const input = (wh: string, qty = 2, extra: Record<string, unknown> = {}) => registerQuoteSchema.parse({
    warehouseId: wh, items: [{ productId: prod.id, quantity: qty }, { productId: prod2.id, quantity: 3 }], ...extra,
  })
  const quotesCount = async () => (await prisma.usagePeriod.findFirst({ where: { tenantId: t.id } }))?.quotesCount ?? 0

  console.log('\n1) Armar el pedido')
  const antesCount = await quotesCount()
  const p1 = await crearPedido(g(cV), cV, input(wA.id), T0)
  const fila = await prisma.quote.findUniqueOrThrow({ where: { id: p1.quoteId } })
  check('>>> el VENDEDOR arma un pedido (permiso ventas.crear)', fila.kind === 'PEDIDO')
  check('nace «enviado a caja» (ENVIADA)', fila.status === 'ENVIADA')
  check('>>> con su propia serie O001-…', /^O001-\d{8}$/.test(p1.number), p1.number)
  check('el total es el de las líneas a los precios del momento (2×30 + 3×10 = 90)', Number(fila.total) === 90)
  check('>>> vence al FINAL DEL DÍA del negocio (medianoche de Lima = 05:00 UTC)', fila.validUntil?.toISOString() === '2026-10-21T05:00:00.000Z', String(fila.validUntil?.toISOString()))
  check('>>> el contador de cotizaciones del plan NO sube', (await quotesCount()) === antesCount)
  check('>>> el CONTADOR no puede armar pedidos', await code(crearPedido(g(cCo), cCo, input(wA.id), T0)) === 'FORBIDDEN_ROLE')
  const cot = await registerQuote(g(cV), cV, input(wA.id, 1, { validDays: 15 }), T0)
  const filaCot = await prisma.quote.findUniqueOrThrow({ where: { id: cot.quoteId } })
  check('una COTIZACIÓN sigue siendo cotización: serie C001, BORRADOR, 15 días', filaCot.kind === 'COTIZACION' && filaCot.status === 'BORRADOR' && /^C001-/.test(cot.number))
  check('>>> y los pedidos no se mezclan con ellas (el listado de cotizaciones filtra por tipo)',
    (await prisma.quote.count({ where: { tenantId: t.id, kind: 'COTIZACION' } })) === 1 && (await prisma.quote.count({ where: { tenantId: t.id, kind: 'PEDIDO' } })) === 1)

  console.log('\n2) >>> NO reserva stock')
  const stockAntes = Number((await prisma.stock.findFirstOrThrow({ where: { productId: prod.id, warehouseId: wA.id } })).quantity)
  const p2 = await crearPedido(g(cV2), cV2, input(wA.id, 4), T0)   // 4 + 2 > 5 disponibles
  check('dos pedidos por más stock del que hay se arman sin problema', !!p2.quoteId)
  check('el stock no se movió', Number((await prisma.stock.findFirstOrThrow({ where: { productId: prod.id, warehouseId: wA.id } })).quantity) === stockAntes)

  console.log('\n3) La cola, por sucursal')
  const colaC1 = await listarPedidos(g(cC1), cC1, T0)
  check('>>> el cajero ve los pedidos de SU sucursal, en orden de llegada', colaC1.length === 2 && colaC1[0]!.number === p1.number && colaC1[0]!.creadoPor === 'vendedor')
  check('con total, líneas y quién lo armó', colaC1[0]!.total === 90 && colaC1[0]!.lineas === 2 && !colaC1[0]!.cobrando && !colaC1[0]!.mio)
  const colaV = await listarPedidos(g(cV), cV, T0)
  check('>>> el VENDEDOR solo ve los SUYOS', colaV.length === 1 && colaV[0]!.esMio)
  const pB = await crearPedido(g(cCB), cCB, input(wB.id), T0)
  check('>>> el cajero de la otra sucursal NO ve los de A, solo el suyo', (await listarPedidos(g(cCB), cCB, T0)).map((p) => p.number).join() === pB.number)
  check('>>> y el administrador, estando en A, ve los de A (no los de B)', (await listarPedidos(g(cAd), cAd, T0)).length === 2)
  check('>>> el cajero de B no puede tomar un pedido de A (no existe en su sucursal)', await code(tomarPedido(g(cCB), cCB, p1.quoteId, T0)) === 'NOT_FOUND')
  check('el CONTADOR no ve la cola', await code(listarPedidos(g(cCo), cCo, T0)) === 'FORBIDDEN_ROLE')

  console.log('\n4) >>> Un pedido lo cobra UN cajero a la vez')
  const tomado = await tomarPedido(g(cC1), cC1, p1.quoteId, T0)
  check('el cajero 1 lo toma y recibe las líneas con sus precios congelados', tomado.total === 90 && tomado.lineas.length === 2 && tomado.lineas[0]!.precio === 30)
  const e2 = await msg(tomarPedido(g(cC2), cC2, p1.quoteId, min(1)))
  check('>>> el cajero 2 NO puede tomarlo y se le dice quién lo tiene', /cajero1/.test(e2), e2)
  check('en la cola aparece «lo está cobrando cajero1»', (await listarPedidos(g(cC2), cC2, min(1))).find((p) => p.id === p1.quoteId)?.cobrando?.nombre === 'cajero1')
  check('y para el cajero 1 es suyo', (await listarPedidos(g(cC1), cC1, min(1))).find((p) => p.id === p1.quoteId)?.mio === true)
  check('el vendedor que lo armó NO ve quién lo cobra', (await listarPedidos(g(cV), cV, min(1)))[0]?.cobrando === null)
  const renov = await tomarPedido(g(cC1), cC1, p1.quoteId, min(3))
  check('>>> volver a tomarlo siendo el dueño RENUEVA la reserva', renov.reservadoHasta.getTime() === min(3).getTime() + PEDIDO_BLOQUEO_MS)
  check('>>> con la reserva renovada, a los 6 min del inicio sigue siendo suyo', await code(tomarPedido(g(cC2), cC2, p1.quoteId, min(6))) === 'DUPLICATE_CODE')
  check('>>> el VENDEDOR no puede tomar pedidos', await code(tomarPedido(g(cV), cV, p2.quoteId, T0)) === 'FORBIDDEN_ROLE')

  console.log('\n5) Cinco cajeros pulsan a la vez: gana uno')
  const extra = await Promise.all([1, 2, 3, 4].map((n) => mk('CAJERO', [bA.id], `cx${n}`)))
  const cx = extra.map((u) => ctxDe(u, 'CAJERO', bA.id))
  const resultados = await Promise.all([cC2, ...cx].map((c) => code(tomarPedido(g(c), c, p2.quoteId, T0))))
  check('>>> exactamente UNO lo toma', resultados.filter((r) => r === null).length === 1 && resultados.filter((r) => r === 'DUPLICATE_CODE').length === 4, JSON.stringify(resultados))
  const dueño = await prisma.quote.findUniqueOrThrow({ where: { id: p2.quoteId } })
  check('y la fila dice quién es', dueño.lockedById !== null)

  console.log('\n6) La reserva caduca')
  check('>>> a los 6 min sin renovar, otro cajero puede tomarlo', (await tomarPedido(g(cC2), cC2, p2.quoteId, min(6))).id === p2.quoteId)
  const ganador = [cC2, ...cx].find((c) => c.userId === dueño.lockedById)
  check('>>> y el primero ya no puede cobrarlo: «toma el pedido»',
    ganador && ganador.userId !== cC2.userId
      ? /Toma el pedido|otra persona/.test(await msg(cobrarPedido(g(ganador), ganador, convertQuoteSchema.parse({ quoteId: p2.quoteId, payments: [{ method: 'EFECTIVO', amount: 130 }] }), min(6))))
      : true)

  console.log('\n7) Cobrar')
  const cobro = (c: TenantContext, id: string, monto: number, ahora: Date) =>
    cobrarPedido(g(c), c, convertQuoteSchema.parse({ quoteId: id, payments: [{ method: 'EFECTIVO', amount: monto }], idempotencyKey: randomUUID() }), ahora)
  check('>>> sin tomarlo antes, se rechaza', await code(cobro(cC2, p1.quoteId, 90, min(4))) === 'DUPLICATE_CODE')
  check('>>> el cajero 2 no puede cobrar el pedido que tiene el 1', /otra persona/.test(await msg(cobro(cC2, p1.quoteId, 90, min(4)))))
  check('el VENDEDOR no puede cobrar (ventas.cobrar)', await code(cobro(cV, p1.quoteId, 90, min(4))) === 'FORBIDDEN_ROLE')
  check('una cotización no se cobra por esta vía', await code(cobrarPedido(g(cC1), cC1, convertQuoteSchema.parse({ quoteId: cot.quoteId, payments: [{ method: 'EFECTIVO', amount: 30 }] }), T0)) === 'NOT_FOUND')
  await prisma.product.update({ where: { id: prod.id }, data: { salePrice: 99 } })   // sube el precio de lista
  const venta = await cobro(cC1, p1.quoteId, 90, min(4))
  const v = await prisma.sale.findUniqueOrThrow({ where: { id: venta.saleId } })
  check('>>> se cobra con los precios CONGELADOS del pedido (90, no con el 99 de hoy)', Number(v.total) === 90 && v.quoteId === p1.quoteId && v.userId === c1.id)
  const trasCobro = await prisma.quote.findUniqueOrThrow({ where: { id: p1.quoteId } })
  check('el pedido queda CONVERTIDO y sin reserva', trasCobro.status === 'CONVERTIDA' && trasCobro.lockedById === null)
  check('>>> AHORA sí se descontó el stock (5 − 2 = 3)', Number((await prisma.stock.findFirstOrThrow({ where: { productId: prod.id, warehouseId: wA.id } })).quantity) === 3)
  check('ya no está en la cola', !(await listarPedidos(g(cC1), cC1, min(5))).some((p) => p.id === p1.quoteId))
  check('>>> cobrarlo otra vez (doble clic, reintento) devuelve LA MISMA venta',
    (await cobro(cC1, p1.quoteId, 90, min(5))).saleId === venta.saleId)
  check('>>> y no existe una segunda venta del pedido', (await prisma.sale.count({ where: { tenantId: t.id, quoteId: p1.quoteId } })) === 1)
  check('tomar uno ya cobrado lo explica', /ya se cobró/.test(await msg(tomarPedido(g(cC2), cC2, p1.quoteId, min(5)))))

  console.log('\n8) Soltar y cancelar')
  const p3 = await crearPedido(g(cV), cV, input(wA.id, 1), min(10))
  await tomarPedido(g(cC1), cC1, p3.quoteId, min(10))
  check('>>> el cajero 2 no puede soltar el pedido del 1', await code(soltarPedido(g(cC2), cC2, p3.quoteId)) === 'NOT_FOUND')
  check('>>> un administrador (caja.cerrar_ajeno) SÍ puede liberarlo', await code(soltarPedido(g(cAd), cAd, p3.quoteId)) === null)
  check('queda auditado', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'pedido.soltar', entityId: p3.quoteId } })) === 1)
  await tomarPedido(g(cC1), cC1, p3.quoteId, min(11))
  await soltarPedido(g(cC1), cC1, p3.quoteId)
  check('quien lo tiene lo suelta y vuelve a la cola libre', (await prisma.quote.findUniqueOrThrow({ where: { id: p3.quoteId } })).lockedById === null)
  check('>>> otro vendedor no cancela el pedido ajeno', await code(cancelarPedido(g(cV2), cV2, p3.quoteId, min(12))) === 'FORBIDDEN_ROLE')
  await tomarPedido(g(cC2), cC2, p3.quoteId, min(12))
  check('>>> ni siquiera el que lo armó mientras OTRO lo está cobrando', await code(cancelarPedido(g(cV), cV, p3.quoteId, min(12))) === 'DUPLICATE_CODE')
  await soltarPedido(g(cC2), cC2, p3.quoteId)
  await cancelarPedido(g(cV), cV, p3.quoteId, min(13))
  check('quien lo armó lo cancela', (await prisma.quote.findUniqueOrThrow({ where: { id: p3.quoteId } })).status === 'RECHAZADA')
  check('uno cancelado no se puede tomar', /cancelado/.test(await msg(tomarPedido(g(cC1), cC1, p3.quoteId, min(14)))))
  check('queda auditado', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'pedido.cancelar', entityId: p3.quoteId } })) === 1)

  console.log('\n9) >>> Vencen al acabar el día')
  const p4 = await crearPedido(g(cV), cV, input(wA.id, 1), T0)
  const manana = new Date('2026-10-21T06:00:00Z')   // 01:00 del día siguiente en Lima
  check('antes de medianoche sigue en cola', (await listarPedidos(g(cC1), cC1, new Date('2026-10-21T04:59:00Z'))).some((p) => p.id === p4.quoteId))
  check('>>> pasada la medianoche del negocio desaparece de la cola', !(await listarPedidos(g(cC1), cC1, manana)).some((p) => p.id === p4.quoteId))
  check('y queda VENCIDO', (await prisma.quote.findUniqueOrThrow({ where: { id: p4.quoteId } })).status === 'VENCIDA')
  check('>>> un pedido vencido no se toma', /venció/.test(await msg(tomarPedido(g(cC1), cC1, p4.quoteId, manana))))
  check('>>> ni se cobra aunque se intente por la vía directa', await code(convertQuoteToSale(g(cC1), cC1, convertQuoteSchema.parse({ quoteId: p4.quoteId, payments: [{ method: 'EFECTIVO', amount: 30 }] }), manana)) === 'DUPLICATE_CODE')
  check('las cotizaciones NO vencen por esta vía', (await prisma.quote.findUniqueOrThrow({ where: { id: cot.quoteId } })).status === 'BORRADOR')

  console.log('\n10) >>> Vencen al cerrar la caja')
  const nuevoDia = new Date('2026-10-22T15:00:00Z')
  await openCashSession(g(cCB), cCB, openCashSchema.parse({ openingAmount: 50 }))
  const pa = await crearPedido(g(cV), cV, input(wA.id, 1), nuevoDia)
  const pb = await crearPedido(g(cCB), cCB, input(wB.id, 1), nuevoDia)
  const turno = await prisma.cashSession.findFirstOrThrow({ where: { tenantId: t.id, branchId: bA.id, status: 'ABIERTA' } })
  await closeCashSession(g(cC1), cC1, closeCashSchema.parse({ sessionId: turno.id, countedAmount: 100 }))
  check('>>> al cerrar la caja de A, sus pedidos pendientes VENCEN', (await prisma.quote.findUniqueOrThrow({ where: { id: pa.quoteId } })).status === 'VENCIDA')
  check('>>> los de la OTRA sucursal siguen vivos', (await prisma.quote.findUniqueOrThrow({ where: { id: pb.quoteId } })).status === 'ENVIADA')
  check('el cierre lo deja anotado en la auditoría', JSON.stringify((await prisma.auditLog.findFirst({ where: { tenantId: t.id, action: { startsWith: 'cash.close' }, entityId: turno.id } }))?.after).includes('"pedidosVencidos":1'))
  check('>>> las cotizaciones no se tocan al cerrar la caja', (await prisma.quote.findUniqueOrThrow({ where: { id: cot.quoteId } })).status === 'BORRADOR')

  await prisma.tenant.deleteMany({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
