/**
 * Mide cuánto tarda una venta y cuánto de eso es la sección serializada.
 *
 * Correr con: npx tsx scripts/medir-venta.ts
 */
import '../tests/guard'
import { randomUUID } from 'node:crypto'
import { crearSucursal, asignarSucursal } from '../tests/fixtures'
import { prisma } from '@/lib/prisma'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { registerSale } from '@/features/pos/sale-service'
import { registerSaleSchema } from '@/features/pos/schemas'
import { createProductExpress } from '@/features/inventory/product-service'
import { createProductExpressSchema } from '@/features/inventory/schemas'
import type { TenantContext } from '@/lib/tenant-context'

const M = randomUUID().slice(0, 6)
const ms = (n: number) => `${n.toFixed(0)} ms`

async function main() {
  const host = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!).hostname
  console.log(`  base: ${host}\n`)

  // Latencia base de una ida y vuelta, para poner lo demás en contexto.
  const pings: number[] = []
  for (let i = 0; i < 5; i++) {
    const t = performance.now()
    await prisma.$queryRawUnsafe('SELECT 1')
    pings.push(performance.now() - t)
  }
  const ping = pings.reduce((a, b) => a + b) / pings.length
  console.log(`  ida y vuelta a la base (media de 5): ${ms(ping)}`)

  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'premium' } })
  const t = await prisma.tenant.create({ data: { slug: `med-${M}`, name: 'Medición', planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' } })
  const u = await prisma.user.create({
    data: { email: `med-${M}@x.com`, name: 'M', role: 'OWNER', tenantId: t.id },
  })
  const b = await crearSucursal(t.id)
  await asignarSucursal(t.id, u.id, b.id)
  const w = await prisma.warehouse.create({
    data: { tenantId: t.id, branchId: b.id, code: 'PRIN', name: 'P', isDefault: true },
  })
  const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: b.id }
  const db = getTenantPrisma(ctx)
  const p = await createProductExpress(db, ctx, createProductExpressSchema.parse({
    barcode: `med${M}`, name: 'Cemento', salePrice: 10,
    initialStock: 100000, minStock: 1, warehouseId: w.id,
  }))

  const venta = (n: number) => registerSaleSchema.parse({
    warehouseId: w.id,
    items: [{ productId: p.productId, quantity: n }],
    payments: [{ method: 'EFECTIVO', amount: n * 10 }],
  })

  console.log('\n  ── UNA venta, en serie ──')
  const sueltas: number[] = []
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    await registerSale(db, ctx, venta(1))
    sueltas.push(performance.now() - t0)
  }
  const media = sueltas.reduce((a, b) => a + b) / sueltas.length
  console.log(`     ${sueltas.map((x) => ms(x)).join(' · ')}`)
  console.log(`     media ${ms(media)}  ≈ ${(media / ping).toFixed(0)} idas y vueltas`)

  console.log('\n  ── 12 ventas SIMULTÁNEAS (lo que hace la prueba) ──')
  const t1 = performance.now()
  const res = await Promise.allSettled(
    Array.from({ length: 12 }, () => registerSale(db, ctx, venta(1))),
  )
  const total = performance.now() - t1
  const ok = res.filter((r) => r.status === 'fulfilled').length
  console.log(`     ${ok}/12 completadas en ${ms(total)}`)
  console.log(`     por venta: ${ms(total / 12)}`)
  console.log(`     margen contra el timeout de 30 000 ms: ${ms(30000 - total)}`)
  if (ok < 12) {
    const err = res.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    console.log(`     primer fallo: ${(err?.reason as Error)?.message?.slice(0, 120)}`)
  }

  await prisma.taxDocument.deleteMany({ where: { tenantId: t.id } })
  await prisma.tenant.delete({ where: { id: t.id } })
  await prisma.$disconnect()
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
