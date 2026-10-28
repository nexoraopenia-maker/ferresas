import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { anularPasada, cancelarConteo, cerrarConteo, crearConteo, iniciarConteo, registrarPasada } from '../src/features/inventory/conteo-service'
import { aplicarConteo, aprobarLinea, rechazarLinea, solicitarRecuento } from '../src/features/inventory/conteo-revision'
import { exportarConteoCsv, getActaConteo } from '../src/features/inventory/conteo-documentos'
import { buscarProductosParaContar, buscarProductosParaSeleccion, misPasadas, resolverProductoParaContar } from '../src/features/inventory/conteo-captura'
import { detalleDeConteo, listarConteosConResponsables } from '../src/features/inventory/conteo-lista'
import { ActaConteoDoc } from '../src/features/inventory/components/ActaConteoDoc'
import { anularPasadaSchema, aplicarConteoSchema, aprobarLineaSchema, cancelarConteoSchema, cerrarConteoSchema, crearConteoSchema, iniciarConteoSchema, recontarLineaSchema, rechazarLineaSchema, registrarPasadaSchema } from '../src/features/inventory/conteo-schemas'
import { createStockMovement } from '../src/features/inventory/stock-service'
import { createStockMovementSchema } from '../src/features/inventory/schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.5c · Los documentos de la toma de inventario y lo que las pantallas leen, contra la base: el acta y el CSV (quién los ve, en qué estado, qué llevan y qué NO llevan sin permiso de
 * costos), la captura ciega (resolver un código, buscar, mis pasadas: nunca una cifra del sistema) y el listado con responsables.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
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
  const t = await prisma.tenant.create({ data: { slug: `rp-cdo-${randomUUID().slice(0, 6)}`, name: 'Conteo documentos', legalName: 'Documentos SAC', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cdo' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const W = b1.warehouse.id, W2 = b2.warehouse.id
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ADMIN', 'ALMACENERO', 'CAJERO', 'CONTADOR'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role === 'ALMACENERO' ? 'Ana' : role, role } })
    for (const b of [b1, b2]) await asignarSucursal(t.id, x.id, b.branch.id)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: [] }
  }
  const O = u.OWNER!, AD = u.ADMIN!, AL = u.ALMACENERO!, CA = u.CAJERO!, CT = u.CONTADOR!
  const x2 = await prisma.user.create({ data: { tenantId: t.id, email: `AL2-${randomUUID()}@x.com`.toLowerCase(), name: 'Beto', role: 'ALMACENERO' } })
  await asignarSucursal(t.id, x2.id, b1.branch.id)
  const AL2: TenantContext = { ...AL, userId: x2.id, branchIds: [b1.branch.id] }
  const REV: TenantContext = { ...AL, userId: x2.id, permisosExtra: ['stock.ajustar'] }
  const GEST: TenantContext = { ...AL, permisosExtra: ['conteo.gestionar'], branchIds: [b1.branch.id] }
  const db = (c: TenantContext) => getTenantPrisma(c)

  const productos: Record<string, string> = {}
  const producto = async (sku: string, stock: number, costo: number, extra: Record<string, unknown> = {}) => {
    const p = await prisma.product.create({ data: { tenantId: t.id, sku, name: `Producto ${sku}`, unitType: 'UNIDAD', salePrice: 20, costPrice: costo, ...extra } })
    if (stock > 0) await createStockMovement(db(O), O, createStockMovementSchema.parse({ productId: p.id, warehouseId: W, type: 'ENTRADA', quantity: stock, unitCost: costo, source: 'MANUAL' }))
    else await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: W, quantity: 0 } })
    productos[sku] = p.id
    return p
  }
  const crear = (c: TenantContext, o: Record<string, unknown> = {}) => crearConteo(db(c), c, crearConteoSchema.parse({ warehouseId: W, scope: 'TOTAL', idempotencyKey: randomUUID(), ...o }))
  const iniciar = (c: TenantContext, id: string) => iniciarConteo(db(c), c, iniciarConteoSchema.parse({ countId: id }))
  const cerrar = (c: TenantContext, id: string) => cerrarConteo(db(c), c, cerrarConteoSchema.parse({ countId: id }))
  const cancelar = (c: TenantContext, id: string) => cancelarConteo(db(c), c, cancelarConteoSchema.parse({ countId: id, reason: 'Prueba de documentos' }))
  const contar = (c: TenantContext, countId: string, sku: string, quantity: number) => registrarPasada(db(c), c, registrarPasadaSchema.parse({ countId, productId: productos[sku]!, quantity, idempotencyKey: randomUUID() }))
  const itemId = async (countId: string, sku: string) => (await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId, productId: productos[sku]! } })).id
  const aprobar = async (c: TenantContext, countId: string, sku: string, o: Record<string, unknown> = {}) => aprobarLinea(db(c), c, aprobarLineaSchema.parse({ countId, itemId: await itemId(countId, sku), ...o }))
  const rechazar = async (c: TenantContext, countId: string, sku: string, reason: string) => rechazarLinea(db(c), c, rechazarLineaSchema.parse({ countId, itemId: await itemId(countId, sku), reason }))
  const recontar = async (c: TenantContext, countId: string, sku: string) => solicitarRecuento(db(c), c, recontarLineaSchema.parse({ countId, itemId: await itemId(countId, sku), reason: 'Parece poco' }))

  // ─── Los productos y un conteo en revisión ───────────────────────────────────────────────────────────────────────
  await producto('A', 20, 10); await producto('B', 10, 10); await producto('C', 100, 5); await producto('E', 1000, 5); await producto('F', 10, 0); await producto('R', 10, 2); await producto('H', 50, 2); await producto('Z', 10, 3)
  await producto('SERV', 0, 0, { trackStock: false, name: 'Servicio de corte' })
  const c1 = await crear(AD)
  check('(preparación) el conteo nace BORRADOR', c1.status === 'BORRADOR')
  check('>>> sin iniciar ni el acta ni el CSV existen', (await code(getActaConteo(db(AD), AD, c1.id))) === 'INVALID_DOCUMENT' && (await code(exportarConteoCsv(db(AD), AD, c1.id))) === 'INVALID_DOCUMENT')
  await iniciar(AD, c1.id); await dormir(8)
  for (const [sku, q, quien] of [['A', 20, AL], ['B', 8, AL], ['C', 101, AL2], ['E', 1050, AL2], ['F', 12, AL], ['R', 15, AL2], ['Z', 3, AL]] as const) { await contar(quien, c1.id, sku, q); await dormir(4) }
  check('>>> en conteo el acta todavía no se emite (explica que falta cerrar), pero el CSV sí', (await getActaConteo(db(AD), AD, c1.id).then(() => null, (e) => e.message))?.includes('cerrada') === true && (await exportarConteoCsv(db(AD), AD, c1.id)).filas === 8)
  const x3 = await prisma.user.create({ data: { tenantId: t.id, email: `AL3-${randomUUID()}@x.com`.toLowerCase(), name: 'Carla', role: 'ALMACENERO' } })
  await asignarSucursal(t.id, x3.id, b1.branch.id)
  const AL3: TenantContext = { ...AL, userId: x3.id, branchIds: [b1.branch.id] }
  const pCarla = await contar(AL3, c1.id, 'H', 49)                                  // Carla contó H y lo anuló enseguida: no figura entre quienes contaron
  await anularPasada(db(AL3), AL3, anularPasadaSchema.parse({ entryId: pCarla.entryId, reason: 'Conté el estante equivocado' }))
  await dormir(8); await cerrar(AD, c1.id)
  await aprobar(AD, c1.id, 'A'); await aprobar(AD, c1.id, 'B', { confirmaUmbral: true }); await aprobar(AD, c1.id, 'C'); await aprobar(AD, c1.id, 'E', { confirmaUmbral: true }); await aprobar(AD, c1.id, 'F', { confirmaUmbral: true })
  await rechazar(AD, c1.id, 'R', '=SUMA(1+1) no se pudo comprobar')
  await recontar(AD, c1.id, 'Z')

  console.log('\nA) Quién ve el acta y el CSV')
  const quienes = async (f: (c: TenantContext) => Promise<unknown>) => ({ al: await code(f(AL)), ca: await code(f(CA)), ct: await code(f(CT)), gest: await code(f(GEST)), rev: await code(f(REV)), ad: await code(f(AD)), o: await code(f(O)) })
  const qa = await quienes((c) => getActaConteo(db(c), c, c1.id)), qc = await quienes((c) => exportarConteoCsv(db(c), c, c1.id))
  check('>>> quien solo cuenta, el cajero y el contador (que no revisa conteos) NO ven el acta: llevan lo que decía el sistema', qa.al === 'FORBIDDEN_ROLE' && qa.ca === 'FORBIDDEN_ROLE' && qa.ct === 'FORBIDDEN_ROLE')
  check('>>> sí la ven quien gestiona, quien aprueba (stock.ajustar), el administrador y el dueño', qa.gest === null && qa.rev === null && qa.ad === null && qa.o === null)
  check('>>> el CSV, igual', qc.al === 'FORBIDDEN_ROLE' && qc.ca === 'FORBIDDEN_ROLE' && qc.ct === 'FORBIDDEN_ROLE' && qc.gest === null && qc.rev === null && qc.ad === null && qc.o === null)
  const OO = await prisma.tenant.create({ data: { slug: `rp-cdo2-${randomUUID().slice(0, 6)}`, name: 'Otro', taxId: ruc(), planId: plan.id } }).then(async (o) => { const uo = await prisma.user.create({ data: { tenantId: o.id, email: `o-${randomUUID()}@x.com`.toLowerCase(), name: 'O', role: 'OWNER' } }); return { tenantId: o.id, userId: uo.id, role: 'OWNER', access: 'FULL', permisosExtra: [] } as TenantContext })
  check('>>> el conteo de OTRO negocio es NOT_FOUND para el acta y el CSV', (await code(getActaConteo(db(OO), OO, c1.id))) === 'NOT_FOUND' && (await code(exportarConteoCsv(db(OO), OO, c1.id))) === 'NOT_FOUND')

  console.log('\nB) El acta de un conteo en revisión')
  const a = await getActaConteo(db(AD), AD, c1.id)
  check('>>> encabezado: número, estado, negocio, sucursal, almacén, alcance y modo', /^CF001-\d{8}$/.test(a.numero) && a.estado === 'EN_REVISION' && a.emisor.nombre === 'Conteo documentos' && a.emisor.razonSocial === 'Documentos SAC' && a.sucursal.length > 0 && a.almacen.length > 0 && a.alcance === 'Todo el almacén' && a.modo === 'Ciego')
  check('>>> responsables: creó el administrador, contaron Ana y Beto (por nombre, sin repetir), cerró el administrador y aún no se aplicó', a.responsables.creo === 'ADMIN' && a.responsables.contadores.join() === 'Ana,Beto' && a.responsables.cerro === 'ADMIN' && a.responsables.aplico === null && a.fechas.aplicado === null && a.fechas.cerrado !== null)
  check('>>> resumen: 8 líneas; Z por recontar; H sin contar; A sin diferencia; B, C, E, F con diferencia aprobada; R rechazada', a.resumen.lineas === 8 && a.resumen.porRecontar === 1 && a.resumen.sinContar === 1 && a.resumen.sinDiferencia === 1 && a.resumen.aprobadas === 5 && a.resumen.rechazadas === 1)
  check('>>> las unidades aprobadas: sobrantes C +1, E +50, F +2 = 53; faltantes B −2 = 2; netas +51 (R, rechazada, no suma)', a.resumen.sobrantes === 53 && a.resumen.faltantes === 2 && a.resumen.netas === 51)
  check('>>> valores (el administrador ve costos): sobrantes 5 + 250 + 0 (F sin costo) = S/ 255; faltantes S/ 20; 1 producto sin costo', a.conCostos && a.resumen.valorSobrantes === 255 && a.resumen.valorFaltantes === 20 && a.resumen.sinCosto === 1)
  const skus = a.lineas.map((l) => l.sku)
  check('>>> por defecto el detalle trae solo las diferencias, las rechazadas y las por recontar (B, C, E, F, R y Z; no A ni H, que no tienen diferencia ni observación)', [...skus].sort().join() === ['B', 'C', 'E', 'F', 'R', 'Z'].join(), skus.join())
  check('>>> cada línea trae contado, sistema al contar y diferencia', (() => { const b = a.lineas.find((l) => l.nombre === 'Producto B')!; return b.contado === 8 && b.sistemaAlContar === 10 && b.diferencia === -2 && b.estado === 'APROBADO' })() && a.lineas.find((l) => l.nombre === 'Producto R')!.nota === '=SUMA(1+1) no se pudo comprobar')
  const aTodo = await getActaConteo(db(AD), AD, c1.id, { detalleCompleto: true })
  check('>>> con el detalle completo salen las 8 líneas, ordenadas por nombre', aTodo.lineas.length === 8 && aTodo.detalleCompleto && !aTodo.truncado && aTodo.lineas.map((l) => l.nombre).join() === [...aTodo.lineas.map((l) => l.nombre)].sort().join())

  console.log('\nC) Sin permiso de costos, el acta no los trae')
  const aRev = await getActaConteo(db(REV), REV, c1.id)
  const jr = JSON.stringify(aRev)
  check('>>> el revisor sin ver costos: conCostos falso y NINGUNA clave de valor (ni vacía) en las líneas ni en el resumen', !aRev.conCostos && !jr.includes('valorDiferencia') && !jr.includes('valorSobrantes') && !jr.includes('valorFaltantes') && !jr.includes('sinCosto'))
  check('>>> pero conserva las unidades: mismas líneas, diferencias y totales', aRev.lineas.length === a.lineas.length && aRev.resumen.sobrantes === 53 && aRev.resumen.faltantes === 2 && aRev.resumen.netas === 51)
  const hRev = renderToStaticMarkup(createElement(ActaConteoDoc, { acta: aRev })), hAd = renderToStaticMarkup(createElement(ActaConteoDoc, { acta: a }))
  check('>>> el acta IMPRESA del revisor no tiene ni un importe ni la columna Valor; la del administrador sí', !/S\//.test(hRev) && !/>Valor</.test(hRev) && !hRev.includes('data-acta="valores"') && hAd.includes('data-acta="valores"') && hAd.includes('S/ 255.00') && hAd.includes('S/ 20.00'))
  check('>>> y el acta impresa lleva las tres firmas y los nombres de quienes contaron', hAd.includes('Almacenero') && hAd.includes('Contador') && hAd.includes('Dueño') && hAd.includes('Ana, Beto'))

  console.log('\nD) El CSV')
  const csv = await exportarConteoCsv(db(AD), AD, c1.id)
  const filas = csv.contenido.split('\r\n').filter(Boolean)
  const celdas = (f: string) => f.split(';')
  check('>>> lleva BOM, separador «;», nombre con el número y una fila por línea (8) más la cabecera', csv.contenido.startsWith('﻿') && csv.nombre === `conteo-${a.numero}.csv` && csv.filas === 8 && filas.length === 9)
  check('>>> con costos la cabecera tiene 14 columnas, con Costo promedio y Valor de la diferencia', celdas(filas[0]!).length === 14 && filas[0]!.includes('Costo promedio') && filas[0]!.includes('Valor de la diferencia') && filas.every((f) => celdas(f).length === 14))
  const filaB = filas.find((f) => f.startsWith('Producto B;'))!
  check('>>> la fila de B: contado 8, sistema 10, diferencia −2, 20 %, costo 10.00 y valor 20.00', (() => { const c = celdas(filaB); return c[4] === '8' && c[5] === '10' && c[6] === '-2' && c[7] === '20' && c[12] === '10.00' && c[13] === '20.00' })())
  check('>>> las alertas van con su nombre en español; el producto sin contar tiene celdas vacías', filaB.includes('Diferencia grande: conviene recontar') && (() => { const c = celdas(filas.find((f) => f.startsWith('Producto H;'))!); return c[4] === '' && c[5] === '' && c[6] === '' && c[3] === 'Sin contar' })())
  check('>>> una nota que empieza por «=» se neutraliza (apóstrofo): no se ejecuta como fórmula en Excel', csv.contenido.includes("'=SUMA(1+1)") && !/;=SUMA/.test(csv.contenido))
  const csvRev = await exportarConteoCsv(db(REV), REV, c1.id)
  const filasRev = csvRev.contenido.split('\r\n').filter(Boolean)
  check('>>> SIN costos: 12 columnas, sin Costo ni Valor en la cabecera ni una cifra de costo en ninguna fila', filasRev.every((f) => celdas(f).length === 12) && !/Costo|Valor/.test(filasRev[0]!) && csvRev.filas === 8 && !filasRev.slice(1).some((f) => /;10\.00;|;20\.00$/.test(f)))
  const aud = await prisma.auditLog.findMany({ where: { tenantId: t.id, action: 'reporte.exportado', entityId: c1.id } })
  check('>>> cada descarga deja su auditoría (quién, cuántas filas y si llevaba costos): 7 descargas, 4 con costos (administrador y dueño) y 3 sin (revisor y gestor)', aud.length === 7 && aud.filter((x) => (x.after as { conCostos: boolean }).conCostos).length === 4 && aud.filter((x) => !(x.after as { conCostos: boolean }).conCostos).length === 3 && aud.every((x) => (x.after as { reporte: string }).reporte === 'conteo' && (x.after as { filas: number }).filas === 8))

  console.log('\nE) El acta de un conteo APLICADO')
  await contar(AL2, c1.id, 'Z', 10); await aprobar(AD, c1.id, 'Z')       // el recuento coincide con el sistema: sin diferencia
  await aprobar(AD, c1.id, 'H').catch(() => null)
  const apl = await aplicarConteo(db(AD), AD, aplicarConteoSchema.parse({ countId: c1.id }))
  const a2 = await getActaConteo(db(AD), AD, c1.id)
  check('>>> el conteo se aplica (4 movimientos) y el acta lo refleja: APLICADO, quién aplicó y cuándo', apl.estado === 'APLICADO' && apl.movimientos === 4 && a2.estado === 'APLICADO' && a2.responsables.aplico === 'ADMIN' && a2.fechas.aplicado !== null)
  check('>>> y las cifras siguen siendo las que se aprobaron (lo aplicado no cambia el acta)', a2.resumen.sobrantes === 53 && a2.resumen.faltantes === 2 && a2.resumen.netas === 51 && a2.resumen.valorSobrantes === 255 && a2.resumen.valorFaltantes === 20)
  check('>>> el CSV de un conteo aplicado también se descarga', (await exportarConteoCsv(db(AD), AD, c1.id)).filas === 8)

  console.log('\nF) Cancelado: no hay documentos')
  const c2 = await crear(AD); await iniciar(AD, c2.id); await cancelar(AD, c2.id)
  check('>>> un conteo cancelado no tiene acta ni CSV (se explica que está cancelado)', (await getActaConteo(db(AD), AD, c2.id).then(() => null, (e) => e.message))?.includes('cancelada') === true && (await code(exportarConteoCsv(db(AD), AD, c2.id))) === 'INVALID_DOCUMENT')

  console.log('\nG) Contar es CIEGO: resolver, buscar y mis pasadas')
  await prisma.product.update({ where: { id: productos.A! }, data: { barcode: '7750009990001' } })
  const pres = await prisma.productPresentation.create({ data: { tenantId: t.id, productId: productos.B!, name: 'Caja x12', unitType: 'CAJA', factor: 12 } })
  await prisma.productCode.create({ data: { tenantId: t.id, productId: productos.B!, presentationId: pres.id, code: '7750009990002', type: 'EAN13', isPrimary: false } })
  const c3 = await crear(AD); await iniciar(AD, c3.id)
  const rA = await resolverProductoParaContar(db(AL), AL, { countId: c3.id, code: '7750009990001' })
  check('>>> un código de barras resuelve al producto (nombre, SKU, unidad)', rA?.productId === productos.A && rA!.nombre === 'Producto A' && rA!.sku === 'A' && rA!.unidad === 'UNIDAD' && rA!.presentacionLeida === null)
  check('>>> el SKU también', (await resolverProductoParaContar(db(AL), AL, { countId: c3.id, code: 'A' }))?.productId === productos.A)
  check('>>> el código de una CAJA resuelve a la presentación leída (y lista las presentaciones del producto)', await (async () => { const r = await resolverProductoParaContar(db(AL), AL, { countId: c3.id, code: '7750009990002' }); return !!r && r.productId === productos.B && r.presentacionLeida?.id === pres.id && r.presentacionLeida.factor === '12' && r.presentaciones.some((p) => p.id === pres.id) })())
  const textoRes = JSON.stringify(rA)
  check('>>> lo que recibe quien cuenta NO trae ninguna cifra del sistema (ni stock, ni cantidad, ni mínimo, ni versión, ni precio, ni costo)', !/"(quantity|stock|minStock|version|salePrice|costPrice|cantidad|existencias)"/.test(textoRes), textoRes)
  check('>>> un código que no existe es null (no un error); un servicio sin control de stock, NOT_FOUND', (await resolverProductoParaContar(db(AL), AL, { countId: c3.id, code: 'NO-EXISTE-999' })) === null && (await code(resolverProductoParaContar(db(AL), AL, { countId: c3.id, code: 'SERV' }))) === 'NOT_FOUND')
  const bq = await buscarProductosParaContar(db(AL), AL, { countId: c3.id, q: 'producto a' })
  check('>>> buscar por nombre: 2 letras mínimo, sin distinguir mayúsculas, solo productos con control de stock, sin cifras del sistema', bq.some((p) => p.productId === productos.A) && (await buscarProductosParaContar(db(AL), AL, { countId: c3.id, q: 'p' })).length === 0 && (await buscarProductosParaContar(db(AL), AL, { countId: c3.id, q: 'servicio' })).length === 0 && !/"(quantity|stock|minStock)"/.test(JSON.stringify(bq)))
  await producto('DUP1', 5, 1); await producto('DUP2', 5, 1, { barcode: 'DUP1' })
  const amb = await resolverProductoParaContar(db(AL), AL, { countId: c3.id, code: 'DUP1' }).then(() => null, (e) => e as { code: string; message: string })
  check('>>> un código que pertenece a varios productos no se adivina: DUPLICATE_CODE con aviso para corregirlo', amb?.code === 'DUPLICATE_CODE' && /varios productos/.test(amb.message), amb ? amb.message : 'no falló')
  check('>>> contar exige conteo.registrar: el cajero y el contador no resuelven ni buscan', (await code(resolverProductoParaContar(db(CA), CA, { countId: c3.id, code: 'A' }))) === 'FORBIDDEN_ROLE' && (await code(buscarProductosParaContar(db(CT), CT, { countId: c3.id, q: 'producto' }))) === 'FORBIDDEN_ROLE')
  check('>>> «mis pasadas» también exige conteo.registrar', (await code(misPasadas(db(CA), CA, { countId: c3.id }))) === 'FORBIDDEN_ROLE' && (await code(misPasadas(db(CT), CT, { countId: c3.id }))) === 'FORBIDDEN_ROLE')
  const cBor = await (async () => { await cancelar(AD, c3.id); const x = await crear(AD); return x })()
  check('>>> con la toma en borrador (o cancelada) no se resuelve nada: se explica que no recibe conteos', (await code(resolverProductoParaContar(db(AL), AL, { countId: cBor.id, code: 'A' }))) === 'INVALID_DOCUMENT' && (await code(resolverProductoParaContar(db(AL), AL, { countId: c3.id, code: 'A' }))) === 'INVALID_DOCUMENT')
  await iniciar(AD, cBor.id)
  const p1 = await contar(AL, cBor.id, 'A', 5); await dormir(5); await contar(AL2, cBor.id, 'B', 3); await dormir(5); const p3 = await contar(AL, cBor.id, 'C', 7)
  await anularPasada(db(AL), AL, anularPasadaSchema.parse({ entryId: p1.entryId, reason: 'Conté mal' }))
  const mias = await misPasadas(db(AL), AL, { countId: cBor.id })
  check('>>> «mis pasadas»: solo las propias (no las de Beto), la más reciente primero, la anulada marcada', mias.length === 2 && mias[0]!.producto === 'Producto C' && mias[1]!.producto === 'Producto A' && mias[1]!.anulada && !mias[0]!.anulada && p3.entryId === mias[0]!.id)
  check('>>> se puede anular lo vigente mientras el conteo sigue en conteo; lo anulado ya no', mias[0]!.puedeAnular && !mias[1]!.puedeAnular)
  check('>>> «mis pasadas» no trae ninguna cifra del sistema', !/"(systemQty|sistema|stock|quantity)"/i.test(JSON.stringify(mias).replace(/"cantidad"/g, '')))
  await cerrar(AD, cBor.id)
  check('>>> con el conteo cerrado ya no se puede anular ninguna', (await misPasadas(db(AL), AL, { countId: cBor.id })).every((m) => !m.puedeAnular))
  check('>>> armar una SELECCIÓN exige conteo.gestionar (el almacenero que solo cuenta no)', (await code(buscarProductosParaSeleccion(db(AL), AL, 'producto'))) === 'FORBIDDEN_ROLE' && (await buscarProductosParaSeleccion(db(AD), AD, 'producto')).length > 0 && (await buscarProductosParaSeleccion(db(AD), AD, 'p')).length === 0 && (await buscarProductosParaSeleccion(db(AD), AD, 'servicio')).length === 0)

  console.log('\nH) El listado con responsables')
  const lista = await listarConteosConResponsables(db(AD), AD)
  const f1 = lista.find((l) => l.id === c1.id)!
  check('>>> cada fila trae quién creó, cerró y aplicó, y las fechas; los más recientes primero', f1.creadoPor === 'ADMIN' && f1.cerradoPor === 'ADMIN' && f1.aplicadoPor === 'ADMIN' && f1.aplicadoEn !== null && lista.every((l, i) => i === 0 || l.createdAt <= lista[i - 1]!.createdAt))
  const fc = lista.find((l) => l.id === c2.id)!
  check('>>> el cancelado trae quién lo canceló, cuándo y por qué', fc.status === 'CANCELADO' && fc.canceladoPor === 'ADMIN' && fc.canceladoEn !== null && fc.motivoCancelacion === 'Prueba de documentos')
  check('>>> se filtra por estado', (await listarConteosConResponsables(db(AD), AD, { estado: 'APLICADO' })).every((l) => l.status === 'APLICADO') && (await listarConteosConResponsables(db(AD), AD, { estado: 'APLICADO' })).length === 1)
  check('>>> quien no puede ver conteos no los lista', (await code(listarConteosConResponsables(db(CA), CA))) === 'FORBIDDEN_ROLE' && (await code(detalleDeConteo(db(CT), CT, c1.id))) === 'FORBIDDEN_ROLE')
  const d1 = await detalleDeConteo(db(AD), AD, c1.id)
  check('>>> el detalle suma las líneas ya aplicadas y las por recontar', d1.aplicadas === 4 && d1.porRecontar === 0 && d1.number === a.numero)
  check('>>> quien solo alcanza la sucursal 1 no ve los conteos de la 2', await (async () => { const cw2 = await crear(AD, { warehouseId: W2 }); const veo = (await listarConteosConResponsables(db(GEST), GEST)).some((l) => l.id === cw2.id); const detalle = await code(detalleDeConteo(db(GEST), GEST, cw2.id)); await cancelar(AD, cw2.id); return !veo && detalle === 'NOT_FOUND' })())

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
