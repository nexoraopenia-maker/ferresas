import { existsSync, readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ConteosLista, InsigniaEstado } from '../src/features/inventory/components/ConteosLista'
import { AccionesConteo } from '../src/features/inventory/components/AccionesConteo'
import { NuevoConteoForm } from '../src/features/inventory/components/NuevoConteoForm'
import { ContarConteo } from '../src/features/inventory/components/ContarConteo'
import { RevisionTabla } from '../src/features/inventory/components/RevisionTabla'
import { AccionesLinea } from '../src/features/inventory/components/AccionesLinea'
import { BarraRevision } from '../src/features/inventory/components/BarraRevision'
import { ActaConteoDoc } from '../src/features/inventory/components/ActaConteoDoc'
import {
  AYUDA_MODO, ETIQUETA_ALCANCE, ETIQUETA_ALERTA, ETIQUETA_ESTADO, ETIQUETA_ESTADO_LINEA, ETIQUETA_MODO, accionesDisponibles, enlaceActa, enlaceContar, enlaceConteo, enlaceConteos, enlaceCsvConteo, enlaceRevision, evaluarPasada,
  type PermisosConteo, type PresentacionElegible,
} from '../src/features/inventory/conteo-ui'
import {
  anularPasadaAccion, aplicarConteoAccion, aprobarLineaAccion, aprobarSinAlertasAccion, buscarProductosAccion, buscarProductosSeleccionAccion, cancelarConteoAccion, cerrarConteoAccion, crearConteoAccion,
  iniciarConteoAccion, misPasadasAccion, rechazarLineaAccion, registrarPasadaAccion, resolverProductoAccion, solicitarRecuentoAccion,
} from '../src/features/inventory/conteo-actions'
import type { FilaConteo } from '../src/features/inventory/conteo-lista'
import type { EstadoRevision, LineaRevision } from '../src/features/inventory/conteo-revision'
import type { ActaConteo } from '../src/features/inventory/conteo-documentos'
import { visibleItems, isActive, NAV_ITEMS } from '../src/features/shell/nav-items'
import { permisosDe } from '../src/lib/puede'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.5c · Las pantallas de la toma de inventario, renderizadas AISLADAS: lo puro (nombres, enlaces, qué se ofrece y la comprobación en vivo de una pasada), cada componente con datos
 * armados, el menú, las acciones de servidor (validación antes de la sesión) y las páginas leídas como código. Lo que más importa: la pantalla de contar es CIEGA, los costos no
 * existen para quien no los ve y cada botón aparece solo si el estado y los permisos lo permiten.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const src = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const codigo = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
// Una excepción cuenta como fallo de la prueba (✗), no como un aborto sin veredicto.
const seguro = <T,>(f: () => T, otro: T): T => { try { return f() } catch (e) { console.log(`    (excepción: ${e instanceof Error ? e.message.slice(0, 140) : e})`); return otro } }
const cuenta = (h: string, re: RegExp) => (h.match(re) ?? []).length

const TODO: PermisosConteo = { gestionar: true, registrar: true, aprobar: true, verRevision: true }
const NADA: PermisosConteo = { gestionar: false, registrar: false, aprobar: false, verRevision: false }
const SIN = { porRecontar: false, aplicadas: false }

