import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { emitirNotaCreditoTotal } from '../src/features/invoicing/service'
import { cargarComprobanteFiscal } from '../src/features/invoicing/envio'
import type { TenantContext } from '../src/lib/tenant-context'

/** Servicio emitirNotaCreditoTotal: filtros, validaciones, serie heredada, correlativos y la carrera del duplicado. */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const lanza = async (f: () => unknown) => { try { await f(); return null } catch (e) { return e as Error & { code?: string } } }
const SUSTENTO = 'Devolución total de la mercadería'

const plan = () => prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })

async function negocio(tag: string, o: { demo?: boolean } = {}) {
  const p = await plan()
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: { slug: `nct-${tag}-${randomUUID().slice(0, 6)}`, name: `NC ${tag}`, legalName: `NC ${tag.toUpperCase()} SAC`, taxId, planId: p.id, pseConfiguredAt: new Date(), isDemo: !!o.demo, ...(o.demo ? {} : { realBillingEnabledAt: new Date(Date.now() - 86_400_000) }) } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: p.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_nct' } })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const mk = (role: 'OWNER' | 'VENDEDOR') => prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`, name: role, role } })
  const owner = await mk('OWNER'); const vend = await mk('VENDEDOR')
  await asignarSucursal(t.id, owner.id, branch.id); await asignarSucursal(t.id, vend.id, branch.id)
  const ctx = (u: { id: string }, role: 'OWNER' | 'VENDEDOR'): TenantContext => ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branch.id, branchIds: [branch.id] })
  let n = 0
  /** Comprobante de venta ya emitido, en el estado y serie dados. */
  const original = async (o: { tipo?: 'FACTURA' | 'BOLETA'; status?: 'PENDIENTE' | 'ENVIADO' | 'ACEPTADO' | 'OBSERVADO' | 'RECHAZADO'; trial?: boolean; serie?: string; sinIdProveedor?: boolean } = {}) => {
    const tipo = o.tipo ?? 'FACTURA'
    const sale = await prisma.sale.create({ data: { tenantId: t.id, branchId: branch.id, warehouseId: w.id, userId: owner.id, number: `V-${tag}-${randomUUID().slice(0, 6)}`, status: 'COMPLETADA' } })
    n++
    const serie = o.serie ?? (tipo === 'FACTURA' ? 'F001' : 'B001')
    return prisma.taxDocument.create({ data: { tenantId: t.id, saleId: sale.id, documentType: tipo, series: serie, correlativo: n, fullNumber: `${serie}-${String(n).padStart(8, '0')}`, status: o.status ?? 'ACEPTADO', isTrial: !!o.trial, externalId: o.sinIdProveedor ? null : `ext-${randomUUID().slice(0, 8)}`, receiverDocType: 'RUC', receiverDocNumber: completarRuc('2055555555'), receiverName: 'CLIENTE SAC', receiverAddress: 'Jr. Cliente 1', issuerTaxId: taxId, issuerLegalName: `NC ${tag.toUpperCase()} SAC`, subtotal: 100, taxTotal: 18, discountTotal: 0, total: 118 } })
  }
  const db = getTenantPrisma(ctx(owner, 'OWNER'))
  return { t, owner, vend, ctx, db, original, branch }
}

