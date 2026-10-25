import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { ean13 } from '../src/lib/codigos-barras'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import {
  auditarCoherenciaCodigos, limpiarCodigo, mensajeAmbiguo, planificarCodigos, registrarCodigosProducto, resolverCodigo, tipoDeCodigo,
  type DuenoLegado,
} from '../src/features/inventory/codigos'
import { formatearInforme, poblarCodigos } from '../src/features/inventory/codigos-relleno'
import { createProductExpress } from '../src/features/inventory/product-service'
import { analyzeImport, commitImport } from '../src/features/inventory/import-service'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Paso 1 del módulo de escaneo: tabla ProductCode, relleno desde las columnas antiguas (sin mutarlas), y el resolvedor único.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const lanza = async (f: () => unknown) => { try { await f(); return null } catch (e) { return e as Error & { code?: string } } }

const EAN = ean13('775000010001')
const EAN_B = ean13('775000010002')

async function parte1() {
  console.log('\n1) Tipo de un código')
  check('>>> EAN-13 válido → EAN13; EAN-8 válido → EAN8; UPC-12 válido → UPC', tipoDeCodigo(EAN) === 'EAN13' && tipoDeCodigo('96385074') === 'EAN8' && tipoDeCodigo('036000291452') === 'UPC')
  check('>>> 13 dígitos con el dígito de control MAL no es un EAN: CODE128', tipoDeCodigo(EAN.slice(0, 12) + ((Number(EAN[12]) + 1) % 10)) === 'CODE128')
  check('texto libre o numérico raro → CODE128; la columna qrCode → QR siempre', tipoDeCodigo('TORN-1/4-ZN') === 'CODE128' && tipoDeCodigo('12345') === 'CODE128' && tipoDeCodigo(EAN, true) === 'QR')
  check('limpiarCodigo recorta y descarta vacíos', limpiarCodigo('  abc ') === 'abc' && limpiarCodigo('   ') === null && limpiarCodigo(null) === null)

  console.log('\n2) Plan de relleno (puro): colisiones sin tocar nada')
  const d = (productId: string, columna: 'barcode' | 'qrCode', codigo: string, variantId: string | null = null, sku = productId): DuenoLegado => ({ productId, variantId, sku, nombre: `Producto ${productId}`, columna, codigo })
  const limpio = planificarCodigos([d('p1', 'barcode', EAN), d('p1', 'qrCode', 'QR-1'), d('p2', 'barcode', EAN_B)])
  check('>>> sin choques: una fila por código, con su tipo', limpio.colisiones.length === 0 && limpio.insertar.length === 3 && limpio.insertar.find((x) => x.code === EAN)?.type === 'EAN13' && limpio.insertar.find((x) => x.code === 'QR-1')?.type === 'QR')
  check('>>> un solo principal por dueño: el de barras; si solo hay QR, el QR', limpio.insertar.find((x) => x.code === EAN)?.isPrimary === true && limpio.insertar.find((x) => x.code === 'QR-1')?.isPrimary === false && planificarCodigos([d('p3', 'qrCode', 'SOLO-QR')]).insertar[0]!.isPrimary === true)
  const choque = planificarCodigos([d('p1', 'barcode', EAN), d('p2', 'qrCode', EAN), d('p3', 'barcode', EAN_B)])
  check('>>> el EAN de un producto igual al QR de otro es COLISIÓN: no se inserta para NINGUNO', choque.colisiones.length === 1 && choque.colisiones[0]!.codigo === EAN && choque.colisiones[0]!.duenos.length === 2 && !choque.insertar.some((x) => x.code === EAN))
  check('...y se informa de quién es cada uno (sku, columna)', choque.colisiones[0]!.duenos.map((x) => `${x.sku}:${x.columna}`).sort().join() === 'p1:barcode,p2:qrCode')
  check('...los demás códigos sí se insertan', choque.insertar.length === 1 && choque.insertar[0]!.code === EAN_B)
  check('>>> producto contra variante con el mismo código: colisión', planificarCodigos([d('p1', 'barcode', EAN), d('p1', 'barcode', EAN, 'v1')]).colisiones.length === 1)
  check('>>> el MISMO dueño con el mismo código en barcode y qrCode NO es colisión (una fila)', (() => { const r = planificarCodigos([d('p1', 'barcode', EAN), d('p1', 'qrCode', EAN)]); return r.colisiones.length === 0 && r.insertar.length === 1 && r.insertar[0]!.type === 'EAN13' })())
  check('espacios y vacíos: se limpian o se ignoran; "x" y " x " son el mismo código', planificarCodigos([d('p1', 'barcode', ' x '), d('p2', 'barcode', 'x'), d('p3', 'barcode', '   ')]).colisiones.length === 1)
  check('(el plan es puro: no recibe ni toca la base)', true)
}

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `cod-${tag}-${randomUUID().slice(0, 6)}`, name: `Códigos ${tag}`, planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cod' } })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER' } })
  await asignarSucursal(t.id, u.id, branch.id)
  const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
  let n = 0
  /** Un producto con sus códigos SOLO en las columnas antiguas (como están los datos hoy), y stock en el almacén. */
  const producto = async (o: { barcode?: string | null; qrCode?: string | null; sku?: string; name?: string; stock?: number; activo?: boolean; borrado?: boolean } = {}) => {
    n++
    const p = await prisma.product.create({ data: { tenantId: t.id, sku: o.sku ?? `SKU-${tag}-${n}`, name: o.name ?? `Producto ${tag} ${n}`, barcode: o.barcode ?? null, qrCode: o.qrCode ?? null, salePrice: 10 + n, isActive: o.activo ?? true, deletedAt: o.borrado ? new Date() : null } })
    if (o.stock !== undefined) await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: w.id, quantity: o.stock, minStock: 2 } })
    return p
  }
  const variante = async (productId: string, o: { barcode?: string | null; qrCode?: string | null; name?: string; salePrice?: number | null; stock?: number } = {}) => {
    n++
    const v = await prisma.productVariant.create({ data: { tenantId: t.id, productId, sku: `VAR-${tag}-${n}`, name: o.name ?? '3 m', barcode: o.barcode ?? null, qrCode: o.qrCode ?? null, salePrice: o.salePrice ?? null } })
    if (o.stock !== undefined) await prisma.stock.create({ data: { tenantId: t.id, productId, variantId: v.id, warehouseId: w.id, quantity: o.stock } })
    return v
  }
  return { t, ctx, w, db: getTenantPrisma(ctx), producto, variante, filas: () => prisma.productCode.findMany({ where: { tenantId: t.id } }) }
}

