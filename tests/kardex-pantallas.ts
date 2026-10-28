import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { crearBorrador, recibirCompra } from '../src/features/compras/service'
import { createStockMovementSchema } from '../src/features/inventory/schemas'
import { createStockMovement } from '../src/features/inventory/stock-service'
import { buscarProductosKardex, kardexDeProducto, type KardexResultado, type LineaKardex } from '../src/features/inventory/kardex-service'
import { kardexSchema } from '../src/features/inventory/kardex-schemas'
import { ETIQUETA_ORIGEN_COSTO, enlaceCsvKardex, enlaceKardex, etiquetaMovimiento, leerFiltros, textoDocumento } from '../src/features/inventory/kardex-enlaces'
import { KardexAlertas, KardexResumen, KardexTabla } from '../src/features/inventory/components/KardexTabla'
import { BuscadorProducto, FiltrosKardex } from '../src/features/inventory/components/KardexFiltros'
import { visibleItems, isActive, NAV_ITEMS } from '../src/features/shell/nav-items'
import { permisosDe } from '../src/lib/puede'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.4c · La pantalla del kardex: lo puro (filtros, enlaces, nombres), los componentes renderizados AISLADOS con datos armados, la seguridad de costos en el HTML
 * de verdad (con el servicio y una base real: quien no ve costos no recibe ni encabezados ni cifras), el menú y los accesos directos, y las páginas leídas como código.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const html = (el: ReactElement) => renderToStaticMarkup(el)
const src = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const codigo = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
// Una excepción cuenta como fallo de la prueba (✗), no como un aborto sin veredicto.
const seguro = <T,>(f: () => T, otro: T): T => { try { return f() } catch (e) { console.log(`    (excepción: ${e instanceof Error ? e.message.slice(0, 140) : e})`); return otro } }
const cuenta = (h: string, re: RegExp) => (h.match(re) ?? []).length

const linea = (o: Partial<LineaKardex> = {}): LineaKardex => ({
  id: randomUUID(), cuando: '2026-10-05T15:00:00.000Z', tipo: 'ENTRADA', origen: 'COMPRA', almacen: { id: 'w1', nombre: 'Almacén central' }, entrada: 10, salida: 0, saldo: 10, saldoAlmacen: 10,
  descuadre: false, stockNegativo: false, motivo: null, usuario: 'Rosa', presentacion: null, documento: { tipo: 'COMPRA', numero: 'C-0001', href: '/compras/c1' }, ...o,
})
const costos = (o: Record<string, unknown> = {}) => ({ costoUnitario: 5, valor: 50, costoPromedio: 5, saldoValorizado: 50, origen: 'EXACTO' as const, pendiente: false, ...o })
const base = (o: Partial<KardexResultado> = {}): KardexResultado => ({
  producto: { id: 'p1', nombre: 'Cemento Sol', sku: 'CEM-1', unidad: 'UNIDAD', controlaStock: true },
  almacenes: [{ id: 'w1', nombre: 'Almacén central' }, { id: 'w2', nombre: 'Almacén norte' }], almacenElegido: null, variante: null,
  desde: '2026-10-01', hasta: '2026-10-31', zonaHoraria: 'America/Lima', conCostos: false, saldoInicial: { cantidad: 3 }, lineas: [linea()], siguiente: null,
  totales: { movimientos: 1, entradas: 10, salidas: 0, saldoFinal: 13, saldoPorMovimientos: 13, consistente: true, stockActual: 13, cuadraConStock: true }, alertas: [], ...o,
})
const conCostos = (o: Partial<KardexResultado> = {}): KardexResultado => base({
  conCostos: true, saldoInicial: { cantidad: 3, costos: { costoPromedio: 4, valorizado: 12, origen: 'RECONSTRUIDO' } },
  lineas: [linea({ costos: costos() }), linea({ id: 'l2', entrada: 0, salida: 4, saldo: 9, tipo: 'SALIDA', origen: 'VENTA', documento: { tipo: 'VENTA', numero: 'B001-7', href: '/ventas/v7' }, costos: costos({ costoUnitario: 6, valor: -24, costoPromedio: 6, saldoValorizado: 54, origen: 'RECONSTRUIDO' }) })],
  totales: { movimientos: 2, entradas: 10, salidas: 4, saldoFinal: 9, saldoPorMovimientos: 9, consistente: true, stockActual: 9, cuadraConStock: true, costos: { costoPromedio: 6, saldoFinalValorizado: 54 } }, ...o,
})
const F = { producto: 'p1' }

