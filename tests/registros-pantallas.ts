import { existsSync, readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { registroCompras, registroVentas, type CompraRegistrable, type ComprobanteVenta } from '../src/features/registros/registro-calculo'
import { parametrosRegistrosSchema, type ParametrosRegistros } from '../src/features/registros/schemas'
import { BarraDescargaRegistro, PestanasRegistros, TablaRegistroCompras, TablaRegistroVentas } from '../src/features/registros/components/TablasRegistros'
import { enlaceCsvRegistro, enlaceRegistros } from '../src/features/registros/urls'
import { CamposDocumento, DOCUMENTO_VACIO } from '../src/features/compras/components/CamposDocumento'
import { CompletarDocumento } from '../src/features/compras/components/CompletarDocumento'

/**
 * F5.4 · Las pantallas de los registros y del documento de compra, renderizadas AISLADAS. Lo que más importa: lo que NO suma se ve aparte
 * (bloque de control), lo provisional se ve marcado, y la página, la ruta y el menú deciden con `reportes.ver`.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const etiqueta = (h: string, marca: string): string => { const i = h.indexOf(marca); if (i < 0) return ''; const a = h.lastIndexOf('<', i); return h.slice(a, h.indexOf('>', i) + 1) }
const P = (o: Partial<ParametrosRegistros> = {}): ParametrosRegistros => parametrosRegistrosSchema.parse(o)
const V = (id: string, o: Partial<ComprobanteVenta> = {}): ComprobanteVenta => ({ id, fecha: '2026-10-20', tipo: 'FACTURA', numero: `F001-${id}`, relacionado: null, receptorTipo: 'RUC', receptorNumero: '20123456789', receptorNombre: 'Cliente SAC', moneda: 'PEN', base: 100, igv: 18, total: 118, estado: 'ACEPTADO', ...o })
const K = (id: string, o: Partial<CompraRegistrable> = {}): CompraRegistrable => ({ id, compra: `C001-${id}`, emision: '2026-10-18', recepcion: '2026-10-20', tipo: 'FACTURA', serie: 'F001', numero: id, referencia: `F001-${id}`, proveedorRuc: '20123456789', proveedorNombre: 'Proveedor SAC', base: 100, igv: 18, total: 118, condicion: 'CONTADO', ...o })

console.log('\nA) Registro de ventas')
const rv = registroVentas([V('1'), V('2', { tipo: 'NOTA_CREDITO', numero: 'FC01-1', relacionado: 'F001-1', base: 50, igv: 9, total: 59 }), V('3', { estado: 'PENDIENTE' }), V('4', { estado: 'ANULADO' }), V('5', { receptorTipo: 'DNI', receptorNumero: '12345678' })])
const hv = html(createElement(TablaRegistroVentas, { r: rv }))
check('>>> los totales muestran lo que suma (118 − 59 + 118 = 177.00) y cuántos documentos', hv.includes('S/ 177.00') && hv.includes('Documentos que suman'))
check('>>> el bloque de CONTROL lista lo que no suma: pendientes y anulados, con importes', hv.includes('data-registro="control"') && hv.includes('data-control="PENDIENTE"') && hv.includes('data-control="ANULADO"') && !hv.includes('data-control="RECHAZADO"'))
check('>>> las filas que no suman se ven apagadas (data-suma="no") y las que suman normales', (hv.match(/data-suma="no"/g) ?? []).length === 2 && (hv.match(/data-suma="si"/g) ?? []).length === 3)
check('>>> la nota de crédito aparece en NEGATIVO y dice qué comprobante corrige', hv.includes('−S/ 59.00') && hv.includes('Corrige F001-1'))
check('aviso de factura sin RUC válido', hv.includes('data-registro-aviso="sin-ruc"') && hv.includes('1 factura no tiene'))
check('>>> sin comprobantes: mensaje que explica que los de ensayo no se registran', html(createElement(TablaRegistroVentas, { r: registroVentas([]) })).includes('Los comprobantes de ensayo no se registran') && !html(createElement(TablaRegistroVentas, { r: registroVentas([]) })).includes('data-registro="control"'))
check('con todo válido no hay bloque de control', !html(createElement(TablaRegistroVentas, { r: registroVentas([V('1')]) })).includes('data-registro="control"'))
check('>>> más de 200 filas: se pintan 200, se avisa, y los totales son de TODAS', (() => { const r = registroVentas(Array.from({ length: 250 }, (_, i) => V(String(i).padStart(4, '0')))); const h = html(createElement(TablaRegistroVentas, { r })); return (h.match(/data-fila=/g) ?? []).length === 200 && h.includes('data-reporte="recorte"') && h.includes('S/ 29500.00') })())

console.log('\nB) Registro de compras')
const rc = registroCompras([K('1'), K('2', { emision: null, tipo: null, serie: null, numero: null, referencia: 'REF-LIBRE', proveedorRuc: null })])
const hc = html(createElement(TablaRegistroCompras, { r: rc }))
check('>>> la compra sin documento muestra la fecha PROVISIONAL marcada y el aviso al contador con el camino para completarla', hc.includes('data-fecha="provisional"') && hc.includes('data-registro-aviso="provisionales"') && hc.includes('Completar documento'))
check('>>> data-provisional distingue las filas; la que tiene documento no está marcada', etiqueta(hc, 'data-fila="2"').includes('data-provisional="si"') && etiqueta(hc, 'data-fila="1"').includes('data-provisional="no"'))
check('aviso de proveedor sin RUC y cada compra enlaza a su detalle', hc.includes('data-registro-aviso="sin-ruc"') && hc.includes('href="/compras/1"'))
check('el tipo y la serie-número se ven', hc.includes('Factura') && hc.includes('F001-1') && hc.includes('Sin documento') && hc.includes('REF-LIBRE'))
check('sin compras: mensaje de vacío', html(createElement(TablaRegistroCompras, { r: registroCompras([]) })).includes('data-reporte="vacio"'))
check('sin provisionales no hay aviso', !html(createElement(TablaRegistroCompras, { r: registroCompras([K('1')]) })).includes('data-registro-aviso'))
check('>>> aclara que es el total del documento y no el costo de cada producto', hc.includes('no el costo de cada producto'))

console.log('\nC) Pestañas, enlaces y descarga')
const pest = html(createElement(PestanasRegistros, { activa: 'compras', params: P({ p: 'MES_PASADO' }) }))
check('>>> dos pestañas; la activa marcada; los enlaces conservan el periodo; ventas sin «t»', ['ventas', 'compras'].every((t) => pest.includes(`data-pestana="${t}"`)) && etiqueta(pest, 'data-pestana="compras"').includes('aria-current="page"') && etiqueta(pest, 'data-pestana="compras"').includes('href="/reportes/registros?t=compras&amp;p=MES_PASADO"') && etiqueta(pest, 'data-pestana="ventas"').includes('href="/reportes/registros?p=MES_PASADO"'))
check('enlace por defecto limpio y CSV por tipo', enlaceRegistros('ventas', P()) === '/reportes/registros' && enlaceCsvRegistro('compras', P({ p: 'RANGO', desde: '2026-10-01', hasta: '2026-10-05' })) === '/api/reportes/registros/compras?p=RANGO&desde=2026-10-01&hasta=2026-10-05')
check('la barra de descarga enlaza al CSV del mismo registro', html(createElement(BarraDescargaRegistro, { tipo: 'ventas', params: P(), texto: 'Octubre' })).includes('href="/api/reportes/registros/ventas"'))

console.log('\nD) El documento en el formulario y en el detalle de la compra')
const campos = html(createElement(CamposDocumento, { valor: DOCUMENTO_VACIO, onChange: noop, hoy: '2026-10-27' }))
check('>>> cuatro campos: tipo (con «Sin documento todavía» + 6 tipos), serie, número y fecha con tope de hoy', campos.includes('name="docType"') && campos.includes('name="docSeries"') && campos.includes('name="docNumber"') && campos.includes('name="issueDate"') && campos.includes('max="2026-10-27"') && ['Factura', 'Boleta', 'Nota de crédito', 'Nota de débito', 'Recibo por honorarios', 'Otro documento', 'Sin documento todavía'].every((t) => campos.includes(`>${t}</option>`)))
check('el valor actual queda seleccionado', html(createElement(CamposDocumento, { valor: { docType: 'BOLETA', docSeries: 'B001', docNumber: '7', issueDate: '2026-10-01' }, onChange: noop, hoy: '2026-10-27' })).includes('value="B001"'))
const comp = html(createElement(CompletarDocumento, { purchaseId: 'p1', actual: null, hoy: '2026-10-27', puedeOperar: true }))
check('>>> «Completar documento» (sin documento) / «Corregir documento» (con documento), deshabilitado si la cuenta está en solo lectura', comp.includes('Completar documento') && html(createElement(CompletarDocumento, { purchaseId: 'p1', actual: { docType: 'FACTURA', docSeries: 'F1', docNumber: '1', issueDate: '2026-10-01' }, hoy: '2026-10-27', puedeOperar: true })).includes('Corregir documento') && /<button[^>]*disabled[^>]*data-boton="documento"|<button[^>]*data-boton="documento"[^>]*disabled/.test(html(createElement(CompletarDocumento, { purchaseId: 'p1', actual: null, hoy: '2026-10-27', puedeOperar: false }))))
const det = readFileSync('src/features/compras/components/DetalleCompra.tsx', 'utf8'), form = readFileSync('src/features/compras/components/FormularioCompra.tsx', 'utf8')
check('>>> el detalle ofrece «Completar documento» solo en RECIBIDA y con compras.registrar, y avisa que falta el documento', det.includes("c.status === 'RECIBIDA' && permisos.puedeRegistrar") && det.includes('data-documento="pendiente"') && det.includes('<CompletarDocumento'))
check('el formulario usa los campos del documento y deja la referencia libre solo si no hay tipo', form.includes('<CamposDocumento') && form.includes('{!doc.docType && ('))
check('la acción de completar no decide permisos (los decide el servicio)', (() => { const a = readFileSync('src/features/compras/actions.ts', 'utf8'); const i = a.indexOf('export async function completarDocumento'); const cuerpo = a.slice(i, a.indexOf('export async function', i + 10)); return cuerpo.includes('completarDocumentoSchema.safeParse') && !/puede\(|exigir\(/.test(cuerpo) })())

console.log('\nE) Página, ruta, centro y permiso')
const D = 'src/app/(dashboard)/reportes'
const pag = readFileSync(`${D}/registros/page.tsx`, 'utf8'), hub = readFileSync(`${D}/page.tsx`, 'utf8'), ruta = readFileSync('src/app/api/reportes/registros/[tipo]/route.ts', 'utf8'), serv = readFileSync('src/features/registros/registro-service.ts', 'utf8')
check("la página exige sesión y `reportes.ver` (404 si no); no mira el rol", pag.includes('await requireTenantContext()') && pag.includes("if (!puede(ctx, 'reportes.ver')) notFound()") && !/ctx\.role/.test(pag))
check('lee con el cliente aislado (getTenantPrisma), nunca con el base', pag.includes('getTenantPrisma(ctx)') && !/from '@\/lib\/prisma'/.test(pag + serv))
check('>>> dirección manipulada → este mes con aviso; rango imposible → aviso', pag.includes('parametrosRegistrosSchema.safeParse(') && pag.includes('Esa dirección tenía un periodo que no entiendo') && pag.includes("e.code === 'INVALID_DOCUMENT'"))
check('el selector vuelve a /reportes/registros y conserva la pestaña', pag.includes('accion="/reportes/registros"') && pag.includes('pestanaInicial="ventas"'))
check('>>> la ruta CSV: 401, 404, 400, 403, cabeceras de `respuestaCsv`, sin lógica de permisos propia', ruta.includes('status: 401') && ruta.includes('status: 404') && ruta.includes('status: 400') && ruta.includes("e.code === 'FORBIDDEN_ROLE' ? 403 : 400") && ruta.includes('respuestaCsv(archivo)') && !/puede\(|exigir\(|ctx\.role/.test(ruta))
check("el servicio exige `reportes.ver` y nada más (el costo de producto no se lee)", serv.includes("exigir(ctx, 'reportes.ver')") && !/costPrice|unitCost/.test(serv) && !/productos\.ver_costo/.test(serv))
check('el centro de reportes enseña la tarjeta de registros con `reportes.ver`', hub.includes('data-reporte-tarjeta="registros"') && /\{verVentas && <li>\s*<Link href="\/reportes\/registros"/.test(hub))
check('hay pantalla de carga', existsSync(`${D}/registros/loading.tsx`))
check('el servicio de registros es de solo lectura (salvo la auditoría de la descarga)', !/\.(update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(serv) && (serv.match(/\.create\(/g) ?? []).length === 1)

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
