import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { ean13 } from '../src/lib/codigos-barras'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { resolverCodigo } from '../src/features/inventory/codigos'
import { crearPresentacion, desactivarPresentacion, validarPresentacion } from '../src/features/inventory/presentaciones-service'
import { calcularLinea } from '../src/features/inventory/conversion'
import type { TenantContext } from '../src/lib/tenant-context'

/** Paso 2: tabla de presentaciones, trazabilidad en las líneas (con la matemática comprobada también en la base) y su alta. */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const lanza = async (f: () => unknown) => { try { await f(); return null } catch (e) { return e as Error & { code?: string } } }

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `cod-${tag}-${randomUUID().slice(0, 6)}`, name: `Presentaciones ${tag}`, planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_pr' } })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const mk = (role: 'OWNER' | 'VENDEDOR') => prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`, name: role, role } })
  const owner = await mk('OWNER'), vend = await mk('VENDEDOR')
  const alm = await prisma.user.create({ data: { tenantId: t.id, email: `ALM-${randomUUID()}@x.com`, name: 'Almacenero', role: 'ALMACENERO' } })
  await asignarSucursal(t.id, alm.id, branch.id)
  await asignarSucursal(t.id, owner.id, branch.id); await asignarSucursal(t.id, vend.id, branch.id)
  const ctx = (u: { id: string }, role: 'OWNER' | 'VENDEDOR'): TenantContext => ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branch.id, branchIds: [branch.id] })
  let n = 0
  const producto = async (o: { unitType?: 'UNIDAD' | 'KILOGRAMO' | 'METRO'; stock?: number; barcode?: string } = {}) => {
    n++
    const p = await prisma.product.create({ data: { tenantId: t.id, sku: `P-${tag}-${n}`, name: `Producto ${tag} ${n}`, unitType: o.unitType ?? 'UNIDAD', salePrice: 10, barcode: o.barcode ?? null } })
    if (o.stock !== undefined) await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: w.id, quantity: o.stock, minStock: 2 } })
    return p
  }
  const pres = (productId: string, o: Record<string, unknown> = {}) => prisma.productPresentation.create({ data: { tenantId: t.id, productId, name: `Caja ${randomUUID().slice(0, 4)}`, unitType: 'CAJA', factor: '12', ...o } as never })
  const venta = () => prisma.sale.create({ data: { tenantId: t.id, branchId: branch.id, warehouseId: w.id, userId: owner.id, number: `V-${tag}-${randomUUID().slice(0, 8)}`, status: 'COMPLETADA' } })
  const compra = () => prisma.purchase.create({ data: { tenantId: t.id, warehouseId: w.id, userId: owner.id, number: `C-${tag}-${randomUUID().slice(0, 8)}` } })
  return { t, w, owner, vend, ctx, db: getTenantPrisma(ctx(owner, 'OWNER')), dbV: getTenantPrisma(ctx(vend, 'VENDEDOR')), ctxO: ctx(owner, 'OWNER'), ctxV: ctx(vend, 'VENDEDOR'), ctxAlm: { tenantId: t.id, userId: alm.id, role: 'ALMACENERO' as const, access: 'FULL' as const, branchId: branch.id, branchIds: [branch.id] }, producto, pres, venta, compra }
}