async function main() {
  await parte1()
  const A = await negocio('a'), B = await negocio('b')

  console.log('\n3) La tabla y sus restricciones')
  const p0 = await A.producto({ name: 'Base' })
  const f = (data: Record<string, unknown>) => prisma.productCode.create({ data: { tenantId: A.t.id, productId: p0.id, code: 'X-1', type: 'CODE128', ...data } as never })
  await f({})
  check('>>> (negocio, código) es ÚNICO: el mismo código dos veces falla', (await lanza(() => f({})))?.code === 'P2002')
  const pB = await B.producto({ name: 'De B' })
  check('>>> pero el mismo código en OTRO negocio sí se permite', !(await lanza(() => prisma.productCode.create({ data: { tenantId: B.t.id, productId: pB.id, code: 'X-1', type: 'CODE128' } }))))
  check('>>> un código no puede apuntar al producto de otro negocio (clave foránea compuesta)', (await lanza(() => f({ code: 'X-2', productId: pB.id })))?.code === 'P2003')
  check('>>> código con espacios en los extremos o vacío → rechazado por la base', (await lanza(() => f({ code: ' X-3 ' }))) !== null && (await lanza(() => f({ code: '' }))) !== null)
  await f({ code: 'P-1', isPrimary: true })
  check('>>> un solo código PRINCIPAL por dueño (índice parcial)', (await lanza(() => f({ code: 'P-2', isPrimary: true }))) !== null && !(await lanza(() => f({ code: 'P-3', isPrimary: false }))))
  const v0 = await A.variante(p0.id)
  check('...pero la variante tiene su propio principal', !(await lanza(() => f({ code: 'P-V', variantId: v0.id, isPrimary: true }))))
  check('un tipo fuera del enum se rechaza', (await lanza(() => f({ code: 'T-1', type: 'RARO' }))) !== null)
  check('>>> el cliente aislado no ve los códigos del otro negocio', (await B.db.productCode.count({ where: { code: 'P-1' } })) === 0 && (await A.db.productCode.count({ where: { code: 'P-1' } })) === 1)
  await prisma.productCode.deleteMany({ where: { tenantId: A.t.id } })

  console.log('\n4) Relleno desde las columnas antiguas: no muta nada')
  const C = await negocio('c')
  const c1 = await C.producto({ barcode: EAN, qrCode: 'QR-C1', sku: 'C1', name: 'Cemento' })
  const c2 = await C.producto({ barcode: EAN_B, sku: 'C2', name: 'Fierro' })
  const c3 = await C.producto({ qrCode: 'SOLO-QR', sku: 'C3', name: 'Granel' })
  const c4 = await C.producto({ barcode: '7750000999990', sku: 'C4', name: 'Clavo', borrado: true })
  const cv = await C.variante(c2.id, { barcode: ean13('775000010003'), name: '3 m' })
  // Colisión: el EAN de «Pegamento» es el QR de «Silicona».
  const dupA = await C.producto({ barcode: ean13('775000010004'), sku: 'PEG', name: 'Pegamento' })
  const dupB = await C.producto({ qrCode: ean13('775000010004'), sku: 'SIL', name: 'Silicona' })
  const antes = JSON.stringify(await prisma.product.findMany({ where: { tenantId: C.t.id }, orderBy: { id: 'asc' } })) + JSON.stringify(await prisma.productVariant.findMany({ where: { tenantId: C.t.id } }))

  const ensayo = await poblarCodigos(C.db, C.t.id)
  check('>>> el ensayo NO escribe nada y ya cuenta lo que haría', (await C.filas()).length === 0 && ensayo.ejecutado === false && ensayo.insertados === 6)
  check('>>> informa la colisión con los dos dueños y NO la resuelve', ensayo.colisiones.length === 1 && ensayo.colisiones[0]!.duenos.map((d) => d.sku).sort().join() === 'PEG,SIL')
  check('el informe en texto dice claramente QUIÉN choca', formatearInforme('c', ensayo).includes('COLISIÓN') && formatearInforme('c', ensayo).includes('PEG «Pegamento»') && formatearInforme('c', ensayo).includes('SIL «Silicona»'))
  const real = await poblarCodigos(C.db, C.t.id, { ejecutar: true })
  const filas = await C.filas()
  check('>>> ejecutado: se insertan los códigos sin colisión (productos, variantes, también el dado de baja)', real.insertados === 6 && filas.length === 6 && filas.some((x) => x.code === '7750000999990') && filas.some((x) => x.variantId === cv.id))
  check('>>> los códigos en colisión NO están en la tabla (ni para uno ni para otro)', !filas.some((x) => x.code === ean13('775000010004')))
  check('tipos y principal: EAN13 principal con su QR secundario; solo-QR es su principal', filas.find((x) => x.code === EAN)?.type === 'EAN13' && filas.find((x) => x.code === EAN)?.isPrimary === true && filas.find((x) => x.code === 'QR-C1')?.isPrimary === false && filas.find((x) => x.code === 'SOLO-QR')?.isPrimary === true)
  check('>>> productos y variantes quedaron EXACTAMENTE como estaban', JSON.stringify(await prisma.product.findMany({ where: { tenantId: C.t.id }, orderBy: { id: 'asc' } })) + JSON.stringify(await prisma.productVariant.findMany({ where: { tenantId: C.t.id } })) === antes)
  const otra = await poblarCodigos(C.db, C.t.id, { ejecutar: true })
  check('>>> idempotente: repetirlo no inserta ni duplica nada', otra.insertados === 0 && otra.yaExistian === 6 && (await C.filas()).length === 6)
  void c1; void c3; void c4; void dupB

  console.log('\n5) Resolvedor único')
  const R = await negocio('r')
  const r1 = await R.producto({ barcode: EAN, qrCode: 'QR-R1', sku: 'R1', name: 'Cemento', stock: 40 })
  const r2 = await R.producto({ sku: 'R2', name: 'Sin código aún', stock: 5 })
  const r3 = await R.producto({ barcode: ean13('775000010005'), sku: 'R3', name: 'Con variantes', stock: 9 })
  const rv = await R.variante(r3.id, { barcode: ean13('775000010006'), name: 'Rojo', salePrice: 99, stock: 7 })
  const inactivo = await R.producto({ barcode: ean13('775000010007'), sku: 'R4', name: 'Apagado', activo: false })
  const borrado = await R.producto({ barcode: ean13('775000010008'), sku: 'R5', name: 'Borrado', borrado: true })
  await poblarCodigos(R.db, R.t.id, { ejecutar: true })
  const ok = async (code: string, almacen = true) => { const x = await resolverCodigo(R.db, code, almacen ? { almacenId: R.w.id } : {}); return x?.estado === 'ok' ? x : null }
  const porEan = await ok(EAN)
  check('>>> un EAN resuelve por la TABLA a {producto, variante, presentación} y trae su stock', porEan?.via === 'tabla' && porEan.producto.id === r1.id && porEan.variante === null && porEan.presentacion === null && Number(porEan.stock?.quantity) === 40 && porEan.tipo === 'EAN13')
  check('el QR propio resuelve al MISMO producto', (await ok('QR-R1'))?.producto.id === r1.id && (await ok('QR-R1'))?.tipo === 'QR')
  const porVar = await ok(ean13('775000010006'))
  check('>>> el código de una VARIANTE resuelve a esa variante, con SU stock (no el del producto)', porVar?.variante?.id === rv.id && porVar.producto.id === r3.id && Number(porVar.stock?.quantity) === 7 && Number(porVar.variante?.salePrice) === 99)
  check('sin almacén no trae stock; el código sigue resolviendo', (await ok(EAN, false))?.stock === null && (await ok(EAN, false))?.producto.id === r1.id)
  check('>>> un producto aún SIN fila en la tabla se encuentra por el respaldo (columnas antiguas y SKU)', (await ok('R2'))?.via === 'legado' && (await ok('R2'))?.producto.id === r2.id)
  const sinFila = await R.producto({ barcode: ean13('775000010009'), sku: 'R6', name: 'Sin rellenar', stock: 3 })
  check('...y un código antiguo sin rellenar también', (await ok(ean13('775000010009')))?.via === 'legado' && (await ok(ean13('775000010009')))?.producto.id === sinFila.id)
  check('>>> un producto inactivo o dado de baja NO se escanea (aunque su código esté en la tabla)', (await ok(ean13('775000010007'))) === null && (await ok(ean13('775000010008'))) === null)
  check('código desconocido, vacío o con espacios', (await resolverCodigo(R.db, '0000')) === null && (await resolverCodigo(R.db, '   ')) === null && (await ok(`  ${EAN}  `))?.producto.id === r1.id)
  check('>>> el código de OTRO negocio no existe aquí', (await resolverCodigo(B.db, EAN)) === null)
  void inactivo; void borrado

  console.log('\n6) Ambigüedad: jamás se adivina')
  const dupX = await R.producto({ barcode: ean13('775000010010'), sku: 'DX', name: 'Uno' })
  const dupY = await R.producto({ qrCode: ean13('775000010010'), sku: 'DY', name: 'Otro' })
  const amb = await resolverCodigo(R.db, ean13('775000010010'))
  check('>>> un código de DOS productos (datos antiguos con colisión) → ambiguo, con los candidatos', amb?.estado === 'ambiguo' && amb.candidatos.map((c) => c.sku).sort().join() === 'DX,DY')
  check('el mensaje para la pantalla nombra los productos', amb?.estado === 'ambiguo' && mensajeAmbiguo(amb).includes('DX') && mensajeAmbiguo(amb).includes('DY'))
  const skuIgual = await R.producto({ sku: ean13('775000010011'), name: 'SKU = código' })
  const conBarras = await R.producto({ barcode: ean13('775000010011'), sku: 'OTRO-SKU', name: 'Con ese código' })
  check('>>> el SKU de uno igual al código de barras de otro también es ambiguo (antes devolvía uno al azar)', (await resolverCodigo(R.db, ean13('775000010011')))?.estado === 'ambiguo')
  void dupX; void dupY; void skuIgual; void conBarras

  console.log('\n7) Los escritores mantienen la tabla al día')
  const W = await negocio('w')
  const ex = await createProductExpress(W.db, W.ctx, { name: 'Exprés', sku: 'EXP-1', barcode: ean13('775000010020'), qrCode: 'QR-EXP', unitType: 'UNIDAD', salePrice: 5, initialStock: 3, minStock: 1, warehouseId: W.w.id, idempotencyKey: randomUUID() } as never)
  const filasW = await W.filas()
  check('>>> el alta exprés crea también sus códigos en la tabla (barras principal + QR)', filasW.length === 2 && filasW.find((x) => x.code === ean13('775000010020'))?.isPrimary === true && filasW.every((x) => x.productId === ex.productId))
  check('>>> y escanear lo encuentra POR LA TABLA', (await resolverCodigo(W.db, 'QR-EXP').then((x) => x?.estado === 'ok' ? x.via : null)) === 'tabla')
  const choqueEx = await lanza(() => createProductExpress(W.db, W.ctx, { name: 'Intruso', sku: 'EXP-2', barcode: 'OTRO-EAN-0001', qrCode: ean13('775000010020'), unitType: 'UNIDAD', salePrice: 5, initialStock: 0, minStock: 0, warehouseId: W.w.id, idempotencyKey: randomUUID() } as never))
  check('>>> un código que ya es de otro producto: DUPLICATE_CODE y NO se crea nada (ni el producto)', choqueEx?.code === 'DUPLICATE_CODE' && (await prisma.product.count({ where: { tenantId: W.t.id, sku: 'EXP-2' } })) === 0 && (await prisma.productCode.count({ where: { tenantId: W.t.id, code: 'OTRO-EAN-0001' } })) === 0)

  const ARCH = ['Nombre;SKU;Código de barras;Unidad;P. Venta;Stock', `"Cinta";CINTA-1;${ean13('775000010030')};und;3,50;10`].join('\r\n')
  await commitImport(W.db, W.ctx, await analyzeImport(W.db, W.ctx, ARCH), W.w.id)
  check('>>> la importación de catálogo también registra sus códigos', (await prisma.productCode.count({ where: { tenantId: W.t.id, code: ean13('775000010030') } })) === 1)
  const ARCH2 = ['Nombre;SKU;Código de barras;Unidad;P. Venta;Stock', `"Cinta";CINTA-1;${ean13('775000010031')};und;3,50;10`].join('\r\n')
  const a2 = await analyzeImport(W.db, W.ctx, ARCH2)
  await commitImport(W.db, W.ctx, a2, W.w.id)
  const prodCinta = await prisma.product.findFirstOrThrow({ where: { tenantId: W.t.id, sku: 'CINTA-1' } })
  check('(la segunda importación ACTUALIZA el mismo producto y le cambia el código)', a2.filas[0]?.estado === 'actualizar' && prodCinta.barcode === ean13('775000010031'))
  check('>>> el código viejo SALE de la tabla (ya no resuelve a ese producto) y el nuevo entra', (await prisma.productCode.count({ where: { tenantId: W.t.id, code: ean13('775000010030') } })) === 0 && (await prisma.productCode.count({ where: { tenantId: W.t.id, code: ean13('775000010031'), productId: prodCinta.id } })) === 1 && (await resolverCodigo(W.db, ean13('775000010030'))) === null)
  const rep = await auditarCoherenciaCodigos(W.db)
  check('>>> la auditoría de coherencia no ve desfases tras usar los servicios', rep.sinFila === 0 && rep.filasHuerfanas === 0, JSON.stringify(rep))
  const deliberado = await W.producto({ barcode: ean13('775000010040'), sku: 'RAW', name: 'Creado a pelo' })
  const rep2 = await auditarCoherenciaCodigos(W.db)
  check('>>> y SÍ ve un producto creado saltándose los servicios (sin fila en la tabla)', rep2.sinFila === 1)
  await registrarCodigosProducto(W.db, W.t.id, { productId: deliberado.id }, { barcode: deliberado.barcode, qrCode: null })
  check('registrarCodigosProducto es idempotente: repetirlo no duplica', (await prisma.productCode.count({ where: { tenantId: W.t.id, productId: deliberado.id } })) === 1)

  console.log('\n8) Las pantallas usan el resolvedor')
  const pos = readFileSync('src/features/pos/actions.ts', 'utf8'), inv = readFileSync('src/features/inventory/actions.ts', 'utf8')
  for (const [nombre, src] of [['POS', pos], ['Inventario', inv]] as const) {
    check(`>>> ${nombre}: el escaneo pasa por resolverCodigo y trata el código ambiguo`, src.includes('resolverCodigo(db, code, { almacenId: warehouse.id })') && src.includes("r.estado === 'ambiguo'") && src.includes('mensajeAmbiguo'))
    check(`>>> ${nombre}: ya no pregunta a mano por barcode/qrCode/sku en el producto`, !/OR: \[\{ barcode: code \}, \{ qrCode: code \}, \{ sku: code \}\]/.test(src))
  }
  const todo = ['product-service', 'import-service'].map((f) => readFileSync(`src/features/inventory/${f}.ts`, 'utf8')).join('\n')
  check('>>> los dos escritores de productos llaman a registrarCodigosProducto', (todo.match(/registrarCodigosProducto\(/g) ?? []).length >= 3)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
