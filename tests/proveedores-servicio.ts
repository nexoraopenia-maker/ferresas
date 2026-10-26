import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import {
  bajaProveedorSchema, crearProveedorSchema, editarProveedorSchema, listarProveedoresSchema, reactivarProveedorSchema,
} from '../src/features/proveedores/schemas'
import {
  bloquearProveedor, crearProveedor, darDeBajaProveedor, editarProveedor, listarProveedores, obtenerFichaProveedor, reactivarProveedor, resolverRuc,
} from '../src/features/proveedores/service'
import { PERMISOS_VER_PROVEEDORES, puedeVerProveedores } from '../src/features/proveedores/permisos'
import { ETIQUETAS, PERMISOS, alcanzable, esOpcional, permisosDeRol, type Permiso } from '../src/lib/permisos'
import { PERMISOS_FUERA_DEL_PIN, permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 4, subpaso F4.2: permisos de compras y proveedores, y el servicio de proveedores (alta, edición, baja, lista, ficha).
 * Lo que más importa: solo dueño y admin gestionan y pagan, el almacenero solo registra compras si el dueño se lo activa, el RUC no
 * cambia con compras, no se da de baja con deuda ni con una compra a crédito en vuelo, y la lista nunca mezcla negocios.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => null).catch((e) => (e as Error).message)
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ctxP = (role: Role, extra: TenantContext['permisosExtra'] = []): TenantContext => ({ tenantId: 't', userId: 'u', role, access: 'FULL', branchId: 'b', permisosExtra: extra })
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `pv-${tag}-${randomUUID().slice(0, 6)}`, name: `Proveedores ${tag}`, taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_pv' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const mk = async (role: Role) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, u.id, b1.branch.id)
    return u
  }
  const ctxs: Record<string, TenantContext> = {}
  for (const r of ['OWNER', 'ADMIN', 'CAJERO', 'VENDEDOR', 'ALMACENERO', 'CONTADOR'] as Role[]) {
    const u = await mk(r)
    ctxs[r] = { tenantId: t.id, userId: u.id, role: r, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  }
  // El mismo almacenero, pero con «compras.registrar» activado por el dueño.
  ctxs.ALMACENERO_CON_COMPRAS = { ...ctxs.ALMACENERO!, permisosExtra: ['compras.registrar'] }
  const dbOf = (c: TenantContext) => getTenantPrisma(c)
  const O = ctxs.OWNER!
  const compra = (supplierId: string, over: Record<string, unknown> = {}) =>
    prisma.purchase.create({ data: { tenantId: t.id, warehouseId: b1.warehouse.id, userId: O.userId, number: `C-${randomUUID().slice(0, 8)}`, supplierId, ...over } })
  /** Una compra a crédito YA recibida, con su cuenta por pagar y la deuda del proveedor al día (como la dejaría el servicio de compras). */
  const compraACredito = async (supplierId: string, monto: number, venceHace: number) => {
    const vence = new Date(Date.now() - venceHace * 86_400_000)
    vence.setUTCHours(0, 0, 0, 0)
    const sub = Math.round((monto / 1.18) * 100) / 100
    const c = await compra(supplierId, { status: 'RECIBIDA', receivedAt: new Date(), receivedById: O.userId, paymentCondition: 'CREDITO', dueDate: vence, subtotal: sub, taxTotal: Math.round((monto - sub) * 100) / 100, total: monto })
    await prisma.accountPayable.create({ data: { tenantId: t.id, supplierId, purchaseId: c.id, amount: monto, dueDate: vence } })
    await prisma.supplier.update({ where: { id: supplierId }, data: { payableBalance: { increment: monto } } })
    return c
  }
  return { t, b1, ctxs, dbOf, O, compra, compraACredito }
}

const alta = (E: Awaited<ReturnType<typeof negocio>>, o: Record<string, unknown> = {}, c: TenantContext = E.O) =>
  crearProveedor(E.dbOf(c), c, crearProveedorSchema.parse({ name: `Proveedor ${Math.random().toString(36).slice(2, 8)}`, taxId: ruc(), ...o }))

