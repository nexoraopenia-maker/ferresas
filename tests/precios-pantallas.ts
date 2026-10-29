import { existsSync, readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ListasPrecio } from '../src/features/precios/components/ListasPrecio'
import { PreciosGrid, cambioDeFila } from '../src/features/precios/components/PreciosGrid'
import { ListaDePrecioCliente } from '../src/features/precios/components/ListaDePrecioCliente'
import { SelectorListaPrecios } from '../src/features/pos/components/SelectorListaPrecios'
import { asignarListaClienteAccion, crearListaAccion, darDeBajaListaAccion, editarListaAccion, guardarPreciosAccion } from '../src/features/precios/actions'
import { preciosParaLista } from '../src/features/pos/actions'
import { brutoDe, conContada, conPrecios, datosDePrecioDe, descuentoDe, etiquetaDePrecio, precioDe, type LineaCarrito } from '../src/features/pos/carrito'
import type { PosProduct } from '../src/features/pos/actions'
import type { DatosDePrecio } from '../src/features/pos/precios-reglas'
import type { FilaPrecio, ListaDePrecio } from '../src/features/precios/service'
import { visibleItems, isActive, NAV_ITEMS } from '../src/features/shell/nav-items'
import { permisosDe } from '../src/lib/puede'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.7c · Las pantallas de precios, renderizadas AISLADAS: las listas, la cuadrícula de precios y tramos (y qué cambio sale de cada fila), la lista del cliente, el selector del POS,
 * el carrito del navegador con el motor compartido, el menú, las acciones de servidor (validación antes de la sesión) y las páginas leídas como código.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const src = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const codigo = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const seguro = <T,>(f: () => T, otro: T): T => { try { return f() } catch (e) { console.log(`    (excepción: ${e instanceof Error ? e.message.slice(0, 140) : e})`); return otro } }
const cuenta = (h: string, re: RegExp) => (h.match(re) ?? []).length
const ctxDe = (role: Role): TenantContext => ({ tenantId: 't', userId: 'u', role, access: 'FULL', branchId: 'b', permisosExtra: [] })