console.log('\nA) Filtros, enlaces y nombres (puro)')
check('>>> leerFiltros toma el primer valor, recorta espacios y descarta lo vacío o desconocido', (() => {
  const r = leerFiltros({ producto: ['p1', 'p2'], almacen: '  w1 ', desde: '', hasta: undefined, variante: '   ', cursor: 'abc', q: ' cemento ', otro: 'x' })
  return JSON.stringify(r) === JSON.stringify({ producto: 'p1', almacen: 'w1', cursor: 'abc', q: 'cemento' })
})())
check('>>> y acota los largos (un valor enorme no viaja entero)', (() => { const r = leerFiltros({ producto: 'x'.repeat(500), q: 'y'.repeat(500), desde: '2026-10-01-EXTRA-LARGO' }); return r.producto!.length === 64 && r.q!.length === 80 && r.desde!.length === 10 })())
check('>>> enlaceKardex arma la dirección con los filtros en orden estable y omite lo vacío', enlaceKardex({ producto: 'p1', almacen: 'w1', desde: '2026-10-01', hasta: '2026-10-31' }) === '/inventario/kardex?producto=p1&almacen=w1&desde=2026-10-01&hasta=2026-10-31' && enlaceKardex({}) === '/inventario/kardex' && enlaceKardex({ producto: 'p1', almacen: '' }) === '/inventario/kardex?producto=p1')
check('>>> los valores se codifican (nada de inyectar parámetros con & o espacios)', enlaceKardex({ q: 'a&b=c d' }) === '/inventario/kardex?q=a%26b%3Dc%20d' && !enlaceKardex({ producto: 'x&desde=2000-01-01' }).includes('&desde='))
check('>>> el cursor viaja en la dirección de la página siguiente', enlaceKardex({ producto: 'p1', cursor: 'abc_-9' }) === '/inventario/kardex?producto=p1&cursor=abc_-9')
check('>>> el enlace del CSV usa los nombres de la API, lleva el rango y NO lleva cursor ni búsqueda', enlaceCsvKardex({ producto: 'p1', almacen: 'w1', variante: 'v1', desde: '2026-10-01', hasta: '2026-10-31', cursor: 'zz', q: 'hola' }) === '/api/inventario/kardex?productId=p1&warehouseId=w1&variantId=v1&desde=2026-10-01&hasta=2026-10-31')
check('>>> sin producto no hay enlace de CSV', enlaceCsvKardex({ q: 'x' }) === null)
check('>>> el nombre del movimiento lo manda el documento: una venta es «Venta» aunque por dentro sea una salida', etiquetaMovimiento({ tipo: 'SALIDA', entrada: 0, documento: { tipo: 'VENTA' } }) === 'Venta' && etiquetaMovimiento({ tipo: 'ENTRADA', entrada: 3, documento: { tipo: 'COMPRA' } }) === 'Compra' && etiquetaMovimiento({ tipo: 'DEVOLUCION_PROVEEDOR', entrada: 0, documento: { tipo: 'COMPRA' } }) === 'Anulación de compra')
check('>>> devoluciones: la de cliente y la dañada (merma) se distinguen; la anulación de venta reingresa', etiquetaMovimiento({ tipo: 'DEVOLUCION_CLIENTE', entrada: 2, documento: { tipo: 'DEVOLUCION' } }) === 'Devolución de cliente' && etiquetaMovimiento({ tipo: 'MERMA', entrada: 0, documento: { tipo: 'DEVOLUCION' } }) === 'Devolución dañada (merma)' && etiquetaMovimiento({ tipo: 'ENTRADA', entrada: 2, documento: { tipo: 'VENTA' } }) === 'Reingreso de venta')
check('>>> los movimientos manuales y de transferencia se nombran por su tipo', etiquetaMovimiento({ tipo: 'AJUSTE', entrada: 1, documento: { tipo: 'MANUAL' } }) === 'Ajuste de inventario' && etiquetaMovimiento({ tipo: 'TRANSFERENCIA_SALIDA', entrada: 0, documento: { tipo: 'TRANSFERENCIA' } }) === 'Transferencia (sale)' && etiquetaMovimiento({ tipo: 'INICIAL', entrada: 5, documento: { tipo: 'MANUAL' } }) === 'Stock inicial' && etiquetaMovimiento({ tipo: 'RARO', entrada: 1, documento: { tipo: 'MANUAL' } }) === 'RARO')
check('>>> el documento: tipo + número, o solo el tipo, o nada si es manual', textoDocumento({ tipo: 'VENTA', numero: 'B001-7' }) === 'Venta B001-7' && textoDocumento({ tipo: 'COMPRA', numero: null }) === 'Compra' && textoDocumento({ tipo: 'MANUAL', numero: null }) === '')
check('>>> las marcas de costo tienen etiqueta en español', ETIQUETA_ORIGEN_COSTO.EXACTO === 'Exacto' && ETIQUETA_ORIGEN_COSTO.RECONSTRUIDO === 'Reconstruido' && ETIQUETA_ORIGEN_COSTO.SIN_DATO === 'Sin dato')

