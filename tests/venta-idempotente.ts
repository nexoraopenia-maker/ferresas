import './guard'
import { correr } from './teardown'
import { abrirTurno, asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { closeCashSession, currentCashSession, openCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * La venta es idempotente: el mismo cobro enviado dos veces (doble toque, red lenta, respuesta perdida) no crea dos ventas.
 *
 * Antes el POS enviaba una clave que `registerSale` ignoraba: cada reintento era otra venta —otro número, otro descuento de
 * stock, otro pago—. Aquí se reproduce el doble cobro y se comprueba que ya no ocurre.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `vi-${tag}-${randomUUID().slice(0, 6)}`, name: `Idem ${tag}`, planId: plan.id } })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'o', role: 'OWNER' } })
  await asignarSucursal(t.id, u.id, branch.id)
  const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
  const db = getTenantPrisma(ctx)
  // F6.8b: se cobra dentro del turno propio, abierto con un fondo de 50.
  const turno = await abrirTurno(t.id, u.id, branch.id, { fondo: 50 })
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Producto', salePrice: 10 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: w.id, quantity: 100 } })
  const vender = (clave: string | undefined, cantidad = 2, pago = cantidad * 10) =>
    registerSale(db, ctx, registerSaleSchema.parse({ warehouseId: w.id, items: [{ productId: prod.id, quantity: cantidad }], payments: [{ method: 'EFECTIVO', amount: pago }], ...(clave ? { idempotencyKey: clave } : {}) }))
  const stock = async () => num((await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId: prod.id } })).quantity)
  const cuenta = async () => ({
    ventas: await prisma.sale.count({ where: { tenantId: t.id } }), pagos: await prisma.payment.count({ where: { tenantId: t.id } }),
    movs: await prisma.stockMovement.count({ where: { tenantId: t.id } }), items: await prisma.saleItem.count({ where: { tenantId: t.id } }),
  })
  return { t, db, ctx, vender, stock, cuenta, w, prod, turno }
}

