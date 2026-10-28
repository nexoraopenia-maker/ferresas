import './guard'
import { correr } from './teardown'
import { crearSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { reporteDeReposicion } from '../src/features/inventory/reposicion-reporte'
import { NOMBRE_SIN_PROVEEDOR } from '../src/features/inventory/reposicion-pedido'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.6b · El reporte de reposición contra la base: agrupado por proveedor habitual, la cantidad redondeada hacia arriba a la última presentación comprada, la convención «bajo pedido»,
 * lo que ya viene en camino, el alcance por sucursal y, sobre todo, que sin `productos.ver_costo` la respuesta NO trae ni claves de costo.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rr-${randomUUID().slice(0, 8)}`, name: 'Reporte reposición', planId: plan.id } })
  const bA = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const bB = await crearSucursal(t.id, { code: 'SUR', name: 'Sur', seriesNumber: 2, isDefault: false, establishmentCode: '0001' })
  const wA = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WA', name: 'Norte', isDefault: true } })
  const wB = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bB.id, code: 'WB', name: 'Sur', isDefault: true } })
  const mk = (role: Role) => prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
  const [owner, alm, cont, caj] = await Promise.all([mk('OWNER'), mk('ALMACENERO'), mk('CONTADOR'), mk('CAJERO')])
  const ctx = (u: { id: string }, role: Role, branchIds: string[]): TenantContext => ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branchIds[0], branchIds })
  const cOwner = ctx(owner, 'OWNER', [bA.id, bB.id])
  const cAlmA = ctx(alm, 'ALMACENERO', [bA.id])
  const cCont = ctx(cont, 'CONTADOR', [bA.id, bB.id])
  const cCaj = ctx(caj, 'CAJERO', [bA.id])
  const db = (c: TenantContext) => getTenantPrisma(c)

  const s1 = await prisma.supplier.create({ data: { tenantId: t.id, name: 'Aceros SAC' } })
  const s2 = await prisma.supplier.create({ data: { tenantId: t.id, name: 'Zinc SRL' } })
  const sBaja = await prisma.supplier.create({ data: { tenantId: t.id, name: 'Cerrado SA', deletedAt: new Date() } })
  const prod = (sku: string, data: Record<string, unknown> = {}) => prisma.product.create({ data: { tenantId: t.id, sku, name: sku, ...data } as never })
  const stock = (productId: string, warehouseId: string, quantity: number) => prisma.stock.create({ data: { tenantId: t.id, productId, warehouseId, quantity } })

  const p1 = await prod('P1', { supplierId: s1.id, minStock: 10, costPrice: 5 })
  await stock(p1.id, wA.id, 4)                                          // objetivo 20, sugerida 16
  const p2 = await prod('P2', { supplierId: s1.id, minStock: 6, maxStock: 30, costPrice: 0 })
  await stock(p2.id, wA.id, 6)                                          // sugerida 24, sin costo
  const p3 = await prod('P3', { supplierId: s2.id, minStock: 4, unitType: 'KILOGRAMO', costPrice: 2 })
  await stock(p3.id, wA.id, 1.5)                                        // objetivo 8, sugerida 6.5
  const p4 = await prod('P4', { minStock: 5, costPrice: 3 })
  await stock(p4.id, wA.id, 0)                                          // sin proveedor, con mínimo → «Otros»
  const p5 = await prod('P5', { minStock: 0 })
  await stock(p5.id, wA.id, 0)                                          // bajo pedido, agotado → fuera
  const p6 = await prod('P6', { minStock: 0, costPrice: 4 })
  await stock(p6.id, wA.id, -2)                                         // bajo pedido pero NEGATIVO → entra
  const p7 = await prod('P7', { supplierId: s1.id, minStock: 10 })
  await stock(p7.id, wA.id, 3)                                          // 3 + 20 en camino → no dispara
  const p8 = await prod('P8', { supplierId: sBaja.id, minStock: 10, costPrice: 1 })
  await stock(p8.id, wA.id, 0)                                          // proveedor dado de baja → «Otros»
  const p9 = await prod('P9', { supplierId: s2.id, minStock: 8, costPrice: 1 })
  await stock(p9.id, wB.id, 0)                                          // solo en Sur
  await prod('P10', { supplierId: s1.id, minStock: 10 })                // nunca tuvo existencias en ningún almacén: sin dónde recibirse

  // Transferencia en camino hacia Norte con 20 de P7.
  const tr = await prisma.branchTransfer.create({ data: { tenantId: t.id, number: 'TR-1', status: 'EN_TRANSITO', requestedById: owner.id, fromBranchId: bB.id, fromWarehouseId: wB.id, toBranchId: bA.id, toWarehouseId: wA.id } })
  await prisma.branchTransferItem.create({ data: { tenantId: t.id, transferId: tr.id, productId: p7.id, nameSnapshot: 'P7', skuSnapshot: 'P7', quantitySent: 20 } })

  // Presentaciones: P1 se compró primero en caja de 6 y DESPUÉS en caja de 12 (manda la última); una compra anulada y una presentación inactiva no cuentan.
  const pres = (productId: string, name: string, factor: number, extra: Record<string, unknown> = {}) =>
    prisma.productPresentation.create({ data: { tenantId: t.id, productId, name, unitType: 'UNIDAD', factor, ...extra } as never })
  const compra = async (status: 'RECIBIDA' | 'ANULADA' | 'BORRADOR', productId: string, presentationId: string, factor: number, cuando: Date) => {
    const c = await prisma.purchase.create({ data: { tenantId: t.id, warehouseId: wA.id, userId: owner.id, number: `C-${randomUUID().slice(0, 6)}`, status, supplierId: s1.id, createdAt: cuando, ...(status === 'RECIBIDA' ? { receivedAt: cuando, receivedById: owner.id } : {}), ...(status === 'ANULADA' ? { voidedAt: cuando, voidedById: owner.id, voidReason: 'Prueba' } : {}) } })
    await prisma.purchaseItem.create({ data: { tenantId: t.id, purchaseId: c.id, productId, quantity: factor * 2, unitCost: 1, lineTotal: 1, presentationId, enteredQuantity: 2, presentationFactor: factor, presentationName: 'x', createdAt: cuando } })
  }
  const caja6 = await pres(p1.id, 'Caja 6', 6)
  const caja12 = await pres(p1.id, 'Caja 12', 12)
  const caja100 = await pres(p1.id, 'Caja 100 anulada', 100)
  const cajaMuerta = await pres(p1.id, 'Caja vieja', 50, { isActive: false })
  await compra('RECIBIDA', p1.id, caja6.id, 6, new Date('2026-01-10T10:00:00Z'))
  await compra('RECIBIDA', p1.id, caja12.id, 12, new Date('2026-03-10T10:00:00Z'))
  await compra('ANULADA', p1.id, caja100.id, 100, new Date('2026-05-10T10:00:00Z'))
  await compra('RECIBIDA', p1.id, cajaMuerta.id, 50, new Date('2026-06-10T10:00:00Z'))

  console.log('\n1) Quién entra y cómo se agrupa')
  const r = await reporteDeReposicion(db(cOwner), cOwner)
  const linea = (sku: string) => r.grupos.flatMap((g) => g.lineas).find((l) => l.sku === sku)
  const grupo = (id: string | null) => r.grupos.find((g) => g.supplierId === id)
  check('>>> hay un grupo por proveedor habitual y «Otros / Sin proveedor» AL FINAL', r.grupos.map((g) => g.nombre).join('|') === `Aceros SAC|Zinc SRL|${NOMBRE_SIN_PROVEEDOR}`, r.grupos.map((g) => g.nombre).join('|'))
  check('>>> Aceros SAC: P1 y P2 (P7 no entra: lo que viene en camino cubre su mínimo)', grupo(s1.id)?.lineas.map((l) => l.sku).sort().join(',') === 'P1,P2')
  check('>>> el proveedor dado de baja no desaparece: su producto va a «Otros»', grupo(null)?.lineas.some((l) => l.sku === 'P8') === true)
  check('>>> sin proveedor pero con mínimo (P4) también va a «Otros»', grupo(null)?.lineas.some((l) => l.sku === 'P4') === true)
  check('>>> >>> bajo pedido y agotado (P5) NO entra, y se cuenta como omitido', !linea('P5') && r.omitidosBajoPedido === 1, String(r.omitidosBajoPedido))
  check('>>> >>> bajo pedido pero con posición NEGATIVA (P6) SÍ entra, marcado, y pide el faltante (2)', linea('P6')?.bajoPedidoNegativo === true && linea('P6')?.sugerida === 2 && linea('P6')?.posicion === -2)
  check('>>> un producto sin ninguna fila de stock (P10) no se lista: la reposición se pide por almacén', !linea('P10'))
  check('>>> lo que ya viene en camino evita pedirlo otra vez (P7 no aparece)', !linea('P7'))
  check('>>> el total de líneas coincide con los grupos', r.totalLineas === r.grupos.reduce((s, g) => s + g.lineas.length, 0) && r.totalLineas === 7, String(r.totalLineas))

  console.log('\n2) Posición, objetivo, sugerida y redondeo')
  const l1 = linea('P1')!
  check('>>> P1: disponible 4, posición 4, mínimo 10, objetivo 20, sugerida 16', l1.disponible === 4 && l1.posicion === 4 && l1.minimo === 10 && l1.objetivo === 20 && l1.sugerida === 16)
  check('>>> >>> P1 se pide en la ÚLTIMA presentación comprada (Caja 12, no la de 6, ni la anulada, ni la inactiva): 16 → 2 cajas = 24 u', l1.pedir.presentacion?.name === 'Caja 12' && l1.pedir.cantidad === 2 && l1.pedir.unidadesBase === 24, JSON.stringify(l1.pedir))
  const l2 = linea('P2')!
  check('>>> P2 (sin compras con presentación) se pide en unidad base: 24 u', l2.pedir.presentacion === null && l2.pedir.cantidad === 24 && l2.objetivo === 30)
  const l3 = linea('P3')!
  check('>>> P3 a granel conserva los decimales: sugerida 6.5 kg', l3.sugerida === 6.5 && l3.pedir.cantidad === 6.5)
  check('>>> los grupos ordenan lo agotado primero (P4 agotado antes que P8)', grupo(null)?.lineas[0]?.estado === 'OUT')

  console.log('\n3) El filtro por almacén y el alcance por sucursal')
  const rA = await reporteDeReposicion(db(cOwner), cOwner, { warehouseId: wA.id })
  check('>>> filtrar por Norte deja fuera lo que solo está en Sur (P9)', !rA.grupos.flatMap((g) => g.lineas).some((l) => l.sku === 'P9') && rA.warehouseId === wA.id)
  const rB = await reporteDeReposicion(db(cOwner), cOwner, { warehouseId: wB.id })
  check('>>> filtrar por Sur trae solo P9', rB.grupos.flatMap((g) => g.lineas).map((l) => l.sku).join(',') === 'P9')
  check('>>> el dueño, sin filtro, ve Norte y Sur', linea('P9') !== undefined && r.almacenes.length === 2)
  const rAlm = await reporteDeReposicion(db(cAlmA), cAlmA)
  check('>>> el almacenero de Norte no ve lo de Sur ni su almacén', !rAlm.grupos.flatMap((g) => g.lineas).some((l) => l.sku === 'P9') && rAlm.almacenes.length === 1)
  const rRaro = await reporteDeReposicion(db(cAlmA), cAlmA, { warehouseId: wB.id })
  check('>>> pedir un almacén ajeno no lo abre: se comporta como «todos los suyos»', rRaro.warehouseId === null && !rRaro.grupos.flatMap((g) => g.lineas).some((l) => l.sku === 'P9'))

  console.log('\n4) Costos: solo con productos.ver_costo')
  const json = JSON.stringify(rAlm)
  check('>>> >>> el almacenero (sin ver costos) recibe una respuesta SIN claves de costo ni de valor', !/costoUnitario|valorEstimado|sinCosto|costPrice/.test(json) && rAlm.verCostos === false)
  check('>>> y su reporte sí trae las cantidades', rAlm.totalLineas > 0 && rAlm.grupos[0]!.lineas[0]!.sugerida > 0)
  const rCont = await reporteDeReposicion(db(cCont), cCont)
  const c1 = rCont.grupos.flatMap((g) => g.lineas).find((l) => l.sku === 'P1')!
  check('>>> el contador (ve costos) ve el costo unitario y el valor: 24 u × 5 = 120', rCont.verCostos && c1.costoUnitario === 5 && c1.valorEstimado === 120, JSON.stringify([c1.costoUnitario, c1.valorEstimado]))
  const cG = (id: string | null) => rCont.grupos.find((g) => g.supplierId === id)
  check('>>> una línea sin costo no suma y se cuenta aparte (P2: costo 0)', rCont.grupos.flatMap((g) => g.lineas).find((l) => l.sku === 'P2')?.valorEstimado === null && cG(s1.id)?.sinCosto === 1 && cG(s1.id)?.valorEstimado === 120, JSON.stringify([cG(s1.id)?.sinCosto, cG(s1.id)?.valorEstimado]))
  // Zinc: P3 6.5 kg × 2 = 13 ; P9 está en Sur (el contador alcanza ambas) 8×2=16 − 0 = objetivo 16, sugerida 16 × 1 = 16.
  check('>>> el valor del proveedor suma sus líneas: Zinc = 6.5 × 2 + 16 × 1 = 29', cG(s2.id)?.valorEstimado === 29, String(cG(s2.id)?.valorEstimado))
  check('>>> el valor total es la suma de los grupos', rCont.valorEstimado === Math.round(rCont.grupos.reduce((s, g) => s + (g.valorEstimado ?? 0), 0) * 100) / 100)
  const rDueno = await reporteDeReposicion(db(cOwner), cOwner)
  check('>>> el dueño también ve los valores', rDueno.verCostos && rDueno.valorEstimado === rCont.valorEstimado)

  console.log('\n5) Permisos')
  check('>>> el cajero no puede ver la reposición', await code(reporteDeReposicion(db(cCaj), cCaj)) === 'FORBIDDEN_ROLE')
  check('>>> un almacenero con ver_costo denegado/extra: el permiso de costos se evalúa por separado (extra lo activa)', await (async () => { const c2 = { ...cAlmA, permisosExtra: ['productos.ver_costo' as const] }; const x = await reporteDeReposicion(getTenantPrisma(c2), c2); return x.verCostos && x.valorEstimado !== undefined })())

  console.log('\n6) Aislamiento entre negocios')
  const otro = await prisma.tenant.create({ data: { slug: `rr2-${randomUUID().slice(0, 8)}`, name: 'Otro', planId: plan.id } })
  const pO = await prisma.product.create({ data: { tenantId: otro.id, sku: 'AJENO', name: 'Ajeno', minStock: 5 } })
  const r2 = await reporteDeReposicion(db(cOwner), cOwner)
  check('>>> el producto de otro negocio no aparece', !r2.grupos.flatMap((g) => g.lineas).some((l) => l.productId === pO.id))

  await prisma.tenant.delete({ where: { id: otro.id } })
  await prisma.tenant.delete({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
