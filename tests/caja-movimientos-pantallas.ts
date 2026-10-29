import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { MovimientosCaja } from '../src/features/branches/components/MovimientosCaja'
import { CashPanel, LineasMovimientos } from '../src/features/branches/components/CashPanel'
import { TicketCierreCaja } from '../src/features/printing/components/TicketCierreCaja'
import { AyudaAbonos } from '../src/features/ventas/components/AyudaAbonos'
import { categoriasOfrecidas, evaluarFormulario, type EntradaFormulario } from '../src/features/branches/cash-movement-formulario'
import { anularMovimiento, registrarMovimiento } from '../src/features/branches/cash-movement-actions'
import type { FilaMovimiento } from '../src/features/branches/cash-movement-service'
import type { TicketCierre } from '../src/features/printing/cierre-caja'

/**
 * F6.3c · Las pantallas de movimientos de caja, renderizadas AISLADAS: el formulario y sus reglas en vivo (puras), la lista con anulación, las líneas en el
 * cierre y el ticket, la ayuda de abonos, las acciones de servidor (validación, sesión) y las páginas leídas como código. Lo que más importa: el arqueo
 * sigue a ciegas (ninguna pantalla enseña el efectivo esperado) y cada permiso ofrece solo lo que concede.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const src = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const codigo = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
// Una excepción cuenta como fallo de la prueba (✗), no como un aborto sin veredicto.
const seguro = <T,>(f: () => T, otro: T): T => { try { return f() } catch (e) { console.log(`    (excepción: ${e instanceof Error ? e.message.slice(0, 120) : e})`); return otro } }

const PC = { movimientos: true, ajuste: false }
const PA = { movimientos: true, ajuste: true }
const NINGUNO = { movimientos: false, ajuste: false }
const e = (o: Partial<EntradaFormulario> = {}): EntradaFormulario => ({ tipo: 'EGRESO', categoria: 'GASTO_MENOR', monto: '25', descripcion: 'Bolsas', referencia: '', ...o })

console.log('\nA) El formulario: categorías por permiso y validación en vivo (funciones puras)')
const cat = (tipo: 'INGRESO' | 'EGRESO', p: typeof PC) => categoriasOfrecidas(tipo, p).map((c) => c.valor).join()
check('>>> el cajero (caja.movimientos) ve solo gasto menor y «otro» en egresos, y solo «otro» en ingresos', cat('EGRESO', PC) === 'GASTO_MENOR,OTRO' && cat('INGRESO', PC) === 'OTRO', `${cat('EGRESO', PC)} | ${cat('INGRESO', PC)}`)
check('>>> con caja.ajuste ve todas las categorías de cada tipo', cat('EGRESO', PA) === 'GASTO_MENOR,RETIRO_DUENO,CORRECCION_ARQUEO,OTRO' && cat('INGRESO', PA) === 'REPOSICION_FONDO,CORRECCION_ARQUEO,OTRO', `${cat('EGRESO', PA)} | ${cat('INGRESO', PA)}`)
check('>>> sin ningún permiso no se ofrece nada', cat('EGRESO', NINGUNO) === '' && cat('INGRESO', NINGUNO) === '')
check('>>> nunca se ofrece la compensación (la hace el sistema)', !cat('EGRESO', PA).includes('COMPENSACION') && !cat('INGRESO', PA).includes('COMPENSACION'))
const ok1 = seguro(() => evaluarFormulario(e(), PC), null)
check('>>> un gasto menor de 25 con descripción es válido para el cajero, sin referencia', !!ok1 && ok1.ok && ok1.montoCent === 2500 && !ok1.referenciaObligatoria && ok1.permiso === 'caja.movimientos')
check('>>> los céntimos se redondean bien aunque el flotante falle (0.29 → 29, 1.15 → 115, 4.35 → 435)', seguro(() => [evaluarFormulario(e({ monto: '0.29' }), PC).montoCent, evaluarFormulario(e({ monto: '1.15' }), PC).montoCent, evaluarFormulario(e({ monto: '4.35' }), PC).montoCent].join(), '') === '29,115,435')
check('>>> el monto con coma decimal se entiende (12,50 → 1250)', seguro(() => evaluarFormulario(e({ monto: '12,50' }), PC).montoCent, null) === 1250)
for (const [n, monto] of [['vacío', ''], ['cero', '0'], ['negativo', '-5'], ['texto', 'abc'], ['tres decimales', '1.234'], ['infinito', '1e999'], ['más del máximo (S/ 10 millones)', '10000000']] as const) {
  const r = seguro(() => evaluarFormulario(e({ monto }), PC), null)
  check(`>>> monto ${n}: no es válido, no hay céntimos y se explica`, !!r && !r.ok && r.montoCent === null && r.errores.length > 0)
}
check('>>> un monto vacío dice «Escribe el monto.» (no el mensaje de formato)', seguro(() => evaluarFormulario(e({ monto: '' }), PC).errores[0], '') === 'Escribe el monto.')
check('>>> descripción de menos de 3 letras: no es válida', seguro(() => evaluarFormulario(e({ descripcion: 'ab' }), PC).ok, true) === false && seguro(() => evaluarFormulario(e({ descripcion: '  a ' }), PC).ok, true) === false)
check('>>> el tope: S/ 100.00 todavía lo puede el cajero; S/ 100.01 ya no (pide un administrador)', seguro(() => evaluarFormulario(e({ monto: '100' }), PC).ok, false) === true && seguro(() => evaluarFormulario(e({ monto: '100.01' }), PC).ok, true) === false)
check('>>> el administrador sí puede más de S/ 100 en gasto menor', seguro(() => evaluarFormulario(e({ monto: '100.01' }), PA).ok, false) === true)
check('>>> un retiro del dueño no lo hace un cajero aunque sea de S/ 1', seguro(() => evaluarFormulario(e({ categoria: 'RETIRO_DUENO', monto: '1' }), PC).ok, true) === false && seguro(() => evaluarFormulario(e({ categoria: 'RETIRO_DUENO', monto: '1' }), PA).ok, false) === true)
const r200 = seguro(() => evaluarFormulario(e({ categoria: 'RETIRO_DUENO', monto: '200' }), PA), null)
const r201 = seguro(() => evaluarFormulario(e({ categoria: 'RETIRO_DUENO', monto: '200.01' }), PA), null)
check('>>> la referencia: hasta S/ 200.00 no se exige; con S/ 200.01 de egreso sí', !!r200 && r200.ok && !r200.referenciaObligatoria && !!r201 && !r201.ok && r201.referenciaObligatoria)
check('>>> con S/ 200.01 y una referencia de 3 letras ya es válido; con 2 no', seguro(() => evaluarFormulario(e({ categoria: 'RETIRO_DUENO', monto: '200.01', referencia: 'R-1' }), PA).ok, false) === true && seguro(() => evaluarFormulario(e({ categoria: 'RETIRO_DUENO', monto: '200.01', referencia: 'R1' }), PA).ok, true) === false)
check('>>> un INGRESO grande nunca exige referencia', seguro(() => evaluarFormulario(e({ tipo: 'INGRESO', categoria: 'REPOSICION_FONDO', monto: '5000' }), PA).referenciaObligatoria, true) === false)
check('>>> un monto inválido y sin permiso suma los errores, no se queda con el primero', seguro(() => evaluarFormulario(e({ monto: '', descripcion: '' }), PC).errores.length, 0) >= 2)

console.log('\nB) El componente: formulario, lista y anulación')
const fila = (o: Partial<FilaMovimiento> = {}): FilaMovimiento => ({ id: randomUUID(), kind: 'EGRESO', category: 'GASTO_MENOR', method: 'EFECTIVO', amount: 25, description: 'Bolsas para el mostrador', reference: null, exceededExpected: false, createdAt: '2026-10-28T15:00:00.000Z', autor: 'Rosa', anulado: false, motivoAnulacion: null, esCompensacion: false, puedeAnular: true, ...o })
const mc = (o: Record<string, unknown> = {}) => html(createElement(MovimientosCaja, { movimientos: [], tiene: PC, puedeOperar: true, zonaHoraria: 'America/Lima', ...o } as never))
const h0 = seguro(() => mc(), '')
check('>>> con permiso se ve el formulario y el vacío de la lista', h0.includes('data-movimientos="formulario"') && h0.includes('Todavía no hay movimientos manuales en este turno'))
check('>>> el texto enseña los topes operativos para el cajero (S/ 100) y la referencia (S/ 200)', h0.includes('S/ 100.00') && h0.includes('S/ 200.00'))
check('>>> con caja.ajuste ya no se habla de topes para el cajero', !seguro(() => mc({ tiene: PA }), '').includes('Como cajero puedes registrar'))
const hSin = seguro(() => mc({ tiene: NINGUNO, movimientos: [fila()] }), '')
check('>>> sin permiso de registrar NO hay formulario, pero la lista se ve', !hSin.includes('data-movimientos="formulario"') && hSin.includes('Bolsas para el mostrador'))
check('>>> la categoría por defecto es gasto menor y las opciones del cajero son solo las suyas', h0.includes('Gasto menor') && !h0.includes('Retiro del dueño'))
check('>>> con caja.ajuste aparece el retiro del dueño', seguro(() => mc({ tiene: PA }), '').includes('Retiro del dueño'))
check('>>> el botón de registrar nace deshabilitado (formulario vacío) y el de exceso no aparece', /data-movimientos="registrar"[^>]*disabled/.test(h0) && !h0.includes('data-movimientos="exceso"'))
const comp = fila({ category: 'COMPENSACION_ABONO', description: 'Compensación de abono anulado', esCompensacion: true, puedeAnular: false })
const anul = fila({ anulado: true, motivoAnulacion: 'Monto equivocado', puedeAnular: false })
const hl = seguro(() => mc({ movimientos: [fila({ reference: 'REC-77' }), anul, comp, fila({ kind: 'INGRESO', category: 'REPOSICION_FONDO', amount: 200, puedeAnular: false }), fila({ method: 'YAPE', category: 'COMPENSACION_ABONO', esCompensacion: true, puedeAnular: false })] }), '')
check('>>> la lista muestra signo, importe, categoría, descripción, referencia, autor y fecha local', hl.includes('− S/ 25.00') && hl.includes('+ S/ 200.00') && hl.includes('Ref. REC-77') && hl.includes('Rosa') && hl.includes('28/10/2026'))
check('>>> el anulado sale tachado con su motivo, sin botón; la compensación dice que es automática y sin botón', hl.includes('data-anulado="si"') && hl.includes('line-through') && hl.includes('Anulado: Monto equivocado') && hl.includes('Automático: abono anulado de un turno cerrado'))
check('>>> hay botón «Anular» solo en la fila que se puede anular (1 de 5)', (hl.match(/data-movimientos="anular"/g) ?? []).length === 1)
check('>>> un movimiento por otro medio dice que no movió el cajón', hl.includes('No movió el cajón (informativo)'))
check('>>> NINGUNA pantalla del componente habla de «esperado» ni de «debía haber» (arqueo a ciegas)', !/esperad|deb[ií]a haber/i.test(hl + h0))
const fuenteComp = codigo('src/features/branches/components/MovimientosCaja.tsx')
check('>>> el aviso de exceso no lleva cifras y pide confirmar; reenvía con la MISMA clave y confirmaExceso true', fuenteComp.includes("res.code === 'CASH_EXCEEDS_EXPECTED'") && fuenteComp.includes('enviar(true)') && fuenteComp.includes('idempotencyKey: clave.current') && fuenteComp.includes('clave.current = nuevaClave()') && !/data-movimientos="exceso"[\s\S]{0,400}money\(/.test(fuenteComp))
check('>>> tras un error NO se renueva la clave (un reintento no duplica); solo tras guardar', fuenteComp.indexOf('setError(res.message); return') < fuenteComp.indexOf('clave.current = nuevaClave()'))
check('>>> la anulación pide motivo de al menos 3 letras antes de llamar a la acción', /motivo\.trim\(\)\.length < 3/.test(fuenteComp))
check('>>> el formulario se deshabilita con la cuenta en solo lectura y mientras guarda', fuenteComp.includes('disabled={pending || !puedeOperar || !ev.ok}') && fuenteComp.includes('disabled={pending || !puedeOperar}'))

console.log('\nC) Las líneas del cierre en CashPanel')
const M0 = { ingresos: 0, egresos: 0, compensacionesEfectivo: 0, compensacionesOtrosMedios: 0 }
const MX = { ingresos: 200, egresos: 300, compensacionesEfectivo: 15, compensacionesOtrosMedios: 7 }
const turno = (m = M0) => ({ id: 't1', openingAmount: 100, expectedAmount: 462, salesCount: 4, refundsCashTotal: 0, refundsOtherTotal: 0, movimientos: m, lista: [], openedAt: '2026-10-27T13:00:00.000Z', abiertoPor: 'Rosa' })
const cierre = (m = M0) => ({ id: 'c1', openingAmount: 100, countedAmount: 462, expectedAmount: 462, difference: 0, salesCount: 4, salesTotal: 800, cashTotal: 500, changeTotal: 20, creditSalesTotal: 0, cashReceiptsTotal: 0, otherReceiptsTotal: 0, supplierCashPaymentsTotal: 0, supplierOtherPaymentsTotal: 0, refundsCashTotal: 0, refundsOtherTotal: 0, movimientos: m, closedAt: '2026-10-27T23:00:00.000Z' })
const cp = (o: Record<string, unknown>) => html(createElement(CashPanel, { turno: null, ultimoCierre: null, sucursal: 'Central', puedeOperar: true, zonaHoraria: 'America/Lima', ...o } as never))
const lm = seguro(() => html(createElement(LineasMovimientos, { m: MX })), '')
check('>>> las cuatro líneas: ingresos (suman), egresos (restan), compensaciones en efectivo (restan) y por otros medios (informativo)', lm.includes('Ingresos manuales (suman)') && lm.includes('S/ 200.00') && lm.includes('Egresos manuales (restan)') && lm.includes('- S/ 300.00') && lm.includes('Compensaciones de abonos anulados en efectivo (restan)') && lm.includes('- S/ 15.00') && lm.includes('Compensaciones por otros medios (informativo)') && lm.includes('S/ 7.00'))
check('>>> sin movimientos no sale ninguna línea', !/manuales|Compensaciones/.test(seguro(() => html(createElement(LineasMovimientos, { m: M0 })), 'x')))
check('>>> solo salen las líneas con importe', !/Egresos manuales|Compensaciones/.test(seguro(() => html(createElement(LineasMovimientos, { m: { ...M0, ingresos: 50 } })), 'x')) && seguro(() => html(createElement(LineasMovimientos, { m: { ...M0, ingresos: 50 } })), '').includes('Ingresos manuales'))
const ht = seguro(() => cp({ turno: turno(MX), permisos: PC }), '')
check('>>> el turno abierto muestra el desglose y el panel de movimientos', ht.includes('Egresos manuales (restan)') && ht.includes('data-movimientos="panel"'))
check('>>> el turno abierto NO adelanta el efectivo esperado (462) aunque tenga movimientos', !ht.includes('462') && !/esperad|deb[ií]a haber/i.test(ht))
const hu = seguro(() => cp({ ultimoCierre: cierre(MX) }), '')
check('>>> el último cierre muestra el desglose congelado y lo que debía haber', hu.includes('Egresos manuales (restan)') && hu.includes('Ingresos manuales (suman)') && hu.includes('Debía haber'))
check('>>> sin turno abierto no hay panel de movimientos (solo se registran con la caja abierta)', !hu.includes('data-movimientos="panel"'))
const fuenteCp = codigo('src/features/branches/components/CashPanel.tsx')
check('>>> el resultado recién cerrado también lleva el desglose', fuenteCp.includes('<LineasMovimientos m={resultado.movimientos} />'))

console.log('\nD) El ticket de cierre')
const tk: TicketCierre = {
  numero: 'CC-20261028-ABC123', zonaHoraria: 'America/Lima', locale: 'es-PE',
  emisor: { nombre: 'Ferretería Demo', razonSocial: null, ruc: '20123456789', direccion: null, telefono: null }, sucursal: 'Central', caja: null, desglose: null, abrio: 'Rosa', cerro: 'Rosa',
  abiertoEn: '2026-10-28T13:00:00.000Z', cerradoEn: '2026-10-28T23:00:00.000Z', fondoInicial: 1000, ventasCantidad: 0, ventasTotal: 0, cobradoEfectivo: 0, vueltos: 0, abonosEfectivo: 0,
  pagosProveedorEfectivo: 0, devolucionesCajon: 0, devolucionesOtrosMedios: 0, ingresosManuales: 200, egresosManuales: 300, compensacionesEfectivo: 15, compensacionesOtrosMedios: 7,
  fiado: 0, abonosOtrosMedios: 0, pagosProveedorOtrosMedios: 0, esperado: 885, contado: 885, diferencia: 0, notas: null,
}
const ht1 = seguro(() => html(createElement(TicketCierreCaja, { ticket: tk } as never)), '')
check('>>> el ticket suma los ingresos, resta los egresos y las compensaciones en efectivo, cada uno en su línea', ht1.includes('data-ticket="ingresos-manuales"') && ht1.includes('+ Ingresos manuales') && ht1.includes('data-ticket="egresos-manuales"') && ht1.includes('- Egresos manuales') && ht1.includes('data-ticket="compensaciones-efectivo"'))
check('>>> la compensación por otro medio va en «Informativo (no tocó el cajón)», no en la cuenta del cajón', ht1.includes('data-ticket="compensaciones-otros"') && ht1.indexOf('compensaciones-otros') > ht1.indexOf('Informativo (no tocó el cajón)') && ht1.indexOf('compensaciones-otros') > ht1.indexOf('data-ticket="diferencia"'))
check('>>> las líneas manuales van ANTES del esperado (parte de la cuenta del cajón)', ht1.indexOf('data-ticket="egresos-manuales"') < ht1.indexOf('Esperado'))
const ht0 = seguro(() => html(createElement(TicketCierreCaja, { ticket: { ...tk, ingresosManuales: 0, egresosManuales: 0, compensacionesEfectivo: 0, compensacionesOtrosMedios: 0 } } as never)), '')
check('>>> sin movimientos el ticket queda como antes (ni líneas ni sección informativa)', !/ingresos-manuales|egresos-manuales|compensaciones-/.test(ht0) && !ht0.includes('Informativo (no tocó el cajón)'))
check('>>> solo compensación informativa: aparece la sección informativa', seguro(() => html(createElement(TicketCierreCaja, { ticket: { ...tk, ingresosManuales: 0, egresosManuales: 0, compensacionesEfectivo: 0 } } as never)), '').includes('Informativo (no tocó el cajón)'))

console.log('\nE) La ayuda de abonos en /ventas/[id]')
const ay1 = seguro(() => html(createElement(AyudaAbonos, { clienteId: 'cli-9', puedeAnularAbonos: true })), '')
check('>>> con credito.castigar y cliente: enlace a la ficha del cliente y explicación de la compensación', ay1.includes('href="/clientes/cli-9"') && ay1.includes('data-devolucion="enlace-abonos"') && ay1.includes('compensación'))
const ay2 = seguro(() => html(createElement(AyudaAbonos, { clienteId: 'cli-9', puedeAnularAbonos: false })), '')
check('>>> sin credito.castigar: NO hay enlace; se pide a un administrador', !ay2.includes('href=') && ay2.includes('administrador'))
const ay3 = seguro(() => html(createElement(AyudaAbonos, { clienteId: null, puedeAnularAbonos: true })), '')
check('>>> sin cliente en la venta no hay enlace', !ay3.includes('href='))
const pagVenta = codigo('src/app/(dashboard)/ventas/[id]/page.tsx'), formParcial = codigo('src/features/ventas/components/FormularioDevolucionParcial.tsx')
check('>>> la página muestra la ayuda solo para CREDIT_HAS_PAYMENTS (parcial y total) y decide con credito.castigar', pagVenta.includes("codigo === 'CREDIT_HAS_PAYMENTS'") && pagVenta.includes("puede(ctx, 'credito.castigar')") && pagVenta.includes('venta.cliente?.id') && pagVenta.includes('{ayuda(codigo)}'))
check('>>> el formulario parcial recibe la ayuda y la enseña solo cuando el cálculo en vivo se bloquea por abonos', formParcial.includes('ayudaAbonos') && /calc\.code === 'CREDIT_HAS_PAYMENTS' && ayudaAbonos/.test(formParcial))

async function acciones() {
console.log('\nF) Las acciones de servidor')
const accion = codigo('src/features/branches/cash-movement-actions.ts')
check('>>> el archivo es de Server Actions', accion.trimStart().startsWith("'use server'"))
for (const [n, f, raw] of [
  ['registrar sin nada', registrarMovimiento, {}],
  ['registrar monto 0', registrarMovimiento, { kind: 'EGRESO', category: 'GASTO_MENOR', amount: 0, description: 'abc', idempotencyKey: randomUUID() }],
  ['registrar categoría que no es de ese tipo', registrarMovimiento, { kind: 'INGRESO', category: 'GASTO_MENOR', amount: 5, description: 'abc', idempotencyKey: randomUUID() }],
  ['registrar la compensación a mano', registrarMovimiento, { kind: 'EGRESO', category: 'COMPENSACION_ABONO', amount: 5, description: 'abc', idempotencyKey: randomUUID() }],
  ['registrar clave que no es UUID', registrarMovimiento, { kind: 'EGRESO', category: 'GASTO_MENOR', amount: 5, description: 'abc', idempotencyKey: 'x' }],
  ['anular sin motivo', anularMovimiento, { movementId: 'm1', reason: '' }],
  ['anular sin id', anularMovimiento, { reason: 'abc' }],
] as const) {
  const r = await (f as (x: unknown) => Promise<{ ok: boolean; code?: string; message?: string }>)(raw).catch((x) => ({ ok: true, code: `LANZÓ ${x}`, message: undefined }))
  check(`>>> ${n}: VALIDATION con mensaje en español, antes de tocar sesión ni base`, !r.ok && r.code === 'VALIDATION' && !!r.message && r.message.length > 0)
}
const sinSesionR = await registrarMovimiento({ kind: 'EGRESO', category: 'GASTO_MENOR', amount: 5, description: 'abc', idempotencyKey: randomUUID() }).catch(() => ({ ok: true as const }))
const sinSesionA = await anularMovimiento({ movementId: 'm1', reason: 'abc' }).catch(() => ({ ok: true as const }))
check('>>> con datos válidos pero SIN sesión devuelven un fallo tipado (no lanzan ni operan)', !sinSesionR.ok && !sinSesionA.ok)
const ia = accion.indexOf('export async function anularMovimiento'), tr = accion.slice(accion.indexOf('export async function registrarMovimiento'), ia), ta = accion.slice(ia)
check('>>> las dos validan con zod ANTES de la sesión y revalidan /caja y /dashboard solo si salió bien', [tr, ta].every((t) => t.indexOf('safeParse') < t.indexOf('conTenant') && /if \(r\.ok\) \{ revalidatePath\('\/caja'\); revalidatePath\('\/dashboard'\) \}/.test(t)))
check('>>> las acciones no deciden permisos (los decide el servicio con caja.movimientos / caja.ajuste) y no leen el rol del navegador', !/puede\(|role|permisos/.test(accion.replace(/\/\*\*[\s\S]*?\*\//, '')))
check('>>> el error inesperado no filtra detalles al navegador', accion.includes("message: 'No pudimos completar la operación. Intenta de nuevo.'"))

console.log('\nG) Las páginas, leídas como código')
const pagCaja = codigo('src/app/(dashboard)/caja/page.tsx')
check('>>> /caja pasa los permisos de movimientos y ajuste, la lista del turno y el desglose del último cierre', pagCaja.includes("movimientos: puede(ctx, 'caja.movimientos')") && pagCaja.includes("ajuste: puede(ctx, 'caja.ajuste')") && pagCaja.includes('listarMovimientosDelTurno(db, ctx, turnoRaw.id)') && pagCaja.includes('desgloseDeMovimientos(db, ultimo.id)'))
check('>>> ni CashPanel ni MovimientosCaja leen jamás el esperado del turno abierto (solo se pinta al cerrar)', !/turno\.expectedAmount/.test(fuenteCp) && !/expectedAmount|esperado/i.test(fuenteComp.replace(/exceededExpected|CASH_EXCEEDS_EXPECTED/g, '')))
const cierreSrv = codigo('src/features/printing/cierre-caja.ts')
check('>>> el ticket lee los totales congelados manualInTotal / manualOutTotal (no recalcula con movimientos vivos) y solo separa las compensaciones', cierreSrv.includes('manualInTotal: true, manualOutTotal: true') && cierreSrv.includes('num(s.manualInTotal)') && cierreSrv.includes('num(s.manualOutTotal) - mov.compensacionesEfectivo'))

}

acciones().then(() => {
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
})