async function main() {
  const A = await negocio('a'); const B = await negocio('b')
  const ctxA = A.ctx(A.owner, 'OWNER')

  console.log('\n1) Una nota total sale bien')
  const f1 = await A.original()
  const n1 = await emitirNotaCreditoTotal(A.db, ctxA, { saleId: f1.saleId, reasonCode: '06', reasonDescription: `  ${SUSTENTO}  ` })
  const d1 = await prisma.taxDocument.findUniqueOrThrow({ where: { id: n1.id } })
  check('>>> serie heredada: factura F001 → FC01, correlativo 1, número impreso', n1.series === 'FC01' && n1.correlativo === 1 && n1.fullNumber === 'FC01-00000001', n1.fullNumber)
  check('es una NOTA_CREDITO PENDIENTE relacionada con el original, de la misma venta y no de prueba', d1.documentType === 'NOTA_CREDITO' && d1.status === 'PENDIENTE' && d1.relatedDocumentId === f1.id && d1.saleId === f1.saleId && d1.isTrial === false)
  check('motivo y sustento (sin espacios sobrantes)', d1.reasonCode === '06' && d1.reasonDescription === SUSTENTO)
  check('>>> importes, emisor y receptor COPIADOS del original', Number(d1.total) === 118 && Number(d1.subtotal) === 100 && Number(d1.taxTotal) === 18 && d1.receiverDocNumber === f1.receiverDocNumber && d1.receiverName === 'CLIENTE SAC' && d1.issuerTaxId === f1.issuerTaxId)
  check('negocio real: entra a la cola en la misma transacción', (await prisma.fiscalDispatch.count({ where: { taxDocumentId: n1.id, op: 'ENVIAR', status: 'PENDIENTE' } })) === 1)
  check('queda en la auditoría', (await prisma.auditLog.count({ where: { tenantId: A.t.id, action: 'taxdocument.nota_credito', entityId: n1.id } })) === 1)
  check('>>> y el envío la reconoce: carga como 07 con su original', (await cargarComprobanteFiscal(A.db, n1.id)).comprobante.documentoRelacionado?.serie === 'F001', 'falta aceptar el original: ya lo está')
  check('la venta y el comprobante original NO cambian', (await prisma.taxDocument.findUniqueOrThrow({ where: { id: f1.id } })).status === 'ACEPTADO' && (await prisma.sale.findUniqueOrThrow({ where: { id: f1.saleId } })).status === 'COMPLETADA')

  console.log('\n2) Filtros')
  const f2 = await A.original()
  for (const c of ['03', '04', '05', '07', '09', '10', '13', '99', '']) {
    const e = await lanza(() => emitirNotaCreditoTotal(A.db, ctxA, { saleId: f2.saleId, reasonCode: c, reasonDescription: SUSTENTO }))
    if (e?.code !== 'INVALID_DOCUMENT') check(`>>> el motivo «${c}» se rechaza`, false, e?.message ?? 'se aceptó')
  }
  check('>>> solo 01, 02 y 06: cualquier otro motivo se rechaza', true)
  check('sustento vacío o larguísimo → rechazado', (await lanza(() => emitirNotaCreditoTotal(A.db, ctxA, { saleId: f2.saleId, reasonCode: '01', reasonDescription: '  ' })))?.code === 'INVALID_DOCUMENT' && (await lanza(() => emitirNotaCreditoTotal(A.db, ctxA, { saleId: f2.saleId, reasonCode: '01', reasonDescription: 'x'.repeat(251) })))?.code === 'INVALID_DOCUMENT')
  check('>>> los rechazos no gastaron ningún correlativo', (await prisma.documentCounter.findFirstOrThrow({ where: { tenantId: A.t.id, series: 'FC01' } })).next === 2)

  console.log('\n3) El original')
  for (const st of ['PENDIENTE', 'ENVIADO', 'RECHAZADO'] as const) {
    const o = await A.original({ status: st })
    check(`>>> original ${st} → bloqueado`, (await lanza(() => emitirNotaCreditoTotal(A.db, ctxA, { saleId: o.saleId, reasonCode: '01', reasonDescription: SUSTENTO })))?.code === 'INVALID_DOCUMENT')
  }
  const oObs = await A.original({ status: 'OBSERVADO', serie: 'F002' })
  check('>>> original OBSERVADO (válido, aceptado con advertencias) → SÍ admite la nota total', (await lanza(() => emitirNotaCreditoTotal(A.db, ctxA, { saleId: oObs.saleId, reasonCode: '06', reasonDescription: SUSTENTO }))) === null)
  const oT = await A.original({ trial: true, serie: 'PF001' })
  check('>>> original de PRUEBA → bloqueado', (await lanza(() => emitirNotaCreditoTotal(A.db, ctxA, { saleId: oT.saleId, reasonCode: '01', reasonDescription: SUSTENTO })))?.message.includes('prueba') === true)
  check('venta sin comprobante → NOT_FOUND', (await lanza(() => emitirNotaCreditoTotal(A.db, ctxA, { saleId: randomUUID(), reasonCode: '01', reasonDescription: SUSTENTO })))?.code === 'NOT_FOUND')
  const oBig = await A.original({ serie: 'F101' })
  check('>>> sucursal ≥ 100 (F101): no cabe en 4 caracteres → bloqueado con mensaje', (await lanza(() => emitirNotaCreditoTotal(A.db, ctxA, { saleId: oBig.saleId, reasonCode: '01', reasonDescription: SUSTENTO })))?.message.includes('1 a 99') === true)

  const oSin = await A.original({ sinIdProveedor: true })
  check('>>> real sin identificador del proveedor (¿aceptado a mano?) → bloqueado, con el camino «Consultar»', (await lanza(() => emitirNotaCreditoTotal(A.db, ctxA, { saleId: oSin.saleId, reasonCode: '01', reasonDescription: SUSTENTO })))?.message.includes('Consultar') === true)

  console.log('\n4) Una sola nota total por comprobante')
  const dup = await lanza(() => emitirNotaCreditoTotal(A.db, ctxA, { saleId: f1.saleId, reasonCode: '01', reasonDescription: SUSTENTO }))
  check('>>> la segunda se BLOQUEA y dice cuál es la existente', dup?.code === 'INVALID_DOCUMENT' && dup.message.includes('FC01-00000001'))
  check('...y no gastó correlativo', (await prisma.documentCounter.findFirstOrThrow({ where: { tenantId: A.t.id, series: 'FC01' } })).next === 2)
  await prisma.taxDocument.update({ where: { id: n1.id }, data: { status: 'RECHAZADO' } })
  const n1b = await emitirNotaCreditoTotal(A.db, ctxA, { saleId: f1.saleId, reasonCode: '01', reasonDescription: SUSTENTO })
  check('>>> una nota RECHAZADA no cuenta: se puede emitir otra, con el SIGUIENTE correlativo', n1b.fullNumber === 'FC01-00000002', n1b.fullNumber)

  console.log('\n5) Carrera: ocho personas emitiendo la nota del mismo comprobante a la vez')
  const f3 = await A.original()
  const antes = (await prisma.documentCounter.findFirstOrThrow({ where: { tenantId: A.t.id, series: 'FC01' } })).next
  const res = await Promise.allSettled(Array.from({ length: 8 }, () => emitirNotaCreditoTotal(A.db, ctxA, { saleId: f3.saleId, reasonCode: '01', reasonDescription: SUSTENTO })))
  const ok = res.filter((r) => r.status === 'fulfilled')
  const rechazos = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  check('>>> EXACTAMENTE una prospera y las otras siete son un bloqueo claro', ok.length === 1 && rechazos.length === 7 && rechazos.every((r) => (r.reason as { code?: string }).code === 'INVALID_DOCUMENT'), `ok=${ok.length} ${rechazos.map((r) => String(r.reason?.message ?? r.reason).slice(0, 50)).slice(0, 2).join(' | ')}`)
  check('>>> en la base hay UNA nota viva y el contador avanzó UNO (los perdedores devolvieron su número)', (await prisma.taxDocument.count({ where: { relatedDocumentId: f3.id, status: { not: 'RECHAZADO' } } })) === 1 && (await prisma.documentCounter.findFirstOrThrow({ where: { tenantId: A.t.id, series: 'FC01' } })).next === antes + 1)

  console.log('\n6) Boletas, permisos y aislamiento')
  const bol = await A.original({ tipo: 'BOLETA' })
  const nb = await emitirNotaCreditoTotal(A.db, ctxA, { saleId: bol.saleId, reasonCode: '02', reasonDescription: SUSTENTO })
  check('>>> boleta B001 → serie BC01 con su propio contador (empieza en 1)', nb.fullNumber === 'BC01-00000001', nb.fullNumber)
  const f4 = await A.original()
  const dbV = getTenantPrisma(A.ctx(A.vend, 'VENDEDOR'))
  check('>>> sin el permiso (vendedor) → FORBIDDEN_ROLE', (await lanza(() => emitirNotaCreditoTotal(dbV, A.ctx(A.vend, 'VENDEDOR'), { saleId: f4.saleId, reasonCode: '01', reasonDescription: SUSTENTO })))?.code === 'FORBIDDEN_ROLE')
  const ctxB = B.ctx(B.owner, 'OWNER')
  check('>>> el dueño de OTRO negocio no puede emitir la nota de esta venta (NOT_FOUND)', (await lanza(() => emitirNotaCreditoTotal(B.db, ctxB, { saleId: f4.saleId, reasonCode: '01', reasonDescription: SUSTENTO })))?.code === 'NOT_FOUND')
  check('...y nada se creó para esa venta', (await prisma.taxDocument.count({ where: { saleId: f4.saleId, documentType: 'NOTA_CREDITO' } })) === 0)

  console.log('\n7) Negocio demo: se crea, pero no entra a la cola')
  const D = await negocio('d', { demo: true })
  const fd = await D.original({ sinIdProveedor: true })
  const nd = await emitirNotaCreditoTotal(D.db, D.ctx(D.owner, 'OWNER'), { saleId: fd.saleId, reasonCode: '01', reasonDescription: SUSTENTO })
  check('>>> la demo emite su nota aun sin identificador de proveedor, y sin fila en la cola (envía por su propio camino)', !!nd.id && (await prisma.fiscalDispatch.count({ where: { taxDocumentId: nd.id } })) === 0)

  console.log('\n8) La base tiene la última palabra')
  const f5 = await A.original()
  const directo = (reason: string) => prisma.taxDocument.create({ data: { tenantId: A.t.id, saleId: f5.saleId, documentType: 'NOTA_CREDITO', series: 'FC01', correlativo: 900 + Math.floor(Math.random() * 90), fullNumber: `FC01-${randomUUID().slice(0, 8)}`, relatedDocumentId: f5.id, reasonCode: reason, reasonDescription: 'x', subtotal: 1, taxTotal: 0, total: 1 } })
  await directo('06')
  check('>>> una segunda nota total insertada A MANO también la rechaza el índice único', (await lanza(() => directo('01')))?.code === 'P2002')
  check('en cambio una nota con motivo NO total (p. ej. 04, descuento) no choca con él', !(await lanza(() => directo('04'))))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
