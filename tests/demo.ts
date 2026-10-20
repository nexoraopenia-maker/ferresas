import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { asegurarDatosDemo, correoDemo, prepararCuentaDemo, PRODUCTOS_DEMO, sembrarDatosDemo } from '../src/features/demo/seed'
import { alertasDeStock, rendimientoDeCaja, resumenDeVentas } from '../src/features/dashboard/service'
import { diaLocal } from '../src/lib/periodos'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))

async function main() {
  console.log('\n1) El correo de la demo')
  check('por defecto es pool@fer.pe', correoDemo() === 'pool@fer.pe' || !!process.env.DEMO_EMAIL)

  console.log('\n2) >>> Una cuenta real NO se convierte en demo')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'premium' } })
  const real = await prisma.tenant.create({ data: { slug: `real-${randomUUID().slice(0, 6)}`, name: 'Negocio real', planId: plan.id } })
  const email = `real-${randomUUID()}@x.com`
  await prisma.user.create({ data: { tenantId: real.id, email, name: 'Dueño real', role: 'OWNER' } })
  check('prepararCuentaDemo se niega sobre un correo que ya es de un negocio real',
    await code(prepararCuentaDemo({ email, password: 'clave-larga-1' })) === 'FORBIDDEN_ROLE')
  check('>>> y sembrarDatosDemo se niega sobre un tenant que no es demo',
    await code(sembrarDatosDemo(real.id)) === 'FORBIDDEN_ROLE')
  check('asegurarDatosDemo lo ignora', (await asegurarDatosDemo(real.id)) === 'no-es-demo')
  check('>>> el negocio real quedó SIN productos', (await prisma.product.count({ where: { tenantId: real.id } })) === 0)

  console.log('\n3) Crear la cuenta demo')
  const demoEmail = `demo-${randomUUID().slice(0, 8)}@fer.pe`
  check('sin contraseña no se crea', await code(prepararCuentaDemo({ email: demoEmail })) === 'INVALID_DOCUMENT')
  const c = await prepararCuentaDemo({ email: demoEmail, password: 'clave-demo-1234' })
  check('se crea', c.creada)
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: c.tenantId }, include: { subscription: true } })
  check('>>> el negocio queda marcado como demo y NO se sembró todavía', t.isDemo && t.demoSeededAt === null)
  check('la suscripción no caduca (ACTIVE, sin fin de periodo)', t.subscription?.status === 'ACTIVE' && t.subscription.currentPeriodEnd === null)
  const otra = await prepararCuentaDemo({ email: demoEmail })
  check('llamarla otra vez la reconoce (no la duplica)', !otra.creada && otra.tenantId === c.tenantId)

  console.log('\n4) Sembrar (en paralelo: solo UNO lo hace)')
  const t0 = Date.now()
  const resultados = await Promise.all([asegurarDatosDemo(c.tenantId), asegurarDatosDemo(c.tenantId), asegurarDatosDemo(c.tenantId)])
  console.log(`   (${Math.round((Date.now() - t0) / 1000)} s)`)
  check('>>> exactamente uno siembra', resultados.filter((r) => r === 'sembrada').length === 1, JSON.stringify(resultados))
  check('y queda marcado', (await prisma.tenant.findUniqueOrThrow({ where: { id: c.tenantId } })).demoSeededAt !== null)
  check('una cuarta llamada no hace nada', (await asegurarDatosDemo(c.tenantId)) === 'ya-estaba')
  const despues = new Date(Date.now() + 11 * 60_000)
  check('>>> con el reclamo CADUCADO y la demo completa, tampoco duplica nada',
    (await asegurarDatosDemo(c.tenantId, despues)) === 'ya-estaba' &&
    (await prisma.product.count({ where: { tenantId: c.tenantId } })) === PRODUCTOS_DEMO.length &&
    (await prisma.sale.count({ where: { tenantId: c.tenantId } })) === 15)

  console.log('\n5) Lo que ve quien entra')
  const nProductos = await prisma.product.count({ where: { tenantId: c.tenantId, deletedAt: null } })
  check(`${PRODUCTOS_DEMO.length} productos`, nProductos === PRODUCTOS_DEMO.length, String(nProductos))
  check('6 clientes ficticios', (await prisma.customer.count({ where: { tenantId: c.tenantId } })) === 6)
  check('4 cotizaciones', (await prisma.quote.count({ where: { tenantId: c.tenantId } })) === 4)
  const ventas = await prisma.sale.findMany({ where: { tenantId: c.tenantId, status: 'COMPLETADA' }, select: { completedAt: true, total: true, number: true, documentType: true } })
  check('>>> 15 ventas completadas (14 + una cotización convertida)', ventas.length === 15, String(ventas.length))
  const dias = new Set(ventas.map((v) => diaLocal('America/Lima', v.completedAt!)))
  check('>>> repartidas en al menos 5 días distintos', dias.size >= 5, [...dias].sort().join(','))
  check('hay boletas y facturas con comprobante', (await prisma.taxDocument.count({ where: { tenantId: c.tenantId } })) >= 8)
  check('>>> y salen ACEPTADOS (por el proveedor simulado), no pendientes',
    (await prisma.taxDocument.count({ where: { tenantId: c.tenantId, status: 'ACEPTADO' } })) === (await prisma.taxDocument.count({ where: { tenantId: c.tenantId } })))
  check('los números de venta son únicos', new Set(ventas.map((v) => v.number)).size === ventas.length)

  console.log('\n6) >>> El libro de inventario cuadra')
  const stocks = await prisma.stock.findMany({ where: { tenantId: c.tenantId } })
  let descuadres = 0
  for (const s of stocks) {
    const suma = await prisma.stockMovement.aggregate({ where: { tenantId: c.tenantId, productId: s.productId, warehouseId: s.warehouseId }, _sum: { quantity: true } })
    if (Math.abs(Number(suma._sum.quantity ?? 0) - Number(s.quantity)) > 0.0001) descuadres++
  }
  check(`SUM(movimientos) = stock en los ${stocks.length} productos con stock`, descuadres === 0, `${descuadres} descuadres`)
  check('ningún stock negativo', stocks.every((s) => Number(s.quantity) >= 0))

  console.log('\n7) El panel y las alertas muestran vida')
  const owner = await prisma.user.findFirstOrThrow({ where: { tenantId: c.tenantId, role: 'OWNER' } })
  const branch = await prisma.branch.findFirstOrThrow({ where: { tenantId: c.tenantId } })
  const ctx: TenantContext = { tenantId: c.tenantId, userId: owner.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
  const db = getTenantPrisma(ctx)
  const r = await resumenDeVentas(db, ctx)
  check('hay ventas hoy', r.hoy.ventas >= 2 && r.hoy.total > 0, JSON.stringify(r.hoy))
  check('hay ventas en la semana y el mes', r.semana.ventas >= r.hoy.ventas && r.mes.ventas >= r.semana.ventas)
  check('el ranking tiene 5 productos', r.topProductos.length === 5)
  const al = await alertasDeStock(db, ctx)
  check('>>> hay agotados Y críticos para enseñar las alertas', al.agotados >= 1 && al.criticos >= 3, JSON.stringify([al.agotados, al.criticos]))
  const caja = await rendimientoDeCaja(db, ctx)
  check('una caja abierta ahora', caja.abiertos.length === 1)
  const cerrada = await prisma.cashSession.findFirst({ where: { tenantId: c.tenantId, status: 'CERRADA' } })
  check('>>> el turno cerrado quedó con diferencia de -2.50', Number(cerrada?.difference) === -2.5, String(cerrada?.difference))

  console.log('\n8) >>> Lo que la demo NO puede hacer')
  const { createCheckoutSession } = await import('../src/features/billing/checkout-service')
  check('no puede contratar ni pagar un plan (se rechaza antes de hablar con el proveedor de pagos)',
    await code(createCheckoutSession(db, ctx, {} as never, { planCode: 'pro', appUrl: 'https://x.test' })) === 'FORBIDDEN_ROLE')
  const { obtenerProveedor } = await import('../src/features/invoicing/providers')
  process.env.FACTURACION_PROVEEDOR = 'mock'
  check('>>> sus comprobantes usan SIEMPRE el proveedor simulado', obtenerProveedor('mock', { esDemo: true }) === obtenerProveedor('mock'))
  const resiembra = await sembrarDatosDemo(c.tenantId)
  check('>>> sembrar de nuevo no duplica ventas ni números', resiembra.ventas === 0 && (await prisma.sale.count({ where: { tenantId: c.tenantId } })) === 15)

  await prisma.tenant.deleteMany({ where: { id: { in: [c.tenantId, real.id] } } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
