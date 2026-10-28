import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma, type TenantPrismaClient } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { crearBorrador, recibirCompra } from '../src/features/compras/service'
import { applyStockMovement, createStockMovement } from '../src/features/inventory/stock-service'
import { createStockMovementSchema, createProductExpressSchema } from '../src/features/inventory/schemas'
import { createProductExpress } from '../src/features/inventory/product-service'
import { resolverMerma, solicitarMerma } from '../src/features/inventory/merma-service'
import { resolverMermaSchema, solicitarMermaSchema } from '../src/features/inventory/merma-schemas'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { anularOdevolverVenta } from '../src/features/devoluciones/service'
import { anularOdevolverVentaSchema } from '../src/features/devoluciones/schemas'
import { openCashSession } from '../src/features/branches/cash-service'
import { openCashSchema } from '../src/features/branches/cash-schemas'
import { approveTransfer, createTransfer, shipTransfer } from '../src/features/branches/transfer-service'
import { createTransferSchema } from '../src/features/branches/transfer-schemas'
import { almacenesDelKardex, exportarKardexCsv, kardexDeProducto, type KardexResultado, type LineaKardex } from '../src/features/inventory/kardex-service'
import { kardexCsvSchema, kardexSchema } from '../src/features/inventory/kardex-schemas'
import { permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'
import { PERMISOS } from '../src/lib/permisos'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.4b · El kardex contra la base: permisos (kardex.ver / productos.ver_costo, el PIN), seguridad de costos (sin ver costos NO se leen ni se mandan), alcance
 * por sucursal, saldo inicial y final, líneas con su documento, paginación por cursor, totales y cuadre con el stock, stock negativo, costos y marcas, y la
 * exportación a CSV (mismas reglas, tope de 50.000 filas, inyección de fórmulas, auditoría).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const cerca = (a: number, b: number) => Math.abs(a - b) < 1e-6
const CLAVES_COSTO = ['costos', 'costoUnitario', 'costoPromedio', 'saldoValorizado', 'costoActual', 'valorizado', 'saldoFinalValorizado', 'unitCostApplied', 'costAfter', 'costOrigin', 'costPending', 'pendiente']

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 500) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-kdx-${randomUUID().slice(0, 6)}`, name: 'Kardex lectura', taxId: ruc(), planId: plan.id, realBillingEnabledAt: new Date('2026-01-01T00:00:00Z') } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_kdx' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const W1 = b1.warehouse.id, W2 = b2.warehouse.id
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ADMIN', 'CONTADOR', 'ALMACENERO', 'CAJERO', 'VENDEDOR'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    for (const b of [b1, b2]) await asignarSucursal(t.id, x.id, b.branch.id)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: [] }
  }
  const O = u.OWNER!, AD = u.ADMIN!, K = u.CONTADOR!, AL = u.ALMACENERO!, CA = u.CAJERO!, VE = u.VENDEDOR!
  const OB2: TenantContext = { ...O, branchId: b2.branch.id }
  const AL1: TenantContext = { ...AL, branchIds: [b1.branch.id] }          // almacenero que solo alcanza la sucursal 1
  const AL2: TenantContext = { ...AL, branchId: b2.branch.id, branchIds: [b2.branch.id] }
  const PIN: TenantContext = { ...O, operadorDe: O.userId, permisosDenegados: permisosDenegadosAlOperador(new Set(PERMISOS)) }
  const db = (c: TenantContext) => getTenantPrisma(c)
  const P = await prisma.product.create({ data: { tenantId: t.id, sku: 'KX1', name: 'Cemento', unitType: 'UNIDAD', salePrice: 20, costPrice: 0 } })
  const comprar = async (cantidad: number, costo: number) => {
    const b = await crearBorrador(db(O), O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: W1, items: [{ productId: P.id, enteredQuantity: cantidad, unitCost: costo }] }))
    await recibirCompra(db(O), O, recibirCompraSchema.parse({ purchaseId: b.id }))
    return b.id
  }
  const vender = (ctx: TenantContext, w: string, q: number, monto: number, forzar = false) =>
    registerSale(db(ctx), ctx, registerSaleSchema.parse({ warehouseId: w, items: [{ productId: P.id, quantity: q, discount: 0 }], payments: [{ method: 'EFECTIVO', amount: monto }], documentType: 'NOTA_VENTA', allowNegativeStock: forzar, idempotencyKey: randomUUID() }) as never)

  // ─── La historia (14 movimientos en 2 almacenes) ─────────────────────────────────────────────────────────────────
  const c1 = await comprar(10, 5)                                                      // 1
  const c2 = await comprar(10, 7)                                                      // 2  promedio 6
  const v1 = await vender(O, W1, 4, 80)                                                // 3
  await openCashSession(db(O), O, openCashSchema.parse({ openingAmount: 100 }))
  await anularOdevolverVenta(db(O), O, anularOdevolverVentaSchema.parse({ saleId: v1.saleId, kind: 'ANULACION', reason: 'Se equivocó el cajero', idempotencyKey: randomUUID() }))   // 4
  await createStockMovement(db(O), O, createStockMovementSchema.parse({ productId: P.id, warehouseId: W2, type: 'ENTRADA', quantity: 5, unitCost: 9, source: 'MANUAL', reason: '=HYPERLINK("http://x.test","clic")' }))   // 5
  await createStockMovement(db(AL2), AL2, createStockMovementSchema.parse({ productId: P.id, warehouseId: W2, type: 'ENTRADA', quantity: 2, source: 'MANUAL', reason: 'Llegó sin factura' }))                          // 6
  const tr = await createTransfer(db(O), O, createTransferSchema.parse({ fromWarehouseId: W1, toBranchId: b2.branch.id, toWarehouseId: W2, items: [{ productId: P.id, quantity: 2 }] }))
  await approveTransfer(db(AD), AD, { transferId: tr.id }); await shipTransfer(db(O), O, { transferId: tr.id })     // 7
  const v2 = await vender(OB2, W2, 10, 200, true)                                       // 8  deja W2 en negativo
  const filaW1 = await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId: P.id, warehouseId: W1 } })
  await createStockMovement(db(O), O, createStockMovementSchema.parse({ productId: P.id, warehouseId: W1, type: 'AJUSTE', quantity: 15, reason: 'Conteo físico del mes', expectedVersion: filaW1.version, source: 'MANUAL' }))   // 9
  const sol = await solicitarMerma(db(AL), AL, solicitarMermaSchema.parse({ warehouseId: W1, productId: P.id, quantity: 1, reason: 'Se cayó el rollo y quedó inservible' }))
  await resolverMerma(db(O), O, resolverMermaSchema.parse({ mermaId: sol.id, decision: 'APROBAR' }))                // 10
  const BASE = Date.UTC(2026, 9, 1, 15, 0, 0), DIA = 86_400_000       // 10:00 en Lima
  const movs = await prisma.stockMovement.findMany({ where: { tenantId: t.id, productId: P.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  for (const [i, m] of movs.entries()) await prisma.$executeRaw`UPDATE stock_movements SET "createdAt" = ${new Date(BASE + i * DIA)} WHERE id = ${m.id}`
  const dia = (i: number) => new Date(BASE + i * DIA).toISOString().slice(0, 10)
  const N = movs.length
  check('(preparación) la historia tiene 10 movimientos en 2 almacenes', N === 10 && new Set(movs.map((m) => m.warehouseId)).size === 2, String(N))
  const DESDE = '2026-10-01', HASTA = '2026-10-31'
  const completo = (c: TenantContext, extra: Record<string, unknown> = {}) => kardexDeProducto(db(c), c, kardexSchema.parse({ productId: P.id, desde: DESDE, hasta: HASTA, limite: 200, ...extra }))
  const stockReal = async (w?: string) => Number((await prisma.stock.aggregate({ where: { tenantId: t.id, productId: P.id, ...(w ? { warehouseId: w } : {}) }, _sum: { quantity: true } }))._sum.quantity ?? 0)

  console.log('\nA) Permisos')
  check('>>> el cajero y el vendedor no ven el kardex (FORBIDDEN_ROLE)', await code(completo(CA)) === 'FORBIDDEN_ROLE' && await code(completo(VE)) === 'FORBIDDEN_ROLE')
  check('>>> y no se entera de si el producto existe: sin permiso, un producto inexistente da FORBIDDEN_ROLE, no NOT_FOUND', await code(kardexDeProducto(db(CA), CA, kardexSchema.parse({ productId: 'no-existe' }))) === 'FORBIDDEN_ROLE' && await code(almacenesDelKardex(db(CA), CA)) === 'FORBIDDEN_ROLE')
  check('>>> con el PIN de operador tampoco, ni siquiera el dueño', await code(completo(PIN)) === 'FORBIDDEN_ROLE' && await code(almacenesDelKardex(db(PIN), PIN)) === 'FORBIDDEN_ROLE')
  check('>>> la exportación exige lo mismo', await code(exportarKardexCsv(db(CA), CA, kardexCsvSchema.parse({ productId: P.id }))) === 'FORBIDDEN_ROLE' && await code(exportarKardexCsv(db(PIN), PIN, kardexCsvSchema.parse({ productId: P.id }))) === 'FORBIDDEN_ROLE')
  const kO = await completo(O), kK = await completo(K), kA = await completo(AL)
  check('>>> dueño, contador y almacenero sí lo ven', kO.lineas.length === N && kK.lineas.length === N && kA.lineas.length === N)
  check('>>> costos: dueño y contador (productos.ver_costo) sí; el almacenero NO', kO.conCostos && kK.conCostos && !kA.conCostos)

  console.log('\nB) Seguridad de costos: sin `productos.ver_costo` no se lee ni se manda')
  const texto = JSON.stringify(kA)
  check('>>> el resultado del almacenero no tiene NINGUNA clave de costo (ni vacía: no existe)', CLAVES_COSTO.every((k) => !texto.includes(`"${k}"`)), CLAVES_COSTO.filter((k) => texto.includes(`"${k}"`)).join(','))
  check('>>> ni en las líneas ni en el saldo inicial ni en los totales', kA.lineas.every((l) => !('costos' in l)) && !('costos' in kA.saldoInicial) && !('costos' in kA.totales) && !('costoActual' in kA.producto))
  check('>>> ni siquiera los números: el costo 5.00, 7.00 o 6.00 y el 9.00 no aparecen como importes', !/"(valor|costo\w*)"/.test(texto))
  check('>>> y no hay alertas de costos (ni siquiera cuántas entradas esperan costo)', kA.alertas.every((a) => a.codigo !== 'COSTO_PENDIENTE' && a.codigo !== 'SIN_COSTO'))
  const espiar = (c: TenantContext) => {
    const log: string[] = []
    const base = db(c)
    const envolver = (modelo: object) => new Proxy(modelo, { get(m, k) { const v = (m as Record<string | symbol, unknown>)[k]; return typeof v === 'function' ? (...a: unknown[]) => { log.push(JSON.stringify(a[0] ?? {})); return (v as (...x: unknown[]) => unknown).apply(m, a) } : v } })
    const proxy = new Proxy(base, { get(m, k) { const v = (m as unknown as Record<string | symbol, unknown>)[k]; return k === 'stockMovement' || k === 'product' || k === 'stock' ? envolver(v as object) : v } }) as unknown as TenantPrismaClient
    return { proxy, log }
  }
  const sA = espiar(AL), sK = espiar(K)
  await kardexDeProducto(sA.proxy, AL, kardexSchema.parse({ productId: P.id, desde: DESDE, hasta: HASTA, limite: 3 }))
  await kardexDeProducto(sK.proxy, K, kardexSchema.parse({ productId: P.id, desde: DESDE, hasta: HASTA, limite: 3 }))
  const COLS = /unitCostApplied|costAfter|costOrigin|costPending|costPrice|unitCost/
  check('>>> el servidor NO LEE las columnas de costo para quien no ve costos: ninguna consulta las nombra', sA.log.length > 5 && sA.log.every((q) => !COLS.test(q)), sA.log.find((q) => COLS.test(q))?.slice(0, 150))
  check('>>> (control) con productos.ver_costo sí las lee: el espía las detecta', sK.log.some((q) => /costAfter/.test(q)) && sK.log.some((q) => /costPrice/.test(q)))

  console.log('\nC) Alcance por sucursal')
  const alms = await almacenesDelKardex(db(O), O)
  check('>>> el dueño alcanza los dos almacenes; el almacenero de la sucursal 1, sólo el suyo', alms.length === 2 && (await almacenesDelKardex(db(AL1), AL1)).map((a) => a.id).join() === W1)
  const k1 = await completo(AL1)
  check('>>> el almacenero de la sucursal 1 sólo ve movimientos de SU almacén (aunque el producto se mueva en los dos)', k1.lineas.length > 0 && k1.lineas.length < N && k1.lineas.every((l) => l.almacen.id === W1) && k1.almacenes.length === 1)
  check('>>> y pedir el almacén de otra sucursal es NOT_FOUND', await code(completo(AL1, { warehouseId: W2 })) === 'NOT_FOUND' && await code(exportarKardexCsv(db(AL1), AL1, kardexCsvSchema.parse({ productId: P.id, warehouseId: W2 }))) === 'NOT_FOUND')
  check('>>> su saldo es el de su almacén, no el del negocio', cerca(k1.totales.saldoFinal, await stockReal(W1)) && k1.totales.cuadraConStock === true)

  console.log('\nD) Líneas, saldos y totales (consolidado)')
  check('>>> las líneas salen en orden cronológico', kO.lineas.every((l, i) => i === 0 || l.cuando >= kO.lineas[i - 1]!.cuando))
  check('>>> el saldo corrido es la suma de las filas de stock: cada línea = saldo anterior + entrada − salida', kO.lineas.every((l, i) => cerca(l.saldo, (i === 0 ? kO.saldoInicial.cantidad : kO.lineas[i - 1]!.saldo) + l.entrada - l.salida)))
  check('>>> el saldo inicial del primer día es 0 y el final es el stock real de los dos almacenes', kO.saldoInicial.cantidad === 0 && cerca(kO.totales.saldoFinal, await stockReal()) && cerca(kO.lineas[N - 1]!.saldo, await stockReal()))
  check('>>> el saldo final por movimientos y por saldos registrados coinciden (el libro es consistente) y cuadra con Stock.quantity', kO.totales.consistente && kO.totales.cuadraConStock === true && !kO.alertas.some((a) => a.codigo === 'NO_CUADRA' || a.codigo === 'LIBRO_INCONSISTENTE'))
  const ent = kO.lineas.reduce((a, l) => a + l.entrada, 0), sal = kO.lineas.reduce((a, l) => a + l.salida, 0)
  check('>>> los totales del rango son la suma de las líneas', cerca(kO.totales.entradas, ent) && cerca(kO.totales.salidas, sal) && kO.totales.movimientos === N && cerca(kO.totales.saldoPorMovimientos, kO.totales.saldoFinal))
  const kW1 = await completo(O, { warehouseId: W1 })
  check('>>> con UN almacén, el saldo de cada línea es exactamente el que registró la base (sin descuadre)', kW1.lineas.length > 0 && kW1.lineas.every((l) => cerca(l.saldo, l.saldoAlmacen) && !l.descuadre) && kW1.almacenElegido === W1)
  check('>>> cada línea trae quién, motivo, almacén y el tipo/origen del movimiento', kO.lineas.every((l) => l.usuario && l.almacen.nombre && l.tipo && l.origen) && kO.lineas.some((l) => l.motivo === 'Conteo físico del mes'))
  check('>>> sin movimientos el rango da saldo inicial = final, sin líneas, sin siguiente', await (async () => { const r = await kardexDeProducto(db(O), O, kardexSchema.parse({ productId: P.id, desde: '2026-12-01', hasta: '2026-12-05' })); return r.lineas.length === 0 && r.siguiente === null && cerca(r.saldoInicial.cantidad, r.totales.saldoFinal) && cerca(r.saldoInicial.cantidad, await stockReal()) && r.totales.cuadraConStock === true })())

  console.log('\nE) Saldo inicial: parte del último movimiento anterior')
  const mitad = dia(4)
  const kM = await completo(O, { desde: mitad })
  check('>>> arrancando en el día 5, el saldo inicial es el saldo de la línea 4 del kardex completo', kM.lineas.length === N - 4 && cerca(kM.saldoInicial.cantidad, kO.lineas[3]!.saldo), `${kM.saldoInicial.cantidad} vs ${kO.lineas[3]!.saldo}`)
  check('>>> y las líneas del rango son idénticas (mismos saldos) a las del completo', kM.lineas.every((l, i) => l.id === kO.lineas[i + 4]!.id && cerca(l.saldo, kO.lineas[i + 4]!.saldo)))
  const kHasta = await completo(O, { hasta: dia(4) })
  check('>>> con `hasta` en medio el saldo final es el de ese día, NO el de hoy: no compara con el stock actual (hay movimientos posteriores)', kHasta.lineas.length === 5 && cerca(kHasta.totales.saldoFinal, kO.lineas[4]!.saldo) && kHasta.totales.cuadraConStock === null && !kHasta.alertas.some((a) => a.codigo === 'NO_CUADRA'))
  check('>>> el día `hasta` entra COMPLETO (todo su día local)', kHasta.lineas[4]!.id === kO.lineas[4]!.id)

  console.log('\nF) Paginación por cursor')
  const paginas: KardexResultado[] = []
  let cursor: string | undefined
  do { const r = await completo(O, { limite: 3, cursor }); paginas.push(r); cursor = r.siguiente ?? undefined } while (cursor && paginas.length < 20)
  const unidas = paginas.flatMap((p) => p.lineas)
  check('>>> páginas de 3 sobre 10 movimientos: 4 páginas (3+3+3+1), la última sin cursor', paginas.length === 4 && paginas.map((p) => p.lineas.length).join() === '3,3,3,1' && paginas[3]!.siguiente === null && paginas.slice(0, 3).every((p) => p.siguiente))
  check('>>> unidas dan EXACTAMENTE las mismas líneas y saldos que sin paginar (sin saltos ni repetidos)', unidas.length === N && unidas.every((l, i) => l.id === kO.lineas[i]!.id && cerca(l.saldo, kO.lineas[i]!.saldo)))
  check('>>> cada página trae los MISMOS totales del rango completo (no los de su trozo)', paginas.every((p) => p.totales.movimientos === N && cerca(p.totales.saldoFinal, kO.totales.saldoFinal) && cerca(p.saldoInicial.cantidad, kO.saldoInicial.cantidad)))
  const justo = await completo(O, { limite: N }), faltaUno = await completo(O, { limite: N - 1 })
  check('>>> con límite = total no hay página siguiente; con total−1 sí', justo.siguiente === null && faltaUno.siguiente !== null && faltaUno.lineas.length === N - 1)
  const pagMedio = await completo(O, { desde: dia(2), limite: 2 })
  const pagMedio2 = await completo(O, { desde: dia(2), limite: 2, cursor: pagMedio.siguiente! })
  check('>>> la paginación funciona también con saldo inicial distinto de cero', pagMedio.lineas.length === 2 && cerca(pagMedio2.lineas[0]!.saldo, kO.lineas[4]!.saldo) && pagMedio2.lineas[0]!.id === kO.lineas[4]!.id)
  check('>>> un cursor adulterado es INVALID_DOCUMENT', await code(completo(O, { cursor: 'basura' })) === 'INVALID_DOCUMENT')
  const ids = new Set<string>(); let repetido = false
  for (const l of unidas) { if (ids.has(l.id)) repetido = true; ids.add(l.id) }
  check('>>> ningún movimiento aparece dos veces entre páginas', !repetido)

  console.log('\nG) Documentos de origen y permisos para verlos')
  const doc = (k: KardexResultado, f: (l: LineaKardex) => boolean) => k.lineas.find(f)!.documento
  const saleNum = (await prisma.sale.findUniqueOrThrow({ where: { id: v1.saleId } })).number
  const compraNum = (await prisma.purchase.findUniqueOrThrow({ where: { id: c1 } })).number
  const dv = await prisma.saleReturn.findFirstOrThrow({ where: { tenantId: t.id, saleId: v1.saleId } })
  const lVenta = (l: LineaKardex) => l.documento.tipo === 'VENTA' && l.entrada === 0
  check('>>> la venta: tipo, número y enlace a /ventas/[id] para quien puede ver ventas (dueño y contador)', [kO, kK].every((k) => { const d = doc(k, lVenta); return d.numero !== null && d.href?.startsWith('/ventas/') === true }) && doc(kO, (l) => l.documento.numero === saleNum).href === `/ventas/${v1.saleId}`)
  check('>>> la compra: número y enlace /compras/[id]', (() => { const d = kO.lineas.map((l) => l.documento).find((x) => x.numero === compraNum)!; return d.tipo === 'COMPRA' && d.href === `/compras/${c1}` })() && c2 !== c1)
  check('>>> la devolución: su número D001-… y enlace a la venta', (() => { const d = kO.lineas.map((l) => l.documento).find((x) => x.tipo === 'DEVOLUCION')!; return d.numero === dv.number && d.href === `/ventas/${v1.saleId}` })())
  check('>>> la transferencia: el número de la transferencia (sin enlace: no hay pantalla de detalle)', (() => { const d = kO.lineas.map((l) => l.documento).find((x) => x.tipo === 'TRANSFERENCIA')!; return d.numero === tr.number && d.href === null })())
  check('>>> la merma y los movimientos manuales (ajuste, entradas) se distinguen', kO.lineas.some((l) => l.documento.tipo === 'MERMA') && kO.lineas.filter((l) => l.documento.tipo === 'MANUAL').length === 3)
  const dA = kA.lineas.map((l) => l.documento)
  check('>>> el almacenero (sin permisos de ventas ni compras) ve el TIPO pero ni el número ni el enlace', dA.filter((d) => d.tipo === 'VENTA' || d.tipo === 'COMPRA' || d.tipo === 'DEVOLUCION').length >= 4 && dA.filter((d) => d.tipo === 'VENTA' || d.tipo === 'COMPRA' || d.tipo === 'DEVOLUCION').every((d) => d.numero === null && d.href === null))
  check('>>> la venta del almacén 2 no se enlaza al almacenero de la sucursal 1 (ni aparece en su kardex)', !k1.lineas.some((l) => l.almacen.id === W2) && v2.saleId !== v1.saleId)
  const sinVentas: TenantContext = { ...AL, permisosExtra: ['compras.registrar'] }
  const kC = await completo(sinVentas)
  check('>>> con compras.registrar (sin ventas) ve las compras pero no las ventas: un permiso = un poder', kC.lineas.map((l) => l.documento).filter((d) => d.tipo === 'COMPRA').every((d) => d.numero !== null && d.href !== null) && kC.lineas.map((l) => l.documento).filter((d) => d.tipo === 'VENTA').every((d) => d.numero === null))

  console.log('\nH) Stock negativo y estados')
  const negativas = kO.lineas.filter((l) => l.stockNegativo)
  check('>>> la venta forzada del almacén 2 deja el stock negativo: la línea lo marca y hay alerta con la cuenta', negativas.length >= 1 && negativas.every((l) => l.saldoAlmacen < 0 && l.almacen.id === W2) && kO.alertas.some((a) => a.codigo === 'STOCK_NEGATIVO' && a.cantidad === negativas.length))
  check('>>> el almacenero (sin costos) también ve la alerta de stock negativo: son unidades', kA.alertas.some((a) => a.codigo === 'STOCK_NEGATIVO'))

  console.log('\nI) Costos y marcas (productos.ver_costo)')
  const lc = (k: KardexResultado, f: (l: LineaKardex) => boolean) => k.lineas.find(f)!.costos!
  const compra1 = kK.lineas[0]!.costos!, compra2 = kK.lineas[1]!.costos!
  check('>>> compra 1 (10 a S/ 5): costo unitario 5, valor 50, promedio 5, saldo valorizado 50, EXACTO', compra1.costoUnitario === 5 && compra1.valor === 50 && compra1.costoPromedio === 5 && compra1.saldoValorizado === 50 && compra1.origen === 'EXACTO' && !compra1.pendiente)
  check('>>> compra 2 (10 a S/ 7): promedio 6, saldo 20 × 6 = 120', compra2.costoUnitario === 7 && compra2.valor === 70 && compra2.costoPromedio === 6 && compra2.saldoValorizado === 120)
  const vtaC = lc(kK, (l) => lVenta(l) && l.almacen.id === W1)
  check('>>> la venta sale al promedio vigente: −4 × 6 = −24, con saldo 16 × 6 = 96', vtaC.costoUnitario === 6 && vtaC.valor === -24 && vtaC.saldoValorizado === 96)
  check('>>> el saldo valorizado de CADA línea es el saldo de la consulta (no el de su almacén) × el promedio de ese momento', kK.lineas.filter((l) => l.costos!.costoPromedio !== null).every((l) => cerca(l.costos!.saldoValorizado!, Math.round(l.saldo * l.costos!.costoPromedio! * 100) / 100)) && kK.lineas.some((l) => !cerca(l.saldo, l.saldoAlmacen)))
  check('>>> el usuario sale por su NOMBRE, no por su correo', kO.lineas.every((l) => ['OWNER', 'ADMIN', 'ALMACENERO', 'CONTADOR'].includes(l.usuario!)))
  const sinCosto = kK.lineas.find((l) => l.motivo === 'Llegó sin factura')!
  check('>>> la entrada sin costo: valor NULL, marcada «pendiente» y con alerta de cuántas esperan', sinCosto.costos!.costoUnitario === null && sinCosto.costos!.valor === null && sinCosto.costos!.pendiente && kK.alertas.some((a) => a.codigo === 'COSTO_PENDIENTE' && a.cantidad === 1))
  check('>>> la entrada con costo 9 se valora a 9 (valor 45) sin mover el promedio (6)', (() => { const c = kK.lineas.find((l) => l.motivo?.startsWith('=HYPERLINK'))!.costos!; return c.costoUnitario === 9 && c.valor === 45 && c.costoPromedio === 6 })())
  check('>>> los totales traen el promedio al final y el saldo final valorizado = saldo × promedio', kK.totales.costos?.costoPromedio !== null && cerca(kK.totales.costos!.saldoFinalValorizado!, Math.round(kK.totales.saldoFinal * kK.totales.costos!.costoPromedio! * 100) / 100))
  check('>>> el producto trae su costo actual', kK.producto.costoActual === num((await prisma.product.findUniqueOrThrow({ where: { id: P.id } })).costPrice))
  const kMc = await completo(K, { desde: mitad })
  check('>>> (con costos) el saldo inicial del día 5 se valoriza al promedio de entonces', !!kMc.saldoInicial.costos && kMc.saldoInicial.costos.costoPromedio === 6 && cerca(kMc.saldoInicial.costos.valorizado!, Math.round(kMc.saldoInicial.cantidad * 6 * 100) / 100) && kMc.saldoInicial.costos.origen === 'EXACTO')
  const cualquiera = movs[2]!
  await prisma.$executeRawUnsafe(`UPDATE stock_movements SET "costOrigin"='SIN_DATO', "costAfter"=NULL, "unitCostApplied"=NULL WHERE id='${cualquiera.id}'`)
  const kS = await completo(K)
  const lS = kS.lineas.find((l) => l.id === cualquiera.id)!.costos!
  check('>>> un movimiento SIN_DATO sale sin cifras (nada inventado), con su marca, y hay alerta', lS.origen === 'SIN_DATO' && lS.costoUnitario === null && lS.costoPromedio === null && lS.saldoValorizado === null && lS.valor === null && kS.alertas.some((a) => a.codigo === 'SIN_COSTO' && a.cantidad === 1))

  console.log('\nJ) Errores y aislamiento')
  check('>>> un producto que no existe es NOT_FOUND', await code(kardexDeProducto(db(O), O, kardexSchema.parse({ productId: 'no-existe' }))) === 'NOT_FOUND')
  const otro = await prisma.tenant.create({ data: { slug: `rp-kdx2-${randomUUID().slice(0, 6)}`, name: 'Otro', taxId: ruc(), planId: plan.id } })
  const po = await prisma.product.create({ data: { tenantId: otro.id, sku: 'Z', name: 'Z', unitType: 'UNIDAD', salePrice: 1, costPrice: 0 } })
  check('>>> el producto de OTRO negocio es NOT_FOUND', await code(kardexDeProducto(db(O), O, kardexSchema.parse({ productId: po.id }))) === 'NOT_FOUND')
  const wOtro = await crearSucursalConAlmacen(otro.id)
  check('>>> el almacén de otro negocio es NOT_FOUND', await code(completo(O, { warehouseId: wOtro.warehouse.id })) === 'NOT_FOUND')
  check('>>> una variante que no es del producto es NOT_FOUND', await code(completo(O, { variantId: 'no-es-variante' })) === 'NOT_FOUND')
  check('>>> un rango de más de 12 meses es INVALID_DOCUMENT', await code(kardexDeProducto(db(O), O, kardexSchema.parse({ productId: P.id, desde: '2025-01-01', hasta: '2026-10-28' }))) === 'INVALID_DOCUMENT')

  console.log('\nK) El día es el del negocio (Lima), no el UTC')
  const Q = await prisma.product.create({ data: { tenantId: t.id, sku: 'KX2', name: 'Tubo', unitType: 'UNIDAD', salePrice: 5, costPrice: 0 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: Q.id, warehouseId: W1, quantity: 7 } })
  const mk = (cuando: string, q: number, saldo: number) => prisma.stockMovement.create({ data: { tenantId: t.id, productId: Q.id, warehouseId: W1, userId: O.userId, type: 'ENTRADA', quantity: q, balanceAfter: saldo, createdAt: new Date(cuando) } })
  await mk('2026-10-10T04:30:00Z', 3, 3)     // 23:30 del 9 en Lima
  await mk('2026-10-10T05:00:00Z', 4, 7)     // 00:00 exacta del 10 en Lima
  const dQ = (d: string) => kardexDeProducto(db(O), O, kardexSchema.parse({ productId: Q.id, desde: d, hasta: d }))
  const q9 = await dQ('2026-10-09'), q10 = await dQ('2026-10-10')
  check('>>> a las 23:30 de Lima del 9 el movimiento es del día 9, aunque en UTC ya sea el 10', q9.lineas.length === 1 && q9.lineas[0]!.entrada === 3 && q9.saldoInicial.cantidad === 0)
  check('>>> a las 00:00 de Lima del 10 ya es del día 10, con saldo inicial 3 (el del día anterior)', q10.lineas.length === 1 && q10.lineas[0]!.entrada === 4 && q10.saldoInicial.cantidad === 3 && q10.totales.saldoFinal === 7 && q10.totales.cuadraConStock === true && q9.totales.cuadraConStock === null)

  console.log('\nL) Exportación a CSV')
  const csvO = await exportarKardexCsv(db(O), O, kardexCsvSchema.parse({ productId: P.id, desde: DESDE, hasta: HASTA }))
  const filasO = csvO.contenido.split('\r\n').filter(Boolean)
  check('>>> el archivo lleva BOM, separador «;», nombre con SKU y rango, y una fila por movimiento + saldo inicial + totales', csvO.contenido.startsWith('﻿') && csvO.nombre === `kardex-KX1-${DESDE}_${HASTA}.csv` && filasO.length === 1 + 1 + N + 1 && csvO.filas === N)
  check('>>> con costos (dueño) la cabecera trae las 6 columnas de valor', filasO[0]!.includes('Costo unitario') && filasO[0]!.includes('Saldo valorizado') && filasO[0]!.includes('Origen del costo'))
  const csvA = await exportarKardexCsv(db(AL), AL, kardexCsvSchema.parse({ productId: P.id, desde: DESDE, hasta: HASTA }))
  const filasA = csvA.contenido.split('\r\n').filter(Boolean)
  check('>>> SIN costos (almacenero) la cabecera no tiene ninguna columna de valor y las filas tienen menos celdas', !/Costo|Valor|valorizado/i.test(filasA[0]!) && filasA[0]!.split(';').length === 12 && filasO[0]!.split(';').length === 18)
  check('>>> todas las filas del CSV sin costos tienen exactamente las 12 columnas de unidades (ninguna celda de valor escondida) y las del dueño 18', filasA.every((f) => f.split(';').length === 12) && filasO.every((f) => f.split(';').length === 18))
  check('>>> el motivo que empieza por «=» se neutraliza (apóstrofo): no se ejecuta como fórmula en Excel', csvO.contenido.includes(`'=HYPERLINK`) && !/;=HYPERLINK/.test(csvO.contenido) && !csvA.contenido.includes(';=HYPERLINK'))
  check('>>> la primera fila es el saldo inicial y la última los totales del rango', filasO[1]!.startsWith(`Saldo inicial al ${DESDE}`) && filasO[filasO.length - 1]!.startsWith(`Totales ${DESDE} a ${HASTA}`))
  const totalesFila = filasO[filasO.length - 1]!.split(';')
  check('>>> los totales del CSV coinciden con los de la lectura (entradas, salidas, saldo final)', cerca(Number(totalesFila[8]), kO.totales.entradas) && cerca(Number(totalesFila[9]), kO.totales.salidas) && cerca(Number(totalesFila[10]), kO.totales.saldoFinal))
  const auds = await prisma.auditLog.findMany({ where: { tenantId: t.id, action: 'reporte.exportado', entityId: 'kardex' }, orderBy: { createdAt: 'asc' } })
  check('>>> cada descarga deja su línea de auditoría (qué, cuántas filas y si llevaba costos)', auds.length === 2 && (auds[0]!.after as { conCostos: boolean }).conCostos === true && (auds[1]!.after as { conCostos: boolean }).conCostos === false && (auds[0]!.after as { filas: number }).filas === N)
  check('>>> la fecha de cada fila va en la hora del negocio (Lima), no en UTC', filasO[2]!.startsWith('2026-10-01 10:00:00'), filasO[2]!.slice(0, 25))

  const csvM = await exportarKardexCsv(db(O), O, kardexCsvSchema.parse({ productId: P.id, desde: mitad, hasta: HASTA }))
  const filaIni = csvM.contenido.split('\r\n')[1]!.split(';')
  check('>>> un CSV que empieza a mitad de la historia arranca con el saldo inicial REAL (no con 0) y su costo promedio', cerca(Number(filaIni[10]), kM.saldoInicial.cantidad) && Number(filaIni[10]) > 0 && Number(filaIni[14]) === 6 && csvM.filas === N - 4)

  console.log('\nN) Un libro roto, el stock en cero, presentaciones y documentos que ya no existen')
  const R = await prisma.product.create({ data: { tenantId: t.id, sku: 'KX3', name: 'Alambre', unitType: 'UNIDAD', salePrice: 5, costPrice: 0 } })
  const pres = await prisma.productPresentation.create({ data: { tenantId: t.id, productId: R.id, name: 'Caja x12', unitType: 'UNIDAD', factor: 12 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: R.id, warehouseId: W1, quantity: 10 } })
  const mr = (i: number, q: number, saldo: number, extra: Record<string, unknown> = {}) => prisma.stockMovement.create({ data: { tenantId: t.id, productId: R.id, warehouseId: W1, userId: O.userId, type: q >= 0 ? 'ENTRADA' : 'SALIDA', quantity: q, balanceAfter: saldo, createdAt: new Date(Date.UTC(2026, 9, 3, 15, 0, 0) + i * 60_000), ...extra } as never })
  await mr(0, 5, 5)
  await mr(1, 3, 8)
  const rota = await mr(2, 4, 8)         // el saldo registrado dice 8 pero la cuenta da 12: el libro está roto
  const kR = await kardexDeProducto(db(O), O, kardexSchema.parse({ productId: R.id, desde: DESDE, hasta: HASTA }))
  check('>>> si el saldo registrado no coincide con la suma de los movimientos: el libro se declara inconsistente con su alerta y la línea con descuadre', !kR.totales.consistente && kR.alertas.some((a) => a.codigo === 'LIBRO_INCONSISTENTE') && kR.lineas[2]!.descuadre && !kR.lineas[0]!.descuadre && kR.totales.saldoFinal === 8 && kR.totales.saldoPorMovimientos === 12)
  check('>>> y como el stock actual (10) no es el saldo final (8), también avisa que no cuadra', kR.totales.cuadraConStock === false && kR.alertas.some((a) => a.codigo === 'NO_CUADRA') && kR.totales.stockActual === 10)
  await prisma.stockMovement.delete({ where: { id: rota.id } })
  await mr(3, -8, 0)                      // el stock queda EXACTAMENTE en cero
  await mr(4, 2, 2, { type: 'ENTRADA', presentationId: pres.id, enteredQuantity: 2, presentationFactor: 1 })
  await mr(5, -1, 1, { type: 'TRANSFERENCIA_SALIDA', reason: 'Transferencia T999-1 a sucursal' })
  await mr(6, -1, 0, { type: 'TRANSFERENCIA_SALIDA', reason: 'Transferencia T999-2 a sucursal', referenceType: 'VENTA', referenceId: 'venta-que-no-existe' })
  await prisma.stock.updateMany({ where: { tenantId: t.id, productId: R.id }, data: { quantity: 0 } })
  const kR2 = await kardexDeProducto(db(O), O, kardexSchema.parse({ productId: R.id, desde: DESDE, hasta: HASTA }))
  const cero = kR2.lineas.find((l) => l.saldoAlmacen === 0 && l.salida === 8)!
  check('>>> un saldo exactamente en cero NO es stock negativo (sin marca y sin alerta)', !!cero && !cero.stockNegativo && kR2.lineas.every((l) => !l.stockNegativo) && !kR2.alertas.some((a) => a.codigo === 'STOCK_NEGATIVO'))
  check('>>> el libro corregido es consistente y cuadra con el stock', kR2.totales.consistente && kR2.totales.cuadraConStock === true && kR2.lineas.every((l) => !l.descuadre))
  const lp = kR2.lineas.find((l) => l.presentacion)!
  check('>>> una línea con presentación muestra su nombre, cantidad y factor', lp.presentacion?.nombre === 'Caja x12' && lp.presentacion.cantidad === 2 && lp.presentacion.factor === 1 && kR2.lineas.filter((l) => l.presentacion).length === 1)
  const tr9 = kR2.lineas.filter((l) => l.documento.tipo === 'TRANSFERENCIA')
  check('>>> una transferencia cuyo número no existe se muestra sin número (nada inventado)', tr9.length === 1 && tr9.every((l) => l.documento.numero === null && l.documento.href === null))
  check('>>> y una venta enlazada que ya no existe, sin número ni enlace', kR2.lineas.find((l) => l.documento.tipo === 'VENTA')?.documento.numero === null)

  // SIN_TOPE=1 omite esta sección (50.000 filas, es la lenta): sólo para las mutaciones que no la tocan.
  if (!process.env.SIN_TOPE) {
  console.log('\nM) El tope de 50.000 filas')
  const ta = await prisma.tenant.create({ data: { slug: `rp-kdx3-${randomUUID().slice(0, 6)}`, name: 'Tope', taxId: ruc(), planId: plan.id } })
  const bt = await crearSucursalConAlmacen(ta.id)
  const ut = await prisma.user.create({ data: { tenantId: ta.id, email: `o-${randomUUID()}@x.com`.toLowerCase(), name: 'O', role: 'OWNER' } })
  await asignarSucursal(ta.id, ut.id, bt.branch.id)
  const OT: TenantContext = { tenantId: ta.id, userId: ut.id, role: 'OWNER', access: 'FULL', branchId: bt.branch.id, branchIds: [bt.branch.id], permisosExtra: [] }
  const pt = await prisma.product.create({ data: { tenantId: ta.id, sku: 'MUCHOS', name: 'Muchos', unitType: 'UNIDAD', salePrice: 1, costPrice: 0 } })
  await prisma.stock.create({ data: { tenantId: ta.id, productId: pt.id, warehouseId: bt.warehouse.id, quantity: 50_001 } })
  const lote = (desde: number, hasta: number) => prisma.stockMovement.createMany({ data: Array.from({ length: hasta - desde }, (_, i) => ({ tenantId: ta.id, productId: pt.id, warehouseId: bt.warehouse.id, userId: ut.id, type: 'ENTRADA' as const, quantity: 1, balanceAfter: desde + i + 1, createdAt: new Date(Date.UTC(2026, 9, 5, 15, 0, 0) + (desde + i) * 1000) })) })
  await lote(0, 50_000)
  const exacto = await exportarKardexCsv(db(OT), OT, kardexCsvSchema.parse({ productId: pt.id, desde: '2026-10-05', hasta: '2026-10-05' })).then((r) => r, (e) => e as Error)
  check('>>> 50.000 movimientos EXACTOS se exportan completos', !(exacto instanceof Error) && exacto.filas === 50_000 && exacto.contenido.split('\r\n').filter(Boolean).length === 50_000 + 3, exacto instanceof Error ? exacto.message : '')
  await lote(50_000, 50_001)
  const antesAud = await prisma.auditLog.count({ where: { tenantId: ta.id, action: 'reporte.exportado' } })
  const sobrante = await exportarKardexCsv(db(OT), OT, kardexCsvSchema.parse({ productId: pt.id, desde: '2026-10-05', hasta: '2026-10-05' })).then(() => null, (e) => e as { code: string; message: string })
  check('>>> 50.001 se rechaza con un mensaje que explica el tope y cómo acortar (no se corta en silencio)', sobrante?.code === 'INVALID_DOCUMENT' && /50000|50\.000/.test(sobrante.message) && /Acórtalo/.test(sobrante.message), sobrante?.message)
  check('>>> y un rechazo no deja auditoría de descarga', (await prisma.auditLog.count({ where: { tenantId: ta.id, action: 'reporte.exportado' } })) === antesAud)
  const lectura = await kardexDeProducto(db(OT), OT, kardexSchema.parse({ productId: pt.id, desde: '2026-10-05', hasta: '2026-10-05', limite: 50 }))
  check('>>> la pantalla sigue leyendo ese mismo rango por páginas (el tope es sólo de la exportación)', lectura.lineas.length === 50 && lectura.siguiente !== null && lectura.totales.movimientos === 50_001)

  }

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