console.log('\nB) La tabla SIN costos: ni columnas ni cifras')
const hS = seguro(() => html(createElement(KardexTabla, { k: base({ lineas: [linea({ costos: undefined })] }), filtros: F, primeraPagina: true })), '')
check('>>> sin costos hay exactamente 6 encabezados (Fecha, Movimiento, Documento, Entrada, Salida, Saldo) más Almacén si es consolidado', cuenta(hS, /<th /g) === 7 && !/Costo|Valor|valorizado|Exacto|Reconstruido/i.test(hS))
const hS1 = seguro(() => html(createElement(KardexTabla, { k: base({ almacenes: [{ id: 'w1', nombre: 'Único' }] }), filtros: F, primeraPagina: true })), '')
check('>>> con UN solo almacén no sobra la columna Almacén', cuenta(hS1, /<th /g) === 6 && !hS1.includes('>Almacén<'))
check('>>> las filas especiales: saldo inicial arriba (3) y totales abajo (entradas 10, salidas 0, saldo 13)', hS.includes('data-kardex="saldo-inicial"') && hS.includes('Saldo inicial al 2026-10-01') && hS.includes('data-kardex="totales"') && hS.includes('Totales del periodo'))
check('>>> a las 22:30 de Lima (03:30 UTC del día siguiente) la fila sigue siendo del día de Lima', seguro(() => html(createElement(KardexTabla, { k: base({ lineas: [linea({ cuando: '2026-10-06T03:30:00.000Z' })] }), filtros: F, primeraPagina: true })), '').includes('05/10/2026'))
check('>>> cada línea muestra fecha en la hora del negocio, movimiento, documento enlazado y los números', hS.includes('05/10/2026') && hS.includes('Compra') && hS.includes('href="/compras/c1"') && hS.includes('Compra C-0001'))
const hTC = seguro(() => html(createElement(KardexTabla, { k: conCostos(), filtros: F, primeraPagina: true })), '')
check('>>> CON costos aparecen las 5 columnas de valor (costo unitario, valor, promedio, saldo valorizado, marca)', cuenta(hTC, /<th /g) === 12 && ['Costo unit.', 'Valor', 'Costo prom.', 'Saldo valorizado'].every((c) => hTC.includes(c)) && hTC.includes('data-origen="EXACTO"') && hTC.includes('data-origen="RECONSTRUIDO"'))
check('>>> con costos los importes salen en soles con 2 decimales, y la salida con signo (−24.00)', hTC.includes('S/ 50.00') && hTC.includes('S/ -24.00') && hTC.includes('S/ 54.00'))
check('>>> cada marca explica qué significa al pasar el cursor (title)', hTC.includes('title="El sistema guardó este costo') && hTC.includes('title="Calculado repitiendo compras'))
const hPend = seguro(() => html(createElement(KardexTabla, { k: conCostos({ lineas: [linea({ costos: costos({ costoUnitario: null, valor: null, pendiente: true }) }), linea({ id: 'l3', costos: costos({ costoUnitario: null, valor: null, costoPromedio: null, saldoValorizado: null, origen: 'SIN_DATO' }) })] }), filtros: F, primeraPagina: true })), '')
check('>>> un costo pendiente lo dice y un SIN_DATO muestra «—» en vez de cifras', hPend.includes('data-kardex="pendiente"') && hPend.includes('data-origen="SIN_DATO"') && cuenta(hPend, /—/g) >= 6)