async function main() {
  const A = await negocio('a'), B = await negocio('b')
  const p = await A.producto({ stock: 100 })
  const pB = await B.producto({})

  console.log('\n1) La tabla de presentaciones')
  const base = await A.pres(p.id, { name: 'Caja x 12' })
  check('>>> se crea con factor, unidad y precios opcionales', base.factor.toString() === '12' && base.unitType === 'CAJA' && base.salePrice === null && base.isActive === true && base.isDefaultSale === false)
  check('>>> factor cero o negativo → rechazado por la base (CHECK)', (await lanza(() => A.pres(p.id, { factor: '0' }))) !== null && (await lanza(() => A.pres(p.id, { factor: '-2' }))) !== null)
  check('el factor guarda 6 decimales exactos', (await A.pres(p.id, { factor: '0.123456', name: 'Fino' })).factor.toString() === '0.123456')
  check('>>> nombre vacío o con espacios en los extremos → rechazado', (await lanza(() => A.pres(p.id, { name: '' }))) !== null && (await lanza(() => A.pres(p.id, { name: ' Caja ' }))) !== null)
  check('precio negativo → rechazado', (await lanza(() => A.pres(p.id, { salePrice: '-1' }))) !== null && !(await lanza(() => A.pres(p.id, { salePrice: '0', costPrice: '0' }))))
  const otroProd = await A.producto()
  check('>>> mismo nombre dos veces en el MISMO producto → rechazado; en otro producto sí', (await lanza(() => A.pres(p.id, { name: 'Caja x 12' })))?.code === 'P2002' && !(await lanza(() => A.pres(otroProd.id, { name: 'Caja x 12' }))))
  const d1 = await A.pres(p.id, { name: 'Por defecto', isDefaultSale: true })
  check('>>> una sola presentación de venta POR DEFECTO por producto (índice parcial)', (await lanza(() => A.pres(p.id, { name: 'Otra defecto', isDefaultSale: true }))) !== null)
  const otroProd2 = await A.producto()
  check('...una dada de baja no cuenta, y la de defecto debe estar activa', !(await lanza(() => prisma.productPresentation.update({ where: { id: d1.id }, data: { isDefaultSale: false, isActive: false, deletedAt: new Date() } }))) && !(await lanza(() => A.pres(p.id, { name: 'Nueva defecto', isDefaultSale: true }))) && (await lanza(() => A.pres(otroProd2.id, { name: 'Inactiva defecto', isDefaultSale: true, isActive: false }))) !== null)
  check('>>> una presentación no puede ser de un producto de OTRO negocio (clave foránea compuesta)', (await lanza(() => prisma.productPresentation.create({ data: { tenantId: A.t.id, productId: pB.id, name: 'X', unitType: 'CAJA', factor: '2' } })))?.code === 'P2003')
  check('el cliente aislado no ve las presentaciones del otro negocio', (await B.db.productPresentation.count()) === 0 && (await A.db.productPresentation.count()) >= 4)

  console.log('\n2) Trazabilidad en las líneas: todo o nada, y la base comprueba la matemática')
  const v = await A.venta(); const c = await A.compra()
  const linea = (o: Record<string, unknown> = {}) => prisma.saleItem.create({ data: { tenantId: A.t.id, saleId: v.id, productId: p.id, nameSnapshot: 'x', skuSnapshot: 'x', quantity: 36, unitPrice: 9.8333, lineTotal: 354, ...o } as never })
  const conPres = { presentationId: base.id, enteredQuantity: '3', presentationFactor: '12', presentationName: 'Caja x 12' }
  check('>>> sin presentación (como hasta hoy) sigue valiendo', !(await lanza(() => linea())))
  check('>>> con presentación: 3 cajas × 12 = 36 → acepta', !(await lanza(() => linea(conPres))))
  check('>>> la base rechaza que la cantidad base NO sea lo ingresado × factor (35 ≠ 3 × 12)', (await lanza(() => linea({ ...conPres, quantity: 35 }))) !== null)
  check('>>> y rechaza las columnas a medias (id sin cantidad, cantidad sin id, sin nombre)', (await lanza(() => linea({ presentationId: base.id }))) !== null && (await lanza(() => linea({ enteredQuantity: '3', presentationFactor: '12' }))) !== null && (await lanza(() => linea({ ...conPres, presentationName: null }))) !== null)
  check('factor cero o cantidad ingresada cero en la línea → rechazado', (await lanza(() => linea({ ...conPres, presentationFactor: '0', quantity: 0 }))) !== null && (await lanza(() => linea({ ...conPres, enteredQuantity: '0', quantity: 0 }))) !== null)
  check('>>> el factor está COPIADO en la línea: cambiar la presentación después no la altera', await (async () => { await prisma.productPresentation.update({ where: { id: base.id }, data: { factor: '24', name: 'Caja x 24' } }); const l = await prisma.saleItem.findFirstOrThrow({ where: { saleId: v.id, presentationId: base.id } }); await prisma.productPresentation.update({ where: { id: base.id }, data: { factor: '12', name: 'Caja x 12' } }); return l.presentationFactor?.toString() === '12' && l.presentationName === 'Caja x 12' && l.quantity.toString() === '36' })())
  const ventaB = await B.venta()
  check('>>> una línea no puede apuntar a la presentación de otro negocio', (await lanza(() => prisma.saleItem.create({ data: { tenantId: B.t.id, saleId: ventaB.id, productId: pB.id, nameSnapshot: 'x', skuSnapshot: 'x', quantity: 36, unitPrice: 1, lineTotal: 1, ...conPres } as never })))?.code === 'P2003')
  check('>>> una presentación con líneas no se puede borrar de verdad (Restrict): solo baja lógica', (await lanza(() => prisma.productPresentation.delete({ where: { id: base.id } })))?.code === 'P2003')
  const compraConPres = (o: Record<string, unknown> = {}) => prisma.purchaseItem.create({ data: { tenantId: A.t.id, purchaseId: c.id, productId: p.id, quantity: 36, unitCost: 5, lineTotal: 180, ...conPres, ...o } as never })
  check('compras: igual regla (acepta lo exacto, rechaza lo que no cuadra o está a medias)', !(await lanza(() => compraConPres())) && (await lanza(() => compraConPres({ quantity: 30 }))) !== null && (await lanza(() => compraConPres({ presentationName: null }))) !== null)
  const mov = (o: Record<string, unknown> = {}) => prisma.stockMovement.create({ data: { tenantId: A.t.id, warehouseId: A.w.id, productId: p.id, userId: A.owner.id, type: 'ENTRADA', quantity: 36, balanceAfter: 136, presentationId: base.id, enteredQuantity: '3', presentationFactor: '12', ...o } as never })
  check('movimientos: acepta el exacto, y la SALIDA (negativa) con su signo', !(await lanza(() => mov())) && !(await lanza(() => mov({ quantity: -24, enteredQuantity: '-2', balanceAfter: 112 }))))
  check('>>> movimientos: rechaza la cantidad que no cuadra, el signo cambiado y la entrada en cero', (await lanza(() => mov({ quantity: 35 }))) !== null && (await lanza(() => mov({ quantity: -36 }))) !== null && (await lanza(() => mov({ quantity: 0, enteredQuantity: '0' }))) !== null)
  check('>>> el stock NO se tocó por registrar líneas: la cantidad base sigue siendo lo único que mueve el stock', (await prisma.stock.findFirstOrThrow({ where: { tenantId: A.t.id, productId: p.id } })).quantity.toString() === '100')

  console.log('\n3) La matemática de conversion.ts cuadra con la base (400 líneas aleatorias)')
  let semilla = 77, aceptadas = 0, rechazadasPorBase = 0
  const azar = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648 }
  const unidades = ['UNIDAD', 'KILOGRAMO', 'METRO'] as const
  const nuevas: Record<string, unknown>[] = []
  for (let i = 0; i < 400; i++) {
    const factor = (1 + Math.floor(azar() * 99)) / 10 ** Math.floor(azar() * 3)
    const cant = (1 + Math.floor(azar() * 999)) / 10 ** Math.floor(azar() * 4)
    try {
      const r = calcularLinea({ precioPresentacion: (Math.floor(azar() * 9999) / 100).toFixed(2), cantidadIngresada: String(cant), factor: String(factor), unidadPresentacion: unidades[Math.floor(azar() * 3)]!, unidadBase: 'KILOGRAMO' })
      nuevas.push({ tenantId: A.t.id, saleId: v.id, productId: p.id, nameSnapshot: 'x', skuSnapshot: 'x', quantity: r.cantidadBase, unitPrice: r.precioBase, lineTotal: r.totalLinea, presentationId: base.id, enteredQuantity: r.cantidadIngresada, presentationFactor: r.factor, presentationName: 'Prueba' })
      aceptadas++
    } catch { rechazadasPorBase++ }
  }
  const antes = await prisma.saleItem.count({ where: { saleId: v.id } })
  await prisma.saleItem.createMany({ data: nuevas as never })
  check(`>>> todas las líneas que conversion.ts acepta (${aceptadas}) las acepta TAMBIÉN la base, sin una sola excepción`, (await prisma.saleItem.count({ where: { saleId: v.id } })) === antes + aceptadas && aceptadas > 100, `rechazadas por conversion: ${rechazadasPorBase}`)

  console.log('\n4) Alta de presentaciones (servicio)')
  const pr = await A.producto({ stock: 50 })
  const creada = await crearPresentacion(A.db, A.ctxO, { productId: pr.id, name: '  Caja x 12  ', unitType: 'CAJA', factor: '12', salePrice: '108', costPrice: '80', isDefaultSale: true, code: ean13('775000020001') })
  const fila = await prisma.productPresentation.findUniqueOrThrow({ where: { id: creada.id } })
  check('>>> crea la presentación (nombre recortado, factor y precios exactos)', fila.name === 'Caja x 12' && fila.factor.toString() === '12' && fila.salePrice?.toString() === '108' && fila.costPrice?.toString() === '80' && fila.isDefaultSale)
  const cod = await prisma.productCode.findFirstOrThrow({ where: { tenantId: A.t.id, code: ean13('775000020001') } })
  check('>>> y su código de barras: de ESA presentación, principal y de tipo EAN13', cod.presentationId === creada.id && cod.productId === pr.id && cod.variantId === null && cod.isPrimary && cod.type === 'EAN13')
  const r = await resolverCodigo(A.db, ean13('775000020001'), { almacenId: A.w.id })
  check('>>> escanear el EAN de la caja resuelve a {producto, presentación} con SU factor y el stock del producto en BASE', r?.estado === 'ok' && r.producto.id === pr.id && r.presentacion?.id === creada.id && r.presentacion.factor.toString() === '12' && r.presentacion.name === 'Caja x 12' && Number(r.stock?.quantity) === 50)
  check('un código del producto (no de la presentación) sigue sin presentación', await (async () => { await prisma.productCode.create({ data: { tenantId: A.t.id, productId: pr.id, code: ean13('775000020002'), type: 'EAN13', isPrimary: false } }); const x = await resolverCodigo(A.db, ean13('775000020002')); return x?.estado === 'ok' && x.presentacion === null })())
  const segunda = await crearPresentacion(A.db, A.ctxO, { productId: pr.id, name: 'Docena', unitType: 'DOCENA', factor: '12', isDefaultSale: true })
  check('>>> marcar otra como «por defecto» baja la anterior (solo una)', (await prisma.productPresentation.findUniqueOrThrow({ where: { id: creada.id } })).isDefaultSale === false && (await prisma.productPresentation.findUniqueOrThrow({ where: { id: segunda.id } })).isDefaultSale === true)
  const errorDe = async (input: Partial<Parameters<typeof crearPresentacion>[2]>, productId = pr.id) => (await lanza(() => crearPresentacion(A.db, A.ctxO, { productId, name: `T${randomUUID().slice(0, 5)}`, unitType: 'CAJA', factor: '6', ...input })))
  check('>>> factor cero, negativo o con 7 decimales → INVALID_DOCUMENT', ['0', '-3', '0.1234567'].every(() => true) && (await errorDe({ factor: '0' }))?.code === 'INVALID_DOCUMENT' && (await errorDe({ factor: '-3' }))?.code === 'INVALID_DOCUMENT' && (await errorDe({ factor: '0.1234567' }))?.code === 'INVALID_DOCUMENT')
  check('>>> un producto en UNIDAD no admite una presentación que contenga media unidad (factor 0.5)', (await errorDe({ factor: '0.5' }))?.message.includes('UNIDAD') === true)
  check('un granel en kilos sí admite 0.5 kg por presentación; y la unidad de la presentación decide la fracción tecleable', await (async () => { const g = await A.producto({ unitType: 'KILOGRAMO' }); return !(await errorDe({ factor: '0.5', unitType: 'KILOGRAMO' }, g.id)) })())
  check('nombre repetido en el producto → DUPLICATE_CODE; nombre vacío o larguísimo → INVALID_DOCUMENT', (await errorDe({ name: 'Docena' }))?.code === 'DUPLICATE_CODE' && (await errorDe({ name: '   ' }))?.code === 'INVALID_DOCUMENT' && (await errorDe({ name: 'x'.repeat(81) }))?.code === 'INVALID_DOCUMENT')
  const antesCodigos = await prisma.productCode.count({ where: { tenantId: A.t.id } })
  const choque = await errorDe({ name: 'Con código ajeno', code: ean13('775000020002') })
  check('>>> un código que ya es de otro: DUPLICATE_CODE y NO se crea ni la presentación', choque?.code === 'DUPLICATE_CODE' && (await prisma.productPresentation.count({ where: { tenantId: A.t.id, name: 'Con código ajeno' } })) === 0 && (await prisma.productCode.count({ where: { tenantId: A.t.id } })) === antesCodigos)
  check('>>> un VENDEDOR no puede crear presentaciones; el dueño de otro negocio no ve el producto', (await lanza(() => crearPresentacion(A.dbV, A.ctxV, { productId: pr.id, name: 'Intruso', unitType: 'CAJA', factor: '2' })))?.code === 'FORBIDDEN_ROLE' && (await lanza(() => crearPresentacion(B.db, B.ctxO, { productId: pr.id, name: 'Ajeno', unitType: 'CAJA', factor: '2' })))?.code === 'NOT_FOUND')
  const dbAlm = getTenantPrisma(A.ctxAlm)
  check('>>> un almacenero (puede crear, NO ve costos) crea la presentación sin costo, pero no puede fijarle uno', !(await lanza(() => crearPresentacion(dbAlm, A.ctxAlm, { productId: pr.id, name: 'Del almacén', unitType: 'CAJA', factor: '10' }))) && (await lanza(() => crearPresentacion(dbAlm, A.ctxAlm, { productId: pr.id, name: 'Con costo', unitType: 'CAJA', factor: '10', costPrice: '5' })))?.code === 'FORBIDDEN_ROLE' && (await prisma.productPresentation.count({ where: { tenantId: A.t.id, name: 'Con costo' } })) === 0)
  check('>>> lo que devuelve un ESCANEO nunca lleva el costo (llega a quien cobra)', !JSON.stringify(r).includes('costPrice') && !JSON.stringify(await resolverCodigo(A.db, ean13('775000020002'), { almacenId: A.w.id })).includes('costPrice'))
  check('queda auditado', (await prisma.auditLog.count({ where: { tenantId: A.t.id, action: 'presentacion.crear', entityId: creada.id } })) === 1)
  await desactivarPresentacion(A.db, A.ctxO, creada.id)
  check('>>> desactivar: baja lógica (la fila sigue), y su código DEJA de resolver', (await prisma.productPresentation.findUniqueOrThrow({ where: { id: creada.id } })).deletedAt !== null && (await resolverCodigo(A.db, ean13('775000020001'))) === null)
  check('desactivar una inexistente o de otro negocio → NOT_FOUND', (await lanza(() => desactivarPresentacion(A.db, A.ctxO, 'no-existe')))?.code === 'NOT_FOUND' && (await lanza(() => desactivarPresentacion(B.db, B.ctxO, segunda.id)))?.code === 'NOT_FOUND')
  check('(validarPresentacion es pura y se puede usar sin base)', validarPresentacion({ name: 'Caja', unitType: 'CAJA', factor: '12' }, 'UNIDAD').name === 'Caja')

  console.log('\n5) Estructura')
  const fuente = readFileSync('src/features/inventory/presentaciones-service.ts', 'utf8')
  check('>>> el servicio valida con la MISMA matemática que usarán las ventas (conversion.ts), sin reglas propias', fuente.includes("from './conversion'") && fuente.includes('calcularLinea('))
  const mig = readFileSync('prisma/migrations/20261109120000_product_presentations/migration.sql', 'utf8')
  check('la migración es solo expand (no borra ni cambia nada existente)', !/DROP |ALTER COLUMN|DELETE FROM|UPDATE "/.test(mig))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
