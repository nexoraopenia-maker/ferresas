import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { anularAbono, anularCuenta, configurarCredito, registrarAbono, sumarDias, hoyEnZona } from '../src/features/credito/credito-service'
import { anularAbonoSchema, configurarCreditoSchema, registrarAbonoSchema } from '../src/features/credito/schemas'
import { openCashSession } from '../src/features/branches/cash-service'
import { openCashSchema } from '../src/features/branches/cash-schemas'
import { crearCliente, listarClientes, obtenerFichaCliente, puedeVerClientes, type FichaCliente, type FilaCliente } from '../src/features/clientes/service'
import { crearClienteSchema, listarClientesSchema } from '../src/features/clientes/schemas'
import { PERMISOS_VER_CLIENTES } from '../src/features/clientes/permisos'
import { leerMonto, METODOS_ABONO, MENSAJE_ABONO_ELIGE_CUENTA, MENSAJE_ABONO_SIN_CAJA, MENSAJE_ABONO_SIN_DEUDA, previsualizarAbono, type CuentaAbonable } from '../src/features/clientes/abono-ui'
import { mensajeAbonoExcede, repartirAbono } from '../src/features/credito/reglas'
import { ClientesLista, enlaceFiltro } from '../src/features/clientes/components/ClientesLista'
import { FormularioCliente, MENSAJE_DOC_BLOQUEADO } from '../src/features/clientes/components/FormularioCliente'
import { ConfigCredito } from '../src/features/clientes/components/ConfigCredito'
import { VistaAbono } from '../src/features/clientes/components/ModalAbono'
import { CuentasYAbonos } from '../src/features/clientes/components/CuentasYAbonos'
import { FichaClienteVista, cuentasAbonables, type PermisosFicha } from '../src/features/clientes/components/FichaClienteVista'
import { visibleItems } from '../src/features/shell/nav-items'
import { permisosDe } from '../src/lib/puede'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 3, subpaso 5.3: las pantallas de clientes (lista, ficha y modal de abono), renderizadas AISLADAS, sin navegador.
 * Lo que más importa: cada botón aparece solo con su permiso, la vista previa del abono es lo que el servidor registra (y dice lo
 * mismo cuando lo rechaza), la mora avisa sin bloquear, y el menú, la página y el servicio deciden con la misma lista de permisos.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => null).catch((e) => (e as Error).message)
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
/** Renderiza dentro de un router de prueba (los componentes usan `useRouter`). */
/** La etiqueta completa (<input …> o <button …>) que lleva `marca`. El orden de los atributos lo decide React: se mira la etiqueta entera. */
const etiqueta = (h: string, marca: string): string => { const i = h.indexOf(marca); if (i < 0) return ''; const a = h.lastIndexOf('<', i); return h.slice(a, h.indexOf('>', i) + 1) }
const deshabilitado = (h: string, marca: string) => /\sdisabled=""/.test(etiqueta(h, marca))
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: { slug: `cp-${tag}-${randomUUID().slice(0, 6)}`, name: `Pantallas ${tag}`, legalName: `PANTALLAS ${tag.toUpperCase()} SAC`, taxId, planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cl' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const mk = async (role: Role) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, u.id, b1.branch.id)
    return u
  }
  const ctxs: Record<string, TenantContext> = {}
  for (const r of ['OWNER', 'ADMIN', 'CAJERO', 'VENDEDOR', 'ALMACENERO', 'CONTADOR'] as Role[]) {
    const u = await mk(r)
    ctxs[r] = { tenantId: t.id, userId: u.id, role: r, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: r === 'CAJERO' ? ['credito.otorgar'] : [] }
  }
  const dbOf = (c: TenantContext) => getTenantPrisma(c)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Producto', salePrice: 100 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: b1.warehouse.id, quantity: 10000 } })
  const O = ctxs.OWNER!
  const vender = (monto: number, payments: { method: string; amount: number }[], customerId: string, c: TenantContext = O) =>
    registerSale(dbOf(c), c, { warehouseId: b1.warehouse.id, customerId, items: [{ productId: prod.id, quantity: monto / 100, discount: 0 }], payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() } as never)
  const linea = (customerId: string, limite: number, dias = 30) => configurarCredito(dbOf(O), O, configurarCreditoSchema.parse({ customerId, creditLimit: limite, creditTermDays: dias, bloqueado: false }))
  const abrirCaja = () => openCashSession(dbOf(O), O, openCashSchema.parse({ openingAmount: 0 }))
  return { t, b1, ctxs, dbOf, prod, vender, linea, abrirCaja, O }
}