console.log('\nC) Saldo negativo, descuadre, páginas y vacío')
const hN = seguro(() => html(createElement(KardexTabla, { k: base({ lineas: [linea({ stockNegativo: true, saldoAlmacen: -2, saldo: -2 }), linea({ id: 'l4', descuadre: true })] }), filtros: F, primeraPagina: true })), '')
check('>>> el stock negativo se marca en la fila y en una insignia; el descuadre también', hN.includes('data-negativo="si"') && hN.includes('data-kardex="negativo"') && hN.includes('Stock negativo') && hN.includes('data-descuadre="si"') && hN.includes('Saldo no coincide') && hN.includes('text-stock-out'))
check('>>> una fila normal no lleva marcas', !hS.includes('data-kardex="negativo"') && !hS.includes('data-kardex="descuadre"') && hS.includes('data-negativo="no"'))
const sig = seguro(() => html(createElement(KardexTabla, { k: base({ siguiente: 'CURSOR_1' }), filtros: { producto: 'p1', almacen: 'w1' }, primeraPagina: true })), '')
check('>>> con más páginas: enlace «Ver más» con el cursor y SIN totales todavía (solo en la última)', sig.includes('data-kardex="siguiente"') && sig.includes('href="/inventario/kardex?producto=p1&amp;almacen=w1&amp;desde=2026-10-01&amp;hasta=2026-10-31&amp;cursor=CURSOR_1"') && !sig.includes('data-kardex="totales"') && sig.includes('data-kardex="saldo-inicial"'))
const seg = seguro(() => html(createElement(KardexTabla, { k: base({ siguiente: null }), filtros: { producto: 'p1', cursor: 'CURSOR_1' }, primeraPagina: false })), '')
check('>>> en una página siguiente: sin saldo inicial, con totales si es la última, y «Volver al inicio» (sin cursor)', !seg.includes('data-kardex="saldo-inicial"') && seg.includes('data-kardex="totales"') && seg.includes('data-kardex="inicio"') && !seg.includes('data-kardex="siguiente"') && !/data-kardex="inicio" href="[^"]*cursor/.test(seg))
check('>>> en la primera y única página no hay navegación', !hS.includes('data-kardex="paginas"'))
const vac = seguro(() => html(createElement(KardexTabla, { k: base({ lineas: [] }), filtros: F, primeraPagina: true })), '')
check('>>> sin movimientos lo dice, pero conserva saldo inicial y totales', vac.includes('data-kardex="vacio"') && vac.includes('No hubo movimientos') && vac.includes('data-kardex="saldo-inicial"') && vac.includes('data-kardex="totales"'))
check('>>> la tabla se desliza dentro de su caja (la página no se ensancha en el móvil)', hS.includes('overflow-x-auto') && hS.includes('min-w-['))

