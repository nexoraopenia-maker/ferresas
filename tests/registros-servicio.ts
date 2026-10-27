import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { parametrosRegistrosSchema, type ParametrosRegistros } from '../src/features/registros/schemas'
import { exportarRegistroCsv, informeRegistroCompras, informeRegistroVentas } from '../src/features/registros/registro-service'
import { anularCompraSchema, completarDocumentoSchema, crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { anularCompra, completarDocumento, crearBorrador, recibirCompra } from '../src/features/compras/service'
import { crearProveedor } from '../src/features/proveedores/service'
import { crearProveedorSchema } from '../src/features/proveedores/schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F5.4 · Registros de ventas y de compras contra la base. Lo que más importa: comprobantes de ENSAYO y notas de venta fuera; solo aceptados y
 * observados suman y el resto va al control; las notas de crédito restan; la frontera del día es la medianoche del negocio; las compras
 * entran por su fecha de EMISIÓN (provisional = recepción si no hay documento); cada sucursal ve lo suyo; `reportes.ver` y nada más.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const AHORA = new Date('2026-10-27T03:00:00Z')   // lunes 26/10/2026 22:00 en Lima
const P = (o: Record<string, unknown> = {}): ParametrosRegistros => parametrosRegistrosSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26', ...o })

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-${tag}-${randomUUID().slice(0, 6)}`, name: `Registros ${tag}`, taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_rp' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const u: Record<string, { id: string; ctx: TenantContext }> = {}
  for (const [nombre, role] of [['owner', 'OWNER'], ['admin', 'ADMIN'], ['contador', 'CONTADOR'], ['cajero', 'CAJERO'], ['vendedor', 'VENDEDOR'], ['almacenero', 'ALMACENERO']] as [string, Role][]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${nombre}-${randomUUID()}@x.com`.toLowerCase(), name: nombre, role } })
    await asignarSucursal(t.id, x.id, b1.branch.id)
    u[nombre] = { id: x.id, ctx: { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: [] } }
  }
  return { t, b1, b2, u, soloB1: { ...u.admin!.ctx, branchIds: [b1.branch.id] } as TenantContext, db: (c: TenantContext) => getTenantPrisma(c) }
}
type N = Awaited<ReturnType<typeof negocio>>