async function main() {
  const cuenta = (id: string, venta: string, saldo: number, vence = '2026-12-01', vencida = false): CuentaAbonable => ({ id, venta, saldo, vence, vencida })
  const cuentas = [cuenta('a', 'V001-1', 200, '2026-09-01', true), cuenta('b', 'V001-2', 100), cuenta('c', 'V001-3', 50)]
  const prev = (o: Partial<Parameters<typeof previsualizarAbono>[0]> = {}) => previsualizarAbono({ cuentas, elegidas: null, texto: '250', metodo: 'YAPE', cajaAbierta: true, deudaTotal: 350, ...o })

  console.log('\nA) Lógica del modal de abono (pura)')
  check('>>> el monto acepta coma decimal; vacío = null; letras, cero, negativo o 3 decimales = inválido', leerMonto('12,50') === 12.5 && leerMonto(' 7 ') === 7 && leerMonto('') === null && [leerMonto('abc'), leerMonto('0'), leerMonto('-5'), leerMonto('1.005'), leerMonto('1,2,3')].every(Number.isNaN))
  const v1 = prev()
  check('>>> 250 «a la más antigua primero» sobre [200, 100, 50]: 200 (saldada) + 50 de la segunda (quedan 50); deuda después 100', v1.listo && v1.partes.length === 2 && v1.partes[0]!.monto === 200 && v1.partes[0]!.pagada && v1.partes[1]!.monto === 50 && v1.partes[1]!.saldoDespues === 50 && v1.deudaDespues === 100)
  const v2 = prev({ elegidas: ['c', 'b'], texto: '120' })
  check('>>> eligiendo [c, b]: el ORDEN ELEGIDO manda (50 a «c», 70 a «b»), no el de antigüedad', v2.listo && v2.partes.map((p) => `${p.id}:${p.monto}`).join(',') === 'c:50,b:70' && v2.deudaDestino === 150)
  const v3 = prev({ elegidas: ['c'], texto: '60' })
  check('>>> mismo mensaje que el servidor: abonar de más en las cuentas ELEGIDAS', !v3.listo && v3.error === mensajeAbonoExcede(60, 50, true) && /en las cuentas elegidas/.test(v3.error!))
  const v4 = prev({ texto: '400' })
  check('abonar más que toda la deuda → mismo mensaje sin «cuentas elegidas», no listo', !v4.listo && v4.error === mensajeAbonoExcede(400, 350, false) && !/elegidas/.test(v4.error!))
  check('>>> sin deuda → «no tiene deuda pendiente»; elegir manual sin marcar ninguna → pide elegir', prev({ cuentas: [], texto: '10', deudaTotal: 0 }).error === MENSAJE_ABONO_SIN_DEUDA && prev({ elegidas: [] }).error === MENSAJE_ABONO_ELIGE_CUENTA)
  check('>>> EFECTIVO con la caja cerrada → bloquea con el mensaje del servidor; Yape con la caja cerrada NO; caja «desconocida» no bloquea (decide el servidor)', prev({ metodo: 'EFECTIVO', cajaAbierta: false }).error === MENSAJE_ABONO_SIN_CAJA && prev({ metodo: 'YAPE', cajaAbierta: false }).listo && prev({ metodo: 'EFECTIVO', cajaAbierta: null }).listo)
  check('monto vacío: no listo y sin error (todavía no escribió); inválido → error claro', !prev({ texto: '' }).listo && prev({ texto: '' }).error === null && /mayor que cero/.test(prev({ texto: '1.005' }).error!))
  let malos = 0
  for (let i = 0; i < 1000; i++) {
    const cs = Array.from({ length: 1 + Math.floor(Math.random() * 5) }, (_, k) => cuenta(`x${k}`, `V-${k}`, (1 + Math.floor(Math.random() * 30000)) / 100))
    const deuda = Math.round(cs.reduce((a, x) => a + Math.round(x.saldo * 100), 0)) / 100
    const monto = (1 + Math.floor(Math.random() * (Math.round(deuda * 100) + 500))) / 100
    const v = previsualizarAbono({ cuentas: cs, elegidas: null, texto: String(monto), metodo: 'YAPE', cajaAbierta: true, deudaTotal: deuda })
    const esperado = repartirAbono(cs.map((x) => x.saldo), monto)
    const ok = v.listo === (esperado.sobrante === 0) && v.partes.length === esperado.partes.length && v.partes.every((p, k) => p.monto === esperado.partes[k]!.monto)
      && (!v.listo || (Math.round(v.partes.reduce((a, p) => a + p.monto * 100, 0)) === Math.round(monto * 100) && v.deudaDespues === Math.round((deuda - monto) * 100) / 100))
    if (!ok) malos++
  }
  check('>>> 1000 casos al azar: la vista previa == repartirAbono (el del servidor); si es «listo», Σ partes = monto y la deuda después = deuda − monto', malos === 0, `${malos} incoherentes`)

  console.log('\nB) Lista de clientes')
  const fila = (o: Partial<FilaCliente> = {}): FilaCliente => ({ id: 'c1', name: 'Ana Quispe', docType: 'DNI', docNumber: '41300001', phone: '987654321', limite: 1000, deuda: 300, disponible: 700, bloqueado: false, activo: true, vencido: 0, cuentasVencidas: 0, ...o })
  const lista = (o: Partial<Parameters<typeof ClientesLista>[0]> = {}) => html(createElement(ClientesLista, { inicial: { items: [fila()], siguiente: null }, filtro: 'TODOS', puedeGestionar: true, puedeOperar: true, ...o }))
  const hL = lista()
  check('>>> cada cliente es un enlace a su ficha, con documento, teléfono, lo que debe y lo disponible', hL.includes('href="/clientes/c1"') && hL.includes('DNI 41300001') && hL.includes('987654321') && hL.includes('Debe S/ 300.00') && hL.includes('Disponible S/ 700.00 de S/ 1000.00'))
  const hI = lista({ inicial: { items: [fila({ id: 'm', vencido: 120, cuentasVencidas: 2 }), fila({ id: 'b', bloqueado: true, deuda: 0 }), fila({ id: 'x', activo: false, docNumber: null, docType: 'SIN_DOCUMENTO', limite: 0, deuda: 0 })], siguiente: null } })
  check('>>> insignias: mora en NARANJA con el monto, crédito bloqueado en rojo, de baja; sin documento se dice; sin deuda se dice', hI.includes('data-insignia="mora"') && hI.includes('stock-low') && hI.includes('Vencido S/ 120.00') && hI.includes('data-insignia="bloqueado"') && hI.includes('data-insignia="baja"') && hI.includes('Sin documento') && hI.includes('Sin deuda'))
  check('>>> «Nuevo cliente» solo con clientes.gestionar (el cajero ve la lista, no crea)', hL.includes('data-boton="nuevo-cliente"') && !lista({ puedeGestionar: false }).includes('data-boton="nuevo-cliente"'))
  check('>>> el filtro «De baja» solo lo ve quien gestiona', hL.includes('De baja') && !lista({ puedeGestionar: false }).includes('>De baja<'))
  check('>>> «Cargar más» solo si hay otra página', !hL.includes('data-boton="cargar-mas"') && lista({ inicial: { items: [fila()], siguiente: 'c1' } }).includes('data-boton="cargar-mas"'))
  check('>>> sin clientes: mensaje distinto si es por la búsqueda o si todavía no hay ninguno', lista({ inicial: { items: [], siguiente: null } }).includes('Todavía no hay clientes') && lista({ inicial: { items: [], siguiente: null }, q: 'zzz' }).includes('Ningún cliente coincide') && lista({ inicial: { items: [], siguiente: null }, filtro: 'VENCIDOS' }).includes('Ningún cliente coincide'))
  check('>>> el filtro activo queda marcado, la búsqueda conserva el filtro y los enlaces de filtro conservan la búsqueda', lista({ filtro: 'CON_DEUDA', q: 'ana' }).includes('aria-current="page"') && lista({ filtro: 'CON_DEUDA', q: 'ana' }).includes('name="filtro" value="CON_DEUDA"') && enlaceFiltro('VENCIDOS', 'ana') === '/clientes?filtro=VENCIDOS&q=ana' && enlaceFiltro('TODOS', undefined) === '/clientes' && enlaceFiltro('TODOS', 'ana') === '/clientes?q=ana')

  console.log('\nC) Formularios del cliente')
  const datos = { id: 'c1', name: 'Ana Quispe', docNumber: '41300001', phone: '987654321', email: null, address: null, notes: null }
  const fc = html(createElement(FormularioCliente, { modo: 'crear', documentoEditable: true }))
  check('>>> alta: nombre, documento, teléfono, correo, dirección y notas — y NINGÚN campo de crédito (eso es de otro permiso)', ['name', 'docNumber', 'phone', 'email', 'address', 'notes'].every((n) => fc.includes(`name="${n}"`)) && !/creditLimit|creditTermDays|bloquea/i.test(fc))
  const fe = html(createElement(FormularioCliente, { modo: 'editar', inicial: datos, documentoEditable: false }))
  check('>>> edición con ventas: el documento aparece DESHABILITADO con la explicación; el resto sigue editable', deshabilitado(fe, 'name="docNumber"') && fe.includes(MENSAJE_DOC_BLOQUEADO) && !deshabilitado(fe, 'name="name"'))
  const fe2 = html(createElement(FormularioCliente, { modo: 'editar', inicial: datos, documentoEditable: true }))
  check('sin ventas el documento sí se edita, sin aviso; el valor actual viene cargado', !deshabilitado(fe2, 'name="docNumber"') && !fe2.includes('data-aviso="doc-bloqueado"') && fe2.includes('value="Ana Quispe"') && fe2.includes('value="41300001"'))

  console.log('\nD) Línea de crédito')
  const cc = (o: Partial<Parameters<typeof ConfigCredito>[0]> = {}) => html(createElement(ConfigCredito, { customerId: 'c1', limite: 500, plazoDias: 30, bloqueado: false, documentoValido: true, puedeEditar: true, ...o }))
  check('>>> con credito.limite los campos se editan y está el botón de guardar', !deshabilitado(cc(), 'name="creditLimit"') && cc().includes('Guardar crédito') && cc().includes('value="500"') && cc().includes('value="30"'))
  const ccL = cc({ puedeEditar: false })
  check('>>> sin credito.limite se VEN los valores pero deshabilitados, sin botón y con la explicación', deshabilitado(ccL, 'name="creditLimit"') && deshabilitado(ccL, 'name="bloqueado"') && deshabilitado(ccL, 'name="creditTermDays"') && !ccL.includes('Guardar crédito') && ccL.includes('data-aviso="solo-lectura"'))
  check('>>> cliente sin DNI/RUC válido: avisa que no se le puede dar línea (a quien puede darla)', cc({ documentoValido: false }).includes('data-aviso="sin-documento"') && !cc({ documentoValido: false, puedeEditar: false }).includes('data-aviso="sin-documento"'))

  console.log('\nE) El modal de abono')
  const base: Parameters<typeof VistaAbono>[0] = {
    nombre: 'Ana Quispe', cuentas, metodo: 'YAPE', texto: '250', referencia: '', elegirManual: false, elegidas: [], cajaAbierta: true,
    vista: prev(), enviando: false, errorServidor: null, resultado: null, enLinea: true,
    onMetodo: noop, onTexto: noop, onReferencia: noop, onElegirManual: noop, onAlternarCuenta: noop, onEnviar: noop, onCerrar: noop,
  }
  const va = (o: Partial<typeof base> = {}) => html(createElement(VistaAbono, { ...base, ...o }))
  const hA = va()
  check('>>> es un diálogo accesible; los métodos NO incluyen el fiado (abonar no es fiar) y el botón dice cuánto cobra', hA.includes('role="dialog"') && hA.includes('aria-modal="true"') && METODOS_ABONO.every((m) => (m.value as string) !== 'CREDITO') && !hA.includes('>Fiado<') && hA.includes('Cobrar S/ 250.00'))
  check('>>> la vista previa muestra a qué cuentas va cada sol y la deuda después', hA.includes('data-abono="vista-previa"') && hA.includes('V001-1') && hA.includes('queda saldada') && hA.includes('S/ 200.00') && hA.includes('Deuda del cliente después: S/ 100.00'))
  check('>>> EFECTIVO con la caja cerrada: alerta visible, error del servidor en la vista y el botón Cobrar DESHABILITADO', (() => { const h = va({ metodo: 'EFECTIVO', cajaAbierta: false, vista: prev({ metodo: 'EFECTIVO', cajaAbierta: false }) }).replace(/\n/g, ' '); return h.includes('data-abono="sin-caja"') && h.includes(MENSAJE_ABONO_SIN_CAJA) && deshabilitado(h, 'data-boton="registrar-abono"') })())
  check('con Yape y la caja cerrada no hay alerta y se puede cobrar', !va({ cajaAbierta: false }).includes('data-abono="sin-caja"') && !deshabilitado(hA, 'data-boton="registrar-abono"'))
  const hM = va({ elegirManual: true, elegidas: ['c', 'b'], vista: prev({ elegidas: ['c', 'b'], texto: '120' }), texto: '120' })
  check('>>> «Elegir cuentas»: aparece la lista con cada saldo, la vencida marcada y el ORDEN de elección (1 y 2) en las marcadas', hM.includes('data-abono="cuentas"') && hM.includes('vencida') && hM.includes('aria-label="Orden 1"') && hM.includes('aria-label="Orden 2"') && !hA.includes('data-abono="cuentas"'))
  const hX = va({ vista: prev({ texto: '400' }), texto: '400' }).replace(/\n/g, ' ')
  check('>>> abonar de más: error en rojo con el texto del servidor y el botón deshabilitado', hX.includes('data-abono="error"') && hX.includes(mensajeAbonoExcede(400, 350, false)) && deshabilitado(hX, 'data-boton="registrar-abono"'))
  check('>>> un rechazo del servidor se muestra aparte; sin red lo dice y bloquea; mientras envía dice «Registrando»', va({ errorServidor: 'El turno ya cerró' }).includes('data-abono="error-servidor"') && va({ enLinea: false }).includes('data-abono="sin-red"') && deshabilitado(va({ enLinea: false }), 'data-boton="registrar-abono"') && va({ enviando: true }).includes('Registrando'))
  const hOk = va({ resultado: { monto: 250, deudaDespues: 100, reparto: [{ venta: 'V001-1', monto: 200, saldoDespues: 0, pagada: true }, { venta: 'V001-2', monto: 50, saldoDespues: 50, pagada: false }] } })
  check('>>> abono hecho: confirmación con el reparto real y la deuda restante; ya no se ofrece cobrar otra vez', hOk.includes('data-abono="hecho"') && hOk.includes('Abono de S/ 250.00 registrado') && hOk.includes('Deuda del cliente ahora: S/ 100.00') && !hOk.includes('data-boton="registrar-abono"'))

  console.log('\nF) Cuentas y abonos')
  const ct = (o: Partial<FichaCliente['cuentasAbiertas'][number]> = {}) => ({ id: 'r1', venta: 'V001-1', fecha: '2026-10-01T10:00:00.000Z', monto: 300, abonado: 100, saldo: 200, vence: '2026-10-10', status: 'ABIERTA' as const, vencida: true, enRevision: false, motivoRevision: null, ...o })
  const ab = (o: Partial<FichaCliente['abonos'][number]> = {}) => ({ id: 'p1', fecha: '2026-10-05T10:00:00.000Z', metodo: 'YAPE', monto: 100, referencia: null, cobradoPor: 'Rosa', anulado: false, motivoAnulacion: null, cuentasPagadas: 1, ...o })
  const cy = (o: Partial<Parameters<typeof CuentasYAbonos>[0]> = {}) => html(createElement(CuentasYAbonos, { abiertas: [ct(), ct({ id: 'r2', venta: 'V001-2', enRevision: true, motivoRevision: 'NC B001-5: devolución', vencida: false })], cerradas: [], abonos: [ab(), ab({ id: 'p2', anulado: true, motivoAnulacion: 'error al digitar' })], puedeCastigar: true, puedeOperar: true, ...o }))
  const hC = cy()
  check('>>> cuentas: saldo, vencimiento, «Vencida» y «Por revisar» con el motivo de la nota de crédito', hC.includes('Saldo S/ 200.00') && hC.includes('data-insignia="vencida"') && hC.includes('data-insignia="revision"') && hC.includes('NC B001-5: devolución'))
  check('>>> con credito.castigar: «Dar de baja la deuda» en cada cuenta abierta, «Mantener la deuda» SOLO en la que está por revisar, y «Anular» en el abono vigente', (hC.match(/data-boton="castigar"/g) ?? []).length === 2 && (hC.match(/data-boton="descartar"/g) ?? []).length === 1 && (hC.match(/data-boton="anular"/g) ?? []).length === 1)
  const hS = cy({ puedeCastigar: false })
  check('>>> SIN credito.castigar no aparece ninguno de los tres botones (el cajero consulta, no castiga)', !/data-boton="(castigar|descartar|anular)"/.test(hS) && hS.includes('V001-1'))
  check('>>> el abono anulado va tachado, con su motivo y sin botón; en solo lectura (cuenta suspendida) tampoco hay botones', hC.includes('data-insignia="anulado"') && hC.includes('line-through') && hC.includes('error al digitar') && !/data-boton="(castigar|descartar|anular)"/.test(cy({ puedeOperar: false })))
  check('vacíos con mensaje; las cuentas cerradas van plegadas', cy({ abiertas: [], abonos: [] }).includes('data-vacio="cuentas"') && cy({ abiertas: [], abonos: [] }).includes('data-vacio="abonos"') && cy({ cerradas: [ct({ id: 'r9', status: 'PAGADA', vencida: false })] }).includes('Cuentas cerradas (1)'))

  console.log('\nG) La ficha completa por permisos')
  const ficha: FichaCliente = {
    id: 'c1', name: 'Ana Quispe', docType: 'DNI', docNumber: '41300001', phone: '987654321', email: 'ana@x.com', address: 'Av. Sol 1', notes: null, activo: true, creado: '2026-01-02T00:00:00.000Z', documentoEditable: true,
    credito: { customerId: 'c1', nombre: 'Ana Quispe', limite: 1000, deuda: 300, disponible: 700, plazoDias: 30, venceSiFia: '2026-11-24', bloqueado: false, documentoValido: true, vencido: 200, cuentasVencidas: 1, puedeFiar: true, motivo: null },
    cuentasAbiertas: [ct(), ct({ id: 'r2', venta: 'V001-2', saldo: 100, monto: 100, abonado: 0, vencida: false, vence: '2026-12-01' })], cuentasCerradas: [], abonos: [ab()],
  }
  const todos: PermisosFicha = { puedeGestionar: true, puedeAbonar: true, puedeLimite: true, puedeCastigar: true, puedeOperar: true }
  const fv = (f: Partial<FichaCliente> = {}, p: Partial<PermisosFicha> = {}) => html(createElement(FichaClienteVista, { ficha: { ...ficha, ...f }, permisos: { ...todos, ...p } }))
  const hD = fv()
  check('>>> dueño: resumen (debe 300, línea 1000, disponible 700, vencido 200), aviso de mora en NARANJA, formulario de datos, línea editable y todos los botones', hD.includes('S/ 300.00') && hD.includes('S/ 1000.00') && hD.includes('S/ 700.00') && hD.includes('data-aviso="mora"') && hD.includes('Tiene S/ 200.00 vencidos en 1 cuenta') && hD.includes('data-form="editar"') && hD.includes('Guardar crédito') && hD.includes('data-boton="abonar"') && hD.includes('data-boton="baja"') && hD.includes('data-boton="castigar"'))
  const hCaj = fv({}, { puedeGestionar: false, puedeLimite: false, puedeCastigar: false })
  check('>>> CAJERO (solo credito.cobrar): ve los datos en LECTURA, la línea sin editar y puede registrar abonos — pero no editar, dar de baja ni castigar',
    hCaj.includes('data-seccion="datos-lectura"') && !hCaj.includes('data-form="editar"') && hCaj.includes('data-aviso="solo-lectura"') && !hCaj.includes('Guardar crédito') && hCaj.includes('data-boton="abonar"') && !hCaj.includes('data-boton="baja"') && !/data-boton="(castigar|descartar|anular)"/.test(hCaj))
  check('>>> sin credito.cobrar no hay «Registrar abono»; sin deuda tampoco', !fv({}, { puedeAbonar: false }).includes('data-boton="abonar"') && !fv({ credito: { ...ficha.credito, deuda: 0, vencido: 0, cuentasVencidas: 0 }, cuentasAbiertas: [] }).includes('data-boton="abonar"'))
  const hB = fv({ activo: false })
  check('>>> cliente de baja: aviso, sin formulario ni abonar ni «Dar de baja»; quien gestiona ve «Reactivar», quien no, nada', hB.includes('data-aviso="de-baja"') && !hB.includes('data-form="editar"') && !hB.includes('data-boton="baja"') && hB.includes('data-boton="reactivar"') && !fv({ activo: false }, { puedeGestionar: false }).includes('data-boton="reactivar"'))
  check('crédito bloqueado → aviso en rojo; la descarga del estado de cuenta es un enlace al CSV', fv({ credito: { ...ficha.credito, bloqueado: true } }).includes('data-aviso="bloqueado"') && hD.includes('href="/api/clientes/c1/estado-cuenta"') && hD.includes('download'))
  check('>>> las cuentas que recibe el modal van en el orden del servidor (vencimiento primero) con su saldo', cuentasAbonables(ficha).map((x) => `${x.venta}:${x.saldo}`).join(',') === 'V001-1:200,V001-2:100' && cuentasAbonables(ficha)[0]!.vencida)

  console.log('\nH) Con datos reales: la pantalla, el servicio y el servidor dicen lo mismo')
  const E = await negocio('a')
  const { O, ctxs, dbOf, vender, linea, abrirCaja } = E
  const db = dbOf(O)
  const tz = (await prisma.tenant.findUniqueOrThrow({ where: { id: E.t.id } })).timezone
  const hoyN = hoyEnZona(tz)
  let dn = 44000000
  const nuevo = (name: string, docNumber?: string) => crearCliente(db, O, crearClienteSchema.parse({ name, docNumber: docNumber ?? String(dn++) }))
  const R = await nuevo('Rosa Real'); await linea(R.id, 2000)
  await abrirCaja()
  const r1 = await vender(300, [{ method: 'CREDITO', amount: 300 }], R.id), r2 = await vender(200, [{ method: 'CREDITO', amount: 200 }], R.id), r3 = await vender(100, [{ method: 'CREDITO', amount: 100 }], R.id)
  await prisma.receivable.updateMany({ where: { saleId: r1.saleId }, data: { dueDate: sumarDias(hoyN, -40) } })
  await prisma.receivable.updateMany({ where: { saleId: r2.saleId }, data: { dueDate: sumarDias(hoyN, -5) } })
  const fReal = await obtenerFichaCliente(db, O, R.id)
  const hReal = fv2(fReal)
  function fv2(f: FichaCliente) { return html(createElement(FichaClienteVista, { ficha: f, permisos: todos })) }
  check('>>> ficha real renderizada: debe 600, 2 cuentas vencidas (500), la tercera vigente', hReal.includes('S/ 600.00') && hReal.includes('Tiene S/ 500.00 vencidos en 2 cuentas') && fReal.cuentasAbiertas.map((x) => x.vencida).join(',') === 'true,true,false')
  const pasos = cuentasAbonables(fReal)
  const vP = previsualizarAbono({ cuentas: pasos, elegidas: null, texto: '350', metodo: 'YAPE', cajaAbierta: true, deudaTotal: fReal.credito.deuda })
  const real = await registrarAbono(db, O, registrarAbonoSchema.parse({ customerId: R.id, method: 'YAPE', amount: 350, idempotencyKey: randomUUID() }))
  check('>>> la vista previa de 350 es EXACTAMENTE lo que el servidor registró (cuenta por cuenta: monto, saldo después, saldada) y la deuda después coincide',
    vP.listo && real.reparto.length === vP.partes.length && real.reparto.every((x, k) => x.monto === vP.partes[k]!.monto && x.saldoDespues === vP.partes[k]!.saldoDespues && x.pagada === vP.partes[k]!.pagada && x.venta === vP.partes[k]!.venta) && real.deudaDespues === vP.deudaDespues, JSON.stringify({ vP: vP.partes, real: real.reparto }))
  const fDespues = await obtenerFichaCliente(db, O, R.id)
  const vExceso = previsualizarAbono({ cuentas: cuentasAbonables(fDespues), elegidas: null, texto: '900', metodo: 'YAPE', cajaAbierta: true, deudaTotal: fDespues.credito.deuda })
  const rechazo = await msg(registrarAbono(db, O, registrarAbonoSchema.parse({ customerId: R.id, method: 'YAPE', amount: 900, idempotencyKey: randomUUID() })))
  check('>>> abonar de más: el texto de error de la pantalla es LITERALMENTE el del servidor', !vExceso.listo && vExceso.error === rechazo && !!rechazo, `${vExceso.error} | ${rechazo}`)
  const elegida = fDespues.cuentasAbiertas.at(-1)!
  const vEleg = previsualizarAbono({ cuentas: cuentasAbonables(fDespues), elegidas: [elegida.id], texto: String(elegida.saldo + 1), metodo: 'YAPE', cajaAbierta: true, deudaTotal: fDespues.credito.deuda })
  const rechazoEleg = await msg(registrarAbono(db, O, registrarAbonoSchema.parse({ customerId: R.id, method: 'YAPE', amount: elegida.saldo + 1, receivableIds: [elegida.id], idempotencyKey: randomUUID() })))
  check('y lo mismo eligiendo cuentas («en las cuentas elegidas»)', !vEleg.listo && vEleg.error === rechazoEleg)
  const lReal = await listarClientes(db, O, listarClientesSchema.parse({ filtro: 'CON_DEUDA' }))
  const hLReal = html(createElement(ClientesLista, { inicial: lReal, filtro: 'CON_DEUDA', puedeGestionar: true, puedeOperar: true }))
  check('>>> la lista real renderizada muestra a Rosa con su deuda actual y su mora', hLReal.includes('Rosa Real') && hLReal.includes(`Debe S/ ${fDespues.credito.deuda.toFixed(2)}`) && (fDespues.credito.vencido > 0) === hLReal.includes('data-insignia="mora"'))
  const cajero = ctxs.CAJERO!
  const fCaj = await obtenerFichaCliente(dbOf(cajero), cajero, R.id)
  const hCajReal = html(createElement(FichaClienteVista, { ficha: fCaj, permisos: { puedeGestionar: false, puedeAbonar: true, puedeLimite: false, puedeCastigar: false, puedeOperar: true } }))
  check('>>> con el contexto REAL del cajero: ve la ficha, puede abonar y no ve ni un botón de gestionar, castigar o editar la línea', hCajReal.includes('data-boton="abonar"') && !hCajReal.includes('data-boton="baja"') && !/data-boton="(castigar|descartar|anular)"/.test(hCajReal) && !hCajReal.includes('Guardar crédito'))
  void anularAbono; void anularCuenta; void configurarCreditoSchema; void anularAbonoSchema; void configurarCredito; void prisma.$disconnect

  const modal = readFileSync('src/features/clientes/components/ModalAbono.tsx', 'utf8')
  const cuerpoEnviar = modal.slice(modal.indexOf('const enviar = () => {'), modal.indexOf('const cerrar = '))
  check('>>> la clave de idempotencia del abono nace al ABRIR y solo se renueva tras un abono hecho: un reintento por un corte de red NO cobra dos veces', /clave\.current = crypto\.randomUUID\(\)/.test(modal.slice(0, modal.indexOf('const enviar'))) && (cuerpoEnviar.match(/randomUUID/g) ?? []).length === 1 && cuerpoEnviar.indexOf('idempotencyKey: clave.current') < cuerpoEnviar.indexOf('randomUUID') && !cuerpoEnviar.slice(0, cuerpoEnviar.indexOf('registrarAbono(')).includes('randomUUID'))
  check('>>> tras cobrar, al cerrar el modal se refresca la ficha (la deuda en pantalla es la real)', /const cerrar = \(\) => \{ if \(resultado\) router\.refresh\(\); onCerrar\(\) \}/.test(modal))
  check('>>> el modal solo envía lo que la vista previa dio por listo, y bloquea sin red', /if \(!vista\.listo \|\| vista\.monto === null\) return/.test(cuerpoEnviar) && cuerpoEnviar.includes('MENSAJE_SIN_RED'))

  console.log('\nI) Páginas, menú y permisos')
  const pagLista = readFileSync('src/app/(dashboard)/clientes/page.tsx', 'utf8'), pagFicha = readFileSync('src/app/(dashboard)/clientes/[id]/page.tsx', 'utf8')
  check('>>> las dos páginas dan 404 a quien no puede ver clientes, antes de consultar nada', [pagLista, pagFicha].every((p) => /if \(!puedeVerClientes\(ctx\)\) notFound\(\)/.test(p) && p.indexOf('notFound()') < p.indexOf('getTenantPrisma(ctx)')))
  check('>>> los permisos de cada botón salen del servidor (puede(ctx, …)), no del navegador', ['clientes.gestionar', 'credito.cobrar', 'credito.limite', 'credito.castigar'].every((p) => pagFicha.includes(`puede(ctx, '${p}')`)))
  check('>>> una dirección manipulada (filtro inventado, «De baja» sin permiso) vuelve a la lista normal; un cliente inexistente o ajeno es 404', /DE_BAJA' && !puedeGestionar/.test(pagLista) && /listarClientesSchema\.parse\(\{\}\)/.test(pagLista) && /NOT_FOUND/.test(pagFicha) && pagFicha.includes('id.slice(0, 64)'))
  const enMenu = (rol: Role) => visibleItems([...permisosDe({ tenantId: 't', userId: 'u', role: rol, access: 'FULL', branchId: 'b', permisosExtra: [] } as TenantContext)]).some((i) => i.href === '/clientes')
  check('>>> el menú: dueño, admin y cajero ven «Clientes»; vendedor, almacenero y contador no', enMenu('OWNER') && enMenu('ADMIN') && enMenu('CAJERO') && !enMenu('VENDEDOR') && !enMenu('ALMACENERO') && !enMenu('CONTADOR'))
  check('>>> menú, páginas y servicio deciden con la MISMA lista (permisos.ts); y el servicio la usa', (['OWNER', 'ADMIN', 'CAJERO', 'VENDEDOR', 'ALMACENERO', 'CONTADOR'] as Role[]).every((r) => enMenu(r) === puedeVerClientes({ tenantId: 't', userId: 'u', role: r, access: 'FULL', branchId: 'b', permisosExtra: [] } as TenantContext)) && PERMISOS_VER_CLIENTES.length === 4)
  const nav = readFileSync('src/features/shell/nav-items.ts', 'utf8')
  check('el menú importa la lista pura (sin arrastrar el servidor al navegador)', nav.includes("from '@/features/clientes/permisos'") && !nav.includes('clientes/service'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
