import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { permisosDe } from '../src/lib/puede'
import { hoyEnZona } from '../src/features/credito/reglas'
import {
  enlaceFiltroCompras, leerDecimal, motivoNoGuardable, MENSAJE_CREDITO_SIN_PROVEEDOR, MENSAJE_SIN_LINEAS, resumenBorrador, venceSugerido,
} from '../src/features/compras/borrador-ui'
import {
  anularCompra, borradorParaEditar, buscarProductosParaCompra, crearBorrador, obtenerCompra, opcionesDeCompra, recibirCompra,
  type BorradorParaEditar, type FilaCompra, type OpcionesCompra, type ProductoParaCompra,
} from '../src/features/compras/service'
import { anularCompraSchema, crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { crearProveedor } from '../src/features/proveedores/service'
import { crearProveedorSchema } from '../src/features/proveedores/schemas'
import { crearPresentacion } from '../src/features/inventory/presentaciones-service'
import { ComprasLista } from '../src/features/compras/components/ComprasLista'
import { FormularioCompra, unidadDeLinea } from '../src/features/compras/components/FormularioCompra'
import { AccionesCompra, MENSAJE_ANULAR_SIN_AJUSTE, type PermisosCompra } from '../src/features/compras/components/AccionesCompra'
import { DetalleCompra } from '../src/features/compras/components/DetalleCompra'
import { visibleItems } from '../src/features/shell/nav-items'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 4, subpaso F4.5 (parte 2): las pantallas de compras (lista, formulario, detalle y acciones), renderizadas AISLADAS, sin navegador.
 * Lo que más importa: los totales que se ven son EXACTAMENTE los que guarda el servidor, recibir y anular solo aparecen cuando y a quien
 * corresponde, el costo por línea no se le enseña a quien solo paga, y el menú, la página y el servicio deciden con los mismos permisos.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
const etiqueta = (h: string, marca: string): string => { const i = h.indexOf(marca); if (i < 0) return ''; const a = h.lastIndexOf('<', i); return h.slice(a, h.indexOf('>', i) + 1) }
const deshabilitado = (h: string, marca: string) => /\sdisabled=""/.test(etiqueta(h, marca))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const rolCtx = (r: Role, extra: TenantContext['permisosExtra'] = []): TenantContext => ({ tenantId: 't', userId: 'u', role: r, access: 'FULL', branchId: 'b', permisosExtra: extra })
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')

const producto = (o: Partial<ProductoParaCompra> = {}): ProductoParaCompra => ({ productId: 'p1', name: 'Clavo 2"', sku: 'CLA', unitType: 'UNIDAD', taxRate: 0.18, costPrice: 0.5, presentaciones: [{ id: 'caja', name: 'Caja x 100', unitType: 'CAJA', factor: '100' }], ...o })
const opciones: OpcionesCompra = { almacenes: [{ id: 'w1', name: 'Principal', isDefault: true }, { id: 'w2', name: 'Depósito', isDefault: false }], proveedores: [{ id: 's1', name: 'Aceros', taxId: '20111111111', paymentTermDays: 30 }, { id: 's2', name: 'Bravo', taxId: null, paymentTermDays: 0 }] }
const fila = (o: Partial<FilaCompra> = {}): FilaCompra => ({ id: 'k1', number: 'C001-00000001', status: 'BORRADOR', invoiceRef: 'F001-1', supplierName: 'Aceros', paymentCondition: 'CONTADO', dueDate: null, total: 118, createdAt: new Date('2026-10-27T03:00:00Z'), ...o })
const P: PermisosCompra = { puedeRegistrar: true, puedeAjustar: true, puedeOperar: true, puedePagar: true }

async function main() {
  console.log('\nA) La lógica del formulario (pura)')
  check('>>> leerDecimal: coma decimal, vacío = null, letras/negativo/muchos decimales = NaN; costo 0 sí, cantidad 0 no',
    leerDecimal('2,5', 4, false) === 2.5 && leerDecimal(' ', 4, false) === null && [leerDecimal('abc', 4, false), leerDecimal('-1', 4, true), leerDecimal('1.00001', 4, true)].every(Number.isNaN) && leerDecimal('0', 4, true) === 0 && Number.isNaN(leerDecimal('0', 4, false)!))
  const r1 = resumenBorrador([{ cantidad: '10', costo: '5', tasa: 0.18 }, { cantidad: '4', costo: '2,5', tasa: 0 }])
  check('>>> totales en vivo: 10×5 + 4×2.5 = 60; IGV solo a lo gravado (9.00); total 69.00', r1.totales[0] === 50 && r1.totales[1] === 10 && r1.subtotal === 60 && r1.igv === 9 && r1.total === 69 && r1.completas && !r1.hayInvalidas)
  const r2 = resumenBorrador([{ cantidad: '10', costo: '', tasa: 0.18 }, { cantidad: 'x', costo: '1', tasa: 0.18 }])
  check('>>> una línea incompleta no suma; una inválida se marca', r2.totales[0] === null && r2.totales[1] === null && r2.subtotal === 0 && !r2.completas && r2.hayInvalidas)
  check('>>> no se puede guardar: sin productos, a crédito sin proveedor, con un dato inválido o incompleto (mismos mensajes que el servidor)',
    motivoNoGuardable({ condicion: 'CONTADO', proveedorId: '', lineas: [] }) === MENSAJE_SIN_LINEAS &&
    motivoNoGuardable({ condicion: 'CREDITO', proveedorId: '', lineas: [{ cantidad: '1', costo: '1', tasa: 0 }] }) === MENSAJE_CREDITO_SIN_PROVEEDOR &&
    (motivoNoGuardable({ condicion: 'CONTADO', proveedorId: '', lineas: [{ cantidad: 'x', costo: '1', tasa: 0 }] }) ?? '').includes('no es un número') &&
    (motivoNoGuardable({ condicion: 'CONTADO', proveedorId: '', lineas: [{ cantidad: '1', costo: '', tasa: 0 }] }) ?? '').includes('Completa') &&
    motivoNoGuardable({ condicion: 'CREDITO', proveedorId: 's1', lineas: [{ cantidad: '1', costo: '0', tasa: 0 }] }) === null)
  check('>>> vencimiento sugerido = hoy + plazo (cruza meses y años)', venceSugerido('2026-12-20', 15) === '2027-01-04' && venceSugerido('2026-01-31', 0) === '2026-01-31')
  check('>>> enlaces de filtro conservan la búsqueda', enlaceFiltroCompras('RECIBIDA', 'F001') === '/compras?estado=RECIBIDA&q=F001' && enlaceFiltroCompras('TODAS', undefined) === '/compras')
  check('>>> la unidad de la línea: la presentación con su factor, o la unidad base', unidadDeLinea({ producto: producto(), presentationId: 'caja' }) === 'Caja x 100 (100 unidad)' && unidadDeLinea({ producto: producto(), presentationId: '' }) === 'unidad')

  console.log('\nB) Lista de compras')
  const lista = (o: Record<string, unknown> = {}) => html(createElement(ComprasLista, { inicial: { filas: [fila(), fila({ id: 'k2', status: 'ANULADA', total: 50 }), fila({ id: 'k3', status: 'RECIBIDA', paymentCondition: 'CREDITO', dueDate: '2026-11-30' })], siguiente: null }, filtro: 'TODAS', puedeRegistrar: true, puedeOperar: true, zona: 'America/Lima', ...o } as never))
  const hl = lista()
  check('>>> cada compra enlaza a su detalle, con número, documento, proveedor, estado, condición y total', hl.includes('href="/compras/k1"') && hl.includes('C001-00000001 · F001-1') && hl.includes('Aceros') && hl.includes('data-insignia="estado-BORRADOR"') && hl.includes('S/ 118.00'))
  check('>>> la fecha es la del NEGOCIO (27/10 03:00 UTC = 26/10 en Lima), no la de UTC', hl.includes('26/10/2026') && !hl.includes('27/10/2026'))
  check('>>> a crédito muestra el vencimiento; una anulada se ve tachada', hl.includes('A crédito · vence 30/11/2026') && /line-through[^>]*>S\/ 50\.00/.test(hl))
  check('>>> «Nueva compra» solo con compras.registrar; en solo lectura queda apagada', hl.includes('href="/compras/nueva"') && !lista({ puedeRegistrar: false }).includes('data-enlace="nueva-compra"') && etiqueta(lista({ puedeOperar: false }), 'data-enlace="nueva-compra"').includes('aria-disabled="true"'))
  const hp = lista({ proveedor: { id: 's1', name: 'Aceros' } })
  check('>>> filtrada por proveedor: lo dice, la nueva compra lleva ese proveedor y los filtros lo conservan', hp.includes('data-aviso="filtro-proveedor"') && hp.includes('href="/compras/nueva?proveedor=s1"') && hp.includes('href="/compras?estado=RECIBIDA&amp;proveedor=s1"') && hp.includes('name="proveedor" value="s1"'))
  check('>>> vacía: distingue «no hay ninguna» de «nada coincide»', html(createElement(ComprasLista, { inicial: { filas: [], siguiente: null }, filtro: 'TODAS', puedeRegistrar: true, puedeOperar: true, zona: 'America/Lima' })).includes('Todavía no hay compras') && html(createElement(ComprasLista, { inicial: { filas: [], siguiente: null }, filtro: 'ANULADA', puedeRegistrar: true, puedeOperar: true, zona: 'America/Lima' })).includes('Ninguna compra coincide'))

  console.log('\nC) El formulario')
  const form = (o: Record<string, unknown> = {}) => html(createElement(FormularioCompra, { modo: 'crear', opciones, hoy: '2026-10-26', ...o } as never))
  const hf = form()
  check('>>> alta: proveedores activos y almacenes de la sucursal para elegir; al contado por defecto', hf.includes('<option value="s1">Aceros · 20111111111</option>') && hf.includes('Sin proveedor (compra suelta)') && hf.includes('>Depósito</option>') && etiqueta(hf, 'value="CONTADO"').includes('checked=""') && !etiqueta(hf, 'value="CREDITO"').includes('checked=""'))
  check('>>> sin productos no se puede guardar (el botón está deshabilitado)', deshabilitado(hf, 'data-boton="guardar-compra"') && hf.includes('data-lista="sin-lineas"'))
  check('>>> desde la ficha llega con el proveedor elegido; un id ajeno o inventado se ignora', /<option value="s2" selected="">/.test(form({ proveedorInicial: 's2' })) && !/selected=""[^>]*>Aceros|<option value="s1" selected/.test(form({ proveedorInicial: 'no-existe' })))
  const sinAlm = form({ opciones: { ...opciones, almacenes: [] } })
  check('>>> sin almacenes activos en la sucursal lo avisa y no deja guardar', sinAlm.includes('data-aviso="sin-almacen"') && deshabilitado(sinAlm, 'data-boton="guardar-compra"'))
  const borrador: BorradorParaEditar = {
    id: 'k1', number: 'C001-00000007', warehouseId: 'w2', supplierId: 's1', invoiceRef: 'F9', paymentCondition: 'CREDITO', vence: null, notes: 'n',
    lineas: [{ producto: producto(), presentationId: 'caja', cantidad: '3', costo: '45.5' }, { producto: producto({ productId: 'p2', name: 'Arena', taxRate: 0, presentaciones: [] }), presentationId: null, cantidad: '2.5', costo: '10' }],
  }
  const he = form({ modo: 'editar', inicial: borrador })
  check('>>> edición: carga cabecera y líneas (almacén, proveedor, documento, presentación, cantidad, costo)', /<option value="w2" selected="">/.test(he) && /<option value="s1" selected="">/.test(he) && he.includes('value="F9"') && /<option value="caja" selected="">/.test(he) && he.includes('value="45.5"') && he.includes('value="2.5"'))
  check('>>> los totales que se ven: 3×45.5 = 136.50 y 2.5×10 = 25.00; IGV 24.57 solo a lo gravado; total 186.07', he.includes('S/ 136.50') && he.includes('S/ 25.00') && /data-total="igv"[^>]*>S\/ 24\.57/.test(he) && /data-total="total"[^>]*>S\/ 186\.07/.test(he))
  check('>>> a crédito sin fecha tocada: el vencimiento sugerido es hoy + el plazo del proveedor (30 días)', he.includes('type="date"') && he.includes('value="2026-11-25"'))
  check('>>> con un borrador válido el botón se habilita; en solo lectura no', !deshabilitado(he, 'data-boton="guardar-compra"') && deshabilitado(form({ modo: 'editar', inicial: borrador, puedeOperar: false }), 'data-boton="guardar-compra"'))
  const perdido = form({ modo: 'editar', inicial: { ...borrador, supplierId: 'de-baja' } })
  check('>>> si el proveedor del borrador se dio de baja, lo avisa en vez de cambiarlo en silencio', perdido.includes('data-aviso="proveedor-de-baja"') && !form({ modo: 'editar', inicial: borrador }).includes('data-aviso="proveedor-de-baja"'))
  check('>>> el costo se pide SIN IGV, por la unidad en que se compra', he.includes('Costo sin IGV') && he.includes('por Caja x 100 (100 unidad)'))

  console.log('\nD) Acciones según el estado')
  const ac = (o: Record<string, unknown> = {}) => html(createElement(AccionesCompra, { purchaseId: 'k1', numero: 'C001-00000001', estado: 'BORRADOR', condicion: 'CREDITO', total: 118, lineas: 2, conPagos: false, proveedor: { id: 's1', name: 'Aceros', deudaActual: 0 }, vence: '2026-11-01', permisos: P, ...o } as never))
  check('>>> BORRADOR: recibir, editar y descartar', ac().includes('data-boton="recibir"') && ac().includes('href="/compras/k1/editar"') && ac().includes('Descartar borrador'))
  check('>>> RECIBIDA: ni recibir ni editar; anular solo con stock.ajustar, y si no, explica por qué', !ac({ estado: 'RECIBIDA' }).includes('data-boton="recibir"') && !ac({ estado: 'RECIBIDA' }).includes('data-enlace="editar"') && ac({ estado: 'RECIBIDA' }).includes('Anular compra') && !ac({ estado: 'RECIBIDA', permisos: { ...P, puedeAjustar: false } }).includes('data-boton="anular"') && ac({ estado: 'RECIBIDA', permisos: { ...P, puedeAjustar: false } }).includes(MENSAJE_ANULAR_SIN_AJUSTE))
  check('>>> el almacenero sin ajustar SÍ puede descartar un borrador (no sale mercadería)', ac({ permisos: { ...P, puedeAjustar: false } }).includes('data-boton="anular"'))
  check('>>> ANULADA o sin compras.registrar: ninguna acción', ac({ estado: 'ANULADA' }) === '' && ac({ permisos: { ...P, puedeRegistrar: false } }) === '')
  check('>>> en solo lectura los botones se ven deshabilitados', deshabilitado(ac({ permisos: { ...P, puedeOperar: false } }), 'data-boton="recibir"') && deshabilitado(ac({ permisos: { ...P, puedeOperar: false } }), 'data-boton="anular"'))

  console.log('\nE) Con datos reales: pantalla, servicio y servidor dicen lo mismo')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `co-pant-${randomUUID().slice(0, 6)}`, name: 'Pantallas compras', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_co' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const ctxs: Record<string, TenantContext> = {}
  for (const r of ['OWNER', 'CAJERO', 'CONTADOR', 'ALMACENERO'] as Role[]) {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${r}-${randomUUID()}@x.com`.toLowerCase(), name: r, role: r } })
    await asignarSucursal(t.id, u.id, b1.branch.id)
    ctxs[r] = { tenantId: t.id, userId: u.id, role: r, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  }
  const O = ctxs.OWNER!, db = getTenantPrisma(O)
  const hoy = hoyEnZona((await prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })).timezone)
  const sA = await crearProveedor(db, O, crearProveedorSchema.parse({ name: 'Zeta', taxId: ruc(), paymentTermDays: 20 }))
  const sB = await crearProveedor(db, O, crearProveedorSchema.parse({ name: 'Ángel', taxId: ruc() }))
  const sBaja = await crearProveedor(db, O, crearProveedorSchema.parse({ name: 'Baja', taxId: ruc() }))
  await prisma.supplier.update({ where: { id: sBaja.id }, data: { isActive: false, deletedAt: new Date() } })
  const pr = await prisma.product.create({ data: { tenantId: t.id, sku: 'CEM-42', name: 'Cemento Sol 42.5 kg', unitType: 'UNIDAD', salePrice: 30, costPrice: 20 } })
  await prisma.product.create({ data: { tenantId: t.id, sku: 'SERV-1', name: 'Cemento servicio de corte', unitType: 'UNIDAD', salePrice: 5, trackStock: false } })
  const caja = await crearPresentacion(db, O, { productId: pr.id, name: 'Bolsa x 10', unitType: 'CAJA', factor: '10' })

  const op = await opcionesDeCompra(db, O)
  check('>>> opciones: solo los almacenes de MI sucursal y solo proveedores activos, en orden del español (Ángel antes que Zeta)', op.almacenes.length === 1 && op.almacenes[0]!.id === b1.warehouse.id && !op.almacenes.some((a) => a.id === b2.warehouse.id) && op.proveedores.map((p) => p.name).join(',') === 'Ángel,Zeta')
  const bus = await buscarProductosParaCompra(db, O, 'cemento')
  check('>>> buscar productos para comprar: solo los que llevan stock (el servicio no aparece), con costo, IGV y presentaciones', bus.length === 1 && bus[0]!.productId === pr.id && bus[0]!.costPrice === 20 && bus[0]!.taxRate === 0.18 && bus[0]!.presentaciones.some((x) => x.id === caja.id && x.factor === '10'))
  // «Abrazadera» va antes que «Cemento» en el alfabeto y su SKU EMPIEZA por lo tecleado: si el orden fuera alfabético, saldría primero.
  await prisma.product.create({ data: { tenantId: t.id, sku: 'CEM-420', name: 'Abrazadera', unitType: 'UNIDAD', salePrice: 1 } })
  const porSku = await buscarProductosParaCompra(db, O, 'CEM-42')
  check('>>> el SKU EXACTO va primero aunque otro (que solo empieza igual) vaya antes en el alfabeto; menos de 2 letras no busca', porSku.length === 2 && porSku[0]?.productId === pr.id && porSku[1]?.name === 'Abrazadera' && (await buscarProductosParaCompra(db, O, 'c')).length === 0)
  check('>>> buscar y ver opciones exigen compras.registrar', await code(buscarProductosParaCompra(getTenantPrisma(ctxs.CAJERO!), ctxs.CAJERO!, 'cemento')) === 'FORBIDDEN_ROLE' && await code(opcionesDeCompra(getTenantPrisma(ctxs.CONTADOR!), ctxs.CONTADOR!)) === 'FORBIDDEN_ROLE')
  const otro = await prisma.tenant.create({ data: { slug: `co-pant2-${randomUUID().slice(0, 6)}`, name: 'Otro', taxId: ruc(), planId: plan.id } })
  await prisma.product.create({ data: { tenantId: otro.id, sku: 'CEM-OTRO', name: 'Cemento ajeno', unitType: 'UNIDAD', salePrice: 1 } })
  check('>>> la búsqueda nunca trae productos de OTRO negocio', !(await buscarProductosParaCompra(db, O, 'cemento')).some((x) => x.name === 'Cemento ajeno'))

  // El formulario muestra lo que el servidor guarda: mismo borrador por las dos vías.
  const lineas = [{ cantidad: '3', costo: '60.005', tasa: 0.18 }, { cantidad: '7', costo: '19.9999', tasa: 0.18 }]
  const vista = resumenBorrador(lineas)
  const k = await crearBorrador(db, O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: b1.warehouse.id, supplierId: sA.id, paymentCondition: 'CREDITO', items: [{ productId: pr.id, presentationId: caja.id, enteredQuantity: '3', unitCost: 60.005 }, { productId: pr.id, enteredQuantity: '7', unitCost: 19.9999 }] }))
  const g = await prisma.purchase.findUniqueOrThrow({ where: { id: k.id }, include: { items: { orderBy: { id: 'asc' } } } })
  check('>>> lo que el formulario muestra es EXACTAMENTE lo que el servidor guarda (líneas, IGV y total, con redondeos difíciles)', num(g.subtotal) === vista.subtotal && num(g.taxTotal) === vista.igv && num(g.total) === vista.total && g.items.map((i) => num(i.lineTotal)).sort().join() === vista.totales.map(Number).sort().join(), `${num(g.total)} vs ${vista.total}`)
  check('>>> y el vencimiento sugerido en pantalla es el que el servidor pone por defecto (hoy + 20 días)', g.dueDate!.toISOString().slice(0, 10) === venceSugerido(hoy, 20))
  const ed = await borradorParaEditar(db, O, k.id)
  check('>>> editar trae el borrador listo para el formulario: presentación, cantidad tecleada y costo por unidad de compra', ed.lineas.length === 2 && ed.lineas.some((l) => l.presentationId === caja.id && l.cantidad === '3') && ed.lineas.some((l) => l.presentationId === null && l.cantidad === '7') && ed.supplierId === sA.id && ed.vence === g.dueDate!.toISOString().slice(0, 10))
  const reabierto = resumenBorrador(ed.lineas.map((l) => ({ cantidad: l.cantidad, costo: l.costo, tasa: l.producto.taxRate })))
  check('>>> reabrir el borrador en el formulario da el MISMO total que tiene guardado', reabierto.total === num(g.total) && reabierto.subtotal === num(g.subtotal), `${reabierto.total} vs ${num(g.total)}`)
  const hEd = html(createElement(FormularioCompra, { modo: 'editar', opciones: op, hoy, inicial: ed }))
  check('>>> y el formulario renderizado con ese borrador real muestra ese total', new RegExp(`data-total="total"[^>]*>S/ ${num(g.total).toFixed(2)}`).test(hEd))
  check('>>> editar exige compras.registrar y no existe en otro negocio', await code(borradorParaEditar(getTenantPrisma(ctxs.CAJERO!), ctxs.CAJERO!, k.id)) === 'FORBIDDEN_ROLE')
  await recibirCompra(db, O, recibirCompraSchema.parse({ purchaseId: k.id }))
  check('>>> una compra RECIBIDA ya no se puede abrir para editar', await code(borradorParaEditar(db, O, k.id)) === 'INVALID_DOCUMENT')

  const det = await obtenerCompra(db, O, k.id)
  const dh = (verCostos: boolean, permisos = P) => html(createElement(DetalleCompra, { compra: det, permisos, zona: 'America/Lima', verCostos }))
  check('>>> detalle: estado, proveedor enlazado, almacén, líneas con la presentación (3 × Bolsa x 10 = 30) y la cuenta por pagar', dh(true).includes('data-insignia="estado-RECIBIDA"') && dh(true).includes(`href="/proveedores/${sA.id}"`) && dh(true).includes('Principal') && dh(true).includes('3 × Bolsa x 10 = 30') && dh(true).includes('Cuenta por pagar · Pendiente'))
  check('>>> el costo por línea se ve SOLO con permiso de costos o de compras; quien solo paga ve los totales de la factura', dh(true).includes('data-costo-linea') && dh(true).includes('c/u sin IGV') && !dh(false).includes('data-costo-linea') && !dh(false).includes('c/u sin IGV') && dh(false).includes(`S/ ${num(g.total).toFixed(2)}`))
  check('>>> dice quién la registró y quién la recibió', dh(true).includes('Registrada por OWNER') && dh(true).includes('Recibida por OWNER'))
  const k2 = await crearBorrador(db, O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: b1.warehouse.id, supplierId: sB.id, items: [{ productId: pr.id, enteredQuantity: '1', unitCost: 1 }] }))
  await anularCompra(db, O, anularCompraSchema.parse({ purchaseId: k2.id, motivo: 'Pedido duplicado' }))
  const an = html(createElement(DetalleCompra, { compra: await obtenerCompra(db, O, k2.id), permisos: P, zona: 'America/Lima', verCostos: true }))
  check('>>> una anulada muestra quién, cuándo y por qué, y ninguna acción', an.includes('data-aviso="anulada"') && an.includes('Pedido duplicado') && an.includes('por OWNER') && !an.includes('data-boton='))

  console.log('\nF) Páginas, menú y permisos')
  const D = 'src/app/(dashboard)/compras'
  const pl = readFileSync(`${D}/page.tsx`, 'utf8'), pn = readFileSync(`${D}/nueva/page.tsx`, 'utf8'), pd = readFileSync(`${D}/[id]/page.tsx`, 'utf8'), pe = readFileSync(`${D}/[id]/editar/page.tsx`, 'utf8')
  check('>>> todas exigen sesión; lista y detalle se ven con puedeVerProveedores; nueva y editar exigen compras.registrar (404 si no)', [pl, pn, pd, pe].every((s) => s.includes('await requireTenantContext()')) && [pl, pd].every((s) => s.includes('if (!puedeVerProveedores(ctx)) notFound()')) && [pn, pe].every((s) => s.includes("if (!puede(ctx, 'compras.registrar')) notFound()")))
  check('>>> el detalle decide el costo por línea con ver_costo O compras.registrar; y los botones con compras.registrar y stock.ajustar', pd.includes("verCostos={puede(ctx, 'productos.ver_costo') || puede(ctx, 'compras.registrar')}") && pd.includes("puedeRegistrar: puede(ctx, 'compras.registrar')") && pd.includes("puedeAjustar: puede(ctx, 'stock.ajustar')"))
  check('>>> editar una compra que ya no es borrador vuelve a su detalle (no un error)', pe.includes("e.code === 'INVALID_DOCUMENT'") && pe.includes('redirect(`/compras/'))
  check('>>> la lista: el proveedor de la dirección solo se usa si es de ESTE negocio (cliente aislado)', pl.includes('db.supplier.findFirst') && pl.includes('getTenantPrisma(ctx)'))
  check('>>> ninguna página decide por el rol a mano', !/ctx\.role/.test(pl + pn + pd + pe))
  const enMenu = (r: Role, extra: TenantContext['permisosExtra'] = []) => visibleItems([...permisosDe(rolCtx(r, extra))]).some((i) => i.href === '/compras')
  check('>>> el menú muestra Compras a quien la página deja entrar (dueño, admin, almacenero con compras) y a nadie más', enMenu('OWNER') && enMenu('ADMIN') && enMenu('ALMACENERO', ['compras.registrar']) && !enMenu('CAJERO') && !enMenu('VENDEDOR') && !enMenu('CONTADOR') && !enMenu('ALMACENERO'))
  check('>>> los componentes con estado son de cliente; el formulario calcula con las funciones del servidor (borrador-ui → costo) sin importar Prisma',
    ['ComprasLista', 'FormularioCompra', 'AccionesCompra'].every((c) => readFileSync(`src/features/compras/components/${c}.tsx`, 'utf8').startsWith("'use client'")) &&
    readFileSync('src/features/compras/borrador-ui.ts', 'utf8').includes("from './costo'") && !/^import /m.test(readFileSync('src/features/compras/costo.ts', 'utf8')) &&
    readFileSync('src/features/compras/components/FormularioCompra.tsx', 'utf8').includes('resumenBorrador('))
  check('>>> el servidor calcula con las MISMAS funciones (totalDeLinea + igvDeCompra) que muestra la pantalla', /totalDeLinea\(conv\.cantidadIngresada, i\.unitCost\)/.test(readFileSync('src/features/compras/service.ts', 'utf8')) && readFileSync('src/features/compras/service.ts', 'utf8').includes('igvDeCompra('))
  check('>>> el formulario manda una clave de idempotencia fija mientras está abierto (un reintento no crea otro borrador)', /const \[clave\] = useState\(/.test(readFileSync('src/features/compras/components/FormularioCompra.tsx', 'utf8')) && readFileSync('src/features/compras/components/FormularioCompra.tsx', 'utf8').includes('idempotencyKey: clave'))
  check('>>> hay pantalla de carga en cada ruta de compras', ['', '/nueva', '/[id]', '/[id]/editar'].every((s) => existsSync(`${D}${s}/loading.tsx`)))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
