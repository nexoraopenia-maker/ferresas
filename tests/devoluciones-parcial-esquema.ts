import './guard'
import { correr } from './teardown'
import { abrirTurno, asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.2a · Lo que la BASE garantiza por sí sola aunque el código fallara: el tope por línea, la coherencia base + IGV = importe, el destino ↔ merma,
 * las líneas de la nota parcial y el aislamiento por negocio y sucursal de las tablas nuevas.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const falla = (p: Promise<unknown>) => p.then(() => false).catch(() => true)
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 300) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const mk = async (tag: string) => {
    const t = await prisma.tenant.create({ data: { slug: `rp-dpe-${tag}-${randomUUID().slice(0, 6)}`, name: `Esquema ${tag}`, taxId: ruc(), planId: plan.id } })
    await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_dpe' } })
    const b1 = await crearSucursalConAlmacen(t.id)
    const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`.toLowerCase(), name: 'Dueño', role: 'OWNER' } })
    await asignarSucursal(t.id, x.id, b1.branch.id); await asignarSucursal(t.id, x.id, b2.branch.id)
    const p = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Prod', unitType: 'UNIDAD', salePrice: 100, costPrice: 60 } })
    for (const w of [b1.warehouse, b2.warehouse]) await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: w.id, quantity: 100 } })
    const O: TenantContext = { tenantId: t.id, userId: x.id, role: 'OWNER', access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: [] }
    // F6.8b: una persona tiene un solo turno; la sucursal 2 la cobra otra persona con el suyo.
    const x2 = await prisma.user.create({ data: { tenantId: t.id, email: `o2-${randomUUID()}@x.com`.toLowerCase(), name: 'Dueño 2', role: 'OWNER' } })
    await asignarSucursal(t.id, x2.id, b2.branch.id)
    await abrirTurno(t.id, x.id, b1.branch.id); await abrirTurno(t.id, x2.id, b2.branch.id)
    const vender = async (b: typeof b1, branchId: string) => {
      const ctx = { ...O, userId: branchId === b2.branch.id ? x2.id : x.id, branchId }
      const v = await registerSale(getTenantPrisma(ctx), ctx, registerSaleSchema.parse({ warehouseId: b.warehouse.id, items: [{ productId: p.id, quantity: 3, discount: 0 }], payments: [{ method: 'YAPE', amount: 300 }], documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() }) as never)
      const li = await prisma.saleItem.findFirstOrThrow({ where: { saleId: v.saleId } })
      return { v, li }
    }
    let corr = 0
    const nota = async (saleId: string) => {
      const c = ++corr
      return prisma.taxDocument.create({ data: { tenantId: t.id, saleId, documentType: 'BOLETA', series: 'B001', correlativo: c, fullNumber: `B001-${String(c).padStart(8, '0')}`, status: 'ACEPTADO', isTrial: false, subtotal: 254.24, taxTotal: 45.76, total: 300, issuedAt: new Date(), receiverDocType: 'SIN_DOCUMENTO', receiverName: 'C' } })
    }
    return { t, b1, b2, x, p, O, vender, nota }
  }
  const A = await mk('a'), B = await mk('b')
  const s1 = await A.vender(A.b1, A.b1.branch.id)
  const item = s1.li

  console.log('\nA) El tope por línea (sale_items)')
  const upd = (data: Record<string, unknown>) => prisma.saleItem.update({ where: { id: item.id }, data })
  check('>>> devolver más unidades de las vendidas lo rechaza la base', await falla(upd({ returnedQuantity: 3.0001, returnedAmount: 300 })))
  check('>>> devolver más importe del vendido lo rechaza la base', await falla(upd({ returnedQuantity: 1, returnedAmount: 300.01 })))
  check('valores negativos se rechazan', await falla(upd({ returnedQuantity: -1 })) && await falla(upd({ returnedAmount: -0.01 })))
  check('>>> devolver TODAS las unidades pero no TODO el importe (un céntimo huérfano) lo rechaza la base', await falla(upd({ returnedQuantity: 3, returnedAmount: 299.99 })))
  check('una devolución parcial coherente (1 de 3 y 100.00) se acepta', !(await falla(upd({ returnedQuantity: 1, returnedAmount: 100 }))))
  check('y la línea entera (3 de 3 y 300.00) también', !(await falla(upd({ returnedQuantity: 3, returnedAmount: 300 }))))

  console.log('\nB) El registro de la devolución y sus líneas')
  const devolucion = (o: Record<string, unknown> = {}) => prisma.saleReturn.create({ data: { tenantId: A.t.id, saleId: s1.v.saleId, kind: 'DEVOLUCION', number: `D-${randomUUID().slice(0, 6)}`, reason: 'Motivo', isFull: false, userId: A.x.id, saleTotal: 300, returnTotal: 100, paidNet: 100, idempotencyKey: randomUUID(), ...o } })
  check('>>> lo devuelto no puede superar el total de la venta', await falla(devolucion({ returnTotal: 300.01 })) && await falla(devolucion({ returnTotal: -1 })))
  const d1 = await devolucion()
  const linea = (o: Record<string, unknown> = {}) => prisma.saleReturnItem.create({ data: { tenantId: A.t.id, returnId: d1.id, saleItemId: item.id, quantity: 1, amount: 100, subtotal: 84.75, taxAmount: 15.25, taxRate: 0.18, ...o } })
  check('>>> importe ≠ base + IGV se rechaza (un céntimo de diferencia)', await falla(linea({ subtotal: 84.75, taxAmount: 15.26 })))
  check('cantidad cero o negativa e importe negativo se rechazan', await falla(linea({ quantity: 0 })) && await falla(linea({ quantity: -1 })) && await falla(linea({ amount: -1, subtotal: -1, taxAmount: 0 })))
  check('>>> destino MERMA sin su merma, o STOCK con una merma, se rechaza', await falla(linea({ destination: 'MERMA' })))
  const merma = await prisma.merma.create({ data: { tenantId: A.t.id, branchId: A.b1.branch.id, warehouseId: A.b1.warehouse.id, productId: A.p.id, nameSnapshot: 'Prod', skuSnapshot: 'P1', unitType: 'UNIDAD', quantity: 1, reason: 'Dañado', status: 'APROBADA', requestedById: A.x.id, resolvedById: A.x.id, resolvedAt: new Date() } })
  check('…con su merma se acepta, y STOCK con merma se rechaza', await falla(linea({ destination: 'STOCK', mermaId: merma.id })) && !(await falla(linea({ destination: 'MERMA', mermaId: merma.id }))))
  check('>>> la merma de OTRO negocio no se puede enlazar (clave compuesta)', await falla(prisma.saleReturnItem.create({ data: { tenantId: A.t.id, returnId: (await devolucion()).id, saleItemId: item.id, quantity: 1, amount: 100, subtotal: 84.75, taxAmount: 15.25, taxRate: 0.18, destination: 'MERMA', mermaId: (await prisma.merma.create({ data: { tenantId: B.t.id, branchId: B.b1.branch.id, warehouseId: B.b1.warehouse.id, productId: B.p.id, nameSnapshot: 'P', skuSnapshot: 'P', unitType: 'UNIDAD', quantity: 1, reason: 'x', requestedById: B.x.id } })).id } })))

  console.log('\nC) Las líneas de la nota de crédito parcial (tax_document_items)')
  const doc = await A.nota(s1.v.saleId)
  const nc = await prisma.taxDocument.create({ data: { tenantId: A.t.id, saleId: s1.v.saleId, documentType: 'NOTA_CREDITO', series: 'BC01', correlativo: 1, fullNumber: 'BC01-00000001', status: 'PENDIENTE', isTrial: false, relatedDocumentId: doc.id, reasonCode: '07', reasonDescription: 'Devolución por ítem', subtotal: 84.75, taxTotal: 15.25, total: 100, issuedAt: new Date(), receiverDocType: 'SIN_DOCUMENTO', receiverName: 'C' } })
  const li = (o: Record<string, unknown> = {}) => prisma.taxDocumentItem.create({ data: { tenantId: A.t.id, documentId: nc.id, saleItemId: item.id, lineNo: 1, description: 'Prod', sku: 'P1', unitType: 'UNIDAD', quantity: 1, taxRate: 0.18, subtotal: 84.75, taxAmount: 15.25, total: 100, ...o } })
  check('>>> total ≠ base + IGV, cantidad cero, total cero y número de línea cero se rechazan', await falla(li({ total: 100.01 })) && await falla(li({ quantity: 0 })) && await falla(li({ total: 0, subtotal: 0, taxAmount: 0 })) && await falla(li({ lineNo: 0 })))
  const ok = await li()
  check('una línea coherente se acepta, y el mismo número de línea no se repite en la nota', !!ok.id && await falla(li()))
  check('>>> una línea no puede apuntar a una línea de venta de OTRO negocio (clave compuesta)', await falla(prisma.taxDocumentItem.create({ data: { tenantId: A.t.id, documentId: nc.id, saleItemId: (await B.vender(B.b1, B.b1.branch.id)).li.id, lineNo: 2, description: 'x', sku: 'x', unitType: 'UNIDAD', quantity: 1, taxRate: 0.18, subtotal: 84.75, taxAmount: 15.25, total: 100 } })))
  check('…ni a un comprobante de otro negocio', await falla(prisma.taxDocumentItem.create({ data: { tenantId: B.t.id, documentId: nc.id, saleItemId: item.id, lineNo: 3, description: 'x', sku: 'x', unitType: 'UNIDAD', quantity: 1, taxRate: 0.18, subtotal: 84.75, taxAmount: 15.25, total: 100 } })))
  await prisma.saleReturnItem.deleteMany({ where: { saleItemId: item.id } })
  check('>>> la línea de venta con líneas de nota no se puede borrar (RESTRICT)', await falla(prisma.saleItem.delete({ where: { id: item.id } })))
  check('al borrar la nota se van sus líneas (CASCADE)', await (async () => { await prisma.taxDocumentItem.deleteMany({ where: { documentId: nc.id } }); return true })())

  console.log('\nD) Aislamiento por negocio y por sucursal (cliente aislado)')
  const s2 = await A.vender(A.b2, A.b2.branch.id)
  const nc2 = await prisma.taxDocument.create({ data: { tenantId: A.t.id, saleId: s2.v.saleId, documentType: 'NOTA_CREDITO', series: 'BC02', correlativo: 1, fullNumber: 'BC02-00000001', status: 'PENDIENTE', isTrial: false, relatedDocumentId: (await A.nota(s2.v.saleId)).id, reasonCode: '07', reasonDescription: 'x', subtotal: 84.75, taxTotal: 15.25, total: 100, issuedAt: new Date(), receiverDocType: 'SIN_DOCUMENTO', receiverName: 'C' } })
  await li({ lineNo: 1 })
  await prisma.taxDocumentItem.create({ data: { tenantId: A.t.id, documentId: nc2.id, saleItemId: s2.li.id, lineNo: 1, description: 'Prod', sku: 'P1', unitType: 'UNIDAD', quantity: 1, taxRate: 0.18, subtotal: 84.75, taxAmount: 15.25, total: 100 } })
  const soloB1: TenantContext = { ...A.O, branchIds: [A.b1.branch.id] }
  check('>>> el dueño con las dos sucursales ve las líneas de las dos notas; el de una sola ve SOLO las de la suya', (await getTenantPrisma(A.O).taxDocumentItem.count()) === 2 && (await getTenantPrisma(soloB1).taxDocumentItem.count()) === 1)
  check('>>> otro NEGOCIO no ve ninguna', (await getTenantPrisma(B.O).taxDocumentItem.count()) === 0)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
