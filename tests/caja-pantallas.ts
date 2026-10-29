import { existsSync, readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { CashPanel } from '../src/features/branches/components/CashPanel'
import { PosTerminal, MENSAJE_SIN_TURNO } from '../src/features/pos/components/PosTerminal'
import { sumarDesgloses, construirDesglose, type DesgloseCierre } from '../src/features/branches/cierre-desglose'
import type { CajaDeSucursal } from '../src/features/branches/cajas-service'

/**
 * F6.8c · Las pantallas de caja, renderizadas AISLADAS: el selector de caja al abrir turno, los avisos «abre tu turno» ANTES de operar (POS, abonos), el interruptor retirado y las rutas de reporte
 * (cierre A4/CSV y consolidado) con su permiso, leídas como código. Lo que más importa: el usuario nunca se entera del rechazo recién al guardar.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const src = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const seguro = <T,>(f: () => T, otro: T): T => { try { return f() } catch (e) { console.log(`    (excepción: ${e instanceof Error ? e.message.slice(0, 160) : e})`); return otro } }

const caja = (id: string, name: string, ocupadaPor?: string): CajaDeSucursal => ({ id, branchId: 'b1', name, turnoAbierto: ocupadaPor ? { id: `t-${id}`, abiertoPor: ocupadaPor, desde: '2026-10-29T13:00:00.000Z' } : null })
const panel = (o: Record<string, unknown> = {}) => html(createElement(CashPanel, { turno: null, ultimoCierre: null, sucursal: 'Casa matriz', puedeOperar: true, zonaHoraria: 'America/Lima', ...o } as never))

console.log('\nA) Abrir turno: el selector de caja')
const una = seguro(() => panel({ cajas: [caja('c1', 'Caja principal')] }), '')
check('>>> con UNA sola caja no hay selector: se dice cuál es', !una.includes('data-caja="selector"') && una.includes('data-caja="unica"') && una.includes('Caja principal'))
const varias = seguro(() => panel({ cajas: [caja('c1', 'Caja principal', 'Ana'), caja('c2', 'Caja 2'), caja('c3', 'Mostrador')] }), '')
check('>>> con varias cajas el usuario DEBE elegir: aparece el selector con cada caja', varias.includes('data-caja="selector"') && varias.includes('Caja 2') && varias.includes('Mostrador'))
check('>>> la ocupada sale deshabilitada y dice quién la tiene; la primera libre viene marcada', /Ocupada por Ana/.test(varias) && /<input[^>]*disabled[^>]*value="c1"|<input[^>]*value="c1"[^>]*disabled/.test(varias) && /<input[^>]*checked[^>]*value="c2"|<input[^>]*value="c2"[^>]*checked/.test(varias))
const llenas = seguro(() => panel({ cajas: [caja('c1', 'Caja principal', 'Ana'), caja('c2', 'Caja 2', 'Beto')] }), '')
const botonAbrir = (h: string) => h.slice(h.lastIndexOf('<button', h.indexOf('Abrir caja')), h.indexOf('Abrir caja'))
check('>>> si todas están ocupadas lo dice y «Abrir caja» queda deshabilitado; con una libre, habilitado', llenas.includes('Todas las cajas de la sucursal están ocupadas') && / disabled=""/.test(botonAbrir(llenas)) && !/ disabled=""/.test(botonAbrir(varias)) && !/ disabled=""/.test(botonAbrir(una)))
const otra = seguro(() => panel({ cajas: [caja('c1', 'Caja principal')], turnoEnOtraSucursal: 'Sucursal Sur' }), '')
check('>>> quien ya tiene turno en OTRA sucursal lo ve antes de intentar, con el nombre de esa sucursal', otra.includes('data-caja="turno-en-otra-sucursal"') && otra.includes('Sucursal Sur') && /disabled/.test(otra.slice(otra.indexOf('Abrir caja') - 300, otra.indexOf('Abrir caja') + 20)))
check('>>> la pantalla ya no dice que se puede vender sin caja: dice que el turno propio es obligatorio', !/Puedes vender sin abrir caja/.test(una) && una.includes('data-caja="obligatoria"') && /tu propio turno/.test(una))
const abierto = seguro(() => panel({ turno: { id: 't', openingAmount: 100, expectedAmount: 100, salesCount: 0, refundsCashTotal: 0, refundsOtherTotal: 0, movimientos: { ingresos: 0, egresos: 0, compensacionesEfectivo: 0, compensacionesOtrosMedios: 0 }, lista: [], openedAt: '2026-10-29T13:00:00.000Z', abiertoPor: 'Ana', caja: 'Caja 2' } }), '')
check('>>> el turno abierto muestra en qué caja trabajas', abierto.includes('Casa matriz · Caja 2'))
check('>>> el esperado sigue a ciegas (no aparece antes de contar)', !/Debía haber|Esperado/.test(abierto))
const ultimo = { id: 'u1', openingAmount: 1, countedAmount: 1, expectedAmount: 1, difference: 0, salesCount: 0, salesTotal: 0, cashTotal: 0, changeTotal: 0, creditSalesTotal: 0, cashReceiptsTotal: 0, otherReceiptsTotal: 0, supplierCashPaymentsTotal: 0, supplierOtherPaymentsTotal: 0, refundsCashTotal: 0, refundsOtherTotal: 0, movimientos: { ingresos: 0, egresos: 0, compensacionesEfectivo: 0, compensacionesOtrosMedios: 0 }, closedAt: '2026-10-28T20:00:00.000Z' }
const conUltimo = seguro(() => panel({ ultimoCierre: ultimo, puedeImprimirUltimoCierre: true, cajas: [caja('c1', 'Caja principal')] }), '')
check('>>> el último cierre se imprime en 80 mm, en A4 y se baja en CSV (enlaces al mismo cierre)', conUltimo.includes('/imprimir/cierre-caja/u1') && conUltimo.includes('/cierre-caja/u1') && conUltimo.includes('/api/caja/cierre/u1'))
const sinPermiso = seguro(() => panel({ ultimoCierre: ultimo, puedeImprimirUltimoCierre: false, cajas: [caja('c1', 'Caja principal')] }), '')
check('>>> sin permiso para ver el cierre no se ofrece ningún enlace', !sinPermiso.includes('/cierre-caja/u1') && !sinPermiso.includes('/api/caja/cierre/u1'))

const paginaCaja = src('src/app/(dashboard)/caja/page.tsx')
check('>>> la página de Caja: el último cierre es el propio salvo `caja.arqueo`; trae las cajas, el turno en otra sucursal y el enlace al consolidado solo con su permiso', /\.\.\.\(arqueo \? \{\} : \{ openedById: ctx\.userId \}\)/.test(paginaCaja) && /cajasDeSucursal\(db, ctx, ctx\.branchId\)/.test(paginaCaja) && /openedById: ctx\.userId, status: 'ABIERTA', branchId: \{ not: ctx\.branchId \}/.test(paginaCaja) && /puede\(ctx, 'caja\.consolidado'\) && \(/.test(paginaCaja))

const panelFuente = src('src/features/branches/components/CashPanel.tsx')
check('>>> abrir manda la caja elegida cuando hay varias, y exige elegir una libre', /openCash\(\{ openingAmount: monto, notes: notas\.trim\(\) \|\| undefined, \.\.\.\(cajas\.length > 1 \? \{ registerId: cajaElegida \} : \{\}\) \}\)/.test(panelFuente) && /cajas\.length > 1 && !libres\.some\(\(c\) => c\.id === cajaElegida\)/.test(panelFuente))

console.log('\nB) Avisos ANTES de operar')
const pos = (o: Record<string, unknown>) => seguro(() => html(createElement(PosTerminal, { warehouseName: 'Principal', zonaHoraria: 'America/Lima', puedeCobrar: true, ...o } as never)), '')
const posSin = pos({ tieneTurno: false }), posCon = pos({ tieneTurno: true })
check('>>> el POS sin turno propio avisa desde el primer momento, con el camino a la caja', posSin.includes('data-pos="sin-turno"') && posSin.includes(MENSAJE_SIN_TURNO) && posSin.includes('href="/caja"'))
check('>>> con turno propio no hay aviso', posCon.length > 0 && !posCon.includes('data-pos="sin-turno"'))
check('>>> el aviso sale solo a quien puede cobrar (el vendedor que arma pedidos no lo necesita)', !pos({ tieneTurno: false, puedeCobrar: false }).includes('data-pos="sin-turno"'))
const posFuente = src('src/features/pos/components/PosTerminal.tsx')
check('>>> el botón «Cobrar» queda deshabilitado sin turno y `cobrar()` también lo corta', /!enLinea \|\| !tieneTurno \|\|/.test(posFuente) && /if \(!tieneTurno\) \{ setError\(MENSAJE_SIN_TURNO\); return \}/.test(posFuente))
check('>>> el POS lee el turno propio en el servidor (no el de la sucursal)', /turnoPropioId\(db, ctx\.userId, ctx\.branchId\)/.test(src('src/app/(dashboard)/pos/page.tsx')) && /tieneTurno=\{turnoPropio !== null\}/.test(src('src/app/(dashboard)/pos/page.tsx')))
const abonoFuente = src('src/features/clientes/components/ModalAbono.tsx')
check('>>> el modal de abonos avisa «no tienes tu turno» con CUALQUIER medio y enlaza a la caja (renderizado en clientes-pantallas)', /\{cajaAbierta === false && \(/.test(abonoFuente) && /data-abono="sin-caja"/.test(abonoFuente) && /href="\/caja"/.test(abonoFuente) && !/metodo === 'EFECTIVO' && cajaAbierta === false/.test(abonoFuente))
const pagoFuente = src('src/features/por-pagar/components/ModalPago.tsx')
check('>>> el modal de pago a proveedor avisa igual, con cualquier medio', /cajaAbierta === false &&[\s\S]{0,200}data-pago="sin-caja"/.test(pagoFuente) && /tu turno de caja/.test(pagoFuente))
check('>>> las devoluciones piden turno propio para cualquier reembolso que mueva dinero (no solo efectivo)', /mode !== 'SIN_SALIDA'\) && !hayTurnoAbierto/.test(src('src/features/ventas/components/FormularioDevolucion.tsx')) && /mode !== 'SIN_SALIDA'\) && !d\.hayTurnoAbierto/.test(src('src/features/ventas/components/FormularioDevolucionParcial.tsx')))

console.log('\nC) El interruptor de «caja obligatoria» ya no existe')
check('>>> sin componente, sin acción de servidor, sin servicio y sin lectura en la página', !existsSync('src/features/branches/components/CajaObligatoria.tsx') && !/setCajaObligatoria|configurarCajaObligatoria/.test(src('src/features/branches/actions.ts') + src('src/features/branches/cash-service.ts')) && !/cashRequired|CajaObligatoria/.test(src('src/app/(dashboard)/caja/page.tsx')))
check('>>> el POS ya no consulta el ajuste (regla universal)', !/cashRequired/.test(src('src/features/pos/sale-service.ts')))

console.log('\nD) Rutas de reporte y permiso')
const cons = src('src/app/(dashboard)/caja/consolidado/page.tsx')
check('>>> el consolidado es una pantalla protegida: sin `caja.consolidado` es 404 (notFound) y lo repite el servicio', /puede\(ctx, 'caja\.consolidado'\)\) notFound\(\)/.test(cons) && /exigir\(ctx, 'caja\.consolidado'\)/.test(src('src/features/branches/consolidado-caja.ts')))
const apiCons = src('src/app/api/caja/consolidado/route.ts')
check('>>> su CSV exige sesión (401) y permiso (403) y se descarga como adjunto sin guardar en caché', /status: 401/.test(apiCons) && /FORBIDDEN_ROLE' \? 403/.test(apiCons) && /respuestaCsv/.test(apiCons))
const apiCierre = src('src/app/api/caja/cierre/[id]/route.ts')
check('>>> el CSV del cierre exige sesión y devuelve 404 a lo que no se puede ver (no confirma que exista)', /status: 401/.test(apiCierre) && /FORBIDDEN_ROLE' \|\| e\.code === 'NOT_FOUND' \? 404/.test(apiCierre))
check('>>> el cierre en A4 vive en su propia ruta y da 404 a lo que no se puede ver', /notFound\(\)/.test(src('src/app/(print-a4)/cierre-caja/[id]/page.tsx')) && /getTicketCierre/.test(src('src/app/(print-a4)/cierre-caja/[id]/page.tsx')))
check('>>> el menú de Caja se ofrece también a quien solo tiene el consolidado', /caja\.consolidado'\]/.test(src('src/features/shell/nav-items.ts')))
const sinCostos = ['src/features/printing/cierre-caja.ts', 'src/features/printing/components/CierreCajaA4.tsx', 'src/features/branches/consolidado-caja.ts', 'src/features/branches/components/ConsolidadoCaja.tsx', 'src/features/branches/cierre-desglose-datos.ts']
check('>>> ningún reporte de caja lee ni nombra el costo de los productos', sinCostos.every((f) => !/costPrice|unitCost|averageCost|\bcosto\b/i.test(src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/bajoCosto|bajo costo|bajo el piso/gi, ''))))

console.log('\nE) Suma de desgloses (consolidado)')
const d1 = construirDesglose({ ventas: [{ numero: 'V-1', status: 'COMPLETADA', total: 100, discountTotal: 5, bajoCosto: true }], pagos: [{ method: 'YAPE', amount: 100, change: 0 }], devoluciones: [], abonos: [{ method: 'PLIN', amount: 10 }], pagosProveedor: [], movimientos: [{ kind: 'EGRESO', category: 'GASTO_MENOR', amount: 7.5 }] })
const d2 = construirDesglose({ ventas: [{ numero: 'V-2', status: 'ANULADA', total: 50.1, discountTotal: 0, bajoCosto: true }, { numero: 'V-1', status: 'COMPLETADA', total: 1, discountTotal: 0, bajoCosto: false }], pagos: [{ method: 'EFECTIVO', amount: 60, change: 9.9 }, { method: 'YAPE', amount: 0.1, change: 0 }], devoluciones: [{ mode: 'CAJA', method: 'EFECTIVO', amount: 20 }], abonos: [], pagosProveedor: [], movimientos: [{ kind: 'EGRESO', category: 'GASTO_MENOR', amount: 2.6 }] })
const suma: DesgloseCierre = sumarDesgloses([d1, d2])
check('>>> las ventas, los medios y los descuentos se suman al céntimo', suma.ventas.cantidad === 3 && suma.ventas.total === 151.1 && suma.ventasPorMetodo.YAPE.monto === 100.1 && suma.ventasPorMetodo.YAPE.operaciones === 2 && suma.ventasPorMetodo.EFECTIVO.monto === 50.1 && suma.ventas.descuentos.total === 5 && suma.vueltos === 9.9)
check('>>> las anuladas, devoluciones, abonos y movimientos por categoría también', suma.ventas.anuladas.cantidad === 1 && suma.devoluciones.delCajon === 20 && suma.abonosPorMetodo.PLIN.monto === 10 && suma.movimientos.egresos.GASTO_MENOR === 10.1 && suma.movimientos.totalEgresos === 10.1)
check('>>> las ventas «bajo el piso» se unen sin repetir (solo números de venta, nunca costos)', JSON.stringify(suma.ventas.bajoCosto) === JSON.stringify({ cantidad: 2, ventas: ['V-1', 'V-2'] }))
check('>>> sumar uno es el mismo desglose; sumar ninguno es todo en cero; el orden no importa', JSON.stringify(sumarDesgloses([d1])) === JSON.stringify(d1) && sumarDesgloses([]).ventas.total === 0 && sumarDesgloses([]).cobradoNeto === 0 && JSON.stringify(sumarDesgloses([d1, d2])) === JSON.stringify(sumarDesgloses([d2, d1])))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exitCode = fail > 0 ? 1 : 0
