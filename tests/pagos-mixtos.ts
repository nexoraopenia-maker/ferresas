import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { closeCashSession, currentCashSession, openCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema, openCashSchema } from '../src/features/branches/cash-schemas'
import { readFileSync } from 'node:fs'
import { resolverPagos, type MetodoPago } from '../src/features/pos/pagos'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Paso 1 de la Fase 3: pagos mixtos matemáticamente correctos ANTES de meter la deuda.
 *
 * Reproduce el descuadre de caja que había con el vuelto: solo se guardaba si el PRIMER pago era efectivo. Con
 * `[YAPE 50, EFECTIVO 60]` sobre 100 el vuelto de 10 se perdía y el cierre esperaba 10 de más en el cajón.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `pm-${randomUUID().slice(0, 6)}`, name: 'Pagos mixtos', planId: plan.id } })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'o', role: 'OWNER' } })
  await asignarSucursal(t.id, u.id, branch.id)
  const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
  const db = getTenantPrisma(ctx)
  // Precio con IGV incluido: 1 unidad = total 100.00 y 2 = 200.00.
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Producto', salePrice: 100 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: w.id, quantity: 1000 } })

  const vender = (cantidad: number, payments: { method: string; amount: number }[]) =>
    registerSale(db, ctx, registerSaleSchema.parse({ warehouseId: w.id, items: [{ productId: prod.id, quantity: cantidad }], payments, idempotencyKey: randomUUID() }))
  const pagosDe = (saleId: string) => prisma.payment.findMany({ where: { saleId }, orderBy: { createdAt: 'asc' } })
  const esperado = async () => (await currentCashSession(db, ctx))!.expectedAmount

  const caja = await openCashSession(db, ctx, openCashSchema.parse({ openingAmount: 100 }))

  console.log('\n1) Reproducción: el vuelto con pagos mixtos cuadra en la caja')
  const s1 = await vender(1, [{ method: 'YAPE', amount: 50 }, { method: 'EFECTIVO', amount: 60 }])
  const p1 = await pagosDe(s1.saleId)
  check('>>> [Yape 50 + efectivo 60] sobre 100: el vuelto de 10 se guarda en la línea de EFECTIVO (no se pierde)',
    p1.find((p) => p.method === 'EFECTIVO')?.change.toString() === '10' && p1.find((p) => p.method === 'YAPE')?.change.toString() === '0')
  check('>>> el esperado del cajón es 100 + 60 − 10 = 150 (antes daba 160)', (await esperado()) === 150, String(await esperado()))

  const s2 = await vender(1, [{ method: 'EFECTIVO', amount: 100 }])
  check('efectivo exacto: sin vuelto y el cajón suma 100', num((await pagosDe(s2.saleId))[0]!.change) === 0 && (await esperado()) === 250)

  const s3b = await vender(1, [{ method: 'EFECTIVO', amount: 5 }, { method: 'EFECTIVO', amount: 140 }])
  const p3 = await pagosDe(s3b.saleId)
  check('>>> dos líneas de efectivo con exceso de 45: el vuelto se reparte sin pasar de lo que recibió cada línea',
    p3.every((p) => num(p.change) <= num(p.amount)) && p3.reduce((s, p) => s + num(p.change), 0) === 45)

  const s4 = await vender(1, [{ method: 'YAPE', amount: 100 }])
  check('un pago solo con Yape no mueve el cajón', num((await pagosDe(s4.saleId))[0]!.change) === 0)

  // Invariante de TODAS las ventas: lo cobrado neto de vuelto = total de la venta.
  const ventas = await prisma.sale.findMany({ where: { tenantId: t.id }, include: { payments: true } })
  check('>>> en TODAS las ventas: Σ pagos − Σ vuelto = total de la venta (el dinero neto cuadra al céntimo)',
    ventas.length === 4 && ventas.every((v) => Math.abs(v.payments.reduce((s, p) => s + num(p.amount) - num(p.change), 0) - num(v.total)) < 1e-9))

  await closeCashSession(db, ctx, closeCashSchema.parse({ sessionId: caja.id, countedAmount: 350 }))
  const cerrada = await prisma.cashSession.findUniqueOrThrow({ where: { id: caja.id } })
  check('>>> el cierre espera 350 = 100 + 50 + 100 + 100: contando 350 billetes reales la diferencia es 0 (ni sobrante ni faltante fantasma)',
    num(cerrada.expectedAmount) === 350 && num(cerrada.difference) === 0, `${cerrada.expectedAmount} / ${cerrada.difference}`)
  check('el vuelto total del turno es el real: 10 + 0 + 45 + 0 = 55', num(cerrada.changeTotal) === 55, String(cerrada.changeTotal))

  console.log('\n2) Lo que no cuadra se rechaza SIN escribir nada')
  const foto = async () => ({
    ventas: await prisma.sale.count({ where: { tenantId: t.id } }), pagos: await prisma.payment.count({ where: { tenantId: t.id } }),
    movs: await prisma.stockMovement.count({ where: { tenantId: t.id } }),
    stock: num((await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId: prod.id } })).quantity),
  })
  const ultimo = async () => (await prisma.sale.findFirstOrThrow({ where: { tenantId: t.id }, orderBy: { createdAt: 'desc' } })).number
  const numeroAntes = await ultimo()
  const antes = await foto()
  const venderSinParsear = (payments: unknown[]) =>
    registerSale(db, ctx, { warehouseId: w.id, items: [{ productId: prod.id, quantity: 1, discount: 0 }], payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() } as never)
  check('>>> pagar 120 con Yape una venta de 100 → rechazado: nadie devuelve vuelto de un Yape', await code(vender(1, [{ method: 'YAPE', amount: 120 }])) === 'INVALID_DOCUMENT')
  check('>>> Yape 100 + tarjeta 10 sobre 100 → rechazado (lo no efectivo ya supera el total)', await code(vender(1, [{ method: 'YAPE', amount: 100 }, { method: 'TARJETA_DEBITO', amount: 10 }])) === 'INVALID_DOCUMENT')
  check('tarjeta 80 + efectivo 10 sobre 100 → los pagos no cubren el total', await code(vender(1, [{ method: 'TARJETA_DEBITO', amount: 80 }, { method: 'EFECTIVO', amount: 10 }])) === 'INSUFFICIENT_STOCK')
  const sinCliente = { warehouseId: 'w', items: [{ productId: 'p', quantity: 1 }], payments: [{ method: 'CREDITO', amount: 100 }] }
  check('>>> CREDITO (fiado) sin cliente → el esquema lo rechaza con un mensaje claro (no se fía a «público general»)', !registerSaleSchema.safeParse(sinCliente).success
    && JSON.stringify(registerSaleSchema.safeParse(sinCliente).error?.issues).includes('DNI o RUC'))
  check('>>> y si alguien llama al servicio saltándose el esquema, sin cliente lo rechaza con CREDIT_CUSTOMER (CREDITO solo, o mezclado)',
    await code(venderSinParsear([{ method: 'CREDITO', amount: 100 }])) === 'CREDIT_CUSTOMER' && await code(venderSinParsear([{ method: 'CREDITO', amount: 60 }, { method: 'EFECTIVO', amount: 40 }])) === 'CREDIT_CUSTOMER')
  const cliente = await prisma.customer.create({ data: { tenantId: t.id, name: 'Cliente', docType: 'DNI', docNumber: '41235678', creditLimit: 1000 } })
  const conCliente = (payments: unknown[]) => registerSale(db, ctx, { warehouseId: w.id, customerId: cliente.id, items: [{ productId: prod.id, quantity: 1, discount: 0 }], payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() } as never)
  check('>>> con cliente, las reglas del fiado se validan pero TODAVÍA no se acepta fiar (el servicio de crédito llega en el subpaso 3.2): nada se registra como cobrado sin deuda',
    await code(conCliente([{ method: 'CREDITO', amount: 100 }])) === 'INVALID_DOCUMENT' && await code(conCliente([{ method: 'EFECTIVO', amount: 40 }, { method: 'CREDITO', amount: 60 }])) === 'INVALID_DOCUMENT')
  check('con cliente y sobrepago en efectivo, el fiado se rechaza por la regla del cuadre exacto', await code(conCliente([{ method: 'EFECTIVO', amount: 80 }, { method: 'CREDITO', amount: 60 }])) === 'INVALID_DOCUMENT')
  check('un pago de 0, o con 3 decimales, se rechaza en el servicio', await code(venderSinParsear([{ method: 'EFECTIVO', amount: 0 }, { method: 'EFECTIVO', amount: 100 }])) === 'INVALID_DOCUMENT' && await code(venderSinParsear([{ method: 'EFECTIVO', amount: 100.005 }])) === 'INVALID_DOCUMENT')
  const despues = await foto()
  check('>>> nada se escribió: ni venta, ni pagos, ni movimientos, ni stock', JSON.stringify(antes) === JSON.stringify(despues))
  const siguiente = await vender(1, [{ method: 'EFECTIVO', amount: 100 }])
  check('>>> y no se gastó ningún número de comprobante: la siguiente venta es la consecutiva (sin huecos)',
    Number((await prisma.sale.findUniqueOrThrow({ where: { id: siguiente.saleId } })).number.split('-').pop()) === Number(numeroAntes.split('-').pop()) + 1, `${numeroAntes} → ${(await ultimo())}`)

  console.log('\n3) Propiedad: miles de combinaciones de pagos (lógica pura)')
  const METODOS: MetodoPago[] = ['EFECTIVO', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'TRANSFERENCIA', 'YAPE', 'PLIN', 'OTRO']
  let semilla = 20261124
  const azar = (n: number) => { semilla = (semilla * 1664525 + 1013904223) % 4294967296; return Math.floor((semilla / 4294967296) * n) }
  let aceptados = 0, rechazados = 0, conVuelto = 0, malos: string[] = []
  for (let i = 0; i < 6000; i++) {
    const T = 1 + azar(50000)
    // La suma se acerca al total: justa, con faltante, con exceso pequeño o grande, repartida al azar entre 1 y 5 pagos.
    const n = 1 + azar(5)
    const caso = azar(100)
    const delta = caso < 15 ? -(1 + azar(Math.min(T, 3000))) : caso < 40 ? 0 : caso < 80 ? 1 + azar(3000) : 1 + azar(30000)
    const objetivo = Math.max(n, T + delta)
    const cortes = Array.from({ length: n - 1 }, () => 1 + azar(Math.max(1, objetivo - 1))).sort((a, b) => a - b)
    const partes = [...cortes, objetivo].map((c, k, arr) => c - (k === 0 ? 0 : arr[k - 1]!)).map((c) => Math.max(1, c))
    const pagos = partes.map((c) => ({ method: METODOS[azar(METODOS.length)]!, amount: c / 100 }))
    const S = pagos.reduce((s, p) => s + Math.round(p.amount * 100), 0)
    const C = pagos.reduce((s, p) => s + (p.method === 'EFECTIVO' ? Math.round(p.amount * 100) : 0), 0)
    const debeAceptar = S >= T && S - T <= C
    let r: ReturnType<typeof resolverPagos> | null = null
    let err = ''
    try { r = resolverPagos(T / 100, pagos) } catch (e) { err = (e as { code?: string }).code ?? 'ERR' }
    if (debeAceptar !== (r !== null)) { malos.push(`#${i} T=${T} S=${S} C=${C} → ${r ? 'aceptó' : err}`); continue }
    if (!r) { rechazados++; if (!['INSUFFICIENT_STOCK', 'INVALID_DOCUMENT'].includes(err)) malos.push(`#${i} código ${err}`); continue }
    aceptados++
    const cambio = r.pagos.reduce((s, p) => s + Math.round(p.change * 100), 0)
    if (cambio > 0) conVuelto++
    const neto = r.pagos.reduce((s, p) => s + Math.round(p.amount * 100) - Math.round(p.change * 100), 0)
    const ok = neto === T && cambio === S - T && Math.round(r.vuelto * 100) === cambio
      && r.pagos.every((p, k) => p.amount === pagos[k]!.amount && p.method === pagos[k]!.method && p.change >= 0 && p.change <= p.amount && (p.change === 0 || p.method === 'EFECTIVO'))
    if (!ok) malos.push(`#${i} invariante T=${T} S=${S}`)
  }
  check(`>>> ${aceptados + rechazados} combinaciones: aceptación exacta (Σ ≥ total y exceso ≤ efectivo) y, si se acepta, Σ pagos − Σ vuelto = total, vuelto solo en efectivo y ≤ lo recibido`,
    malos.length === 0 && aceptados > 1500 && rechazados > 1500 && conVuelto > 500, `${aceptados} aceptadas (${conVuelto} con vuelto) / ${rechazados} rechazadas ${malos.slice(0, 3).join('; ')}`)

  console.log('\n4) Estructura')
  const venta = readFileSync('src/features/pos/sale-service.ts', 'utf8')
  check('>>> registerSale delega en resolverPagos y ya no calcula el vuelto a mano («primer pago»)', venta.includes('resolverPagos(total, input.payments,') && !/i === 0 && p\.method === 'EFECTIVO'/.test(venta))
  check('los cobros por cotización y por pedido pasan por registerSale (mismas reglas)', readFileSync('src/features/pos/quote-service.ts', 'utf8').includes('payments: input.payments'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
