import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { crearSucursalConAlmacen } from './fixtures'

/**
 * Esquema de las notas de crédito y débito (migración 20261104120000_init_notas_credito_debito).
 * Lo que se prueba es lo que garantiza LA BASE, no el código: son las últimas líneas de defensa.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
/** Código del error de la base, o null si la operación se permitió. */
const falla = (p: Promise<unknown>) => p.then(() => null).catch((e) => { const txt = JSON.stringify({ c: e.code, m: String(e.message), meta: e.meta, cause: String(e.cause?.message ?? ''), d: String(e.meta?.driverAdapterError?.cause?.kind ?? '') }); return e.code === 'P2002' ? 'P2002' : e.code === 'P2003' ? 'P2003' : /check|chk|23514/i.test(txt) ? 'CHECK' : String(e.code ?? e.name) })

async function mk(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: { slug: `nc-${tag}-${randomUUID().slice(0, 6)}`, name: `Notas ${tag}`, taxId, planId: plan.id } })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER' } })
  let n = 0
  const venta = async () => (await prisma.sale.create({ data: { tenantId: t.id, branchId: branch.id, warehouseId: w.id, userId: u.id, number: `V-${tag}-${randomUUID().slice(0, 6)}`, status: 'COMPLETADA' } })).id
  const base = (saleId: string, over: Record<string, unknown> = {}) => ({
    tenantId: t.id, saleId, documentType: 'FACTURA' as const, series: 'F001', correlativo: ++n, fullNumber: `F001-${String(n).padStart(8, '0')}`,
    subtotal: 10, taxTotal: 1.8, total: 11.8, ...over,
  })
  return { t, venta, base }
}

