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
import { crearProveedor, listarProveedores, obtenerFichaProveedor, type FichaProveedor, type FilaProveedor } from '../src/features/proveedores/service'
import { crearProveedorSchema, listarProveedoresSchema } from '../src/features/proveedores/schemas'
import { PERMISOS_VER_PROVEEDORES } from '../src/features/proveedores/permisos'
import { ProveedoresLista, enlaceFiltroProveedores } from '../src/features/proveedores/components/ProveedoresLista'
import { FormularioProveedor, MENSAJE_RUC_BLOQUEADO } from '../src/features/proveedores/components/FormularioProveedor'
import { AccionesProveedor } from '../src/features/proveedores/components/AccionesProveedor'
import { FichaProveedorVista, type PermisosFichaProveedor } from '../src/features/proveedores/components/FichaProveedorVista'
import { crearBorrador, listarCompras, recibirCompra, type FilaCompra } from '../src/features/compras/service'
import { crearBorradorSchema, listarComprasSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { visibleItems } from '../src/features/shell/nav-items'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 4, subpaso F4.5 (parte 1): las pantallas de proveedores (lista, formulario, acciones y ficha), renderizadas AISLADAS, sin navegador.
 * Lo que más importa: cada botón aparece solo con su permiso, lo que dice la pantalla es lo que dice el servicio, y el menú, la página y
 * el servicio deciden con la misma lista de permisos.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const noop = () => undefined
const stub = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }
const html = (el: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: stub as never }, el))
/** La etiqueta completa (<input …>, <a …> o <button …>) que lleva `marca`. El orden de los atributos lo decide React: se mira entera. */
const etiqueta = (h: string, marca: string): string => { const i = h.indexOf(marca); if (i < 0) return ''; const a = h.lastIndexOf('<', i); return h.slice(a, h.indexOf('>', i) + 1) }
const deshabilitado = (h: string, marca: string) => /\sdisabled=""/.test(etiqueta(h, marca))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const rolCtx = (r: Role, extra: TenantContext['permisosExtra'] = []): TenantContext => ({ tenantId: 't', userId: 'u', role: r, access: 'FULL', branchId: 'b', permisosExtra: extra })

const fila = (o: Partial<FilaProveedor> = {}): FilaProveedor => ({ id: 's1', name: 'Aceros del Sur', taxId: '20123456789', contact: 'Luis', phone: '999', paymentTermDays: 30, activo: true, deuda: 0, vencido: 0, cuentasVencidas: 0, ...o })
const ficha = (o: Partial<FichaProveedor> = {}): FichaProveedor => ({
  id: 's1', name: 'Aceros del Sur', taxId: '20123456789', contact: 'Luis', phone: '999', email: 'ventas@aceros.pe', address: 'Av. 1', notes: null, paymentTermDays: 30,
  activo: true, creado: '2026-01-15T10:00:00.000Z', rucEditable: false, deuda: 0, vencido: 0, cuentasVencidas: 0, comprasTotal: 0, ultimaCompra: null, cuentasAbiertas: [], ...o,
})
const todos: PermisosFichaProveedor = { puedeGestionar: true, puedeComprar: true, puedeOperar: true }

