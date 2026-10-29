import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen, abrirTurno } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { anularPasada, crearConteo, iniciarConteo, registrarPasada, cerrarConteo, cancelarConteo, lineasDelConteo } from '../src/features/inventory/conteo-service'
import { aplicarConteo, aprobarLinea, aprobarLineasSinAlerta, estadoDeRevision, rechazarLinea, revisionDelConteo, solicitarRecuento, type LineaRevision } from '../src/features/inventory/conteo-revision'
import { anularPasadaSchema, aplicarConteoSchema, aprobarLineaSchema, aprobarSinAlertaSchema, cancelarConteoSchema, cerrarConteoSchema, crearConteoSchema, iniciarConteoSchema, recontarLineaSchema, registrarPasadaSchema, rechazarLineaSchema, revisionSchema } from '../src/features/inventory/conteo-schemas'
import { createStockMovement } from '../src/features/inventory/stock-service'
import { createStockMovementSchema } from '../src/features/inventory/schemas'
import { kardexDeProducto } from '../src/features/inventory/kardex-service'
import { kardexSchema } from '../src/features/inventory/kardex-schemas'
import { etiquetaMovimiento } from '../src/features/inventory/kardex-enlaces'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'
import { PERMISOS } from '../src/lib/permisos'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.5b · Revisión y aplicación de la toma de inventario contra la base: la diferencia contra el KARDEX a la hora de contar (las ventas posteriores no la distorsionan),
 * los umbrales y sus alertas, recontar, aprobar y rechazar, y aplicar de forma RELATIVA con `AJUSTE` de origen CONTEO (al costo vigente, sin tocar `Product.costPrice`),
 * por tandas, con sus permisos, el PIN, la separación de quien contó, el secreto de costos y el kardex.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const err = (p: Promise<unknown>) => p.then(() => null).catch((e) => e as { code?: string; message: string })
