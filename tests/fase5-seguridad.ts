import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { resolveRouteAccess } from '../src/lib/route-access'
import { crearBorrador, recibirCompra, completarDocumento } from '../src/features/compras/service'
import { completarDocumentoSchema, crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { exportarVentasCsv, informeCobros, informeVentasPorMedio, informeVentasPorPeriodo, informeVentasPorVendedor } from '../src/features/reportes/ventas-service'
import { exportarCostosCsv, informeAbc, informeInventario, informeMargen } from '../src/features/reportes/rentabilidad-service'
import { exportarRegistroCsv, informeRegistroCompras, informeRegistroVentas } from '../src/features/registros/registro-service'
import { exportarConciliacionCsv, informeConciliacion } from '../src/features/conciliacion/conciliacion-service'
import { listarAuditoria, personasParaFiltro } from '../src/features/auditoria/service'
import { parametrosCostosSchema, parametrosVentasSchema } from '../src/features/reportes/schemas'
import { parametrosRegistrosSchema } from '../src/features/registros/schemas'
import { parametrosAuditoriaSchema } from '../src/features/auditoria/schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F5.8 · REVISIÓN DE COHERENCIA Y SEGURIDAD de toda la Fase 5. Una matriz de roles × cada punto de entrada (informes y descargas), los poderes
 * sueltos (un permiso = un poder), que NINGÚN informe de `reportes.ver` filtre un costo, aislamiento entre negocios, acotado por sucursal, y
 * revisiones del código fuente de páginas, rutas y servicios.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const AHORA = new Date('2026-10-27T03:00:00Z')
const PV = parametrosVentasSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26' })
const PC = parametrosCostosSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26' })
const PR = parametrosRegistrosSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26' })
const PA = parametrosAuditoriaSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26' })

// Valores centinela: si aparecen en la salida de un informe que NO debe revelar costos, hubo una fuga.
const COSTO_PRODUCTO = 37.7311, COSTO_COMPRA = 41.2399

const archivos = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? archivos(p) : /\.tsx?$/.test(f) ? [p] : [] })

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 300) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const montar = async (tag: string) => {
    const t = await prisma.tenant.create({ data: { slug: `rp-seg-${tag}-${randomUUID().slice(0, 6)}`, name: `Seguridad ${tag}`, taxId: ruc(), planId: plan.id, realBillingEnabledAt: new Date('2026-01-01T00:00:00Z') } })
    await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_seg' } })
    const b1 = await crearSucursalConAlmacen(t.id)
    const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
    const u: Record<string, TenantContext> = {}
    for (const role of ['OWNER', 'ADMIN', 'CONTADOR', 'CAJERO', 'VENDEDOR', 'ALMACENERO'] as Role[]) {
      const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
      await asignarSucursal(t.id, x.id, b1.branch.id)
      u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: [] }
    }
    return { t, b1, b2, u }
  }
  const A = await montar('a'), B = await montar('b')

  // Datos de A: productos con costo centinela, ventas (una por sucursal), comprobante, compra con unitCost centinela, auditoría.
  const sembrar = async (N: typeof A, etiqueta: string, ventaB1: number, ventaB2: number) => {
    const prod = await prisma.product.create({ data: { tenantId: N.t.id, sku: `S-${etiqueta}`, name: `Producto ${etiqueta}`, unitType: 'UNIDAD', salePrice: 100, costPrice: COSTO_PRODUCTO } })
    for (const w of [N.b1.warehouse, N.b2.warehouse]) await prisma.stock.create({ data: { tenantId: N.t.id, productId: prod.id, warehouseId: w.id, quantity: 10 } })
    const crearVenta = async (b: typeof N.b1, total: number, nro: string) => {
      const base = Math.round((total / 1.18) * 100) / 100, igv = Math.round((total - base) * 100) / 100
      const sale = await prisma.sale.create({ data: { tenantId: N.t.id, branchId: b.branch.id, warehouseId: b.warehouse.id, userId: N.u.OWNER!.userId, number: nro, documentType: 'BOLETA', status: 'COMPLETADA', subtotal: base, taxTotal: igv, total, completedAt: new Date('2026-10-22T15:00:00Z') } })
      await prisma.saleItem.create({ data: { tenantId: N.t.id, saleId: sale.id, productId: prod.id, nameSnapshot: prod.name, skuSnapshot: prod.sku, quantity: 1, unitPrice: total, taxRate: 0.18, unitCost: COSTO_PRODUCTO, lineTotal: total } })
      await prisma.payment.create({ data: { tenantId: N.t.id, saleId: sale.id, userId: N.u.OWNER!.userId, method: 'EFECTIVO', amount: total, receivedAt: new Date('2026-10-22T15:00:00Z') } })
      return { sale, base, igv }
    }
    const s1 = await crearVenta(N.b1, ventaB1, `V-${etiqueta}-1`), s2 = await crearVenta(N.b2, ventaB2, `V-${etiqueta}-2`)
    for (const [i, s] of [s1, s2].entries()) await prisma.taxDocument.create({ data: { tenantId: N.t.id, saleId: s.sale.id, documentType: 'BOLETA', series: `B00${i + 1}`, correlativo: 1, fullNumber: `B00${i + 1}-00000001`, status: 'ACEPTADO', isTrial: false, subtotal: s.base, taxTotal: s.igv, total: Number(s.sale.total), issuedAt: new Date('2026-10-22T15:00:00Z'), receiverDocType: 'SIN_DOCUMENTO', receiverName: 'Cliente' } })
    const prov = await prisma.supplier.create({ data: { tenantId: N.t.id, name: `Proveedor ${etiqueta}`, taxId: ruc() } })
    const owner = N.u.OWNER!
    const comprar = async (c: TenantContext, almacen: string, doc: Record<string, unknown>) => {
      const k = await crearBorrador(getTenantPrisma(c), c, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: almacen, supplierId: prov.id, items: [{ productId: prod.id, enteredQuantity: 3, unitCost: COSTO_COMPRA }, { productId: prod.id, enteredQuantity: 2, unitCost: 1.5 }], ...doc }))
      await recibirCompra(getTenantPrisma(c), c, recibirCompraSchema.parse({ purchaseId: k.id }))
      return k
    }
    const k1 = await comprar(owner, N.b1.warehouse.id, { docType: 'FACTURA', docSeries: 'F001', docNumber: '1', issueDate: '2026-10-22' })
    const k2 = await comprar({ ...owner, branchId: N.b2.branch.id }, N.b2.warehouse.id, { docType: 'FACTURA', docSeries: 'F002', docNumber: '2', issueDate: '2026-10-22' })
    await prisma.auditLog.create({ data: { tenantId: N.t.id, actorId: owner.userId, actorRole: 'OWNER', action: 'cliente.creado', entityType: 'Cliente', entityId: `cli-${etiqueta}`, after: { nombre: `Cliente ${etiqueta}`, token: 'NO-DEBE-SALIR' }, createdAt: new Date('2026-10-22T15:00:00Z') } })
    return { prod, k1, k2 }
  }
  const dA = await sembrar(A, 'A', 1111.11, 3333.33)
  await sembrar(B, 'B', 7777.77, 8888.88)

  console.log('\nA) Matriz de roles × cada punto de entrada de la Fase 5')
  type Entrada = { nombre: string; permiso: 'reportes.ver' | 'productos.ver_costo' | 'auditoria.ver' | 'compras.registrar'; ejecutar: (c: TenantContext) => Promise<unknown> }
  const db = (c: TenantContext) => getTenantPrisma(c)
  const entradas: Entrada[] = [
    { nombre: 'ventas por periodo', permiso: 'reportes.ver', ejecutar: (c) => informeVentasPorPeriodo(db(c), c, PV, AHORA) },
    { nombre: 'ventas por vendedor', permiso: 'reportes.ver', ejecutar: (c) => informeVentasPorVendedor(db(c), c, PV, AHORA) },
    { nombre: 'ventas por medio', permiso: 'reportes.ver', ejecutar: (c) => informeVentasPorMedio(db(c), c, PV, AHORA) },
    { nombre: 'cobros', permiso: 'reportes.ver', ejecutar: (c) => informeCobros(db(c), c, PV, AHORA) },
    ...(['periodo', 'vendedor', 'medios', 'cobros'] as const).map((tp) => ({ nombre: `CSV ventas ${tp}`, permiso: 'reportes.ver' as const, ejecutar: (c: TenantContext) => exportarVentasCsv(db(c), c, tp, PV, AHORA) })),
    { nombre: 'registro de ventas', permiso: 'reportes.ver', ejecutar: (c) => informeRegistroVentas(db(c), c, PR, AHORA) },
    { nombre: 'registro de compras', permiso: 'reportes.ver', ejecutar: (c) => informeRegistroCompras(db(c), c, PR, AHORA) },
    { nombre: 'CSV registro de ventas', permiso: 'reportes.ver', ejecutar: (c) => exportarRegistroCsv(db(c), c, 'ventas', PR, AHORA) },
    { nombre: 'CSV registro de compras', permiso: 'reportes.ver', ejecutar: (c) => exportarRegistroCsv(db(c), c, 'compras', PR, AHORA) },
    { nombre: 'conciliación fiscal', permiso: 'reportes.ver', ejecutar: (c) => informeConciliacion(db(c), c, PR, AHORA) },
    { nombre: 'CSV conciliación', permiso: 'reportes.ver', ejecutar: (c) => exportarConciliacionCsv(db(c), c, PR, AHORA) },
    { nombre: 'margen', permiso: 'productos.ver_costo', ejecutar: (c) => informeMargen(db(c), c, PC, AHORA) },
    { nombre: 'inventario valorizado', permiso: 'productos.ver_costo', ejecutar: (c) => informeInventario(db(c), c, AHORA) },
    { nombre: 'ABC', permiso: 'productos.ver_costo', ejecutar: (c) => informeAbc(db(c), c, PC, AHORA) },
    ...(['margen', 'inventario', 'abc'] as const).map((tp) => ({ nombre: `CSV rentabilidad ${tp}`, permiso: 'productos.ver_costo' as const, ejecutar: (c: TenantContext) => exportarCostosCsv(db(c), c, tp, PC, AHORA) })),
    { nombre: 'auditoría (lista)', permiso: 'auditoria.ver', ejecutar: (c) => listarAuditoria(db(c), c, PA, AHORA) },
    { nombre: 'auditoría (personas)', permiso: 'auditoria.ver', ejecutar: (c) => personasParaFiltro(db(c), c) },
    { nombre: 'completar documento de una compra', permiso: 'compras.registrar', ejecutar: (c) => completarDocumento(db(c), c, completarDocumentoSchema.parse({ purchaseId: dA.k1.id, docType: 'FACTURA', docSeries: 'F001', docNumber: '1', issueDate: '2026-10-22' })) },
  ]
  // Quién tiene cada poder de fábrica (tabla EXPLÍCITA, no derivada de `puede`).
  const tienen: Record<Entrada['permiso'], Role[]> = {
    'reportes.ver': ['OWNER', 'ADMIN', 'CONTADOR'], 'productos.ver_costo': ['OWNER', 'ADMIN', 'CONTADOR'], 'auditoria.ver': ['OWNER', 'ADMIN'], 'compras.registrar': ['OWNER', 'ADMIN'],
  }
  const roles: Role[] = ['OWNER', 'ADMIN', 'CONTADOR', 'CAJERO', 'VENDEDOR', 'ALMACENERO']
  const fallos: string[] = []
  for (const e of entradas) for (const r of roles) {
    const res = await code(e.ejecutar(A.u[r]!))
    const debe = tienen[e.permiso].includes(r)
    if (debe ? res !== null : res !== 'FORBIDDEN_ROLE') fallos.push(`${e.nombre} / ${r}: ${res ?? 'permitido'} (debía ${debe ? 'permitir' : 'FORBIDDEN_ROLE'})`)
  }
  check(`>>> ${entradas.length} puntos de entrada × 6 roles = ${entradas.length * 6} combinaciones: cada una permite o niega EXACTAMENTE lo que corresponde`, fallos.length === 0, fallos.slice(0, 4).join(' | '))

  console.log('\nB) Un permiso = un poder (los poderes no se mezclan)')
  const base = A.u.CONTADOR!
  const sinCosto: TenantContext = { ...base, permisosDenegados: ['productos.ver_costo'] }
  const sinReportes: TenantContext = { ...base, permisosDenegados: ['reportes.ver'] }
  const cajeroVeReportes: TenantContext = { ...A.u.CAJERO!, permisosExtra: ['reportes.ver'] }
  const cajeroVeCostos: TenantContext = { ...A.u.CAJERO!, permisosExtra: ['productos.ver_costo'] }
  const porPermiso = (p: Entrada['permiso']) => entradas.filter((e) => e.permiso === p)
  const todoPermitido = async (c: TenantContext, p: Entrada['permiso']) => (await Promise.all(porPermiso(p).map((e) => code(e.ejecutar(c))))).every((x) => x === null)
  const todoNegado = async (c: TenantContext, p: Entrada['permiso']) => (await Promise.all(porPermiso(p).map((e) => code(e.ejecutar(c))))).every((x) => x === 'FORBIDDEN_ROLE')
  check('>>> un contador al que se le quita `productos.ver_costo` conserva reportes, registros y conciliación, y pierde TODA la rentabilidad', await todoPermitido(sinCosto, 'reportes.ver') && await todoNegado(sinCosto, 'productos.ver_costo'))
  check('>>> un contador al que se le quita `reportes.ver` pierde reportes, registros y conciliación pero conserva la rentabilidad (cada poder se guarda aparte)', await todoNegado(sinReportes, 'reportes.ver') && await todoPermitido(sinReportes, 'productos.ver_costo'))
  check('>>> un cajero con solo `reportes.ver` ve ventas, registros y conciliación pero NO la rentabilidad', await todoPermitido(cajeroVeReportes, 'reportes.ver') && await todoNegado(cajeroVeReportes, 'productos.ver_costo'))
  check('>>> un cajero con solo `productos.ver_costo` ve la rentabilidad pero NO ventas, registros ni conciliación', await todoPermitido(cajeroVeCostos, 'productos.ver_costo') && await todoNegado(cajeroVeCostos, 'reportes.ver'))
  check('>>> `reportes.ver` y `productos.ver_costo` no abren la auditoría, y `auditoria.ver` solo la abre a dueño y administrador', await todoNegado(base, 'auditoria.ver') && await todoNegado(cajeroVeReportes, 'auditoria.ver') && await todoNegado({ ...cajeroVeReportes, permisosExtra: ['reportes.ver', 'productos.ver_costo'] }, 'auditoria.ver'))
  check('>>> completar un documento exige `compras.registrar` y no lo dan ni `reportes.ver` ni `productos.ver_costo`', await todoNegado({ ...base }, 'compras.registrar') && await todoNegado({ ...A.u.CAJERO!, permisosExtra: ['reportes.ver', 'productos.ver_costo'] }, 'compras.registrar') && await todoPermitido({ ...A.u.ALMACENERO!, permisosExtra: ['compras.registrar'] }, 'compras.registrar'))

  console.log('\nC) Ningún informe de `reportes.ver` filtra costos')
  const salidas = async (c: TenantContext) => {
    const r: Record<string, unknown> = {}
    for (const e of entradas.filter((x) => x.permiso === 'reportes.ver')) r[e.nombre] = await e.ejecutar(c)
    return r
  }
  const ctxSinCostos: TenantContext[] = [sinCosto, cajeroVeReportes]
  for (const [i, c] of ctxSinCostos.entries()) {
    const out = await salidas(c)
    const texto = JSON.stringify(out)
    const csv = Object.entries(out).filter(([, v]) => v && typeof v === 'object' && 'contenido' in (v as object)).map(([, v]) => (v as { contenido: string }).contenido).join('\n')
    const claves = [...texto.matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]!)
    const cabeceras = csv.split('\n').filter((l) => l.includes(';') && !/^\d/.test(l)).join(' ')
    check(`>>> ${i === 0 ? 'contador sin ver_costo' : 'cajero con reportes.ver'}: ni el costo del producto ni el costo de la compra aparecen en NINGUNA salida (JSON ni CSV)`, !texto.includes(String(COSTO_PRODUCTO)) && !texto.includes('37.73') && !texto.includes(String(COSTO_COMPRA)) && !texto.includes('41.24') && !csv.includes('37.73') && !csv.includes('41.24') && !csv.includes('37,73') && !csv.includes('41,24'))
    check(`${i === 0 ? 'contador sin ver_costo' : 'cajero con reportes.ver'}: ninguna salida lleva campos de costo, utilidad ni margen (ni en el JSON ni en las cabeceras del CSV)`, !claves.some((k) => /^(cost|unitCost|costo|costPrice|utilidad|margen)/i.test(k)) && !/Costo|Utilidad|Margen/i.test(cabeceras), claves.filter((k) => /cost|utilidad|margen/i.test(k)).join())
  }
  check('el registro de compras muestra el total de cada DOCUMENTO (base, IGV, total), no el costo de cada producto: la compra de dos líneas no deja deducir el costo unitario centinela', await (async () => { const r = (await informeRegistroCompras(db(cajeroVeReportes), cajeroVeReportes, PR, AHORA)).datos; const c1 = r.filas.find((f) => f.id === dA.k1.id)!; return Math.round(c1.base * 100) === Math.round((3 * COSTO_COMPRA + 2 * 1.5) * 100) && !JSON.stringify(c1).includes('unitCost') })())

  console.log('\nD) Aislamiento entre negocios')
  const todas = await salidas(A.u.OWNER!)
  const masA = { ...todas, margen: await informeMargen(db(A.u.OWNER!), A.u.OWNER!, PC, AHORA), inventario: await informeInventario(db(A.u.OWNER!), A.u.OWNER!, AHORA), abc: await informeAbc(db(A.u.OWNER!), A.u.OWNER!, PC, AHORA), auditoria: await listarAuditoria(db(A.u.OWNER!), A.u.OWNER!, PA, AHORA), personas: await personasParaFiltro(db(A.u.OWNER!), A.u.OWNER!) }
  const txtA = JSON.stringify(masA)
  check('>>> el negocio A (dueño) nunca ve nada del negocio B: ni importes (7777.77, 8888.88), ni proveedor, ni cliente de auditoría, ni ids', !txtA.includes('7777.77') && !txtA.includes('8888.88') && !txtA.includes('Proveedor B') && !txtA.includes('cli-B') && !txtA.includes(B.t.id) && !txtA.includes(B.u.OWNER!.userId))
  check('…y sí ve lo suyo (los importes de A y su proveedor)', txtA.includes('1111.11') && txtA.includes('3333.33') && txtA.includes('Proveedor A'))
  const txtB = JSON.stringify({ ...await salidas(B.u.OWNER!), auditoria: await listarAuditoria(db(B.u.OWNER!), B.u.OWNER!, PA, AHORA) })
  check('>>> y el B tampoco ve nada de A', !txtB.includes('1111.11') && !txtB.includes('3333.33') && !txtB.includes('Proveedor A') && !txtB.includes('cli-A') && !txtB.includes(A.t.id))
  check('>>> un contexto de A apuntando a una compra de B no puede completarle el documento (NOT_FOUND)', (await code(completarDocumento(db(A.u.OWNER!), A.u.OWNER!, completarDocumentoSchema.parse({ purchaseId: (await prisma.purchase.findFirstOrThrow({ where: { tenantId: B.t.id } })).id, docType: 'FACTURA', docSeries: 'F9', docNumber: '9', issueDate: '2026-10-22' })))) === 'NOT_FOUND')
  check('>>> la auditoría muestra los secretos TAPADOS (el token sembrado no sale)', !txtA.includes('NO-DEBE-SALIR') && txtA.includes('«oculto»'))

  console.log('\nE) Acotado por sucursal (una sola sucursal)')
  const soloB1 = (r: Role): TenantContext => ({ ...A.u[r]!, branchIds: [A.b1.branch.id] })
  const o1 = soloB1('OWNER')
  const salidas1 = JSON.stringify({ ...(await salidas(o1)), margen: await informeMargen(db(o1), o1, PC, AHORA), inventario: await informeInventario(db(o1), o1, AHORA), abc: await informeAbc(db(o1), o1, PC, AHORA) })
  check('>>> con la sucursal 1 no aparece NADA de la 2: ni la venta de 3333.33, ni su comprobante, ni su compra (F002-2), ni su serie B002', !salidas1.includes('3333.33') && !salidas1.includes('B002-') && !salidas1.includes('F002-2') && salidas1.includes('1111.11') && salidas1.includes('F001-1'))
  const inv1 = await informeInventario(db(o1), o1, AHORA), invT = await informeInventario(db(A.u.OWNER!), A.u.OWNER!, AHORA)
  check('el inventario de una sucursal vale la mitad del del negocio (mismo stock en las dos)', inv1.datos.almacenes.length === 1 && invT.datos.almacenes.length === 2 && Math.round(inv1.datos.totales.valor * 200) === Math.round(invT.datos.totales.valor * 100))
  check('>>> la auditoría NO se acota por sucursal (el registro no tiene sucursal): es el alcance documentado de dueño y administrador', JSON.stringify(await listarAuditoria(db(o1), o1, PA, AHORA)).includes('cli-A'))

  console.log('\nF) Revisión del código fuente')
  const D = 'src/app/(dashboard)'
  const pagina = (ruta: string) => readFileSync(`${D}/${ruta}/page.tsx`, 'utf8')
  const guardas: [string, string][] = [['reportes/ventas', "puede(ctx, 'reportes.ver')"], ['reportes/rentabilidad', "puede(ctx, 'productos.ver_costo')"], ['reportes/registros', "puede(ctx, 'reportes.ver')"], ['reportes/conciliacion', "puede(ctx, 'reportes.ver')"], ['auditoria', "puede(ctx, 'auditoria.ver')"]]
  check('>>> cada página de la Fase 5 exige sesión, su permiso exacto y da 404 sin él; lee con el cliente aislado; es dinámica', guardas.every(([r, g]) => { const s = pagina(r); return s.includes('await requireTenantContext()') && s.includes(`if (!${g}) notFound()`) && s.includes('getTenantPrisma(ctx)') && s.includes("export const dynamic = 'force-dynamic'") && !/from '@\/lib\/prisma'/.test(s) && !/ctx\.role/.test(s) }))
  check("el centro de reportes exige al menos uno de los dos permisos y enseña cada tarjeta con el suyo", (() => { const s = pagina('reportes'); return s.includes("if (!puedeAlguno(ctx, 'reportes.ver', 'productos.ver_costo')) notFound()") && s.includes("const verVentas = puede(ctx, 'reportes.ver')") && s.includes("const verRentabilidad = puede(ctx, 'productos.ver_costo')") && /\{verRentabilidad && <li>\s*<Link href="\/reportes\/rentabilidad"/.test(s) })())
  const rutas = ['ventas/[tipo]', 'rentabilidad/[tipo]', 'registros/[tipo]', 'conciliacion'].map((r) => readFileSync(`src/app/api/reportes/${r}/route.ts`, 'utf8'))
  check('>>> cada ruta CSV: 401 sin sesión, 403 sin permiso (lo decide el servicio, no la ruta), cabeceras de `respuestaCsv`, dinámica, sin `ctx.role`', rutas.every((s) => s.includes('status: 401') && s.includes("e.code === 'FORBIDDEN_ROLE' ? 403 : 400") && s.includes('respuestaCsv(') && s.includes("export const dynamic = 'force-dynamic'") && !/puede\(|exigir\(|ctx\.role/.test(s)))
  const protegidas = ['/reportes', '/reportes/ventas', '/reportes/rentabilidad', '/reportes/registros', '/reportes/conciliacion', '/auditoria', '/api/reportes/ventas/periodo', '/api/reportes/rentabilidad/margen', '/api/reportes/registros/ventas', '/api/reportes/conciliacion']
  check('>>> todas las rutas de la Fase 5 están protegidas: sin sesión nunca pasan (el proxy las manda al login)', protegidas.every((p) => resolveRouteAccess({ pathname: p, session: null }).kind !== 'allow'))
  check('>>> y con la cuenta suspendida (BLOQUEADA) tampoco pasan', protegidas.filter((p) => !p.startsWith('/api')).every((p) => resolveRouteAccess({ pathname: p, session: { userId: 'u', tenantId: 't', role: 'OWNER', access: 'BLOCKED' } }).kind !== 'allow'))
  const features = ['reportes', 'registros', 'conciliacion', 'auditoria'].flatMap((f) => archivos(`src/features/${f}`))
  check('>>> ningún archivo de reportes, registros, conciliación ni auditoría importa el cliente de Prisma sin aislar (`@/lib/prisma`)', features.every((f) => !/from '@\/lib\/prisma'/.test(readFileSync(f, 'utf8'))), features.filter((f) => /from '@\/lib\/prisma'/.test(readFileSync(f, 'utf8'))).join())
  const SIN_PERMISO_A_PROPOSITO = new Set(['leerVentas', 'leerComprobantes', 'leerCompras', 'calcularConciliacion'])   // núcleos internos: los llaman funciones que SÍ exigen permiso, o el script de solo lectura
  const sinGuarda: string[] = []
  for (const f of features.filter((x) => /(service|ventas-service|rentabilidad-service|registro-service|conciliacion-service)\.ts$/.test(x))) {
    const s = readFileSync(f, 'utf8')
    for (const m of s.matchAll(/export async function (\w+)\(/g)) {
      const i = m.index!, j = s.indexOf('\nexport ', i + 10)
      const cuerpo = s.slice(i, j < 0 ? undefined : j)
      if (SIN_PERMISO_A_PROPOSITO.has(m[1]!)) continue
      if (!/exigir\(|exigirCostos\(|exigirAuditoria\(|exigirRegistros\(|preparar\(|informeVentas|informeCobros|informeMargen|informeInventario|informeAbc|informeRegistro|informeConciliacion/.test(cuerpo)) sinGuarda.push(`${f}:${m[1]}`)
    }
  }
  check('>>> toda función exportada de los servicios de la Fase 5 exige un permiso (o delega en una que lo exige); solo 4 núcleos internos están exentos y nombrados', sinGuarda.length === 0 && SIN_PERMISO_A_PROPOSITO.size === 4, sinGuarda.join(', '))
  const costeadores = features.filter((f) => /costPrice|unitCost/.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')))
  check('>>> el ÚNICO archivo de reportes, registros, conciliación y auditoría que lee costos es `rentabilidad-service.ts`, que exige `productos.ver_costo`', costeadores.length === 1 && costeadores[0]!.endsWith('rentabilidad-service.ts') && /function exigirCostos\(ctx: TenantContext\): void \{ exigir\(ctx, 'productos\.ver_costo'\) \}/.test(readFileSync(costeadores[0]!, 'utf8')), costeadores.join())
  const acciones = readFileSync('src/features/compras/actions.ts', 'utf8')
  check('la acción de completar documento valida con su esquema y no decide permisos (los decide el servicio con `compras.registrar`)', acciones.includes('completarDocumentoSchema.safeParse') && /export async function completarDocumento[\s\S]*?completarDocumento as runCompletar|runCompletar\(db, ctx, p\.data\)/.test(acciones) && /export async function completarDocumento\([\s\S]*?\n\}/.exec(acciones)![0].indexOf('puede(') < 0 && /export async function completarDocumento[\s\S]*?exigir\(ctx, 'compras\.registrar'\)/.test(readFileSync('src/features/compras/service.ts', 'utf8')))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