async function main() {
  console.log('\nA) La lista de listas')
  const listas: ListaDePrecio[] = [
    { id: 'l1', name: 'Mayorista', code: 'MAY', isActive: true, entradas: 12, clientes: 3 },
    { id: 'l2', name: 'Constructor', code: null, isActive: false, entradas: 1, clientes: 0 },
  ]
  const hl = seguro(() => html(createElement(ListasPrecio, { listas })), '')
  check('>>> la Base va primero, con enlace a sus tramos', hl.indexOf('data-lista="base"') >= 0 && hl.indexOf('data-lista="base"') < hl.indexOf('data-lista="l1"') && hl.includes('href="/precios/base"'))
  check('>>> cada lista trae su nombre, código, cuántos productos y clientes tiene y su enlace', hl.includes('Mayorista') && hl.includes('MAY') && /12 productos · 3 clientes/.test(hl) && /1 producto · 0 clientes/.test(hl) && hl.includes('href="/precios/l1"'))
  check('>>> una lista inactiva se marca', /inactiva/.test(hl))
  check('>>> hay formulario de alta, renombrar y dar de baja', hl.includes('data-precios="nueva"') && hl.includes('Renombrar') && hl.includes('Dar de baja'))
  check('>>> sin listas lo dice y ofrece crear la primera', /Todavía no hay listas/.test(seguro(() => html(createElement(ListasPrecio, { listas: [] })), '')))

  console.log('\nB) Qué cambio sale de cada fila de la cuadrícula (puro, con las reglas del servidor)')
  const fila = (o: Partial<FilaPrecio> = {}): FilaPrecio => ({ productId: 'p1', nombre: 'Cinta', sku: 'CIN', unitType: 'UNIDAD', salePrice: 3.5, entrada: null, baseTiers: [], ...o })
  const b = (price: string, tiers: { min: string; precio: string }[] = [], eliminar = false) => ({ price, tiers, eliminar })
  check('>>> sin tocar nada no hay cambio', cambioDeFila(fila(), b(''), true).cambio === null && cambioDeFila(fila({ entrada: { price: 3.1, tiers: [] } }), b('3.1'), true).cambio === null)
  check('>>> un precio nuevo en una lista sin entrada crea la entrada', JSON.stringify(cambioDeFila(fila(), b('3,1'), true).cambio) === JSON.stringify({ productId: 'p1', price: 3.1 }))
  check('>>> un tramo nuevo sin precio plano: solo tramos', JSON.stringify(cambioDeFila(fila(), b('', [{ min: '12', precio: '2.9' }]), true).cambio) === JSON.stringify({ productId: 'p1', tiers: [{ minQuantity: 12, unitPrice: 2.9 }] }))
  check('>>> cambiar solo el precio no toca los tramos (y al revés)', (() => { const f = fila({ entrada: { price: 3.1, tiers: [{ minQuantity: 12, unitPrice: 2.9 }] } }); const c = cambioDeFila(f, b('3', [{ min: '12', precio: '2.9' }]), true).cambio as Record<string, unknown>; const d = cambioDeFila(f, b('3.1', [{ min: '12', precio: '2.5' }]), true).cambio as Record<string, unknown>; return 'price' in c && !('tiers' in c) && !('price' in d) && 'tiers' in d })())
  check('>>> vaciar el precio de una entrada con tramos lo quita (null)', JSON.stringify(cambioDeFila(fila({ entrada: { price: 3.1, tiers: [{ minQuantity: 12, unitPrice: 2.9 }] } }), b('', [{ min: '12', precio: '2.9' }]), true).cambio) === JSON.stringify({ productId: 'p1', price: null }))
  check('>>> vaciar precio y tramos de una entrada que existe se avisa (para volver a Base se quita de la lista)', /quita el producto de la lista/.test(cambioDeFila(fila({ entrada: { price: 3.1, tiers: [] } }), b(''), true).error ?? ''))
  check('>>> «Quitar de la lista» sale como eliminar, y solo si la entrada existe', JSON.stringify(cambioDeFila(fila({ entrada: { price: 3.1, tiers: [] } }), b('3.1', [], true), true).cambio) === JSON.stringify({ productId: 'p1', eliminar: true }) && cambioDeFila(fila(), b('', [], true), true).cambio === null)
  check('>>> en la Base solo hay tramos (el precio plano no se envía nunca)', JSON.stringify(cambioDeFila(fila(), b('9', [{ min: '100', precio: '3.2' }]), false).cambio) === JSON.stringify({ productId: 'p1', tiers: [{ minQuantity: 100, unitPrice: 3.2 }] }))
  check('>>> >>> las reglas del servidor ya se ven aquí: un tramo que sube el precio con la cantidad', /no puede costar más/.test(cambioDeFila(fila(), b('', [{ min: '10', precio: '3' }, { min: '20', precio: '3.4' }]), true).error ?? ''))
  check('>>> un tramo más caro que el plano (el de la lista, o el Base si no hay)', /más que el precio plano/.test(cambioDeFila(fila(), b('3', [{ min: '10', precio: '3.2' }]), true).error ?? '') && /más que el precio plano/.test(cambioDeFila(fila(), b('', [{ min: '10', precio: '4' }]), true).error ?? ''))
  check('>>> un tramo a medias o con letras se marca', /necesita una cantidad y un precio/.test(cambioDeFila(fila(), b('', [{ min: '10', precio: '' }]), true).error ?? '') && /número/.test(cambioDeFila(fila(), b('abc'), true).error ?? ''))
  check('>>> una fila de tramo vacía se ignora', cambioDeFila(fila(), b('', [{ min: '', precio: '' }]), true).cambio === null)

  console.log('\nC) La cuadrícula renderizada')
  const filas = [
    fila({ entrada: { price: 3.1, tiers: [{ minQuantity: 12, unitPrice: 2.9 }] }, costoUnitario: 2 }),
    fila({ productId: 'p2', nombre: 'Tubo', sku: 'TUB', salePrice: 11.8, costoUnitario: null }),
  ]
  const g1 = seguro(() => html(createElement(PreciosGrid, { priceListId: 'l1', filas })), '')
  check('>>> una fila por producto con su precio Base, el campo de precio de la lista y sus tramos', cuenta(g1, /data-fila=/g) === 2 && cuenta(g1, /data-campo="precio"/g) === 2 && /value="3\.1"/.test(g1) && /value="12"/.test(g1) && /value="2\.9"/.test(g1) && /Base S\/ 11\.80/.test(g1))
  check('>>> lo heredado se ve como sugerencia gris (el precio Base) y se dice que vacío = Base', /placeholder="11\.80"/.test(g1) && /vacío = el precio Base/.test(g1))
  check('>>> con costos (el servidor lo mandó) se ven; «sin dato» si no hay', g1.includes('data-precio="costo"') && /costo S\/ 2\.00 sin IGV/.test(g1) && /costo sin dato/.test(g1))
  const g2 = seguro(() => html(createElement(PreciosGrid, { priceListId: 'l1', filas: filas.map(({ costoUnitario: _c, ...r }) => r) })), '')
  check('>>> >>> sin costos en los datos NO existe ni la palabra «costo» en la pantalla', !/costo/i.test(g2.replace(/Quitar de la lista/g, '')))
  check('>>> «Quitar de la lista» solo en filas que ya tienen entrada; «Añadir tramo» en todas', cuenta(g1, /data-precio="quitar"/g) === 1 && cuenta(g1, /data-precio="mas-tramo"/g) === 2)
  const gb = seguro(() => html(createElement(PreciosGrid, { priceListId: null, filas: [fila({ baseTiers: [{ minQuantity: 100, unitPrice: 3.2 }] })] })), '')
  check('>>> la Base no tiene campo de precio plano (es el precio del producto) y muestra sus tramos', !gb.includes('data-campo="precio"') && /value="100"/.test(gb) && /value="3\.2"/.test(gb) && !gb.includes('data-precio="quitar"'))
  check('>>> «Guardar» empieza deshabilitado', /data-precios="guardar"[^>]*disabled=""/.test(g1) || /disabled=""[^>]*data-precios="guardar"/.test(g1))
  check('>>> cada campo tiene etiqueta accesible', /aria-label="Precio de Cinta en la lista"/.test(g1) && /aria-label="Cantidad mínima del tramo 1 de Cinta"/.test(g1) && /aria-label="Precio del tramo 1 de Cinta"/.test(g1))
  check('>>> sin productos lo dice', seguro(() => html(createElement(PreciosGrid, { priceListId: 'l1', filas: [] })), '').includes('data-precios="vacio"'))

  console.log('\nD) La lista en la ficha del cliente')
  const L = [{ id: 'l1', name: 'Mayorista' }]
  const e = seguro(() => html(createElement(ListaDePrecioCliente, { customerId: 'c1', actual: 'l1', listas: L, editable: true })), '')
  check('>>> editable: un selector con Base y las listas, con la actual elegida, y «Guardar» deshabilitado', /<option value="">Base \(minorista\)<\/option>/.test(e) && /<option value="l1" selected="">Mayorista/.test(e) && (/data-cliente="lista-precios"/.test(e)))
  const ro = seguro(() => html(createElement(ListaDePrecioCliente, { customerId: 'c1', actual: 'l1', listas: L, editable: false })), '')
  check('>>> sin precios.gestionar solo se ve la lista, sin selector', ro.includes('data-cliente="lista-solo-lectura"') && />Mayorista</.test(ro) && !/<select/.test(ro))
  check('>>> una lista dada de baja se dice (y se le vende a Base)', seguro(() => html(createElement(ListaDePrecioCliente, { customerId: 'c1', actual: 'vieja', listas: L, editable: true })), '').includes('data-cliente="lista-de-baja"'))

  console.log('\nE) El selector del POS')
  const sel = seguro(() => html(createElement(SelectorListaPrecios, { listas: [{ id: 'l1', name: 'Mayorista' }, { id: 'l2', name: 'Constructor' }], valor: 'l1', onChange: noop, nota: 'Es la lista de este cliente.' })), '')
  check('>>> Base primero y todas las listas; la elegida marcada; con su nota', /<option value="">Base \(minorista\)<\/option>/.test(sel) && /<option value="l1" selected="">Mayorista/.test(sel) && sel.includes('Constructor') && sel.includes('Es la lista de este cliente.'))
  check('>>> se puede deshabilitar (un pedido tomado se cobra con sus precios)', /disabled=""/.test(seguro(() => html(createElement(SelectorListaPrecios, { listas: [], valor: null, onChange: noop, deshabilitado: true })), '')))

  console.log('\nF) El carrito del navegador con el motor compartido')
  const datos: DatosDePrecio = { salePrice: 3.5, baseTiers: [{ minQuantity: 100, unitPrice: 3.2 }], entrada: { price: 3.1, tiers: [{ minQuantity: 12, unitPrice: 2.9 }] } }
  const prod = (precios?: DatosDePrecio) => ({ productId: 'p1', variantId: null, name: 'Cinta', sku: 'CIN', unitType: 'UNIDAD', salePrice: 3.5, taxRate: 0.18, trackStock: true, stock: 1000, minStock: 0, stockStatus: 'OK', warehouseId: 'w', warehouseName: 'A', ...(precios ? { precios } : {}) }) as unknown as PosProduct
  const linea = (q: number, precios?: DatosDePrecio, extra: Partial<LineaCarrito> = {}): LineaCarrito => ({ key: 'a', producto: prod(precios), quantity: q, discount: 0, ...extra })
  check('>>> sin datos de precio (un pedido tomado) usa el precio de la línea y nada más', brutoDe(linea(4)) === 14 && precioDe(linea(4)).fuente === 'BASE' && datosDePrecioDe(linea(4)).baseTiers.length === 0)
  check('>>> con la lista: 5 u → 3.10; 12 u → 2.90 (volumen); el bruto sale del mismo motor', brutoDe(linea(5, datos)) === 15.5 && precioDe(linea(12, datos)).precio === 2.9 && brutoDe(linea(12, datos)) === 34.8)
  check('>>> el borde se mide en cantidad base exacta (11.9999 → plano)', precioDe(linea(11.9999, datos)).fuente === 'LISTA')
  const caja = { id: 'c', name: 'Caja 50', unitType: 'UNIDAD', factor: 50, precio: 45, precioPropio: true }
  check('>>> una caja con precio propio en Base lo conserva (2 cajas = 90.00)', brutoDe(linea(100, { salePrice: 1, baseTiers: [], entrada: null }, { presentacion: caja, ingresada: 2 })) === 90)
  check('>>> con una lista, la caja es unidad base × factor y el precio propio se ignora (0.90 × 100 = 90.00)', brutoDe(linea(100, { salePrice: 1, baseTiers: [], entrada: { price: 0.9, tiers: [] } }, { presentacion: caja, ingresada: 2 })) === 90 && precioDe(linea(100, { salePrice: 1, baseTiers: [], entrada: { price: 0.8, tiers: [] } }, { presentacion: caja, ingresada: 2 })).precio === 0.8)
  check('>>> una caja de 50 se evalúa como 50 unidades base contra los tramos', precioDe(linea(50, datos, { presentacion: { ...caja, precioPropio: false, precio: 175 }, ingresada: 1 })).precio === 2.9)
  const etiq = (l: LineaCarrito) => etiquetaDePrecio(l, 'Mayorista')
  check('>>> la etiqueta dice de dónde salió el precio: nada en Base, la lista, o «Volumen desde N»', etiq(linea(4)) === null && etiq(linea(5, datos)) === 'Lista Mayorista' && etiq(linea(12, datos)) === 'Volumen desde 12')
  const conPct = { ...linea(5, datos), pct: 10, discount: descuentoDe({ ...linea(5, datos), pct: 10 }) }
  check('>>> el descuento en % se calcula sobre el importe de la lista (10 % de 15.50 = 1.55)', conPct.discount === 1.55)
  const sinLista = conPrecios(conPct, { salePrice: 3.5, baseTiers: [], entrada: null })
  check('>>> al cambiar de lista el descuento en % se recalcula sobre el importe nuevo (10 % de 17.50 = 1.75)', sinLista.discount === 1.75 && brutoDe(sinLista) === 17.5)
  check('>>> y un descuento fijo nunca pasa del importe nuevo', conPrecios({ ...linea(5, datos), discount: 20 }, { salePrice: 1, baseTiers: [], entrada: null }).discount === 5)
  check('>>> sin datos nuevos la línea no cambia', conPrecios(conPct, undefined) === conPct)
  check('>>> cambiar la cantidad recalcula el tramo y el descuento: de 5 a 12 u, 10 % de 34.80 = 3.48', (() => { const n = conContada(conPct, 12); return n.quantity === 12 && n.discount === 3.48 && precioDe(n).fuente === 'VOLUMEN' })())

  console.log('\nG) Menú y permisos')
  const enMenu = (r: Role, href: string) => visibleItems([...permisosDe(ctxDe(r))]).some((i) => i.href === href)
  check('>>> «Listas de precio» está en el menú con precios.gestionar', NAV_ITEMS.some((i) => i.href === '/precios' && i.permisos.length === 1 && i.permisos[0] === 'precios.gestionar'))
  check('>>> lo ven dueño y administrador; nadie más', enMenu('OWNER', '/precios') && enMenu('ADMIN', '/precios') && (['CAJERO', 'VENDEDOR', 'ALMACENERO', 'CONTADOR'] as Role[]).every((r) => !enMenu(r, '/precios')))
  check('>>> está activo en /precios y /precios/x, y no enciende otros', isActive('/precios', '/precios') && isActive('/precios', '/precios/abc') && !isActive('/inventario', '/precios'))

  console.log('\nH) Acciones de servidor: validan ANTES de la sesión')
  const v = async (f: () => Promise<{ ok: boolean; code?: string }>) => { const r = await f(); return !r.ok && r.code === 'VALIDATION' }
  check('>>> crear lista con nombre corto o código con espacios → VALIDATION', await v(() => crearListaAccion({ name: 'A' })) && await v(() => crearListaAccion({ name: 'Buena', code: 'a b' })) && await v(() => crearListaAccion(null)))
  check('>>> editar sin cambios, dar de baja sin id → VALIDATION', await v(() => editarListaAccion({ priceListId: 'l1' })) && await v(() => darDeBajaListaAccion({})))
  check('>>> guardar precios con lote vacío, negativo o sin nada que cambiar → VALIDATION', await v(() => guardarPreciosAccion({ priceListId: null, cambios: [] })) && await v(() => guardarPreciosAccion({ priceListId: 'l', cambios: [{ productId: 'p', price: -1 }] })) && await v(() => guardarPreciosAccion({ priceListId: 'l', cambios: [{ productId: 'p' }] })))
  check('>>> asignar lista sin cliente → VALIDATION', await v(() => asignarListaClienteAccion({ priceListId: null })))
  check('>>> refrescar los precios del carrito sin productos, o con más de 200 → VALIDATION', await v(() => preciosParaLista({ priceListId: null, productIds: [] })) && await v(() => preciosParaLista({ priceListId: null, productIds: Array.from({ length: 201 }, (_, i) => `p${i}`) })))

  console.log('\nI) Las páginas y el POS, leídos como código')
  const pPrecios = codigo('src/app/(dashboard)/precios/page.tsx'), pLista = codigo('src/app/(dashboard)/precios/[id]/page.tsx'), pCli = codigo('src/app/(dashboard)/clientes/[id]/page.tsx'), pPos = codigo('src/app/(dashboard)/pos/page.tsx')
  const term = codigo('src/features/pos/components/PosTerminal.tsx')
  check('>>> las dos pantallas de precios se guardan con precios.gestionar (404 sin él)', /puede\(ctx, 'precios\.gestionar'\)\) notFound\(\)/.test(pPrecios) && /puede\(ctx, 'precios\.gestionar'\)\) notFound\(\)/.test(pLista))
  check('>>> un id de lista que no existe o es de otro negocio es 404', /if \(!esBase && !lista\) notFound\(\)/.test(pLista))
  check('>>> ninguna página ni componente de precios nombra costPrice ni unitCost (el costo solo sale del servicio, con ver_costo)', !/costPrice|unitCost/.test(pPrecios + pLista + codigo('src/features/precios/components/PreciosGrid.tsx') + codigo('src/features/precios/components/ListasPrecio.tsx')))
  check('>>> la ficha del cliente deja editar la lista solo con precios.gestionar', /editable=\{puede\(ctx, 'precios\.gestionar'\) && ficha\.activo\}/.test(pCli))
  check('>>> el POS recibe las listas activas', /listasParaVender\(db\)/.test(pPos) && /listasPrecio=\{listasPrecio\}/.test(pPos))
  check('>>> >>> el POS manda SIEMPRE la lista elegida y el total que mostró al cobrar', /priceListId: lista,\s*\n\s*totalEsperado: totales\.total/.test(term))
  check('>>> y la lista también al cotizar y al mandar a caja', cuenta(term, /priceListId: lista,/g) === 3)
  check('>>> las búsquedas piden los datos de precio de la lista elegida (siempre con la referencia más reciente)', /lookupForPos\(\{ code, priceListId: listaRef\.current \}\)/.test(term) && cuenta(term, /searchForPos\(texto, listaRef\.current\)/g) === 2 && /lookupForPos\(\{ code: texto, priceListId: listaRef\.current \}\)/.test(term))
  check('>>> un cliente con lista por defecto la aplica sola, y PRICE_CHANGED refresca los precios', /elegirCliente/.test(term) && /onChange=\{elegirCliente\}/.test(term) && /PRICE_CHANGED/.test(term))
  const acc = codigo('src/features/pos/actions.ts')
  check('>>> la búsqueda por código y la búsqueda por texto devuelven los datos de precio de la lista elegida', /cargarDatosDePrecio\(db, \[product\.id\], parsed\.data\.priceListId \?\? null\)/.test(acc) && /\.\.\.\(precios \? \{ precios \} : \{\}\)/.test(acc) && /cargarDatosDePrecio\(db, resultados\.map\(\(p\) => p\.productId\), lista\.data\)/.test(acc))
  check('>>> un pedido tomado no cambia de lista (precios congelados)', /if \(pedidoRef\.current\) return\s*\n\s*setLista\(nueva\)/.test(term))
  check('>>> tras cobrar, cotizar o mandar a caja el carrito vuelve a la lista Base (el siguiente cliente no hereda la del anterior)', cuenta(term, /setLista\(null\); listaRef\.current = null/g) === 3)
  check('>>> el servidor nunca recibe precios del carrito (itemDe no manda precio)', !/unitPrice|salePrice/.test(codigo('src/features/pos/carrito.ts').slice(codigo('src/features/pos/carrito.ts').indexOf('export const itemDe'), codigo('src/features/pos/carrito.ts').indexOf('export const itemDe') + 400)))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

main().then((f) => process.exit(f === 0 ? 0 : 1)).catch((e) => { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? e.message.slice(0, 200) : e}`, false); process.exit(1) })
