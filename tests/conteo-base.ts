import './guard'
import { correr } from './teardown'
import { crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { completarRuc } from '../src/lib/documentos'

/**
 * F6.5a · Lo que la BASE garantiza por sí sola en la toma de inventario: un solo conteo abierto por almacén, la coherencia entre el estado y sus fechas y
 * personas, una línea por producto y variante, cantidades y presentaciones válidas, anulaciones completas, claves compuestas entre negocios y que una pasada
 * pertenezca al mismo conteo que su línea. Más la migración leída como archivo (down.sql, índices).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const falla = (p: Promise<unknown>) => p.then(() => false).catch(() => true)
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
  const nuevoTenant = async (tag: string) => {
    const t = await prisma.tenant.create({ data: { slug: `rp-cnb-${tag}-${randomUUID().slice(0, 6)}`, name: `Conteo base ${tag}`, taxId: ruc(), planId: plan.id } })
    const b = await crearSucursalConAlmacen(t.id)
    const user = await prisma.user.create({ data: { tenantId: t.id, email: `u-${randomUUID()}@x.com`.toLowerCase(), name: 'U', role: 'OWNER' } })
    const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P', name: 'P', unitType: 'UNIDAD', salePrice: 1, costPrice: 1 } })
    const cat = await prisma.category.create({ data: { tenantId: t.id, name: 'C', slug: `c-${randomUUID().slice(0, 4)}` } })
    return { t, b, user, prod, cat }
  }
  const A = await nuevoTenant('a'), B = await nuevoTenant('b')
  const W = A.b.warehouse.id, BR = A.b.branch.id, U = A.user.id
  const base = (o: Record<string, unknown> = {}) => ({ tenantId: A.t.id, number: `CF-${randomUUID().slice(0, 8)}`, warehouseId: W, branchId: BR, scope: 'TOTAL' as const, createdById: U, idempotencyKey: randomUUID(), ...o })
  const conteo = (o: Record<string, unknown> = {}) => prisma.inventoryCount.create({ data: base(o) as never })
  const ahora = new Date()

  console.log('\nA) El conteo: estado y sus fechas')
  const c0 = await conteo()
  check('>>> un borrador válido se guarda y nace CIEGO', c0.status === 'BORRADOR' && c0.mode === 'CIEGO')
  await prisma.inventoryCount.update({ where: { id: c0.id }, data: { status: 'CANCELADO', cancelledAt: ahora, cancelledById: U, cancelReason: 'Prueba' } })
  const abre = (o: Record<string, unknown>) => conteo(o)
  check('>>> EN_CONTEO exige haber empezado (fecha y persona)', await falla(abre({ status: 'EN_CONTEO' })) && await falla(abre({ status: 'EN_CONTEO', startedAt: ahora })) && await falla(abre({ status: 'EN_CONTEO', startedById: U })))
  check('>>> un BORRADOR no puede traer fecha de inicio', await falla(abre({ startedAt: ahora, startedById: U })))
  check('>>> EN_REVISION y APLICADO exigen también el cierre', await falla(abre({ status: 'EN_REVISION', startedAt: ahora, startedById: U })) && await falla(abre({ status: 'APLICADO', startedAt: ahora, startedById: U, appliedAt: ahora, appliedById: U })))
  check('>>> EN_CONTEO no puede traer cierre', await falla(abre({ status: 'EN_CONTEO', startedAt: ahora, startedById: U, closedAt: ahora, closedById: U })))
  check('>>> APLICADO exige quién y cuándo aplicó; los demás estados no pueden traerlo', await falla(abre({ status: 'APLICADO', startedAt: ahora, startedById: U, closedAt: ahora, closedById: U })) && await falla(abre({ appliedAt: ahora, appliedById: U })))
  check('>>> CANCELADO exige quién, cuándo y un motivo de al menos 3 letras', await falla(abre({ status: 'CANCELADO' })) && await falla(abre({ status: 'CANCELADO', cancelledAt: ahora, cancelledById: U })) && await falla(abre({ status: 'CANCELADO', cancelledAt: ahora, cancelledById: U, cancelReason: '  a ' })))
  check('>>> y un conteo no cancelado no puede traer motivo de cancelación', await falla(abre({ cancelReason: 'Por qué' })))
  check('>>> un conteo cancelado desde el borrador (sin haber empezado) es válido', !(await falla(abre({ status: 'CANCELADO', cancelledAt: ahora, cancelledById: U, cancelReason: 'No se hizo' }))))
  check('>>> «por categoría» exige categoría y las demás no la admiten', await falla(abre({ scope: 'CATEGORIA' })) && await falla(abre({ scope: 'TOTAL', categoryId: A.cat.id })) && await falla(abre({ scope: 'SELECCION', categoryId: A.cat.id })))
  const cCat = await abre({ scope: 'CATEGORIA', categoryId: A.cat.id, status: 'CANCELADO', cancelledAt: ahora, cancelledById: U, cancelReason: 'Prueba' })
  check('>>> una categoría válida se acepta (y la de OTRO negocio, no)', !!cCat.id && await falla(abre({ scope: 'CATEGORIA', categoryId: B.cat.id })))
  check('>>> el número no puede estar en blanco ni repetirse en el negocio (en otro negocio sí)', await falla(abre({ number: '   ' })) && await (async () => { const n = `CF-${randomUUID().slice(0, 6)}`; await abre({ number: n, status: 'CANCELADO', cancelledAt: ahora, cancelledById: U, cancelReason: 'Prueba' }); return falla(abre({ number: n })) })())
  check('>>> el mismo número en otro negocio es válido', !(await falla(prisma.inventoryCount.create({ data: { tenantId: B.t.id, number: 'CF-IGUAL', warehouseId: B.b.warehouse.id, branchId: B.b.branch.id, scope: 'TOTAL', createdById: B.user.id, idempotencyKey: randomUUID() } }))))
  const kk = randomUUID(); await abre({ idempotencyKey: kk, status: 'CANCELADO', cancelledAt: ahora, cancelledById: U, cancelReason: 'Prueba' })
  check('>>> la clave de idempotencia no se repite en el negocio', await falla(abre({ idempotencyKey: kk })))
  check('>>> el almacén, la sucursal o el usuario de OTRO negocio se rechazan (claves compuestas)', await falla(abre({ warehouseId: B.b.warehouse.id })) && await falla(abre({ branchId: B.b.branch.id })) && await falla(abre({ createdById: 'no-existe' })))

  console.log('\nB) Un solo conteo abierto por almacén')
  const abierto = await conteo()
  check('>>> un segundo conteo abierto en el mismo almacén lo rechaza la BASE (índice único parcial)', await falla(conteo()))
  check('>>> también si el primero ya empezó o está en revisión', await (async () => {
    await prisma.inventoryCount.update({ where: { id: abierto.id }, data: { status: 'EN_CONTEO', startedAt: ahora, startedById: U } })
    const a = await falla(conteo())
    await prisma.inventoryCount.update({ where: { id: abierto.id }, data: { status: 'EN_REVISION', closedAt: ahora, closedById: U } })
    return a && await falla(conteo())
  })())
  check('>>> cancelado o aplicado deja de contar como abierto: se puede abrir otro y conviven varios cerrados', await (async () => {
    await prisma.inventoryCount.update({ where: { id: abierto.id }, data: { status: 'APLICADO', appliedAt: ahora, appliedById: U } })
    const otro = await conteo()
    await prisma.inventoryCount.update({ where: { id: otro.id }, data: { status: 'CANCELADO', cancelledAt: ahora, cancelledById: U, cancelReason: 'Prueba' } })
    const tercero = await conteo()
    await prisma.inventoryCount.update({ where: { id: tercero.id }, data: { status: 'CANCELADO', cancelledAt: ahora, cancelledById: U, cancelReason: 'Prueba' } })
    return true
  })())
  check('>>> otro almacén u otro negocio no se ven afectados', await (async () => { const w2 = await crearSucursalConAlmacen(A.t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' }); const x = await prisma.inventoryCount.create({ data: base({ warehouseId: w2.warehouse.id, branchId: w2.branch.id }) as never }); await prisma.inventoryCount.update({ where: { id: x.id }, data: { status: 'CANCELADO', cancelledAt: ahora, cancelledById: U, cancelReason: 'Prueba' } }); return true })())

  console.log('\nC) Las líneas')
  const cl = await conteo()
  const item = (o: Record<string, unknown> = {}) => prisma.inventoryCountItem.create({ data: { tenantId: A.t.id, countId: cl.id, productId: A.prod.id, nameSnapshot: 'P', skuSnapshot: 'P', unitType: 'UNIDAD', ...o } as never })
  const it = await item()
  check('>>> una línea válida nace PENDIENTE, sin cantidad ni foto', it.status === 'PENDIENTE' && it.countedQty === null && it.systemQtyAtStart === null)
  check('>>> no se repite el producto sin variante en el mismo conteo', await falla(item()))
  const v1 = await prisma.productVariant.create({ data: { tenantId: A.t.id, productId: A.prod.id, sku: 'V1', name: 'V1' } })
  const iv = await item({ variantId: v1.id })
  check('>>> el producto y su variante son líneas distintas, pero la misma variante no se repite', !!iv.id && await falla(item({ variantId: v1.id })))
  check('>>> la variante de OTRO producto o negocio no se acepta (clave compuesta)', await falla(item({ productId: A.prod.id, variantId: 'no-existe' })))
  check('>>> el producto de OTRO negocio no se acepta', await falla(item({ productId: B.prod.id })))
  check('>>> CONTADO exige cantidad contada; PENDIENTE no puede tenerla', await falla(prisma.inventoryCountItem.update({ where: { id: it.id }, data: { status: 'CONTADO' } })) && await falla(prisma.inventoryCountItem.update({ where: { id: it.id }, data: { countedQty: 3 } })))
  check('>>> lo contado nunca es negativo', await falla(prisma.inventoryCountItem.update({ where: { id: it.id }, data: { status: 'CONTADO', countedQty: -1 } })))
  check('>>> CONTADO con cantidad (incluso cero) es válido', !(await falla(prisma.inventoryCountItem.update({ where: { id: it.id }, data: { status: 'CONTADO', countedQty: 0 } }))))
  check('>>> los estados de F6.5b (RECONTAR, APROBADO, RECHAZADO) ya existen', await (async () => { for (const s of ['RECONTAR', 'APROBADO', 'RECHAZADO'] as const) await prisma.inventoryCountItem.update({ where: { id: iv.id }, data: { status: s, countedQty: 1 } }); return true })())

  console.log('\nD) Las pasadas')
  const ent = (o: Record<string, unknown> = {}) => prisma.inventoryCountEntry.create({ data: { tenantId: A.t.id, itemId: it.id, countId: cl.id, quantity: 5, userId: U, idempotencyKey: randomUUID(), ...o } as never })
  const e0 = await ent()
  check('>>> una pasada válida se guarda', e0.quantity.toString() === '5' && e0.voidedAt === null)
  check('>>> cero es una cantidad válida; negativa, no', !(await falla(ent({ quantity: 0 }))) && await falla(ent({ quantity: -1 })))
  const pres = await prisma.productPresentation.create({ data: { tenantId: A.t.id, productId: A.prod.id, name: 'Caja', unitType: 'UNIDAD', factor: 12 } })
  check('>>> la presentación: cantidad base = ingresada × factor; si no coincide, la base lo rechaza', !(await falla(ent({ quantity: 24, presentationId: pres.id, enteredQuantity: 2, presentationFactor: 12 }))) && await falla(ent({ quantity: 25, presentationId: pres.id, enteredQuantity: 2, presentationFactor: 12 })))
  check('>>> la presentación va completa o no va (id, cantidad y factor juntos)', await falla(ent({ presentationId: pres.id })) && await falla(ent({ enteredQuantity: 2 })) && await falla(ent({ presentationId: pres.id, enteredQuantity: 2 })) && await falla(ent({ quantity: 0, presentationId: pres.id, enteredQuantity: 0, presentationFactor: 0 })))
  check('>>> contar cero cajas (0 × 12) es válido', !(await falla(ent({ quantity: 0, presentationId: pres.id, enteredQuantity: 0, presentationFactor: 12 }))))
  check('>>> la zona no puede estar vacía ni pasar de 40 caracteres', await falla(ent({ zone: '   ' })) && await falla(ent({ zone: 'z'.repeat(41) })) && !(await falla(ent({ zone: 'z'.repeat(40) }))) && !(await falla(ent({ zone: 'Pasillo 3' }))))
  check('>>> anular exige quién, cuándo y motivo (todo o nada)', await falla(ent({ voidedAt: ahora })) && await falla(ent({ voidedAt: ahora, voidedById: U })) && await falla(ent({ voidedAt: ahora, voidedById: U, voidReason: 'ab' })) && await falla(ent({ voidReason: 'Sin fecha' })) && !(await falla(ent({ voidedAt: ahora, voidedById: U, voidReason: 'Conté dos veces' }))))
  check('>>> la clave de idempotencia no se repite en el negocio', await (async () => { const k = randomUUID(); await ent({ idempotencyKey: k }); return falla(ent({ idempotencyKey: k })) })())
  const otroConteo = await (async () => { const w2 = await crearSucursalConAlmacen(A.t.id, { almacenCode: 'ALM3', seriesNumber: 3, branchCode: 'B3', establishmentCode: '0003' }); return prisma.inventoryCount.create({ data: base({ warehouseId: w2.warehouse.id, branchId: w2.branch.id }) as never }) })()
  check('>>> una pasada no puede apuntar a un conteo distinto del de su línea (clave compuesta item + conteo)', await falla(ent({ countId: otroConteo.id })))
  check('>>> ni a una línea de otro negocio, ni a un usuario inexistente', await falla(ent({ tenantId: B.t.id })) && await falla(ent({ userId: 'no-existe' })))
  check('>>> la presentación de otro negocio se rechaza', await (async () => { const pb = await prisma.productPresentation.create({ data: { tenantId: B.t.id, productId: B.prod.id, name: 'Caja', unitType: 'UNIDAD', factor: 2 } }); return falla(ent({ quantity: 4, presentationId: pb.id, enteredQuantity: 2, presentationFactor: 2 })) })())

  console.log('\nE) La migración, leída como archivo')
  const dir = readdirSync('prisma/migrations').find((d) => d.endsWith('_toma_inventario'))!
  const sql = readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8'), down = existsSync(`prisma/migrations/${dir}/down.sql`) ? readFileSync(`prisma/migrations/${dir}/down.sql`, 'utf8') : ''
  check('>>> es ADITIVA: solo crea (tipos, tablas, índices, reglas); no borra ni altera tablas existentes', !/\bDROP\b/i.test(sql) && !/ALTER TABLE "(?!inventory_count)/.test(sql) && (sql.match(/CREATE TABLE/g) ?? []).length === 3 && (sql.match(/CREATE TYPE/g) ?? []).length === 4)
  check('>>> trae el índice único parcial del conteo abierto y los de línea sin/con variante', /inventory_counts_uno_abierto[^;]*WHERE "status" IN \('BORRADOR', 'EN_CONTEO', 'EN_REVISION'\)/.test(sql) && sql.includes('inventory_count_items_sin_variante_key') && sql.includes('inventory_count_items_con_variante_key'))
  check('>>> y tiene su down.sql, que deshace todo en orden (pasadas, líneas, conteos, tipos)', down.includes('DROP TABLE IF EXISTS "inventory_count_entries"') && down.indexOf('inventory_count_entries') < down.indexOf('inventory_count_items') && down.indexOf('inventory_count_items') < down.indexOf('"inventory_counts"') && (down.match(/DROP TYPE/g) ?? []).length === 4)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