async function main() {
  console.log('\nA) Los tres permisos nuevos')
  const NUEVOS: Permiso[] = ['proveedores.gestionar', 'compras.registrar', 'proveedores.pagar']
  check('>>> los tres existen en el catálogo y todos tienen etiqueta para la pantalla', NUEVOS.every((p) => PERMISOS.includes(p) && (ETIQUETAS[p]?.length ?? 0) > 3))
  check('>>> DUEÑO y ADMIN tienen los tres de fábrica (incluido pagar a proveedores)', (['OWNER', 'ADMIN'] as Role[]).every((r) => NUEVOS.every((p) => permisosDeRol(r).has(p))))
  check('>>> CAJERO, VENDEDOR y CONTADOR no tienen ninguno y no pueden recibirlos activándolos', (['CAJERO', 'VENDEDOR', 'CONTADOR'] as Role[]).every((r) => NUEVOS.every((p) => !permisosDeRol(r).has(p) && !alcanzable(r, p))))
  check('>>> el ALMACENERO no tiene ninguno de fábrica; solo «compras.registrar» es activable (opcional); gestionar y pagar no lo son nunca',
    NUEVOS.every((p) => !permisosDeRol('ALMACENERO').has(p)) && esOpcional('ALMACENERO', 'compras.registrar') && alcanzable('ALMACENERO', 'compras.registrar') && !alcanzable('ALMACENERO', 'proveedores.gestionar') && !alcanzable('ALMACENERO', 'proveedores.pagar'))
  check('>>> pagar a proveedores es del dueño y el admin y de NADIE más, ni siquiera como opcional (sale dinero del negocio)', (['VENDEDOR', 'CAJERO', 'ALMACENERO', 'CONTADOR'] as Role[]).every((r) => !alcanzable(r, 'proveedores.pagar')))
  check('>>> vedados al PIN: pagar y gestionar proveedores (un PIN de 4 cifras no mueve dinero ni administra); registrar compras no (es operativo)',
    PERMISOS_FUERA_DEL_PIN.includes('proveedores.pagar') && PERMISOS_FUERA_DEL_PIN.includes('proveedores.gestionar') && !PERMISOS_FUERA_DEL_PIN.includes('compras.registrar')
    && permisosDenegadosAlOperador(new Set(PERMISOS)).includes('proveedores.pagar'))
  check('>>> VER proveedores: dueño y admin; el almacenero solo si el dueño le activó compras; cajero, vendedor y contador no', puedeVerProveedores(ctxP('OWNER')) && puedeVerProveedores(ctxP('ADMIN'))
    && !puedeVerProveedores(ctxP('ALMACENERO')) && puedeVerProveedores(ctxP('ALMACENERO', ['compras.registrar'])) && !puedeVerProveedores(ctxP('CAJERO')) && !puedeVerProveedores(ctxP('VENDEDOR')) && !puedeVerProveedores(ctxP('CONTADOR')) && PERMISOS_VER_PROVEEDORES.length === 3)

  console.log('\nB) Esquemas y RUC')
  check('nombre de 2+ letras; datos opcionales vacíos = sin dato; correo válido; plazo 0-365 (por defecto 0)', !crearProveedorSchema.safeParse({ name: 'A' }).success && crearProveedorSchema.parse({ name: 'Ana SAC', taxId: ' ', contact: '', email: '' }).taxId === undefined
    && !crearProveedorSchema.safeParse({ name: 'Ana', email: 'no' }).success && !crearProveedorSchema.safeParse({ name: 'Ana', paymentTermDays: 366 }).success && !crearProveedorSchema.safeParse({ name: 'Ana', paymentTermDays: -1 }).success && crearProveedorSchema.parse({ name: 'Ana' }).paymentTermDays === 0)
  check('>>> el esquema NO deja pasar la deuda ni el estado: se descartan', !('payableBalance' in editarProveedorSchema.parse({ supplierId: 'x', name: 'Ana', payableBalance: 99999, deletedAt: 'x' })) && !('deletedAt' in editarProveedorSchema.parse({ supplierId: 'x', name: 'Ana', deletedAt: 'x' })))
  check('baja exige motivo; la lista valida filtro y tamaño de página', !bajaProveedorSchema.safeParse({ supplierId: 'x', motivo: 'ab' }).success && !listarProveedoresSchema.safeParse({ filtro: 'OTRO' }).success && !listarProveedoresSchema.safeParse({ limite: 500 }).success && reactivarProveedorSchema.safeParse({ supplierId: 'x' }).success)
  const r1 = ruc()
  check('>>> RUC válido se normaliza; vacío = sin RUC; DNI → error «se identifica con RUC»; RUC con dígito malo → error; largo malo → error',
    resolverRuc(` ${r1} `) === r1 && resolverRuc(undefined) === null && (() => { try { resolverRuc('41300001'); return false } catch (e) { return /RUC/.test((e as Error).message) } })()
    && (() => { try { resolverRuc('20123456789'); return false } catch { return true } })() && (() => { try { resolverRuc('123'); return false } catch { return true } })())

  const E = await negocio('a')
  const { ctxs, dbOf, O, compra, compraACredito } = E
  const db = dbOf(O)

  console.log('\nC) Alta')
  const p1 = await alta(E, { name: 'Aceros del Sur SAC', contact: 'Luis Pérez', phone: '987654321', paymentTermDays: 30 })
  const f1 = await prisma.supplier.findUniqueOrThrow({ where: { id: p1.id } })
  check('>>> alta: nace activo, sin deuda y con el plazo que se le dio', f1.isActive && f1.deletedAt === null && num(f1.payableBalance) === 0 && f1.paymentTermDays === 30 && f1.contact === 'Luis Pérez')
  check('alta sin RUC (proveedor informal) es válida', (await prisma.supplier.findUniqueOrThrow({ where: { id: (await alta(E, { taxId: undefined, name: 'Ferretero Informal' })).id } })).taxId === null)
  check('>>> RUC inválido, un DNI o un RUC repetido → rechazado con su motivo', await code(alta(E, { taxId: '20123456789' })) === 'INVALID_DOCUMENT' && await code(alta(E, { taxId: '41300001' })) === 'INVALID_DOCUMENT' && await code(alta(E, { taxId: f1.taxId! })) === 'DUPLICATE_CODE')
  check('>>> cajero, vendedor, contador y el almacenero (aun con compras.registrar) NO crean proveedores', (await Promise.all(['CAJERO', 'VENDEDOR', 'CONTADOR', 'ALMACENERO', 'ALMACENERO_CON_COMPRAS'].map((r) => code(alta(E, {}, ctxs[r]!))))).every((c) => c === 'FORBIDDEN_ROLE'))
  check('auditado: quién, qué y con qué RUC', !!(await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'proveedor.creado', entityId: p1.id, actorId: O.userId } })))
  const mismo = ruc()
  const carrera = await Promise.allSettled(Array.from({ length: 5 }, () => alta(E, { taxId: mismo, name: 'Carrera' })))
  check('>>> 5 altas simultáneas con el mismo RUC: exactamente UNA entra y las otras reciben DUPLICATE_CODE (no un error crudo)', carrera.filter((r) => r.status === 'fulfilled').length === 1 && carrera.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason?.code === 'DUPLICATE_CODE'),
    JSON.stringify(carrera.map((r) => r.status === 'rejected' ? (r.reason as { code?: string }).code ?? 'otro' : 'ok')))

  console.log('\nD) Edición')
  const ed = await editarProveedor(db, O, editarProveedorSchema.parse({ supplierId: p1.id, name: 'Aceros del Sur SAC', taxId: f1.taxId!, contact: 'Luis Pérez', phone: '999111222', paymentTermDays: 45 }))
  check('>>> cambia teléfono y plazo; informa exactamente qué cambió; lo no enviado (correo, notas) queda vacío', ed.cambios.join(',') === 'phone,paymentTermDays' && (await prisma.supplier.findUniqueOrThrow({ where: { id: p1.id } })).paymentTermDays === 45)
  const log = await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'proveedor.editado', entityId: p1.id } })
  check('>>> auditoría con el ANTES y el DESPUÉS solo de lo que cambió', JSON.stringify(log?.before) === JSON.stringify({ phone: '987654321', paymentTermDays: 30 }) && JSON.stringify(log?.after) === JSON.stringify({ phone: '999111222', paymentTermDays: 45 }))
  const antesAud = await prisma.auditLog.count({ where: { tenantId: E.t.id, action: 'proveedor.editado' } })
  check('guardar sin cambios no escribe ni audita', (await editarProveedor(db, O, editarProveedorSchema.parse({ supplierId: p1.id, name: 'Aceros del Sur SAC', taxId: f1.taxId!, contact: 'Luis Pérez', phone: '999111222', paymentTermDays: 45 }))).cambios.length === 0 && (await prisma.auditLog.count({ where: { tenantId: E.t.id, action: 'proveedor.editado' } })) === antesAud)
  const p2 = await alta(E, { name: 'Sin Compras SAC' })
  const r2 = (await prisma.supplier.findUniqueOrThrow({ where: { id: p2.id } })).taxId!
  const nuevoRuc = ruc()
  check('>>> sin compras el RUC SÍ se puede cambiar', (await editarProveedor(db, O, editarProveedorSchema.parse({ supplierId: p2.id, name: 'Sin Compras SAC', taxId: nuevoRuc }))).cambios.includes('taxId'))
  const p3 = await alta(E, { name: 'Con Compras SAC' })
  const r3 = (await prisma.supplier.findUniqueOrThrow({ where: { id: p3.id } })).taxId!
  await compra(p3.id)
  check('>>> con compras el RUC NO se puede cambiar (mensaje claro) y no se toca nada', /ya tiene compras/.test((await msg(editarProveedor(db, O, editarProveedorSchema.parse({ supplierId: p3.id, name: 'Con Compras SAC', taxId: ruc() })))) ?? '') && (await prisma.supplier.findUniqueOrThrow({ where: { id: p3.id } })).taxId === r3)
  check('con compras sí se editan nombre, contacto y plazo', (await editarProveedor(db, O, editarProveedorSchema.parse({ supplierId: p3.id, name: 'Con Compras SAC Nuevo', taxId: r3, contact: 'Ana', paymentTermDays: 15 }))).cambios.join(',') === 'name,contact,paymentTermDays')
  check('>>> RUC ya usado por otro proveedor → DUPLICATE_CODE', await code(editarProveedor(db, O, editarProveedorSchema.parse({ supplierId: p2.id, name: 'Nombre Repetido', taxId: f1.taxId! }))) === 'DUPLICATE_CODE')
  const p4 = await alta(E, { name: 'Con Deuda SAC' })
  await prisma.supplier.update({ where: { id: p4.id }, data: { payableBalance: 50 } })
  check('>>> a un proveedor con deuda no se le puede quitar el RUC (no se podría conciliar lo que se le debe)', /con deuda/.test((await msg(editarProveedor(db, O, editarProveedorSchema.parse({ supplierId: p4.id, name: 'Con Deuda SAC' })))) ?? ''))
  check('>>> editar NO toca el dinero: la deuda y el estado quedan idénticos', num((await prisma.supplier.findUniqueOrThrow({ where: { id: p4.id } })).payableBalance) === 50 && (await editarProveedor(db, O, editarProveedorSchema.parse({ supplierId: p4.id, name: 'Con Deuda SAC', taxId: (await prisma.supplier.findUniqueOrThrow({ where: { id: p4.id } })).taxId!, phone: '900000001' }))).cambios.join(',') === 'phone' && num((await prisma.supplier.findUniqueOrThrow({ where: { id: p4.id } })).payableBalance) === 50)
  check('el cajero, el vendedor y el almacenero con compras NO editan', (await Promise.all(['CAJERO', 'VENDEDOR', 'ALMACENERO_CON_COMPRAS'].map((r) => code(editarProveedor(dbOf(ctxs[r]!), ctxs[r]!, editarProveedorSchema.parse({ supplierId: p1.id, name: 'Hack' })))))).every((c) => c === 'FORBIDDEN_ROLE'))
  const E2 = await negocio('b')
  const ajeno = await alta(E2, { name: 'De otro negocio' })
  check('>>> editar el proveedor de OTRO negocio → no existe (nada se filtra)', await code(editarProveedor(db, O, editarProveedorSchema.parse({ supplierId: ajeno.id, name: 'Robado' }))) === 'NOT_FOUND' && (await prisma.supplier.findUniqueOrThrow({ where: { id: ajeno.id } })).name === 'De otro negocio')

  console.log('\nE) Baja y reactivación')
  const conDeuda = await alta(E, { name: 'Debemos Dinero SAC' })
  await compraACredito(conDeuda.id, 236, 5)
  check('>>> con deuda NO se da de baja: error con el monto y el proveedor sigue activo', /Le debes S\/ 236\.00/.test((await msg(darDeBajaProveedor(db, O, bajaProveedorSchema.parse({ supplierId: conDeuda.id, motivo: 'ya no compramos' })))) ?? '') && (await prisma.supplier.findUniqueOrThrow({ where: { id: conDeuda.id } })).deletedAt === null)
  const conBorrador = await alta(E, { name: 'Con Borrador SAC' })
  await compra(conBorrador.id)
  check('>>> con una compra en BORRADOR tampoco: hay que recibirla o anularla antes', /compra en borrador/.test((await msg(darDeBajaProveedor(db, O, bajaProveedorSchema.parse({ supplierId: conBorrador.id, motivo: 'prueba' })))) ?? ''))
  const limpio = await alta(E, { name: 'Sin Pendientes SAC' })
  await darDeBajaProveedor(db, O, bajaProveedorSchema.parse({ supplierId: limpio.id, motivo: 'duplicado de otro' }))
  const baja = await prisma.supplier.findUniqueOrThrow({ where: { id: limpio.id } })
  check('>>> sin deuda ni borradores: baja LÓGICA (deletedAt, inactivo), la fila sigue existiendo, auditada con el motivo', baja.deletedAt !== null && !baja.isActive && (await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'proveedor.baja', entityId: limpio.id } }))?.reason === 'duplicado de otro')
  check('darlo de baja dos veces → error; editarlo de baja → error', await code(darDeBajaProveedor(db, O, bajaProveedorSchema.parse({ supplierId: limpio.id, motivo: 'otra vez' }))) === 'INVALID_DOCUMENT' && await code(editarProveedor(db, O, editarProveedorSchema.parse({ supplierId: limpio.id, name: 'Zombi' }))) === 'INVALID_DOCUMENT')
  check('>>> cajero y almacenero con compras NO dan de baja', (await Promise.all(['CAJERO', 'ALMACENERO_CON_COMPRAS'].map((r) => code(darDeBajaProveedor(dbOf(ctxs[r]!), ctxs[r]!, bajaProveedorSchema.parse({ supplierId: p1.id, motivo: 'intento' })))))).every((c) => c === 'FORBIDDEN_ROLE'))
  check('>>> el RUC de un proveedor de baja NO se reutiliza: crear otro → mensaje claro «dado de baja»', /dado de baja/.test((await msg(alta(E, { taxId: baja.taxId! }))) ?? ''))
  await reactivarProveedor(db, O, reactivarProveedorSchema.parse({ supplierId: limpio.id }))
  const re = await prisma.supplier.findUniqueOrThrow({ where: { id: limpio.id } })
  check('>>> reactivar: vuelve a estar activo y auditado; reactivar a uno activo → error', re.deletedAt === null && re.isActive && !!(await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'proveedor.reactivado', entityId: limpio.id } })) && await code(reactivarProveedor(db, O, reactivarProveedorSchema.parse({ supplierId: limpio.id }))) === 'INVALID_DOCUMENT')
  // Una compra a crédito EN VUELO: otra transacción tiene bloqueado al proveedor y le subirá la deuda a 100 dentro de 1,5 s.
  const enVuelo = await alta(E, { name: 'Compra En Vuelo SAC' })
  const recibiendo = prisma.$transaction(async (tx) => {
    await tx.supplier.update({ where: { id: enVuelo.id }, data: { payableBalance: { increment: 0 } } })
    await new Promise((r) => setTimeout(r, 1500))
    await tx.supplier.update({ where: { id: enVuelo.id }, data: { payableBalance: 100 } })
  }, { timeout: 20_000 })
  await new Promise((r) => setTimeout(r, 400))
  const bajaTardia = await msg(darDeBajaProveedor(db, O, bajaProveedorSchema.parse({ supplierId: enVuelo.id, motivo: 'carrera determinista' })))
  await recibiendo
  check('>>> dar de baja ESPERA a la compra a crédito en vuelo, ve la deuda ya firme (S/ 100.00) y se rechaza: el proveedor no queda de baja con deuda', /Le debes S\/ 100\.00/.test(bajaTardia ?? '') && (await prisma.supplier.findUniqueOrThrow({ where: { id: enVuelo.id } })).deletedAt === null, String(bajaTardia).slice(0, 100))
  const bl = await db.$transaction(async (tx) => bloquearProveedor(tx as never, p1.id))
  check('bloquearProveedor devuelve la fila fresca (deuda como número) y un proveedor inexistente es NOT_FOUND', bl.id === p1.id && bl.payableBalance === 0 && await code(db.$transaction(async (tx) => bloquearProveedor(tx as never, 'no-existe'))) === 'NOT_FOUND')
  let incoherentes = 0
  for (let i = 0; i < 3; i++) {
    const z = await alta(E, { name: `Carrera Baja ${i}` })
    const R = await Promise.allSettled([compraACredito(z.id, 100, 3), darDeBajaProveedor(db, O, bajaProveedorSchema.parse({ supplierId: z.id, motivo: 'carrera' }))])
    void R
    const fz = await prisma.supplier.findUniqueOrThrow({ where: { id: z.id } })
    if (fz.deletedAt !== null && num(fz.payableBalance) > 0) incoherentes++
  }
  check('>>> baja y compra a crédito a la vez (3 rondas): NUNCA queda un proveedor de baja con deuda', incoherentes === 0, `${incoherentes} incoherentes`)

  console.log('\nF) Lista')
  const L = await negocio('l')
  const Lo = L.O, Ldb = L.dbOf(Lo)
  const nombres = ['Álvaro Distribuciones', 'Bravo Aceros', 'Cementos Lima', 'Distribuidora Paz', 'Ñandú Herramientas', 'Zinc Perú']
  const ids: Record<string, string> = {}
  for (const nm of nombres) ids[nm] = (await alta(L, { name: nm, contact: nm === 'Bravo Aceros' ? 'Rosa Quispe' : undefined, phone: nm === 'Zinc Perú' ? '955443322' : undefined }, Lo)).id
  await L.compraACredito(ids['Bravo Aceros']!, 500, 20)
  await L.compraACredito(ids['Cementos Lima']!, 300, -10)
  await darDeBajaProveedor(Ldb, Lo, bajaProveedorSchema.parse({ supplierId: ids['Zinc Perú']!, motivo: 'prueba' }))
  const lista = (o: Record<string, unknown> = {}, c: TenantContext = Lo) => listarProveedores(L.dbOf(c), c, listarProveedoresSchema.parse(o))
  const todos = await lista()
  check('>>> TODOS: los activos por orden alfabético del español (la Á primero y la Ñ entre la N y la O, no al final), sin el dado de baja', todos.items.map((x) => x.name).join('|') === ['Álvaro Distribuciones', 'Bravo Aceros', 'Cementos Lima', 'Distribuidora Paz', 'Ñandú Herramientas'].join('|'), todos.items.map((x) => x.name).join('|'))
  const br = todos.items.find((x) => x.name === 'Bravo Aceros')!, ce = todos.items.find((x) => x.name === 'Cementos Lima')!
  check('>>> cada fila trae lo que se le debe y la parte VENCIDA aparte (Bravo venció hace 20 días; Cementos aún no)', br.deuda === 500 && br.vencido === 500 && br.cuentasVencidas === 1 && ce.deuda === 300 && ce.vencido === 0)
  check('>>> CON_DEUDA: solo Bravo y Cementos', (await lista({ filtro: 'CON_DEUDA' })).items.map((x) => x.name).join('|') === 'Bravo Aceros|Cementos Lima')
  check('>>> DE_BAJA: solo Zinc, y solo para quien gestiona', (await lista({ filtro: 'DE_BAJA' })).items.map((x) => x.name).join('|') === 'Zinc Perú' && await code(lista({ filtro: 'DE_BAJA' }, L.ctxs.ALMACENERO_CON_COMPRAS!)) === 'FORBIDDEN_ROLE')
  check('búsqueda por nombre (sin importar mayúsculas), por RUC y por contacto', (await lista({ q: 'cementos' })).items.length === 1 && (await lista({ q: (await prisma.supplier.findUniqueOrThrow({ where: { id: ids['Distribuidora Paz']! } })).taxId! })).items[0]?.name === 'Distribuidora Paz' && (await lista({ q: 'rosa' })).items[0]?.name === 'Bravo Aceros')
  const p1l = await lista({ limite: 2 }), p2l = await lista({ limite: 2, cursor: p1l.siguiente! }), p3l = await lista({ limite: 2, cursor: p2l.siguiente! })
  check('>>> paginación de 2 en 2 (5 activos): 2, 2, 1; sin repetidos ni saltos y la última sin «siguiente»', [p1l, p2l, p3l].map((p) => p.items.length).join(',') === '2,2,1' && p3l.siguiente === null && new Set([...p1l.items, ...p2l.items, ...p3l.items].map((x) => x.id)).size === 5 && [...p1l.items, ...p2l.items, ...p3l.items].map((x) => x.name).join('|') === todos.items.map((x) => x.name).join('|'))
  check('>>> VEN la lista: dueño, admin y el almacenero con compras; NO el cajero, el vendedor, el contador ni el almacenero sin compras',
    (await lista({}, L.ctxs.ADMIN!)).items.length === 5 && (await lista({}, L.ctxs.ALMACENERO_CON_COMPRAS!)).items.length === 5
    && (await Promise.all(['CAJERO', 'VENDEDOR', 'CONTADOR', 'ALMACENERO'].map((r) => code(lista({}, L.ctxs[r]!))))).every((c) => c === 'FORBIDDEN_ROLE'))
  check('>>> la lista nunca trae proveedores de OTRO negocio', !(await lista({ limite: 100 })).items.some((x) => x.name === 'De otro negocio') && (await listarProveedores(E2.dbOf(E2.O), E2.O, listarProveedoresSchema.parse({}))).items.every((x) => x.name === 'De otro negocio'))

  console.log('\nG) Ficha')
  const fi = await obtenerFichaProveedor(Ldb, Lo, ids['Bravo Aceros']!)
  await L.compra(ids['Bravo Aceros']!)
  check('>>> ficha: datos, deuda 500 y vencida 500 en 1 cuenta, y la cuenta abierta con su compra, saldo y vencimiento', fi.name === 'Bravo Aceros' && fi.contact === 'Rosa Quispe' && fi.deuda === 500 && fi.vencido === 500 && fi.cuentasAbiertas.length === 1 && fi.cuentasAbiertas[0]!.saldo === 500 && fi.cuentasAbiertas[0]!.vencida && fi.cuentasAbiertas[0]!.compra.startsWith('C-'))
  const fi2 = await obtenerFichaProveedor(Ldb, Lo, ids['Bravo Aceros']!)
  check('>>> con compras el RUC no es editable; cuenta las compras y da la fecha de la última recibida', !fi2.rucEditable && fi2.comprasTotal === 2 && fi2.ultimaCompra !== null && (await obtenerFichaProveedor(Ldb, Lo, ids['Álvaro Distribuciones']!)).rucEditable && (await obtenerFichaProveedor(Ldb, Lo, ids['Álvaro Distribuciones']!)).ultimaCompra === null)
  check('>>> el almacenero con compras ve la ficha; el cajero no', (await obtenerFichaProveedor(L.dbOf(L.ctxs.ALMACENERO_CON_COMPRAS!), L.ctxs.ALMACENERO_CON_COMPRAS!, ids['Bravo Aceros']!)).name === 'Bravo Aceros' && await code(obtenerFichaProveedor(L.dbOf(L.ctxs.CAJERO!), L.ctxs.CAJERO!, ids['Bravo Aceros']!)) === 'FORBIDDEN_ROLE')
  check('>>> un proveedor de baja lo ve quien gestiona (para reactivarlo) pero NO el almacenero con compras', (await obtenerFichaProveedor(Ldb, Lo, ids['Zinc Perú']!)).activo === false && await code(obtenerFichaProveedor(L.dbOf(L.ctxs.ALMACENERO_CON_COMPRAS!), L.ctxs.ALMACENERO_CON_COMPRAS!, ids['Zinc Perú']!)) === 'NOT_FOUND')
  check('>>> la ficha de OTRO negocio no existe', await code(obtenerFichaProveedor(Ldb, Lo, ajeno.id)) === 'NOT_FOUND')
  const antesF = JSON.stringify(await prisma.supplier.findUniqueOrThrow({ where: { id: ids['Bravo Aceros']! } }))
  await obtenerFichaProveedor(Ldb, Lo, ids['Bravo Aceros']!); await listarProveedores(Ldb, Lo, listarProveedoresSchema.parse({}))
  check('>>> consultar es de SOLO LECTURA: el proveedor queda idéntico (incluida su fecha de modificación)', JSON.stringify(await prisma.supplier.findUniqueOrThrow({ where: { id: ids['Bravo Aceros']! } })) === antesF)

  console.log('\nH) Estructura')
  const svc = readFileSync('src/features/proveedores/service.ts', 'utf8')
  const act = readFileSync('src/features/proveedores/actions.ts', 'utf8')
  const cuerpo = (n: string) => { const i = svc.indexOf(`export async function ${n}(`); const j = svc.indexOf('\nexport ', i + 10); return svc.slice(i, j < 0 ? undefined : j) }
  check('>>> editar, dar de baja y reactivar BLOQUEAN al proveedor antes de leer o escribir; sin SQL crudo', ['editarProveedor', 'darDeBajaProveedor', 'reactivarProveedor'].every((f) => { const c = cuerpo(f); return c.includes('bloquearProveedor(t,') && c.indexOf('bloquearProveedor(t,') < c.indexOf('supplier.update({ where: { id: ') || c.indexOf('bloquearProveedor(t,') < c.indexOf('findFirst') || c.indexOf('bloquearProveedor(t,') < c.indexOf('t.supplier.update') }) && !/\$queryRaw|\$executeRaw/.test(svc))
  check('>>> el bloqueo ES el del dinero: un UPDATE que toma la fila (payableBalance += 0), no una lectura', /async function bloquearProveedor[\s\S]*?payableBalance: \{ increment: 0 \}/.test(svc))
  // Se quitan los usos legítimos (seleccionarla, el bloqueo `+= 0`, el filtro «con deuda» y las lecturas); si queda alguna asignación a `payableBalance:`, el servicio la escribe.
  const sinLegitimos = svc.replace(/payableBalance: (true|\{ increment: 0 \}|\{ gt: 0 \})/g, '').replace(/payableBalance: num\([^)]*\)/g, '')
  check('>>> el servicio nunca escribe la deuda del proveedor: solo la selecciona, la lee, la filtra y la bloquea con `+= 0`', !/payableBalance\s*:/.test(sinLegitimos) && /payableBalance: \{ increment: 0 \}/.test(svc))
  check('>>> las acciones son "use server", validan con Zod, pasan por la sesión, no deciden permisos y solo exportan 6 funciones async', act.startsWith("'use server'") && act.includes('requireTenantContext') && !/puede\(|exigir\(/.test(act) && (act.match(/export async function/g) ?? []).length === 6 && !/export (const|let|class)/.test(act))

  // Se corta el archivo POR FUNCIÓN: una expresión que cruzara a la función siguiente daría por buena una acción sin validar.
  const cuerpoAccion = (n: string) => { const i = act.indexOf(`export async function ${n}(`); const j = act.indexOf('export async function', i + 10); return act.slice(i, j < 0 ? undefined : j) }
  const conEsquema: [string, string][] = [['crearProveedor', 'crearProveedorSchema'], ['editarProveedor', 'editarProveedorSchema'], ['darDeBajaProveedor', 'bajaProveedorSchema'], ['reactivarProveedor', 'reactivarProveedorSchema'], ['listarProveedores', 'listarProveedoresSchema'], ['fichaProveedor', 'fichaProveedorSchema']]
  check('>>> cada acción valida con SU esquema de Zod ANTES de tocar nada, rechaza si no pasa, y solo entonces llama al servicio', conEsquema.every(([n, esq]) => { const c = cuerpoAccion(n); return c.includes(`${esq}.safeParse(`) && /if \(!p\.success\) return invalida\(p\.error\)/.test(c) && c.indexOf('safeParse(') < c.indexOf('conTenant(') }))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