let correlativo = 0
async function comprobante(n: N, o: { tipo?: 'FACTURA' | 'BOLETA' | 'NOTA_CREDITO' | 'NOTA_DEBITO' | 'NOTA_VENTA'; estado?: string; trial?: boolean; en: string; total?: number; branch?: 'b1' | 'b2'; ruc?: string | null; relacionadoA?: string }) {
  const b = o.branch === 'b2' ? n.b2 : n.b1
  const total = o.total ?? 118, base = Math.round((total / 1.18) * 100) / 100
  const v = await prisma.sale.create({ data: { tenantId: n.t.id, branchId: b.branch.id, warehouseId: b.warehouse.id, userId: n.u.owner!.id, number: `V-${++correlativo}-${randomUUID().slice(0, 4)}`, documentType: o.tipo === 'FACTURA' || o.tipo === 'BOLETA' ? o.tipo : 'NOTA_VENTA', status: 'COMPLETADA', subtotal: base, taxTotal: Math.round((total - base) * 100) / 100, total, completedAt: new Date(o.en) } })
  if (o.tipo === 'NOTA_VENTA') return null
  const tipo = o.tipo ?? 'FACTURA'
  return prisma.taxDocument.create({ data: {
    tenantId: n.t.id, saleId: v.id, documentType: tipo, series: tipo === 'FACTURA' ? 'F001' : tipo === 'BOLETA' ? 'B001' : 'FC01', correlativo: correlativo, fullNumber: `${tipo === 'FACTURA' ? 'F001' : tipo === 'BOLETA' ? 'B001' : 'FC01'}-${String(correlativo).padStart(8, '0')}`,
    status: (o.estado ?? 'ACEPTADO') as never, isTrial: o.trial ?? false, subtotal: base, taxTotal: Math.round((total - base) * 100) / 100, total, issuedAt: new Date(o.en),
    receiverDocType: o.ruc === null ? 'SIN_DOCUMENTO' : 'RUC', receiverDocNumber: o.ruc === undefined ? '20123456789' : o.ruc, receiverName: 'Cliente SAC',
    ...(o.relacionadoA ? { relatedDocumentId: o.relacionadoA, reasonCode: '01', reasonDescription: 'Anulación' } : {}),
  } })
}

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 220) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  console.log('\nA) El escenario de ventas')
  const n = await negocio('uno'), o = await negocio('dos')
  const { u } = n
  const owner = u.owner!.ctx
  const f1 = await comprobante(n, { en: '2026-10-21T15:00:00Z' })                                                    // factura aceptada 118
  await comprobante(n, { tipo: 'BOLETA', estado: 'OBSERVADO', en: '2026-10-22T15:00:00Z', total: 59, ruc: null })    // boleta observada 59
  await comprobante(n, { tipo: 'NOTA_CREDITO', en: '2026-10-23T15:00:00Z', total: 29.5, relacionadoA: f1!.id })        // NC aceptada −29.50
  await comprobante(n, { estado: 'PENDIENTE', en: '2026-10-23T16:00:00Z', total: 236 })                              // al control
  await comprobante(n, { estado: 'RECHAZADO', en: '2026-10-23T17:00:00Z', total: 118 })                              // al control
  await comprobante(n, { estado: 'ANULADO', en: '2026-10-23T18:00:00Z', total: 118 })                                // al control
  await comprobante(n, { branch: 'b2', en: '2026-10-24T15:00:00Z', total: 354 })                                      // otra sucursal
  await comprobante(n, { trial: true, tipo: 'BOLETA', en: '2026-10-24T16:00:00Z', total: 999 })                      // ENSAYO: fuera
  await comprobante(n, { tipo: 'NOTA_VENTA', en: '2026-10-24T17:00:00Z', total: 777 })                               // nota de venta: no es comprobante
  await comprobante(n, { en: '2026-10-20T04:59:59Z', total: 1000 })                                                  // Lima: 19/10 23:59:59 → fuera
  await comprobante(n, { en: '2026-10-27T05:00:00Z', total: 2000 })                                                  // Lima: 27/10 00:00:00 → fuera
  await comprobante(n, { en: '2026-10-26T04:59:59Z', total: 11.8 })                                                  // Lima: 25/10 23:59:59 → dentro
  await comprobante(o, { en: '2026-10-22T15:00:00Z', total: 5000 })                                                  // otro negocio

  console.log('\nB) Registro de ventas')
  const rv = await informeRegistroVentas(n.db(owner), owner, P(), AHORA)
  const d = rv.datos
  check('>>> ensayo y notas de venta NO están; entran todos los estados (8 filas)', d.filas.length === 8 && !d.filas.some((f) => f.total === 999 || f.total === 777), String(d.filas.length))
  check('>>> el total suma SOLO aceptados y observados con la NC restando: 118 + 59 − 29.50 + 354 + 11.80 = 513.30', d.totales.total === 513.3 && d.totales.documentos === 5, `${d.totales.total}/${d.totales.documentos}`)
  check('>>> el control: pendiente 236.00, rechazado 118.00 y anulado 118.00, aparte', d.control.find((k) => k.estado === 'PENDIENTE')!.total === 236 && d.control.find((k) => k.estado === 'RECHAZADO')!.total === 118 && d.control.find((k) => k.estado === 'ANULADO')!.total === 118 && d.control.find((k) => k.estado === 'ENVIADO')!.documentos === 0)
  check('>>> la frontera es la medianoche de LIMA: 23:59:59 del 25 entra; 23:59:59 del 19 y 00:00:00 del 27 quedan fuera', d.filas.some((f) => f.total === 11.8 && f.fecha === '2026-10-25') && !d.filas.some((f) => f.total === 1000 || f.total === 2000))
  check('la nota de crédito conserva el comprobante que corrige', d.filas.find((f) => f.tipo === 'NOTA_CREDITO')!.relacionado === f1!.fullNumber)
  check('el periodo y la zona se informan', rv.textoPeriodo === '20/10/2026 – 26/10/2026' && rv.zona === 'America/Lima')
  check('>>> una factura sin RUC del cliente se avisa (no se oculta)', (await comprobante(n, { en: '2026-10-22T10:00:00Z', ruc: null, total: 11.8 }), (await informeRegistroVentas(n.db(owner), owner, P(), AHORA)).datos.alertas.facturasSinRuc) === 1)
  const rb1 = await informeRegistroVentas(n.db(n.soloB1), n.soloB1, P(), AHORA)
  check('>>> quien ve solo la sucursal 1 no ve el comprobante de la 2 (354.00)', rb1.datos.filas.length === d.filas.length && !rb1.datos.filas.some((f) => f.total === 354) && Math.round(rb1.datos.totales.total * 100) === 17110, String(rb1.datos.totales.total))
  const ro = await informeRegistroVentas(o.db(o.u.owner!.ctx), o.u.owner!.ctx, P(), AHORA)
  check('>>> cada negocio ve lo suyo', ro.datos.totales.total === 5000 && ro.datos.filas.length === 1)
  check('>>> un rango imposible → INVALID_DOCUMENT', (await code(informeRegistroVentas(n.db(owner), owner, P({ desde: '2026-10-26', hasta: '2026-10-20' }), AHORA))) === 'INVALID_DOCUMENT')

  console.log('\nC) Compras: fecha de emisión y provisional')
  const db = n.db(owner)
  const prod = await prisma.product.create({ data: { tenantId: n.t.id, sku: 'R-1', name: 'Cemento', unitType: 'UNIDAD', salePrice: 30, costPrice: 0 } })
  const prov = await crearProveedor(db, owner, crearProveedorSchema.parse({ name: 'Proveedor Uno', taxId: ruc() }))
  const provSinRuc = await crearProveedor(db, owner, crearProveedorSchema.parse({ name: 'Proveedor Sin RUC' }))
  const compra = async (o2: Record<string, unknown>, recibida = true, items = [{ productId: prod.id, enteredQuantity: 10, unitCost: 5 }], c: TenantContext = owner, almacen = n.b1.warehouse.id) => {
    const k = await crearBorrador(n.db(c), c, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: almacen, supplierId: prov.id, items, ...o2 }))
    if (recibida) await recibirCompra(n.db(c), c, recibirCompraSchema.parse({ purchaseId: k.id }))
    return k
  }
  const dentro = await compra({ docType: 'FACTURA', docSeries: 'F001', docNumber: '1', issueDate: '2026-10-22' })      // 59.00 (10×5 + IGV)
  const borde = await compra({ docType: 'BOLETA', docSeries: 'B001', docNumber: '2', issueDate: '2026-10-26' })
  const emitidaAntes = await compra({ docType: 'FACTURA', docSeries: 'F001', docNumber: '3', issueDate: '2026-10-19' })   // emisión ANTES del periodo → fuera
  await prisma.purchase.update({ where: { id: emitidaAntes.id }, data: { receivedAt: new Date('2026-10-24T15:00:00Z') } })   // …aunque se RECIBIÓ dentro: manda la emisión del documento
  await compra({ docType: 'FACTURA', docSeries: 'F001', docNumber: '4', issueDate: '2026-10-26' }, false)             // borrador → fuera
  const anulable = await compra({ docType: 'FACTURA', docSeries: 'F001', docNumber: '5', issueDate: '2026-10-22' })
  const sinDoc = await compra({ invoiceRef: 'REF-LIBRE' })                                                          // sin documento: recepción HOY (provisional)
  await prisma.purchase.update({ where: { id: sinDoc.id }, data: { receivedAt: new Date('2026-10-24T15:00:00Z') } })
  const sinDocFuera = await compra({})
  await prisma.purchase.update({ where: { id: sinDocFuera.id }, data: { receivedAt: new Date('2026-10-27T05:00:00Z') } })   // recepción fuera del periodo
  await anularCompra(db, owner, anularCompraSchema.parse({ purchaseId: anulable.id, motivo: 'Error de prueba' }))
  await prisma.purchase.update({ where: { id: anulable.id }, data: { receivedAt: new Date('2026-10-24T15:00:00Z') } })   // anulada con recepción DENTRO del periodo: aun así no entra
  const sinRuc = await crearBorrador(db, owner, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: n.b1.warehouse.id, supplierId: provSinRuc.id, docType: 'FACTURA', docSeries: 'F009', docNumber: '9', issueDate: '2026-10-23', items: [{ productId: prod.id, enteredQuantity: 10, unitCost: 5 }] }))
  await recibirCompra(db, owner, recibirCompraSchema.parse({ purchaseId: sinRuc.id }))
  const compraB2 = await prisma.purchase.create({ data: { tenantId: n.t.id, warehouseId: n.b2.warehouse.id, userId: owner.userId, supplierId: prov.id, number: 'C-B2-1', status: 'RECIBIDA', receivedAt: new Date('2026-10-24T15:00:00Z'), receivedById: owner.userId,
    subtotal: 100, taxTotal: 18, total: 118, docType: 'FACTURA', docSeries: 'F001', docNumber: '6', invoiceRef: 'F001-6', issueDate: new Date('2026-10-24T00:00:00Z') } })
  const rc = await informeRegistroCompras(db, owner, P(), AHORA)
  const c = rc.datos
  const ids = c.filas.map((f) => f.id)
  check('>>> entran las RECIBIDAS cuya emisión cae en el periodo; borradores, anuladas y emisión fuera del periodo NO', ids.includes(dentro.id) && ids.includes(borde.id) && c.filas.every((f) => !f.documento.endsWith('-3') && !f.documento.endsWith('-4') && !f.documento.endsWith('-5')))
  check('>>> sin documento entra por la fecha de RECEPCIÓN y queda PROVISIONAL; si la recepción cae fuera, no entra', c.filas.find((f) => f.id === sinDoc.id)?.provisional === true && c.filas.find((f) => f.id === sinDoc.id)?.fecha === '2026-10-24' && !ids.includes(sinDocFuera.id))
  check('>>> el control cuenta las provisionales y el proveedor sin RUC', c.control.provisionales === 1 && c.control.proveedorSinRuc === 1, JSON.stringify(c.control))
  check('la fecha de las que tienen documento es la de emisión, no la de recepción (hoy)', c.filas.find((f) => f.id === dentro.id)!.fecha === '2026-10-22' && c.filas.find((f) => f.id === dentro.id)!.provisional === false)
  check('base, IGV y total del documento (10 × 5.00 = 50 + 9 = 59.00)', c.filas.find((f) => f.id === dentro.id)!.base === 50 && c.filas.find((f) => f.id === dentro.id)!.igv === 9 && c.filas.find((f) => f.id === dentro.id)!.total === 59)
  check('proveedor, RUC, tipo y serie-número en cada fila', c.filas.find((f) => f.id === dentro.id)!.proveedorNombre === 'Proveedor Uno' && c.filas.find((f) => f.id === dentro.id)!.documento === 'F001-1' && c.filas.find((f) => f.id === dentro.id)!.tipoEtiqueta === 'Factura' && c.filas.find((f) => f.id === borde.id)!.tipoEtiqueta === 'Boleta')
  check('el total es la suma de las filas', c.totales.total === c.filas.reduce((a, f) => a + f.total, 0) && c.totales.documentos === c.filas.length)
  check('>>> «Completar documento» saca la compra de provisionales y la pasa a su fecha de emisión', await (async () => {
    await completarDocumento(db, owner, completarDocumentoSchema.parse({ purchaseId: sinDoc.id, docType: 'FACTURA', docSeries: 'F800', docNumber: '1', issueDate: '2026-10-21' }))
    const r2 = (await informeRegistroCompras(db, owner, P(), AHORA)).datos
    const f = r2.filas.find((x) => x.id === sinDoc.id)!
    return f.provisional === false && f.fecha === '2026-10-21' && r2.control.provisionales === 0
  })())
  const rcB1 = await informeRegistroCompras(n.db(n.soloB1), n.soloB1, P(), AHORA)
  check('>>> las compras se acotan por las sucursales del usuario: la de la sucursal 2 la ve el dueño y NO quien solo ve la 1', c.filas.some((f) => f.id === compraB2.id) && !rcB1.datos.filas.some((f) => f.id === compraB2.id) && rcB1.datos.filas.length === c.filas.length - 1)
  const rcO = await informeRegistroCompras(o.db(o.u.owner!.ctx), o.u.owner!.ctx, P(), AHORA)
  check('>>> otro negocio no ve nada de estas compras', rcO.datos.filas.length === 0)

  console.log('\nD) Permiso: reportes.ver')
  const probar = async (x: TenantContext) => [await code(informeRegistroVentas(n.db(x), x, P(), AHORA)), await code(informeRegistroCompras(n.db(x), x, P(), AHORA)), await code(exportarRegistroCsv(n.db(x), x, 'ventas', P(), AHORA))]
  for (const r of ['owner', 'admin', 'contador']) check(`>>> ${r} puede ver los dos y descargar`, (await probar(u[r]!.ctx)).every((x) => x === null))
  for (const r of ['cajero', 'vendedor', 'almacenero']) check(`>>> ${r} NO puede (FORBIDDEN_ROLE)`, (await probar(u[r]!.ctx)).every((x) => x === 'FORBIDDEN_ROLE'))

  console.log('\nE) CSV y auditoría')
  const antes = await prisma.auditLog.count({ where: { tenantId: n.t.id, action: 'reporte.exportado' } })
  const csvV = await exportarRegistroCsv(db, owner, 'ventas', P(), AHORA)
  check('el archivo de ventas se llama registro-ventas-DESDE_HASTA.csv, con BOM y el total firmado', csvV.nombre === 'registro-ventas-2026-10-20_2026-10-26.csv' && csvV.contenido.startsWith('﻿') && csvV.contenido.includes('CONTROL: PENDIENTE (no suma)') && csvV.contenido.includes(';-29.50;'))
  const csvC = await exportarRegistroCsv(db, owner, 'compras', P(), AHORA)
  check('el de compras marca lo provisional y lo que falta', csvC.nombre === 'registro-compras-2026-10-20_2026-10-26.csv' && csvC.contenido.includes('CONTROL: proveedor sin RUC'))
  const reg = await prisma.auditLog.findFirst({ where: { tenantId: n.t.id, action: 'reporte.exportado', entityId: 'registro-ventas' } })
  check('>>> cada descarga queda en la auditoría (quién, qué registro y cuántas filas)', (await prisma.auditLog.count({ where: { tenantId: n.t.id, action: 'reporte.exportado' } })) === antes + 2 && reg?.actorId === owner.userId && JSON.stringify(reg?.after).includes('"filas"'))
  check('>>> sin permiso no se descarga ni se audita', (await code(exportarRegistroCsv(n.db(u.cajero!.ctx), u.cajero!.ctx, 'compras', P(), AHORA))) === 'FORBIDDEN_ROLE' && (await prisma.auditLog.count({ where: { tenantId: n.t.id, action: 'reporte.exportado' } })) === antes + 2)

  console.log('\nF) Más de 1000 documentos (lotes)')
  await prisma.sale.createMany({ data: Array.from({ length: 1100 }, (_, i) => ({ tenantId: n.t.id, branchId: n.b1.branch.id, warehouseId: n.b1.warehouse.id, userId: owner.userId, number: `G-${i}`, documentType: 'BOLETA' as const, status: 'COMPLETADA' as const, subtotal: 1, taxTotal: 0, total: 1, completedAt: new Date('2026-10-24T15:00:00Z') })) })
  const baseG = correlativo
  await prisma.$executeRawUnsafe(`INSERT INTO tax_documents (id,"tenantId","saleId","documentType",series,correlativo,"fullNumber",status,"isTrial","receiverDocType",currency,subtotal,"taxTotal","discountTotal",total,"issuedAt","createdAt","updatedAt")
    SELECT 'g' || gen_random_uuid()::text, '${n.t.id}', s.id, 'BOLETA', 'B777', ${baseG + 1000} + row_number() OVER (ORDER BY s.number), 'B777-' || (${baseG + 1000} + row_number() OVER (ORDER BY s.number)), 'ACEPTADO', false, 'SIN_DOCUMENTO', 'PEN', 1, 0, 0, 1, '2026-10-24T15:00:00Z', now(), now() FROM sales s WHERE s."tenantId" = '${n.t.id}' AND s.number LIKE 'G-%'`)
  const rg = await informeRegistroVentas(db, owner, P(), AHORA)
  check('>>> las 1100 boletas adicionales se leen todas (lotes de 1000): +1100 filas y +1100.00 al total', rg.datos.filas.length === d.filas.length + 1 + 1100 && Math.round((rg.datos.totales.total - d.totales.total - 11.8) * 100) / 100 === 1100, `${rg.datos.filas.length} / ${rg.datos.totales.total}`)

  await prisma.$executeRawUnsafe(`INSERT INTO purchases (id,"tenantId","warehouseId","userId",number,status,"receivedAt","receivedById",subtotal,"taxTotal",total,"issueDate","docType","docSeries","docNumber","invoiceRef","createdAt","updatedAt")
    SELECT 'pz' || gen_random_uuid()::text, '${n.t.id}', '${n.b1.warehouse.id}', '${owner.userId}', 'Z-' || g, 'RECIBIDA', '2026-10-24T15:00:00Z', '${owner.userId}', 1, 0, 1, '2026-10-24', 'FACTURA', 'Z001', g::text, 'Z001-' || g, now(), now() FROM generate_series(1, 1100) g`)
  const rcg = await informeRegistroCompras(db, owner, P(), AHORA)
  check('>>> las 1100 compras adicionales se leen todas (lotes de 1000): +1100 filas y +1100.00 al total', rcg.datos.filas.length === c.filas.length + 1100 && Math.round((rcg.datos.totales.total - c.totales.total) * 100) === 110000, `${rcg.datos.filas.length} / ${rcg.datos.totales.total}`)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
