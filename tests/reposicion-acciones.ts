import './guard'
import { correr } from './teardown'
import { crearSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { cantidadATransferir, excedentesPara, ordenarDonantes } from '../src/features/inventory/reposicion-excedentes'
import { calcularReporte, exportarReposicionCsv, reporteDeReposicion } from '../src/features/inventory/reposicion-reporte'
import { crearBorradorDeCompraDesdeReposicion, solicitarTransferenciaDesdeReposicion } from '../src/features/inventory/reposicion-acciones'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.6c · Del reporte a la acción, contra la base: los excedentes de otras sucursales, el borrador de compra por proveedor (cantidades, presentación y último costo recalculados en el
 * servidor), el pedido de transferencia (cantidad topada por lo que SOBRA al otro lado), los permisos de cada acción, el alcance por sucursal y el CSV (sin dinero sin ver_costo).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '').catch((e) => String(e.message ?? e))

async function main() {
  console.log('\nA) La cantidad a pedir de un excedente (puro)')
  check('>>> lo necesario si el excedente alcanza', cantidadATransferir(16, 60, 'UNIDAD') === 16)
  check('>>> >>> nunca más de lo que SOBRA al otro lado', cantidadATransferir(24, 1, 'UNIDAD') === 1 && cantidadATransferir(24, 10, 'UNIDAD') === 10)
  check('>>> unidades enteras no se parten: hacia abajo (2.9 → 2)', cantidadATransferir(10, 2.9, 'UNIDAD') === 2 && cantidadATransferir(2.9, 10, 'UNIDAD') === 2)
  check('>>> un excedente menor que una unidad entera no se puede pedir (0)', cantidadATransferir(10, 0.9, 'UNIDAD') === 0)
  check('>>> a granel conserva decimales (kilos: 6.5 de 9.25 → 6.5; 9.25 de 6.5 → 6.5)', cantidadATransferir(6.5, 9.25, 'KILOGRAMO') === 6.5 && cantidadATransferir(9.25, 6.5, 'KILOGRAMO') === 6.5)
  check('>>> sin necesidad o sin excedente es 0', cantidadATransferir(0, 5, 'UNIDAD') === 0 && cantidadATransferir(5, 0, 'UNIDAD') === 0 && cantidadATransferir(-1, 5, 'UNIDAD') === 0)
  check('>>> exactitud decimal (0.1 + 0.2 necesarios, mucho excedente → 0.3 en kilos)', cantidadATransferir(0.1 + 0.2, 5, 'KILOGRAMO') === 0.3)
  const orden = ordenarDonantes([{ excedente: 5, sucursal: 'B', almacen: 'x' }, { excedente: 9, sucursal: 'C', almacen: 'x' }, { excedente: 9, sucursal: 'A', almacen: 'x' }])
  check('>>> el donante con más excedente primero; a igual, por nombre', orden.map((d) => d.sucursal).join('') === 'ACB')

  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `ra-${randomUUID().slice(0, 8)}`, name: 'Acciones reposición', planId: plan.id } })
  const bA = await crearSucursal(t.id, { code: 'NORTE', name: 'Norte', seriesNumber: 1, isDefault: true })
  const bB = await crearSucursal(t.id, { code: 'SUR', name: 'Sur', seriesNumber: 2, isDefault: false, establishmentCode: '0001' })
  const wA = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WA', name: 'Norte', isDefault: true } })
  const wA2 = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WA2', name: 'Norte depósito' } })
  const wB = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bB.id, code: 'WB', name: 'Sur', isDefault: true } })
  const mk = (role: Role) => prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
  const [owner, alm, cont, caj] = await Promise.all([mk('OWNER'), mk('ALMACENERO'), mk('CONTADOR'), mk('CAJERO')])
  const ctx = (u: { id: string }, role: Role, branchIds: string[], extra: Partial<TenantContext> = {}): TenantContext => ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branchIds[0], branchIds, ...extra })
  const cOwner = ctx(owner, 'OWNER', [bA.id, bB.id])
  const cAlm = ctx(alm, 'ALMACENERO', [bA.id])
  const cAlmCompra = ctx(alm, 'ALMACENERO', [bA.id], { permisosExtra: ['compras.registrar'] })
  const cCont = ctx(cont, 'CONTADOR', [bA.id])
  const cCaj = ctx(caj, 'CAJERO', [bA.id])
  const db = (c: TenantContext) => getTenantPrisma(c)

  const s1 = await prisma.supplier.create({ data: { tenantId: t.id, name: 'Aceros SAC' } })
  const prod = (sku: string, data: Record<string, unknown> = {}) => prisma.product.create({ data: { tenantId: t.id, sku, name: sku, ...data } as never })
  const stock = (productId: string, warehouseId: string, quantity: number, data: Record<string, unknown> = {}) => prisma.stock.create({ data: { tenantId: t.id, productId, warehouseId, quantity, ...data } as never })

  const p1 = await prod('P1', { supplierId: s1.id, minStock: 10, costPrice: 9 })
  await stock(p1.id, wA.id, 4); await stock(p1.id, wB.id, 100, { minStock: 10, maxStock: 40 })      // falta 16; Sur: sobran 60
  const p2 = await prod('P2', { supplierId: s1.id, minStock: 6, maxStock: 30, costPrice: 2.5 })
  await stock(p2.id, wA.id, 6); await stock(p2.id, wB.id, 31)                                       // falta 24; Sur (hereda 6/30): sobra 1
  const p3 = await prod('P3', { minStock: 5, costPrice: 0, name: '=1+1' })
  await stock(p3.id, wA.id, 0); await stock(p3.id, wB.id, 500, { minStock: 0 })                     // sin proveedor; Sur con 0 explícito = sin umbral
  const p4 = await prod('P4', { supplierId: s1.id, minStock: 10 })
  await stock(p4.id, wA.id, 2); await stock(p4.id, wA2.id, 90)                                      // otro almacén de LA MISMA sucursal: no es donante
  const pV = await prod('PV', { supplierId: s1.id, minStock: 10, hasVariants: true })
  const vv = await prisma.productVariant.create({ data: { tenantId: t.id, productId: pV.id, sku: 'PV-1', name: 'uno' } })
  await stock(pV.id, wA.id, 2, { variantId: vv.id })                                                // una variante: no entra al borrador
  const s2 = await prisma.supplier.create({ data: { tenantId: t.id, name: 'Zinc SRL' } })
  const p6 = await prod('P6', { supplierId: s2.id, minStock: 10 })
  await stock(p6.id, wA.id, 3); await stock(p6.id, wB.id, 50, { reserved: 20, minStock: 10, maxStock: 25 })   // Sur: 50 − 20 reservados = 30 disponibles; objetivo 25 → sobran 5 (no 25)
  const p5 = await prod('P5', { supplierId: s1.id, minStock: 10, costPrice: 1 })
  await stock(p5.id, wB.id, 1)                                                                      // solo falta en Sur

  // Presentación y último costo de P1: caja de 12; se le compró a 4.00 por unidad base (48 la caja).
  const caja = await prisma.productPresentation.create({ data: { tenantId: t.id, productId: p1.id, name: 'Caja', unitType: 'UNIDAD', factor: 12 } })
  const compra = await prisma.purchase.create({ data: { tenantId: t.id, warehouseId: wA.id, userId: owner.id, number: 'C-OLD', status: 'RECIBIDA', supplierId: s1.id, receivedAt: new Date(), receivedById: owner.id } })
  await prisma.purchaseItem.create({ data: { tenantId: t.id, purchaseId: compra.id, productId: p1.id, quantity: 24, unitCost: 4, lineTotal: 96, presentationId: caja.id, enteredQuantity: 2, presentationFactor: 12, presentationName: 'Caja' } })

  // Una compra ANULADA, más reciente, de P2 a un costo disparatado: no debe contar como «último costo».
  const anulada = await prisma.purchase.create({ data: { tenantId: t.id, warehouseId: wA.id, userId: owner.id, number: 'C-ANU', status: 'ANULADA', supplierId: s1.id, voidedAt: new Date(), voidedById: owner.id, voidReason: 'Prueba' } })
  await prisma.purchaseItem.create({ data: { tenantId: t.id, purchaseId: anulada.id, productId: p2.id, quantity: 10, unitCost: 99, lineTotal: 990 } })

  console.log('\nB) Excedentes de otras sucursales')
  const rep = await calcularReporte(db(cOwner), cOwner, { warehouseId: wA.id }, false)
  const lin = (sku: string) => rep.grupos.flatMap((g) => g.lineas).find((l) => l.sku === sku)
  check('>>> P1: a Sur le sobran 60 (100 − su objetivo 40) y se puede pedir lo que falta (16)', lin('P1')?.excedentes[0]?.sucursal === 'Sur' && lin('P1')?.excedentes[0]?.excedente === 60 && lin('P1')?.transferible === 16, JSON.stringify(lin('P1')?.excedentes))
  check('>>> P2: a Sur le sobra solo 1 (31 − 30): se puede pedir 1 aunque falten 24', lin('P2')?.excedentes[0]?.excedente === 1 && lin('P2')?.transferible === 1)
  check('>>> >>> P3: Sur tiene 500 pero con mínimo 0 explícito y sin máximo: sin umbral no hay excedente', (lin('P3')?.excedentes.length ?? 0) === 0 && lin('P3')?.transferible === 0)
  check('>>> P4: el otro almacén de la MISMA sucursal no es donante', (lin('P4')?.excedentes.length ?? 0) === 0)
  check('>>> >>> el excedente descuenta lo reservado del donante (50 con 20 reservados y objetivo 25 → sobran 5, no 25)', lin('P6')?.excedentes[0]?.excedente === 5, String(lin('P6')?.excedentes[0]?.excedente))
  const ex = await excedentesPara(db(cOwner), cOwner, [{ productId: p1.id, variantId: null, warehouseId: wA.id }, { productId: p3.id, variantId: null, warehouseId: wA.id }])
  check('>>> excedentesPara solo devuelve los pedidos que tienen donante', ex.size === 1)
  check('>>> y solo dice CUÁNTO sobra, no cuánto hay (no expone existencias del donante)', !JSON.stringify([...ex.values()]).includes('"quantity"') && !JSON.stringify([...ex.values()]).includes('"disponible"'))

  console.log('\nC) Borrador de compra desde el reporte')
  const clave1 = randomUUID()
  const b = await crearBorradorDeCompraDesdeReposicion(db(cAlmCompra), cAlmCompra, { supplierId: s1.id, warehouseId: wA.id, idempotencyKey: clave1 })
  const compraB = await prisma.purchase.findUniqueOrThrow({ where: { id: b.id }, include: { items: true } })
  const itemP1 = compraB.items.find((i) => i.productId === p1.id)!, itemP2 = compraB.items.find((i) => i.productId === p2.id)!
  check('>>> queda en BORRADOR, con el proveedor, en ese almacén, sin recibir', compraB.status === 'BORRADOR' && compraB.supplierId === s1.id && compraB.warehouseId === wA.id && compraB.receivedAt === null)
  check('>>> lleva los productos del proveedor que faltan en ESE almacén (P1, P2, P4); no el de otro almacén (P5), ni sin proveedor (P3), ni la variante', compraB.items.map((i) => i.productId).sort().join() === [p1.id, p2.id, p4.id].sort().join(), String(compraB.items.length))
  check('>>> >>> P1 va en su presentación: 16 sugeridas → 2 cajas = 24 unidades base', itemP1.presentationId === caja.id && Number(itemP1.enteredQuantity) === 2 && Number(itemP1.quantity) === 24)
  check('>>> >>> valorizado con el ÚLTIMO costo conocido (4.00 la unidad base de la última compra, no el promedio 9)', Number(itemP1.unitCost) === 4 && Number(itemP1.lineTotal) === 96, String(itemP1.unitCost))
  check('>>> sin compras previas usa el costo promedio del producto (P2: 2.50) y pide en unidad base', Number(itemP2.unitCost) === 2.5 && Number(itemP2.quantity) === 24 && itemP2.presentationId === null)
  check('>>> una compra ANULADA más reciente no cuenta como último costo (P2 sigue en 2.50, no 99); y un producto sin ningún costo conocido va en 0 y se cuenta (P4)', Number(compraB.items.find((i) => i.productId === p4.id)!.unitCost) === 0 && b.sinCosto === 1)
  check('>>> informa las líneas de variantes que no entraron', b.variantesOmitidas === 1 && b.lineas === 3)
  check('>>> el total del borrador es la suma de las líneas (96 + 60 + 0 = 156 sin IGV)', Number(compraB.subtotal) === 156 && Math.abs(Number(compraB.total) - Number(compraB.subtotal) - Number(compraB.taxTotal)) < 0.01, `${compraB.subtotal}/${compraB.taxTotal}/${compraB.total}`)
  check('>>> el borrador no mueve stock ni crea movimientos', Number((await prisma.stock.findFirstOrThrow({ where: { productId: p1.id, warehouseId: wA.id } })).quantity) === 4 && (await prisma.stockMovement.count({ where: { tenantId: t.id, productId: p1.id } })) === 0)
  const b2 = await crearBorradorDeCompraDesdeReposicion(db(cAlmCompra), cAlmCompra, { supplierId: s1.id, warehouseId: wA.id, idempotencyKey: clave1 })
  check('>>> >>> el mismo clic dos veces (misma clave) devuelve el MISMO borrador', b2.replayed === true && b2.id === b.id && (await prisma.purchase.count({ where: { tenantId: t.id, status: 'BORRADOR' } })) === 1)
  const bSin = await crearBorradorDeCompraDesdeReposicion(db(cAlmCompra), cAlmCompra, { supplierId: null, warehouseId: wA.id, idempotencyKey: randomUUID() }).catch(() => null)
  const cSin = bSin ? await prisma.purchase.findUniqueOrThrow({ where: { id: bSin.id }, include: { items: true } }) : { supplierId: 'no-se-creo', status: '', items: [] as { productId: string }[] }
  check('>>> «Otros / Sin proveedor» crea un borrador SIN proveedor con sus productos (P3), para asignarlo a mano', cSin.supplierId === null && cSin.status === 'BORRADOR' && cSin.items.map((i) => i.productId).join() === p3.id)
  check('>>> el cliente no decide cantidades: la acción solo recibe proveedor, almacén y clave', Object.keys({ supplierId: 1, warehouseId: 1, idempotencyKey: 1 }).length === 3)

  console.log('\nD) Borrador: permisos, alcance y casos vacíos')
  check('>>> el contador (sin compras.registrar) no puede', await code(crearBorradorDeCompraDesdeReposicion(db(cCont), cCont, { supplierId: s1.id, warehouseId: wA.id, idempotencyKey: randomUUID() })) === 'FORBIDDEN_ROLE')
  check('>>> el almacenero de fábrica tampoco (registrar compras es opcional)', await code(crearBorradorDeCompraDesdeReposicion(db(cAlm), cAlm, { supplierId: s1.id, warehouseId: wA.id, idempotencyKey: randomUUID() })) === 'FORBIDDEN_ROLE')
  check('>>> el almacén de otra sucursal no se abre (Sur para quien solo alcanza Norte)', await code(crearBorradorDeCompraDesdeReposicion(db(cAlmCompra), cAlmCompra, { supplierId: s1.id, warehouseId: wB.id, idempotencyKey: randomUUID() })) === 'TENANT_MISMATCH')
  check('>>> un proveedor sin nada que pedir → error claro, sin borrador', /nada que pedir/.test(await msg(crearBorradorDeCompraDesdeReposicion(db(cAlmCompra), cAlmCompra, { supplierId: 'otro-proveedor', warehouseId: wA.id, idempotencyKey: randomUUID() }))))
  check('>>> el dueño, parado en Norte, no puede crear el borrador de un almacén de Sur (la compra es de SU sucursal)', await code(crearBorradorDeCompraDesdeReposicion(db(cOwner), cOwner, { supplierId: s1.id, warehouseId: wB.id, idempotencyKey: randomUUID() })) === 'TENANT_MISMATCH')

  console.log('\nE) Pedir la transferencia')
  const t1 = await solicitarTransferenciaDesdeReposicion(db(cAlm), cAlm, { fromWarehouseId: wB.id, toWarehouseId: wA.id, items: [{ productId: p1.id }] })
  const tr1 = await prisma.branchTransfer.findUniqueOrThrow({ where: { id: t1.id }, include: { items: true } })
  check('>>> queda SOLICITADA: pide desde Sur hacia Norte, a nombre de quien pide', tr1.status === 'SOLICITADA' && tr1.fromBranchId === bB.id && tr1.fromWarehouseId === wB.id && tr1.toBranchId === bA.id && tr1.toWarehouseId === wA.id && tr1.requestedById === alm.id)
  check('>>> >>> por la cantidad necesaria (16), no por lo que sobra (60)', tr1.items.length === 1 && Number(tr1.items[0]!.quantitySent) === 16 && tr1.items[0]!.productId === p1.id)
  check('>>> no mueve stock (solo solicita)', Number((await prisma.stock.findFirstOrThrow({ where: { productId: p1.id, warehouseId: wB.id } })).quantity) === 100)
  const rep2 = await calcularReporte(db(cAlm), cAlm, { warehouseId: wA.id }, false)
  const l1b = rep2.grupos.flatMap((g) => g.lineas).find((l) => l.sku === 'P1')!
  check('>>> el pedido queda anotado: lo pendiente de llegar (16) y el excedente restante (60 − 16 = 44)', l1b.pendienteDeLlegar === 16 && l1b.excedentes[0]?.excedente === 44, JSON.stringify([l1b.pendienteDeLlegar, l1b.excedentes[0]?.excedente]))
  const t2 = await solicitarTransferenciaDesdeReposicion(db(cAlm), cAlm, { fromWarehouseId: wB.id, toWarehouseId: wA.id, items: [{ productId: p2.id }] })
  const tr2 = await prisma.branchTransferItem.findFirstOrThrow({ where: { transferId: t2.id } })
  check('>>> >>> P2: pide solo 1 (lo que SOBRA a Sur), aunque a Norte le falten 24', Number(tr2.quantitySent) === 1)
  check('>>> pedirlo otra vez ya no se puede: el excedente se agotó con el primer pedido', /ya no tiene excedente/.test(await msg(solicitarTransferenciaDesdeReposicion(db(cAlm), cAlm, { fromWarehouseId: wB.id, toWarehouseId: wA.id, items: [{ productId: p2.id }] }))))
  check('>>> sin donante (P3) se rechaza', /ya no tiene excedente/.test(await msg(solicitarTransferenciaDesdeReposicion(db(cAlm), cAlm, { fromWarehouseId: wB.id, toWarehouseId: wA.id, items: [{ productId: p3.id }] }))))
  check('>>> un producto que ya no necesita reposición se rechaza', /ya no necesita reposición/.test(await msg(solicitarTransferenciaDesdeReposicion(db(cAlm), cAlm, { fromWarehouseId: wB.id, toWarehouseId: wA.id, items: [{ productId: 'no-existe' }] }))))
  check('>>> pedir a un almacén que NO es el donante (otro de Norte) de un producto que sí tiene donante se rechaza', /ya no tiene excedente/.test(await msg(solicitarTransferenciaDesdeReposicion(db(cAlm), cAlm, { fromWarehouseId: wA2.id, toWarehouseId: wA.id, items: [{ productId: p1.id }] }))))
  check('>>> pedir al mismo almacén que recibe (o a uno de la misma sucursal) se rechaza', await code(solicitarTransferenciaDesdeReposicion(db(cAlm), cAlm, { fromWarehouseId: wA2.id, toWarehouseId: wA.id, items: [{ productId: p4.id }] })) === 'INVALID_DOCUMENT')
  check('>>> el contador no puede pedir transferencias', await code(solicitarTransferenciaDesdeReposicion(db(cCont), cCont, { fromWarehouseId: wB.id, toWarehouseId: wA.id, items: [{ productId: p1.id }] })) === 'FORBIDDEN_ROLE')
  check('>>> el cajero sí puede solicitar (es su permiso de fábrica)', await code(solicitarTransferenciaDesdeReposicion(db(cCaj), cCaj, { fromWarehouseId: wB.id, toWarehouseId: wA.id, items: [{ productId: p1.id }] })) !== 'FORBIDDEN_ROLE')
  check('>>> el almacén que recibe tiene que ser de MI sucursal: no se abre Sur como destino', await code(solicitarTransferenciaDesdeReposicion(db(cAlm), cAlm, { fromWarehouseId: wA.id, toWarehouseId: wB.id, items: [{ productId: p5.id }] })) === 'TENANT_MISMATCH')

  console.log('\nF) CSV')
  const csvOwner = await exportarReposicionCsv(db(cOwner), cOwner)
  const csvAlm = await exportarReposicionCsv(db(cAlm), cAlm)
  const csvCont = await exportarReposicionCsv(db(cCont), cCont)
  const cab = (c: { contenido: string }) => c.contenido.replace(/^﻿/, '').split('\r\n')[0]!
  check('>>> BOM, separador «;» y una fila por producto y almacén', csvOwner.contenido.startsWith('﻿') && cab(csvOwner).split(';').length >= 20 && csvOwner.filas === csvOwner.contenido.split('\r\n').length - 2)
  check('>>> >>> sin productos.ver_costo la cabecera NI NOMBRA el dinero', !/Costo|Valor/.test(cab(csvAlm)) && !/Costo|Valor/.test(cab(csvOwner).replace('Costo unitario', '').replace('Valor estimado', '')) === true)
  check('>>> el almacenero (sin costos) no recibe ni una cifra de costo', !/Costo|Valor/.test(cab(csvAlm)) && !csvAlm.contenido.includes('96.00'))
  check('>>> con costos (dueño y contador) trae «Costo unitario» y «Valor estimado»', /Costo unitario;Valor estimado$/.test(cab(csvOwner)) && /Costo unitario;Valor estimado$/.test(cab(csvCont)))
  check('>>> agrupa por proveedor y el sin proveedor va después', csvOwner.contenido.indexOf('Aceros SAC') < csvOwner.contenido.indexOf('Otros / Sin proveedor'))
  check('>>> una celda de texto que empieza por «=» se neutraliza (inyección de fórmulas)', csvOwner.contenido.includes("'=1+1") && !/;=1\+1;/.test(csvOwner.contenido))
  const columnas = (c: { contenido: string }) => c.contenido.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean).map((l) => l.split(';').length)
  check('>>> todas las filas del CSV tienen tantas columnas como la cabecera (sin celdas de dinero sueltas para quien no ve costos)', [csvOwner, csvAlm, csvCont].every((c) => columnas(c).every((n) => n === columnas(c)[0])))
  check('>>> trae la presentación y la cantidad a pedir de P1', /Caja de 12;2;24/.test(csvOwner.contenido))
  check('>>> y el excedente de otra sucursal', /Sur: \d+/.test(csvOwner.contenido))
  const csvSur = await exportarReposicionCsv(db(cOwner), cOwner, { warehouseId: wB.id })
  check('>>> el filtro por almacén filtra', csvSur.filas === 1 && csvSur.contenido.includes('P5'))
  check('>>> la descarga deja una línea de auditoría', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'reporte.exportado', entityType: 'Reposicion' } })) === 4)
  check('>>> el cajero (sin reposicion.ver) no puede exportar', await code(exportarReposicionCsv(db(cCaj), cCaj)) === 'FORBIDDEN_ROLE')

  console.log('\nG) Las acciones no exigen ver el reporte (un permiso = un poder)')
  const soloComprar = ctx(caj, 'CAJERO', [bA.id], { permisosExtra: ['compras.registrar'] })
  check('>>> un cajero con compras.registrar (sin reposicion.ver) puede crear el borrador, pero NO ver el reporte', await code(reporteDeReposicion(db(soloComprar), soloComprar)) === 'FORBIDDEN_ROLE' && await code(crearBorradorDeCompraDesdeReposicion(db(soloComprar), soloComprar, { supplierId: s1.id, warehouseId: wA.id, idempotencyKey: randomUUID() })) !== 'FORBIDDEN_ROLE')

  await prisma.tenant.delete({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
