import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { resolverCliente } from '../src/features/pos/cliente-service'
import { configurarCredito, registrarAbono, anularAbono } from '../src/features/credito/credito-service'
import { configurarCreditoSchema, registrarAbonoSchema, anularAbonoSchema } from '../src/features/credito/schemas'
import { openCashSession } from '../src/features/branches/cash-service'
import { openCashSchema } from '../src/features/branches/cash-schemas'
import {
  bajaClienteSchema, crearClienteSchema, editarClienteSchema, listarClientesSchema, reactivarClienteSchema,
} from '../src/features/clientes/schemas'
import {
  crearCliente, darDeBajaCliente, editarCliente, listarClientes, obtenerFichaCliente, puedeVerClientes, reactivarCliente,
} from '../src/features/clientes/service'
import { PERMISOS, alcanzable, esOpcional, permisosDeRol } from '../src/lib/permisos'
import { PERMISOS_FUERA_DEL_PIN } from '../src/features/seguridad/pin-reglas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 3, subpaso 5.1: clientes (alta, edición, baja, lista, ficha) y el permiso `clientes.gestionar`.
 * Lo que más importa: solo dueño y admin gestionan, quien cobra abonos solo VE, el documento no cambia con ventas, no se da de baja con
 * deuda ni con una venta fiada en curso, y la lista nunca mezcla negocios.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => null).catch((e) => (e as Error).message)
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ctxP = (role: Role, extra: TenantContext['permisosExtra'] = []): TenantContext => ({ tenantId: 't', userId: 'u', role, access: 'FULL', branchId: 'b', permisosExtra: extra })

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: { slug: `cl-${tag}-${randomUUID().slice(0, 6)}`, name: `Clientes ${tag}`, legalName: `CLIENTES ${tag.toUpperCase()} SAC`, taxId, planId: plan.id } })
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

let n8 = 42000000
const dni = () => String(n8++)
const alta = (E: Awaited<ReturnType<typeof negocio>>, o: Record<string, unknown> = {}, c: TenantContext = E.O) =>
  crearCliente(E.dbOf(c), c, crearClienteSchema.parse({ name: `Cliente ${n8}`, docNumber: dni(), ...o }))