async function main() {
  console.log('\nA) Lista de proveedores')
  const lista = (o: Record<string, unknown> = {}) => html(createElement(ProveedoresLista, { inicial: { items: [fila({ deuda: 150.5, vencido: 40, cuentasVencidas: 1 }), fila({ id: 's2', name: 'Baja SAC', activo: false, taxId: null })], siguiente: null }, filtro: 'TODOS', puedeGestionar: true, puedeOperar: true, ...o } as never))
  const h = lista()
  check('>>> cada proveedor enlaza a su ficha, con RUC, contacto y lo que se le debe', h.includes('href="/proveedores/s1"') && h.includes('RUC 20123456789') && h.includes('Luis') && h.includes('Le debes S/ 150.50'))
  check('>>> insignias: vencido con su monto y «De baja»; un proveedor sin RUC lo dice', h.includes('data-insignia="vencido"') && h.includes('Vencido S/ 40.00') && h.includes('data-insignia="baja"') && h.includes('Sin RUC'))
  check('>>> sin deuda dice «Sin deuda» (no «Le debes S/ 0.00») y el plazo solo si hay', html(createElement(ProveedoresLista, { inicial: { items: [fila({ paymentTermDays: 0 })], siguiente: null }, filtro: 'TODOS', puedeGestionar: true, puedeOperar: true })).includes('Sin deuda') && !html(createElement(ProveedoresLista, { inicial: { items: [fila({ paymentTermDays: 0 })], siguiente: null }, filtro: 'TODOS', puedeGestionar: true, puedeOperar: true })).includes('Plazo 0'))
  check('>>> «Nuevo proveedor» y el filtro «De baja» solo para quien gestiona', h.includes('data-boton="nuevo-proveedor"') && h.includes('De baja</a>') && !lista({ puedeGestionar: false }).includes('data-boton="nuevo-proveedor"') && !lista({ puedeGestionar: false }).includes('De baja</a>'))
  check('>>> con la cuenta en solo lectura, «Nuevo proveedor» se ve deshabilitado', deshabilitado(lista({ puedeOperar: false }), 'data-boton="nuevo-proveedor"') && !deshabilitado(h, 'data-boton="nuevo-proveedor"'))
  check('>>> lista vacía: el mensaje distingue «no hay ninguno» de «nada coincide»', html(createElement(ProveedoresLista, { inicial: { items: [], siguiente: null }, filtro: 'TODOS', puedeGestionar: true, puedeOperar: true })).includes('Todavía no hay proveedores') && html(createElement(ProveedoresLista, { inicial: { items: [], siguiente: null }, filtro: 'CON_DEUDA', puedeGestionar: true, puedeOperar: true })).includes('Ningún proveedor coincide'))
  check('>>> «Cargar más» solo si hay otra página', lista({ inicial: { items: [fila()], siguiente: 's1' } }).includes('data-boton="cargar-mas"') && !h.includes('data-boton="cargar-mas"'))
  check('>>> el filtro activo se marca y los enlaces conservan la búsqueda', lista({ filtro: 'CON_DEUDA', q: 'acero' }).includes('aria-current="page"') && enlaceFiltroProveedores('CON_DEUDA', 'acero') === '/proveedores?filtro=CON_DEUDA&q=acero' && enlaceFiltroProveedores('TODOS', undefined) === '/proveedores')

  console.log('\nB) Formulario')
  const fc = html(createElement(FormularioProveedor, { modo: 'crear', rucEditable: true }))
  check('>>> alta: nombre obligatorio, RUC de 11 dígitos opcional, plazo, contacto, teléfono, correo, dirección y notas', fc.includes('name="name"') && /name="name"[^>]*required|required[^>]*name="name"/.test(fc) && fc.includes('pattern="\\d{11}"') && ['taxId', 'paymentTermDays', 'contact', 'phone', 'email', 'address', 'notes'].every((n) => fc.includes(`name="${n}"`)) && fc.includes('Crear proveedor'))
  const fe = html(createElement(FormularioProveedor, { modo: 'editar', inicial: ficha(), rucEditable: false }))
  check('>>> edición con compras: el RUC se ve DESHABILITADO y explica por qué (el servicio lo rechaza igual)', deshabilitado(fe, 'name="taxId"') && fe.includes(MENSAJE_RUC_BLOQUEADO) && fe.includes('value="Aceros del Sur"') && fe.includes('value="30"'))
  check('>>> sin compras, el RUC se puede editar', !deshabilitado(html(createElement(FormularioProveedor, { modo: 'editar', inicial: ficha(), rucEditable: true })), 'name="taxId"'))

  console.log('\nC) Acciones de la ficha')
  const acc = (o: Record<string, unknown> = {}) => html(createElement(AccionesProveedor, { supplierId: 's1', nombre: 'X', activo: true, deuda: 0, puedeGestionar: true, puedeComprar: true, puedeOperar: true, ...o } as never))
  check('>>> «Registrar compra» lleva a una compra con el proveedor ya elegido, solo con compras.registrar y si está activo', acc().includes('href="/compras/nueva?proveedor=s1"') && !acc({ puedeComprar: false }).includes('data-enlace="nueva-compra"') && !acc({ activo: false }).includes('data-enlace="nueva-compra"'))
  check('>>> «Ver sus compras» siempre (filtra la lista de compras por el proveedor)', acc({ puedeGestionar: false, puedeComprar: false }).includes('href="/compras?proveedor=s1"'))
  check('>>> «Dar de baja» solo para quien gestiona y si está activo; «Reactivar» solo si está de baja', acc().includes('data-boton="baja"') && !acc({ puedeGestionar: false }).includes('data-boton="baja"') && acc({ activo: false }).includes('data-boton="reactivar"') && !acc().includes('data-boton="reactivar"') && !acc({ activo: false, puedeGestionar: false }).includes('data-boton="reactivar"'))
  check('>>> en solo lectura: la baja deshabilitada y el enlace de compra apagado (aria-disabled)', deshabilitado(acc({ puedeOperar: false }), 'data-boton="baja"') && etiqueta(acc({ puedeOperar: false }), 'data-enlace="nueva-compra"').includes('aria-disabled="true"'))

  console.log('\nD) La ficha completa')
  const cuentas = [{ id: 'x1', compra: 'C001-00000001', monto: 118, pagado: 18, saldo: 100, vence: '2026-09-01', vencida: true }, { id: 'x2', compra: 'C001-00000002', monto: 50, pagado: 0, saldo: 50, vence: '2027-01-01', vencida: false }]
  const compras: FilaCompra[] = [{ id: 'k1', number: 'C001-00000001', status: 'RECIBIDA', invoiceRef: 'F001-9', supplierName: 'Aceros del Sur', paymentCondition: 'CREDITO', dueDate: '2026-09-01', total: 118, createdAt: new Date('2026-08-01T15:00:00Z') }]
  const fv = html(createElement(FichaProveedorVista, { ficha: ficha({ deuda: 150, vencido: 100, cuentasVencidas: 1, comprasTotal: 3, cuentasAbiertas: cuentas }), compras, permisos: todos }))
  check('>>> resumen: le debes, vencido, plazo y número de compras', fv.includes('S/ 150.00') && fv.includes('S/ 100.00') && fv.includes('30 días') && />3</.test(fv))
  check('>>> avisa lo vencido con el número de cuentas', fv.includes('data-aviso="vencido"') && fv.includes('en 1 cuenta'))
  check('>>> cuentas por pagar: saldo, de cuánto, y «Venció» / «Vence» con la fecha del negocio (DD/MM/AAAA)', fv.includes('Venció el 01/09/2026') && fv.includes('Vence el 01/01/2027') && fv.includes('de S/ 118.00') && fv.includes('data-cuenta="x1"'))
  check('>>> últimas compras: enlazan a su detalle, con estado, condición y total', fv.includes('href="/compras/k1"') && fv.includes('Recibida · A crédito') && fv.includes('F001-9'))
  check('>>> sin cuentas ni compras lo dice', html(createElement(FichaProveedorVista, { ficha: ficha(), compras: [], permisos: todos })).includes('No le debes nada') && html(createElement(FichaProveedorVista, { ficha: ficha(), compras: [], permisos: todos })).includes('Todavía no hay compras'))
  check('>>> quien gestiona ve el formulario de edición; quien no, los datos en solo lectura', fv.includes('data-form="proveedor-editar"') && !html(createElement(FichaProveedorVista, { ficha: ficha(), compras: [], permisos: { ...todos, puedeGestionar: false } })).includes('data-form="proveedor-editar"') && html(createElement(FichaProveedorVista, { ficha: ficha(), compras: [], permisos: { ...todos, puedeGestionar: false } })).includes('ventas@aceros.pe'))
  check('>>> un proveedor de baja lo avisa y no ofrece editar', html(createElement(FichaProveedorVista, { ficha: ficha({ activo: false }), compras: [], permisos: todos })).includes('data-aviso="de-baja"') && !html(createElement(FichaProveedorVista, { ficha: ficha({ activo: false }), compras: [], permisos: todos })).includes('data-form="proveedor-editar"'))

  console.log('\nE) Con datos reales: la pantalla dice lo que dice el servicio')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `pv-pant-${randomUUID().slice(0, 6)}`, name: 'Pantallas prov', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_pv' } })
  const b = await crearSucursalConAlmacen(t.id)
  const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER' } })
  await asignarSucursal(t.id, u.id, b.branch.id)
  const O: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: b.branch.id, branchIds: [b.branch.id], permisosExtra: [] }
  const db = getTenantPrisma(O)
  const sp = await crearProveedor(db, O, crearProveedorSchema.parse({ name: 'Ñandú Ferretero', taxId: ruc(), paymentTermDays: 15 }))
  const p = await prisma.product.create({ data: { tenantId: t.id, sku: 'X', name: 'X', unitType: 'UNIDAD', salePrice: 10, costPrice: 0, taxRate: 0 } })
  const k = await crearBorrador(db, O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: b.warehouse.id, supplierId: sp.id, paymentCondition: 'CREDITO', items: [{ productId: p.id, enteredQuantity: 4, unitCost: 25 }] }))
  await recibirCompra(db, O, recibirCompraSchema.parse({ purchaseId: k.id }))
  const fr = await obtenerFichaProveedor(db, O, sp.id)
  const cr = await listarCompras(db, O, listarComprasSchema.parse({ supplierId: sp.id, limite: 10 }))
  const fh = html(createElement(FichaProveedorVista, { ficha: fr, compras: cr.filas, permisos: todos }))
  check('>>> la ficha renderizada con datos reales muestra la deuda del servicio (100.00), su cuenta y su compra', fr.deuda === 100 && fh.includes('S/ 100.00') && fh.includes(`data-cuenta="${fr.cuentasAbiertas[0]!.id}"`) && fh.includes(`href="/compras/${k.id}"`))
  check('>>> y el RUC ya no es editable porque tiene compras (lo decide el servicio)', !fr.rucEditable && deshabilitado(fh, 'name="taxId"'))
  const lr = await listarProveedores(db, O, listarProveedoresSchema.parse({}))
  check('>>> la lista real enlaza al proveedor con su deuda', html(createElement(ProveedoresLista, { inicial: lr, filtro: 'TODOS', puedeGestionar: true, puedeOperar: true })).includes(`href="/proveedores/${sp.id}"`) && html(createElement(ProveedoresLista, { inicial: lr, filtro: 'TODOS', puedeGestionar: true, puedeOperar: true })).includes('Le debes S/ 100.00'))

  console.log('\nF) Páginas, menú y permisos')
  const pl = readFileSync('src/app/(dashboard)/proveedores/page.tsx', 'utf8')
  const pf = readFileSync('src/app/(dashboard)/proveedores/[id]/page.tsx', 'utf8')
  check('>>> lista y ficha exigen sesión y deciden con puedeVerProveedores (404 si no)', [pl, pf].every((s) => s.includes('await requireTenantContext()') && s.includes('if (!puedeVerProveedores(ctx)) notFound()')))
  check('>>> la ficha: inexistente, de otro negocio o sin permiso → 404 (no un error)', pf.includes("e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN_ROLE'") && pf.includes('if (!ficha) notFound()'))
  check('>>> la lista: una dirección manipulada («de baja» sin permiso o filtro inventado) vuelve a la lista normal', pl.includes("parsed.data.filtro === 'DE_BAJA' && !puedeGestionar"))
  check('>>> los permisos de los botones salen del servidor (puede…), nunca del rol a mano', !/ctx\.role/.test(pl + pf) && pf.includes("puede(ctx, 'proveedores.gestionar')") && pf.includes("puede(ctx, 'compras.registrar')"))
  const enMenu = (r: Role, extra: TenantContext['permisosExtra'] = []) => visibleItems([...permisosDe(rolCtx(r, extra))]).some((i) => i.href === '/proveedores')
  check('>>> el menú muestra Proveedores a quien la página deja entrar: dueño, admin y almacenero con compras; no a cajero, vendedor, contador ni almacenero común',
    enMenu('OWNER') && enMenu('ADMIN') && enMenu('ALMACENERO', ['compras.registrar']) && !enMenu('CAJERO') && !enMenu('VENDEDOR') && !enMenu('CONTADOR') && !enMenu('ALMACENERO'))
  const nav = readFileSync('src/features/shell/nav-items.ts', 'utf8')
  check('>>> el enlace usa la MISMA lista pura que la página y el servicio (PERMISOS_VER_PROVEEDORES)', /href: '\/proveedores',[\s\S]*?permisos: \[\.\.\.PERMISOS_VER_PROVEEDORES\]/.test(nav) && PERMISOS_VER_PROVEEDORES.length === 3)
  check('>>> los componentes con estado son de cliente y no importan nada del servidor', ['ProveedoresLista', 'FormularioProveedor', 'AccionesProveedor'].every((c) => { const s = readFileSync(`src/features/proveedores/components/${c}.tsx`, 'utf8'); return s.startsWith("'use client'") && !/from '@\/lib\/(prisma|tenant-prisma|session)'|from '\.\.\/service'(?!.*type)/.test(s.replace(/import type[^\n]*\n/g, '')) }))
  check('>>> hay pantalla de carga para la lista y la ficha', existsSync('src/app/(dashboard)/proveedores/loading.tsx') && existsSync('src/app/(dashboard)/proveedores/[id]/loading.tsx'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