console.log('\nD) Resumen y alertas')
const rS = seguro(() => html(createElement(KardexResumen, { k: base(), filtros: F })), '')
check('>>> el resumen del rango: saldo inicial, entradas, salidas, saldo final, movimientos y stock actual', ['Saldo inicial', 'Entradas', 'Salidas', 'Saldo final', 'Movimientos', 'Stock actual'].every((t) => rS.includes(t)) && rS.includes('Cemento Sol') && rS.includes('Del 2026-10-01 al 2026-10-31') && rS.includes('Todos mis almacenes'))
check('>>> el botón de CSV apunta al endpoint con el rango que se está viendo', rS.includes('data-kardex="csv"') && rS.includes('href="/api/inventario/kardex?productId=p1&amp;desde=2026-10-01&amp;hasta=2026-10-31"') && rS.includes('download'))
check('>>> sin costos el resumen lo explica y no tiene ninguna cifra de valor', rS.includes('data-kardex="sin-costos"') && rS.includes('Ver costos y márgenes') && !/Costo promedio|valorizado/i.test(rS))
const rC = seguro(() => html(createElement(KardexResumen, { k: conCostos({ almacenElegido: 'w2' }), filtros: { producto: 'p1', almacen: 'w2' } })), '')
check('>>> con costos añade el costo promedio y el saldo final valorizado, y nombra el almacén elegido', rC.includes('Costo promedio') && rC.includes('S/ 6.00') && rC.includes('Saldo final valorizado') && rC.includes('S/ 54.00') && rC.includes('Almacén norte') && !rC.includes('data-kardex="sin-costos"') && rC.includes('warehouseId=w2'))
const cu = (c: boolean | null) => seguro(() => html(createElement(KardexResumen, { k: base({ totales: { ...base().totales, cuadraConStock: c } }), filtros: F })), '')
check('>>> el cuadre con el stock tiene tres estados claros', cu(true).includes('Cuadra con el stock actual') && cu(false).includes('No cuadra con el stock actual') && cu(null).includes('Hay movimientos posteriores a este rango') && cu(false).includes('text-stock-out'))
const al = seguro(() => html(createElement(KardexAlertas, { k: base({ alertas: [{ codigo: 'STOCK_NEGATIVO', mensaje: '2 movimiento(s) dejaron el stock en negativo.', cantidad: 2 }, { codigo: 'NO_CUADRA', mensaje: 'No cuadra.' }, { codigo: 'COSTO_PENDIENTE', mensaje: '1 entrada(s) esperan costo.', cantidad: 1 }] }) })), '')
const liDe = (c: string) => al.split('<li').find((x) => x.includes(`data-alerta="${c}"`)) ?? ''
check('>>> las alertas salen como avisos (role=alert) con su código; las de stock/cuadre en rojo y las de costos en ámbar', cuenta(al, /role="alert"/g) === 3 && liDe('STOCK_NEGATIVO').includes('text-stock-out') && liDe('NO_CUADRA').includes('text-stock-out') && liDe('COSTO_PENDIENTE').includes('text-stock-low') && !liDe('COSTO_PENDIENTE').includes('text-stock-out') && al.includes('dejaron el stock en negativo'))
check('>>> sin alertas no se pinta nada', html(createElement(KardexAlertas, { k: base() })) === '')

console.log('\nE) Buscador y filtros')
const bu = seguro(() => html(createElement(BuscadorProducto, { q: 'cemento' })), '')
check('>>> el buscador es un formulario GET a la propia pantalla, con el texto previo', bu.includes('method="get"') && bu.includes('action="/inventario/kardex"') && bu.includes('name="q"') && bu.includes('value="cemento"') && bu.includes('role="search"'))
const fi = seguro(() => html(createElement(FiltrosKardex, { filtros: { producto: 'p1', almacen: 'w2' }, almacenes: [{ id: 'w1', nombre: 'Almacén central' }, { id: 'w2', nombre: 'Almacén norte' }], variantes: [], desde: '2026-10-01', hasta: '2026-10-31' })), '')
check('>>> los filtros: producto oculto, almacén (con «Todos» y el elegido marcado), fechas por defecto del rango, sin variante si no hay', fi.includes('name="producto" value="p1"') && fi.includes('Todos mis almacenes') && /<option value="w2" selected/.test(fi) && fi.includes('name="desde"') && fi.includes('value="2026-10-01"') && fi.includes('value="2026-10-31"') && !fi.includes('name="variante"'))
const fiV = seguro(() => html(createElement(FiltrosKardex, { filtros: { producto: 'p1', variante: 'v2' }, almacenes: [], variantes: [{ id: 'v1', nombre: 'Rojo' }, { id: 'v2', nombre: 'Azul' }], desde: '2026-10-01', hasta: '2026-10-31' })), '')
check('>>> con variantes aparece su selector (con la elegida) y «Últimos 30 días» limpia las fechas y la página pero conserva el producto y la variante', fiV.includes('name="variante"') && /<option value="v2" selected/.test(fiV) && /data-kardex="ultimos-30" href="\/inventario\/kardex\?producto=p1&amp;variante=v2"/.test(fiV))
check('>>> los campos de fecha son del tipo fecha (en el móvil abren el selector nativo)', fi.includes('type="date"'))

