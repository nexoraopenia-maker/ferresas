import './guard'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { analyzeImport, commitImport } from '../src/features/inventory/import-service'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const M = randomUUID().slice(0, 6)

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'premium' } })
  const t = await prisma.tenant.create({
    data: { slug: `imp-${M}`, name: `Ferre Import ${M}`, planId: plan.id },
  })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' } })
  const owner = await prisma.user.create({
    data: { email: `o-${M}@x.com`, name: 'Dueño', role: 'OWNER', tenantId: t.id },
  })
  const w = await prisma.warehouse.create({
    data: { tenantId: t.id, code: 'PRIN', name: 'Principal', isDefault: true },
  })
  const ctx: TenantContext = { tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL' }
  const db = getTenantPrisma(ctx)

  const ARCHIVO = [
    'Nombre;Código de barras;Unidad;P. Venta;Costo;Stock;Mínimo',
    `"Cemento Sol 42.5 kg";771${M}001;bls;32,50;28,00;120;20`,
    '"Clavo 3"" a granel";;kg;8,50;6,20;45,5;5',
    '"Cable THW 14 AWG";;m;4,20;3,10;200;25',
    `"Tubo PVC 1/2"" x 3m";771${M}002;und;11,80;9,00;60;10`,
  ].join('\r\n')

  console.log('\n1) Análisis: NO escribe nada')
  const a1 = await analyzeImport(db, ctx, ARCHIVO)
  check('detecta el separador de Excel español', a1.delimitador === ';')
  check('4 filas analizadas', a1.resumen.total === 4, String(a1.resumen.total))
  check('las 4 son nuevas', a1.resumen.crear === 4 && a1.resumen.error === 0)
  check('>>> la base sigue VACÍA tras analizar',
    (await db.product.count()) === 0, String(await db.product.count()))
  check('reconoce todas las columnas', a1.columnasIgnoradas.length === 0)
  check('precio con coma decimal interpretado',
    a1.filas[0]?.datos.salePrice === 32.5, String(a1.filas[0]?.datos.salePrice))
  check('stock fraccionado del granel',
    a1.filas[1]?.datos.stock === 45.5, String(a1.filas[1]?.datos.stock))
  check('unidad a granel normalizada', a1.filas[1]?.datos.unitType === 'KILOGRAMO')
  check('«bls» -> BOLSA', a1.filas[0]?.datos.unitType === 'BOLSA')
  check('comillas escapadas en el nombre',
    a1.filas[1]?.datos.name === 'Clavo 3" a granel', a1.filas[1]?.datos.name)

  console.log('\n2) Confirmación')
  const r1 = await commitImport(db, ctx, a1, w.id)
  check('crea los 4 productos', r1.creados === 4, String(r1.creados))
  check('ninguna actualización', r1.actualizados === 0)
  check('están en la base', (await db.product.count()) === 4)

  const cemento = await db.product.findFirstOrThrow({
    where: { barcode: `771${M}001` },
    include: { stocks: true },
  })
  check('el código de barras se guardó', cemento.barcode === `771${M}001`)
  check('el precio se guardó', cemento.salePrice.toNumber() === 32.5)
  check('el stock inicial entró', cemento.stocks[0]?.quantity.toNumber() === 120)
  const mov = await db.stockMovement.findFirst({
    where: { productId: cemento.id, type: 'INICIAL' },
  })
  check('>>> el stock entró por el LEDGER (movimiento INICIAL)', mov !== null)
  check('con origen IMPORTACION', mov?.source === 'IMPORTACION')
  const suma = await db.stockMovement.aggregate({
    where: { productId: cemento.id }, _sum: { quantity: true },
  })
  check('SUM(ledger) cuadra con Stock.quantity', Number(suma._sum.quantity) === 120)
  check('queda auditado',
    (await db.auditLog.count({ where: { action: 'catalog.import' } })) === 1)

  console.log('\n3) IDEMPOTENCIA: reimportar el MISMO archivo')
  const a2 = await analyzeImport(db, ctx, ARCHIVO)
  check('ahora las 4 son actualizaciones', a2.resumen.actualizar === 4 && a2.resumen.crear === 0)
  check('empareja por código de barras donde lo hay',
    a2.filas[0]?.coincidePor === 'barcode')
  check('>>> y por SKU derivado del nombre donde NO hay código de barras',
    a2.filas[1]?.coincidePor === 'sku', String(a2.filas[1]?.coincidePor))
  check('el SKU generado es estable entre importaciones',
    /^IMP-[0-9A-F]{8}$/.test(
      (await db.product.findFirstOrThrow({ where: { name: 'Clavo 3\" a granel' } })).sku,
    ))
  const r2 = await commitImport(db, ctx, a2, w.id)
  check('>>> NO duplica: sigue habiendo 4 productos', (await db.product.count()) === 4)
  check('las cuenta como actualizadas', r2.actualizados === 4 && r2.creados === 0)

  console.log('\n4) LO CRÍTICO: reimportar NO pisa el stock')
  // Simula tres semanas de ventas tras la primera importación.
  await prisma.stock.updateMany({
    where: { productId: cemento.id }, data: { quantity: 37 },
  })
  const a3 = await analyzeImport(db, ctx, ARCHIVO)  // el archivo sigue diciendo 120
  check('el análisis avisa de que ignorará el stock',
    a3.filas[0]?.avisos.some((x) => /stock del archivo se ignora/.test(x)) === true,
    JSON.stringify(a3.filas[0]?.avisos))
  await commitImport(db, ctx, a3, w.id)
  const trasReimport = await db.stock.findFirstOrThrow({ where: { productId: cemento.id } })
  check('>>> el stock sigue en 37, NO volvió a 120',
    trasReimport.quantity.toNumber() === 37, String(trasReimport.quantity))

  console.log('\n5) Un archivo con los errores de la vida real')
  const SUCIO = [
    'nombre;precio;stock;unidad',
    'Martillo;25,00;10;und',
    ';15,00;5;und',                    // sin nombre
    'Sierra;;8;und',                   // sin precio
    'Alicate;gratis;3;und',            // precio no numérico
    'Llave;18,50;-5;cajitas',          // stock negativo + unidad inventada
    'Martillo;30,00;2;und',            // nombre repetido pero SKU distinto (se permite)
  ].join('\n')
  const a4 = await analyzeImport(db, ctx, SUCIO)
  check('detecta 3 filas con error', a4.resumen.error === 3, String(a4.resumen.error))
  check('fila sin nombre señalada',
    a4.filas[1]?.errores.some((e) => /nombre/.test(e)) === true)
  check('fila sin precio señalada',
    a4.filas[2]?.errores.some((e) => /precio/.test(e)) === true)
  check('precio «gratis» señalado',
    a4.filas[3]?.errores.some((e) => /no es un número/.test(e)) === true)
  check('stock negativo se avisa y se deja en 0',
    a4.filas[4]?.datos.stock === 0 &&
    a4.filas[4]?.avisos.some((x) => /negativo/.test(x)) === true)
  check('unidad inventada se avisa y cae a UNIDAD',
    a4.filas[4]?.datos.unitType === 'UNIDAD' &&
    a4.filas[4]?.avisos.some((x) => /No se reconoce la unidad/.test(x)) === true)
  check('el número de línea apunta al Excel (cabecera = 1)',
    a4.filas[1]?.linea === 3, String(a4.filas[1]?.linea))

  const antesSucio = await db.product.count()
  const r4 = await commitImport(db, ctx, a4, w.id)
  check('>>> solo importa las filas buenas', r4.omitidos === 3)
  check('las malas NO crearon nada',
    (await db.product.count()) === antesSucio + r4.creados)

  console.log('\n6) Duplicados DENTRO del archivo')
  const DUP = [
    'nombre;codigo de barras;precio',
    `Taladro;888${M}999;100,00`,
    `Taladro otra vez;888${M}999;120,00`,
  ].join('\n')
  const a5 = await analyzeImport(db, ctx, DUP)
  check('la segunda fila con el mismo código se marca error',
    a5.filas[1]?.errores.some((e) => /repetido/.test(e)) === true,
    JSON.stringify(a5.filas[1]?.errores))
  check('el mensaje dice en qué línea estaba la primera',
    /línea 2/.test(a5.filas[1]?.errores.join(' ') ?? ''))

  console.log('\n7) Archivo mal formado')
  const a6 = await analyzeImport(db, ctx, 'proveedor;ubicacion\nACME;Pasillo 3')
  check('sin columna de nombre, se BLOQUEA', a6.bloqueos.length > 0)
  check('el mensaje dice qué columna falta',
    a6.bloqueos.some((b) => /nombre/.test(b)))
  check('no se puede confirmar un análisis bloqueado',
    await commitImport(db, ctx, a6, w.id).then(() => null).catch((e) => e.code) === 'INVALID_DOCUMENT')
  const a7 = await analyzeImport(db, ctx, 'nombre;precio')
  check('archivo sin filas de datos se bloquea', a7.bloqueos.length > 0)

  console.log('\n8) Límite de plan')
  await prisma.plan.update({ where: { code: 'premium' }, data: { maxProducts: 5 } })
  const a8 = await analyzeImport(db, ctx, ARCHIVO.replace(new RegExp(M, 'g'), 'ZZZ'))
  check('informa del límite', a8.limitePlan.maxProducts === 5)
  check('>>> bloquea si el archivo excedería el plan', a8.limitePlan.excede === true)
  check('el mensaje dice cuántos tiene y cuántos crearía',
    a8.bloqueos.some((b) => /permite 5 productos/.test(b)), a8.bloqueos.join(' | '))
  await prisma.plan.update({ where: { code: 'premium' }, data: { maxProducts: null } })

  console.log('\n9) Permisos y suscripción')
  const vend: TenantContext = { ...ctx, role: 'VENDEDOR' }
  check('un VENDEDOR no puede importar',
    await analyzeImport(getTenantPrisma(vend), vend, ARCHIVO)
      .then(() => null).catch((e) => e.code) === 'FORBIDDEN_ROLE')
  const ro: TenantContext = { ...ctx, access: 'READ_ONLY' }
  check('analizar con suscripción vencida SÍ funciona (es solo lectura)',
    await analyzeImport(getTenantPrisma(ro), ro, ARCHIVO).then(() => true).catch(() => false))
  check('pero confirmar NO',
    await commitImport(getTenantPrisma(ro), ro, a1, w.id)
      .then(() => null).catch((e) => e.code) === 'SUBSCRIPTION_READ_ONLY')

  console.log('\n10) Aislamiento')
  const otro = await prisma.tenant.create({ data: { slug: `imp2-${M}`, name: 'Otro', planId: plan.id } })
  const ou = await prisma.user.create({
    data: { email: `ou-${M}@x.com`, name: 'O', role: 'OWNER', tenantId: otro.id },
  })
  const dbOtro = getTenantPrisma({ tenantId: otro.id, userId: ou.id, role: 'OWNER', access: 'FULL' })
  const aOtro = await dbOtro && await analyzeImport(dbOtro, { tenantId: otro.id, userId: ou.id, role: 'OWNER', access: 'FULL' }, ARCHIVO)
  check('>>> para otro tenant son productos NUEVOS, no actualizaciones',
    aOtro.resumen.crear === 4 && aOtro.resumen.actualizar === 0,
    `crear=${aOtro.resumen.crear} act=${aOtro.resumen.actualizar}`)

  console.log('\n11) Limpieza')
  await prisma.tenant.delete({ where: { id: otro.id } })
  await prisma.tenant.delete({ where: { id: t.id } })
  check('datos de prueba eliminados', (await prisma.tenant.count({ where: { id: t.id } })) === 0)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
