import './guard'
import { correr } from './teardown'
import { crearSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { estadoTrasMovimiento, posicionesDeStock } from '../src/features/inventory/reposicion-service'
import { buscarProductos } from '../src/features/pos/busqueda'
import { estadoDeCodigo, resolverCodigo } from '../src/features/inventory/codigos'
import { alertasDeStock } from '../src/features/dashboard/service'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.6a · El servicio que alimenta el motor, contra la base: herencia almacén → variante → producto, lo reservado, lo que viene en camino por transferencias EN_TRANSITO,
 * el stock negativo, el alcance por sucursal, el aislamiento entre negocios, los CHECK de la migración y que el escáner y el panel dicen lo MISMO.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const rechaza = (p: Promise<unknown>) => p.then(() => false).catch(() => true)

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const mkTenant = (name: string) => prisma.tenant.create({ data: { slug: `rp-${randomUUID().slice(0, 8)}`, name, planId: plan.id } })
  const t = await mkTenant('Reposición')
  const ajeno = await mkTenant('Reposición ajeno')

  const bA = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const bB = await crearSucursal(t.id, { code: 'SUR', name: 'Sur', seriesNumber: 2, isDefault: false, establishmentCode: '0001' })
  const wA = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WA', name: 'Norte', isDefault: true } })
  const wB = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bB.id, code: 'WB', name: 'Sur', isDefault: true } })
  const mk = (role: Role) => prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
  const [owner, alm] = await Promise.all([mk('OWNER'), mk('ALMACENERO')])
  const ctx = (u: { id: string }, role: Role, branchIds: string[]): TenantContext =>
    ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branchIds[0], branchIds })
  const cOwner = ctx(owner, 'OWNER', [bA.id, bB.id])
  const cAlmA = ctx(alm, 'ALMACENERO', [bA.id])
  const dbOwner = getTenantPrisma(cOwner)
  const dbAlmA = getTenantPrisma(cAlmA)

  const prod = (sku: string, data: Record<string, unknown> = {}) =>
    prisma.product.create({ data: { tenantId: t.id, sku, name: sku, ...data } as never })
  const stock = (productId: string, warehouseId: string, quantity: number, data: Record<string, unknown> = {}) =>
    prisma.stock.create({ data: { tenantId: t.id, productId, warehouseId, quantity, ...data } as never })
  const fila = (ps: Awaited<ReturnType<typeof posicionesDeStock>>, productId: string, warehouseId: string | null, variantId: string | null = null) =>
    ps.find((p) => p.productId === productId && p.warehouseId === warehouseId && p.variantId === variantId)

  console.log('\n1) La herencia llega desde la base')
  const prodH = await prod('HER', { minStock: 10, maxStock: 40 })
  await stock(prodH.id, wA.id, 4)                                   // hereda 10 / 40 del producto
  await stock(prodH.id, wB.id, 4, { minStock: 3, maxStock: 12 })    // el almacén Sur fija 3 / 12
  const ps1 = await posicionesDeStock(dbOwner, cOwner)
  const hA = fila(ps1, prodH.id, wA.id), hB = fila(ps1, prodH.id, wB.id)
  check('>>> el almacén sin override hereda mínimo 10 y máximo 40 del producto', hA?.minimo === 10 && hA.maximo === 40 && hA.origenMinimo === 'PRODUCTO' && hA.origenMaximo === 'PRODUCTO')
  check('>>> y por eso está crítico y sugiere 36 (40 − 4)', hA?.estado === 'LOW' && hA.dispara && hA.sugerida === 36, JSON.stringify(hA && [hA.estado, hA.sugerida]))
  check('>>> el almacén con override usa 3 / 12: con 4 está OK y no dispara', hB?.minimo === 3 && hB.maximo === 12 && hB.origenMinimo === 'ALMACEN' && hB.estado === 'OK' && !hB.dispara && hB.sugerida === 0)

  console.log('\n2) Variantes: un 0 hereda; un valor propio manda')
  const prodV = await prod('VAR', { minStock: 20, hasVariants: true })
  const vHereda = await prisma.productVariant.create({ data: { tenantId: t.id, productId: prodV.id, sku: 'VAR-1', name: '1/2', minStock: 0 } })
  const vPropia = await prisma.productVariant.create({ data: { tenantId: t.id, productId: prodV.id, sku: 'VAR-2', name: '3/4', minStock: 6, maxStock: 15 } })
  await stock(prodV.id, wA.id, 8, { variantId: vHereda.id })
  await stock(prodV.id, wA.id, 8, { variantId: vPropia.id })
  const ps2 = await posicionesDeStock(dbOwner, cOwner)
  const f1 = fila(ps2, prodV.id, wA.id, vHereda.id), f2 = fila(ps2, prodV.id, wA.id, vPropia.id)
  check('>>> la variante con mínimo 0 hereda el 20 del producto (antes lo tapaba con 0): crítica', f1?.minimo === 20 && f1.origenMinimo === 'PRODUCTO' && f1.estado === 'LOW')
  check('>>> la variante con valores propios usa 6 / 15: con 8 está OK', f2?.minimo === 6 && f2.maximo === 15 && f2.origenMinimo === 'VARIANTE' && f2.origenMaximo === 'VARIANTE' && f2.estado === 'OK')
  check('>>> el nombre de la fila incluye el de la variante', f2?.nombre === 'VAR 3/4' && f2.sku === 'VAR-2')

  console.log('\n3) Reservado y en tránsito')
  const prodR = await prod('RES', { minStock: 10 })
  await stock(prodR.id, wA.id, 14, { reserved: 6 })                  // disponible 8
  const ps3a = await posicionesDeStock(dbOwner, cOwner)
  const r1 = fila(ps3a, prodR.id, wA.id)
  check('>>> lo reservado resta: 14 con 6 reservados → disponible 8, crítico, sugiere 12 (20 − 8)', r1?.disponible === 8 && r1.estado === 'LOW' && r1.sugerida === 12, JSON.stringify(r1 && [r1.disponible, r1.estado, r1.sugerida]))

  let numTr = 0
  const transferencia = async (status: 'BORRADOR' | 'SOLICITADA' | 'APROBADA' | 'EN_TRANSITO' | 'RECIBIDA' | 'CANCELADA', cantidad: number, recibida: number | null = null, hacia = wA, desde = wB) => {
    const tr = await prisma.branchTransfer.create({
      data: {
        tenantId: t.id, number: `TR-${++numTr}`, status, requestedById: owner.id,
        fromBranchId: desde.branchId, fromWarehouseId: desde.id, toBranchId: hacia.branchId, toWarehouseId: hacia.id,
      },
    })
    await prisma.branchTransferItem.create({
      data: { tenantId: t.id, transferId: tr.id, productId: prodR.id, nameSnapshot: 'RES', skuSnapshot: 'RES', quantitySent: cantidad, quantityReceived: recibida },
    })
    return tr
  }
  await transferencia('BORRADOR', 100)
  await transferencia('SOLICITADA', 100)
  await transferencia('APROBADA', 100)
  await transferencia('CANCELADA', 100)
  await transferencia('RECIBIDA', 100, 100)
  const ps3b = await posicionesDeStock(dbOwner, cOwner)
  const r2 = fila(ps3b, prodR.id, wA.id)
  check('>>> borrador, solicitada, aprobada, cancelada y recibida NO cuentan como «en camino»', r2?.enTransito === 0 && r2.dispara)
  await transferencia('EN_TRANSITO', 5)
  await transferencia('EN_TRANSITO', 3)
  await transferencia('EN_TRANSITO', 50, null, wB, wA)               // hacia OTRO almacén: no suma a Norte
  const ps3c = await posicionesDeStock(dbOwner, cOwner)
  const r3 = fila(ps3c, prodR.id, wA.id)
  check('>>> dos transferencias EN_TRANSITO hacia Norte suman 8 (la que va a Sur no)', r3?.enTransito === 8, String(r3?.enTransito))
  check('>>> posición = 8 disponibles + 8 en camino = 16: ya no dispara', r3?.posicion === 16 && r3.dispara === false && r3.sugerida === 0)
  check('>>> pero el semáforo físico sigue crítico (lo que viene no se puede vender hoy)', r3?.estado === 'LOW')
  await transferencia('EN_TRANSITO', 4, 1)
  const r4 = fila(await posicionesDeStock(dbOwner, cOwner), prodR.id, wA.id)
  check('>>> lo ya recibido de una línea no cuenta como en camino (4 enviadas, 1 recibida → 3)', r4?.enTransito === 11, String(r4?.enTransito))

  console.log('\n4) Stock negativo')
  const prodN = await prod('NEG', { minStock: 10 })
  await stock(prodN.id, wA.id, -3)
  const n1 = fila(await posicionesDeStock(dbOwner, cOwner), prodN.id, wA.id)
  check('>>> agotado, dispara y repone 20 + 3 = 23', n1?.estado === 'OUT' && n1.dispara && n1.sugerida === 23, JSON.stringify(n1 && [n1.estado, n1.sugerida]))

  console.log('\n5) Quién aparece: sin control de stock, bajas, almacenes inactivos y productos nunca cargados')
  await prod('SRV', { minStock: 5, trackStock: false })
  const prodBaja = await prod('BAJA', { minStock: 5, deletedAt: new Date() })
  const prodInactivo = await prod('INACT', { minStock: 5, isActive: false })
  await stock(prodBaja.id, wA.id, 0); await stock(prodInactivo.id, wA.id, 0)
  const prodNunca = await prod('NUNCA', { minStock: 5 })
  const prodSinMin = await prod('SINMIN', { minStock: 0 })
  await stock(prodSinMin.id, wA.id, 2)
  const wMuerto = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WX', name: 'Cerrado', isActive: false } })
  const prodEnMuerto = await prod('ENMUERTO', { minStock: 5 })
  await stock(prodEnMuerto.id, wMuerto.id, 0)
  const vBaja = await prisma.productVariant.create({ data: { tenantId: t.id, productId: prodV.id, sku: 'VAR-BAJA', name: 'baja', minStock: 5, deletedAt: new Date() } })
  const vOff = await prisma.productVariant.create({ data: { tenantId: t.id, productId: prodV.id, sku: 'VAR-OFF', name: 'off', minStock: 5, isActive: false } })
  await stock(prodV.id, wA.id, 0, { variantId: vBaja.id }); await stock(prodV.id, wA.id, 0, { variantId: vOff.id })
  const prov = await prisma.supplier.create({ data: { tenantId: t.id, name: 'Aceros SAC' } })
  const prodProv = await prod('PROV', { minStock: 5, supplierId: prov.id })
  await stock(prodProv.id, wA.id, 1)
  const ps5 = await posicionesDeStock(dbOwner, cOwner)
  check('>>> una variante dada de baja o desactivada no aparece (su fila de stock tampoco)', !ps5.some((p) => p.variantId === vBaja.id || p.variantId === vOff.id))
  check('>>> el proveedor habitual del producto viaja en la posición (para agrupar la compra)', fila(ps5, prodProv.id, wA.id)?.supplierId === prov.id && fila(ps5, prodH.id, wA.id)?.supplierId === null)
  check('>>> un servicio (trackStock false) no aparece', !ps5.some((p) => p.sku === 'SRV'))
  check('>>> un producto dado de baja o inactivo no aparece', !ps5.some((p) => p.productId === prodBaja.id || p.productId === prodInactivo.id))
  const nunca = ps5.find((p) => p.productId === prodNunca.id)
  check('>>> un producto que nunca tuvo existencias aparece como AGOTADO, sin almacén (fila sintética)', nunca?.estado === 'OUT' && nunca.warehouseId === null && nunca.almacen === null && nunca.sugerida === 10)
  check('>>> un producto con stock en un almacén NO genera fila sintética', ps5.filter((p) => p.productId === prodSinMin.id).length === 1)
  check('>>> sin mínimo (0) y con existencias: OK y no dispara', fila(ps5, prodSinMin.id, wA.id)?.estado === 'OK' && !fila(ps5, prodSinMin.id, wA.id)?.dispara)
  check('>>> el stock de un almacén inactivo no cuenta (y el producto sale como nunca cargado)', !ps5.some((p) => p.warehouseId === wMuerto.id) && ps5.some((p) => p.productId === prodEnMuerto.id && p.warehouseId === null))

  console.log('\n6) Alcance por sucursal y filtros')
  const psA = await posicionesDeStock(dbAlmA, cAlmA)
  check('>>> el almacenero de Norte no ve las filas del almacén Sur', psA.length > 0 && !psA.some((p) => p.warehouseId === wB.id))
  check('>>> ni lo que va hacia Sur cuenta para él (solo lo de Norte)', fila(psA, prodR.id, wA.id)?.enTransito === 11)
  const psSoloB = await posicionesDeStock(dbOwner, cOwner, { warehouseId: wB.id })
  check('>>> el filtro por almacén devuelve solo ese almacén y ninguna fila sintética', psSoloB.length > 0 && psSoloB.every((p) => p.warehouseId === wB.id))
  const psProd = await posicionesDeStock(dbOwner, cOwner, { productId: prodH.id })
  check('>>> el filtro por producto devuelve solo ese producto (2 almacenes)', psProd.length === 2 && psProd.every((p) => p.productId === prodH.id))

  console.log('\n7) Aislamiento entre negocios')
  const prodAjeno = await prisma.product.create({ data: { tenantId: ajeno.id, sku: 'AJ', name: 'Ajeno', minStock: 5 } })
  const ps7 = await posicionesDeStock(dbOwner, cOwner)
  check('>>> el producto de otro negocio no aparece (ni como sintético)', !ps7.some((p) => p.productId === prodAjeno.id))

  console.log('\n8) El panel usa el mismo criterio, por almacén')
  const prodP = await prod('PAN', { minStock: 10 })
  await stock(prodP.id, wA.id, 4)
  await stock(prodP.id, wB.id, 500)
  const alOwner = await alertasDeStock(dbOwner, cOwner, 500)
  const alPan = alOwner.items.filter((a) => a.productId === prodP.id)
  check('>>> >>> el dueño, que ve A y B, SÍ ve el crítico de Norte aunque Sur tenga 500 (ya no se suman)', alPan.length === 1 && alPan[0]!.almacen === 'Norte' && alPan[0]!.estado === 'LOW')
  check('>>> cada alerta trae su almacén y una clave única', new Set(alOwner.items.map((a) => a.clave)).size === alOwner.items.length)
  const alReserva = alOwner.items.find((a) => a.productId === prodR.id && a.warehouseId === wA.id)
  check('>>> la alerta muestra lo disponible (8) y lo que viene en camino (11)', alReserva?.stock === 8 && alReserva.enTransito === 11)
  check('>>> los contadores coinciden con los estados de las posiciones', alOwner.agotados + alOwner.criticos === ps7.filter((p) => p.estado !== 'OK').length + 1 /* PAN */, JSON.stringify([alOwner.agotados, alOwner.criticos]))

  console.log('\n9) El escáner dice lo MISMO que el panel')
  // Con código de barras: la vía del escáner y del POS (`resolverCodigo` + `estadoDeCodigo`).
  const prodE = await prod('ESC', { minStock: 10, barcode: '7750000999001' })
  await stock(prodE.id, wA.id, 25, { reserved: 20 })                  // disponible 5 → crítico
  const rE = await resolverCodigo(dbOwner, '7750000999001', { almacenId: wA.id })
  const eE = rE && rE.estado === 'ok' ? estadoDeCodigo(rE) : null
  const pE = fila(await posicionesDeStock(dbOwner, cOwner), prodE.id, wA.id)
  check('>>> el escáner juzga lo disponible (25 − 20 = 5 con mínimo 10): crítico', eE?.estado === 'LOW' && eE.minimo === 10 && eE.cantidad === 25, JSON.stringify(eE))
  check('>>> y coincide con el motor central (mismo estado, mismo mínimo)', pE?.estado === eE?.estado && pE?.minimo === eE?.minimo)
  const prodO = await prod('OVR', { minStock: 10, barcode: '7750000999002' })
  await stock(prodO.id, wA.id, 6, { minStock: 4 })
  const rO = await resolverCodigo(dbOwner, '7750000999002', { almacenId: wA.id })
  check('>>> el override del almacén también rige en el escáner (mínimo 4: con 6 está OK)', rO?.estado === 'ok' && estadoDeCodigo(rO).estado === 'OK' && estadoDeCodigo(rO).minimo === 4)
  const rSin = await resolverCodigo(dbOwner, '7750000999001', { almacenId: wB.id })
  check('>>> sin fila de stock en ese almacén el escáner dice agotado con el mínimo del producto', rSin?.estado === 'ok' && estadoDeCodigo(rSin).estado === 'OUT' && estadoDeCodigo(rSin).minimo === 10)

  await prisma.productVariant.update({ where: { id: vHereda.id }, data: { barcode: '7750000999003' } })
  await prisma.productVariant.update({ where: { id: vPropia.id }, data: { barcode: '7750000999004' } })
  const rVP = await resolverCodigo(dbOwner, '7750000999004', { almacenId: wA.id })
  check('>>> el escáner de una variante con mínimo propio (6) lo usa: con 8 está OK aunque el producto pida 20', rVP?.estado === 'ok' && estadoDeCodigo(rVP).minimo === 6 && estadoDeCodigo(rVP).estado === 'OK')
  const rV = await resolverCodigo(dbOwner, '7750000999003', { almacenId: wA.id })
  check('>>> el escáner de una VARIANTE con mínimo 0 hereda el del producto (20): con 8 está crítico', rV?.estado === 'ok' && estadoDeCodigo(rV).minimo === 20 && estadoDeCodigo(rV).estado === 'LOW')

  console.log('\n9b) El POS y el estado tras un movimiento, por el mismo criterio')
  const bus = await buscarProductos(dbOwner, cOwner, 'ESC')
  const bE = bus.find((r) => r.productId === prodE.id)
  check('>>> la búsqueda del POS juzga lo disponible (5 con mínimo 10): crítico, y trae el mínimo resuelto', bE?.stockStatus === 'LOW' && bE.minStock === 10 && bE.stock === 25, JSON.stringify(bE && [bE.stockStatus, bE.minStock, bE.stock]))
  const bO = (await buscarProductos(dbOwner, cOwner, 'OVR')).find((r) => r.productId === prodO.id)
  check('>>> y respeta el override del almacén (mínimo 4, hay 6: OK)', bO?.stockStatus === 'OK' && bO.minStock === 4)
  check('>>> tras un movimiento, el estado usa el override del almacén (6 → OK; 4 → crítico)', await estadoTrasMovimiento(dbOwner, { warehouseId: wA.id, productId: prodO.id, variantId: null, cantidad: 6 }) === 'OK' && await estadoTrasMovimiento(dbOwner, { warehouseId: wA.id, productId: prodO.id, variantId: null, cantidad: 4 }) === 'LOW')
  check('>>> tras un movimiento, lo reservado resta (25 con 20 reservados, mínimo 10: crítico)', await estadoTrasMovimiento(dbOwner, { warehouseId: wA.id, productId: prodE.id, variantId: null, cantidad: 25 }) === 'LOW')
  check('>>> tras un movimiento en una variante con mínimo 0 hereda el del producto (8 con mínimo 20: crítico)', await estadoTrasMovimiento(dbOwner, { warehouseId: wA.id, productId: prodV.id, variantId: vHereda.id, cantidad: 8 }) === 'LOW')
  check('>>> tras un movimiento en una variante con mínimo propio (6) lo usa: 7 → OK; 5 → crítico', await estadoTrasMovimiento(dbOwner, { warehouseId: wA.id, productId: prodV.id, variantId: vPropia.id, cantidad: 7 }) === 'OK' && await estadoTrasMovimiento(dbOwner, { warehouseId: wA.id, productId: prodV.id, variantId: vPropia.id, cantidad: 5 }) === 'LOW')
  check('>>> sin fila de stock aún (primer movimiento): usa el mínimo del producto sin reventar', await estadoTrasMovimiento(dbOwner, { warehouseId: wB.id, productId: prodE.id, variantId: null, cantidad: 3 }) === 'LOW')

  console.log('\n10) Los CHECK de la migración')
  const prodC = await prod('CHK', { minStock: 5 })
  const sC = await stock(prodC.id, wA.id, 1, { minStock: 5 })
  check('>>> un máximo negativo en el almacén se rechaza', await rechaza(prisma.stock.update({ where: { id: sC.id }, data: { maxStock: -1 } })))
  check('>>> un máximo por debajo del mínimo del mismo almacén se rechaza', await rechaza(prisma.stock.update({ where: { id: sC.id }, data: { maxStock: 4 } })))
  check('>>> un máximo igual al mínimo se acepta', !(await rechaza(prisma.stock.update({ where: { id: sC.id }, data: { maxStock: 5 } }))))
  const sSinMin = await stock(prodC.id, wB.id, 1)
  check('>>> sin mínimo en la fila, un máximo ≥ 0 se acepta; uno negativo NO pasa por tener el mínimo vacío (el CHECK con NULL aprueba)', !(await rechaza(prisma.stock.update({ where: { id: sSinMin.id }, data: { maxStock: 0 } }))) && await rechaza(prisma.stock.update({ where: { id: sSinMin.id }, data: { maxStock: -0.5 } })))
  check('>>> en la variante: máximo negativo o por debajo de su mínimo se rechaza', await rechaza(prisma.productVariant.update({ where: { id: vPropia.id }, data: { maxStock: -2 } })) && await rechaza(prisma.productVariant.update({ where: { id: vPropia.id }, data: { maxStock: 5 } })))
  check('>>> en la variante: máximo ≥ mínimo se acepta', !(await rechaza(prisma.productVariant.update({ where: { id: vPropia.id }, data: { maxStock: 6 } }))))
  const vNueva = await prisma.productVariant.create({ data: { tenantId: t.id, productId: prodV.id, sku: 'VAR-3', name: '1', minStock: 0 } })
  check('>>> una variante nueva nace con máximo NULL (hereda)', vNueva.maxStock === null)

  await prisma.tenant.delete({ where: { id: t.id } })
  await prisma.tenant.delete({ where: { id: ajeno.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