async function main() {
  const A = await negocio('a')
  const B = await negocio('b')

  console.log('\n1) Doble toque: el mismo envío repetido')
  const k1 = randomUUID()
  const v1 = await A.vender(k1)
  const antes = await A.cuenta()
  const v1b = await A.vender(k1)
  check('>>> el reintento devuelve la MISMA venta: mismo id, mismo número, mismos importes', v1b.saleId === v1.saleId && v1b.number === v1.number && v1b.total === v1.total && v1b.subtotal === v1.subtotal && v1b.taxTotal === v1.taxTotal)
  check('>>> y avisa que es un reintento (replayed) mientras el primero no', v1b.replayed === true && v1.replayed === false)
  check('>>> NADA se duplicó: una venta, un pago, un movimiento de stock y una línea; el stock bajó una sola vez (100 → 98)',
    JSON.stringify(await A.cuenta()) === JSON.stringify(antes) && antes.ventas === 1 && antes.pagos === 1 && antes.movs === 1 && antes.items === 1 && (await A.stock()) === 98)
  const triple = await Promise.all([A.vender(k1), A.vender(k1), A.vender(k1)])
  check('tres reintentos más, todos iguales al original', triple.every((r) => r.saleId === v1.saleId && r.replayed) && (await A.cuenta()).ventas === 1 && (await A.stock()) === 98)
  check('el contador de uso del plan se cobró UNA vez', num((await prisma.usagePeriod.findFirstOrThrow({ where: { tenantId: A.t.id } })).salesCount) === 1)

  console.log('\n2) Envíos SIMULTÁNEOS con la misma clave (la carrera real)')
  const k2 = randomUUID()
  const rs = await Promise.allSettled(Array.from({ length: 8 }, () => A.vender(k2, 1)))
  const ok = rs.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof A.vender>>> => r.status === 'fulfilled').map((r) => r.value)
  check('>>> 8 envíos a la vez: ninguno falla', ok.length === 8, rs.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason?.message).slice(0, 80)).join(' | '))
  check('>>> todos reciben la MISMA venta, y exactamente UNO la creó', new Set(ok.map((r) => r.saleId)).size === 1 && ok.filter((r) => !r.replayed).length === 1)
  const despues = await A.cuenta()
  check('>>> en la base: solo una venta nueva, un pago, un movimiento; el stock bajó 1 (98 → 97)', despues.ventas === antes.ventas + 1 && despues.pagos === antes.pagos + 1 && despues.movs === antes.movs + 1 && (await A.stock()) === 97, JSON.stringify(despues))
  const nums = (await prisma.sale.findMany({ where: { tenantId: A.t.id }, select: { number: true }, orderBy: { number: 'asc' } })).map((s) => Number(s.number.split('-').pop()))
  check('>>> y sin huecos en la numeración: los perdedores no gastaron número', nums.every((n, i) => i === 0 || n === nums[i - 1]! + 1), nums.join(','))

  console.log('\n3) Lo que no cambia')
  const sinClave = [await A.vender(undefined, 1), await A.vender(undefined, 1)]
  check('>>> sin clave todo sigue igual: cada envío es una venta distinta (compatibilidad)', sinClave[0]!.saleId !== sinClave[1]!.saleId && sinClave.every((r) => !r.replayed))
  const distintas = [await A.vender(randomUUID(), 1), await A.vender(randomUUID(), 1)]
  check('claves distintas → ventas distintas', distintas[0]!.saleId !== distintas[1]!.saleId)
  const kX = randomUUID()
  check('>>> un intento que FALLA no quema la clave: sin stock suficiente se rechaza…', await code(A.vender(kX, 500)) === 'INSUFFICIENT_STOCK' && (await prisma.sale.count({ where: { tenantId: A.t.id, idempotencyKey: kX } })) === 0)
  const reintento = await A.vender(kX, 1)
  check('…y el reintento con la misma clave (carrito corregido) sí crea la venta', !reintento.replayed && (await prisma.sale.count({ where: { tenantId: A.t.id, idempotencyKey: kX } })) === 1)
  const otroCarrito = await A.vender(k1, 7)
  check('>>> la misma clave con OTRO carrito devuelve la venta original (la clave identifica el intento): por eso el POS la renueva tras cada cobro', otroCarrito.saleId === v1.saleId && otroCarrito.total === 20 && otroCarrito.replayed)

  const kd = randomUUID()
  const vd = await A.vender(kd, 1)
  await prisma.product.update({ where: { id: A.prod.id }, data: { isActive: false } })
  check('>>> si entre el cobro y el reintento cambió el mundo (el producto se desactivó), el reintento igual devuelve la venta original en vez de fallar',
    await A.vender(kd, 1).then((r) => r.saleId === vd.saleId && r.replayed, () => false))
  check('(y una venta NUEVA de ese producto ya no se puede: la desactivación sí rige)', (await code(A.vender(randomUUID(), 1))) !== null)
  await prisma.product.update({ where: { id: A.prod.id }, data: { isActive: true } })

  console.log('\n4) Aislamiento entre negocios')
  const vB = await B.vender(k1)
  check('>>> la MISMA clave en OTRO negocio crea su propia venta y no devuelve la ajena', !vB.replayed && vB.saleId !== v1.saleId && (await B.cuenta()).ventas === 1)

  console.log('\n5) La caja no se cuenta dos veces')
  const caja = { id: B.turno }
  const kc = randomUUID()
  await B.vender(kc, 3)
  const esp1 = (await currentCashSession(B.db, B.ctx))!.expectedAmount
  await B.vender(kc, 3); await B.vender(kc, 3)
  const esp2 = (await currentCashSession(B.db, B.ctx))!.expectedAmount
  check('>>> reintentar un cobro en efectivo NO suma el efectivo otra vez: el esperado del cajón se mantiene (50 de fondo + 20 de la venta anterior + 30)', esp1 === 100 && esp2 === 100, `${esp1} / ${esp2}`)
  await closeCashSession(B.db, B.ctx, closeCashSchema.parse({ sessionId: caja.id, countedAmount: 100 }))
  check('y el cierre con el conteo real da diferencia 0', num((await prisma.cashSession.findUniqueOrThrow({ where: { id: caja.id } })).difference) === 0)

  console.log('\n6) La base')
  const base = (over: Record<string, unknown>) => prisma.sale.create({ data: { tenantId: A.t.id, branchId: A.ctx.branchId!, warehouseId: A.w.id, userId: A.ctx.userId, number: `X-${randomUUID().slice(0, 8)}`, status: 'COMPLETADA', ...over } })
  const falla = (p: Promise<unknown>) => p.then(() => null).catch((e) => (e.code === 'P2002' ? 'P2002' : /check|chk|23514/i.test(JSON.stringify({ m: String(e.message), c: String(e.cause?.message ?? '') })) ? 'CHECK' : String(e.code ?? e.name)))
  check('>>> la clave repetida en el mismo negocio la rechaza el índice único, aunque el código fallara', (await falla(base({ idempotencyKey: k1 }))) === 'P2002')
  check('una clave en blanco la rechaza la base (CHECK)', (await falla(base({ idempotencyKey: '   ' }))) === 'CHECK')
  check('varias ventas sin clave son válidas (NULL no choca)', !(await falla(base({}))) && !(await falla(base({}))))

  console.log('\n7) Estructura')
  const fuente = readFileSync('src/features/pos/sale-service.ts', 'utf8')
  check('>>> registerSale busca la clave ANTES de hacer nada y la guarda al crear la venta', fuente.includes('ventaPorClave(db, input.idempotencyKey)') && fuente.includes('idempotencyKey: input.idempotencyKey ?? null'))
  check('>>> la carrera la resuelve el catch del P2002, que solo devuelve una venta si de verdad existe esa clave', /e\.code === 'P2002'[\s\S]{0,260}ventaPorClave\(db, input\.idempotencyKey\)/.test(fuente))
  const pos = readFileSync('src/features/pos/components/PosTerminal.tsx', 'utf8')
  check('>>> el POS renueva la clave tras cada cobro exitoso (si no, la siguiente venta devolvería la anterior)', /setRecibo\([\s\S]{0,400}idemRef\.current = null/.test(pos))
  check('y la reutiliza mientras el cobro falla (para que un reintento sea seguro)', /idemRef\.current \?\?= crypto\.randomUUID\(\)/.test(pos))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