async function main() {
  console.log('\nA) El permiso nuevo')
  check('>>> OWNER y ADMIN tienen clientes.gestionar de fábrica', permisosDeRol('OWNER').has('clientes.gestionar') && permisosDeRol('ADMIN').has('clientes.gestionar'))
  check('>>> ningún otro rol lo tiene ni puede recibirlo activándolo', (['CAJERO', 'VENDEDOR', 'ALMACENERO', 'CONTADOR'] as Role[]).every((r) => !permisosDeRol(r).has('clientes.gestionar') && !alcanzable(r, 'clientes.gestionar') && !esOpcional(r, 'clientes.gestionar')))
  check('>>> está vedado al PIN de cajero (es administración)', PERMISOS_FUERA_DEL_PIN.includes('clientes.gestionar') && PERMISOS.includes('clientes.gestionar'))
  check('>>> VER clientes: dueño, admin y el cajero (credito.cobrar); NO vendedor, almacenero ni contador', puedeVerClientes(ctxP('OWNER')) && puedeVerClientes(ctxP('ADMIN')) && puedeVerClientes(ctxP('CAJERO')) && !puedeVerClientes(ctxP('VENDEDOR')) && !puedeVerClientes(ctxP('ALMACENERO')) && !puedeVerClientes(ctxP('CONTADOR')))

  console.log('\nB) Esquemas')
  check('nombre de 2+ letras; documento, teléfono, correo, dirección y notas vacíos = sin dato; correo válido', !crearClienteSchema.safeParse({ name: 'A' }).success && crearClienteSchema.parse({ name: 'Ana', docNumber: '  ', phone: '', email: '', address: ' ' }).docNumber === undefined && !crearClienteSchema.safeParse({ name: 'Ana', email: 'no-es-correo' }).success)
  check('>>> el esquema NO deja pasar campos de crédito (línea, deuda, bloqueo): se descartan', !('creditLimit' in editarClienteSchema.parse({ customerId: 'x', name: 'Ana', creditLimit: 99999, creditBalance: -5 })))
  check('baja exige motivo; la lista limita el tamaño de página y valida el filtro', !bajaClienteSchema.safeParse({ customerId: 'x', motivo: 'ab' }).success && !listarClientesSchema.safeParse({ limite: 500 }).success && !listarClientesSchema.safeParse({ filtro: 'OTRO' }).success && reactivarClienteSchema.safeParse({ customerId: 'x' }).success)

  const E = await negocio('a')
  const { ctxs, dbOf, vender, linea, abrirCaja, O } = E
  const db = dbOf(O)

  console.log('\nC) Alta')
  const a1 = await alta(E, { name: 'Ana Quispe', phone: '987654321', email: 'ana@x.com' })
  const f1 = await prisma.customer.findUniqueOrThrow({ where: { id: a1.id } })
  check('>>> alta con DNI: el tipo se deduce, nace SIN línea de crédito y activo', f1.docType === 'DNI' && num(f1.creditLimit) === 0 && num(f1.creditBalance) === 0 && f1.isActive && f1.deletedAt === null)
  const ruc = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  check('alta con RUC válido → RUC; sin documento → SIN_DOCUMENTO', (await prisma.customer.findUniqueOrThrow({ where: { id: (await alta(E, { docNumber: ruc })).id } })).docType === 'RUC' && (await prisma.customer.findUniqueOrThrow({ where: { id: (await alta(E, { docNumber: undefined, name: 'Sin Documento' })).id } })).docType === 'SIN_DOCUMENTO')
  check('>>> documento inválido (RUC con dígito malo, DNI corto) → rechazado', await code(alta(E, { docNumber: '20123456789' })) === 'INVALID_DOCUMENT' && await code(alta(E, { docNumber: '1234' })) === 'INVALID_DOCUMENT')
  check('>>> mismo documento dos veces → DUPLICATE_CODE', await code(alta(E, { docNumber: f1.docNumber! })) === 'DUPLICATE_CODE')
  check('>>> el cajero, el vendedor, el almacenero y el contador NO crean clientes', (await Promise.all(['CAJERO', 'VENDEDOR', 'ALMACENERO', 'CONTADOR'].map((r) => code(alta(E, {}, ctxs[r]!))))).every((c) => c === 'FORBIDDEN_ROLE'))
  check('auditado: quién, qué y con qué documento', !!(await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'cliente.creado', entityId: a1.id, actorId: O.userId } })))
  const mismo = dni()
  const carrera = await Promise.allSettled(Array.from({ length: 5 }, () => alta(E, { docNumber: mismo, name: 'Carrera' })))
  check('>>> 5 altas simultáneas con el mismo documento: exactamente UNA entra y las otras reciben DUPLICATE_CODE (no un error crudo)', carrera.filter((r) => r.status === 'fulfilled').length === 1 && carrera.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason?.code === 'DUPLICATE_CODE'), JSON.stringify(carrera.map((r) => r.status === 'rejected' ? (r.reason as { code?: string }).code ?? (r.reason as Error).message.slice(0, 40) : 'ok')))

  console.log('\nD) Edición')
  const antesEd = await prisma.auditLog.count({ where: { tenantId: E.t.id, action: 'cliente.editado' } })
  const ed = await editarCliente(db, O, editarClienteSchema.parse({ customerId: a1.id, name: 'Ana Quispe Rojas', docNumber: f1.docNumber!, phone: '999111222', email: 'ana@x.com' }))
  const f2 = await prisma.customer.findUniqueOrThrow({ where: { id: a1.id } })
  check('>>> cambia nombre y teléfono; informa exactamente qué cambió; lo no enviado (dirección, notas) queda vacío', ed.cambios.join(',') === 'name,phone' && f2.name === 'Ana Quispe Rojas' && f2.phone === '999111222')
  const log = await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'cliente.editado', entityId: a1.id } })
  check('>>> auditoría con el ANTES y el DESPUÉS solo de lo que cambió', JSON.stringify(log?.before) === JSON.stringify({ name: 'Ana Quispe', phone: '987654321' }) && JSON.stringify(log?.after) === JSON.stringify({ name: 'Ana Quispe Rojas', phone: '999111222' }))
  const ed0 = await editarCliente(db, O, editarClienteSchema.parse({ customerId: a1.id, name: 'Ana Quispe Rojas', docNumber: f1.docNumber!, phone: '999111222', email: 'ana@x.com' }))
  check('guardar sin cambios no escribe ni audita', ed0.cambios.length === 0 && (await prisma.auditLog.count({ where: { tenantId: E.t.id, action: 'cliente.editado' } })) === antesEd + 1)
  check('>>> sin ventas el documento SÍ se puede cambiar (DNI nuevo)', (await editarCliente(db, O, editarClienteSchema.parse({ customerId: a1.id, name: 'Ana Quispe Rojas', docNumber: dni(), phone: '999111222', email: 'ana@x.com' }))).cambios.includes('docNumber'))
  const bea = await alta(E, { name: 'Beto Vega' })
  await vender(100, [{ method: 'YAPE', amount: 100 }], bea.id)
  const docBea = (await prisma.customer.findUniqueOrThrow({ where: { id: bea.id } })).docNumber!
  const intento = await msg(editarCliente(db, O, editarClienteSchema.parse({ customerId: bea.id, name: 'Beto Vega', docNumber: dni() })))
  check('>>> con ventas el documento NO se puede cambiar (mensaje claro) y no se toca nada', /ya tiene ventas/.test(intento ?? '') && (await prisma.customer.findUniqueOrThrow({ where: { id: bea.id } })).docNumber === docBea)
  check('con ventas sí se editan nombre, teléfono y dirección', (await editarCliente(db, O, editarClienteSchema.parse({ customerId: bea.id, name: 'Beto Vega Soto', docNumber: docBea, address: 'Jr. Lima 123' }))).cambios.join(',') === 'name,address')
  const cre = await alta(E, { name: 'Con Línea' })
  await linea(cre.id, 500)
  check('>>> a un cliente con línea de crédito no se le puede quitar el documento (no se le podría fiar ni cobrar)', /línea de crédito/.test((await msg(editarCliente(db, O, editarClienteSchema.parse({ customerId: cre.id, name: 'Con Línea' })))) ?? ''))
  check('>>> documento ya usado por otro cliente → DUPLICATE_CODE', await code(editarCliente(db, O, editarClienteSchema.parse({ customerId: cre.id, name: 'Con Línea', docNumber: docBea }))) === 'DUPLICATE_CODE' || await code(editarCliente(db, O, editarClienteSchema.parse({ customerId: a1.id, name: 'Ana', docNumber: docBea }))) === 'DUPLICATE_CODE')
  await prisma.customer.update({ where: { id: cre.id }, data: { creditTermDays: 45, creditBlockedAt: new Date('2026-02-01T00:00:00Z') } })
  const dineroAntes = JSON.stringify((({ creditLimit, creditTermDays, creditBalance, creditBlockedAt }) => ({ creditLimit, creditTermDays, creditBalance, creditBlockedAt }))(await prisma.customer.findUniqueOrThrow({ where: { id: cre.id } })))
  await editarCliente(db, O, editarClienteSchema.parse({ customerId: cre.id, name: 'Con Línea Editado', docNumber: (await prisma.customer.findUniqueOrThrow({ where: { id: cre.id } })).docNumber!, phone: '900000001' }))
  const dineroDespues = JSON.stringify((({ creditLimit, creditTermDays, creditBalance, creditBlockedAt }) => ({ creditLimit, creditTermDays, creditBalance, creditBlockedAt }))(await prisma.customer.findUniqueOrThrow({ where: { id: cre.id } })))
  check('>>> editar NO toca el dinero: línea 500, plazo 45, deuda y bloqueo idénticos antes y después', dineroAntes === dineroDespues && dineroAntes.includes('"creditLimit":"500"') && dineroAntes.includes('45'), dineroAntes)
  check('el cajero y el vendedor NO editan', (await Promise.all(['CAJERO', 'VENDEDOR'].map((r) => code(editarCliente(dbOf(ctxs[r]!), ctxs[r]!, editarClienteSchema.parse({ customerId: a1.id, name: 'Hack' })))))).every((c) => c === 'FORBIDDEN_ROLE'))
  const E2 = await negocio('b')
  const ajeno = await alta(E2, { name: 'De otro negocio' })
  check('>>> editar el cliente de OTRO negocio → no existe (nada se filtra)', await code(editarCliente(db, O, editarClienteSchema.parse({ customerId: ajeno.id, name: 'Robado' }))) === 'NOT_FOUND' && (await prisma.customer.findUniqueOrThrow({ where: { id: ajeno.id } })).name === 'De otro negocio')
  const carr = await alta(E, { name: 'Edita y Fía' })
  await linea(carr.id, 1000); await abrirCaja()
  const [rf, re2] = await Promise.allSettled([vender(100, [{ method: 'CREDITO', amount: 100 }], carr.id), editarCliente(db, O, editarClienteSchema.parse({ customerId: carr.id, name: 'Edita y Fía Editado', docNumber: (await prisma.customer.findUniqueOrThrow({ where: { id: carr.id } })).docNumber! }))])
  const fc = await prisma.customer.findUniqueOrThrow({ where: { id: carr.id } })
  check('>>> editar y fiar a la vez: ninguna operación pisa a la otra (nombre nuevo Y deuda 100)', rf.status === 'fulfilled' && re2.status === 'fulfilled' && fc.name === 'Edita y Fía Editado' && num(fc.creditBalance) === 100, JSON.stringify({ rf: rf.status === 'rejected' ? String(rf.reason?.message) : 'ok', name: fc.name, bal: String(fc.creditBalance) }))

  console.log('\nE) Baja y reactivación')
  const conDeuda = await alta(E, { name: 'Debe Dinero' })
  await linea(conDeuda.id, 500)
  await vender(150, [{ method: 'CREDITO', amount: 150 }], conDeuda.id)
  check('>>> con deuda NO se da de baja: error con el monto y el cliente sigue activo', /debe S\/ 150\.00/.test((await msg(darDeBajaCliente(db, O, bajaClienteSchema.parse({ customerId: conDeuda.id, motivo: 'se mudó' })))) ?? '') && (await prisma.customer.findUniqueOrThrow({ where: { id: conDeuda.id } })).deletedAt === null)
  const limpio = await alta(E, { name: 'Sin Deuda' })
  await darDeBajaCliente(db, O, bajaClienteSchema.parse({ customerId: limpio.id, motivo: 'duplicado de otro' }))
  const baja = await prisma.customer.findUniqueOrThrow({ where: { id: limpio.id } })
  check('>>> sin deuda: baja LÓGICA (deletedAt, inactivo), la fila sigue existiendo', baja.deletedAt !== null && !baja.isActive)
  check('auditada con el motivo', (await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'cliente.baja', entityId: limpio.id } }))?.reason === 'duplicado de otro')
  check('darlo de baja dos veces → error; editarlo estando de baja → error', await code(darDeBajaCliente(db, O, bajaClienteSchema.parse({ customerId: limpio.id, motivo: 'otra vez' }))) === 'INVALID_DOCUMENT' && await code(editarCliente(db, O, editarClienteSchema.parse({ customerId: limpio.id, name: 'Zombi' }))) === 'INVALID_DOCUMENT')
  check('>>> el cajero NO da de baja', await code(darDeBajaCliente(dbOf(ctxs.CAJERO!), ctxs.CAJERO!, bajaClienteSchema.parse({ customerId: carr.id, motivo: 'intento' }))) === 'FORBIDDEN_ROLE')
  const docBaja = baja.docNumber!
  check('>>> el documento de un cliente de baja NO se reutiliza: crear otro → mensaje claro; el POS también (no un error crudo)', /dado de baja/.test((await msg(alta(E, { docNumber: docBaja }))) ?? '') && /dado de baja/.test((await msg(resolverCliente(db, O, { docNumber: docBaja, name: 'Otro' }))) ?? ''))
  await reactivarCliente(db, O, reactivarClienteSchema.parse({ customerId: limpio.id }))
  const re = await prisma.customer.findUniqueOrThrow({ where: { id: limpio.id } })
  check('>>> reactivar: vuelve a estar activo y auditado; reactivar a uno activo → error', re.deletedAt === null && re.isActive && !!(await prisma.auditLog.findFirst({ where: { tenantId: E.t.id, action: 'cliente.reactivado', entityId: limpio.id } })) && await code(reactivarCliente(db, O, reactivarClienteSchema.parse({ customerId: limpio.id }))) === 'INVALID_DOCUMENT')
  let rotos = 0
  for (let i = 0; i < 4; i++) {
    const z = await alta(E, { name: `Carrera Baja ${i}` })
    await linea(z.id, 500)
    const R = await Promise.allSettled([vender(100, [{ method: 'CREDITO', amount: 100 }], z.id), darDeBajaCliente(db, O, bajaClienteSchema.parse({ customerId: z.id, motivo: 'carrera' }))])
    const fz = await prisma.customer.findUniqueOrThrow({ where: { id: z.id } })
    if (fz.deletedAt !== null && num(fz.creditBalance) > 0) rotos++
    if (R.every((r) => r.status === 'fulfilled')) rotos++   // las dos no pueden ganar: o hay deuda o está de baja
  }
  check('>>> baja y venta fiada a la vez (4 rondas): NUNCA queda un cliente de baja con deuda, y nunca ganan las dos', rotos === 0, `${rotos} incoherentes`)

  // Una venta fiada EN VUELO: otra transacción tiene bloqueado al cliente y le subirá la deuda a 100 dentro de 1,5 s.
  const enVuelo = await alta(E, { name: 'Fiado En Vuelo' })
  await linea(enVuelo.id, 500)
  const fiando = prisma.$transaction(async (tx) => {
    await tx.customer.update({ where: { id: enVuelo.id }, data: { creditBalance: { increment: 0 } } })
    await new Promise((r) => setTimeout(r, 1500))
    await tx.customer.update({ where: { id: enVuelo.id }, data: { creditBalance: 100 } })
  }, { timeout: 20_000 })
  await new Promise((r) => setTimeout(r, 400))
  const bajaTardia = await msg(darDeBajaCliente(db, O, bajaClienteSchema.parse({ customerId: enVuelo.id, motivo: 'carrera determinista' })))
  await fiando
  check('>>> dar de baja ESPERA a la venta fiada en vuelo, ve la deuda ya firme (S/ 100.00) y se rechaza: el cliente no queda de baja con deuda', /debe S\/ 100\.00/.test(bajaTardia ?? '') && (await prisma.customer.findUniqueOrThrow({ where: { id: enVuelo.id } })).deletedAt === null, String(bajaTardia).slice(0, 120))

  console.log('\nF) Lista')
  const L = await negocio('l')
  const Lo = L.O, Ldb = L.dbOf(Lo)
  const mk = (name: string, o: Record<string, unknown> = {}) => alta(L, { name, ...o }, Lo)
  const cNombres = ['Álvaro Ramos', 'Beatriz Soto', 'Carlos Díaz', 'Diana Paz', 'Elena Cruz', 'Fabio Luna', 'Gloria Mesa']
  const ids: Record<string, string> = {}
  for (const nm of cNombres) ids[nm] = (await mk(nm, { phone: `9${Math.floor(Math.random() * 1e8)}` })).id
  const sinDoc = await mk('Hugo Sin Papeles', { docNumber: undefined })
  await L.abrirCaja()
  await L.linea(ids['Beatriz Soto']!, 1000); await L.vender(300, [{ method: 'CREDITO', amount: 300 }], ids['Beatriz Soto']!)
  await L.linea(ids['Carlos Díaz']!, 500); const vC = await L.vender(200, [{ method: 'CREDITO', amount: 200 }], ids['Carlos Díaz']!)
  await prisma.receivable.updateMany({ where: { saleId: vC.saleId }, data: { dueDate: new Date('2026-01-10T00:00:00Z') } })
  await prisma.customer.update({ where: { id: ids['Diana Paz']! }, data: { creditBlockedAt: new Date() } })
  await darDeBajaCliente(Ldb, Lo, bajaClienteSchema.parse({ customerId: ids['Gloria Mesa']!, motivo: 'prueba' }))
  const lista = (o: Record<string, unknown> = {}, c: TenantContext = Lo) => listarClientes(L.dbOf(c), c, listarClientesSchema.parse(o))
  const todos = await lista()
  check('>>> TODOS: los activos por orden alfabético (sin el dado de baja)', todos.items.map((x) => x.name).join('|') === ['Álvaro Ramos', 'Beatriz Soto', 'Carlos Díaz', 'Diana Paz', 'Elena Cruz', 'Fabio Luna', 'Hugo Sin Papeles'].join('|'), todos.items.map((x) => x.name).join('|'))
  const bea2 = todos.items.find((x) => x.name === 'Beatriz Soto')!, car2 = todos.items.find((x) => x.name === 'Carlos Díaz')!
  check('>>> cada fila trae línea, deuda y disponible; y lo vencido aparte', bea2.limite === 1000 && bea2.deuda === 300 && bea2.disponible === 700 && bea2.vencido === 0 && car2.deuda === 200 && car2.vencido === 200 && car2.cuentasVencidas === 1)
  check('>>> CON_DEUDA: solo Beatriz y Carlos', (await lista({ filtro: 'CON_DEUDA' })).items.map((x) => x.name).join('|') === 'Beatriz Soto|Carlos Díaz')
  check('>>> VENCIDOS: solo Carlos (la deuda de Beatriz aún no vence)', (await lista({ filtro: 'VENCIDOS' })).items.map((x) => x.name).join('|') === 'Carlos Díaz')
  check('>>> BLOQUEADOS: solo Diana', (await lista({ filtro: 'BLOQUEADOS' })).items.map((x) => x.name).join('|') === 'Diana Paz')
  check('>>> SIN_DOCUMENTO: solo Hugo', (await lista({ filtro: 'SIN_DOCUMENTO' })).items.map((x) => x.id).join('|') === sinDoc.id)
  check('>>> DE_BAJA: solo Gloria, y solo para quien gestiona', (await lista({ filtro: 'DE_BAJA' })).items.map((x) => x.name).join('|') === 'Gloria Mesa' && await code(lista({ filtro: 'DE_BAJA' }, L.ctxs.CAJERO!)) === 'FORBIDDEN_ROLE')
  check('>>> búsqueda por nombre sin importar mayúsculas (aunque el nombre lleve tilde en otra letra)', (await lista({ q: 'carlos' })).items.map((x) => x.name).join('|') === 'Carlos Díaz' && (await lista({ q: 'SOTO' })).items.length === 1)
  const docC = (await prisma.customer.findUniqueOrThrow({ where: { id: ids['Fabio Luna']! } }))
  check('búsqueda por documento y por teléfono', (await lista({ q: docC.docNumber! })).items[0]?.name === 'Fabio Luna' && (await lista({ q: docC.phone! })).items[0]?.name === 'Fabio Luna')
  check('>>> búsqueda COMBINADA con filtro (q + SIN_DOCUMENTO) no pisa ninguno de los dos', (await lista({ q: 'hugo', filtro: 'SIN_DOCUMENTO' })).items.length === 1 && (await lista({ q: 'carlos', filtro: 'SIN_DOCUMENTO' })).items.length === 0)
  const p1 = await lista({ limite: 3 }), p2 = await lista({ limite: 3, cursor: p1.siguiente! }), p3 = await lista({ limite: 3, cursor: p2.siguiente! })
  check('>>> paginación de 3 en 3 (7 activos): 3, 3, 1; sin repetidos ni saltos y la última sin «siguiente»', [p1, p2, p3].map((p) => p.items.length).join(',') === '3,3,1' && p3.siguiente === null && new Set([...p1.items, ...p2.items, ...p3.items].map((x) => x.id)).size === 7 && [...p1.items, ...p2.items, ...p3.items].map((x) => x.name).join('|') === todos.items.map((x) => x.name).join('|'))
  check('>>> el cajero VE la lista (credito.cobrar); vendedor, almacenero y contador NO', (await lista({}, L.ctxs.CAJERO!)).items.length === 7 && (await Promise.all(['VENDEDOR', 'ALMACENERO', 'CONTADOR'].map((r) => code(lista({}, L.ctxs[r]!))))).every((c) => c === 'FORBIDDEN_ROLE'))
  check('>>> la lista nunca trae clientes de OTRO negocio', !(await lista({ limite: 100 })).items.some((x) => x.name === 'De otro negocio') && (await listarClientes(E2.dbOf(E2.O), E2.O, listarClientesSchema.parse({}))).items.every((x) => x.name === 'De otro negocio'))

  console.log('\nG) Ficha')
  const G = await negocio('g')
  const Go = G.O, Gdb = G.dbOf(Go)
  const g1 = await alta(G, { name: 'Gaby Ficha', phone: '911222333', address: 'Av. Sol 1' })
  await G.linea(g1.id, 800, 20); await G.abrirCaja()
  const gv1 = await G.vender(300, [{ method: 'CREDITO', amount: 300 }], g1.id), gv2 = await G.vender(200, [{ method: 'CREDITO', amount: 200 }], g1.id), gv3 = await G.vender(50, [{ method: 'CREDITO', amount: 50 }], g1.id)
  await prisma.receivable.updateMany({ where: { saleId: gv2.saleId }, data: { dueDate: new Date('2026-01-05T00:00:00Z') } })
  const ab1 = await registrarAbono(Gdb, Go, registrarAbonoSchema.parse({ customerId: g1.id, method: 'EFECTIVO', amount: 80, idempotencyKey: randomUUID() }))
  const ab2 = await registrarAbono(Gdb, Go, registrarAbonoSchema.parse({ customerId: g1.id, method: 'YAPE', amount: 20, idempotencyKey: randomUUID() }))
  await anularAbono(Gdb, Go, anularAbonoSchema.parse({ paymentId: ab2.paymentId, motivo: 'error al digitar' }))
  const fi = await obtenerFichaCliente(Gdb, Go, g1.id)
  check('>>> ficha: datos, línea 800, deuda 470 (550 − 80), plazo 20', fi.name === 'Gaby Ficha' && fi.phone === '911222333' && fi.credito.limite === 800 && fi.credito.deuda === 470 && fi.credito.plazoDias === 20)
  check('>>> cuentas abiertas ordenadas por vencimiento: la vencida primero y marcada; con su saldo (la primera absorbió el abono FIFO)', fi.cuentasAbiertas.length === 3 && fi.cuentasAbiertas[0]!.vencida && fi.cuentasAbiertas[0]!.venta === (await prisma.sale.findUniqueOrThrow({ where: { id: gv2.saleId } })).number && fi.cuentasAbiertas[0]!.saldo === 120 && fi.cuentasAbiertas.slice(1).every((x) => !x.vencida) && fi.credito.vencido === 120)
  check('>>> abonos: el más reciente primero, con su método, quién cobró y el anulado marcado con su motivo', fi.abonos.length === 2 && fi.abonos[0]!.anulado && fi.abonos[0]!.motivoAnulacion === 'error al digitar' && !fi.abonos[1]!.anulado && fi.abonos[1]!.monto === 80 && fi.abonos[1]!.metodo === 'EFECTIVO' && fi.abonos[1]!.cobradoPor === 'OWNER')
  check('con ventas el documento no es editable', fi.documentoEditable === false && (await obtenerFichaCliente(Gdb, Go, (await alta(G, { name: 'Recién Creado' })).id)).documentoEditable === true)
  void ab1; void gv1; void gv3
  check('>>> el cajero ve la ficha; el vendedor no', (await obtenerFichaCliente(G.dbOf(G.ctxs.CAJERO!), G.ctxs.CAJERO!, g1.id)).name === 'Gaby Ficha' && await code(obtenerFichaCliente(G.dbOf(G.ctxs.VENDEDOR!), G.ctxs.VENDEDOR!, g1.id)) === 'FORBIDDEN_ROLE')
  check('>>> la ficha de OTRO negocio no existe', await code(obtenerFichaCliente(Gdb, Go, ajeno.id)) === 'NOT_FOUND')
  const gb = await alta(G, { name: 'Dado De Baja' }); await darDeBajaCliente(Gdb, Go, bajaClienteSchema.parse({ customerId: gb.id, motivo: 'prueba ficha' }))
  check('>>> un cliente de baja lo ve quien gestiona (para reactivarlo) pero NO el cajero', (await obtenerFichaCliente(Gdb, Go, gb.id)).activo === false && await code(obtenerFichaCliente(G.dbOf(G.ctxs.CAJERO!), G.ctxs.CAJERO!, gb.id)) === 'NOT_FOUND')
  const antesFicha = JSON.stringify(await prisma.customer.findUniqueOrThrow({ where: { id: g1.id } }))
  await obtenerFichaCliente(Gdb, Go, g1.id); await listarClientes(Gdb, Go, listarClientesSchema.parse({}))
  check('>>> consultar es de SOLO LECTURA: el cliente queda idéntico', JSON.stringify(await prisma.customer.findUniqueOrThrow({ where: { id: g1.id } })) === antesFicha)

  console.log('\nH) Estructura')
  const svc = readFileSync('src/features/clientes/service.ts', 'utf8')
  const act = readFileSync('src/features/clientes/actions.ts', 'utf8')
  check('>>> el servicio no contiene SQL crudo', !/\$queryRaw|\$executeRaw/.test(svc))
  check('>>> el bloqueo del servicio ES el del crédito (bloquearCliente, el UPDATE que toma la fila), no una lectura', /async function bloquear\(t[\s\S]*?return await bloquearCliente\(t, customerId\)/.test(svc))
  check('>>> editar y dar de baja BLOQUEAN al cliente antes de leer; sin SQL crudo', /async function editarCliente[\s\S]*?await bloquear\(t,[\s\S]*?findFirst\(\{ where: \{ id: input\.customerId \}/.test(svc) && /async function darDeBajaCliente[\s\S]*?await bloquear\(t,/.test(svc) && !/\$queryRaw|\$executeRaw/.test(svc))
  check('>>> las acciones son "use server", validan con Zod, pasan por la sesión y no deciden permisos (lo hace el servicio)', act.startsWith("'use server'") && act.includes('requireTenantContext') && !/puede\(|exigir\(/.test(act) && (act.match(/export async function/g) ?? []).length === 6 && !/export (const|let|class)/.test(act))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
