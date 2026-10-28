import { existsSync, readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ReposicionReporte } from '../src/features/inventory/components/ReposicionReporte'
import { UmbralesGrid } from '../src/features/inventory/components/UmbralesGrid'
import { UmbralesImport } from '../src/features/inventory/components/UmbralesImport'
import { analizarUmbralesCsvAccion, guardarUmbralesAccion } from '../src/features/inventory/reposicion-actions'
import { cantidadAPedir, agruparPorProveedor } from '../src/features/inventory/reposicion-pedido'
import type { LineaReposicion, ReporteReposicion } from '../src/features/inventory/reposicion-reporte'
import type { FilaUmbral } from '../src/features/inventory/umbrales-service'
import { visibleItems, isActive, NAV_ITEMS } from '../src/features/shell/nav-items'
import { permisosDe } from '../src/lib/puede'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.6b · Las pantallas de reposición, renderizadas AISLADAS: el reporte agrupado (con y sin costos), la cuadrícula de mínimos y máximos, la importación por CSV, el menú, las acciones de
 * servidor (validación antes de la sesión) y las páginas leídas como código. Lo que más importa: sin costos no existe ni una cifra de dinero en el HTML, y cada pantalla se guarda con su permiso.
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

const caja12 = { id: 'pr', name: 'Caja', unitType: 'UNIDAD', factor: 12 }
const linea = (o: Partial<LineaReposicion> & { sku: string; supplierId: string | null }): LineaReposicion => ({
  clave: `w1:${o.sku}:-`, productId: `id-${o.sku}`, variantId: null, warehouseId: 'w1', almacen: 'Norte', nombre: `Producto ${o.sku}`, unitType: 'UNIDAD', estado: 'LOW',
  cantidad: 4, reservado: 0, disponible: 4, enTransito: 0, posicion: 4, minimo: 10, maximo: null, objetivo: 20, sugerida: 14, pedir: cantidadAPedir(14, 'UNIDAD', caja12), bajoPedidoNegativo: false, ...o,
})
const reporteDe = (lineas: LineaReposicion[], conCostos: boolean): ReporteReposicion => {
  const grupos = agruparPorProveedor(lineas, new Map([['s1', 'Aceros SAC']]))
  return {
    grupos: conCostos ? grupos.map((g) => ({ ...g, valorEstimado: 120, sinCosto: 0 })) : grupos, totalLineas: lineas.length, omitidosBajoPedido: 2,
    almacenes: [{ id: 'w1', name: 'Norte' }], warehouseId: null, verCostos: conCostos, ...(conCostos ? { valorEstimado: 120, sinCosto: 0 } : {}),
  }
}

