import { existsSync, readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { generarCsv } from '../src/lib/csv-export'
import { permisosDe } from '../src/lib/puede'
import { gruposDelPeriodo, resolverPeriodo } from '../src/features/reportes/periodo'
import { parametrosVentasSchema, type ParametrosVentas } from '../src/features/reportes/schemas'
import { cobrosPorMedio, ventasPorMedio, ventasPorPeriodo, ventasPorVendedor, type VentaFila } from '../src/features/reportes/ventas-calculo'
import { csvCobros, csvVentasPorMedio, csvVentasPorPeriodo, csvVentasPorVendedor } from '../src/features/reportes/ventas-csv'
import { SelectorPeriodo } from '../src/features/reportes/components/SelectorPeriodo'
import { BarraDescarga, PestanasVentas, TablaCobros, TablaPorMedio, TablaPorPeriodo, TablaPorVendedor } from '../src/features/reportes/components/TablasVentas'
import { visibleItems } from '../src/features/shell/nav-items'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F5.1/F5.2 · Las pantallas de reportes, renderizadas AISLADAS (sin navegador ni base). Lo que más importa: lo que se ve en pantalla es lo
 * que baja en el CSV, el selector y las pestañas conservan el periodo, un periodo manipulado no rompe la página, y el menú, la página y la
 * descarga deciden con el MISMO permiso (`reportes.ver`: dueño, administrador y contador; ni cajero, ni vendedor, ni almacenero).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const etiqueta = (h: string, marca: string): string => { const i = h.indexOf(marca); if (i < 0) return ''; const a = h.lastIndexOf('<', i); return h.slice(a, h.indexOf('>', i) + 1) }
const P = (o: Partial<ParametrosVentas> = {}): ParametrosVentas => parametrosVentasSchema.parse(o)
const ctxDe = (r: Role): TenantContext => ({ tenantId: 't', userId: 'u', role: r, access: 'FULL', branchId: 'b', permisosExtra: [] })

const LIMA = 'America/Lima'
const per = resolverPeriodo({ preset: 'RANGO', desde: '2026-10-24', hasta: '2026-10-26' }, new Date('2026-12-01T12:00:00Z'), LIMA)
const venta = (id: string, total: number, o: Partial<VentaFila> = {}): VentaFila => ({
  id, numero: id, completedAt: new Date('2026-10-25T15:00:00Z'), total, igv: 0, descuentos: 0, vendedorId: 'a', cobroId: 'a', pagos: [{ metodo: 'EFECTIVO', monto: total, vuelto: 0 }], ...o,
})
const ventas = [
  venta('1', 118, { igv: 18, vendedorId: 'ana', cobroId: 'beto', pagos: [{ metodo: 'EFECTIVO', monto: 120, vuelto: 2 }] }),
  venta('2', 50, { vendedorId: 'beto', cobroId: 'beto', completedAt: new Date('2026-10-26T15:00:00Z'), pagos: [{ metodo: 'YAPE', monto: 50, vuelto: 0 }] }),
  venta('3', 200, { vendedorId: 'ana', cobroId: 'ana', descuentos: 10, pagos: [{ metodo: 'EFECTIVO', monto: 50, vuelto: 0 }, { metodo: 'CREDITO', monto: 150, vuelto: 0 }] }),
]
const nombres = new Map([['ana', 'Ana'], ['beto', 'Beto']])
const rPer = ventasPorPeriodo(ventas, 'dia', LIMA, gruposDelPeriodo(per, 'dia'))
const rVen = ventasPorVendedor(ventas, 'VENDEDOR', nombres)
const rMed = ventasPorMedio(ventas)
const rCob = cobrosPorMedio(ventas.flatMap((v) => v.pagos), [{ metodo: 'TRANSFERENCIA', monto: 100 }])

console.log('\nA) Selector de periodo')
const sel = (tab: 'periodo' | 'vendedor' | 'medios' | 'cobros', p: Partial<ParametrosVentas> = {}) => html(createElement(SelectorPeriodo, { tab, params: P(p) }))
const hs = sel('periodo', { p: 'SEMANA' })
check('>>> es un formulario de dirección (GET) hacia /reportes/ventas: se puede compartir el enlace y no necesita JavaScript', /<form[^>]*action="\/reportes\/ventas"[^>]*method="get"|<form[^>]*method="get"[^>]*action="\/reportes\/ventas"/.test(hs) && !readFileSync('src/features/reportes/components/SelectorPeriodo.tsx', 'utf8').includes("'use client'"))
check('trae los 8 periodos en español y deja marcado el elegido', ['Hoy', 'Ayer', 'Esta semana', 'Semana pasada', 'Este mes', 'Mes pasado', 'Últimos 30 días', 'Rango de fechas'].every((t) => hs.includes(`>${t}</option>`)) && /<option value="SEMANA" selected="">/.test(hs))
check('las dos fechas del rango se conservan', sel('periodo', { p: 'RANGO', desde: '2026-10-01', hasta: '2026-10-05' }).includes('value="2026-10-01"') && sel('periodo', { p: 'RANGO', desde: '2026-10-01', hasta: '2026-10-05' }).includes('value="2026-10-05"'))
check('>>> «Agrupar por» solo en la pestaña por periodo; «Atribuir a» solo en la de vendedor', hs.includes('name="agrupar"') && !hs.includes('name="atrib"') && sel('vendedor').includes('name="atrib"') && !sel('vendedor').includes('name="agrupar"') && !sel('medios').includes('name="agrupar"') && !sel('cobros').includes('name="atrib"'))
check('>>> al cambiar de periodo desde otra pestaña, la pestaña se conserva (campo oculto t)', sel('vendedor').includes('name="t" value="vendedor"') && sel('cobros').includes('name="t" value="cobros"') && !hs.includes('name="t"'))
check('la atribución elegida queda marcada', /<option value="COBRO" selected="">/.test(sel('vendedor', { atrib: 'COBRO' })))

console.log('\nB) Pestañas y descarga')
const pest = html(createElement(PestanasVentas, { activa: 'vendedor', params: P({ p: 'MES_PASADO', atrib: 'COBRO' }) }))
check('>>> cuatro pestañas; la activa está marcada; cada enlace conserva el periodo y la atribución', ['periodo', 'vendedor', 'medios', 'cobros'].every((t) => pest.includes(`data-pestana="${t}"`)) && etiqueta(pest, 'data-pestana="vendedor"').includes('aria-current="page"') && !etiqueta(pest, 'data-pestana="medios"').includes('aria-current') && etiqueta(pest, 'data-pestana="medios"').includes('href="/reportes/ventas?t=medios&amp;p=MES_PASADO&amp;atrib=COBRO"'))
check('la pestaña por periodo apunta a la dirección sin «t»', etiqueta(pest, 'data-pestana="periodo"').includes('href="/reportes/ventas?p=MES_PASADO&amp;atrib=COBRO"'))
const barra = html(createElement(BarraDescarga, { tipo: 'cobros', params: P({ p: 'SEMANA' }), textoPeriodo: '19/10/2026 – 26/10/2026' }))
check('>>> «Descargar CSV» va a la ruta de la API con el mismo periodo y descarga el archivo; el periodo se lee en pantalla', etiqueta(barra, 'data-enlace="csv"').includes('href="/api/reportes/ventas/cobros?p=SEMANA"') && etiqueta(barra, 'data-enlace="csv"').includes('download') && barra.includes('19/10/2026 – 26/10/2026'))

console.log('\nC) Tablas')
const tp = html(createElement(TablaPorPeriodo, { r: rPer }))
check('>>> por periodo: tarjetas (vendido 368.00, 3 ventas, ticket 122.67, IGV 18.00), una fila por día y la fila de totales', tp.includes('S/ 368.00') && tp.includes('122.67') && tp.includes('S/ 18.00') && (tp.match(/data-fila=/g) ?? []).length === 3 && tp.includes('data-reporte-total'))
const filaVacia = tp.slice(tp.indexOf('data-fila="2026-10-24"'), tp.indexOf('</tr>', tp.indexOf('data-fila="2026-10-24"')))
check('>>> un día sin ventas muestra «—» en sus importes (no «S/ 0.00», que parece un dato) y 0 ventas', (filaVacia.match(/—/g) ?? []).length === 4 && !filaVacia.includes('S/ 0.00') && />0<\/td>/.test(filaVacia))
check('>>> sin ventas: el mensaje, no una tabla vacía', html(createElement(TablaPorPeriodo, { r: ventasPorPeriodo([], 'dia', LIMA, gruposDelPeriodo(per, 'dia')) })).includes('data-reporte="vacio"') && !html(createElement(TablaPorPeriodo, { r: ventasPorPeriodo([], 'dia', LIMA, gruposDelPeriodo(per, 'dia')) })).includes('<table'))
const tv = html(createElement(TablaPorVendedor, { r: rVen }))
check('por vendedor: Ana 318.00 (2 ventas), Beto 50.00, participación y la nota de a quién se atribuye', tv.includes('Ana') && tv.includes('S/ 318.00') && tv.includes('86.4 %') && tv.includes('quien armó el pedido'))
check('atribuido a quien cobró: la columna y la nota cambian', html(createElement(TablaPorVendedor, { r: ventasPorVendedor(ventas, 'COBRO', nombres) })).includes('Cobró en caja') && html(createElement(TablaPorVendedor, { r: ventasPorVendedor(ventas, 'COBRO', nombres) })).includes('quien la cobró en caja'))
const tm = html(createElement(TablaPorMedio, { r: rMed }))
check('>>> por medio: efectivo 168.00 (neto de vuelto), el fiado como un medio más, y los dos totales iguales', tm.includes('Efectivo') && tm.includes('S/ 168.00') && tm.includes('Fiado (a crédito)') && tm.includes('Total de los medios') && tm.includes('Total de las ventas') && !tm.includes('data-reporte="descuadre"'))
const desc = html(createElement(TablaPorMedio, { r: ventasPorMedio([venta('x', 100, { pagos: [{ metodo: 'EFECTIVO', monto: 90, vuelto: 0 }] })]) }))
check('>>> si los pagos no suman lo vendido, la pantalla lo AVISA con la diferencia', desc.includes('data-reporte="descuadre"') && desc.includes('S/ 10.00') && desc.includes('1 venta tiene'))
const tc = html(createElement(TablaCobros, { r: rCob }))
check('>>> cobros: lo fiado no aparece, los abonos sí (transferencia 100.00), y la nota explica qué es un cobro', !tc.includes('Fiado') && tc.includes('Transferencia') && tc.includes('S/ 100.00') && tc.includes('no aparece hasta que el cliente abona'))
check('cobros sin movimiento: mensaje', html(createElement(TablaCobros, { r: cobrosPorMedio([], []) })).includes('No hubo cobros'))

console.log('\nD) Lo que se ve es lo que se descarga')
const total = (t: { filas: unknown[][] }) => t.filas.at(-1)!
const montoDe = (c: unknown) => (c as { monto: number }).monto
check('>>> periodo: el total de la pantalla (368.00) = la fila TOTAL del CSV', montoDe(total(csvVentasPorPeriodo(rPer))[2]) === rPer.totales.total && tp.includes(`S/ ${rPer.totales.total.toFixed(2)}`))
check('>>> vendedor, medios y cobros: cada total en pantalla = el del CSV', montoDe(total(csvVentasPorVendedor(rVen))[2]) === rVen.totales.total && montoDe(total(csvVentasPorMedio(rMed))[2]) === rMed.totalVentas && montoDe(total(csvCobros(rCob))[3]) === rCob.totales.total)
check('el mismo reporte genera las mismas filas en pantalla y en CSV (3 días con ventas + sin ventas)', csvVentasPorPeriodo(rPer).filas.length === rPer.filas.length + 1)
const csvTexto = generarCsv(csvVentasPorPeriodo(rPer).cabecera, csvVentasPorPeriodo(rPer).filas)
check('el CSV se abre en Excel es-PE: BOM, «;» y punto decimal', csvTexto.startsWith('﻿') && csvTexto.includes(';368.00;'))

console.log('\nE) Páginas, ruta y menú')
const D = 'src/app/(dashboard)/reportes'
const hub = readFileSync(`${D}/page.tsx`, 'utf8'), pagV = readFileSync(`${D}/ventas/page.tsx`, 'utf8'), ruta = readFileSync('src/app/api/reportes/ventas/[tipo]/route.ts', 'utf8')
check('>>> la página de ventas exige sesión y `reportes.ver` (404 si no); el centro de reportes, al menos uno de los permisos de sus tarjetas, y muestra cada tarjeta solo con el suyo', [hub, pagV].every((s) => s.includes('await requireTenantContext()')) && pagV.includes("if (!puede(ctx, 'reportes.ver')) notFound()") && hub.includes("if (!puedeAlguno(ctx, 'reportes.ver', 'productos.ver_costo')) notFound()") && hub.includes("const verVentas = puede(ctx, 'reportes.ver')") && !/ctx\.role/.test(hub + pagV))
check('>>> una dirección manipulada vuelve al periodo por defecto con un AVISO (no un error): parámetros inválidos y rango imposible', pagV.includes('parametrosVentasSchema.safeParse(') && pagV.includes('Esa dirección tenía un periodo que no entiendo') && pagV.includes("e.code === 'INVALID_DOCUMENT'") && pagV.includes('aviso = e.message'))
check('una pestaña inventada cae en «por periodo»', pagV.includes("(TIPOS_REPORTE_VENTAS as readonly string[]).includes(sp.t ?? '') ? (sp.t as TipoReporteVentas) : 'periodo'"))
check('>>> las páginas leen con el cliente aislado por negocio y sucursal (getTenantPrisma), nunca con el cliente base', pagV.includes('getTenantPrisma(ctx)') && !/from '@\/lib\/prisma'/.test(pagV + hub))
check('>>> la ruta CSV: sesión (401), reporte inexistente (404), parámetros inválidos (400), sin permiso (403), con las cabeceras de `respuestaCsv`; el permiso lo decide el servicio', ruta.includes("status: 401") && ruta.includes("status: 404") && ruta.includes("status: 400") && ruta.includes("e.code === 'FORBIDDEN_ROLE' ? 403 : 400") && ruta.includes('respuestaCsv(archivo)') && !/puede\(|exigir\(|ctx\.role/.test(ruta) && ruta.includes("export const dynamic = 'force-dynamic'"))
const enMenu = (r: Role) => visibleItems([...permisosDe(ctxDe(r))]).some((i) => i.href === '/reportes')
check('>>> el menú muestra Reportes a dueño, administrador y contador; no a cajero, vendedor ni almacenero (quien tiene alguno de los dos permisos de reportes)', enMenu('OWNER') && enMenu('ADMIN') && enMenu('CONTADOR') && !enMenu('CAJERO') && !enMenu('VENDEDOR') && !enMenu('ALMACENERO'))
check('el enlace del menú usa el mismo permiso', /href: '\/reportes',[\s\S]*?permisos: \['reportes\.ver', 'productos\.ver_costo'\]/.test(readFileSync('src/features/shell/nav-items.ts', 'utf8')))
check('el centro de reportes enlaza a ventas', hub.includes('href="/reportes/ventas"') || hub.includes('"/reportes/ventas"'))
check('hay pantalla de carga para el centro y para ventas', existsSync(`${D}/loading.tsx`) && existsSync(`${D}/ventas/loading.tsx`))
check('>>> los reportes de ventas nunca piden ni muestran costos (ni leen `costPrice` ni `unitCost`: eso es de otro reporte y de `productos.ver_costo`)', !/costPrice|unitCost/.test(readFileSync('src/features/reportes/ventas-service.ts', 'utf8') + readFileSync('src/features/reportes/ventas-calculo.ts', 'utf8') + pagV))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
