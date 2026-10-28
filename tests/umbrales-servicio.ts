import './guard'
import { correr } from './teardown'
import { crearSucursal, crearSucursalConAlmacen, asignarSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { analizarUmbralesCsv, aplicarUmbrales, listarUmbrales, TAMANO_PAGINA_UMBRALES } from '../src/features/inventory/umbrales-service'
import { posicionesDeStock } from '../src/features/inventory/reposicion-service'
import { analyzeImport, commitImport } from '../src/features/inventory/import-service'
import type { CambioUmbralInput } from '../src/features/inventory/umbrales-schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.6b · Mínimos y máximos contra la base: la cuadrícula (listar), la actualización en bloque en los tres niveles (almacén, variante, producto) con su herencia, la atomicidad del
 * lote, los permisos, el alcance por sucursal, la auditoría, la importación de umbrales por CSV y la columna de máximo del importador de catálogo.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '').catch((e) => String(e.message ?? e))

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'premium' } })
  const t = await prisma.tenant.create({ data: { slug: `um-${randomUUID().slice(0, 8)}`, name: 'Umbrales', planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' } })
  const bA = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const bB = await crearSucursal(t.id, { code: 'SUR', name: 'Sur', seriesNumber: 2, isDefault: false, establishmentCode: '0001' })
  const wA = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WA', name: 'Norte', isDefault: true } })
  const wB = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bB.id, code: 'WB', name: 'Sur', isDefault: true } })
  const mk = (role: Role) => prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
  const [owner, adm, alm, cont] = await Promise.all([mk('OWNER'), mk('ADMIN'), mk('ALMACENERO'), mk('CONTADOR')])
  const ctx = (u: { id: string }, role: Role, branchIds: string[], extra: Partial<TenantContext> = {}): TenantContext => ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branchIds[0], branchIds, ...extra })
  const cOwner = ctx(owner, 'OWNER', [bA.id, bB.id])
  const cAdmA = ctx(adm, 'ADMIN', [bA.id])
  const cAlm = ctx(alm, 'ALMACENERO', [bA.id])
  const cAlmCfg = ctx(alm, 'ALMACENERO', [bA.id], { permisosExtra: ['reposicion.configurar'] })
  const cCont = ctx(cont, 'CONTADOR', [bA.id])
  const db = (c: TenantContext) => getTenantPrisma(c)

  const prod = (sku: string, data: Record<string, unknown> = {}) => prisma.product.create({ data: { tenantId: t.id, sku, name: sku, ...data } as never })
  const stock = (productId: string, warehouseId: string, quantity: number, data: Record<string, unknown> = {}) => prisma.stock.create({ data: { tenantId: t.id, productId, warehouseId, quantity, ...data } as never })
  const pA = await prod('PA', { minStock: 10, maxStock: 40 })
  await stock(pA.id, wA.id, 4); await stock(pA.id, wB.id, 4)
  const pV = await prod('PV', { minStock: 20, hasVariants: true })
  const v1 = await prisma.productVariant.create({ data: { tenantId: t.id, productId: pV.id, sku: 'PV-1', name: 'uno', minStock: 0 } })
  await stock(pV.id, wA.id, 8, { variantId: v1.id })
  const pC = await prod('PC', { minStock: 5 })
  await stock(pC.id, wA.id, 1)
  const leer = async (c: TenantContext, productId: string, warehouseId: string, variantId: string | null = null) =>
    (await posicionesDeStock(db(c), c)).find((p) => p.productId === productId && p.warehouseId === warehouseId && p.variantId === variantId)
  const A = (productId: string, warehouseId: string, minimo?: number | null, maximo?: number | null, variantId: string | null = null): CambioUmbralInput => ({ nivel: 'ALMACEN', productId, variantId, warehouseId, minimo, maximo })

  console.log('\n1) Permisos: reposicion.configurar')
  check('>>> el contador (solo reposicion.ver) no puede escribir', await code(aplicarUmbrales(db(cCont), cCont, { cambios: [A(pA.id, wA.id, 3)] })) === 'FORBIDDEN_ROLE')
  check('>>> ni leer la cuadrícula', await code(listarUmbrales(db(cCont), cCont)) === 'FORBIDDEN_ROLE')
  check('>>> el almacenero de fábrica tampoco', await code(aplicarUmbrales(db(cAlm), cAlm, { cambios: [A(pA.id, wA.id, 3)] })) === 'FORBIDDEN_ROLE')
  check('>>> sin permiso NO se escribió nada', (await leer(cOwner, pA.id, wA.id))?.origenMinimo === 'PRODUCTO')
  check('>>> el almacenero con el opcional activado sí puede', await code(aplicarUmbrales(db(cAlmCfg), cAlmCfg, { cambios: [A(pA.id, wA.id, 9)] })) === null)
  check('>>> el administrador sí', await code(aplicarUmbrales(db(cAdmA), cAdmA, { cambios: [A(pA.id, wA.id, 9)] })) === null)

  console.log('\n2) Nivel almacén: override y herencia')
  const r1 = await aplicarUmbrales(db(cOwner), cOwner, { cambios: [A(pA.id, wA.id, 3, 12)] })
  const a1 = await leer(cOwner, pA.id, wA.id), b1 = await leer(cOwner, pA.id, wB.id)
  check('>>> el almacén Norte usa 3 / 12 y lo dice (origen ALMACEN)', a1?.minimo === 3 && a1.maximo === 12 && a1.origenMinimo === 'ALMACEN' && a1.origenMaximo === 'ALMACEN' && r1.aplicados === 1)
  check('>>> el almacén Sur no cambió: sigue heredando 10 / 40 del producto', b1?.minimo === 10 && b1.maximo === 40 && b1.origenMinimo === 'PRODUCTO')
  const r2 = await aplicarUmbrales(db(cOwner), cOwner, { cambios: [A(pA.id, wA.id, 3, 12)] })
  check('>>> repetir el mismo valor no cambia nada (sinCambio)', r2.aplicados === 0 && r2.sinCambio === 1)
  await aplicarUmbrales(db(cOwner), cOwner, { cambios: [A(pA.id, wA.id, undefined, null)] })
  const a2 = await leer(cOwner, pA.id, wA.id)
  check('>>> null en el máximo lo quita (hereda 40) y el mínimo se queda en 3', a2?.minimo === 3 && a2.maximo === 40 && a2.origenMaximo === 'PRODUCTO')
  await aplicarUmbrales(db(cOwner), cOwner, { cambios: [A(pA.id, wA.id, null, null)] })
  const a3 = await leer(cOwner, pA.id, wA.id)
  check('>>> null en ambos devuelve el almacén a heredar todo', a3?.minimo === 10 && a3.maximo === 40 && a3.origenMinimo === 'PRODUCTO')
  await aplicarUmbrales(db(cOwner), cOwner, { cambios: [A(pA.id, wA.id, 0)] })
  check('>>> un 0 explícito en el almacén es «sin umbral aquí» (no hereda)', (await leer(cOwner, pA.id, wA.id))?.minimo === 0)
  await aplicarUmbrales(db(cOwner), cOwner, { cambios: [A(pA.id, wA.id, null, null)] })

  console.log('\n3) Nivel variante y producto')
  await aplicarUmbrales(db(cOwner), cOwner, { cambios: [{ nivel: 'VARIANTE', productId: pV.id, variantId: v1.id, minimo: 6, maximo: 15 }] })
  const v = await leer(cOwner, pV.id, wA.id, v1.id)
  check('>>> la variante con 6 / 15 propios deja de heredar el 20 del producto', v?.minimo === 6 && v.maximo === 15 && v.origenMinimo === 'VARIANTE')
  await aplicarUmbrales(db(cOwner), cOwner, { cambios: [{ nivel: 'VARIANTE', productId: pV.id, variantId: v1.id, minimo: null, maximo: null }] })
  const v0 = await leer(cOwner, pV.id, wA.id, v1.id)
  check('>>> quitar el valor propio de la variante (mínimo → 0) vuelve a heredar del producto', v0?.minimo === 20 && v0.maximo === null && v0.origenMinimo === 'PRODUCTO')
  await aplicarUmbrales(db(cOwner), cOwner, { cambios: [{ nivel: 'PRODUCTO', productId: pC.id, minimo: 7, maximo: 25 }] })
  const c = await leer(cOwner, pC.id, wA.id)
  check('>>> el nivel producto cambia el predeterminado de todos sus almacenes', c?.minimo === 7 && c.maximo === 25 && c.origenMinimo === 'PRODUCTO')
  check('>>> y rige el motor: con 1 de 7, objetivo 25, sugerida 24', c?.sugerida === 24)

  console.log('\n4) Validación y atomicidad')
  check('>>> un máximo menor que el mínimo ACTUAL del mismo nivel se rechaza aunque el cambio solo toque el máximo', /menor que el mínimo/.test(await msg(aplicarUmbrales(db(cOwner), cOwner, { cambios: [{ nivel: 'PRODUCTO', productId: pC.id, maximo: 3 }] }))))
  check('>>> y un mínimo mayor que el máximo actual', /menor que el mínimo/.test(await msg(aplicarUmbrales(db(cOwner), cOwner, { cambios: [{ nivel: 'PRODUCTO', productId: pC.id, minimo: 30 }] }))))
  const antes = await leer(cOwner, pA.id, wA.id)
  const lote = await code(aplicarUmbrales(db(cOwner), cOwner, { cambios: [A(pA.id, wA.id, 2, 8), { nivel: 'PRODUCTO', productId: 'no-existe', minimo: 1 }] }))
  const despues = await leer(cOwner, pA.id, wA.id)
  check('>>> >>> un lote con un cambio inválido NO aplica ninguno (todo o nada)', lote === 'INVALID_DOCUMENT' && despues?.minimo === antes?.minimo && despues?.origenMinimo === antes?.origenMinimo)
  check('>>> el mismo producto dos veces en el lote se rechaza', /dos veces/.test(await msg(aplicarUmbrales(db(cOwner), cOwner, { cambios: [A(pA.id, wA.id, 2), A(pA.id, wA.id, 3)] }))))
  check('>>> sin fila de stock en ese almacén no se crea una: se rechaza', /no tiene existencias/.test(await msg(aplicarUmbrales(db(cOwner), cOwner, { cambios: [A(pC.id, wB.id, 2)] }))) && (await prisma.stock.count({ where: { productId: pC.id, warehouseId: wB.id } })) === 0)
  check('>>> un cambio mal formado (esquema) se rechaza antes de tocar la base', await code(aplicarUmbrales(db(cOwner), cOwner, { cambios: [{ nivel: 'ALMACEN', productId: pA.id, minimo: -1 } as never] })) === 'INVALID_DOCUMENT')
  check('>>> el CHECK de la base respalda al servicio: un máximo bajo el mínimo en la fila de stock no entra ni por la puerta de atrás', await code(prisma.stock.updateMany({ where: { productId: pA.id, warehouseId: wA.id }, data: { minStock: 9, maxStock: 5 } })) !== null)

  console.log('\n5) Alcance por sucursal')
  check('>>> el administrador de Norte no puede tocar el almacén Sur', /no tiene existencias|no es de tus sucursales/.test(await msg(aplicarUmbrales(db(cAdmA), cAdmA, { cambios: [A(pA.id, wB.id, 2)] }))))
  const pagS = await listarUmbrales(db(cAdmA), cAdmA, { warehouseId: wB.id })
  check('>>> y pedir la cuadrícula de Sur le devuelve Norte (su único almacén)', pagS.warehouseId === wA.id && pagS.almacenes.length === 1)

  console.log('\n6) La cuadrícula (listar)')
  const pag = await listarUmbrales(db(cOwner), cOwner, { warehouseId: wA.id })
  const fPA = pag.filas.find((f) => f.productId === pA.id)
  check('>>> lista las filas del almacén con su override y lo que rige', fPA !== undefined && fPA.almacenMin === null && fPA.minimo === 10 && fPA.origenMinimo === 'PRODUCTO' && fPA.maximo === 40)
  check('>>> la variante sale como su propia fila, con nombre y SKU de la variante', pag.filas.some((f) => f.variantId === v1.id && f.nombre === 'PV uno' && f.sku === 'PV-1'))
  check('>>> sin pasarse: solo las filas de ESE almacén', pag.filas.every((f) => f.warehouseId === wA.id))
  const busc = await listarUmbrales(db(cOwner), cOwner, { warehouseId: wA.id, q: 'pc' })
  check('>>> buscar por nombre o SKU filtra (insensible a mayúsculas)', busc.filas.length === 1 && busc.filas[0]!.sku === 'PC' && busc.total === 1)
  for (let i = 0; i < TAMANO_PAGINA_UMBRALES + 5; i++) { const p = await prod(`BULK${String(i).padStart(3, '0')}`); await stock(p.id, wB.id, 1) }
  const p0 = await listarUmbrales(db(cOwner), cOwner, { warehouseId: wB.id, pagina: 0 })
  const p1 = await listarUmbrales(db(cOwner), cOwner, { warehouseId: wB.id, pagina: 1 })
  check('>>> pagina de 100 en 100 sin repetir ni perder filas', p0.filas.length === TAMANO_PAGINA_UMBRALES && p1.filas.length === p0.total - TAMANO_PAGINA_UMBRALES && p0.paginas === 2 && new Set([...p0.filas, ...p1.filas].map((f) => f.productId)).size === p0.total, JSON.stringify([p0.total, p0.filas.length, p1.filas.length]))

  console.log('\n7) Auditoría')
  const aud = await prisma.auditLog.findMany({ where: { tenantId: t.id, action: 'reposicion.umbrales' }, orderBy: { createdAt: 'desc' } })
  check('>>> cada lote que cambió algo dejó UNA fila de auditoría con el antes y el después', aud.length > 0 && aud.every((a) => a.before && a.after && a.actorId))
  const ultimo = aud.find((a) => JSON.stringify(a.after).includes(pC.id))
  check('>>> el antes y el después traen nivel, producto y valores', JSON.stringify(ultimo?.before).includes('"minimo":0') || JSON.stringify(ultimo?.before).includes('"minimo":5'), JSON.stringify(ultimo?.before))
  const nAntes = await prisma.auditLog.count({ where: { tenantId: t.id, action: 'reposicion.umbrales' } })
  await aplicarUmbrales(db(cOwner), cOwner, { cambios: [{ nivel: 'PRODUCTO', productId: pC.id, minimo: 7, maximo: 25 }] })
  check('>>> un lote que no cambió nada no ensucia la auditoría', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'reposicion.umbrales' } })) === nAntes)

  console.log('\n8) Importar umbrales por CSV')
  const csv = (l: string[]) => l.join('\r\n')
  const an = (c: TenantContext, contenido: string) => analizarUmbralesCsv(db(c), c, contenido)
  const ok1 = await an(cOwner, csv(['sku;almacen;minimo;maximo', 'PA;WA;5;20', 'PA;Sur;;30', 'PV-1;;4;9', 'PC;;-;-']))
  check('>>> cuatro filas válidas: almacén por código, almacén por nombre, variante y producto', ok1.resumen.ok === 4 && ok1.resumen.error === 0 && ok1.cambios.length === 4, JSON.stringify(ok1.resumen))
  const niveles = ok1.cambios.map((x) => x.nivel).join(',')
  check('>>> sin almacén escribe el predeterminado (variante o producto); con almacén, el de esa fila', niveles === 'ALMACEN,ALMACEN,VARIANTE,PRODUCTO', niveles)
  check('>>> celda vacía = no tocar (undefined) y «-» = quitar (null)', ok1.cambios[1]!.minimo === undefined && ok1.cambios[1]!.maximo === 30 && ok1.cambios[3]!.minimo === null && ok1.cambios[3]!.maximo === null)
  const malo = await an(cOwner, csv(['sku;almacen;minimo;maximo', 'NOEXISTE;;1;2', 'PA;Marte;1;2', 'PA;WA;abc;2', 'PA;WA;9;3', ';;1;1', 'PA;WA;;', 'PC;WA;1;2']))
  check('>>> cada error se explica por línea y NO se ofrece aplicar nada', malo.resumen.error === 6 && malo.resumen.ok === 1 && malo.cambios.length === 0 && malo.filas.slice(0, 6).every((f) => f.errores.length > 0), JSON.stringify(malo.filas.map((f) => f.errores)))
  check('>>> el CSV rechaza un máximo menor que el mínimo (fila aislada, sin otros errores)', (await an(cOwner, csv(['sku;almacen;minimo;maximo', 'PC;WA;9;3']))).filas[0]!.errores.join('|') === 'El máximo no puede ser menor que el mínimo.')
  check('>>> sin columna de SKU o sin mínimo/máximo se bloquea el archivo', (await an(cOwner, 'nombre;minimo\r\nx;1')).bloqueos.length > 0 && (await an(cOwner, 'sku;almacen\r\nPA;WA')).bloqueos.length > 0)
  check('>>> un SKU repetido para el mismo almacén se marca', (await an(cOwner, csv(['sku;almacen;minimo', 'PA;WA;1', 'PA;WA;2']))).resumen.error === 1)
  check('>>> el mismo SKU en dos almacenes distintos es válido', (await an(cOwner, csv(['sku;almacen;minimo', 'PA;WA;1', 'PA;WB;2']))).resumen.error === 0)
  check('>>> el administrador de Norte no puede nombrar el almacén Sur', (await an(cAdmA, csv(['sku;almacen;minimo', 'PA;WB;1']))).resumen.error === 1)
  check('>>> separador con coma y BOM se entienden', (await an(cOwner, '﻿sku,minimo\r\nPC,4')).resumen.ok === 1)
  check('>>> sin permiso ni se analiza', await code(an(cCont, 'sku;minimo\r\nPC;1')) === 'FORBIDDEN_ROLE')
  const res = await aplicarUmbrales(db(cOwner), cOwner, { cambios: ok1.cambios })
  const aN = await leer(cOwner, pA.id, wA.id), aS = await leer(cOwner, pA.id, wB.id), vN = await leer(cOwner, pV.id, wA.id, v1.id), cN = await leer(cOwner, pC.id, wA.id)
  check('>>> aplicar el análisis deja los valores esperados en los cuatro niveles', res.aplicados === 4 && aN?.minimo === 5 && aN.maximo === 20 && aS?.minimo === 10 && aS.maximo === 30 && vN?.minimo === 4 && vN.maximo === 9 && cN?.minimo === 0 && cN.maximo === null, JSON.stringify([res, aN?.minimo, aN?.maximo, aS?.minimo, aS?.maximo, vN?.minimo, vN?.maximo, cN?.minimo, cN?.maximo]))

  console.log('\n9) Importador de catálogo: columna de máximo')
  const bc = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALMX', seriesNumber: 9, branchCode: 'BX', establishmentCode: '0009' })
  await asignarSucursal(t.id, owner.id, bc.branch.id)
  const cImp = ctx(owner, 'OWNER', [bc.branch.id])
  const dImp = db(cImp)
  const ARCH = ['Nombre;Código de barras;P. Venta;Stock;Mínimo;Máximo', 'Pintura látex;77100000001;48,00;10;4;16', 'Thinner;77100000002;9,00;5;3;']
  const ai = await analyzeImport(dImp, cImp, ARCH.join('\r\n'))
  check('>>> el análisis lee el máximo (y respeta que una celda vacía es «no dice nada»)', ai.filas[0]!.datos.maxStock === 16 && ai.filas[1]!.datos.maxStock === null && ai.columnasDetectadas.includes('maxStock'))
  await commitImport(dImp, cImp, ai, bc.warehouse.id)
  const pl = await prisma.product.findFirstOrThrow({ where: { tenantId: t.id, name: 'Pintura látex' } })
  const th = await prisma.product.findFirstOrThrow({ where: { tenantId: t.id, name: 'Thinner' } })
  check('>>> al crear, el máximo queda en el producto (y sin máximo queda vacío)', Number(pl.maxStock) === 16 && Number(pl.minStock) === 4 && th.maxStock === null)
  const ai2 = await analyzeImport(dImp, cImp, ['Nombre;Código de barras;P. Venta;Máximo', 'Pintura látex;77100000001;48,00;30'].join('\r\n'))
  await commitImport(dImp, cImp, ai2, bc.warehouse.id)
  const pl2 = await prisma.product.findFirstOrThrow({ where: { id: pl.id } })
  check('>>> al actualizar con solo el máximo, el mínimo NO se toca', Number(pl2.maxStock) === 30 && Number(pl2.minStock) === 4)
  const ai2b = await analyzeImport(dImp, cImp, ['Nombre;Código de barras;P. Venta;Mínimo', 'Pintura látex;77100000001;48,00;5'].join('\r\n'))
  await commitImport(dImp, cImp, ai2b, bc.warehouse.id)
  const pl3 = await prisma.product.findFirstOrThrow({ where: { id: pl.id } })
  check('>>> al actualizar SIN la columna de máximo, el máximo que ya tenía NO se borra', Number(pl3.maxStock) === 30 && Number(pl3.minStock) === 5)
  const ai2c = { ...ai2, filas: ai2.filas.map((f) => ({ ...f, datos: { ...f.datos, maxStock: 2, minStock: null } })) }
  check('>>> un análisis forjado con un máximo bajo el mínimo que el producto YA tiene (5) no se confirma', await code(commitImport(dImp, cImp, ai2c, bc.warehouse.id)) === 'INVALID_DOCUMENT')
  const nuevo = (maxStock: number, minStock: number | null) => ({ ...ai2, filas: [{ ...ai2.filas[0]!, estado: 'crear' as const, coincidePor: null, datos: { ...ai2.filas[0]!.datos, name: 'Producto forjado', sku: 'FORJ-1', barcode: '77100000077', maxStock, minStock } }] })
  check('>>> un producto NUEVO forjado con máximo bajo el mínimo no se confirma', await code(commitImport(dImp, cImp, nuevo(1, 5), bc.warehouse.id)) === 'INVALID_DOCUMENT')
  check('>>> ni uno con máximo negativo', await code(commitImport(dImp, cImp, nuevo(-1, null), bc.warehouse.id)) === 'INVALID_DOCUMENT')
  const ai3 = await analyzeImport(dImp, cImp, ['Nombre;Código de barras;P. Venta;Mínimo;Máximo', 'X;77100000009;1,00;10;5'].join('\r\n'))
  check('>>> máximo menor que mínimo en el archivo es un error de fila', ai3.filas[0]!.estado === 'error' && ai3.filas[0]!.errores.some((e) => /máximo/.test(e)))
  const ai4 = await analyzeImport(dImp, cImp, ['Nombre;Código de barras;P. Venta;Máximo', 'Pintura látex;77100000001;48,00;2'].join('\r\n'))
  check('>>> y contra el mínimo que el producto YA tiene (4)', ai4.filas[0]!.estado === 'error' && ai4.filas[0]!.errores.some((e) => /mínimo actual/.test(e)))
  const cSinCfg = ctx(owner, 'OWNER', [bc.branch.id], { permisosDenegados: ['reposicion.configurar'] })
  const ai5 = await analyzeImport(getTenantPrisma(cSinCfg), cSinCfg, ARCH.join('\r\n'))
  check('>>> sin reposicion.configurar un archivo con columna de máximo se bloquea entero', ai5.bloqueos.some((b) => /máximo/.test(b)))
  let forjado = ''
  try { await commitImport(getTenantPrisma(cSinCfg), cSinCfg, ai, bc.warehouse.id) } catch (e) { forjado = (e as { code?: string }).code ?? '' }
  check('>>> y un análisis forjado en el cliente tampoco se confirma sin ese permiso', forjado === 'FORBIDDEN_ROLE', forjado)
  const forjado2 = { ...ai, filas: ai.filas.map((f) => ({ ...f, datos: { ...f.datos, maxStock: 1, minStock: 5 } })) }
  check('>>> ni uno con máximo por debajo del mínimo', await code(commitImport(dImp, cImp, forjado2, bc.warehouse.id)) === 'INVALID_DOCUMENT')

  await prisma.tenant.delete({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