async function main() {
console.log('\nA) El reporte')
const lineas = [linea({ sku: 'A1', supplierId: 's1', valorEstimado: 120, costoUnitario: 5 }), linea({ sku: 'B1', supplierId: null, estado: 'OUT', posicion: -2, disponible: -2, bajoPedidoNegativo: true, sugerida: 2, pedir: cantidadAPedir(2, 'UNIDAD') })]
const conCosto = html(createElement(ReposicionReporte, { reporte: reporteDe(lineas, true), verKardex: true }))
const sinCosto = html(createElement(ReposicionReporte, { reporte: reporteDe(lineas.map(({ valorEstimado: _v, costoUnitario: _c, ...resto }) => resto as LineaReposicion), false), verKardex: false }))
check('>>> un bloque por proveedor y «Otros / Sin proveedor» al final', cuenta(conCosto, /data-reposicion="grupo"/g) === 2 && conCosto.indexOf('Aceros SAC') < conCosto.indexOf('Otros / Sin proveedor'))
check('>>> >>> lo que se pide va redondeado: «2 × Caja de 12 (24 u)»', /2 × Caja de 12 \(24 /.test(conCosto))
check('>>> muestra disponible, en camino, posición, mínimo/objetivo y sugerida', ['Disponible', 'En camino', 'Posición', 'Mín / Obj.', 'Sugerida'].every((c) => conCosto.includes(c)))
check('>>> con costos: valor del grupo y total', conCosto.includes('data-reposicion="valor-grupo"') && conCosto.includes('data-reposicion="valor-total"') && /120[.,]00/.test(conCosto.replace(/ /g, ' ')))
check('>>> >>> sin costos: NI UNA cifra de dinero, ni columna de valor, ni «sin costo»', !/S\/|valor|Valor/.test(sinCosto.replace('Valor estimado', '')) && !sinCosto.includes('data-reposicion="valor') && !/sin costo/.test(sinCosto), sinCosto.match(/S\/[^<]{0,12}/)?.[0])
check('>>> lo vendido sin existencias se marca', conCosto.includes('vendido sin existencias'))
check('>>> aviso de lo que se trabaja contra pedido', /2 productos se trabajan contra pedido/.test(conCosto))
check('>>> el enlace al kardex solo si puede verlo', conCosto.includes('data-producto="kardex"') && !sinCosto.includes('data-producto="kardex"'))
check('>>> sin nada que reponer lo dice con calma', html(createElement(ReposicionReporte, { reporte: { ...reporteDe([], false), grupos: [], totalLineas: 0 } })).includes('Nada que reponer'))
check('>>> la nota explica la fórmula y que los borradores no cuentan', /Posición = disponible/.test(conCosto) && /borradores de compra no cuentan/.test(conCosto))

console.log('\nB) La cuadrícula')
const fila = (o: Partial<FilaUmbral>): FilaUmbral => ({ productId: 'p1', variantId: null, warehouseId: 'w1', nombre: 'Cemento Sol', sku: 'CEM', unitType: 'UNIDAD', cantidad: 8, almacenMin: null, almacenMax: null, minimo: 10, maximo: null, origenMinimo: 'PRODUCTO', origenMaximo: null, ...o })
const grid = seguro(() => html(createElement(UmbralesGrid, { filas: [fila({}), fila({ productId: 'p2', variantId: 'v1', nombre: 'Tubo 1/2', sku: 'TUB', almacenMin: 3, almacenMax: 12, minimo: 3, maximo: 12, origenMinimo: 'ALMACEN', origenMaximo: 'ALMACEN' })] })), '')
check('>>> una fila por producto/variante con sus dos campos', cuenta(grid, /data-fila=/g) === 2 && cuenta(grid, /data-campo="min"/g) === 2 && cuenta(grid, /data-campo="max"/g) === 2)
check('>>> lo heredado se ve como sugerencia gris (placeholder) y de dónde viene', /placeholder="10"/.test(grid) && /el producto/.test(grid) && /este almacén/.test(grid))
check('>>> lo propio del almacén se ve como valor', /value="3"/.test(grid) && /value="12"/.test(grid))
check('>>> sin máximo avisa del objetivo por defecto', /sin máximo \(objetivo 2 × mín\)/.test(grid))
check('>>> «Guardar» empieza deshabilitado (no hay cambios)', /data-umbrales="guardar"[^>]*disabled=""/.test(grid) || /disabled=""[^>]*data-umbrales="guardar"/.test(grid))
check('>>> cada campo tiene etiqueta accesible', /aria-label="Mínimo de Cemento Sol"/.test(grid) && /aria-label="Máximo de Tubo 1\/2"/.test(grid))
check('>>> sin filas: mensaje vacío', seguro(() => html(createElement(UmbralesGrid, { filas: [] })), '').includes('data-umbrales="vacio"'))

console.log('\nC) La importación por CSV')
const imp = seguro(() => html(createElement(UmbralesImport)), '')
check('>>> explica las columnas y el significado de vacío y «-»', /sku/.test(imp) && /almacen/.test(imp) && /minimo/.test(imp) && /maximo/.test(imp) && /guion/.test(imp))
check('>>> hay un selector de archivo CSV con etiqueta', /type="file"/.test(imp) && /accept="\.csv,text\/csv"/.test(imp) && /aria-label="Archivo CSV/.test(imp))
check('>>> aún no ofrece aplicar (primero se analiza)', !imp.includes('data-umbrales="aplicar"'))

console.log('\nD) Menú y permisos')
const enMenu = (r: Role, href: string) => visibleItems([...permisosDe(ctxDe(r))]).some((i) => i.href === href)
check('>>> «Reposición sugerida» está en el menú, con reposicion.ver', NAV_ITEMS.some((i) => i.href === '/inventario/reposicion' && i.permisos.length === 1 && i.permisos[0] === 'reposicion.ver'))
check('>>> lo ven dueño, administrador, almacenero y contador; no cajero ni vendedor', (['OWNER', 'ADMIN', 'ALMACENERO', 'CONTADOR'] as Role[]).every((r) => enMenu(r, '/inventario/reposicion')) && !enMenu('CAJERO', '/inventario/reposicion') && !enMenu('VENDEDOR', '/inventario/reposicion'))
check('>>> está activo en su ruta y en la de mínimos, y no enciende a «Inventario»', isActive('/inventario/reposicion', '/inventario/reposicion') && isActive('/inventario/reposicion', '/inventario/reposicion/umbrales') && !isActive('/inventario', '/inventario/reposicion'))

console.log('\nE) Acciones de servidor: validan ANTES de la sesión')
const v = async (f: () => Promise<{ ok: boolean; code?: string }>) => { const r = await f(); return !r.ok && r.code === 'VALIDATION' }
check('>>> guardar con un lote vacío o mal formado → VALIDATION', await v(() => guardarUmbralesAccion({ cambios: [] })) && await v(() => guardarUmbralesAccion({ cambios: [{ nivel: 'ALMACEN', productId: 'p', minimo: 1 }] })) && await v(() => guardarUmbralesAccion(null)))
check('>>> mínimo negativo o máximo menor que el mínimo → VALIDATION', await v(() => guardarUmbralesAccion({ cambios: [{ nivel: 'PRODUCTO', productId: 'p', minimo: -1 }] })) && await v(() => guardarUmbralesAccion({ cambios: [{ nivel: 'PRODUCTO', productId: 'p', minimo: 5, maximo: 2 }] })))
check('>>> analizar un archivo vacío → VALIDATION', await v(() => analizarUmbralesCsvAccion({ contenido: '' })) && await v(() => analizarUmbralesCsvAccion({})))

console.log('\nF) Las páginas, leídas como código')
const rep = codigo('src/app/(dashboard)/inventario/reposicion/page.tsx')
const umb = codigo('src/app/(dashboard)/inventario/reposicion/umbrales/page.tsx')
check('>>> el reporte se guarda con reposicion.ver (404 si no)', /puede\(ctx, 'reposicion\.ver'\)\) notFound\(\)/.test(rep))
check('>>> la cuadrícula se guarda con reposicion.configurar (404 si no)', /puede\(ctx, 'reposicion\.configurar'\)\) notFound\(\)/.test(umb))
check('>>> el enlace a los mínimos solo se ofrece a quien puede configurar', /puede\(ctx, 'reposicion\.configurar'\) && <Link href="\/inventario\/reposicion\/umbrales"/.test(rep))
check('>>> ninguna página nombra costPrice ni unitCost: los costos solo salen del servicio', !/costPrice|unitCost/.test(rep + umb))
check('>>> la página de alertas ofrece el reporte a quien puede verlo', /puede\(ctx, 'reposicion\.ver'\) && <Link href="\/inventario\/reposicion"/.test(codigo('src/app/(dashboard)/inventario/alertas/page.tsx')))
check('>>> el reporte se vuelve a comprobar en el servicio (no solo en la página)', /exigir\(ctx, 'reposicion\.ver'\)/.test(codigo('src/features/inventory/reposicion-reporte.ts')) && /exigir\(ctx, 'reposicion\.configurar'\)/.test(codigo('src/features/inventory/umbrales-service.ts')))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
return fail
}

main().then((f) => process.exit(f === 0 ? 0 : 1))