async function main() {
  const A = await mk('a'); const B = await mk('b')
  const vA = await A.venta()
  const factura = await prisma.taxDocument.create({ data: A.base(vA) })
  const nota = (over: Record<string, unknown> = {}) => ({
    ...A.base(vA, { documentType: 'NOTA_CREDITO', series: 'FC01' }),
    relatedDocumentId: factura.id, reasonCode: '01', reasonDescription: 'Anulación de la operación', ...over,
  })

  console.log('\n1) Un comprobante de venta por venta; las notas no cuentan')
  check('>>> una segunda factura o boleta para la MISMA venta se rechaza (índice único parcial)',
    (await falla(prisma.taxDocument.create({ data: A.base(vA, { documentType: 'BOLETA', series: 'B001' }) }))) === 'P2002')
  const n1 = await prisma.taxDocument.create({ data: nota() })
  check('>>> una nota de crédito sobre la misma venta SÍ se permite', !!n1.id)
  check('...y otra nota de débito también (una venta puede acumular notas)', !(await falla(prisma.taxDocument.create({ data: nota({ documentType: 'NOTA_DEBITO', series: 'FD01', correlativo: 1, fullNumber: 'FD01-00000001', reasonCode: '02', reasonDescription: 'Aumento en el valor' }) }))))
  check('la nota apunta a su comprobante y éste ve sus notas', (await prisma.taxDocument.findUniqueOrThrow({ where: { id: factura.id }, include: { notes: true } })).notes.length === 2)

  console.log('\n2) Los campos de la nota son obligatorios (CHECK) y los de un comprobante, vacíos')
  check('>>> una nota SIN comprobante relacionado se rechaza', (await falla(prisma.taxDocument.create({ data: nota({ relatedDocumentId: null, correlativo: 50, fullNumber: 'FC01-00000050' }) }))) === 'CHECK')
  { const r = await falla(prisma.taxDocument.create({ data: nota({ reasonCode: null, correlativo: 51, fullNumber: 'FC01-00000051' }) })); check('>>> una nota SIN código de motivo se rechaza', r === 'CHECK', String(r)) }
  check('el código debe ser de dos dígitos', (await Promise.all(['1', 'AB', '001', ' 1'].map((c, i) => falla(prisma.taxDocument.create({ data: nota({ reasonCode: c, correlativo: 60 + i, fullNumber: `FC01-0000006${i}` }) }))))).every((x) => x === 'CHECK'))
  check('>>> y el sustento no puede estar vacío ni ser solo espacios', (await Promise.all([null, '', '   '].map((d, i) => falla(prisma.taxDocument.create({ data: nota({ reasonDescription: d, correlativo: 70 + i, fullNumber: `FC01-0000007${i}` }) }))))).every((x) => x === 'CHECK'))
  check('>>> una factura o boleta con comprobante relacionado o motivo se rechaza',
    (await falla(prisma.taxDocument.create({ data: A.base(await A.venta(), { relatedDocumentId: factura.id }) }))) === 'CHECK' &&
    (await falla(prisma.taxDocument.create({ data: A.base(await A.venta(), { reasonCode: '01' }) }))) === 'CHECK')
  check('>>> una nota no puede relacionarse consigo misma', (await falla(prisma.$executeRawUnsafe(`UPDATE tax_documents SET "relatedDocumentId" = id WHERE id = '${n1.id}'`))) !== null)

  console.log('\n3) El comprobante relacionado es del MISMO negocio')
  const vB = await B.venta()
  const facturaB = await prisma.taxDocument.create({ data: B.base(vB) })
  check('>>> una nota de A relacionada con un comprobante de B se rechaza (clave foránea compuesta)',
    (await falla(prisma.taxDocument.create({ data: nota({ relatedDocumentId: facturaB.id, correlativo: 80, fullNumber: 'FC01-00000080' }) }))) === 'P2003')
  check('y la de B con su propio comprobante sí', !(await falla(prisma.taxDocument.create({ data: { ...B.base(vB, { documentType: 'NOTA_CREDITO', series: 'FC01' }), relatedDocumentId: facturaB.id, reasonCode: '01', reasonDescription: 'x' } }))))

  console.log('\n4) Numeración y borrado')
  check('>>> la clave fiscal (negocio, tipo, serie, correlativo) sigue siendo única para las notas',
    (await falla(prisma.taxDocument.create({ data: nota({ correlativo: n1.correlativo, fullNumber: n1.fullNumber }) }))) === 'P2002')
  check('el mismo número en OTRO tipo de documento sí se permite', !(await falla(prisma.taxDocument.create({ data: nota({ documentType: 'NOTA_DEBITO', series: 'FC01', correlativo: n1.correlativo, fullNumber: n1.fullNumber, reasonCode: '02', reasonDescription: 'x' }) }))))
  check('>>> no se puede borrar un comprobante que tiene notas (Restrict)', (await falla(prisma.taxDocument.delete({ where: { id: factura.id } }))) === 'P2003')

  console.log('\n5) Aislamiento entre negocios')
  const dbA = getTenantPrisma({ tenantId: A.t.id, userId: 'x', role: 'OWNER', access: 'FULL' })
  const dbB = getTenantPrisma({ tenantId: B.t.id, userId: 'x', role: 'OWNER', access: 'FULL' })
  check('cada negocio ve solo sus notas', (await dbA.taxDocument.count({ where: { documentType: 'NOTA_CREDITO' } })) === 1 && (await dbB.taxDocument.count({ where: { documentType: 'NOTA_CREDITO' } })) === 1)

  console.log('\n6) La migración')
  const dir = readdirSync('prisma/migrations').filter((d) => d.endsWith('init_notas_credito_debito'))[0]!
  const sql = readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8')
  const todas = readdirSync('prisma/migrations').filter((d) => /^\d{14}_/.test(d)).sort()
  // Las migraciones posteriores (p. ej. el índice de una nota total) la superan: lo que importa es que sea MAYOR que la anterior y no se repitan marcas.
  const previa = todas[todas.indexOf(dir) - 1]!
  check('>>> su marca es MAYOR que la de la migración anterior y las marcas no se repiten (el orden no retrocede)', dir.slice(0, 14) > previa.slice(0, 14) && todas.length === new Set(todas.map((d) => d.slice(0, 14))).size, `${previa} < ${dir}`)
  check('lleva el índice único parcial y el CHECK a mano', /CREATE UNIQUE INDEX "tax_documents_un_comprobante_por_venta"[\s\S]*WHERE "documentType" IN \('BOLETA', 'FACTURA'\)/.test(sql) && sql.includes('tax_documents_nota_campos_chk'))
  check('>>> no usa NOTA_CREDITO/NOTA_DEBITO dentro de un CHECK o índice (un valor de enum nuevo no se puede usar en la misma transacción)', !/(CHECK|WHERE)[\s\S]*NOTA_(CREDITO|DEBITO)/.test(sql.replace(/ALTER TYPE[^;]*;/g, '')))
  check('trae down.sql que se niega a borrar notas emitidas', existsSync(`prisma/migrations/${dir}/down.sql`) && readFileSync(`prisma/migrations/${dir}/down.sql`, 'utf8').includes('RAISE EXCEPTION'))
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  const modelo = schema.slice(schema.indexOf('model TaxDocument {'), schema.indexOf('@@map("tax_documents")'))
  check('>>> el esquema ya no declara @@unique([tenantId, saleId])', !/@@unique\(\[tenantId, saleId\]\)/.test(modelo))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
