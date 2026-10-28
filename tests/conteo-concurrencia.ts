import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { anularPasada, cancelarConteo, cerrarConteo, crearConteo, iniciarConteo, registrarPasada } from '../src/features/inventory/conteo-service'
import { anularPasadaSchema, cancelarConteoSchema, cerrarConteoSchema, crearConteoSchema, iniciarConteoSchema, registrarPasadaSchema } from '../src/features/inventory/conteo-schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.5a · Concurrencia de la toma de inventario: varias personas contando a la vez no se pisan, un reintento simultáneo no duplica, cerrar y contar se serializan
 * (nada entra tras el cierre ni se pierde en silencio), dos conteos para el mismo almacén no conviven y dos «iniciar» no duplican las líneas.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const res = async <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: { code?: string; message: string }) => ({ ok: false as const, code: e.code ?? 'ERR', message: e.message }))

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 500) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-cnc-${randomUUID().slice(0, 6)}`, name: 'Conteo concurrencia', taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cnc' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const W = b1.warehouse.id
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ALMACENERO'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, x.id, b1.branch.id)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  }
  const O = u.OWNER!, AL = u.ALMACENERO!
  const db = (c: TenantContext) => getTenantPrisma(c)
  const mk = (sku: string) => prisma.product.create({ data: { tenantId: t.id, sku, name: `Producto ${sku}`, unitType: 'UNIDAD', salePrice: 5, costPrice: 2 } })
  const P1 = await mk('C1'), P2 = await mk('C2'), P3 = await mk('C3')
  for (const p of [P1, P2, P3]) await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: W, quantity: 10 } })
  const crear = (c: TenantContext) => crearConteo(db(c), c, crearConteoSchema.parse({ warehouseId: W, scope: 'TOTAL', idempotencyKey: randomUUID() }))
  const iniciar = (id: string) => iniciarConteo(db(O), O, iniciarConteoSchema.parse({ countId: id }))
  const pasada = (id: string, p: string, q: number, key = randomUUID()) => registrarPasada(db(AL), AL, registrarPasadaSchema.parse({ countId: id, productId: p, quantity: q, idempotencyKey: key }))
  const nuevoEnConteo = async () => { const c = await crear(O); await iniciar(c.id); return c }

  console.log('\nA) Doce personas cuentan el mismo producto a la vez')
  const c1 = await nuevoEnConteo()
  const doce = await Promise.all(Array.from({ length: 12 }, (_, i) => res(pasada(c1.id, P1.id, i + 1))))
  const l1 = await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: c1.id, productId: P1.id } })
  check('>>> las 12 pasadas entran y la línea suma exactamente 1+2+…+12 = 78 (ninguna se pierde ni se pisa)', doce.every((r) => r.ok) && num(l1.countedQty) === 78 && (await prisma.inventoryCountEntry.count({ where: { itemId: l1.id } })) === 12)

  console.log('\nB) El mismo reintento llega cinco veces a la vez')
  const llave = randomUUID()
  const cinco = await Promise.all(Array.from({ length: 5 }, () => res(pasada(c1.id, P2.id, 4, llave))))
  const ids = new Set(cinco.filter((r) => r.ok).map((r) => (r as { ok: true; v: { entryId: string } }).v.entryId))
  check('>>> todas contestan bien con la MISMA pasada y solo se guarda una (suma 4, no 20)', cinco.every((r) => r.ok) && ids.size === 1 && (await prisma.inventoryCountEntry.count({ where: { idempotencyKey: llave } })) === 1 && num((await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: c1.id, productId: P2.id } })).countedQty) === 4)
  check('>>> exactamente una fue la original y las demás se marcan como repetidas', cinco.filter((r) => r.ok && !(r as { ok: true; v: { replayed: boolean } }).v.replayed).length === 1)

  console.log('\nC) Cerrar mientras se cuenta: nada entra tras el cierre ni se pierde en silencio')
  await cancelarConteo(db(O), O, cancelarConteoSchema.parse({ countId: c1.id, reason: 'Prueba de concurrencia' }))
  const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const tarde = async <T,>(ms: number, f: () => Promise<T>) => { await espera(ms); return f() }
  let hubo = 0
  for (const retardo of [0, 15, 40]) {
    const c2 = await nuevoEnConteo()
    const antes = Array.from({ length: 8 }, (_, i) => res(pasada(c2.id, P3.id, 1 + i)))
    const cierraYa = res(tarde(retardo, () => cerrarConteo(db(O), O, cerrarConteoSchema.parse({ countId: c2.id }))))
    const despues = Array.from({ length: 8 }, (_, i) => res(tarde(retardo, () => pasada(c2.id, P3.id, 100 + i))))
    const todas = await Promise.all([...antes, ...despues])
    const cerr = await cierraYa
    const aceptadas = todas.filter((r) => r.ok) as { ok: true; v: { entryId: string } }[]
    const rechazadas = todas.filter((r) => !r.ok) as { ok: false; code: string; message: string }[]
    const cierre = await prisma.inventoryCount.findUniqueOrThrow({ where: { id: c2.id } })
    const guardadas = await prisma.inventoryCountEntry.findMany({ where: { countId: c2.id } })
    const linea = await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: c2.id, productId: P3.id } })
    const suma = guardadas.reduce((a, e) => a + num(e.quantity), 0)
    if (aceptadas.length > 0 && rechazadas.length > 0) hubo++
    check(`>>> (retardo ${retardo} ms) el cierre tuvo éxito y quedó EN_REVISION; ${aceptadas.length} pasadas aceptadas y ${rechazadas.length} rechazadas`, cerr.ok && cierre.status === 'EN_REVISION')
    check(`>>> (retardo ${retardo} ms) cada pasada aceptada está guardada y cada rechazada NO, con el motivo de que ya se cerró (nada se pierde en silencio)`, guardadas.length === aceptadas.length && aceptadas.every((a) => guardadas.some((g) => g.id === a.v.entryId)) && rechazadas.every((r) => r.code === 'INVALID_DOCUMENT' && /cerr|revisión/.test(r.message)))
    check(`>>> (retardo ${retardo} ms) la línea suma exactamente lo aceptado y ninguna pasada guardada es posterior al cierre`, (guardadas.length === 0 ? linea.countedQty === null : num(linea.countedQty) === suma) && guardadas.every((g) => g.createdAt.getTime() <= cierre.closedAt!.getTime() + 50))
    await cancelarConteo(db(O), O, cancelarConteoSchema.parse({ countId: c2.id, reason: 'Prueba de concurrencia' }))
  }
  console.log(`  (informativo) rondas en que la carrera mezcló pasadas aceptadas y rechazadas: ${hubo} de 3`)

  console.log('\nD) Dos conteos para el mismo almacén a la vez')
  const dos = await Promise.all([res(crear(O)), res(crear(O)), res(crear(O)), res(crear(O))])
  const gano = dos.filter((r) => r.ok), perdio = dos.filter((r) => !r.ok) as { ok: false; code: string; message: string }[]
  check('>>> exactamente uno se crea; los demás reciben «ya hay una toma abierta» (no se cuelan ni revientan)', gano.length === 1 && perdio.length === 3 && perdio.every((r) => r.code === 'INVALID_DOCUMENT' && /abierta/.test(r.message)), dos.map((r) => (r.ok ? 'ok' : r.code)).join())
  check('>>> la base tiene un solo conteo abierto y sus números no tienen huecos por los intentos fallidos', (await prisma.inventoryCount.count({ where: { tenantId: t.id, warehouseId: W, status: 'BORRADOR' } })) === 1)
  const nums = (await prisma.inventoryCount.findMany({ where: { tenantId: t.id }, select: { number: true }, orderBy: { number: 'asc' } })).map((c) => Number(c.number.split('-')[1]))
  check('>>> la numeración es correlativa sin huecos (los intentos que fallaron no consumieron número)', nums.every((n, i) => n === i + 1), nums.join())
  const abierto = await prisma.inventoryCount.findFirstOrThrow({ where: { tenantId: t.id, warehouseId: W, status: 'BORRADOR' } })

  console.log('\nE) Iniciar dos veces a la vez')
  const inicios = await Promise.all([res(iniciar(abierto.id)), res(iniciar(abierto.id)), res(iniciar(abierto.id))])
  check('>>> solo uno inicia; los otros reciben que ya no está en borrador', inicios.filter((r) => r.ok).length === 1 && inicios.filter((r) => !r.ok).every((r) => (r as { code: string }).code === 'INVALID_DOCUMENT'))
  check('>>> y las líneas no se duplican (3 productos, 3 líneas)', (await prisma.inventoryCountItem.count({ where: { countId: abierto.id } })) === 3)

  console.log('\nF) Anular la misma pasada a la vez y anular mientras se cierra')
  const ep = await pasada(abierto.id, P1.id, 5)
  const dobles = await Promise.all(Array.from({ length: 4 }, () => res(anularPasada(db(AL), AL, anularPasadaSchema.parse({ entryId: ep.entryId, reason: 'Duplicada' })))))
  check('>>> anulada exactamente una vez; las demás reciben «ya está anulada»', dobles.filter((r) => r.ok).length === 1 && dobles.filter((r) => !r.ok).every((r) => (r as { code: string }).code === 'INVALID_DOCUMENT') && (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'conteo.pasada_anulada', entityId: abierto.id } })) === 1)
  check('>>> y la línea volvió a PENDIENTE', (await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: abierto.id, productId: P1.id } })).status === 'PENDIENTE')
  const e2 = await pasada(abierto.id, P2.id, 7)
  const carrera = await Promise.all([res(anularPasada(db(AL), AL, anularPasadaSchema.parse({ entryId: e2.entryId, reason: 'Me equivoqué' }))), res(cerrarConteo(db(O), O, cerrarConteoSchema.parse({ countId: abierto.id })))])
  const lin2 = await prisma.inventoryCountItem.findFirstOrThrow({ where: { countId: abierto.id, productId: P2.id } })
  const ent2 = await prisma.inventoryCountEntry.findUniqueOrThrow({ where: { id: e2.entryId } })
  check('>>> anular y cerrar a la vez: el cierre gana siempre; si la anulación entró antes, la línea lo refleja; si no, se rechazó y la pasada sigue vigente', carrera[1].ok && (carrera[0].ok ? ent2.voidedAt !== null && lin2.status === 'PENDIENTE' : (ent2.voidedAt === null && num(lin2.countedQty) === 7)))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
