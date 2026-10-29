import './guard'
import { correr } from './teardown'
import { crearSucursal, asignarSucursal, abrirTurno } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { resolveTenantContext } from '../src/lib/session'
import { extrasPorTopes, topeDeRol, topeDeRoles, topeDescuento, validarDescuentoLinea } from '../src/lib/descuentos'
import { puede } from '../src/lib/puede'
import { registerSale } from '../src/features/pos/sale-service'
import { registerQuote } from '../src/features/pos/quote-service'
import { cobrarPedido, crearPedido, tomarPedido } from '../src/features/pos/pedido-service'
import { convertQuoteSchema, registerQuoteSchema, registerSaleSchema } from '../src/features/pos/schemas'
import { fijarTope, listarTopes } from '../src/features/usuarios/descuentos-service'
import { contextoDeOperador } from '../src/features/seguridad/pin-service'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '').catch((e) => String(e.message))
const lanza = (f: () => void) => { try { f(); return null } catch (e) { return (e as { code?: string }).code ?? 'ERR' } }
const base = (role: Role, extra: Partial<TenantContext> = {}): TenantContext => ({ tenantId: 't', userId: 'u', role, access: 'FULL', ...extra })

async function main() {
  console.log('\n1) Reglas puras')
  check('sin configuración: dueño y administrador 100 %, el resto 0 %',
    topeDeRol('OWNER') === 100 && topeDeRol('ADMIN') === 100 && topeDeRol('VENDEDOR') === 0 && topeDeRol('CAJERO') === 0 && topeDeRol('ALMACENERO') === 0 && topeDeRol('CONTADOR') === 0)
  check('>>> el tope del DUEÑO no se puede limitar ni con una fila en 0', topeDeRol('OWNER', { OWNER: 0 }) === 100)
  check('el del administrador sí', topeDeRol('ADMIN', { ADMIN: 20 }) === 20)
  check('con varios roles vale el más alto', topeDeRoles(['CAJERO', 'VENDEDOR'], { CAJERO: 5, VENDEDOR: 12 }) === 12)
  check('>>> un tope > 0 de VENDEDOR o CAJERO activa su permiso opcional', extrasPorTopes(['CAJERO'], { CAJERO: 5 }).join() === 'ventas.descuento' && extrasPorTopes(['VENDEDOR'], { VENDEDOR: 1 }).length === 1)
  check('con tope 0, no', extrasPorTopes(['CAJERO'], { CAJERO: 0 }).length === 0 && extrasPorTopes(['CAJERO'], {}).length === 0)
  check('>>> un tope de ALMACENERO o CONTADOR no activa nada (su permiso no es opcional)', extrasPorTopes(['ALMACENERO'], { ALMACENERO: 50 }).length === 0 && extrasPorTopes(['CONTADOR'], { CONTADOR: 50 }).length === 0)
  const cajeroCon5 = base('CAJERO', { permisosExtra: ['ventas.descuento'], topesDescuento: { CAJERO: 5 } })
  check('topeDescuento: con permiso y tope 5 → 5', topeDescuento(cajeroCon5) === 5)
  check('>>> sin el permiso → 0 aunque haya tope', topeDescuento(base('CAJERO', { topesDescuento: { CAJERO: 5 } })) === 0)
  check('contexto sin configuración y con el permiso: el permiso decide (100)', topeDescuento(base('CAJERO', { permisosExtra: ['ventas.descuento'] })) === 100)
  check('descuentoMaxPct fijado manda (operador por PIN)', topeDescuento({ ...cajeroCon5, descuentoMaxPct: 2 }) === 2)
  check('descuento 0 siempre pasa, aunque no haya permiso', lanza(() => validarDescuentoLinea(base('ALMACENERO'), 'X', 100, 0)) === null)
  check('>>> sin permiso, cualquier descuento se rechaza', lanza(() => validarDescuentoLinea(base('CAJERO'), 'X', 100, 0.01)) === 'FORBIDDEN_ROLE')
  check('dentro del tope pasa y justo en el tope también', lanza(() => validarDescuentoLinea(cajeroCon5, 'X', 100, 5)) === null)
  check('>>> un céntimo por encima se rechaza', lanza(() => validarDescuentoLinea(cajeroCon5, 'X', 100, 5.01)) === 'FORBIDDEN_ROLE')
  check('>>> el redondeo a céntimos no castiga: 5 % de 33,33 es 1,67', lanza(() => validarDescuentoLinea(cajeroCon5, 'X', 33.33, 1.67)) === null && lanza(() => validarDescuentoLinea(cajeroCon5, 'X', 33.33, 1.68)) === 'FORBIDDEN_ROLE')
  check('el mensaje dice el tope y el máximo en soles', (() => { try { validarDescuentoLinea(cajeroCon5, 'Cemento', 200, 20) } catch (e) { return /5%/.test((e as Error).message) && /10\.00/.test((e as Error).message) } return false })())

  console.log('\n2) Preparar el negocio')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `ds-${randomUUID().slice(0, 8)}`, name: 'Descuentos', planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' } })
  const otro = await prisma.tenant.create({ data: { slug: `ds2-${randomUUID().slice(0, 8)}`, name: 'Otro', planId: plan.id } })
  const bA = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const wA = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WA', name: 'A', isDefault: true } })
  const mk = async (role: Role, tag: string) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${tag}-${randomUUID()}@x.com`.toLowerCase(), name: tag, role } })
    await asignarSucursal(t.id, u.id, bA.id)
    return u
  }
  const owner = await mk('OWNER', 'dueno'), admin = await mk('ADMIN', 'admin'), vend = await mk('VENDEDOR', 'vendedor')
  const cajero = await mk('CAJERO', 'cajero'), conta = await mk('CONTADOR', 'contador')
  for (const u of [owner, admin, vend, cajero, conta]) await abrirTurno(t.id, u.id, bA.id)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Cemento', salePrice: 100 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: wA.id, quantity: 1000 } })
  const ctx = (u: { id: string }) => resolveTenantContext(u.id)
  const g = (c: TenantContext) => getTenantPrisma(c)

  const venta = (c: TenantContext, descuento: number, cantidad = 1) =>
    registerSale(g(c), c, registerSaleSchema.parse({
      warehouseId: wA.id, items: [{ productId: prod.id, quantity: cantidad, discount: descuento }],
      payments: [{ method: 'EFECTIVO', amount: 100 * cantidad - descuento }], idempotencyKey: randomUUID(),
    }))

  console.log('\n3) >>> El hueco: antes cualquiera con ventas.cobrar daba el descuento que quisiera')
  let cCajero = await ctx(cajero)
  check('un cajero SIN tope configurado cobra sin descuento', await code(venta(cCajero, 0)) === null)
  check('>>> y si manda un descuento (invocando la acción a mano) se rechaza', await code(venta(cCajero, 10)) === 'FORBIDDEN_ROLE')
  check('>>> el administrador y el dueño sí pueden (100 % por defecto)', await code(venta(await ctx(admin), 30)) === null && await code(venta(await ctx(owner), 30)) === null)

  console.log('\n4) Configurar los topes')
  const cOwner = await ctx(owner), cAdmin = await ctx(admin), cConta = await ctx(conta)
  await fijarTope(g(cOwner), cOwner, { role: 'CAJERO', maxPercent: 5 })
  await fijarTope(g(cAdmin), cAdmin, { role: 'VENDEDOR', maxPercent: 10 })
  const topes = await listarTopes(g(cOwner), cOwner)
  check('>>> el dueño y el administrador fijan el de cajero y vendedor', topes.find((x) => x.role === 'CAJERO')?.maxPercent === 5 && topes.find((x) => x.role === 'VENDEDOR')?.maxPercent === 10)
  check('el listado marca qué puede editar cada uno', topes.every((x) => x.editable) && !(await listarTopes(g(cAdmin), cAdmin)).find((x) => x.role === 'ADMIN')!.editable)
  check('>>> el administrador NO puede fijar el suyo (solo el dueño)', await code(fijarTope(g(cAdmin), cAdmin, { role: 'ADMIN', maxPercent: 100 })) === 'FORBIDDEN_ROLE')
  check('el dueño sí puede limitar al administrador', await code(fijarTope(g(cOwner), cOwner, { role: 'ADMIN', maxPercent: 40 })) === null)
  check('>>> el contador no configura topes', await code(fijarTope(g(cConta), cConta, { role: 'CAJERO', maxPercent: 50 })) === 'FORBIDDEN_ROLE')
  check('>>> ni el cajero ni el vendedor', await code(fijarTope(g(cCajero), cCajero, { role: 'CAJERO', maxPercent: 50 })) === 'FORBIDDEN_ROLE')
  for (const [rol, pct, por] of [['OWNER', 50, 'el dueño no se limita'], ['ALMACENERO', 5, 'no vende'], ['CONTADOR', 5, 'no vende'], ['CAJERO', 101, 'más de 100'], ['CAJERO', -1, 'negativo'], ['CAJERO', 5.555, 'más de 2 decimales']] as const) {
    check(`>>> se rechaza ${rol} ${pct}% (${por})`, await code(fijarTope(g(cOwner), cOwner, { role: rol, maxPercent: pct })) === 'INVALID_DOCUMENT')
  }
  const aud = await prisma.auditLog.findFirst({ where: { tenantId: t.id, action: 'descuento.tope', entityId: 'CAJERO' } })
  check('queda auditado con el valor anterior y el nuevo', JSON.stringify(aud?.before).includes('0') && JSON.stringify(aud?.after).includes('5'))
  check('un cambio de otro negocio no afecta a este', await (async () => {
    const dbO = getTenantPrisma({ tenantId: otro.id, userId: 'x', role: 'OWNER', access: 'FULL' })
    return (await dbO.discountCap.count()) === 0
  })())

  console.log('\n5) La sesión recoge el tope')
  cCajero = await ctx(cajero)
  check('>>> el cajero con tope 5 ahora TIENE ventas.descuento (se le activó el opcional)', puede(cCajero, 'ventas.descuento') && topeDescuento(cCajero) === 5)
  const cVend = await ctx(vend), cAdmin2 = await ctx(admin)
  check('el vendedor tiene 10 y el administrador 40', topeDescuento(cVend) === 10 && topeDescuento(cAdmin2) === 40)
  check('>>> el contador, que no vende, 0 aunque se le pusiera tope', topeDescuento(await ctx(conta)) === 0)

  console.log('\n6) Vender con descuento')
  check('>>> el cajero da 5 % (5,00 sobre 100)', await code(venta(cCajero, 5)) === null)
  check('>>> 5,01 se rechaza', await code(venta(cCajero, 5.01)) === 'FORBIDDEN_ROLE')
  check('con varias unidades el tope es sobre la LÍNEA: 3 × 100 → hasta 15', await code(venta(cCajero, 15, 3)) === null && await code(venta(cCajero, 15.01, 3)) === 'FORBIDDEN_ROLE')
  check('el mensaje orienta', /5%/.test(await msg(venta(cCajero, 50))))
  const ventaDesc = await prisma.auditLog.findFirst({ where: { tenantId: t.id, action: 'sale.discount', actorId: cajero.id } })
  check('>>> toda venta con descuento deja constancia: quién, cuánto y con qué tope', !!ventaDesc && JSON.stringify(ventaDesc.after).includes('"tope":5'))
  check('una venta sin descuento no genera ese registro', await (async () => {
    const antes = await prisma.auditLog.count({ where: { tenantId: t.id, action: 'sale.discount' } })
    await venta(cCajero, 0)
    return (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'sale.discount' } })) === antes
  })())
  await fijarTope(g(cOwner), cOwner, { role: 'CAJERO', maxPercent: 0 })
  check('>>> bajar el tope a 0 le quita el descuento en su siguiente petición', await code(venta(await ctx(cajero), 1)) === 'FORBIDDEN_ROLE' && !puede(await ctx(cajero), 'ventas.descuento'))
  await fijarTope(g(cOwner), cOwner, { role: 'CAJERO', maxPercent: 5 })

  console.log('\n7) Cotizaciones y pedidos')
  const cot = (c: TenantContext, descuento: number) => registerQuote(g(c), c, registerQuoteSchema.parse({ warehouseId: wA.id, items: [{ productId: prod.id, quantity: 1, discount: descuento }] }))
  check('el vendedor cotiza con 10 %', await code(cot(cVend, 10)) === null)
  check('>>> y con 11 % se rechaza (también las cotizaciones)', await code(cot(cVend, 11)) === 'FORBIDDEN_ROLE')
  const ped = await crearPedido(g(cVend), cVend, registerQuoteSchema.parse({ warehouseId: wA.id, items: [{ productId: prod.id, quantity: 2, discount: 20 }] }))
  check('el vendedor arma un pedido con 10 % de descuento (20 sobre 200)', !!ped.quoteId)
  check('>>> y 21 se rechaza', await code(crearPedido(g(cVend), cVend, registerQuoteSchema.parse({ warehouseId: wA.id, items: [{ productId: prod.id, quantity: 2, discount: 21 }] }))) === 'FORBIDDEN_ROLE')
  await fijarTope(g(cOwner), cOwner, { role: 'CAJERO', maxPercent: 1 })
  const cCajero1 = await ctx(cajero)
  await tomarPedido(g(cCajero1), cCajero1, ped.quoteId)
  const cobro = await cobrarPedido(g(cCajero1), cCajero1, convertQuoteSchema.parse({ quoteId: ped.quoteId, payments: [{ method: 'EFECTIVO', amount: 180 }], idempotencyKey: randomUUID() }))
  const v = await prisma.sale.findUniqueOrThrow({ where: { id: cobro.saleId } })
  check('>>> el cajero (tope 1 %) COBRA el pedido con el 10 % que autorizó el vendedor, sin revalidar', Number(v.discountTotal) === 20 && Number(v.total) === 180)
  check('pero ese mismo cajero no podría dar 10 % por su cuenta', await code(venta(cCajero1, 10)) === 'FORBIDDEN_ROLE')

  console.log('\n8) Operador por PIN: nunca más que la sesión ni que él')
  const sesion = (rol: Role, extra: Role[] = []): TenantContext => base(rol, {
    roles: extra, permisosExtra: ['ventas.descuento'], topesDescuento: { VENDEDOR: 10, CAJERO: 5, ADMIN: 40 }, branchId: 'b', branchIds: ['b'],
  })
  const op = (rol: Role) => ({ id: 'op', role: rol, extraRoles: [] as Role[] })
  check('>>> sesión del DUEÑO (100) + operador cajero (5) → 5', topeDescuento(contextoDeOperador({ ...sesion('OWNER'), permisosExtra: undefined }, op('CAJERO'))) === 5)
  check('>>> sesión de cajero (5) + operador ADMIN (40) → 5, no 40', topeDescuento(contextoDeOperador(sesion('CAJERO'), op('ADMIN'))) === 5)
  check('sesión de vendedor (10) + operador cajero (5) → 5', topeDescuento(contextoDeOperador(sesion('VENDEDOR'), op('CAJERO'))) === 5)
  check('>>> sesión de cajero SIN tope (0) + operador vendedor (10) → 0: no hereda el permiso', topeDescuento(contextoDeOperador(base('CAJERO', { topesDescuento: { VENDEDOR: 10 }, branchId: 'b' }), op('VENDEDOR'))) === 0)

  await prisma.tenant.deleteMany({ where: { id: { in: [t.id, otro.id] } } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
