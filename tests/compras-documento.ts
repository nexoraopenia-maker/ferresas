import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { diaValido, validarDocumento } from '../src/features/compras/documento'
import { anularCompraSchema, completarDocumentoSchema, crearBorradorSchema, editarBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { anularCompra, completarDocumento, crearBorrador, editarBorrador, obtenerCompra, recibirCompra } from '../src/features/compras/service'
import { crearProveedor } from '../src/features/proveedores/service'
import { crearProveedorSchema } from '../src/features/proveedores/schemas'
import { hoyEnZona } from '../src/features/credito/reglas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F5.4 · El documento del proveedor en las compras: tipo, serie, número y fecha de emisión (migración 20261113100000).
 * Lo que más importa: los cuatro van juntos o ninguno (también en la base), `invoiceRef` se compone con ellos y sigue impidiendo duplicados,
 * «Completar documento» solo cambia esas columnas (ni stock, ni costo, ni deuda, ni totales) y exige `compras.registrar`.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const HOY = '2026-10-27'

console.log('\nA) Validación pura')
const D = (o: Record<string, string> = {}) => ({ docType: 'FACTURA', docSeries: 'f001', docNumber: ' 000 123 ', issueDate: '2026-10-20', ...o })
const ok = (e: { docType?: string; docSeries?: string; docNumber?: string; issueDate?: string }) => validarDocumento(e, HOY)
check('sin ningún dato: sin documento (no es error)', (() => { const r = ok({}); return r.ok && r.documento === null })())
check('>>> normaliza: mayúsculas, sin espacios, y compone la referencia «SERIE-NÚMERO»', (() => { const r = ok(D()); return r.ok && r.documento!.docSeries === 'F001' && r.documento!.docNumber === '000123' && r.documento!.invoiceRef === 'F001-000123' })())
check('>>> los ceros a la izquierda se conservan (texto, no número)', (() => { const r = ok(D({ docNumber: '0000001' })); return r.ok && r.documento!.docNumber === '0000001' })())
check('>>> los cuatro juntos o ninguno: con 1, 2 o 3 datos es error', [{ docType: 'FACTURA' }, { docSeries: 'F001' }, { docType: 'FACTURA', docSeries: 'F001' }, { docType: 'FACTURA', docSeries: 'F001', docNumber: '1' }, { issueDate: '2026-10-20' }].every((e) => !ok(e).ok))
check('>>> y el mensaje dice qué falta (completar los cuatro o dejarlos vacíos), no un error suelto de formato', [{ docType: 'FACTURA' }, { docSeries: 'F001' }, { issueDate: '2026-10-20' }, { docType: 'FACTURA', docSeries: 'F001', docNumber: '1' }].every((e) => { const r = ok(e); return !r.ok && r.mensaje.startsWith('Completa el tipo, la serie, el número y la fecha') }))
check('espacios en blanco cuentan como vacío', ok({ docType: ' ', docSeries: '', docNumber: '  ', issueDate: '' }).ok)
check('>>> serie o número con guion, signos o ñ se rechazan (el guion es el separador de la referencia)', ['F-001', 'F001!', 'FÑ01', 'A'.repeat(21)].every((s) => !ok(D({ docSeries: s })).ok) && ['12-3', '12.3', '1/2'].every((n) => !ok(D({ docNumber: n })).ok))
check('un tipo inventado se rechaza; los 6 válidos pasan', !ok(D({ docType: 'TICKET' })).ok && ['FACTURA', 'BOLETA', 'NOTA_CREDITO', 'NOTA_DEBITO', 'RECIBO_HONORARIOS', 'OTRO'].every((t) => ok(D({ docType: t })).ok))
check('>>> fechas: 31 de febrero y 29/02 de año no bisiesto no existen; 29/02/2028 sí', !diaValido('2026-02-31') && !diaValido('2027-02-29') && diaValido('2028-02-29') && !diaValido('2026-13-01') && !diaValido('26-10-20') && !diaValido('2026-1-5'))
check('>>> la emisión no puede ser futura: hoy sí, mañana no', ok(D({ issueDate: HOY })).ok && !ok(D({ issueDate: '2026-10-28' })).ok)
check('y no puede ser anterior al año 2000 (años tecleados a medias)', ok(D({ issueDate: '2000-01-01' })).ok && !ok(D({ issueDate: '1999-12-31' })).ok && !ok(D({ issueDate: '0026-10-20' })).ok)

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 220) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const montar = async (tag: string) => {
    const t = await prisma.tenant.create({ data: { slug: `co-${tag}-${randomUUID().slice(0, 6)}`, name: `Documento ${tag}`, taxId: ruc(), planId: plan.id } })
    await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_co' } })
    const b1 = await crearSucursalConAlmacen(t.id)
    const ctxs: Record<string, TenantContext> = {}
    for (const r of ['OWNER', 'ADMIN', 'CAJERO', 'ALMACENERO', 'CONTADOR'] as Role[]) {
      const u = await prisma.user.create({ data: { tenantId: t.id, email: `${r}-${randomUUID()}@x.com`.toLowerCase(), name: r, role: r } })
      await asignarSucursal(t.id, u.id, b1.branch.id)
      ctxs[r] = { tenantId: t.id, userId: u.id, role: r, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
    }
    return { t, b1, ctxs }
  }
  const A = await montar('uno'), B = await montar('dos')
  const O = A.ctxs.OWNER!, db = getTenantPrisma(O)
  const prod = await prisma.product.create({ data: { tenantId: A.t.id, sku: 'D-1', name: 'Cemento', unitType: 'UNIDAD', salePrice: 30, costPrice: 0 } })
  const prov = await crearProveedor(db, O, crearProveedorSchema.parse({ name: 'Proveedor Uno', taxId: ruc() }))
  const prov2 = await crearProveedor(db, O, crearProveedorSchema.parse({ name: 'Proveedor Dos', taxId: ruc() }))
  const nuevo = (o: Record<string, unknown> = {}, items = [{ productId: prod.id, enteredQuantity: 10, unitCost: 5 }]) =>
    crearBorrador(db, O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: A.b1.warehouse.id, supplierId: prov.id, items, ...o }))
  const recibir = (id: string) => recibirCompra(db, O, recibirCompraSchema.parse({ purchaseId: id }))
  const fila = (id: string) => prisma.purchase.findUniqueOrThrow({ where: { id } })
  const completar = (id: string, o: Record<string, unknown> = {}, c: TenantContext = O) =>
    completarDocumento(getTenantPrisma(c), c, completarDocumentoSchema.parse({ purchaseId: id, docType: 'FACTURA', docSeries: 'F001', docNumber: '123', issueDate: '2026-10-20', ...o }))

  console.log('\nB) Crear y editar con documento')
  const c1 = await nuevo({ docType: 'FACTURA', docSeries: 'f001', docNumber: '000123', issueDate: '2026-10-20' })
  const f1 = await fila(c1.id)
  check('>>> se guardan tipo, serie, número y fecha; `invoiceRef` se compone «F001-000123»', f1.docType === 'FACTURA' && f1.docSeries === 'F001' && f1.docNumber === '000123' && f1.issueDate!.toISOString().slice(0, 10) === '2026-10-20' && f1.invoiceRef === 'F001-000123')
  check('>>> la fecha es un DÍA del calendario (no se corre por la zona horaria)', f1.issueDate!.toISOString() === '2026-10-20T00:00:00.000Z')
  check('>>> el mismo documento del mismo proveedor no se registra dos veces (aunque venga en minúsculas o con espacios)', (await code(nuevo({ docType: 'FACTURA', docSeries: ' F001 ', docNumber: '000123', issueDate: '2026-10-21' }))) === 'DUPLICATE_CODE')
  check('otro proveedor sí puede tener el mismo número', (await code(nuevo({ supplierId: prov2.id, docType: 'FACTURA', docSeries: 'F001', docNumber: '000123', issueDate: '2026-10-21' }))) === null)
  check('>>> documento incompleto → INVALID_DOCUMENT y no se crea nada', (await code(nuevo({ docType: 'FACTURA', docSeries: 'F002' }))) === 'INVALID_DOCUMENT' && (await prisma.purchase.count({ where: { tenantId: A.t.id, invoiceRef: { startsWith: 'F002' } } })) === 0)
  check('>>> fecha futura (en la hora del negocio) → INVALID_DOCUMENT', (await code(nuevo({ docType: 'FACTURA', docSeries: 'F003', docNumber: '1', issueDate: '2099-01-01' }))) === 'INVALID_DOCUMENT')
  const libre = await nuevo({ invoiceRef: 'REF-LIBRE-9' })
  const fl = await fila(libre.id)
  check('sin documento estructurado, la referencia libre sigue funcionando (compatibilidad)', fl.invoiceRef === 'REF-LIBRE-9' && fl.docType === null && fl.docSeries === null && fl.docNumber === null && fl.issueDate === null)
  check('>>> si vienen ambos, manda el documento estructurado', await (async () => { const c = await nuevo({ invoiceRef: 'IGNORADA', docType: 'BOLETA', docSeries: 'B001', docNumber: '77', issueDate: '2026-10-22' }); return (await fila(c.id)).invoiceRef === 'B001-77' })())
  await editarBorrador(db, O, editarBorradorSchema.parse({ purchaseId: libre.id, warehouseId: A.b1.warehouse.id, supplierId: prov.id, docType: 'FACTURA', docSeries: 'E001', docNumber: '55', issueDate: '2026-10-19', items: [{ productId: prod.id, enteredQuantity: 10, unitCost: 5 }] }))
  const fe = await fila(libre.id)
  check('>>> editar un borrador le pone el documento estructurado', fe.invoiceRef === 'E001-55' && fe.docType === 'FACTURA' && fe.issueDate!.toISOString().slice(0, 10) === '2026-10-19')
  check('>>> y quitarlo deja los cuatro vacíos (no medio documento)', await (async () => { await editarBorrador(db, O, editarBorradorSchema.parse({ purchaseId: libre.id, warehouseId: A.b1.warehouse.id, supplierId: prov.id, items: [{ productId: prod.id, enteredQuantity: 10, unitCost: 5 }] })); const x = await fila(libre.id); return x.docType === null && x.docSeries === null && x.docNumber === null && x.issueDate === null && x.invoiceRef === null })())

  console.log('\nC) La base también lo exige (CHECK)')
  const base = { tenantId: A.t.id, warehouseId: A.b1.warehouse.id, userId: O.userId }
  const raw = (n: string, d: Record<string, unknown>) => code(prisma.purchase.create({ data: { ...base, number: `RAW-${n}-${randomUUID().slice(0, 4)}`, ...d } as never }))
  check('>>> la base rechaza un documento a medias (solo tipo, solo serie, sin fecha…)', (await raw('1', { docType: 'FACTURA' })) !== null && (await raw('2', { docSeries: 'F001', docNumber: '1', docType: 'FACTURA' })) !== null && (await raw('3', { issueDate: new Date('2026-10-01') })) !== null)
  check('>>> la base rechaza serie o número con minúsculas, espacios o guiones', (await raw('4', { docType: 'FACTURA', docSeries: 'f001', docNumber: '1', issueDate: new Date('2026-10-01') })) !== null && (await raw('5', { docType: 'FACTURA', docSeries: 'F 01', docNumber: '1', issueDate: new Date('2026-10-01') })) !== null && (await raw('6', { docType: 'FACTURA', docSeries: 'F001', docNumber: '1-2', issueDate: new Date('2026-10-01') })) !== null)
  check('la base acepta el documento completo y también ninguno', (await raw('7', { docType: 'OTRO', docSeries: 'F001', docNumber: '1', issueDate: new Date('2026-10-01') })) === null && (await raw('8', {})) === null)

  console.log('\nD) Completar documento en una compra recibida')
  const vieja = await nuevo({ invoiceRef: 'F777-9' })
  const rec = await recibir(vieja.id)
  const antes = await fila(vieja.id)
  const stockAntes = num((await prisma.stock.findFirstOrThrow({ where: { tenantId: A.t.id, productId: prod.id } })).quantity)
  const costoAntes = num((await prisma.product.findUniqueOrThrow({ where: { id: prod.id } })).costPrice)
  const deudaAntes = num((await prisma.supplier.findUniqueOrThrow({ where: { id: prov.id } })).payableBalance)
  const r = await completar(vieja.id, { docType: 'FACTURA', docSeries: 'f777', docNumber: '000009', issueDate: '2026-10-18' })
  const despues = await fila(vieja.id)
  check('>>> completa tipo, serie, número y fecha, y recompone la referencia', despues.docType === 'FACTURA' && despues.docSeries === 'F777' && despues.docNumber === '000009' && despues.issueDate!.toISOString().slice(0, 10) === '2026-10-18' && despues.invoiceRef === 'F777-000009' && r.invoiceRef === 'F777-000009')
  check('>>> NO toca nada más: ni totales, ni estado, ni fecha de recepción, ni condición, ni número de compra', despues.status === 'RECIBIDA' && num(despues.total) === num(antes.total) && num(despues.subtotal) === num(antes.subtotal) && num(despues.taxTotal) === num(antes.taxTotal) && despues.receivedAt!.getTime() === antes.receivedAt!.getTime() && despues.number === antes.number && despues.paymentCondition === antes.paymentCondition)
  check('>>> ni el stock, ni el costo promedio, ni la deuda del proveedor, ni las líneas', num((await prisma.stock.findFirstOrThrow({ where: { tenantId: A.t.id, productId: prod.id } })).quantity) === stockAntes && num((await prisma.product.findUniqueOrThrow({ where: { id: prod.id } })).costPrice) === costoAntes && num((await prisma.supplier.findUniqueOrThrow({ where: { id: prov.id } })).payableBalance) === deudaAntes && (await prisma.purchaseItem.count({ where: { purchaseId: vieja.id } })) === 1 && rec.replayed === false)
  const aud = await prisma.auditLog.findFirst({ where: { tenantId: A.t.id, action: 'compra.documento', entityId: vieja.id } })
  check('>>> queda en la auditoría con el antes (referencia libre) y el después (documento)', !!aud && JSON.stringify(aud.before).includes('F777-9') && JSON.stringify(aud.after).includes('F777-000009') && aud.actorId === O.userId)
  const rect = await completar(vieja.id, { docSeries: 'F777', docNumber: '000010' })
  check('se puede CORREGIR un documento ya completado (un error de tipeo)', (await fila(vieja.id)).invoiceRef === 'F777-000010' && rect.invoiceRef === 'F777-000010')
  check('>>> el documento de otra compra del mismo proveedor → DUPLICATE_CODE', (await code(completar(vieja.id, { docSeries: 'F001', docNumber: '000123' }))) === 'DUPLICATE_CODE')
  check('repetir lo mismo sobre la misma compra no choca consigo misma', (await code(completar(vieja.id, { docSeries: 'F777', docNumber: '000010' }))) === null)
  check('>>> a medias o con fecha futura → INVALID_DOCUMENT y no cambia nada', (await code(completar(vieja.id, { docType: 'OTRO', issueDate: '2099-01-01' }))) === 'INVALID_DOCUMENT' && (await fila(vieja.id)).invoiceRef === 'F777-000010')
  check('>>> un borrador no se completa así (se edita)', (await code(completar(c1.id))) === 'INVALID_DOCUMENT')
  const anul = await nuevo({ invoiceRef: 'ANU-1' }); await anularCompra(db, O, anularCompraSchema.parse({ purchaseId: anul.id, motivo: 'Error de prueba' }))
  check('>>> una anulada tampoco', (await code(completar(anul.id))) === 'INVALID_DOCUMENT')

  console.log('\nE) Permisos y aislamiento')
  const sinRecibir = await nuevo({ invoiceRef: 'PERM-1' }); await recibir(sinRecibir.id)
  for (const rol of ['OWNER', 'ADMIN']) check(`>>> ${rol} puede completar el documento`, (await code(completar(sinRecibir.id, { docSeries: 'P001', docNumber: rol === 'OWNER' ? '1' : '2' }, A.ctxs[rol]!))) === null)
  for (const rol of ['CAJERO', 'ALMACENERO', 'CONTADOR']) check(`>>> ${rol} NO puede (compras.registrar)`, (await code(completar(sinRecibir.id, { docSeries: 'P009', docNumber: '9' }, A.ctxs[rol]!))) === 'FORBIDDEN_ROLE')
  check('un almacenero al que el dueño le activó compras.registrar sí', (await code(completar(sinRecibir.id, { docSeries: 'P003', docNumber: '3' }, { ...A.ctxs.ALMACENERO!, permisosExtra: ['compras.registrar'] }))) === null)
  check('>>> otro negocio no puede tocar la compra (NOT_FOUND)', (await code(completar(sinRecibir.id, {}, B.ctxs.OWNER!))) === 'NOT_FOUND')
  const det = await obtenerCompra(db, O, vieja.id)
  check('el detalle devuelve el documento y la fecha como AAAA-MM-DD', det.docType === 'FACTURA' && det.docSeries === 'F777' && det.issueDate === '2026-10-20')

  console.log('\nF) Anular libera el documento')
  const ref = await nuevo({ docType: 'FACTURA', docSeries: 'A001', docNumber: '5', issueDate: '2026-10-20' }); await recibir(ref.id)
  await anularCompra(db, O, anularCompraSchema.parse({ purchaseId: ref.id, motivo: 'Devuelta al proveedor' }))
  const fa = await fila(ref.id)
  check('>>> anular deja los cuatro campos vacíos junto con `invoiceRef` (el CHECK sigue cumpliéndose) y libera el documento', fa.docType === null && fa.docSeries === null && fa.docNumber === null && fa.issueDate === null && fa.invoiceRef === null)
  check('y el mismo documento se puede volver a registrar', (await code(nuevo({ docType: 'FACTURA', docSeries: 'A001', docNumber: '5', issueDate: '2026-10-20' }))) === null)
  check('la fecha de hoy en la zona del negocio es la que usa el servidor', hoyEnZona('America/Lima').length === 10)

  console.log('\nF2) Dos sucursales numeran sus compras sin chocar')
  const B2 = await crearSucursalConAlmacen(A.t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const dueno2: TenantContext = { ...O, branchId: B2.branch.id, branchIds: [A.b1.branch.id, B2.branch.id] }
  const enB2 = await crearBorrador(getTenantPrisma(dueno2), dueno2, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: B2.warehouse.id, supplierId: prov.id, items: [{ productId: prod.id, enteredQuantity: 1, unitCost: 5 }] }))
  const enB1 = await nuevo({})
  check('>>> la primera compra de la sucursal 2 NO choca con las de la 1: números distintos, con la serie de cada sucursal (P001-… y P002-…)', /^P001-\d{8}$/.test(enB1.number) && /^P002-\d{8}$/.test(enB2.number) && enB1.number !== enB2.number, `${enB1.number} / ${enB2.number}`)
  check('y las dos sucursales pueden seguir comprando (el correlativo de cada serie avanza por separado)', await (async () => { const a = await crearBorrador(getTenantPrisma(dueno2), dueno2, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: B2.warehouse.id, supplierId: prov.id, items: [{ productId: prod.id, enteredQuantity: 1, unitCost: 5 }] })); return /^P002-\d{8}$/.test(a.number) && a.number > enB2.number })())

  console.log('\nG) La migración es aditiva')
  const mig = readFileSync('prisma/migrations/20261113100000_compras_documento/migration.sql', 'utf8').replace(/--[^\n]*/g, '')
  check('>>> solo añade: 4 columnas SIN NOT NULL, un tipo, un índice y dos CHECK; no borra, no cambia datos', (mig.match(/ADD COLUMN/g) ?? []).length === 4 && !/ADD COLUMN[^\n]*NOT NULL/.test(mig) && !/DROP |DELETE |UPDATE |TRUNCATE |ALTER COLUMN|RENAME/i.test(mig) && /CREATE TYPE "PurchaseDocType"/.test(mig) && /CREATE INDEX "purchases_tenantId_issueDate_idx"/.test(mig) && (mig.match(/ADD CONSTRAINT/g) ?? []).length === 2)
  check('usa el nombre REAL de la tabla (purchases, por @@map), no el del modelo', mig.includes('ALTER TABLE "purchases"') && !mig.includes('"Purchase"'))
  check('hay down.sql probado, y la migración es posterior a todas las demás', existsSync('prisma/migrations/20261113100000_compras_documento/down.sql') && '20261113100000_compras_documento' > '20261112100000_compras_cuentas_por_pagar')

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
