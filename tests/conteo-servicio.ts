import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import {
  anularPasada, cancelarConteo, cerrarConteo, crearConteo, iniciarConteo, lineasDelConteo, listarConteos, obtenerConteo, pasadasDeLinea, registrarPasada,
} from '../src/features/inventory/conteo-service'
import { anularPasadaSchema, cancelarConteoSchema, cerrarConteoSchema, crearConteoSchema, iniciarConteoSchema, registrarPasadaSchema } from '../src/features/inventory/conteo-schemas'
import { permisosDenegadosAlOperador } from '../src/features/seguridad/pin-reglas'
import { PERMISOS } from '../src/lib/permisos'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.5a · El ciclo de vida de la toma de inventario contra la base: permisos y PIN, crear (idempotente, un solo conteo abierto por almacén, alcances), iniciar
 * (la foto del stock, sin tocar el stock), pasadas (aditivas, idempotentes, con zona y presentación), anular, el conteo ciego, cerrar y cancelar, la auditoría y el
 * aislamiento por negocio y sucursal.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const err = (p: Promise<unknown>) => p.then(() => null).catch((e) => e as { code?: string; message: string })
const num = (d: { toString(): string } | null | undefined) => (d === null || d === undefined ? null : Number(d.toString()))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 500) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-cnt-${randomUUID().slice(0, 6)}`, name: 'Conteo servicio', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cnt' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const W1 = b1.warehouse.id, W2 = b2.warehouse.id
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ADMIN', 'ALMACENERO', 'CAJERO', 'VENDEDOR', 'CONTADOR'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    for (const b of [b1, b2]) await asignarSucursal(t.id, x.id, b.branch.id)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: [] }
  }
  const O = u.OWNER!, AD = u.ADMIN!, AL = u.ALMACENERO!, CA = u.CAJERO!, VE = u.VENDEDOR!, CO = u.CONTADOR!
  const x2 = await prisma.user.create({ data: { tenantId: t.id, email: `AL2-${randomUUID()}@x.com`.toLowerCase(), name: 'ALMACENERO2', role: 'ALMACENERO' } })
  await asignarSucursal(t.id, x2.id, b1.branch.id)
  const AL2: TenantContext = { ...AL, userId: x2.id, branchIds: [b1.branch.id] }            // otro almacenero, solo de la sucursal 1
  const ALG: TenantContext = { ...AL, permisosExtra: ['conteo.gestionar'], branchIds: [b1.branch.id] }   // almacenero con el permiso opcional, solo sucursal 1
  const PIN: TenantContext = { ...O, operadorDe: O.userId, permisosDenegados: permisosDenegadosAlOperador(new Set(PERMISOS)) }
  const db = (c: TenantContext) => getTenantPrisma(c)

  const cat1 = await prisma.category.create({ data: { tenantId: t.id, name: 'Cementos', slug: 'cementos' } })
  const cat2 = await prisma.category.create({ data: { tenantId: t.id, name: 'Pinturas', slug: 'pinturas' } })
  const prod = (sku: string, o: Record<string, unknown> = {}) => prisma.product.create({ data: { tenantId: t.id, sku, name: `Producto ${sku}`, unitType: 'UNIDAD', salePrice: 10, costPrice: 4, ...o } })
  const P1 = await prod('P1', { categoryId: cat1.id }), P2 = await prod('P2', { categoryId: cat1.id }), P3 = await prod('P3', { categoryId: cat2.id })
  const PV = await prod('PV', { categoryId: cat2.id }), SERV = await prod('SERV', { trackStock: false }), NUEVO = await prod('NUEVO', { categoryId: cat1.id })
  const va = await prisma.productVariant.create({ data: { tenantId: t.id, productId: PV.id, sku: 'PV-A', name: 'Rojo' } })
  const vb = await prisma.productVariant.create({ data: { tenantId: t.id, productId: PV.id, sku: 'PV-B', name: 'Azul' } })
  const pres = await prisma.productPresentation.create({ data: { tenantId: t.id, productId: P1.id, name: 'Caja x12', unitType: 'UNIDAD', factor: 12 } })
  const stock = (p: string, w: string, q: number, v: string | null = null) => prisma.stock.create({ data: { tenantId: t.id, productId: p, warehouseId: w, variantId: v, quantity: q } })
  await stock(P1.id, W1, 10); await stock(P2.id, W1, 5); await stock(P3.id, W1, 0); await stock(PV.id, W1, 3, va.id); await stock(PV.id, W1, 4, vb.id); await stock(P1.id, W2, 7)
  await stock(SERV.id, W1, 3)   // un producto que dejó de llevar control de stock pero conserva su fila: no entra a ningún conteo
  const stockTotal = async () => Number((await prisma.stock.aggregate({ where: { tenantId: t.id }, _sum: { quantity: true } }))._sum.quantity ?? 0)
  const movimientos = () => prisma.stockMovement.count({ where: { tenantId: t.id } })

  const crear = (c: TenantContext, o: Record<string, unknown> = {}) => crearConteo(db(c), c, crearConteoSchema.parse({ warehouseId: W1, scope: 'TOTAL', idempotencyKey: randomUUID(), ...o }))
  const iniciar = (c: TenantContext, id: string) => iniciarConteo(db(c), c, iniciarConteoSchema.parse({ countId: id }))
  const cerrar = (c: TenantContext, id: string) => cerrarConteo(db(c), c, cerrarConteoSchema.parse({ countId: id }))
  const cancelar = (c: TenantContext, id: string, reason = 'Se contó con otro criterio') => cancelarConteo(db(c), c, cancelarConteoSchema.parse({ countId: id, reason }))
  const pasada = (c: TenantContext, countId: string, productId: string, quantity: number, o: Record<string, unknown> = {}) =>
    registrarPasada(db(c), c, registrarPasadaSchema.parse({ countId, productId, quantity, idempotencyKey: randomUUID(), ...o }))
  const anularP = (c: TenantContext, entryId: string, reason = 'Conté dos veces') => anularPasada(db(c), c, anularPasadaSchema.parse({ entryId, reason }))
  const linea = (countId: string, productId: string, variantId: string | null = null) => prisma.inventoryCountItem.findFirst({ where: { countId, productId, variantId } })
  const stockAntes = await stockTotal(), movAntes = await movimientos()

  console.log('\nA) Permisos y PIN de operador')
  check('>>> cajero, vendedor y contador no pueden crear ni ver conteos (FORBIDDEN_ROLE)', (await Promise.all([CA, VE, CO].map((c) => code(crear(c)))) ).every((x) => x === 'FORBIDDEN_ROLE') && (await code(listarConteos(db(CA), CA))) === 'FORBIDDEN_ROLE' && (await code(obtenerConteo(db(CO), CO, 'x'))) === 'FORBIDDEN_ROLE')
  check('>>> el almacenero solo cuenta: no puede crear, iniciar, cerrar ni cancelar (le falta conteo.gestionar)', (await code(crear(AL))) === 'FORBIDDEN_ROLE' && (await code(iniciar(AL, 'x'))) === 'FORBIDDEN_ROLE' && (await code(cerrar(AL, 'x'))) === 'FORBIDDEN_ROLE' && (await code(cancelar(AL, 'x'))) === 'FORBIDDEN_ROLE')
  check('>>> con el PIN de operador (aunque sea el dueño) no se gestiona un conteo', (await code(crear(PIN))) === 'FORBIDDEN_ROLE')
  check('>>> dueño, administrador y almacenero con el permiso opcional sí crean', await (async () => { const a = await crear(O, { warehouseId: W2 }); await cancelar(O, a.id); const b = await crear(AD, { warehouseId: W2 }); await cancelar(AD, b.id); const c = await crear(ALG); await cancelar(ALG, c.id); return !!a.id && !!b.id && !!c.id })())
  check('>>> el almacenero con el opcional no ve el kardex de costos ni cambia stock: solo gestiona conteos (no tiene stock.ajustar de fábrica)', !(AL.permisosExtra ?? []).includes('stock.ajustar'))

  console.log('\nB) Crear')
  const k1 = randomUUID()
  const c1 = await crear(O, { idempotencyKey: k1 })
  check('>>> un conteo total nace en BORRADOR con número CF001-… (serie de la sucursal 1), modo ciego y SIN líneas todavía (nacen al empezar)', c1.status === 'BORRADOR' && /^CF001-\d{8}$/.test(c1.number) && c1.mode === 'CIEGO' && c1.lineas === 0 && c1.warehouse.id === W1 && c1.scope === 'TOTAL' && !c1.replayed)
  check('>>> informa cuántas líneas tendrá (las 5 filas de stock del almacén con control de stock)', c1.previstas === 5, String(c1.previstas))
  const replay = await crear(O, { idempotencyKey: k1 })
  check('>>> reenviar con la misma clave devuelve el MISMO conteo y no gasta un número', replay.id === c1.id && replay.replayed === true && (await prisma.inventoryCount.count({ where: { tenantId: t.id, idempotencyKey: k1 } })) === 1)
  const dup = await err(crear(AD))
  check('>>> no se abre otro conteo en el mismo almacén mientras haya uno abierto (aunque sea de otra persona)', dup?.code === 'INVALID_DOCUMENT' && dup.message.includes(c1.number), dup?.message)
  const otroAlm = await crear(O, { warehouseId: W2 })
  check('>>> otro almacén sí puede tener su conteo, con SU serie (CF002…) y numeración propia', /^CF002-\d{8}$/.test(otroAlm.number) && otroAlm.warehouse.id === W2)
  await cancelar(O, otroAlm.id)
  check('>>> un almacén que no existe, de otro negocio o dado de baja: NOT_FOUND', (await code(crear(O, { warehouseId: 'no-existe' }))) === 'NOT_FOUND')
  const otro = await prisma.tenant.create({ data: { slug: `rp-cnt2-${randomUUID().slice(0, 6)}`, name: 'Otro', taxId: ruc(), planId: plan.id } })
  const wOtro = await crearSucursalConAlmacen(otro.id)
  check('>>> el almacén de otro negocio es NOT_FOUND', (await code(crear(O, { warehouseId: wOtro.warehouse.id }))) === 'NOT_FOUND')
  check('>>> el almacenero de la sucursal 1 no crea en un almacén de la sucursal 2', (await code(crear(ALG, { warehouseId: W2 }))) === 'NOT_FOUND')
  await cancelar(O, c1.id)
  check('>>> al cancelar el abierto, ya se puede abrir otro en el almacén', (await crear(O)).status === 'BORRADOR')
  const abierto = await prisma.inventoryCount.findFirstOrThrow({ where: { tenantId: t.id, warehouseId: W1, status: 'BORRADOR' } })
  await cancelar(O, abierto.id)

  console.log('\nC) Alcances')
  const cCat = await crear(O, { scope: 'CATEGORIA', categoryId: cat1.id })
  check('>>> por categoría prevé solo los productos de esa categoría (P1 y P2)', cCat.previstas === 2 && cCat.scope === 'CATEGORIA' && cCat.categoryId === cat1.id)
  await cancelar(O, cCat.id)
  check('>>> una categoría que no existe: NOT_FOUND', (await code(crear(O, { scope: 'CATEGORIA', categoryId: 'no-existe' }))) === 'NOT_FOUND')
  const cSel = await crear(O, { scope: 'SELECCION', productIds: [P1.id, PV.id, NUEVO.id], mode: 'GUIADO' })
  const lSel = await prisma.inventoryCountItem.findMany({ where: { countId: cSel.id }, orderBy: { skuSnapshot: 'asc' } })
  check('>>> una selección crea sus líneas YA: P1, las 2 variantes de PV y el producto sin fila de stock (4 líneas), sin foto todavía', cSel.lineas === 4 && lSel.length === 4 && lSel.every((l) => l.systemQtyAtStart === null && l.status === 'PENDIENTE') && lSel.map((l) => l.skuSnapshot).join() === 'NUEVO,P1,PV-A,PV-B')
  check('>>> la línea de una variante lleva producto y variante en su nombre', lSel.find((l) => l.skuSnapshot === 'PV-A')!.nameSnapshot === 'Producto PV · Rojo' && lSel.find((l) => l.skuSnapshot === 'PV-A')!.variantId === va.id)
  await cancelar(O, cSel.id)
  check('>>> una selección con un servicio (sin control de stock) o un producto ajeno se rechaza', (await code(crear(O, { scope: 'SELECCION', productIds: [P1.id, SERV.id] }))) === 'INVALID_DOCUMENT' && (await code(crear(O, { scope: 'SELECCION', productIds: ['no-existe'] }))) === 'INVALID_DOCUMENT')

  console.log('\nD) Iniciar: la foto del stock, sin tocar el stock')
  const c2 = await crear(O)
  check('>>> antes de iniciar no se puede contar', (await err(pasada(AL, c2.id, P1.id, 3)))?.message.includes('todavía no se inició') === true)
  await prisma.stock.create({ data: { tenantId: t.id, productId: NUEVO.id, warehouseId: W1, quantity: 9 } })   // nace después de crear, antes de iniciar
  const i2 = await iniciar(O, c2.id)
  const lin2 = await prisma.inventoryCountItem.findMany({ where: { countId: c2.id } })
  check('>>> al iniciar pasa a EN_CONTEO y se generan las líneas del almacén (incluida la fila nacida entre crear e iniciar)', i2.status === 'EN_CONTEO' && i2.startedAt !== null && lin2.length === 6 && lin2.some((l) => l.productId === NUEVO.id))
  const f = (p: string, v: string | null = null) => lin2.find((l) => l.productId === p && l.variantId === v)!
  check('>>> cada línea guarda la FOTO del stock (P1 10, P2 5, P3 0, variantes 3 y 4, nuevo 9)', num(f(P1.id).systemQtyAtStart) === 10 && num(f(P2.id).systemQtyAtStart) === 5 && num(f(P3.id).systemQtyAtStart) === 0 && num(f(PV.id, va.id).systemQtyAtStart) === 3 && num(f(PV.id, vb.id).systemQtyAtStart) === 4 && num(f(NUEVO.id).systemQtyAtStart) === 9)
  check('>>> y la unidad, el nombre y el SKU quedan copiados en la línea', f(P1.id).nameSnapshot === 'Producto P1' && f(P1.id).skuSnapshot === 'P1' && f(P1.id).unitType === 'UNIDAD' && f(PV.id, vb.id).nameSnapshot === 'Producto PV · Azul')
  check('>>> iniciar NO toca el stock ni crea movimientos (el conteo no mueve nada hasta aplicarse)', (await stockTotal()) === stockAntes + 9 && (await movimientos()) === movAntes)
  check('>>> no se puede iniciar dos veces', (await code(iniciar(O, c2.id))) === 'INVALID_DOCUMENT')
  const cSel2 = await (async () => { await cancelar(O, c2.id); const s = await crear(O, { scope: 'SELECCION', productIds: [P1.id, NUEVO.id, PV.id] }); await iniciar(O, s.id); return s })()
  const lS = await prisma.inventoryCountItem.findMany({ where: { countId: cSel2.id } })
  check('>>> en una selección, al iniciar se pone la foto a las líneas que ya existían', lS.length === 4 && num(lS.find((l) => l.productId === P1.id)!.systemQtyAtStart) === 10 && num(lS.find((l) => l.productId === NUEVO.id)!.systemQtyAtStart) === 9)
  await cancelar(O, cSel2.id)
  await prisma.stock.deleteMany({ where: { tenantId: t.id, productId: NUEVO.id } })

  console.log('\nE) Pasadas: aditivas, idempotentes, con zona y presentación')
  const c3 = await crear(O)
  await iniciar(O, c3.id)
  const e1 = await pasada(AL, c3.id, P1.id, 7)
  check('>>> una pasada suma a su línea: P1 contado 7, la línea queda CONTADO', e1.contado === 7 && !e1.replayed && (await linea(c3.id, P1.id))!.status === 'CONTADO' && num((await linea(c3.id, P1.id))!.countedQty) === 7)
  const e2 = await pasada(AL2, c3.id, P1.id, 2.5, { zone: '  Pasillo 3  ' })
  check('>>> otra persona cuenta el mismo producto en otra zona: se SUMA (7 + 2.5 = 9.5) sin pisar a nadie', e2.contado === 9.5 && e2.itemId === e1.itemId)
  const pasadas = await pasadasDeLinea(db(O), O, e1.itemId)
  check('>>> el detalle de la línea muestra las dos pasadas con quién, cuánto y en qué zona (recortada)', pasadas.length === 2 && pasadas[0]!.usuario === 'ALMACENERO' && pasadas[1]!.usuario === 'ALMACENERO2' && pasadas[1]!.zona === 'Pasillo 3' && pasadas[0]!.zona === null && pasadas.every((p) => !p.anulada))
  const k2 = randomUUID()
  const e3 = await pasada(AL, c3.id, P2.id, 0, { idempotencyKey: k2 })
  check('>>> contar CERO es contar: la línea queda CONTADO con 0 (distinto de PENDIENTE)', e3.contado === 0 && (await linea(c3.id, P2.id))!.status === 'CONTADO' && num((await linea(c3.id, P2.id))!.countedQty) === 0)
  const e3b = await registrarPasada(db(AL), AL, registrarPasadaSchema.parse({ countId: c3.id, productId: P2.id, quantity: 0, idempotencyKey: k2 }))
  check('>>> reenviar la misma pasada (reintento del móvil) devuelve la primera y NO suma de nuevo', e3b.replayed && e3b.entryId === e3.entryId && (await prisma.inventoryCountEntry.count({ where: { idempotencyKey: k2 } })) === 1)
  check('>>> usar la misma clave para OTRA cosa es un error (no se pisa la pasada anterior)', (await code(pasada(AL, c3.id, P3.id, 1, { idempotencyKey: k2 }))) === 'INVALID_DOCUMENT')
  const e4 = await pasada(AL, c3.id, P1.id, 24, { presentationId: pres.id, enteredQuantity: 2 })
  const fila4 = await prisma.inventoryCountEntry.findUniqueOrThrow({ where: { id: e4.entryId } })
  check('>>> contar en cajas: 2 cajas × 12 = 24 en unidad base, con la presentación guardada (y suma a la línea: 33.5)', e4.contado === 33.5 && num(fila4.quantity) === 24 && num(fila4.enteredQuantity) === 2 && num(fila4.presentationFactor) === 12 && fila4.presentationId === pres.id)
  check('>>> si la cantidad base no coincide con la presentación, se rechaza (no se confía en el cliente)', (await code(pasada(AL, c3.id, P1.id, 25, { presentationId: pres.id, enteredQuantity: 2 }))) === 'INVALID_DOCUMENT')
  check('>>> la presentación de otro producto se rechaza', (await code(pasada(AL, c3.id, P2.id, 12, { presentationId: pres.id, enteredQuantity: 1 }))) === 'TENANT_MISMATCH')
  const ev = await pasada(AL, c3.id, PV.id, 2, { variantId: va.id })
  check('>>> una variante se cuenta en SU línea (Rojo 2), sin mezclarse con Azul', ev.contado === 2 && (await linea(c3.id, PV.id, vb.id))!.status === 'PENDIENTE')
  check('>>> una variante que no es del producto: NOT_FOUND', (await code(pasada(AL, c3.id, P1.id, 1, { variantId: va.id }))) === 'NOT_FOUND')
  const eNuevo = await pasada(AL, c3.id, NUEVO.id, 4)
  const lNuevo = await linea(c3.id, NUEVO.id)
  check('>>> en un total se admite un producto que no estaba en la lista (se halló mercadería): línea nueva, foto 0', eNuevo.contado === 4 && lNuevo !== null && num(lNuevo.systemQtyAtStart) === 0)
  check('>>> un servicio (sin control de stock) o un producto que no existe: NOT_FOUND', (await code(pasada(AL, c3.id, SERV.id, 1))) === 'NOT_FOUND' && (await code(pasada(AL, c3.id, 'no-existe', 1))) === 'NOT_FOUND')
  check('>>> una pasada con cantidad negativa o el cajero contando: se rechazan (esquema / permiso)', !registrarPasadaSchema.safeParse({ countId: c3.id, productId: P1.id, quantity: -1, idempotencyKey: randomUUID() }).success && (await code(pasada(CA, c3.id, P1.id, 1))) === 'FORBIDDEN_ROLE')
  check('>>> con el PIN de operador SÍ se cuenta', (await pasada(PIN, c3.id, P3.id, 6)).contado === 6)
  check('>>> el dueño y el administrador también cuentan', (await pasada(O, c3.id, P3.id, 1)).contado === 7 && (await pasada(AD, c3.id, P3.id, 1)).contado === 8)
  check('>>> contar no toca el stock ni crea movimientos', (await stockTotal()) === stockAntes && (await movimientos()) === movAntes)

  console.log('\nF) Anular pasadas')
  const ea = await pasada(AL, c3.id, P2.id, 5)
  check('>>> quien contó anula SU pasada: la suma se recalcula (0 + 5 − 5 = 0)', (await anularP(AL, ea.entryId)).contado === 0)
  check('>>> la pasada anulada sigue visible, tachada, con su motivo y quién la anuló quedó registrado', await (async () => { const p = (await pasadasDeLinea(db(O), O, ea.itemId)).find((x) => x.id === ea.entryId)!; const r = await prisma.inventoryCountEntry.findUniqueOrThrow({ where: { id: ea.entryId } }); return p.anulada && p.motivoAnulacion === 'Conté dos veces' && r.voidedById === AL.userId && r.voidedAt !== null })())
  check('>>> no se anula dos veces', (await code(anularP(AL, ea.entryId))) === 'INVALID_DOCUMENT')
  const ea2 = await pasada(AL2, c3.id, P2.id, 3)
  check('>>> el almacenero NO anula la pasada de otro (solo las suyas)', (await code(anularP(AL, ea2.entryId))) === 'FORBIDDEN_ROLE')
  check('>>> con conteo.gestionar sí anula la de cualquiera, y queda registrado QUIÉN la anuló (no quien contó)', (await anularP(ALG, ea2.entryId, 'Estaba duplicada')).contado === 0 && (await prisma.inventoryCountEntry.findUniqueOrThrow({ where: { id: ea2.entryId } })).voidedById === ALG.userId && ea2.entryId !== '')
  const lP2 = await linea(c3.id, P2.id)
  check('>>> si la línea queda con el CERO de antes (la primera pasada de 0 sigue vigente) sigue CONTADO con 0', lP2!.status === 'CONTADO' && num(lP2!.countedQty) === 0)
  const solo = await pasada(AL, c3.id, P3.id, 1, { zone: 'Estante 2' })
  const ePend = await pasada(AL, c3.id, PV.id, 5, { variantId: vb.id })
  await anularP(AL, ePend.entryId)
  check('>>> si se anula la ÚNICA pasada de una línea, vuelve a PENDIENTE y sin cantidad', (await linea(c3.id, PV.id, vb.id))!.status === 'PENDIENTE' && (await linea(c3.id, PV.id, vb.id))!.countedQty === null && solo.contado > 0)
  check('>>> lo anulado no cuenta para el total del producto', (await linea(c3.id, P3.id))!.countedQty!.toString() === '9')
  check('>>> el cajero no anula; una pasada inexistente es NOT_FOUND', (await code(anularP(CA, ea.entryId))) === 'FORBIDDEN_ROLE' && (await code(anularP(AL, 'no-existe'))) === 'NOT_FOUND')

  console.log('\nG) Conteo ciego y guiado')
  const lsAL = await lineasDelConteo(db(AL), AL, c3.id)
  check('>>> en un conteo CIEGO el almacenero ve lo CONTADO pero la clave `sistemaAlEmpezar` ni existe en lo que recibe', lsAL.lineas.length === 6 && lsAL.lineas.every((l) => !('sistemaAlEmpezar' in l)) && !JSON.stringify(lsAL).includes('sistemaAlEmpezar') && lsAL.lineas.find((l) => l.sku === 'P1')!.contado === 33.5)
  const lsAD = await lineasDelConteo(db(AD), AD, c3.id)
  check('>>> el administrador (gestiona) ve la cantidad del sistema de cada línea', lsAD.lineas.find((l) => l.sku === 'P1')!.sistemaAlEmpezar === 10 && lsAD.lineas.find((l) => l.sku === 'P3')!.sistemaAlEmpezar === 0)
  check('>>> el almacenero con conteo.gestionar también la ve; el cajero ni siquiera ve el conteo', (await lineasDelConteo(db(ALG), ALG, c3.id)).lineas.every((l) => 'sistemaAlEmpezar' in l) && (await code(lineasDelConteo(db(CA), CA, c3.id))) === 'FORBIDDEN_ROLE')
  check('>>> el cajero tampoco ve las pasadas de una línea (FORBIDDEN_ROLE)', (await code(pasadasDeLinea(db(CA), CA, (await linea(c3.id, P1.id))!.id))) === 'FORBIDDEN_ROLE')
  check('>>> las líneas salen ordenadas por nombre y se pueden filtrar por estado', lsAD.lineas.map((l) => l.nombre).join() === [...lsAD.lineas.map((l) => l.nombre)].sort().join() && (await lineasDelConteo(db(AD), AD, c3.id, { estado: 'PENDIENTE' })).lineas.every((l) => l.estado === 'PENDIENTE'))
  const pag1 = await lineasDelConteo(db(AD), AD, c3.id, { limite: 4 }), pag2 = await lineasDelConteo(db(AD), AD, c3.id, { limite: 4, cursor: pag1.siguiente! })
  check('>>> paginado de 4 en 4: 6 líneas sin repetir ni saltar, la última página sin siguiente', pag1.lineas.length === 4 && pag1.siguiente !== null && pag2.lineas.length === 2 && pag2.siguiente === null && new Set([...pag1.lineas, ...pag2.lineas].map((l) => l.id)).size === 6)
  await cancelar(O, c3.id)
  const cG = await crear(O, { mode: 'GUIADO' })
  await iniciar(O, cG.id)
  check('>>> en un conteo GUIADO quien cuenta SÍ ve la cantidad del sistema', (await lineasDelConteo(db(AL), AL, cG.id)).lineas.find((l) => l.sku === 'P1')!.sistemaAlEmpezar === 10)

  console.log('\nH) Alcance por categoría y por selección al contar')
  await cancelar(O, cG.id)
  const cc = await crear(O, { scope: 'CATEGORIA', categoryId: cat1.id })
  await iniciar(O, cc.id)
  check('>>> por categoría: solo hay líneas de esa categoría', (await prisma.inventoryCountItem.count({ where: { countId: cc.id } })) === 2)
  check('>>> un producto de OTRA categoría no se puede contar ahí', (await code(pasada(AL, cc.id, P3.id, 1))) === 'INVALID_DOCUMENT')
  check('>>> uno de la categoría que no tenía fila de stock sí (se halló mercadería)', (await pasada(AL, cc.id, NUEVO.id, 2)).contado === 2)
  await cancelar(O, cc.id)
  const cs = await crear(O, { scope: 'SELECCION', productIds: [P1.id, P2.id] })
  await iniciar(O, cs.id)
  check('>>> en una selección solo se cuenta lo elegido: otro producto es NOT_FOUND', (await code(pasada(AL, cs.id, P3.id, 1))) === 'NOT_FOUND' && (await pasada(AL, cs.id, P1.id, 1)).contado === 1)

  console.log('\nI) Cerrar')
  check('>>> el almacenero sin gestionar no cierra; cerrar un borrador o inexistente se rechaza', (await code(cerrar(AL, cs.id))) === 'FORBIDDEN_ROLE' && (await code(cerrar(O, 'no-existe'))) === 'NOT_FOUND')
  const extra = await pasada(AL, cs.id, P2.id, 3)
  await anularP(AL, extra.entryId)
  const cerrado = await cerrar(O, cs.id)
  check('>>> cerrar pasa a EN_REVISION con el resumen: 2 líneas, 1 contada, 1 pendiente, 1 pasada', cerrado.status === 'EN_REVISION' && cerrado.lineas === 2 && cerrado.contadas === 1 && cerrado.pendientes === 1 && cerrado.pasadas === 1 && cerrado.closedAt !== null)
  const post = await err(pasada(AL, cs.id, P1.id, 1))
  check('>>> tras cerrar ya no entran pasadas (se explica por qué)', post?.code === 'INVALID_DOCUMENT' && /ya se cerró/.test(post.message), post?.message)
  const eCerr = (await pasadasDeLinea(db(O), O, (await linea(cs.id, P1.id))!.id))[0]!
  check('>>> ni se anulan pasadas con el conteo cerrado', (await code(anularP(ALG, eCerr.id))) === 'INVALID_DOCUMENT')
  const dosVeces = await err(cerrar(O, cs.id))
  check('>>> no se cierra dos veces (se explica que ya está en revisión) ni se inicia uno cerrado', dosVeces?.code === 'INVALID_DOCUMENT' && /ya se cerró y está en revisión/.test(dosVeces.message) && (await code(iniciar(O, cs.id))) === 'INVALID_DOCUMENT', dosVeces?.message)
  check('>>> un conteo en revisión sigue contando como ABIERTO: no se puede abrir otro en el almacén', (await code(crear(O))) === 'INVALID_DOCUMENT')

  console.log('\nJ) Cancelar')
  check('>>> cancelar pide motivo y gestionar', !cancelarConteoSchema.safeParse({ countId: cs.id, reason: 'x' }).success && (await code(cancelar(AL, cs.id))) === 'FORBIDDEN_ROLE')
  const canc = await cancelar(O, cs.id, 'Se cuenta de nuevo el lunes')
  const cRow = await prisma.inventoryCount.findUniqueOrThrow({ where: { id: cs.id } })
  check('>>> cancelar desde EN_REVISION: queda CANCELADO con quién, cuándo y por qué; conserva TODAS sus pasadas (también la anulada)', canc.status === 'CANCELADO' && cRow.cancelReason === 'Se cuenta de nuevo el lunes' && cRow.cancelledById === O.userId && cRow.cancelledAt !== null && (await prisma.inventoryCountEntry.count({ where: { countId: cs.id } })) === 2)
  const reCancel = await err(cancelar(O, cs.id))
  check('>>> un conteo cancelado no admite nada más (contar, cerrar, iniciar, cancelar); se explica que está cancelado', (await code(pasada(AL, cs.id, P1.id, 1))) === 'INVALID_DOCUMENT' && (await code(cerrar(O, cs.id))) === 'INVALID_DOCUMENT' && reCancel?.code === 'INVALID_DOCUMENT' && /está cancelado/.test(reCancel.message) && (await code(iniciar(O, cs.id))) === 'INVALID_DOCUMENT', reCancel?.message)
  const cb = await crear(O)
  check('>>> se cancela también desde BORRADOR', (await cancelar(O, cb.id)).status === 'CANCELADO')
  const ce = await crear(O); await iniciar(O, ce.id)
  check('>>> y desde EN_CONTEO (sin cerrar)', (await cancelar(O, ce.id)).status === 'CANCELADO')

  console.log('\nK) Auditoría, lectura y aislamiento')
  const acciones = (await prisma.auditLog.findMany({ where: { tenantId: t.id, entityType: 'InventoryCount' }, select: { action: true } })).map((a) => a.action)
  check('>>> cada paso del ciclo deja su línea de auditoría (crear, iniciar, cerrar, cancelar, pasada anulada)', ['conteo.crear', 'conteo.iniciar', 'conteo.cerrar', 'conteo.cancelar', 'conteo.pasada_anulada'].every((a) => acciones.includes(a)))
  const aud = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: t.id, action: 'conteo.pasada_anulada' } })
  check('>>> la auditoría de una pasada anulada guarda el motivo y lo que valía', aud.reason !== null && JSON.stringify(aud.before).includes('cantidad'))
  const lista = await listarConteos(db(O), O)
  check('>>> la lista trae los conteos del más reciente al más antiguo y se filtra por estado', lista.length >= 6 && lista.every((c, i) => i === 0 || c.createdAt <= lista[i - 1]!.createdAt) && (await listarConteos(db(O), O, { estado: 'EN_REVISION' })).length === 0 && (await listarConteos(db(O), O, { estado: 'CANCELADO' })).length >= 5)
  const wOtro2 = await prisma.user.create({ data: { tenantId: otro.id, email: `o-${randomUUID()}@x.com`.toLowerCase(), name: 'O', role: 'OWNER' } })
  const OO: TenantContext = { tenantId: otro.id, userId: wOtro2.id, role: 'OWNER', access: 'FULL', permisosExtra: [] }
  check('>>> un conteo de OTRO negocio no existe (NOT_FOUND) ni se puede tocar', (await code(obtenerConteo(db(OO), OO, cs.id))) === 'NOT_FOUND' && (await code(cerrar(OO, cs.id))) === 'NOT_FOUND' && (await code(pasada(OO, cs.id, P1.id, 1))) === 'NOT_FOUND')
  const c2suc = await crear(O, { warehouseId: W2 })
  check('>>> quien solo alcanza la sucursal 1 no ve ni toca un conteo de la sucursal 2 (NOT_FOUND)', (await code(obtenerConteo(db(ALG), ALG, c2suc.id))) === 'NOT_FOUND' && (await code(iniciar(ALG, c2suc.id))) === 'NOT_FOUND' && (await listarConteos(db(ALG), ALG)).every((c) => c.warehouse.id === W1))
  await cancelar(O, c2suc.id)
  check('>>> quien tiene las dos sucursales sí ve el de la sucursal 2', (await obtenerConteo(db(O), O, c2suc.id)).warehouse.id === W2)
  check('>>> en todo el ciclo el stock y los movimientos quedaron EXACTAMENTE como estaban', (await stockTotal()) === stockAntes && (await movimientos()) === movAntes)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
