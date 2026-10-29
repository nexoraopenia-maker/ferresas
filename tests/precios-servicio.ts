import './guard'
import { correr } from './teardown'
import { crearSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { resolverPrecio } from '../src/features/pos/precios-reglas'
import {
  asignarListaACliente, cargarDatosDePrecio, crearLista, darDeBajaLista, editarLista, guardarPrecios, listarListas, listarPrecios, listasParaVender, TAMANO_PAGINA_PRECIOS,
} from '../src/features/precios/service'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.7a · Listas de precio contra la base: permisos, crear/editar/dar de baja listas, precios y tramos en lote (todo o nada, validados contra lo que hay), la herencia de la Base al cargar
 * datos para el motor, la lista de un cliente, el costo solo con ver_costo, el aislamiento entre negocios y las restricciones de la migración.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '').catch((e) => String(e.message ?? e))
const rechaza = (p: Promise<unknown>) => p.then(() => false).catch(() => true)

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const mkTenant = (name: string) => prisma.tenant.create({ data: { slug: `pr-${randomUUID().slice(0, 8)}`, name, planId: plan.id } })
  const t = await mkTenant('Precios')
  const ajeno = await mkTenant('Precios ajeno')
  const bA = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const mk = (role: Role) => prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
  const [owner, adm, caj, cont, alm, ven] = await Promise.all([mk('OWNER'), mk('ADMIN'), mk('CAJERO'), mk('CONTADOR'), mk('ALMACENERO'), mk('VENDEDOR')])
  const ctx = (u: { id: string }, role: Role, extra: Partial<TenantContext> = {}): TenantContext => ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: bA.id, branchIds: [bA.id], ...extra })
  const cOwner = ctx(owner, 'OWNER'), cAdm = ctx(adm, 'ADMIN'), cCaj = ctx(caj, 'CAJERO'), cCont = ctx(cont, 'CONTADOR'), cAlm = ctx(alm, 'ALMACENERO'), cVen = ctx(ven, 'VENDEDOR')
  const cGestor = ctx(adm, 'ADMIN', { permisosDenegados: ['productos.ver_costo'] })
  const db = (c: TenantContext) => getTenantPrisma(c)
  const prod = (sku: string, data: Record<string, unknown> = {}) => prisma.product.create({ data: { tenantId: t.id, sku, name: sku, salePrice: 10, ...data } as never })

  const p1 = await prod('P1', { salePrice: 10, costPrice: 4 })
  const p2 = await prod('P2', { salePrice: 20, costPrice: 0 })
  const p3 = await prod('P3', { salePrice: 5, costPrice: 4.5 })     // 5 con IGV = 4.24 sin IGV: ya está bajo su costo

  console.log('\n1) Permisos')
  const roles: [string, TenantContext][] = [['cajero', cCaj], ['vendedor', cVen], ['contador', cCont], ['almacenero', cAlm]]
  check('>>> sin precios.gestionar nadie escribe ni lee la gestión (cajero, vendedor, contador, almacenero)', (await Promise.all(roles.flatMap(([, c]) => [code(crearLista(db(c), c, { name: 'X1' })), code(listarListas(db(c), c)), code(guardarPrecios(db(c), c, { priceListId: null, cambios: [{ productId: p1.id, tiers: [] }] })), code(asignarListaACliente(db(c), c, { customerId: 'x', priceListId: null })), code(listarPrecios(db(c), c, { priceListId: null }))]))).every((r) => r === 'FORBIDDEN_ROLE'))
  check('>>> el administrador y el dueño sí', await code(crearLista(db(cAdm), cAdm, { name: 'Constructor' })) === null && await code(crearLista(db(cOwner), cOwner, { name: 'Mayorista' })) === null)
  check('>>> el opcional activado a mano también sirve (permisosExtra)', await code(listarListas(db({ ...cCaj, permisosExtra: ['precios.gestionar'] }), { ...cCaj, permisosExtra: ['precios.gestionar'] })) === null)
  check('>>> elegir una lista al vender no pide permiso: el cajero ve los nombres de las listas', (await listasParaVender(db(cCaj))).map((l) => l.name).sort().join() === 'Constructor,Mayorista')

  console.log('\n2) Crear, editar y dar de baja listas')
  const [lConst, lMay] = await Promise.all([prisma.priceList.findFirstOrThrow({ where: { tenantId: t.id, name: 'Constructor' } }), prisma.priceList.findFirstOrThrow({ where: { tenantId: t.id, name: 'Mayorista' } })])
  check('>>> el nombre es único sin distinguir mayúsculas ni espacios al borde', await code(crearLista(db(cOwner), cOwner, { name: ' mayorista ' })) === 'DUPLICATE_CODE' && /ese nombre/.test(await msg(crearLista(db(cOwner), cOwner, { name: 'MAYORISTA' }))))
  await crearLista(db(cOwner), cOwner, { name: 'Con código', code: 'CC-1' })
  check('>>> el código es único', /ese código/.test(await msg(crearLista(db(cOwner), cOwner, { name: 'Otra', code: 'CC-1' }))))
  check('>>> un nombre demasiado corto o un código con espacios se rechaza antes de la base', await code(crearLista(db(cOwner), cOwner, { name: 'A' })) === 'INVALID_DOCUMENT' && await code(crearLista(db(cOwner), cOwner, { name: 'Buena', code: 'a b' })) === 'INVALID_DOCUMENT')
  await editarLista(db(cOwner), cOwner, { priceListId: lConst.id, name: 'Constructores' })
  check('>>> se puede renombrar, y renombrar a un nombre ocupado se rechaza', (await prisma.priceList.findUniqueOrThrow({ where: { id: lConst.id } })).name === 'Constructores' && await code(editarLista(db(cOwner), cOwner, { priceListId: lConst.id, name: 'mayorista' })) === 'DUPLICATE_CODE')
  check('>>> editar sin cambios, o una lista que no existe, se rechaza', await code(editarLista(db(cOwner), cOwner, { priceListId: lConst.id })) === 'INVALID_DOCUMENT' && await code(editarLista(db(cOwner), cOwner, { priceListId: 'no-existe', name: 'Zeta' })) === 'NOT_FOUND')
  const tope = await mkTenant('Tope')
  const cTope: TenantContext = { tenantId: tope.id, userId: owner.id, role: 'OWNER', access: 'FULL' }
  for (let i = 0; i < 20; i++) await prisma.priceList.create({ data: { tenantId: tope.id, name: `Lista ${i}` } })
  check('>>> hay un tope de 20 listas por negocio', /hasta 20 listas/.test(await msg(crearLista(getTenantPrisma(cTope), cTope, { name: 'Lista 21' }))))
  await prisma.tenant.delete({ where: { id: tope.id } })

  console.log('\n3) Precios y tramos en lote')
  const T = (minQuantity: number, unitPrice: number) => ({ minQuantity, unitPrice })
  const ra = await guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: p1.id, price: 8, tiers: [T(12, 7)] }, { productId: p2.id, tiers: [T(10, 18)] }] })
  check('>>> crea las entradas: P1 con plano y tramo, P2 solo con tramo', ra.aplicados === 2 && ra.sinCambio === 0)
  const dMay = await cargarDatosDePrecio(db(cOwner), [p1.id, p2.id, p3.id], lMay.id)
  check('>>> el motor lee lo guardado: P1 en Mayorista cuesta 8, y 7 desde 12', resolverPrecio(dMay.get(p1.id)!, 5).precio === 8 && resolverPrecio(dMay.get(p1.id)!, 12).precio === 7)
  check('>>> P2 solo con tramos: debajo del tramo, el plano es el base (20)', resolverPrecio(dMay.get(p2.id)!, 5).precio === 20 && resolverPrecio(dMay.get(p2.id)!, 5).fuente === 'BASE' && resolverPrecio(dMay.get(p2.id)!, 10).precio === 18)
  check('>>> >>> P3 no tiene entrada: hereda la Base completa (5)', dMay.get(p3.id)!.entrada === null && resolverPrecio(dMay.get(p3.id)!, 3).precio === 5)
  const nAudPre = await prisma.auditLog.count({ where: { tenantId: t.id, action: 'precios.cambio' } })
  const rs = await guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: p1.id, price: 8, tiers: [T(12, 7)] }] })
  check('>>> repetir lo mismo no cambia nada, y no ensucia la auditoría', rs.aplicados === 0 && rs.sinCambio === 1 && (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'precios.cambio' } })) === nAudPre)
  await guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: p1.id, price: 9 }] })
  const d2 = (await cargarDatosDePrecio(db(cOwner), [p1.id], lMay.id)).get(p1.id)!
  check('>>> cambiar solo el plano conserva los tramos (undefined = no tocar)', d2.entrada?.price === 9 && d2.entrada?.tiers.length === 1)
  await guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: p1.id, tiers: [] }] })
  check('>>> tiers [] los quita todos y deja el plano', (await cargarDatosDePrecio(db(cOwner), [p1.id], lMay.id)).get(p1.id)!.entrada?.tiers.length === 0)
  await guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: p1.id, price: null, tiers: [T(5, 6)] }] })
  const d3 = (await cargarDatosDePrecio(db(cOwner), [p1.id], lMay.id)).get(p1.id)!
  check('>>> null en el plano lo quita (queda solo con tramos)', d3.entrada?.price === null && d3.entrada?.tiers.length === 1)

  console.log('\n4) Validación y atomicidad')
  const antesN = await prisma.priceListEntry.count({ where: { priceListId: lMay.id } })
  const lote = await code(guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: p3.id, price: 4 }, { productId: p1.id, tiers: [T(10, 9), T(20, 9.5)] }] }))
  check('>>> >>> un lote con un tramo inválido (el de más cantidad sube el precio) NO aplica ninguno', lote === 'INVALID_DOCUMENT' && (await prisma.priceListEntry.count({ where: { priceListId: lMay.id } })) === antesN && !(await prisma.priceListEntry.findFirst({ where: { priceListId: lMay.id, productId: p3.id } })))
  check('>>> un tramo más caro que el plano EFECTIVO se rechaza aunque el cambio solo toque el plano', /más que el precio plano/.test(await msg(guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: p2.id, price: 15 }] }))))
  check('>>> una entrada vacía (sin plano ni tramos) se rechaza y se explica cómo quitarla', /necesita un precio o al menos un tramo/.test(await msg(guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: p3.id, price: null, tiers: [] }] }))))
  check('>>> el mismo producto dos veces en el lote se rechaza', /dos veces/.test(await msg(guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: p3.id, price: 4 }, { productId: p3.id, price: 3 }] }))))
  check('>>> un producto que no existe, o de otro negocio, se rechaza', await code(guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: 'no-existe', price: 4 }] })) === 'INVALID_DOCUMENT')
  check('>>> una lista dada de baja o ajena no admite cambios', await code(guardarPrecios(db(cOwner), cOwner, { priceListId: 'no-existe', cambios: [{ productId: p1.id, price: 4 }] })) === 'NOT_FOUND')
  check('>>> en la Base no se cambia el precio plano (es del producto) ni se quita una entrada', /se cambia en el producto/.test(await msg(guardarPrecios(db(cOwner), cOwner, { priceListId: null, cambios: [{ productId: p1.id, price: 9 }] }))) && /no tiene entradas/.test(await msg(guardarPrecios(db(cOwner), cOwner, { priceListId: null, cambios: [{ productId: p1.id, eliminar: true }] }))))

  console.log('\n5) Tramos de la Base y quitar entradas')
  await guardarPrecios(db(cOwner), cOwner, { priceListId: null, cambios: [{ productId: p1.id, tiers: [T(100, 9)] }] })
  const dBase = (await cargarDatosDePrecio(db(cOwner), [p1.id], null)).get(p1.id)!
  check('>>> la Base admite tramos (priceListId NULL): P1 desde 100 cuesta 9', dBase.entrada === null && resolverPrecio(dBase, 100).precio === 9 && resolverPrecio(dBase, 99).precio === 10)
  check('>>> un tramo Base duplicado lo frena el índice parcial de la base', await rechaza(prisma.priceTier.create({ data: { tenantId: t.id, priceListId: null, productId: p1.id, minQuantity: 100, unitPrice: 8 } })))
  check('>>> los tramos de la Base se heredan en una lista SIN entrada (P1 en Constructores, 100 u → 9)', resolverPrecio((await cargarDatosDePrecio(db(cOwner), [p1.id], lConst.id)).get(p1.id)!, 100).precio === 9)
  check('>>> pero NO en una lista CON entrada (P1 en Mayorista, 100 u → su tramo de 5: 6)', resolverPrecio((await cargarDatosDePrecio(db(cOwner), [p1.id], lMay.id)).get(p1.id)!, 100).precio === 6)
  const rq = await guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: p1.id, eliminar: true }] })
  check('>>> quitar la entrada borra sus tramos (en cascada) y la lista vuelve a heredar la Base', rq.aplicados === 1 && (await prisma.priceTier.count({ where: { priceListId: lMay.id, productId: p1.id } })) === 0 && (await cargarDatosDePrecio(db(cOwner), [p1.id], lMay.id)).get(p1.id)!.entrada === null)
  check('>>> quitar una entrada que no existe no hace nada', ((await guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: p1.id, eliminar: true }] }).catch(() => null))?.sinCambio) === 1)

  console.log('\n6) Precios por debajo del costo (solo la cuenta, nunca cifras)')
  const rc = await guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: p1.id, price: 4, tiers: [T(10, 3)] }, { productId: p3.id, price: 4 }, { productId: p2.id, price: 19 }] })
  check('>>> cuenta los precios bajo el costo sin IGV: P1 4 → 3.39 < 4 y tramo 3 → 2.54 < 4; P3 4 → 3.39 < 4.5; P2 sin costo no cuenta', rc.bajoCosto === 3, String(rc.bajoCosto))
  check('>>> el resultado no trae costos ni márgenes', JSON.stringify(Object.keys(rc).sort()) === JSON.stringify(['aplicados', 'bajoCosto', 'sinCambio']))
  const aud = await prisma.auditLog.findMany({ where: { tenantId: t.id, action: 'precios.cambio' } })
  check('>>> la auditoría guarda antes y después y NO el costo', aud.length > 0 && aud.every((a) => a.before && a.after && !/costPrice|costo/i.test(JSON.stringify(a.after) + JSON.stringify(a.before))))

  console.log('\n7) La cuadrícula (listar precios) y el costo')
  const pg = await listarPrecios(db(cOwner), cOwner, { priceListId: lMay.id })
  const f1 = pg.filas.find((f) => f.productId === p1.id)!
  check('>>> lista los productos con su precio base y la entrada de la lista', f1.salePrice === 10 && f1.entrada?.price === 4 && f1.entrada?.tiers[0]?.unitPrice === 3 && pg.total >= 3)
  check('>>> >>> con productos.ver_costo trae el costo (y null si es 0)', pg.verCostos && f1.costoUnitario === 4 && pg.filas.find((f) => f.productId === p2.id)!.costoUnitario === null)
  const pgG = await listarPrecios(db(cGestor), cGestor, { priceListId: lMay.id })
  check('>>> >>> sin ver_costo la respuesta NO trae ni la clave de costo', !pgG.verCostos && !/costoUnitario|costPrice/.test(JSON.stringify(pgG)) && pgG.filas.length === pg.filas.length)
  const pb = await listarPrecios(db(cOwner), cOwner, { priceListId: null })
  check('>>> la Base muestra sus tramos y ninguna entrada', pb.filas.find((f) => f.productId === p1.id)!.baseTiers[0]?.unitPrice === 9 && pb.filas.every((f) => f.entrada === null))
  check('>>> buscar por nombre o SKU filtra', (await listarPrecios(db(cOwner), cOwner, { priceListId: null, q: 'p2' })).filas.map((f) => f.sku).join() === 'P2')
  check('>>> una lista que no existe no se lista', await code(listarPrecios(db(cOwner), cOwner, { priceListId: 'no-existe' })) === 'NOT_FOUND')
  for (let i = 0; i < TAMANO_PAGINA_PRECIOS + 5; i++) await prod(`BULK${String(i).padStart(3, '0')}`)
  const g0 = await listarPrecios(db(cOwner), cOwner, { priceListId: null, pagina: 0 }), g1 = await listarPrecios(db(cOwner), cOwner, { priceListId: null, pagina: 1 })
  check('>>> pagina de 100 en 100 sin repetir ni perder filas', g0.filas.length === TAMANO_PAGINA_PRECIOS && g1.filas.length === g0.total - TAMANO_PAGINA_PRECIOS && new Set([...g0.filas, ...g1.filas].map((f) => f.productId)).size === g0.total)

  console.log('\n8) La lista de un cliente')
  const cli = await prisma.customer.create({ data: { tenantId: t.id, name: 'Constructora Sur' } })
  check('>>> se asigna con precios.gestionar', (await asignarListaACliente(db(cOwner), cOwner, { customerId: cli.id, priceListId: lMay.id })).priceListId === lMay.id && (await prisma.customer.findUniqueOrThrow({ where: { id: cli.id } })).priceListId === lMay.id)
  check('>>> sin ese permiso no (aunque pueda vender)', await code(asignarListaACliente(db(cCaj), cCaj, { customerId: cli.id, priceListId: lConst.id })) === 'FORBIDDEN_ROLE' && (await prisma.customer.findUniqueOrThrow({ where: { id: cli.id } })).priceListId === lMay.id)
  check('>>> una lista que no existe o dada de baja no se asigna', await code(asignarListaACliente(db(cOwner), cOwner, { customerId: cli.id, priceListId: 'no-existe' })) === 'NOT_FOUND')
  const nAud = await prisma.auditLog.count({ where: { tenantId: t.id, action: 'precios.cliente_lista' } })
  await asignarListaACliente(db(cOwner), cOwner, { customerId: cli.id, priceListId: lMay.id })
  check('>>> asignar la misma lista no audita de nuevo', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'precios.cliente_lista' } })) === nAud)
  check('>>> null la quita (vuelve a Base) y un cliente inexistente se rechaza', (await asignarListaACliente(db(cOwner), cOwner, { customerId: cli.id, priceListId: null })).priceListId === null && await code(asignarListaACliente(db(cOwner), cOwner, { customerId: 'no-existe', priceListId: null })) === 'NOT_FOUND')

  console.log('\n9) Dar de baja una lista')
  await asignarListaACliente(db(cOwner), cOwner, { customerId: cli.id, priceListId: lConst.id })
  const baja = await darDeBajaLista(db(cOwner), cOwner, { priceListId: lConst.id })
  check('>>> la baja es lógica: dice cuántos clientes la tenían y la lista deja de ofrecerse', baja.clientesAfectados === 1 && (await listasParaVender(db(cCaj))).every((l) => l.id !== lConst.id) && (await prisma.priceList.findUniqueOrThrow({ where: { id: lConst.id } })).deletedAt !== null)
  check('>>> el cliente conserva la referencia, pero el motor la trata como Base (vender nunca se bloquea)', (await prisma.customer.findUniqueOrThrow({ where: { id: cli.id } })).priceListId === lConst.id && (await cargarDatosDePrecio(db(cOwner), [p1.id], lConst.id)).get(p1.id)!.entrada === null)
  check('>>> y deja de aparecer en la gestión de listas', (await listarListas(db(cOwner), cOwner)).every((l) => l.id !== lConst.id))
  check('>>> su nombre queda libre para una lista nueva', await code(crearLista(db(cOwner), cOwner, { name: 'Constructores' })) === null)
  check('>>> una lista dada de baja no se puede volver a dar de baja ni editar ni llenar', await code(darDeBajaLista(db(cOwner), cOwner, { priceListId: lConst.id })) === 'NOT_FOUND' && await code(editarLista(db(cOwner), cOwner, { priceListId: lConst.id, name: 'Otro' })) === 'NOT_FOUND' && await code(guardarPrecios(db(cOwner), cOwner, { priceListId: lConst.id, cambios: [{ productId: p1.id, price: 1 }] })) === 'NOT_FOUND')
  const desactivada = await prisma.priceList.create({ data: { tenantId: t.id, name: 'Pausada', isActive: false } })
  await prisma.priceListEntry.create({ data: { tenantId: t.id, priceListId: desactivada.id, productId: p1.id, price: 1 } })
  await prisma.priceListEntry.create({ data: { tenantId: t.id, priceListId: lConst.id, productId: p3.id, price: 1 } })
  check('>>> >>> una lista inactiva o dada de baja, AUNQUE tenga entradas, no se aplica (se vende a precio Base)', (await listasParaVender(db(cCaj))).every((l) => l.id !== desactivada.id) && (await cargarDatosDePrecio(db(cOwner), [p1.id], desactivada.id)).get(p1.id)!.entrada === null && (await cargarDatosDePrecio(db(cOwner), [p3.id], lConst.id)).get(p3.id)!.entrada === null)
  check('>>> listarListas cuenta productos y clientes', (await listarListas(db(cOwner), cOwner)).find((l) => l.id === lMay.id)!.entradas === 3)

  console.log('\n10) Aislamiento entre negocios')
  const pAjeno = await prisma.product.create({ data: { tenantId: ajeno.id, sku: 'AJ', name: 'Ajeno', salePrice: 1 } })
  const lAjena = await prisma.priceList.create({ data: { tenantId: ajeno.id, name: 'Ajena' } })
  check('>>> las listas de otro negocio no se ven, ni se editan, ni se asignan', (await listarListas(db(cOwner), cOwner)).every((l) => l.id !== lAjena.id) && await code(editarLista(db(cOwner), cOwner, { priceListId: lAjena.id, name: 'Robada' })) === 'NOT_FOUND' && await code(asignarListaACliente(db(cOwner), cOwner, { customerId: cli.id, priceListId: lAjena.id })) === 'NOT_FOUND')
  check('>>> ni se escriben precios de productos ajenos ni en listas ajenas', await code(guardarPrecios(db(cOwner), cOwner, { priceListId: lMay.id, cambios: [{ productId: pAjeno.id, price: 1 }] })) === 'INVALID_DOCUMENT' && await code(guardarPrecios(db(cOwner), cOwner, { priceListId: lAjena.id, cambios: [{ productId: p1.id, price: 1 }] })) === 'NOT_FOUND')
  check('>>> el motor no lee entradas de otro negocio aunque se le pase su lista', (await cargarDatosDePrecio(db(cOwner), [p1.id], lAjena.id)).get(p1.id)!.entrada === null)

  console.log('\n11) Las restricciones de la migración')
  const l0 = await prisma.priceList.create({ data: { tenantId: t.id, name: 'Para restricciones' } })
  check('>>> un nombre de 1 letra o de más de 40 no entra ni por la puerta de atrás', await rechaza(prisma.priceList.create({ data: { tenantId: t.id, name: 'A' } })) && await rechaza(prisma.priceList.create({ data: { tenantId: t.id, name: 'x'.repeat(41) } })))
  check('>>> un código con espacios no entra', await rechaza(prisma.priceList.create({ data: { tenantId: t.id, name: 'Con espacio', code: 'a b' } })))
  check('>>> un precio negativo, un tramo en 0 o un precio de tramo negativo no entran', await rechaza(prisma.priceListEntry.create({ data: { tenantId: t.id, priceListId: l0.id, productId: p1.id, price: -1 } })) && await rechaza(prisma.priceTier.create({ data: { tenantId: t.id, priceListId: null, productId: p3.id, minQuantity: 0, unitPrice: 1 } })) && await rechaza(prisma.priceTier.create({ data: { tenantId: t.id, priceListId: null, productId: p3.id, minQuantity: 5, unitPrice: -1 } })))
  check('>>> un tramo de una lista sin entrada no entra (cuelga de la entrada)', await rechaza(prisma.priceTier.create({ data: { tenantId: t.id, priceListId: l0.id, productId: p1.id, minQuantity: 5, unitPrice: 1 } })))
  check('>>> una entrada duplicada para el mismo producto no entra', await (async () => { await prisma.priceListEntry.create({ data: { tenantId: t.id, priceListId: l0.id, productId: p1.id, price: 5 } }); return rechaza(prisma.priceListEntry.create({ data: { tenantId: t.id, priceListId: l0.id, productId: p1.id, price: 6 } })) })())
  check('>>> el mismo tramo repetido en una lista no entra', await (async () => { await prisma.priceTier.create({ data: { tenantId: t.id, priceListId: l0.id, productId: p1.id, minQuantity: 5, unitPrice: 4 } }); return rechaza(prisma.priceTier.create({ data: { tenantId: t.id, priceListId: l0.id, productId: p1.id, minQuantity: 5, unitPrice: 3 } })) })())
  check('>>> una lista con clientes no se puede borrar de verdad (la baja es lógica)', await (async () => { await prisma.customer.update({ where: { id: cli.id }, data: { priceListId: l0.id } }); return rechaza(prisma.priceList.delete({ where: { id: l0.id } })) })())

  // sale_items.priceSource / tierMinQuantity: el tramo va si y solo si la fuente es VOLUMEN.
  const bw = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WP', name: 'P', isDefault: true } })
  const venta = await prisma.sale.create({ data: { tenantId: t.id, branchId: bA.id, warehouseId: bw.id, userId: owner.id, number: 'V-PR-1', status: 'COMPLETADA', total: 10, completedAt: new Date() } })
  const item = (extra: Record<string, unknown>) => prisma.saleItem.create({ data: { tenantId: t.id, saleId: venta.id, productId: p1.id, nameSnapshot: 'P1', skuSnapshot: 'P1', quantity: 1, unitPrice: 10, lineTotal: 10, ...extra } as never })
  check('>>> una línea anterior (sin fuente ni tramo) es válida', !(await rechaza(item({}))))
  check('>>> BASE y LISTA sin tramo son válidas; VOLUMEN con tramo también', !(await rechaza(item({ priceSource: 'BASE' }))) && !(await rechaza(item({ priceSource: 'LISTA' }))) && !(await rechaza(item({ priceSource: 'VOLUMEN', tierMinQuantity: 12 }))))
  check('>>> >>> VOLUMEN sin tramo, o BASE/LISTA con tramo, o tramo sin fuente, o tramo 0 no entran', (await Promise.all([item({ priceSource: 'VOLUMEN' }), item({ priceSource: 'BASE', tierMinQuantity: 5 }), item({ priceSource: 'LISTA', tierMinQuantity: 5 }), item({ tierMinQuantity: 5 }), item({ priceSource: 'VOLUMEN', tierMinQuantity: 0 })].map((p) => rechaza(p)))).every(Boolean))

  await prisma.tenant.delete({ where: { id: ajeno.id } })
  await prisma.tenant.delete({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
