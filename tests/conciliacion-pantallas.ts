import { existsSync, readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { armarInforme, cuadre, MENSAJE_SIN_COMPROBANTES, puenteVentas, type Hallazgo, type InformeConciliacion } from '../src/features/conciliacion/conciliacion-calculo'
import { BarraDescargaConciliacion, EJEMPLOS_POR_HALLAZGO, VistaConciliacion } from '../src/features/conciliacion/components/VistaConciliacion'
import { enlaceCsvConciliacion } from '../src/features/conciliacion/urls'
import { registroVentas } from '../src/features/registros/registro-calculo'
import { parametrosRegistrosSchema } from '../src/features/registros/schemas'
import type { ModoFiscal } from '../src/features/invoicing/modo-fiscal'

/**
 * F5.7 · La pantalla de conciliación fiscal, renderizada AISLADA. Lo que más importa: «sin comprobantes reales» se ve calmado (sin rojo, sin
 * alerta), un error se ve y se lee, los umbrales operativos van marcados con ⚠️, y la página, la ruta y el centro deciden con `reportes.ver`.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const cero = { documentos: 0, total: 0 }
const base = { modo: 'REAL' as ModoFiscal, puente: puenteVentas([], cero, cero), cuadreVentas: cuadre(0, 0), cuadreCompras: cuadre(0, 0), comprobantesReales: 0, registroVentas: registroVentas([]), comprasEnRegistro: 0 }
const hall = (nivel: Hallazgo['nivel'], o: Partial<Hallazgo> = {}): Hallazgo => ({ codigo: 'FACTURA_SIN_RUC', nivel, titulo: 'Facturas sin RUC', explicacion: 'Explicación', cantidad: 1, importe: 118, items: [{ referencia: 'F001-1', detalle: 'sin RUC', importe: 118, enlace: '/comprobantes' }], ...o })
const vista = (i: InformeConciliacion) => html(createElement(VistaConciliacion, { r: i }))

console.log('\nA) Estados')
const sin = vista(armarInforme({ ...base, modo: 'ENSAYO', hallazgos: [hall('INFO', { codigo: 'MODO_SIN_VALOR_FISCAL', titulo: 'Facturación electrónica real sin habilitar', items: [], cantidad: 0, importe: 0 })] }))
check('>>> «Sin comprobantes reales que conciliar»: se dice, es un estado calmado (role="status", gris) y SIN alerta roja', sin.includes(MENSAJE_SIN_COMPROBANTES) && sin.includes('data-conciliacion="SIN_COMPROBANTES"') && /role="status"/.test(sin) && !sin.includes('role="alert"') && !sin.includes('stock-out') && !sin.includes('stock-low-soft'))
check('el modo se muestra', sin.includes('Modo: Ensayo'))
const limpio = vista(armarInforme({ ...base, comprobantesReales: 3, hallazgos: [] }))
check('limpio: «Todo cuadra.» en verde, sin alerta y con «No hay nada que revisar»', limpio.includes('Todo cuadra.') && limpio.includes('data-conciliacion="LIMPIO"') && limpio.includes('stock-ok-soft') && !limpio.includes('role="alert"') && limpio.includes('No hay nada que revisar'))
const adv = vista(armarInforme({ ...base, comprobantesReales: 3, hallazgos: [hall('ADVERTENCIA')] }))
check('advertencias: aviso ámbar con role="alert" y el conteo', adv.includes('data-conciliacion="ADVERTENCIAS"') && /role="alert"/.test(adv) && adv.includes('1 advertencia'))
const err = vista(armarInforme({ ...base, comprobantesReales: 3, hallazgos: [hall('ERROR'), hall('ADVERTENCIA'), hall('INFO')] }))
check('>>> errores: aviso rojo con role="alert" y los conteos', err.includes('data-conciliacion="ERRORES"') && /role="alert"/.test(err) && err.includes('1 error') && err.includes('stock-out-soft'))

console.log('\nB) Hallazgos')
check('>>> cada hallazgo muestra su nivel, título, explicación y sus casos con importe y enlace', err.includes('data-hallazgo="FACTURA_SIN_RUC"') && err.includes('Error') && err.includes('Advertencia') && err.includes('Información') && err.includes('F001-1') && err.includes('S/ 118.00') && err.includes('href="/comprobantes"'))
check('>>> los errores van primero y abiertos; las advertencias, cerradas', (() => { const i = err.indexOf('data-nivel="ERROR"'), j = err.indexOf('data-nivel="ADVERTENCIA"'); return i >= 0 && i < j && /data-nivel="ERROR"[^>]*>\s*<details[^>]*open/.test(err) && !/data-nivel="ADVERTENCIA"[^>]*>\s*<details[^>]*open/.test(err) })())
check('>>> más de 10 casos: se muestran 10 y se avisa que la descarga trae todos', (() => { const items = Array.from({ length: 25 }, (_, i) => ({ referencia: `R${i}`, detalle: 'd', importe: 1, enlace: null })); const h = vista(armarInforme({ ...base, comprobantesReales: 1, hallazgos: [hall('ERROR', { items, cantidad: 25 })] })); return (h.match(/data-item/g) ?? []).length === EJEMPLOS_POR_HALLAZGO && h.includes('data-hallazgo-recorte') && h.includes('Se muestran 10 de 25') })())
check('el importe y los casos se resumen en la cabecera del hallazgo', err.includes('1 caso') && err.includes('S/ 118.00'))
check('>>> el ⚠️ de los umbrales: la nota dice que 24 h / 72 h son operativos, no plazos de SUNAT, y pendientes de validar con el contador', limpio.includes('data-conciliacion-nota') && limpio.includes('24 h advierte, 72 h es error') && limpio.includes('no plazos de SUNAT') && limpio.includes('validar con tu contador') && limpio.includes('⚠️'))

console.log('\nC) Puente y cuadre')
const p = puenteVentas([
  { id: '1', numero: 'V1', pide: 'BOLETA', total: 118, base: 100, igv: 18, completadaMs: 0, doc: { id: 'd', tipo: 'BOLETA', numero: 'B1', estado: 'ACEPTADO', isTrial: false, base: 100, igv: 18, total: 118, receptorTipo: 'SIN_DOCUMENTO', receptorNumero: null, emitidoMs: 0 } },
  { id: '2', numero: 'V2', pide: 'NOTA_VENTA', total: 50, base: 42.37, igv: 7.63, completadaMs: 0, doc: null },
], { documentos: 1, total: 20 }, { documentos: 2, total: 30 })
const hp = vista(armarInforme({ ...base, puente: p, cuadreVentas: cuadre(118, 118), cuadreCompras: cuadre(10, 9), comprobantesReales: 1, hallazgos: [] }))
check('>>> el puente lista cada paso con ventas e importe: completadas 168.00, notas de venta 50.00, con comprobante 118.00 y sus categorías', hp.includes('data-puente="completadas"') && hp.includes('S/ 168.00') && hp.includes('data-puente="notas-de-venta"') && hp.includes('S/ 50.00') && hp.includes('data-puente="con-comprobante"') && ['valido', 'pendiente', 'rechazado', 'anulado', 'ensayo', 'sinComprobante'].every((k) => hp.includes(`data-puente="${k}"`)))
check('>>> la diferencia sin explicar sale en verde con 0 y en rojo si no es 0', hp.includes('data-puente="diferencia"') && /data-puente="diferencia" class="[^"]*text-stock-ok/.test(hp) && /data-puente="diferencia" class="[^"]*text-stock-out/.test(vista(armarInforme({ ...base, puente: { ...p, diferencia: 5 }, comprobantesReales: 1, hallazgos: [] }))))
check('>>> las anuladas y devueltas están en líneas INFORMATIVAS propias, claramente “no suman”', hp.includes('data-puente="anuladas"') && hp.includes('S/ 20.00') && hp.includes('data-puente="devueltas"') && hp.includes('S/ 30.00') && /data-puente="anuladas"[\s\S]*?\(no suman\)[\s\S]*?data-puente="devueltas"/.test(hp) && /data-puente="devueltas"[\s\S]*?\(no suman\)/.test(hp))
check('>>> el cuadre de los registros: ventas sin diferencia (verde) y compras con S/ 1.00 (rojo)', /data-cuadre="ventas"[\s\S]*?text-stock-ok/.test(hp) && /data-cuadre="compras"[\s\S]*?text-stock-out/.test(hp))
const params = parametrosRegistrosSchema.parse({})
check('la barra de descarga enlaza al CSV, con el periodo cuando no es el de por defecto', html(createElement(BarraDescargaConciliacion, { params, texto: 'Octubre' })).includes('href="/api/reportes/conciliacion"') && enlaceCsvConciliacion(parametrosRegistrosSchema.parse({ p: 'RANGO', desde: '2026-10-01', hasta: '2026-10-05' })) === '/api/reportes/conciliacion?p=RANGO&desde=2026-10-01&hasta=2026-10-05')

console.log('\nD) Página, ruta, centro y script')
const D = 'src/app/(dashboard)/reportes'
const pag = readFileSync(`${D}/conciliacion/page.tsx`, 'utf8'), hub = readFileSync(`${D}/page.tsx`, 'utf8'), ruta = readFileSync('src/app/api/reportes/conciliacion/route.ts', 'utf8')
const serv = readFileSync('src/features/conciliacion/conciliacion-service.ts', 'utf8'), calc = readFileSync('src/features/conciliacion/conciliacion-calculo.ts', 'utf8'), script = readFileSync('scripts/auditar-fiscal.ts', 'utf8')
check("la página exige sesión y `reportes.ver` (404 si no); no mira el rol", pag.includes('await requireTenantContext()') && pag.includes("if (!puede(ctx, 'reportes.ver')) notFound()") && !/ctx\.role/.test(pag))
check('>>> la página llama a `informeConciliacion` (con permiso), NUNCA al núcleo sin permiso; lee con el cliente aislado', pag.includes('informeConciliacion(db, ctx, params)') && !pag.includes('calcularConciliacion') && !ruta.includes('calcularConciliacion') && pag.includes('getTenantPrisma(ctx)') && !/from '@\/lib\/prisma'/.test(pag + serv))
check('>>> dirección manipulada → este mes con aviso; rango imposible → aviso', pag.includes('parametrosRegistrosSchema.safeParse(') && pag.includes('Esa dirección tenía un periodo que no entiendo') && pag.includes("e.code === 'INVALID_DOCUMENT'"))
check('>>> la ruta CSV: 401, 400, 403, cabeceras de `respuestaCsv`, sin lógica de permisos propia', ruta.includes('status: 401') && ruta.includes('status: 400') && ruta.includes("e.code === 'FORBIDDEN_ROLE' ? 403 : 400") && ruta.includes('respuestaCsv(') && !/puede\(|exigir\(|ctx\.role/.test(ruta))
check('>>> el servicio: `informeConciliacion` exige `reportes.ver` (y nada más) y se acota por las sucursales del usuario; el núcleo no pide permisos (lo usa el script)', /export async function informeConciliacion[\s\S]*?exigir\(ctx, 'reportes\.ver'\)[\s\S]*?calcularConciliacion\(db, p, ahora, ctx\.branchIds\)/.test(serv) && !/productos\.ver_costo|costPrice|unitCost/.test(serv + calc) && (serv.match(/exigir\(/g) ?? []).length === 1 + 0)
check('>>> SOLO LECTURA: el servicio y el script no escriben nada salvo la línea de auditoría de la descarga', (serv.match(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/g) ?? []).length === 1 && serv.includes('auditLog.create') && !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany|\$executeRaw)/.test(script))
check('el centro de reportes enseña la tarjeta con `reportes.ver`', hub.includes('data-reporte-tarjeta="conciliacion"') && /\{verVentas && <li>\s*<Link href="\/reportes\/conciliacion"/.test(hub))
check('hay pantalla de carga', existsSync(`${D}/conciliacion/loading.tsx`))
check('>>> el script: solo lectura, salida 0/3/1 documentada, rechaza opciones desconocidas y recorre los negocios sin usuario', script.includes('process.exitCode = 3') && script.includes('process.exit(1)') && script.includes('Opción desconocida') && script.includes("role: 'SUPERADMIN'") && script.includes('calcularConciliacion(db, parsed.data)'))
check('>>> los umbrales son constantes con nombre y la documentación los marca como operativos, no normativos', calc.includes('export const UMBRAL_ADVERTENCIA_HORAS = 24') && calc.includes('export const UMBRAL_ERROR_HORAS = 72') && /UMBRALES OPERATIVOS, NO NORMATIVOS/.test(calc))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