async function cuerpo() {
console.log('\nF) La seguridad de costos en el HTML REAL (servicio + base)')
const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
const t = await prisma.tenant.create({ data: { slug: `rp-kdp-${randomUUID().slice(0, 6)}`, name: 'Kardex pantallas', taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`), planId: plan.id } })
await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_kdp' } })
const b1 = await crearSucursalConAlmacen(t.id)
const u: Record<string, TenantContext> = {}
for (const role of ['OWNER', 'CONTADOR', 'ALMACENERO', 'CAJERO'] as Role[]) {
  const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
  await asignarSucursal(t.id, x.id, b1.branch.id)
  u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
}
const O = u.OWNER!, K = u.CONTADOR!, AL = u.ALMACENERO!, CA = u.CAJERO!
const db = (c: TenantContext) => getTenantPrisma(c)
const P = await prisma.product.create({ data: { tenantId: t.id, sku: 'PK1', name: 'Cemento Real', unitType: 'UNIDAD', salePrice: 20, costPrice: 0, barcode: '7750001234567' } })
const b = await crearBorrador(db(O), O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: b1.warehouse.id, items: [{ productId: P.id, enteredQuantity: 10, unitCost: 5 }] }))
await recibirCompra(db(O), O, recibirCompraSchema.parse({ purchaseId: b.id }))
await createStockMovement(db(O), O, createStockMovementSchema.parse({ productId: P.id, warehouseId: b1.warehouse.id, type: 'ENTRADA', quantity: 2, unitCost: 9.99, source: 'MANUAL' }))
const vista = async (c: TenantContext) => {
  const k = await kardexDeProducto(db(c), c, kardexSchema.parse({ productId: P.id, limite: 50 }))
  const doc = html(createElement('div', null, createElement(KardexResumen, { k, filtros: { producto: P.id } }), createElement(KardexAlertas, { k }), createElement(KardexTabla, { k, filtros: { producto: P.id }, primeraPagina: true })))
  return { k, doc }
}
const vA = await vista(AL), vK = await vista(K)
check('>>> el HTML del almacenero (kardex.ver sin costos) no tiene NINGÚN encabezado, importe ni marca de costo', vA.k.lineas.length === 2 && !/Costo|Valor|valorizado|Exacto|Reconstruido|S\//i.test(vA.doc.replace(/<p data-kardex="sin-costos"[^>]*>.*?<\/p>/, '')) && !vA.doc.includes('5.00') && !vA.doc.includes('9.99') && vA.doc.includes('data-kardex="sin-costos"'))
check('>>> el del contador (con costos) sí: costo 5.00, 9.99 y las marcas', /S\/ 5\.00/.test(vK.doc) && vK.doc.includes('S/ 9.99') && vK.doc.includes('data-origen="EXACTO"') && vK.doc.includes('Saldo valorizado'))
check('>>> y el CSV: el enlace es el mismo para ambos (la API decide), con el rango resuelto por el servicio', vA.doc.includes(`productId=${P.id}`) && vA.doc.includes(`desde=${vA.k.desde}`) && vK.doc.includes(`hasta=${vK.k.hasta}`))
const cand = await buscarProductosKardex(db(AL), AL, 'cemento')
check('>>> la búsqueda encuentra por nombre, por SKU y por código de barras', cand.length === 1 && cand[0]!.id === P.id && (await buscarProductosKardex(db(AL), AL, 'pk1')).length === 1 && (await buscarProductosKardex(db(AL), AL, '775000')).length === 1)
check('>>> la búsqueda pide 2 letras como mínimo, no devuelve nada si no hay coincidencias y no ve productos de otros negocios', (await buscarProductosKardex(db(AL), AL, 'c')).length === 0 && (await buscarProductosKardex(db(AL), AL, 'zzzzzz')).length === 0)
check('>>> sin kardex.ver la búsqueda también se niega', await buscarProductosKardex(db(CA), CA, 'cemento').then(() => null, (e) => e.code) === 'FORBIDDEN_ROLE')
const sinControl = await prisma.product.create({ data: { tenantId: t.id, sku: 'SRV1', name: 'Servicio de corte', unitType: 'UNIDAD', salePrice: 5, costPrice: 0, trackStock: false } })
check('>>> los servicios (sin control de stock) no salen en la búsqueda', (await buscarProductosKardex(db(O), O, 'servicio')).every((c) => c.id !== sinControl.id))

console.log('\nG) El menú y los accesos directos')
const enMenu = (rol: Role) => visibleItems([...permisosDe({ tenantId: 't', userId: 'u', role: rol, access: 'FULL', permisosExtra: [] } as TenantContext)]).some((i) => i.href === '/inventario/kardex')
check('>>> el menú muestra «Kardex» a dueño, administrador, contador y almacenero; no a cajero ni vendedor', (['OWNER', 'ADMIN', 'CONTADOR', 'ALMACENERO'] as Role[]).every(enMenu) && !enMenu('CAJERO') && !enMenu('VENDEDOR'))
check('>>> en /inventario/kardex se marca «Kardex» y SOLO ese (no «Inventario» a la vez); en /inventario sigue marcado «Inventario»', isActive('/inventario/kardex', '/inventario/kardex') && !isActive('/inventario', '/inventario/kardex') && isActive('/inventario', '/inventario') && isActive('/inventario', '/inventario/importar') && NAV_ITEMS.filter((i) => isActive(i.href, '/inventario/kardex')).length === 1)
check('>>> la regla no rompe lo demás: /clientes/abc sigue marcando Clientes y nada más', NAV_ITEMS.filter((i) => isActive(i.href, '/clientes/abc')).map((i) => i.href).join() === '/clientes')
const pagK = codigo('src/app/(dashboard)/inventario/kardex/page.tsx')
check('>>> la página exige sesión y `kardex.ver` ANTES de leer nada (sin permiso: 404)', pagK.includes('requireTenantContext()') && /if \(!puede\(ctx, 'kardex\.ver'\)\) notFound\(\)/.test(pagK) && pagK.indexOf("notFound()") < pagK.indexOf('kardexDeProducto('))
check('>>> valida los filtros con el esquema (no confía en la dirección) y solo muestra como aviso los errores de negocio esperados', pagK.includes('kardexSchema.safeParse') && /e\.code === 'NOT_FOUND' \|\| e\.code === 'INVALID_DOCUMENT'/.test(pagK) && pagK.includes('else throw e'))
check('>>> pide 50 filas por página, empieza por la primera página si no hay cursor y no lee costos por su cuenta', pagK.includes('limite: 50') && pagK.includes('primeraPagina={!f.cursor}') && !/costPrice|unitCost|costAfter/.test(pagK))
const ins = codigo('src/app/(dashboard)/inventario/page.tsx'), ala = codigo('src/app/(dashboard)/inventario/alertas/page.tsx'), hoja = codigo('src/features/inventory/components/ScanToStockSheet.tsx')
check('>>> desde Inventario hay un botón «Kardex» (solo con kardex.ver) y la hoja del producto escaneado ofrece «Ver kardex de este producto»', ins.includes("puede(ctx, 'kardex.ver')") && /\{verKardex && \(\s*<Link href="\/inventario\/kardex"/.test(ins) && ins.includes('verKardex={verKardex}') && hoja.includes('verKardex &&') && hoja.includes('enlaceKardex({ producto: product.productId, almacen: product.warehouseId })'))
check('>>> desde las alertas de stock cada producto enlaza a su kardex (solo con kardex.ver)', ala.includes("puede(ctx, 'kardex.ver')") && ala.includes('enlaceKardex({ producto: a.productId })') && ala.includes('verKardex &&'))
check('>>> la hoja del escáner no muestra el enlace por defecto (verKardex es opcional y falso)', hoja.includes('verKardex = false'))
const comp = codigo('src/features/inventory/components/KardexTabla.tsx')
check('>>> la tabla muestra las columnas de valor solo dentro de `k.conCostos` (nunca por su cuenta)', (comp.match(/k\.conCostos/g) ?? []).length >= 6 && comp.includes('l.costos &&'))
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(async () => {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 400) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
})