async function main() {
console.log('\nA) Nombres y enlaces (puro)')
check('>>> los estados se nombran en español', ETIQUETA_ESTADO.BORRADOR === 'Borrador' && ETIQUETA_ESTADO.EN_CONTEO === 'En conteo' && ETIQUETA_ESTADO.EN_REVISION === 'En revisión' && ETIQUETA_ESTADO.APLICADO === 'Aplicado' && ETIQUETA_ESTADO.CANCELADO === 'Cancelado')
check('>>> alcance, modo, estados de línea y alertas tienen etiqueta', ETIQUETA_ALCANCE.TOTAL === 'Todo el almacén' && ETIQUETA_MODO.CIEGO === 'Ciego' && ETIQUETA_ESTADO_LINEA.RECONTAR === 'Por recontar' && ETIQUETA_ALERTA.SOBRE_UMBRAL.includes('recontar') && ETIQUETA_ALERTA.SIN_COSTO === 'Producto sin costo' && AYUDA_MODO.CIEGO.includes('no ve lo que dice el sistema'))
check('>>> los enlaces', enlaceConteos() === '/inventario/conteos' && enlaceConteo('c1') === '/inventario/conteos/c1' && enlaceContar('c1') === '/inventario/conteos/c1/contar' && enlaceCsvConteo('c1') === '/api/inventario/conteos/c1')
check('>>> la revisión conserva el filtro y la página; el acta pide el detalle o la impresión automática', enlaceRevision('c1') === '/inventario/conteos/c1/revision' && enlaceRevision('c1', { estado: 'RECONTAR', cursor: 'x1' }) === '/inventario/conteos/c1/revision?estado=RECONTAR&cursor=x1' && enlaceActa('c1') === '/imprimir/acta-conteo/c1' && enlaceActa('c1', { todo: true, auto: true }) === '/imprimir/acta-conteo/c1?detalle=todo&auto=1')
check('>>> un id raro se codifica (no inyecta parámetros)', enlaceConteo('a/b?c=1') === '/inventario/conteos/a%2Fb%3Fc%3D1')

console.log('\nB) Qué se ofrece según el estado y los permisos')
const ac = (e: Parameters<typeof accionesDisponibles>[0], p: PermisosConteo, h = SIN) => accionesDisponibles(e, p, h)
check('>>> BORRADOR: quien gestiona puede iniciar y cancelar; nada más', (() => { const a = ac('BORRADOR', TODO); return a.iniciar && a.cancelar && !a.cerrar && !a.contar && !a.verRevision && !a.acta })())
check('>>> EN_CONTEO: se cuenta, se cierra, se cancela, se ven las diferencias y el CSV; aún no hay acta ni se decide', (() => { const a = ac('EN_CONTEO', TODO); return a.contar && a.cerrar && a.cancelar && a.verRevision && a.csv && !a.acta && !a.decidir && !a.iniciar })())
check('>>> EN_REVISION: se decide, hay acta y CSV; contar solo si hay algo por recontar', (() => { const a = ac('EN_REVISION', TODO); const b = ac('EN_REVISION', TODO, { porRecontar: true, aplicadas: false }); return a.decidir && a.acta && a.csv && a.verRevision && !a.contar && b.contar && !a.cerrar })())
check('>>> con ajustes ya aplicados no se ofrece cancelar', ac('EN_REVISION', TODO, { porRecontar: false, aplicadas: true }).cancelar === false && ac('EN_REVISION', TODO).cancelar === true)
check('>>> APLICADO: solo mirar (diferencias, acta, CSV); nada que cambiar', (() => { const a = ac('APLICADO', TODO); return a.verRevision && a.acta && a.csv && !a.contar && !a.decidir && !a.cancelar && !a.iniciar && !a.cerrar })())
check('>>> CANCELADO: no se ofrece nada', Object.values(ac('CANCELADO', TODO)).every((x) => x === false))
check('>>> sin permisos no se ofrece nada en ningún estado', (['BORRADOR', 'EN_CONTEO', 'EN_REVISION', 'APLICADO', 'CANCELADO'] as const).every((e) => Object.values(ac(e, NADA, { porRecontar: true, aplicadas: false })).every((x) => x === false)))
check('>>> quien solo VE la revisión (conteo.gestionar) no decide: decidir es de quien aprueba', (() => { const a = ac('EN_REVISION', { ...NADA, gestionar: true, verRevision: true }); return a.verRevision && a.acta && !a.decidir })())
check('>>> un permiso = un poder: quien solo cuenta cuenta; quien solo gestiona gestiona; quien solo aprueba decide', (() => {
  const c = ac('EN_CONTEO', { ...NADA, registrar: true }), g = ac('EN_CONTEO', { ...NADA, gestionar: true, verRevision: true }), d = ac('EN_REVISION', { ...NADA, aprobar: true, verRevision: true })
  return c.contar && !c.cerrar && !c.verRevision && !c.csv && !g.contar && g.cerrar && g.verRevision && d.decidir && !d.cancelar && !d.contar
})())

console.log('\nC) Comprobación en vivo de una pasada (puro)')
const U = 'UNIDAD' as const, KG = 'KILOGRAMO' as const
const CAJA: PresentacionElegible = { id: 'pr1', nombre: 'Caja x12', unidad: 'CAJA', factor: '12' }
const ep = (cantidad: string, unidad: typeof U | typeof KG = U, presentacion: PresentacionElegible | null = null, zona = '') => seguro(() => evaluarPasada({ cantidad, unidad, presentacion, zona }), { ok: false, errores: ['EXCEPCIÓN'], cantidadBase: null, presentationId: null, enteredQuantity: null, zona: undefined })
check('>>> una cantidad entera de unidades es válida', (() => { const r = ep('12'); return r.ok && r.cantidadBase === 12 && r.presentationId === null && r.errores.length === 0 })())
check('>>> la coma decimal se entiende (2,5 kg) y las unidades enteras no admiten fracciones', ep('2,5', KG).cantidadBase === 2.5 && ep('2,5', U).ok === false && /enteras/.test(ep('2,5', U).errores[0] ?? ''))
check('>>> los kilos admiten hasta 3 decimales; 4, no', ep('1.125', KG).ok && !ep('1.1255', KG).ok)
check('>>> contar CERO es válido', ep('0').ok && ep('0').cantidadBase === 0 && ep('0', KG).ok)
check('>>> vacío, negativo, texto y absurdos no valen y dicen por qué', !ep('').ok && /Escribe la cantidad/.test(ep('').errores[0]!) && !ep('-3').ok && !ep('abc').ok && !ep('1e3').ok && !ep('1,2,3').ok && !ep('1000000000').ok && /sin signo/.test(ep('-3').errores[0]!))
check('>>> en cajas: 2 cajas × 12 = 24 unidades, con la presentación y la cantidad ingresada', (() => { const r = ep('2', U, CAJA); return r.ok && r.cantidadBase === 24 && r.presentationId === 'pr1' && r.enteredQuantity === '2' })())
const SACO: PresentacionElegible = { id: 'pr2', nombre: 'Saco 25 kg', unidad: 'KILOGRAMO', factor: '25' }
check('>>> las cajas se cuentan enteras (media caja no); un saco de 25 kg admite 0,5 (= 12,5 kg) pero no lo que da más de 3 decimales de kilo', !ep('0,5', U, CAJA).ok && ep('0,5', KG, SACO).cantidadBase === 12.5 && !ep('0,3333', KG, SACO).ok)
check('>>> cero cajas se manda como cero unidades, sin presentación (la conversión no admite cero)', (() => { const r = ep('0', U, CAJA); return r.ok && r.cantidadBase === 0 && r.presentationId === null && r.enteredQuantity === null })())
check('>>> la zona se recorta; vacía = sin zona; más de 40 caracteres no vale', ep('1', U, null, '  Pasillo 3 ').zona === 'Pasillo 3' && ep('1', U, null, '   ').zona === undefined && !ep('1', U, null, 'z'.repeat(41)).ok && ep('1', U, null, 'z'.repeat(40)).ok)

console.log('\nD) El listado')
const fila = (o: Partial<FilaConteo> = {}): FilaConteo => ({
  id: 'c1', number: 'CF001-00000007', status: 'EN_CONTEO', scope: 'TOTAL', mode: 'CIEGO', warehouse: { id: 'w1', name: 'Almacén central' }, categoryId: null, notes: null, lineas: 120, contadas: 45, pendientes: 75, pasadas: 52,
  createdAt: '2026-10-05T15:00:00.000Z', startedAt: '2026-10-05T15:10:00.000Z', closedAt: null, creadoPor: 'Rosa', iniciadoPor: 'Rosa', cerradoPor: null, aplicadoPor: null, canceladoPor: null, aplicadoEn: null, canceladoEn: null, motivoCancelacion: null, ...o,
})
const hv = seguro(() => html(createElement(ConteosLista, { filas: [], zona: 'America/Lima' })), '')
check('>>> sin conteos lo dice', hv.includes('data-conteos="vacio"') && hv.includes('Todavía no hay tomas de inventario'))
const hl = seguro(() => html(createElement(ConteosLista, { filas: [fila(), fila({ id: 'c2', number: 'CF001-00000006', status: 'APLICADO', closedAt: '2026-10-04T20:00:00.000Z', aplicadoEn: '2026-10-04T21:00:00.000Z', aplicadoPor: 'Luis', cerradoPor: 'Rosa', lineas: 30, contadas: 30, pendientes: 0 }), fila({ id: 'c3', status: 'CANCELADO', canceladoEn: '2026-10-03T15:00:00.000Z', canceladoPor: 'Rosa', lineas: 0, contadas: 0, pendientes: 0 })], zona: 'America/Lima' })), '')
check('>>> cada conteo es una fila con su número enlazado, almacén, alcance y modo', cuenta(hl, /data-conteo="/g) === 3 && hl.includes('href="/inventario/conteos/c1"') && hl.includes('CF001-00000007') && hl.includes('Almacén central') && hl.includes('Todo el almacén') && hl.includes('Conteo ciego'))
check('>>> una fecha cerca de la medianoche se muestra en la hora del negocio: las 22:30 de Lima del 5 (03:30 UTC del 6) es el 5', seguro(() => html(createElement(ConteosLista, { filas: [fila({ createdAt: '2026-10-06T03:30:00.000Z' })], zona: 'America/Lima' })), '').includes('Creada 05/10/2026'))
check('>>> el estado sale como insignia con su color; el avance, «45 de 120» (o «—» sin líneas)', hl.includes('data-conteo-estado="EN_CONTEO"') && hl.includes('data-conteo-estado="APLICADO"') && hl.includes('data-conteo-estado="CANCELADO"') && hl.includes('45 de 120') && hl.includes('30 de 30') && hl.includes('>—<'))
check('>>> fechas en la hora del negocio y los responsables de cada paso', hl.includes('Creada 05/10/2026') && hl.includes('Aplicada 04/10/2026') && hl.includes('Cancelada 03/10/2026') && hl.includes('Creó Rosa') && hl.includes('Aplicó Luis') && hl.includes('Canceló Rosa'))
check('>>> la tabla se desliza dentro de su caja (la página no se ensancha en el móvil)', hl.includes('overflow-x-auto') && hl.includes('min-w-['))
check('>>> la insignia sola', html(createElement(InsigniaEstado, { estado: 'EN_REVISION' })).includes('En revisión'))

console.log('\nE) Los botones del ciclo')
const ba = (a: Partial<Record<'iniciar' | 'cerrar' | 'cancelar', boolean>>) => seguro(() => html(createElement(AccionesConteo, { countId: 'c1', acciones: { iniciar: false, cerrar: false, cancelar: false, ...a } })), 'ERROR')
check('>>> sin ninguna acción posible no se pinta nada', ba({}) === '')
check('>>> iniciar explica que se toma una foto y que las ventas no se detienen', ba({ iniciar: true }).includes('data-accion="iniciar"') && ba({ iniciar: true }).includes('Las ventas no se detienen'))
check('>>> cerrar explica que ya no entran más conteos', ba({ cerrar: true }).includes('data-accion="cerrar"') && ba({ cerrar: true }).includes('ya no entran más conteos'))
check('>>> cancelar se ofrece como botón (el motivo se pide después)', ba({ cancelar: true }).includes('data-accion="cancelar"') && !ba({ cancelar: true }).includes('data-conteo="cancelar"'))
const fuenteAcc = codigo('src/features/inventory/components/AccionesConteo.tsx'), fuenteNuevo = codigo('src/features/inventory/components/NuevoConteoForm.tsx')
check('>>> cancelar exige un motivo de 3 letras antes de habilitarse', fuenteAcc.includes('motivo.trim().length < 3}') && /data-accion="confirmar-cancelar" disabled=\{pendiente \|\| !enLinea \|\| motivo/.test(fuenteAcc))
check('>>> crear una selección sin productos se rechaza en la pantalla, y la clave de creación nace una vez y se renueva solo al salir bien', fuenteNuevo.includes("alcance === 'SELECCION' && elegidos.length === 0") && fuenteNuevo.includes('const clave = useRef(crypto.randomUUID())') && fuenteNuevo.indexOf('idempotencyKey: clave.current') < fuenteNuevo.indexOf('clave.current = crypto.randomUUID()'))
check('>>> solo aparecen los botones que se pidieron', !ba({ iniciar: true }).includes('data-accion="cerrar"') && !ba({ iniciar: true }).includes('data-accion="cancelar"') && ba({ iniciar: true, cancelar: true }).includes('data-accion="cancelar"'))

console.log('\nF) Crear una toma')
const nf = seguro(() => html(createElement(NuevoConteoForm, { almacenes: [{ id: 'w1', nombre: 'Central' }, { id: 'w2', nombre: 'Norte' }], categorias: [{ id: 'k1', nombre: 'Cementos' }] })), '')
check('>>> el formulario ofrece los almacenes, los tres alcances y los dos modos (ciego marcado)', nf.includes('data-conteos="nuevo"') && nf.includes('Central') && nf.includes('Norte') && nf.includes('Todo el almacén') && nf.includes('Por categoría') && nf.includes('Selección de productos') && /aria-pressed="true"[^>]*>Conteo ciego/.test(nf))
check('>>> explica la diferencia entre ciego y guiado', nf.includes('no ve lo que dice el sistema'))
check('>>> al inicio no pide categoría ni productos (alcance: todo el almacén)', !nf.includes('data-conteos="seleccion"') && !nf.includes('>Categoría<'))
check('>>> el botón de crear nace habilitado con almacén, y sin almacén no', !/data-conteos="crear"[^>]*disabled=""/.test(nf) && /data-conteos="crear"[^>]*disabled=""/.test(seguro(() => html(createElement(NuevoConteoForm, { almacenes: [], categorias: [] })), '')))

console.log('\nG) La pantalla de contar es CIEGA')
const ct = seguro(() => html(createElement(ContarConteo, { countId: 'c1', numero: 'CF001-00000007', almacen: 'Central', enRevision: false })), '')
check('>>> dice qué conteo es y que no se muestra lo que dice el sistema', ct.includes('Contando · CF001-00000007') && ct.includes('Central') && ct.includes('data-contar="ciego"') && ct.includes('No se muestra lo que dice el sistema'))
check('>>> trae el campo de código, el botón de buscar y el de escanear con la cámara', ct.includes('Escanea o escribe') && ct.includes('data-contar="buscar"') && ct.includes('data-contar="escanear"'))
check('>>> sin producto elegido no hay formulario de cantidad, y la lista de pasadas propias nace vacía', !ct.includes('data-contar="producto"') && ct.includes('Todavía no has contado nada'))
check('>>> NO existe ninguna palabra ni campo de existencias: ni «stock», ni «sistema espera», ni «debería haber»', !/stock hoy|existencias|deber[ií]a haber|el sistema (dice|espera|tiene)|saldo/i.test(ct.replace('No se muestra lo que dice el sistema', '')))
const cr = seguro(() => html(createElement(ContarConteo, { countId: 'c1', numero: 'CF001-00000007', almacen: 'Central', enRevision: true })), '')
check('>>> en revisión se llama «Recuento» y avisa que solo se cuenta lo mandado a recontar', cr.includes('Recuento · CF001-00000007') && cr.includes('data-contar="recuento"') && cr.includes('mandó a recontar') && !ct.includes('data-contar="recuento"'))
const fuenteContar = codigo('src/features/inventory/components/ContarConteo.tsx')
check('>>> y el texto de la pantalla del producto elegido tampoco habla de existencias, stock de hoy ni de lo que «debería haber»', !/existencias|stock hoy|deber[ií]a haber|el sistema (espera|tiene)/i.test(fuenteContar.replace('No se muestra lo que dice el sistema', '')))
check('>>> el código de la pantalla no lee nada del sistema (ni sistemaAlEmpezar ni stockActual ni systemQty)', !/sistemaAlEmpezar|stockActual|systemQty|sistemaAlContar|\.stock\b/.test(fuenteContar))
const ramaError = fuenteContar.slice(fuenteContar.indexOf('await registrarPasadaAccion('), fuenteContar.indexOf("setAviso({ tipo: 'ok'", fuenteContar.indexOf('await registrarPasadaAccion(')))
check('>>> la clave de idempotencia nace al registrar y SE CONSERVA si falla (solo se limpia al salir bien o al cambiar de producto)', /clave\.current \?\?= crypto\.randomUUID\(\)/.test(fuenteContar) && ramaError.includes('if (!r.ok)') && !ramaError.includes('clave.current = null') && fuenteContar.includes('clave.current = null\n      setProducto(null)'))
check('>>> el registro está deshabilitado sin red, sin cantidad válida o mientras guarda', fuenteContar.includes('disabled={pendiente || !enLinea || !ev.ok || cantidad.trim() === \'\'}'))
check('>>> corregir un error al momento: anular la propia pasada exige un motivo de 3 letras', fuenteContar.includes('motivo.trim().length < 3') && fuenteContar.includes('data-contar="confirmar-anulacion"'))

console.log('\nH) La tabla de revisión')
const lin = (o: Partial<LineaRevision> = {}): LineaRevision => ({
  id: 'i1', productId: 'p1', variantId: null, nombre: 'Cemento Sol', sku: 'CEM-1', unidad: 'UNIDAD', estado: 'CONTADO', contado: 8, sistemaAlContar: 10, diferencia: -2, porcentaje: 0.2, movimientosDesdeContar: 1, stockActual: 8,
  alertas: ['SOBRE_UMBRAL', 'MOVIDO_DESPUES'], causasUmbral: ['PORCENTAJE'], notaRevision: null, aplicada: false, ...o,
})
const hr = (lineas: LineaRevision[], conCostos = false, puedeDecidir = true) => seguro(() => html(createElement(RevisionTabla, { countId: 'c1', lineas, conCostos, puedeDecidir })), '')
const conC = (o: Partial<LineaRevision> = {}) => lin({ costos: { costoPromedio: 10, valorDiferencia: 20 }, ...o })
check('>>> sin líneas lo dice', hr([]).includes('data-revision="vacio"'))
const h1 = hr([lin(), lin({ id: 'i2', sku: 'B', nombre: 'Clavos', contado: 11, sistemaAlContar: 10, diferencia: 1, porcentaje: 0.1, alertas: [], causasUmbral: [], movimientosDesdeContar: 0, stockActual: 11 })])
check('>>> columnas: producto, contado, sistema al contar, diferencia, %, movimientos después, stock hoy, estado y decidir (sin costos)', ['Contado', 'Sistema al contar', 'Diferencia', 'Mov. después', 'Stock hoy', 'Estado', 'Decidir'].every((t) => h1.includes(t)) && !/Costo prom|Valor dif/.test(h1))
check('>>> la diferencia grande se resalta en la fila, con su alerta y su causa («más del 10 %»); la chica no', /data-linea="i1"[^>]*data-grande="si"/.test(h1) && /data-linea="i2"[^>]*data-grande="no"/.test(h1) && h1.includes('Diferencia grande: conviene recontar (más del 10 %)') && h1.includes('Se movió después de contar'))
check('>>> el signo de la diferencia: −2 en rojo, +1 en verde', h1.includes('text-stock-out">-2<') && h1.includes('text-stock-ok">+1<'))
const hCv = hr([conC({ causasUmbral: ['VALOR'], contado: 1050, sistemaAlContar: 1000, diferencia: 50, porcentaje: 0.05 })], true)
check('>>> CON costos aparecen las columnas de costo y valor, y la causa por valor («más de S/ 200»)', hCv.includes('Costo prom.') && hCv.includes('Valor dif.') && hCv.includes('S/ 10.00') && hCv.includes('S/ 20.00') && hCv.includes('más de S/ 200'))
check('>>> SIN costos (revisor sin ver costos): ni columnas ni cifras, y la causa genérica «grande» sin decir cuánto', !/Costo prom|Valor dif|S\//.test(hr([lin({ causasUmbral: ['GRANDE'] })])) && hr([lin({ causasUmbral: ['GRANDE'] })]).includes('(grande)'))
check('>>> el porcentaje con el sistema en cero es «n/d»; una línea sin contar muestra guiones', hr([lin({ porcentaje: null, sistemaAlContar: 0, contado: 3, diferencia: 3 })]).includes('n/d') && hr([lin({ estado: 'PENDIENTE', contado: null, sistemaAlContar: null, diferencia: null, porcentaje: null, alertas: [], causasUmbral: [], movimientosDesdeContar: 0 })]).includes('>—<'))
check('>>> DEJARIA_NEGATIVO sale en rojo; SIN_COSTO y MOVIDO en ámbar', hr([lin({ alertas: ['DEJARIA_NEGATIVO'] })]).includes('data-alerta="DEJARIA_NEGATIVO"') && /data-alerta="DEJARIA_NEGATIVO"[^>]*bg-stock-out-soft/.test(hr([lin({ alertas: ['DEJARIA_NEGATIVO'] })])) && /data-alerta="MOVIDO_DESPUES"[^>]*bg-stock-low-soft/.test(h1))
check('>>> sin permiso para decidir ni siquiera existe la columna «Decidir»', h1.includes('>Decidir<') && !hr([lin()], false, false).includes('>Decidir<'))
check('>>> los botones de decidir existen SOLO con permiso y sin aplicar', h1.includes('data-linea-acciones="i1"') && !hr([lin()], false, false).includes('data-linea-acciones') && !hr([lin({ aplicada: true })]).includes('data-linea-acciones'))
check('>>> una línea aplicada lo dice', hr([lin({ estado: 'APROBADO', aplicada: true })]).includes('data-linea-aplicada') && hr([lin({ estado: 'APROBADO', aplicada: true })]).includes('Aplicada al stock'))
check('>>> la nota del revisor se ve', hr([lin({ notaRevision: 'Se vendió en el mostrador' })]).includes('Nota: Se vendió en el mostrador'))

console.log('\nI) Las decisiones por línea')
const al = (estado: LineaRevision['estado'], alertas: LineaRevision['alertas'] = []) => seguro(() => html(createElement(AccionesLinea, { countId: 'c1', linea: { id: 'i1', estado, alertas, nombre: 'Cemento' } })), 'ERROR')
check('>>> una línea CONTADA se aprueba, se recuenta o se rechaza', ['aprobar', 'recontar', 'rechazar'].every((a) => al('CONTADO').includes(`data-accion="${a}"`)))
check('>>> una APROBADA ya no se aprueba (se puede recontar o rechazar)', !al('APROBADO').includes('data-accion="aprobar"') && al('APROBADO').includes('data-accion="recontar"') && al('APROBADO').includes('data-accion="rechazar"'))
check('>>> una RECHAZADA se puede aprobar o recontar, no rechazar otra vez', al('RECHAZADO').includes('data-accion="aprobar"') && al('RECHAZADO').includes('data-accion="recontar"') && !al('RECHAZADO').includes('data-accion="rechazar"'))
check('>>> una que ya está por RECONTAR o sin contar no ofrece aprobar ni rechazar', !al('RECONTAR').includes('data-accion="aprobar"') && !al('RECONTAR').includes('data-accion="rechazar"') && !al('RECONTAR').includes('data-accion="recontar"') && !al('PENDIENTE').includes('data-accion="aprobar"'))
const fuenteLinea = codigo('src/features/inventory/components/AccionesLinea.tsx')
check('>>> una diferencia grande NO se aprueba de un toque: primero pide confirmar (y si el servidor la rechaza por grande, vuelve a preguntar)', fuenteLinea.includes("(grande ? setPaso('confirmar-umbral') : aprobar(false))") && fuenteLinea.includes("code === 'COUNT_OVER_THRESHOLD'") && fuenteLinea.includes('aprobar(true)'))
check('>>> recontar y rechazar exigen un motivo de 3 letras', (fuenteLinea.match(/motivo\.trim\(\)\.length < 3/g) ?? []).length >= 1 && fuenteLinea.includes('data-accion={`confirmar-${paso}`}'))

console.log('\nJ) La barra de la revisión')
const est = (o: Partial<EstadoRevision> = {}): EstadoRevision => ({ lineas: 9, sinContar: 1, contadas: 3, porRecontar: 0, aprobadas: 4, rechazadas: 1, aplicadas: 0, porAplicar: 4, ...o })
const bb = (e: EstadoRevision, puedeDecidir = true, aplicable = true) => seguro(() => html(createElement(BarraRevision, { countId: 'c1', estado: e, puedeDecidir, aplicable })), 'ERROR')
check('>>> muestra el estado de las decisiones: líneas, sin contar, por decidir, por recontar, aprobadas, rechazadas', ['Líneas', 'Sin contar', 'Por decidir', 'Por recontar', 'Aprobadas', 'Rechazadas'].every((t) => bb(est()).includes(t)))
check('>>> quien puede decidir ve «Aprobar todas sin alerta» y «Aplicar conteo»', bb(est()).includes('data-revision="aprobar-limpias"') && bb(est()).includes('data-revision="aplicar"'))
check('>>> sin permiso para decidir no hay ningún botón', !bb(est(), false).includes('data-revision="aprobar-limpias"') && !bb(est(), false).includes('data-revision="aplicar"'))
check('>>> si todavía no se puede aplicar (hay por decidir o por recontar) no se ofrece «Aplicar»', !bb(est(), true, false).includes('data-revision="aplicar"') && bb(est(), true, false).includes('data-revision="aprobar-limpias"'))
check('>>> «Aprobar todas sin alerta» se deshabilita si no hay nada por decidir', /data-revision="aprobar-limpias"[^>]*disabled=""/.test(bb(est({ contadas: 0 }))) && !/data-revision="aprobar-limpias"[^>]*disabled=""/.test(bb(est())))
check('>>> con ajustes ya aplicados lo dice y cuántos faltan', bb(est({ aplicadas: 3, porAplicar: 2 })).includes('3 ajuste(s) ya aplicados') && bb(est({ aplicadas: 3, porAplicar: 2 })).includes('faltan 2'))
const fuenteBarra = codigo('src/features/inventory/components/BarraRevision.tsx')
check('>>> aplicar pide confirmación explícita (no se deshace) y repite por tandas hasta quedar APLICADO', fuenteBarra.includes("setConfirmando(true)") && fuenteBarra.includes('data-revision="confirmar"') && fuenteBarra.includes("r.data.estado === 'APLICADO'") && fuenteBarra.includes('Las ventas hechas desde que se contó se conservan'))
check('>>> si una tanda falla, informa cuántos ajustes ya se aplicaron', fuenteBarra.includes('ya se aplicaron ${movimientos} ajuste(s)'))

console.log('\nK) El acta (A4)')
const acta = (o: Partial<ActaConteo> = {}): ActaConteo => ({
  numero: 'CF001-00000007', estado: 'APLICADO', emisor: { nombre: 'Ferretería Demo', razonSocial: 'Demo SAC', ruc: '20123456789', direccion: 'Av. Principal 123' }, sucursal: 'Sucursal 1', almacen: 'Central', alcance: 'Todo el almacén', modo: 'Ciego', notas: 'Inventario de octubre',
  zonaHoraria: 'America/Lima', locale: 'es-PE', fechas: { creado: '2026-10-05T15:00:00.000Z', iniciado: '2026-10-05T15:10:00.000Z', cerrado: '2026-10-05T20:00:00.000Z', aplicado: '2026-10-06T14:00:00.000Z' },
  responsables: { creo: 'Rosa', inicio: 'Rosa', cerro: 'Rosa', aplico: 'Luis', contadores: ['Ana', 'Beto'] }, conCostos: false, detalleCompleto: false, truncado: false,
  resumen: { lineas: 100, sinContar: 4, sinDiferencia: 90, conDiferencia: 6, aprobadas: 5, rechazadas: 1, porRecontar: 0, sobrantes: 7, faltantes: 3, netas: 4 },
  lineas: [{ nombre: 'Cemento Sol', sku: 'CEM-1', unidad: 'UNIDAD', estado: 'APROBADO', contado: 8, sistemaAlContar: 10, diferencia: -2, nota: null }, { nombre: 'Clavos', sku: 'CLA-1', unidad: 'UNIDAD', estado: 'RECHAZADO', contado: 20, sistemaAlContar: 10, diferencia: 10, nota: 'Se vendió sin registrar' }], ...o,
})
const ha = (a: ActaConteo) => seguro(() => html(createElement(ActaConteoDoc, { acta: a })), '')
const hA = ha(acta())
check('>>> el encabezado: negocio, RUC, «ACTA DE TOMA DE INVENTARIO», número y estado', hA.includes('Ferretería Demo') && hA.includes('RUC 20123456789') && hA.includes('ACTA DE TOMA DE INVENTARIO') && hA.includes('CF001-00000007 · Aplicado'))
check('>>> sucursal, almacén, alcance, modo, fechas locales y responsables (creó, inició, cerró, aplicó, contaron)', hA.includes('Sucursal 1') && hA.includes('Central') && hA.includes('Conteo ciego') && hA.includes('05/10/2026') && hA.includes('Luis') && hA.includes('Ana, Beto') && hA.includes('Inventario de octubre'))
check('>>> el resumen: líneas, sin contar, sin diferencia, con diferencia, aprobadas, rechazadas, sobrantes +7, faltantes −3, netas +4', ['Sin diferencia', 'Con diferencia', 'Aprobadas', 'Rechazadas', 'Sobrantes aprobados', 'Faltantes aprobados', '+7', '−3', '+4'].every((t) => hA.includes(t)))
check('>>> el detalle lista contado, sistema y diferencia de cada línea con su estado y nota', hA.includes('data-acta="detalle"') && cuenta(hA, /data-acta-linea/g) === 2 && hA.includes('Cemento Sol') && hA.includes('>-2<') && hA.includes('Rechazada') && hA.includes('Se vendió sin registrar'))
check('>>> SIN costos: ni la fila de valores ni la columna Valor ni un solo importe', !hA.includes('data-acta="valores"') && !/>Valor</.test(hA) && !/S\//.test(hA))
const hAc = ha(acta({ conCostos: true, resumen: { ...acta().resumen, valorSobrantes: 70, valorFaltantes: 30, sinCosto: 1 }, lineas: [{ ...acta().lineas[0]!, valorDiferencia: 20 }] }))
check('>>> CON costos: la fila de valores (sobrantes, faltantes, sin costo) y la columna Valor', hAc.includes('data-acta="valores"') && hAc.includes('S/ 70.00') && hAc.includes('S/ 30.00') && />Valor</.test(hAc) && hAc.includes('S/ 20.00'))
check('>>> las tres firmas: almacenero, contador y dueño, con espacio para firmar', hA.includes('data-acta="firmas"') && hA.includes('Almacenero') && hA.includes('Contador') && hA.includes('Dueño') && cuenta(hA, /class="firma"/g) === 3 && hA.includes('Nombre y firma'))
check('>>> es A4: trae su @page y se imprime sin sombra ni fondo oscuro', hA.includes('size: A4') && hA.includes('@media print') && hA.includes('box-shadow: none'))
check('>>> sin diferencias lo dice; el detalle completo cambia el título; truncado avisa', ha(acta({ lineas: [] })).includes('data-acta="sin-diferencias"') && ha(acta({ detalleCompleto: true })).includes('Detalle completo') && hA.includes('Diferencias y líneas observadas') && ha(acta({ detalleCompleto: true, truncado: true })).includes('data-acta="truncado"') && !hA.includes('data-acta="truncado"'))
check('>>> aclara qué es «el sistema» (el kardex a la hora de contar) y que es un documento interno', hA.includes('lo que decía el kardex a la hora en que se contó') && hA.includes('Documento interno'))

console.log('\nL) El menú y los accesos')
const enMenu = (rol: Role) => visibleItems([...permisosDe({ tenantId: 't', userId: 'u', role: rol, access: 'FULL', permisosExtra: [] } as TenantContext)]).some((i) => i.href === '/inventario/conteos')
check('>>> «Toma de inventario» en el menú: dueño, administrador y almacenero; no cajero, vendedor ni contador', (['OWNER', 'ADMIN', 'ALMACENERO'] as Role[]).every(enMenu) && !enMenu('CAJERO') && !enMenu('VENDEDOR') && !enMenu('CONTADOR'))
check('>>> en /inventario/conteos se marca ese enlace y NO «Inventario»; en /inventario/kardex, solo «Kardex»', isActive('/inventario/conteos', '/inventario/conteos/abc/contar') && !isActive('/inventario', '/inventario/conteos') && NAV_ITEMS.filter((i) => isActive(i.href, '/inventario/conteos/abc')).length === 1 && NAV_ITEMS.filter((i) => isActive(i.href, '/inventario/kardex')).length === 1)
const ins = codigo('src/app/(dashboard)/inventario/page.tsx')
check('>>> /inventario ofrece el botón «Toma de inventario» solo a quien puede ver conteos', /puedeVerConteos\(ctx\) && \(\s*<Link href="\/inventario\/conteos"/.test(ins))

console.log('\nM) Las acciones de servidor')
const accion = codigo('src/features/inventory/conteo-actions.ts')
check('>>> el archivo es de Server Actions', accion.trimStart().startsWith("'use server'"))
const raws: [string, (r: unknown) => Promise<{ ok: boolean; code?: string; message?: string }>, unknown][] = [
  ['crear sin nada', crearConteoAccion, {}], ['crear por categoría sin categoría', crearConteoAccion, { warehouseId: 'w', scope: 'CATEGORIA', idempotencyKey: '00000000-0000-4000-8000-000000000001' }], ['iniciar sin id', iniciarConteoAccion, {}], ['cerrar sin id', cerrarConteoAccion, { countId: '' }],
  ['cancelar sin motivo', cancelarConteoAccion, { countId: 'c' }], ['pasada negativa', registrarPasadaAccion, { countId: 'c', productId: 'p', quantity: -1, idempotencyKey: '00000000-0000-4000-8000-000000000001' }], ['pasada sin clave', registrarPasadaAccion, { countId: 'c', productId: 'p', quantity: 1 }],
  ['anular sin motivo', anularPasadaAccion, { entryId: 'e', reason: '' }], ['resolver sin código', resolverProductoAccion, { countId: 'c', code: '' }], ['buscar con texto enorme', buscarProductosAccion, { countId: 'c', q: 'x'.repeat(81) }],
  ['selección con texto enorme', buscarProductosSeleccionAccion, { q: 'x'.repeat(81) }], ['mis pasadas sin conteo', misPasadasAccion, {}], ['recontar sin motivo', solicitarRecuentoAccion, { countId: 'c', itemId: 'i', reason: 'ab' }],
  ['aprobar con confirmación que no es booleana', aprobarLineaAccion, { countId: 'c', itemId: 'i', confirmaUmbral: 'si' }], ['rechazar sin motivo', rechazarLineaAccion, { countId: 'c', itemId: 'i' }], ['aprobar sin alertas sin conteo', aprobarSinAlertasAccion, {}], ['aplicar con nota enorme', aplicarConteoAccion, { countId: 'c', note: 'x'.repeat(121) }],
]
for (const [n, f, raw] of raws) {
  const r = await f(raw).catch((x) => ({ ok: true, code: `LANZÓ ${x}`, message: undefined }))
  check(`>>> ${n}: VALIDATION con mensaje en español, antes de tocar sesión ni base`, !r.ok && r.code === 'VALIDATION' && !!r.message && r.message.length > 0)
}
const sinSesion = await Promise.all([
  iniciarConteoAccion({ countId: 'c1' }).catch(() => ({ ok: true })), registrarPasadaAccion({ countId: 'c1', productId: 'p1', quantity: 1, idempotencyKey: '00000000-0000-4000-8000-000000000002' }).catch(() => ({ ok: true })),
  aplicarConteoAccion({ countId: 'c1' }).catch(() => ({ ok: true })), aprobarLineaAccion({ countId: 'c1', itemId: 'i1' }).catch(() => ({ ok: true })), misPasadasAccion({ countId: 'c1' }).catch(() => ({ ok: true })),
])
check('>>> con datos válidos pero SIN sesión devuelven un fallo tipado (no lanzan ni operan)', sinSesion.every((r) => !r.ok))
const accionesTxt = ['crearConteoAccion', 'iniciarConteoAccion', 'cerrarConteoAccion', 'cancelarConteoAccion', 'registrarPasadaAccion', 'anularPasadaAccion', 'solicitarRecuentoAccion', 'aprobarLineaAccion', 'rechazarLineaAccion', 'aprobarSinAlertasAccion', 'aplicarConteoAccion']
const cuerpoDe = (n: string) => accion.slice(accion.indexOf(`export async function ${n}`)).split('\nexport async function ')[0]!
check('>>> las que cambian algo validan con zod ANTES de la sesión y revalidan solo si salió bien', accionesTxt.every((n) => { const t = cuerpoDe(n); return t.indexOf('safeParse') < t.indexOf('conTenant') && /if \(r\.ok\)/.test(t) }))
check('>>> aplicar refresca también el inventario, el kardex, las alertas y el panel (el stock cambió)', ['/inventario', '/inventario/kardex', '/inventario/alertas', '/dashboard', '/panel'].every((p) => cuerpoDe('aplicarConteoAccion').includes(`revalidatePath('${p}')`)))
check('>>> las acciones no deciden permisos ni leen el rol (lo deciden los servicios) y el error inesperado no filtra detalles', !/puede\(|role|permisos/.test(accion.replace(/\/\*\*[\s\S]*?\*\//, '')) && accion.includes("message: 'No pudimos completar la operación. Intenta de nuevo.'"))

console.log('\nN) Las páginas, leídas como código')
const pLista = codigo('src/app/(dashboard)/inventario/conteos/page.tsx'), pDet = codigo('src/app/(dashboard)/inventario/conteos/[id]/page.tsx')
const pContar = codigo('src/app/(dashboard)/inventario/conteos/[id]/contar/page.tsx'), pRev = codigo('src/app/(dashboard)/inventario/conteos/[id]/revision/page.tsx')
const pActa = codigo('src/app/(print)/imprimir/acta-conteo/[id]/page.tsx'), apiCsv = codigo('src/app/api/inventario/conteos/[id]/route.ts')
check('>>> todas exigen sesión y permiso ANTES de leer nada (sin permiso: 404)', [pLista, pDet, pContar, pRev].every((p) => p.includes('requireTenantContext()') && /notFound\(\)/.test(p)) && /if \(!puedeVerConteos\(ctx\)\) notFound\(\)/.test(pLista) && /if \(!puedeVerConteos\(ctx\)\) notFound\(\)/.test(pDet) && /if \(!puede\(ctx, 'conteo\.registrar'\)\) notFound\(\)/.test(pContar) && /if \(!puedeVerRevision\(ctx\)\) notFound\(\)/.test(pRev))
check('>>> el listado solo ofrece crear a quien gestiona y no usa el PIN de operador', pLista.includes("puede(ctx, 'conteo.gestionar') && !ctx.operadorDe") && pLista.includes('gestiona && almacenes.length > 0'))
check('>>> decidir exige stock.ajustar y NO el PIN de operador; aplicar solo con todo decidido', pRev.includes("puede(ctx, 'stock.ajustar') && !ctx.operadorDe && rev.conteo.status === 'EN_REVISION'") && pRev.includes('est.porRecontar === 0 && est.contadas === 0'))
check('>>> la página de contar ni siquiera lee la cantidad del sistema (no usa revisión ni stock)', !/revisionDelConteo|estadoDeRevision|\.stock\b|systemQty|sistemaAlContar/.test(pContar) && pContar.includes("c.status === 'EN_CONTEO' || (c.status === 'EN_REVISION' && porRecontar > 0)"))
check('>>> el detalle ofrece cada enlace solo si corresponde (contar, revisar, acta, CSV)', pDet.includes('a.contar &&') && pDet.includes('a.verRevision &&') && pDet.includes('a.acta &&') && pDet.includes('a.csv &&') && pDet.includes('accionesDisponibles('))
check('>>> las páginas de revisión no leen costos por su cuenta (lo decide el servicio)', !/costPrice|unitCost|costAfter/.test(pRev + pDet + pLista))
check('>>> el acta es un 404 si no existe, no se puede ver o el conteo no está cerrado; el CSV responde 401/403/404/400', ['NOT_FOUND', 'FORBIDDEN_ROLE', 'INVALID_DOCUMENT'].every((c) => pActa.includes(`'${c}'`)) && pActa.includes("detalle === 'todo'") && apiCsv.includes('status: 401') && apiCsv.includes("'FORBIDDEN_ROLE' ? 403") && apiCsv.includes("'NOT_FOUND' ? 404 : 400") && apiCsv.includes('respuestaCsv('))

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
