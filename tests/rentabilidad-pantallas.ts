import { existsSync, readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { permisosDe } from '../src/lib/puede'
import { analisisAbc, inventarioValorizado, margenPorProducto, type FilaStock, type LineaVentaCosto } from '../src/features/reportes/rentabilidad-calculo'
import { csvAbc, csvInventario, csvMargen } from '../src/features/reportes/rentabilidad-csv'
import { parametrosCostosSchema, type ParametrosCostos } from '../src/features/reportes/schemas'
import { SelectorPeriodo } from '../src/features/reportes/components/SelectorPeriodo'
import { BarraDescargaCostos, PestanasCostos, TablaAbc, TablaInventario, TablaMargen } from '../src/features/reportes/components/TablasRentabilidad'
import { enlaceCsvRentabilidad, enlaceRentabilidad } from '../src/features/reportes/urls'
import { visibleItems } from '../src/features/shell/nav-items'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F5.3 · Las pantallas de rentabilidad, renderizadas AISLADAS. Lo que más importa: la cobertura de costo se VE (aviso con el porcentaje cuando
 * falta costo), un producto sin costo no muestra margen, la pantalla y el CSV dicen lo mismo, y menú, página y descarga deciden con
 * `productos.ver_costo`.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const etiqueta = (h: string, marca: string): string => { const i = h.indexOf(marca); if (i < 0) return ''; const a = h.lastIndexOf('<', i); return h.slice(a, h.indexOf('>', i) + 1) }
const P = (o: Partial<ParametrosCostos> = {}): ParametrosCostos => parametrosCostosSchema.parse(o)
const ctxDe = (r: Role, extra: Partial<TenantContext> = {}): TenantContext => ({ tenantId: 't', userId: 'u', role: r, access: 'FULL', branchId: 'b', permisosExtra: [], ...extra })
const L = (productId: string, o: Partial<LineaVentaCosto> = {}): LineaVentaCosto => ({ productId, nombre: `Prod ${productId}`, sku: `S-${productId}`, unidad: 'UNIDAD', cantidad: 1, costoUnitario: 0, totalConIgv: 118, tasaIgv: 0.18, ...o })
const S = (productId: string, almacenId: string, cantidad: number, costoUnitario: number): FilaStock => ({ productId, nombre: `Prod ${productId}`, sku: `S-${productId}`, unidad: 'UNIDAD', eliminado: false, almacenId, almacen: `Alm ${almacenId}`, cantidad, costoUnitario })

const parcial = margenPorProducto([L('a', { costoUnitario: 60 }), L('b'), L('b')])
const completo = margenPorProducto([L('a', { costoUnitario: 60 })])
const sinNada = margenPorProducto([])

console.log('\nA) Margen: la cobertura se ve')
const hp = html(createElement(TablaMargen, { r: parcial }))
check('>>> con costos faltantes aparece el AVISO con el porcentaje real (33.3 %), las cifras y el enlace para completarlos', /role="alert"[^>]*data-cobertura="parcial"|data-cobertura="parcial"[^>]*role="alert"/.test(hp) && hp.includes('33.3 %') && hp.includes('S/ 100.00 de S/ 300.00') && hp.includes('S/ 200.00 vendidos sin costo') && hp.includes('href="/costos"'))
check('>>> el aviso dice que el margen se calcula SOLO sobre esa parte (no un 100 % inventado)', hp.includes('ÚNICAMENTE') && hp.includes('no entran'))
check('>>> el producto sin costo muestra «— sin costo», no un porcentaje', etiqueta(hp, 'data-fila="b"') !== '' && /data-margen="sin"/.test(hp) && !/data-fila="b"[\s\S]{0,900}100\.0 %[\s\S]{0,40}<\/td><td[^>]*>100\.0/.test(hp))
check('con todo cubierto: mensaje verde de cobertura completa y sin aviso de alerta', html(createElement(TablaMargen, { r: completo })).includes('data-cobertura="completa"') && !html(createElement(TablaMargen, { r: completo })).includes('data-cobertura="parcial"'))
check('>>> «Vendido sin costo» lista los productos pendientes', hp.includes('data-reporte="sin-costo"') && hp.includes('Vendido sin costo (1 producto)'))
const hv = html(createElement(TablaMargen, { r: sinNada }))
check('sin ventas: mensaje de vacío, sin aviso ni cobertura «100 %» falsa', hv.includes('data-reporte="vacio"') && !hv.includes('data-cobertura') && !hv.includes('100.0 %'))
check('la fila de total existe y suma la venta (S/ 300.00)', hp.includes('data-reporte-total') && hp.includes('S/ 300.00'))
const parcialCsv = csvMargen(parcial)
check('>>> pantalla y CSV coinciden: la misma cantidad de productos y el margen vacío del que no tiene costo', parcialCsv.filas.length - 1 === parcial.filas.length && parcialCsv.filas.some((f) => String(f[0]).includes('Prod b') && f.includes('')))

console.log('\nB) Inventario')
const inv = inventarioValorizado([S('a', 'w1', 10, 2), S('b', 'w1', 3, 0), S('c', 'w1', -2, 5)])
const hi = html(createElement(TablaInventario, { r: inv, fecha: '2026-10-26' }))
check('>>> aviso de productos con stock y sin costo: dice que el valor es MENOR que el real y enlaza a /costos', hi.includes('data-inventario="sin-costo"') && hi.includes('es MENOR que el real') && hi.includes('href="/costos"'))
check('>>> la fila sin costo dice «sin costo», no S/ 0.00', hi.includes('data-inventario="fila-sin-costo"') && !/data-fila="b"[\s\S]*?S\/ 0\.00[\s\S]*?<\/tr>/.test(hi.split('data-fila="c"')[0] ?? ''))
check('el saldo negativo se avisa', hi.includes('data-inventario="negativos"'))
check('el total valorizado (S/ 20.00) y el resumen por almacén aparecen', hi.includes('S/ 20.00') && hi.includes('data-reporte="almacenes"'))
check('la fecha del inventario se dice en la pantalla', hi.includes('26/10'))
check('>>> pantalla y CSV: mismo total valorizado', csvInventario(inv).filas.some((f) => String(f[0]).startsWith('TOTAL') && JSON.stringify(f[5]) === '{"monto":20}') && csvInventario(inv).filas.some((f) => f[0] === 'Prod b' && f[4] === '' && f[5] === ''))
check('sin stock: mensaje de vacío', html(createElement(TablaInventario, { r: inventarioValorizado([]), fecha: '2026-10-26' })).includes('data-reporte="vacio"'))

console.log('\nC) ABC')
const abcR = (base: 'VENTAS' | 'UTILIDAD', sinClasificar = 0) => ({ ...analisisAbc([{ id: 'a', nombre: 'Prod a', sku: 'S-a', valor: 70 }, { id: 'b', nombre: 'Prod b', sku: 'S-b', valor: 30 }]), base, sinClasificar, cobertura: 60 })
const ha = html(createElement(TablaAbc, { r: abcR('VENTAS') }))
check('tabla de resumen por clase (A, B, C) y tabla por producto con su clase', ['A', 'B', 'C'].every((c) => ha.includes(`data-clase="${c}"`)) && ha.includes('data-reporte="abc"') && ha.includes('data-fila="a"'))
check('explica la regla de los umbrales (80 % / 95 %)', ha.includes('hasta el 80 %') && ha.includes('hasta el 95 %'))
check('>>> por ventas no habla de cobertura de costo', !ha.includes('data-abc="cobertura"'))
const hu = html(createElement(TablaAbc, { r: abcR('UTILIDAD', 2) }))
check('>>> por utilidad con productos sin costo: aviso con el conteo, la cobertura y que NO se mandan a C', hu.includes('data-abc="cobertura"') && hu.includes('2 productos vendidos no tienen costo') && hu.includes('60.0 %') && hu.includes('no se mandan a C'))
check('por utilidad con todo cubierto: mensaje de que todos están clasificados', html(createElement(TablaAbc, { r: abcR('UTILIDAD', 0) })).includes('Todos los productos vendidos tienen costo'))
check('pantalla y CSV: mismas filas', csvAbc(abcR('VENTAS'), 'VENTAS').filas.length >= 2)

console.log('\nD) Pestañas, selector y descarga')
const pest = html(createElement(PestanasCostos, { activa: 'abc', params: P({ p: 'MES_PASADO', base: 'UTILIDAD' }) }))
check('>>> tres pestañas; la activa marcada; los enlaces conservan periodo y base; margen sin «t»', ['margen', 'inventario', 'abc'].every((t) => pest.includes(`data-pestana="${t}"`)) && etiqueta(pest, 'data-pestana="abc"').includes('aria-current="page"') && etiqueta(pest, 'data-pestana="inventario"').includes('href="/reportes/rentabilidad?p=MES_PASADO&amp;base=UTILIDAD&amp;t=inventario"') !== undefined && etiqueta(pest, 'data-pestana="margen"').includes('href="/reportes/rentabilidad?p=MES_PASADO&amp;base=UTILIDAD"'))
check('enlace por defecto limpio y CSV por tipo', enlaceRentabilidad('margen', P()) === '/reportes/rentabilidad' && enlaceCsvRentabilidad('abc', P({ a: 70, b: 90 })) === '/api/reportes/rentabilidad/abc?a=70&b=90')
const sel = html(createElement(SelectorPeriodo, { tab: 'abc', params: P({ p: 'SEMANA' }), accion: '/reportes/rentabilidad', pestanaInicial: 'margen' }))
check('>>> el selector vuelve a /reportes/rentabilidad, conserva la pestaña y no mete «agrupar»/«atribuir»', /action="\/reportes\/rentabilidad"/.test(sel) && sel.includes('name="t" value="abc"'))
check('el selector de ventas sigue igual (acción por defecto)', html(createElement(SelectorPeriodo, { tab: 'periodo', params: parametrosCostosSchema.parse({}) })).includes('action="/reportes/ventas"'))
const bd = html(createElement(BarraDescargaCostos, { tipo: 'margen', params: P(), texto: 'Octubre' }))
check('la barra de descarga enlaza al CSV del mismo reporte', bd.includes('href="/api/reportes/rentabilidad/margen"') && bd.includes('download'))

console.log('\nE) Páginas, ruta y menú')
const D = 'src/app/(dashboard)/reportes'
const pag = readFileSync(`${D}/rentabilidad/page.tsx`, 'utf8'), hub = readFileSync(`${D}/page.tsx`, 'utf8'), ruta = readFileSync('src/app/api/reportes/rentabilidad/[tipo]/route.ts', 'utf8')
const nav = readFileSync('src/features/shell/nav-items.ts', 'utf8')
check("la página exige sesión y `productos.ver_costo` SOLO (404 si no); no mira el rol ni pide `reportes.ver`", pag.includes('await requireTenantContext()') && pag.includes("if (!puede(ctx, 'productos.ver_costo')) notFound()") && !/ctx\.role|reportes\.ver/.test(pag))
check('la página lee con el cliente aislado por negocio y sucursal', pag.includes('getTenantPrisma(ctx)') && !/from '@\/lib\/prisma'/.test(pag))
check('>>> una dirección manipulada vuelve al periodo por defecto con un aviso (periodo, rango imposible y umbrales)', pag.includes('parametrosCostosSchema.safeParse(') && pag.includes('Esa dirección tenía un periodo que no entiendo') && pag.includes('Esos umbrales no sirven') && pag.includes("e.code === 'INVALID_DOCUMENT'"))
check('la pestaña inventada cae en margen', pag.includes("(TIPOS_REPORTE_COSTOS as readonly string[]).includes(sp.t ?? '') ? (sp.t as TipoReporteCostos) : 'margen'"))
check('el inventario no muestra el selector de periodo (es de hoy)', pag.includes("tab !== 'inventario' && <SelectorPeriodo"))
check('>>> la ruta CSV: 401, 404, 400, 403, cabeceras de `respuestaCsv`, sin lógica de permisos propia', ruta.includes('status: 401') && ruta.includes('status: 404') && ruta.includes('status: 400') && ruta.includes("e.code === 'FORBIDDEN_ROLE' ? 403 : 400") && ruta.includes('respuestaCsv(archivo)') && !/puede\(|exigir\(|ctx\.role/.test(ruta) && ruta.includes("export const dynamic = 'force-dynamic'"))
const enMenu = (c: TenantContext) => visibleItems([...permisosDe(c)]).some((i) => i.href === '/reportes')
check('>>> el menú muestra Reportes a dueño, administrador y contador; no a cajero, vendedor ni almacenero', enMenu(ctxDe('OWNER')) && enMenu(ctxDe('ADMIN')) && enMenu(ctxDe('CONTADOR')) && !enMenu(ctxDe('CAJERO')) && !enMenu(ctxDe('VENDEDOR')) && !enMenu(ctxDe('ALMACENERO')))
check('>>> quien solo tiene `productos.ver_costo` ve el menú (y entra a rentabilidad); quien solo tiene `reportes.ver` también (ventas)', enMenu(ctxDe('CAJERO', { permisosExtra: ['productos.ver_costo'] })) && enMenu(ctxDe('CAJERO', { permisosExtra: ['reportes.ver'] })))
check('el centro enseña cada tarjeta con su propio permiso: ventas = reportes.ver; rentabilidad = productos.ver_costo', hub.includes('{verVentas && <li>') && hub.includes('{verRentabilidad && <li>') && hub.includes("const verRentabilidad = puede(ctx, 'productos.ver_costo')") && hub.includes('data-reporte-tarjeta="rentabilidad"'))
check('el menú usa los dos permisos (solo visibilidad)', nav.includes("permisos: ['reportes.ver', 'productos.ver_costo']"))
check('hay pantalla de carga', existsSync(`${D}/rentabilidad/loading.tsx`))
check('>>> el servicio exige `productos.ver_costo` en cada informe y la exportación, y nada más', (() => { const s = readFileSync('src/features/reportes/rentabilidad-service.ts', 'utf8'); return s.includes("exigir(ctx, 'productos.ver_costo')") && !s.includes('reportes.ver') && (s.match(/exigirCostos\(ctx\)/g) ?? []).length >= 2 })())

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