const num = (d: { toString(): string } | null | undefined) => (d === null || d === undefined ? null : Number(d.toString()))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 500) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-cnr-${randomUUID().slice(0, 6)}`, name: 'Conteo revisión', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cnr' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const W = b1.warehouse.id
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ADMIN', 'ALMACENERO', 'CAJERO'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, x.id, b1.branch.id)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  }
  const O = u.OWNER!, AD = u.ADMIN!, AL = u.ALMACENERO!, CA = u.CAJERO!
  await abrirTurno(t.id, O.userId, b1.branch.id)
  const x2 = await prisma.user.create({ data: { tenantId: t.id, email: `AL2-${randomUUID()}@x.com`.toLowerCase(), name: 'ALMACENERO2', role: 'ALMACENERO' } })
  await asignarSucursal(t.id, x2.id, b1.branch.id)
  const AL2: TenantContext = { ...AL, userId: x2.id }
  const REV: TenantContext = { ...AL, userId: x2.id, permisosExtra: ['stock.ajustar'] }          // revisor SIN productos.ver_costo
  const GEST: TenantContext = { ...AL, permisosExtra: ['conteo.gestionar'] }                     // gestiona el conteo pero no aprueba
  const PIN: TenantContext = { ...AD, operadorDe: AD.userId, permisosDenegados: permisosDenegadosAlOperador(new Set(PERMISOS)) }
  const db = (c: TenantContext) => getTenantPrisma(c)

  const productos: Record<string, { id: string; name: string }> = {}
  const producto = async (sku: string, stock: number, costo: number) => {
    const p = await prisma.product.create({ data: { tenantId: t.id, sku, name: `Producto ${sku}`, unitType: 'UNIDAD', salePrice: 20, costPrice: costo } })
    if (stock > 0) await createStockMovement(db(O), O, createStockMovementSchema.parse({ productId: p.id, warehouseId: W, type: 'ENTRADA', quantity: stock, unitCost: costo, source: 'MANUAL' }))
    else await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: W, quantity: 0 } })
    productos[sku] = { id: p.id, name: p.name }
    return p
  }
  const vender = (sku: string, q: number) => registerSale(db(O), O, registerSaleSchema.parse({ warehouseId: W, items: [{ productId: productos[sku]!.id, quantity: q, discount: 0 }], payments: [{ method: 'EFECTIVO', amount: 20 * q }], documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() }) as never)
  const crear = (c: TenantContext, o: Record<string, unknown> = {}) => crearConteo(db(c), c, crearConteoSchema.parse({ warehouseId: W, scope: 'TOTAL', idempotencyKey: randomUUID(), ...o }))
  const iniciar = (c: TenantContext, id: string) => iniciarConteo(db(c), c, iniciarConteoSchema.parse({ countId: id }))
  const cerrar = (c: TenantContext, id: string) => cerrarConteo(db(c), c, cerrarConteoSchema.parse({ countId: id }))
  const cancelar = (c: TenantContext, id: string) => cancelarConteo(db(c), c, cancelarConteoSchema.parse({ countId: id, reason: 'Prueba de revisión' }))
  const contar = (c: TenantContext, countId: string, sku: string, quantity: number) => registrarPasada(db(c), c, registrarPasadaSchema.parse({ countId, productId: productos[sku]!.id, quantity, idempotencyKey: randomUUID() }))
  const revision = (c: TenantContext, countId: string, o: Record<string, unknown> = {}) => revisionDelConteo(db(c), c, revisionSchema.parse({ countId, limite: 200, ...o }))
  const lin = async (c: TenantContext, countId: string, sku: string): Promise<LineaRevision> => (await revision(c, countId)).lineas.find((l) => l.sku === sku)!
  const itemId = async (countId: string, sku: string) => (await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId, productId: productos[sku]!.id } })).id
  const aprobar = async (c: TenantContext, countId: string, sku: string, o: Record<string, unknown> = {}) => aprobarLinea(db(c), c, aprobarLineaSchema.parse({ countId, itemId: await itemId(countId, sku), ...o }))
  const rechazar = async (c: TenantContext, countId: string, sku: string, reason = 'No se pudo comprobar') => rechazarLinea(db(c), c, rechazarLineaSchema.parse({ countId, itemId: await itemId(countId, sku), reason }))
  const recontar = async (c: TenantContext, countId: string, sku: string, reason = 'Parece poco') => solicitarRecuento(db(c), c, recontarLineaSchema.parse({ countId, itemId: await itemId(countId, sku), reason }))
  const aplicar = (c: TenantContext, countId: string, lote?: number, note?: string) => aplicarConteo(db(c), c, aplicarConteoSchema.parse({ countId, note }), lote ? { lote } : {})
  const anularPasadaX = (c: TenantContext, entryId: string) => anularPasada(db(c), c, anularPasadaSchema.parse({ entryId, reason: 'Conté de más' }))
  const stockDe = async (sku: string) => num((await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId: productos[sku]!.id, warehouseId: W } })).quantity)!
  const costoDe = async (sku: string) => num((await prisma.product.findUniqueOrThrow({ where: { id: productos[sku]!.id } })).costPrice)!
  const movsConteo = (countId: string) => prisma.stockMovement.findMany({ where: { tenantId: t.id, referenceType: 'CONTEO', referenceId: countId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

  // ─── Los productos: A…I con sus costos ───────────────────────────────────────────────────────────────────────────
  await producto('A', 20, 10); await producto('B', 10, 10); await producto('C', 100, 5); await producto('D', 4, 100); await producto('E', 1000, 5)
  await producto('F', 10, 0); await producto('G', 0, 7); await producto('H', 50, 2); await producto('I', 5, 3)
  const costosAntes = { A: await costoDe('A'), B: await costoDe('B'), C: await costoDe('C'), D: await costoDe('D'), E: await costoDe('E'), F: await costoDe('F'), G: await costoDe('G'), H: await costoDe('H'), I: await costoDe('I') }

  const c1 = await crear(O)
  await iniciar(O, c1.id)
  await dormir(8)
  await vender('A', 3)                                         // A baja a 17 ANTES de contar: el sistema, a la hora de contar, dice 17
  await dormir(8)
  for (const [sku, q] of [['A', 17], ['B', 8], ['C', 101], ['D', 5], ['E', 1050], ['F', 12], ['G', 3], ['I', 0]] as const) { await contar(AL, c1.id, sku, q); await dormir(4) }
  await dormir(8)
  await vender('B', 2)                                         // B baja a 8 DESPUÉS de contar
  await vender('I', 5)                                         // I baja a 0 DESPUÉS de contar
  await dormir(8)
  await cerrar(O, c1.id)

  console.log('\nA) Quién ve la revisión')
  check('>>> quien solo cuenta (almacenero) y el cajero NO ven las diferencias', (await code(revision(AL, c1.id))) === 'FORBIDDEN_ROLE' && (await code(revision(CA, c1.id))) === 'FORBIDDEN_ROLE' && (await code(estadoDeRevision(db(AL), AL, c1.id))) === 'FORBIDDEN_ROLE')
  check('>>> sí la ven quien gestiona el conteo, quien aprueba (stock.ajustar), el administrador y el dueño', (await revision(GEST, c1.id)).lineas.length === 9 && (await revision(REV, c1.id)).lineas.length === 9 && (await revision(AD, c1.id)).lineas.length === 9 && (await revision(O, c1.id)).lineas.length === 9)
  check('>>> un conteo de otro negocio no existe (NOT_FOUND)', await (async () => { const o2 = await prisma.tenant.create({ data: { slug: `rp-cnr2-${randomUUID().slice(0, 6)}`, name: 'Otro', taxId: ruc(), planId: plan.id } }); const uo = await prisma.user.create({ data: { tenantId: o2.id, email: `o-${randomUUID()}@x.com`.toLowerCase(), name: 'O', role: 'OWNER' } }); const OO: TenantContext = { tenantId: o2.id, userId: uo.id, role: 'OWNER', access: 'FULL', permisosExtra: [] }; return (await code(revision(OO, c1.id))) === 'NOT_FOUND' })())

  console.log('\nB) La diferencia sale del KARDEX a la hora de contar')
  const rv = await revision(AD, c1.id)
  const L = (sku: string) => rv.lineas.find((l) => l.sku === sku)!
  check('>>> A: se vendieron 3 ANTES de contar y se contaron 17: el sistema decía 17 al contar → diferencia 0 (no −3, que daría la foto del inicio)', L('A').sistemaAlContar === 17 && L('A').contado === 17 && L('A').diferencia === 0 && L('A').alertas.length === 0)
  check('>>> B: contó 8 con el sistema en 10 → −2 (20 %), y después hubo una venta: avisa de 1 movimiento posterior y que el stock de hoy es 8', L('B').sistemaAlContar === 10 && L('B').diferencia === -2 && L('B').porcentaje === 0.2 && L('B').movimientosDesdeContar === 1 && L('B').stockActual === 8 && L('B').alertas.includes('MOVIDO_DESPUES'))
  check('>>> C (+1 sobre 100): una diferencia chica no alerta', L('C').diferencia === 1 && L('C').alertas.length === 0 && L('C').causasUmbral.length === 0)
  check('>>> D (+1 sobre 4 = 25 %): alerta por PORCENTAJE', L('D').alertas.includes('SOBRE_UMBRAL') && L('D').causasUmbral.join() === 'PORCENTAJE')
  check('>>> E (+50 sobre 1000 = 5 %, pero a S/ 5 son S/ 250): alerta por VALOR, no por porcentaje (quien ve costos lo sabe)', L('E').alertas.includes('SOBRE_UMBRAL') && L('E').causasUmbral.join() === 'VALOR' && L('E').costos?.valorDiferencia === 250)
  check('>>> F (sin costo): 20 % alerta por porcentaje y se marca «sin costo»', L('F').alertas.includes('SOBRE_UMBRAL') && L('F').alertas.includes('SIN_COSTO') && L('F').costos?.costoPromedio === null && L('F').costos?.valorDiferencia === null)
  check('>>> G (el sistema esperaba 0 y se contó 3): porcentaje indefinido (null) y cuenta como grande', L('G').sistemaAlContar === 0 && L('G').diferencia === 3 && L('G').porcentaje === null && L('G').alertas.includes('SOBRE_UMBRAL'))
  check('>>> H (nadie la contó): sin cantidad ni diferencia, PENDIENTE', L('H').estado === 'PENDIENTE' && L('H').contado === null && L('H').diferencia === null && L('H').sistemaAlContar === null)
  check('>>> I (contó 0, se vendió todo después): dejaría el stock en negativo (0 + (−5)) y lo avisa', L('I').diferencia === -5 && L('I').stockActual === 0 && L('I').alertas.includes('DEJARIA_NEGATIVO') && L('I').alertas.includes('MOVIDO_DESPUES'))
  const rvR = await revision(REV, c1.id)
  const LR = (sku: string) => rvR.lineas.find((l) => l.sku === sku)!
  const textoR = JSON.stringify(rvR)
  check('>>> el revisor SIN productos.ver_costo recibe las diferencias en unidades pero NINGUNA clave de costo (ni valor ni «sin costo»)', !rvR.conCostos && rvR.lineas.every((l) => !('costos' in l)) && !textoR.includes('"costos"') && !textoR.includes('valorDiferencia') && !textoR.includes('costoPromedio') && LR('F').alertas.every((a) => a !== 'SIN_COSTO'))
  check('>>> pero la regla del valor sigue rigiendo: E sale como alerta con causa genérica «GRANDE» (sin decir cuánto vale)', LR('E').alertas.includes('SOBRE_UMBRAL') && LR('E').causasUmbral.join() === 'GRANDE' && LR('D').causasUmbral.join() === 'PORCENTAJE')
  const est0 = await estadoDeRevision(db(AD), AD, c1.id)
  check('>>> el estado de la revisión cuenta: 9 líneas, 1 sin contar, 8 contadas, ninguna aprobada', est0.lineas === 9 && est0.sinContar === 1 && est0.contadas === 8 && est0.aprobadas === 0 && est0.porAplicar === 0)
  const pag1 = await revision(AD, c1.id, { limite: 4 }), pag2 = await revision(AD, c1.id, { limite: 4, cursor: pag1.siguiente! }), pag3 = await revision(AD, c1.id, { limite: 4, cursor: pag2.siguiente! })
  check('>>> paginado de 4 en 4: 9 líneas sin repetir ni saltar', pag1.lineas.length === 4 && pag2.lineas.length === 4 && pag3.lineas.length === 1 && pag3.siguiente === null && new Set([...pag1.lineas, ...pag2.lineas, ...pag3.lineas].map((l) => l.id)).size === 9)
  check('>>> se filtra por estado', (await revision(AD, c1.id, { estado: 'PENDIENTE' })).lineas.map((l) => l.sku).join() === 'H')

  console.log('\nC) Permisos y PIN de operador para decidir')
  const idB = await itemId(c1.id, 'B')
  const decisiones = (c: TenantContext) => Promise.all([
    code(aprobarLinea(db(c), c, aprobarLineaSchema.parse({ countId: c1.id, itemId: idB, confirmaUmbral: true }))),
    code(rechazarLinea(db(c), c, rechazarLineaSchema.parse({ countId: c1.id, itemId: idB, reason: 'No cuadra' }))),
    code(solicitarRecuento(db(c), c, recontarLineaSchema.parse({ countId: c1.id, itemId: idB, reason: 'Parece poco' }))),
    code(aprobarLineasSinAlerta(db(c), c, aprobarSinAlertaSchema.parse({ countId: c1.id }))),
    code(aplicarConteo(db(c), c, aplicarConteoSchema.parse({ countId: c1.id }))),
  ])
  check('>>> quien solo cuenta, quien solo gestiona y el cajero no pueden aprobar, rechazar, recontar ni aplicar (falta stock.ajustar)', (await Promise.all([AL, GEST, CA].map(decisiones))).flat().every((x) => x === 'FORBIDDEN_ROLE'))
  check('>>> con el PIN de operador no se decide nada aunque sea el administrador', (await decisiones(PIN)).every((x) => x === 'FORBIDDEN_ROLE'))
  check('>>> y nada de lo anterior cambió el conteo', (await estadoDeRevision(db(AD), AD, c1.id)).aprobadas === 0 && (await movsConteo(c1.id)).length === 0)

  console.log('\nD) Aprobar: el umbral exige confirmación expresa')
  const sobre = await err(aprobar(AD, c1.id, 'B'))
  check('>>> aprobar una diferencia grande sin confirmar se rechaza con COUNT_OVER_THRESHOLD y recomienda recontar', sobre?.code === 'COUNT_OVER_THRESHOLD' && /recont/i.test(sobre.message), sobre?.message)
  check('>>> el mensaje no revela cifras de valor ni de costo del producto (solo los umbrales generales: 10 % y S/ 200)', !/\d/.test((sobre?.message ?? '').replace('10 %', '').replace('S/ 200', '')))
  check('>>> sigue CONTADO: el rechazo del umbral no cambió nada', (await prisma.inventoryCountItem.findUniqueOrThrow({ where: { id: idB } })).status === 'CONTADO')
  const masiva = await aprobarLineasSinAlerta(db(AD), AD, aprobarSinAlertaSchema.parse({ countId: c1.id }))
  check('>>> «aprobar sin alertas» aprueba solo las limpias (A y C) y deja las 6 con alerta para revisar a mano (B, D, E, F, G, I)', masiva.aprobadas === 2 && masiva.conAlerta === 6 && masiva.siguiente === null)
  const iA = await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: c1.id, productId: productos.A!.id } })
  check('>>> lo aprobado guarda quién y cuándo, el sistema al contar y la diferencia (A: 17 → 0; C: 100 → +1)', iA.status === 'APROBADO' && iA.reviewedById === AD.userId && iA.reviewedAt !== null && num(iA.systemQtyAtCount) === 17 && num(iA.difference) === 0 && num((await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: c1.id, productId: productos.C!.id } })).difference) === 1)
  await dormir(8); await vender('A', 1); await dormir(8)                  // A baja a 16 DESPUÉS de aprobarse
  const lAprob = await lin(AD, c1.id, 'A')
  check('>>> una línea APROBADA muestra lo que se evaluó al aprobarla (0 movimientos posteriores), no una medición nueva: lo de después es otra historia', lAprob.estado === 'APROBADO' && lAprob.movimientosDesdeContar === 0 && lAprob.diferencia === 0 && lAprob.sistemaAlContar === 17)
  const rcA = await recontar(AD, c1.id, 'A', 'Se vendió una después de aprobar: contar otra vez')
  const rowA = await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: c1.id, productId: productos.A!.id } })
  check('>>> mandar a recontar una línea ya APROBADA limpia TODA su revisión (quién aprobó, confirmación, diferencia, sistema, movimientos y costo)', rcA.estado === 'RECONTAR' && rowA.status === 'RECONTAR' && rowA.reviewedAt === null && rowA.reviewedById === null && rowA.thresholdConfirmed === false && rowA.difference === null && rowA.systemQtyAtCount === null && rowA.movedSinceCount === null && rowA.costAtApply === null && rowA.countedQty === null)
  await dormir(8); await contar(AL, c1.id, 'A', 16)
  const lA2 = await lin(AD, c1.id, 'A')
  check('>>> y el recuento (16) se mide contra el kardex a la hora del nuevo conteo (16) → diferencia 0; se vuelve a aprobar', lA2.sistemaAlContar === 16 && lA2.diferencia === 0 && (await aprobar(AD, c1.id, 'A')).diferencia === 0)
  const apB = await aprobar(AD, c1.id, 'B', { confirmaUmbral: true, note: 'Se vendió en el mostrador' })
  const rowB = await prisma.inventoryCountItem.findUniqueOrThrow({ where: { id: idB } })
  check('>>> con la confirmación expresa se aprueba y queda constancia de que se confirmó (B: −2)', apB.estado === 'APROBADO' && apB.sobreUmbral && apB.diferencia === -2 && rowB.thresholdConfirmed && rowB.reviewNote === 'Se vendió en el mostrador' && num(rowB.movedSinceCount) === 1)
  check('>>> una línea sin pasadas (H) o ya aprobada no se aprueba', (await code(aprobar(AD, c1.id, 'H'))) === 'INVALID_DOCUMENT' && (await code(aprobar(AD, c1.id, 'B', { confirmaUmbral: true }))) === 'INVALID_DOCUMENT')
  check('>>> una línea que no es de este conteo es NOT_FOUND', (await code(aprobarLinea(db(AD), AD, aprobarLineaSchema.parse({ countId: c1.id, itemId: 'no-existe' })))) === 'NOT_FOUND')

  console.log('\nE) Recontar')
  const reco = await recontar(AD, c1.id, 'D', 'Cuatro es muy poco: vuelvan a contar')
  const pasD = await prisma.inventoryCountEntry.findMany({ where: { itemId: await itemId(c1.id, 'D') } })
  const rowD = await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: c1.id, productId: productos.D!.id } })
  check('>>> mandar a recontar anula las pasadas vigentes (con el motivo) y deja la línea en RECONTAR sin cantidad ni diferencia', reco.estado === 'RECONTAR' && reco.pasadasAnuladas === 1 && pasD.every((p) => p.voidedAt !== null && /^Recuento: /.test(p.voidReason ?? '')) && rowD.status === 'RECONTAR' && rowD.countedQty === null && rowD.difference === null && rowD.reviewNote === 'Cuatro es muy poco: vuelvan a contar')
  check('>>> mientras haya líneas por recontar no se puede aplicar', (await err(aplicar(AD, c1.id)))?.message.includes('por recontar') === true)
  const ee = await err(contar(AL, c1.id, 'B', 8))
  check('>>> con el conteo en revisión NO se cuenta lo que no se mandó a recontar (se explica)', ee?.code === 'INVALID_DOCUMENT' && /solo se cuenta de nuevo lo que se mandó a recontar/.test(ee.message), ee?.message)
  check('>>> el almacenero ve qué líneas debe recontar (y NO ve la cantidad del sistema)', await (async () => { const r = await lineasDelConteo(db(AL), AL, c1.id, { estado: 'RECONTAR' }); return r.lineas.length === 1 && r.lineas[0]!.sku === 'D' && !('sistemaAlEmpezar' in r.lineas[0]!) })())
  const nuevaD = await contar(AL2, c1.id, 'D', 4)
  check('>>> en la línea mandada a recontar SÍ entra la nueva pasada: vuelve a CONTADO con la cantidad nueva', nuevaD.contado === 4 && (await prisma.inventoryCountItem.findUniqueOrThrow({ where: { id: rowD.id } })).status === 'CONTADO')
  const lD = await lin(AD, c1.id, 'D')
  check('>>> y la diferencia se mide contra el kardex a la hora del NUEVO conteo: 4 contra 4 → 0, sin alerta (la hora de la última pasada vigente)', lD.contado === 4 && lD.sistemaAlContar === 4 && lD.diferencia === 0 && !lD.alertas.includes('SOBRE_UMBRAL'))
  check('>>> aprobada sin pedir confirmación porque ya no es grande', (await aprobar(AD, c1.id, 'D')).diferencia === 0)
  check('>>> no se manda a recontar dos veces la misma línea, ni una línea inexistente', (await recontar(AD, c1.id, 'H', 'Nadie la contó')).estado === 'RECONTAR' && (await code(recontar(AD, c1.id, 'H', 'otra vez'))) === 'INVALID_DOCUMENT')
  check('>>> (H, que nadie contó, también se puede mandar a contar durante la revisión)', (await contar(AL, c1.id, 'H', 50)).contado === 50)
  check('>>> y H cuenta 50 con el sistema en 50: diferencia 0, se aprueba', (await lin(AD, c1.id, 'H')).diferencia === 0 && (await aprobar(AD, c1.id, 'H')).diferencia === 0)

  console.log('\nF) Rechazar y aplicar: reglas previas')
  const sinDecidir = await err(aplicar(AD, c1.id))
  check('>>> aplicar exige haber decidido TODO lo contado: avisa cuántas líneas faltan (E, F, G, I)', sinDecidir?.code === 'INVALID_DOCUMENT' && /4 línea\(s\) contadas sin aprobar ni rechazar/.test(sinDecidir.message), sinDecidir?.message)
  await aprobar(AD, c1.id, 'E', { confirmaUmbral: true }); await aprobar(AD, c1.id, 'F', { confirmaUmbral: true }); await aprobar(AD, c1.id, 'G', { confirmaUmbral: true })
  const apI = await aprobar(AD, c1.id, 'I', { confirmaUmbral: true })
  check('>>> I (el 100 %) se aprueba con confirmación aunque dejaría el stock en negativo (eso lo para aplicar, no aprobar)', apI.diferencia === -5)
  const neg = await err(aplicar(AD, c1.id))
  check('>>> aplicar con una línea que dejaría el stock en negativo se rechaza NOMBRANDO el producto y recomendando recontar', neg?.code === 'INVALID_DOCUMENT' && /Producto I/.test(neg.message) && /negativo/.test(neg.message) && /recontar/.test(neg.message), neg?.message)
  check('>>> y la tanda se deshace ENTERA: ningún stock cambió ni se creó ningún movimiento (todo o nada)', (await movsConteo(c1.id)).length === 0 && (await stockDe('B')) === 8 && (await stockDe('C')) === 100 && (await stockDe('E')) === 1000 && (await prisma.inventoryCount.findUniqueOrThrow({ where: { id: c1.id } })).status === 'EN_REVISION')
  const rj = await rechazar(AD, c1.id, 'I', 'Se vendió todo: el conteo ya no vale')
  const rowI = await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: c1.id, productId: productos.I!.id } })
  check('>>> rechazar deja la línea RECHAZADO con su motivo, quién y cuándo, y sin diferencia (el stock queda como está)', rj.estado === 'RECHAZADO' && rowI.status === 'RECHAZADO' && rowI.reviewNote === 'Se vendió todo: el conteo ya no vale' && rowI.reviewedById === AD.userId && rowI.difference === null)
  check('>>> una línea rechazada se puede volver a aprobar o mandar a recontar (el revisor cambia de idea) pero no una ya aplicada', (await aprobar(AD, c1.id, 'I', { confirmaUmbral: true })).estado === 'APROBADO' && (await rechazar(AD, c1.id, 'I', 'Mejor rechazarla')).estado === 'RECHAZADO')

  console.log('\nG) Aplicar: ajustes relativos, al costo vigente, sin tocar Product.costPrice')
  const stockAntes = { A: await stockDe('A'), B: await stockDe('B'), C: await stockDe('C'), D: await stockDe('D'), E: await stockDe('E'), F: await stockDe('F'), G: await stockDe('G'), H: await stockDe('H'), I: await stockDe('I') }
  const ap = await aplicar(AD, c1.id, undefined, 'Cierre de octubre')
  check('>>> el conteo queda APLICADO: 5 movimientos (4 sobrantes: C, E, F, G; 1 faltante: B), 54 unidades netas (−2+1+50+2+3), sin pendientes', ap.estado === 'APLICADO' && ap.movimientos === 5 && ap.sobrantes === 4 && ap.faltantes === 1 && ap.unidadesNetas === 54 && ap.pendientes === 0, JSON.stringify(ap))
  check('>>> B (hoy 8, diferencia −2) queda en 6: la venta posterior a contar se CONSERVA (aplicación relativa, no absoluta)', (await stockDe('B')) === stockAntes.B - 2 && (await stockDe('B')) === 6)
  check('>>> los demás: C 101, E 1050, F 12, G 3; sin diferencia (A, D, H) y la rechazada (I) no se tocan', (await stockDe('C')) === 101 && (await stockDe('E')) === 1050 && (await stockDe('F')) === 12 && (await stockDe('G')) === 3 && (await stockDe('A')) === stockAntes.A && (await stockDe('D')) === stockAntes.D && (await stockDe('H')) === stockAntes.H && (await stockDe('I')) === stockAntes.I)
  const movs = await movsConteo(c1.id)
  const mB = movs.find((m) => m.productId === productos.B!.id)!, mC = movs.find((m) => m.productId === productos.C!.id)!, mF = movs.find((m) => m.productId === productos.F!.id)!
  check('>>> cada movimiento es un AJUSTE de origen CONTEO, enlazado al conteo, con la diferencia como cantidad y el saldo resultante', movs.length === 5 && movs.every((m) => m.type === 'AJUSTE' && m.source === 'CONTEO' && m.referenceType === 'CONTEO' && m.referenceId === c1.id && m.userId === AD.userId) && num(mB.quantity) === -2 && num(mB.balanceAfter) === 6 && num(mC.quantity) === 1 && num(mC.balanceAfter) === 101)
  check('>>> el motivo dice la toma, si es sobrante o faltante, de cuánto y la nota', /^Toma de inventario CF001-\d{8}: faltante de 2 · Cierre de octubre$/.test(mB.reason ?? '') && /sobrante de 1/.test(mC.reason ?? ''))
  check('>>> al costo promedio VIGENTE: B 10, C 5, E 5, G 7 (con su promedio y EXACTO)', [['B', 10], ['C', 5], ['E', 5], ['G', 7]].every(([sku, c]) => { const m = movs.find((x) => x.productId === productos[sku as string]!.id)!; return num(m.unitCostApplied) === c && num(m.costAfter) === c && m.costOrigin === 'EXACTO' }))
  check('>>> el producto SIN costo (F) se ajusta sin valor aplicado (NULL) y queda marcado en la línea', mF.unitCostApplied === null && (await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: c1.id, productId: productos.F!.id } })).costAtApply === null)
  const costosDespues = { A: await costoDe('A'), B: await costoDe('B'), C: await costoDe('C'), D: await costoDe('D'), E: await costoDe('E'), F: await costoDe('F'), G: await costoDe('G'), H: await costoDe('H'), I: await costoDe('I') }
  check('>>> REGLA DE ORO: ningún Product.costPrice cambió (ni sobrantes ni faltantes recalculan el promedio)', JSON.stringify(costosDespues) === JSON.stringify(costosAntes))
  const itB = await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: c1.id, productId: productos.B!.id } })
  check('>>> cada línea aplicada guarda su movimiento, su costo, el sistema al contar y la diferencia; la de diferencia 0 no tiene movimiento', itB.resultingMovementId === mB.id && num(itB.costAtApply) === 10 && num(itB.systemQtyAtCount) === 10 && num(itB.difference) === -2 && (await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: c1.id, productId: productos.A!.id } })).resultingMovementId === null)
  const cRow = await prisma.inventoryCount.findUniqueOrThrow({ where: { id: c1.id } })
  check('>>> el conteo guarda quién aplicó y cuándo', cRow.status === 'APLICADO' && cRow.appliedById === AD.userId && cRow.appliedAt !== null)
  check('>>> el informe de aplicación al administrador (con costos) nombra los productos ajustados sin costo; al revisor sin costos, NO', JSON.stringify(ap.sinCosto) === JSON.stringify(['Producto F']))
  const stockRowB = await prisma.stock.findFirstOrThrow({ where: { tenantId: t.id, productId: productos.B!.id, warehouseId: W } })
  check('>>> el stock del producto queda marcado como contado (lastCountedAt)', stockRowB.lastCountedAt !== null)
  const acciones = (await prisma.auditLog.findMany({ where: { tenantId: t.id, entityId: c1.id } })).map((a) => a.action)
  check('>>> la auditoría guarda cada decisión: aprobaciones, rechazo, recuento, aprobación masiva y la aplicación', ['conteo.linea_aprobada', 'conteo.linea_rechazada', 'conteo.recuento_solicitado', 'conteo.aprobacion_masiva', 'conteo.aplicar'].every((a) => acciones.includes(a)) && (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'stock.adjust', reason: { startsWith: 'Toma de inventario' } } })) === 5)
  const ak = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: t.id, action: 'conteo.aplicar', entityId: c1.id } })
  check('>>> y la de aplicar resume movimientos, sobrantes, faltantes, unidades netas y los sin costo', JSON.stringify(ak.after).includes('"movimientos":5') && JSON.stringify(ak.after).includes('"unidadesNetas":54') && JSON.stringify(ak.after).includes('"sinCosto":1'))

  console.log('\nH) Kardex: el ajuste se lee como documento del conteo')
  const kB = await kardexDeProducto(db(AD), AD, kardexSchema.parse({ productId: productos.B!.id, limite: 50 }))
  const filaB = kB.lineas.find((l) => l.documento.tipo === 'CONTEO')!
  check('>>> la fila del kardex es un documento CONTEO con el número de la toma, salida de 2 y saldo 6', !!filaB && filaB.documento.numero === cRow.number && filaB.salida === 2 && filaB.saldo === 6 && filaB.tipo === 'AJUSTE' && filaB.origen === 'CONTEO')
  check('>>> la fila del kardex enlaza a la pantalla del conteo (con permiso) y el contador, sin permiso de verlo, no tiene enlace', filaB.documento.href === `/inventario/conteos/${c1.id}`)
  check('>>> se nombra «Ajuste por conteo (faltante)» / «(sobrante)»', etiquetaMovimiento(filaB) === 'Ajuste por conteo (faltante)' && etiquetaMovimiento({ tipo: 'AJUSTE', entrada: 1, documento: { tipo: 'CONTEO' } }) === 'Ajuste por conteo (sobrante)')
  check('>>> el libro sigue cuadrando: consistente y el saldo final = Stock.quantity', kB.totales.consistente && kB.totales.cuadraConStock === true && kB.totales.saldoFinal === 6)
  const kBc = await kardexDeProducto(db(AD), AD, kardexSchema.parse({ productId: productos.B!.id }))
  check('>>> con costos, la fila trae el costo unitario 10, valor −20 y origen EXACTO', kBc.lineas.find((l) => l.documento.tipo === 'CONTEO')!.costos?.costoUnitario === 10 && kBc.lineas.find((l) => l.documento.tipo === 'CONTEO')!.costos?.valor === -20 && kBc.lineas.find((l) => l.documento.tipo === 'CONTEO')!.costos?.origen === 'EXACTO')
  const kF = await kardexDeProducto(db(AD), AD, kardexSchema.parse({ productId: productos.F!.id }))
  check('>>> el ajuste sin costo se ve sin valor (—), no con 0', kF.lineas.find((l) => l.documento.tipo === 'CONTEO')!.costos?.costoUnitario === null && kF.lineas.find((l) => l.documento.tipo === 'CONTEO')!.costos?.valor === null)
  const CT: TenantContext = { ...O, role: 'CONTADOR', userId: (await prisma.user.create({ data: { tenantId: t.id, email: `ct-${randomUUID()}@x.com`.toLowerCase(), name: 'CONTADOR', role: 'CONTADOR' } })).id, permisosExtra: [] }
  const kCt = await kardexDeProducto(db(CT), CT, kardexSchema.parse({ productId: productos.B!.id }))
  const dCt = kCt.lineas.find((l) => l.documento.tipo === 'CONTEO')!.documento
  check('>>> quien ve el kardex pero no los conteos (contador) ve el TIPO «Toma de inventario» sin número ni enlace', dCt.tipo === 'CONTEO' && dCt.numero === null && dCt.href === null)

  console.log('\nI) Un conteo aplicado es inmutable')
  check('>>> no se aplica dos veces, ni se aprueba, rechaza, recuenta, cierra, cancela ni se cuenta', [
    await code(aplicar(AD, c1.id)), await code(aprobar(AD, c1.id, 'C', { confirmaUmbral: true })), await code(rechazar(AD, c1.id, 'C')), await code(recontar(AD, c1.id, 'C')),
    await code(cerrar(O, c1.id)), await code(cancelar(O, c1.id)), await code(contar(AL, c1.id, 'C', 1)),
  ].every((x) => x === 'INVALID_DOCUMENT'))
  check('>>> un conteo aplicado deja de ser «abierto»: se puede abrir otro en el almacén', (await crear(O)).status === 'BORRADOR')
  await cancelar(O, (await prisma.inventoryCount.findFirstOrThrow({ where: { tenantId: t.id, status: 'BORRADOR' } })).id)

  console.log('\nJ) Aplicar por tandas')
  for (const sku of ['T0', 'T1', 'T2', 'T3', 'T4', 'T5']) await producto(sku, 10, 2)          // T0, la primera creada, no tendrá diferencia: va primero en el orden de aplicación
  const c2 = await crear(O); await iniciar(O, c2.id)
  await contar(AL, c2.id, 'T0', 10); await dormir(4)
  for (const sku of ['T1', 'T2', 'T3', 'T4', 'T5']) { await contar(AL, c2.id, sku, 11); await dormir(4) }
  await cerrar(O, c2.id)
  const m2 = await aprobarLineasSinAlerta(db(AD), AD, aprobarSinAlertaSchema.parse({ countId: c2.id }))
  check('>>> +1 sobre 10 es EXACTAMENTE el 10 %: no es «mayor que», así que las 5 líneas (y T0, sin diferencia) se aprueban sin alertas', m2.aprobadas === 6 && m2.conAlerta === 0 && m2.siguiente === null)
  const t1 = await aplicar(AD, c2.id, 2)
  check('>>> la primera tanda (de 2) aplica 2 movimientos y deja el conteo EN_REVISION con 3 pendientes', t1.estado === 'EN_REVISION' && t1.movimientos === 2 && t1.pendientes === 3 && (await movsConteo(c2.id)).length === 2)
  check('>>> con ajustes ya aplicados el conteo NO se puede cancelar (el stock ya cambió)', (await err(cancelar(O, c2.id)))?.message.includes('ya aplicó ajustes') === true)
  const yaAplicada = (await movsConteo(c2.id))[0]!.productId
  const skuAplicado = Object.entries(productos).find(([, v]) => v.id === yaAplicada)![0]
  check('>>> una línea ya aplicada no se puede recontar, rechazar ni aprobar de nuevo', (await code(recontar(AD, c2.id, skuAplicado))) === 'INVALID_DOCUMENT' && (await code(rechazar(AD, c2.id, skuAplicado))) === 'INVALID_DOCUMENT' && (await code(aprobar(AD, c2.id, skuAplicado))) === 'INVALID_DOCUMENT')
  const est2 = await estadoDeRevision(db(AD), AD, c2.id)
  check('>>> el estado cuenta 2 aplicadas y 3 por aplicar (la línea sin diferencia, T0, no se cuenta entre las que faltan)', est2.aplicadas === 2 && est2.porAplicar === 3 && est2.aprobadas === 6)
  const t2 = await aplicar(AD, c2.id, 2), t3 = await aplicar(AD, c2.id, 2)
  check('>>> la segunda tanda aplica 2 (quedan 1) y la tercera 1: el conteo pasa a APLICADO', t2.estado === 'EN_REVISION' && t2.movimientos === 2 && t2.pendientes === 1 && t3.estado === 'APLICADO' && t3.movimientos === 1 && t3.pendientes === 0)
  const todosMovs = await movsConteo(c2.id)
  check('>>> en total 5 movimientos, uno por producto (ninguno aplicado dos veces, ninguno para T0) y cada stock quedó en 11 (T0 sigue en 10)', todosMovs.length === 5 && new Set(todosMovs.map((m) => m.productId)).size === 5 && (await Promise.all(['T1', 'T2', 'T3', 'T4', 'T5'].map(stockDe))).every((x) => x === 11) && (await stockDe('T0')) === 10)
  check('>>> y volver a aplicar un conteo ya aplicado se rechaza', (await code(aplicar(AD, c2.id))) === 'INVALID_DOCUMENT')
  check('>>> hubo una auditoría parcial por cada tanda intermedia y la final de aplicar', (await prisma.auditLog.count({ where: { tenantId: t.id, entityId: c2.id, action: 'conteo.aplicar_parcial' } })) === 2 && (await prisma.auditLog.count({ where: { tenantId: t.id, entityId: c2.id, action: 'conteo.aplicar' } })) === 1)

  console.log('\nK) Quien contó no aplica su propio conteo (salvo el dueño)')
  for (const sku of ['U1', 'U2', 'U3']) await producto(sku, 10, 2)
  const sel = (sku: string) => ({ scope: 'SELECCION', productIds: [productos[sku]!.id] })
  const k1 = await crear(AD, sel('U1')); await iniciar(AD, k1.id)
  await contar(REV, k1.id, 'U1', 12)                                   // REV (almacenero con stock.ajustar) es el ÚNICO contador
  await cerrar(AD, k1.id)
  await aprobar(REV, k1.id, 'U1', { confirmaUmbral: true })
  const propio = await err(aplicar(REV, k1.id))
  check('>>> el único contador, aunque tenga stock.ajustar, NO aplica su conteo: FORBIDDEN_ROLE con el motivo', propio?.code === 'FORBIDDEN_ROLE' && /no aplica su propio conteo/.test(propio.message) && (await stockDe('U1')) === 10, propio?.message)
  check('>>> aprobar sí puede (la separación es al APLICAR) y lo aplica otra persona', (await aplicar(AD, k1.id)).estado === 'APLICADO' && (await stockDe('U1')) === 12)
  const k2 = await crear(AD, sel('U2')); await iniciar(AD, k2.id)
  await contar(REV, k2.id, 'U2', 12); await contar(AL, k2.id, 'U2', 0)
  await cerrar(AD, k2.id)
  await aprobar(REV, k2.id, 'U2', { confirmaUmbral: true })
  const itemDeOtro = await itemId(k1.id, 'U1')
  check('>>> una línea de OTRO conteo no se puede decidir desde este (NOT_FOUND)', (await code(aprobarLinea(db(AD), AD, aprobarLineaSchema.parse({ countId: k2.id, itemId: itemDeOtro, confirmaUmbral: true })))) === 'NOT_FOUND' && (await code(rechazarLinea(db(AD), AD, rechazarLineaSchema.parse({ countId: k2.id, itemId: itemDeOtro, reason: 'No es de este conteo' })))) === 'NOT_FOUND')
  const apREV = await aplicar(REV, k2.id)
  check('>>> si contaron DOS personas distintas, uno de los contadores sí puede aplicar (no fue el único); y al revisor sin costos NO se le manda la lista de productos sin costo', apREV.estado === 'APLICADO' && (await stockDe('U2')) === 12 && !('sinCosto' in apREV))
  const k3 = await crear(AD, sel('U3')); await iniciar(AD, k3.id)
  await contar(O, k3.id, 'U3', 12)
  await cerrar(O, k3.id)
  await aprobar(O, k3.id, 'U3', { confirmaUmbral: true })
  check('>>> el DUEÑO puede aplicar un conteo que contó él solo (el inventario es suyo)', (await aplicar(O, k3.id)).estado === 'APLICADO' && (await stockDe('U3')) === 12)

  console.log('\nM) La aprobación masiva deja para revisar a mano lo dudoso')
  await producto('M1', 1000, 0); await producto('M2', 1000, 1); await producto('M4', 100, 1); await producto('M5', 100, 1)
  const c7 = await crear(AD, { scope: 'SELECCION', productIds: ['M1', 'M2', 'M4', 'M5'].map((s) => productos[s]!.id) }); await iniciar(AD, c7.id)
  await dormir(6)
  for (const [sku, q] of [['M1', 1001], ['M2', 1001], ['M4', 101], ['M5', 100]] as const) { await contar(AL, c7.id, sku, q); await dormir(4) }
  await dormir(6); await vender('M2', 1); await dormir(6)                      // M2 se movió después de contar
  await cerrar(AD, c7.id)
  const mm = await aprobarLineasSinAlerta(db(AD), AD, aprobarSinAlertaSchema.parse({ countId: c7.id }))
  const est7 = await estadoDeRevision(db(AD), AD, c7.id)
  check('>>> sin costo (M1) y con movimientos posteriores a contar (M2) NO se aprueban solos aunque la diferencia sea chica; sí M4 (+1 limpia) y M5 (sin diferencia)', mm.aprobadas === 2 && mm.conAlerta === 2 && est7.aprobadas === 2 && est7.contadas === 2)
  const r7 = await revision(AD, c7.id)
  check('>>> y esas dos siguen CONTADAS, con su alerta a la vista (SIN_COSTO y MOVIDO_DESPUES)', r7.lineas.find((l) => l.sku === 'M1')!.estado === 'CONTADO' && r7.lineas.find((l) => l.sku === 'M1')!.alertas.includes('SIN_COSTO') && r7.lineas.find((l) => l.sku === 'M2')!.estado === 'CONTADO' && r7.lineas.find((l) => l.sku === 'M2')!.alertas.includes('MOVIDO_DESPUES'))
  await cancelar(AD, c7.id)

  console.log('\nL) Casos de borde del kardex al contar')
  await prisma.product.create({ data: { tenantId: t.id, sku: 'LEG', name: 'Producto LEG', unitType: 'UNIDAD', salePrice: 20, costPrice: 2 } }).then(async (p) => { productos.LEG = { id: p.id, name: p.name }; await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: W, quantity: 5 } }) })
  await producto('PX', 10, 2); await producto('Q0', 2, 2)
  const sel2 = (skus: string[]) => ({ scope: 'SELECCION', productIds: skus.map((s) => productos[s]!.id) })
  const c6 = await crear(AD, sel2(['LEG', 'PX', 'Q0'])); await iniciar(AD, c6.id)
  await dormir(6)
  await contar(AL, c6.id, 'LEG', 5); await dormir(6)                          // LEG: stock cargado SIN historial (legado)
  await contar(AL, c6.id, 'PX', 10); await dormir(6)
  await vender('PX', 1); await dormir(6)                                      // PX baja a 9 entre las dos pasadas
  const pxSegunda = await contar(AL2, c6.id, 'PX', 0); await dormir(6)        // pasada extra que se ANULA enseguida
  await anularPasadaX(AL2, pxSegunda.entryId)
  await vender('LEG', 1); await dormir(6)                                     // LEG baja a 4 DESPUÉS de contar
  await contar(AL, c6.id, 'Q0', 0)                                            // Q0: stock 2, se cuenta 0
  await cerrar(AD, c6.id)
  const r6 = await revision(AD, c6.id)
  const L6 = (sku: string) => r6.lineas.find((l) => l.sku === sku)!
  check('>>> stock cargado SIN historial (legado): el sistema al contar se deduce del stock de hoy menos lo movido después (4 − (−1) = 5) → diferencia 0', L6('LEG').sistemaAlContar === 5 && L6('LEG').diferencia === 0 && L6('LEG').movimientosDesdeContar === 1)
  check('>>> la hora de contar es la de la última pasada VIGENTE: una pasada posterior anulada no cuenta (PX: 10 contado con el sistema en 10 → diferencia 0, no +1)', L6('PX').contado === 10 && L6('PX').sistemaAlContar === 10 && L6('PX').diferencia === 0)
  check('>>> un conteo que dejaría el stock EXACTAMENTE en cero no es negativo (Q0: 2 → contó 0)', L6('Q0').diferencia === -2 && !L6('Q0').alertas.includes('DEJARIA_NEGATIVO') && L6('Q0').alertas.includes('SOBRE_UMBRAL'))
  await aprobar(AD, c6.id, 'LEG'); await aprobar(AD, c6.id, 'PX'); await aprobar(AD, c6.id, 'Q0', { confirmaUmbral: true })
  const ap6 = await aplicar(AD, c6.id)
  check('>>> y se aplica: Q0 queda en 0 (un solo movimiento de −2); LEG y PX no tienen diferencia', ap6.estado === 'APLICADO' && ap6.movimientos === 1 && (await stockDe('Q0')) === 0 && (await stockDe('LEG')) === 4 && (await stockDe('PX')) === 9)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
