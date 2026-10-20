import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { buscarProductos, palabras, relevancia } from '../src/features/pos/busqueda'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

async function main() {
  console.log('\n1) Relevancia (pura)')
  const cem = { name: 'Cemento Sol 42.5 kg', sku: 'CEM-SOL-425', barcode: '7750000012345', qrCode: null }
  check('código de barras completo = 0', relevancia(cem, '7750000012345') === 0)
  check('SKU exacto (sin importar mayúsculas) = 0', relevancia(cem, 'cem-sol-425') === 0)
  check('prefijo de código de barras = 1', relevancia(cem, '77500000') === 1)
  check('prefijo de SKU = 1', relevancia(cem, 'cem-s') === 1)
  check('el nombre empieza así = 2', relevancia(cem, 'cemento so') === 2)
  check('>>> palabras en otro orden = 3', relevancia(cem, 'sol cemento') === 3)
  check('palabra en medio del nombre = 4', relevancia({ ...cem, sku: 'X1' }, 'mento') === 4)
  check('>>> sin acentos ni mayúsculas', relevancia({ name: 'Cañería PVC ½"', sku: 'P1', barcode: null, qrCode: null }, 'caneria') === 2)
  check('las palabras se parten por espacios y se limpian', palabras('  sol   cemento ').join('|') === 'sol|cemento')

  console.log('\n2) Búsqueda real')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `bq-${randomUUID().slice(0, 8)}`, name: 'Búsqueda', planId: plan.id } })
  const otro = await prisma.tenant.create({ data: { slug: `bq2-${randomUUID().slice(0, 8)}`, name: 'Otro', planId: plan.id } })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const u = await prisma.user.create({ data: { tenantId: t.id, email: `u-${randomUUID()}@x.com`, name: 'U', role: 'CAJERO' } })
  await asignarSucursal(t.id, u.id, branch.id)
  const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'CAJERO', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
  const db = getTenantPrisma(ctx)

  const mk = (data: { sku: string; name: string; barcode?: string; isActive?: boolean; deletedAt?: Date; tenantId?: string }) =>
    prisma.product.create({ data: { tenantId: t.id, salePrice: 10, ...data } })
  const pCem = await mk({ sku: 'CEM-SOL-425', name: 'Cemento Sol 42.5 kg', barcode: '7750000012345' })
  const pCem2 = await mk({ sku: 'CEM-AND-425', name: 'Cemento Andino 42.5 kg', barcode: '7750000099999' })
  const pCla = await mk({ sku: 'CLA-3', name: 'Clavo 3 pulgadas', barcode: '7750000055555' })
  await mk({ sku: 'OFF', name: 'Cemento descontinuado', isActive: false })
  await mk({ sku: 'DEL', name: 'Cemento borrado', deletedAt: new Date() })
  await prisma.product.create({ data: { tenantId: otro.id, sku: 'AJENO', name: 'Cemento de otro negocio', salePrice: 1 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: pCem.id, warehouseId: w.id, quantity: 0 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: pCem2.id, warehouseId: w.id, quantity: 30 } })

  const ids = async (q: string) => (await buscarProductos(db, ctx, q)).map((r) => r.sku)

  check('>>> el código de barras completo deja el producto PRIMERO', (await ids('7750000012345'))[0] === 'CEM-SOL-425')
  check('con relevancia 0', (await buscarProductos(db, ctx, '7750000012345'))[0]?.relevancia === 0)
  check('>>> un prefijo del código encuentra todos los que empiezan así', (await ids('77500000')).length === 3)
  check('>>> por SKU parcial', (await ids('CLA')).join() === 'CLA-3')
  check('por nombre parcial', (await ids('clav')).join() === 'CLA-3')
  check('>>> varias palabras en cualquier orden: «sol cemento»', (await ids('sol cemento')).join() === 'CEM-SOL-425')
  check('«42.5 cemento» encuentra los dos cementos', (await ids('42.5 cemento')).length === 2)
  check('>>> no devuelve inactivos', !(await ids('cemento')).includes('OFF'))
  check('>>> ni borrados', !(await ids('cemento')).includes('DEL'))
  check('>>> ni productos de OTRO negocio', !(await ids('cemento')).includes('AJENO'))
  check('un texto de 1 carácter no busca', (await ids('c')).length === 0)
  check('algo que no existe devuelve vacío', (await ids('zzzzqq')).length === 0)
  check('>>> a igual parecido, lo que HAY en el estante va antes que lo agotado',
    (await ids('cemento'))[0] === 'CEM-AND-425')
  const conStock = (await buscarProductos(db, ctx, 'cemento')).find((r) => r.sku === 'CEM-AND-425')
  check('trae el stock del almacén de la sucursal activa', conStock?.stock === 30 && conStock.warehouseId === w.id)
  check('y el semáforo', conStock?.stockStatus === 'OK')
  void pCla

  console.log('\n3) Un catálogo grande no se cae')
  await prisma.product.createMany({
    data: Array.from({ length: 400 }, (_, i) => ({ tenantId: t.id, sku: `BULK-${i}`, name: `Tornillo bulk ${i}`, salePrice: 1 })),
  })
  const t0 = Date.now()
  const r = await buscarProductos(db, ctx, 'tornillo bulk')
  check('>>> acota a 20 resultados aunque coincidan 400', r.length === 20, String(r.length))
  check('y responde con rapidez', Date.now() - t0 < 5_000, `${Date.now() - t0} ms (red remota incluida)`)

  await prisma.tenant.deleteMany({ where: { id: { in: [t.id, otro.id] } } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
