import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen, abrirTurno } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { issueTaxDocument } from '../src/features/invoicing/service'
import { cargarComprobanteFiscal, enviarComprobante, refrescarEstado } from '../src/features/invoicing/envio'
import { construirXmlUbl } from '../src/features/invoicing/ubl'
import { obtenerProveedor, reiniciarMock, type CredencialesProveedor } from '../src/features/invoicing/providers'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const cred = (escenario: string): CredencialesProveedor => ({ usuario: `mock:${escenario}`, clave: 'x', modoPruebas: true })
const mock = obtenerProveedor('mock')

async function negocio(tag: string, opts: { demo?: boolean; fiscal?: boolean } = {}) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const fiscal = opts.fiscal !== false
  const t = await prisma.tenant.create({
    data: {
      slug: `en-${tag}-${randomUUID().slice(0, 6)}`, name: `Envío ${tag}`, planId: plan.id,
      isDemo: !!opts.demo,
      ...(fiscal ? { taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`), legalName: `ENVIO ${tag.toUpperCase()} S.A.C.`, address: 'Av. Prueba 1', ubigeo: '150101' } : {}),
    },
  })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  // La facturación real está APAGADA por defecto: un negocio que envía a un proveedor la tiene
  // encendida y su sucursal completa. (Una demo nunca la enciende.)
  await prisma.branch.update({ where: { id: branch.id }, data: { address: 'Av. Prueba 123, Lima', ubigeo: '150101' } })
  if (!opts.demo && fiscal) await prisma.tenant.update({ where: { id: t.id }, data: { realBillingEnabledAt: new Date() } })
  const mk = async (role: Role) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, u.id, branch.id)
    const ctx: TenantContext = { tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
    return { ctx, db: getTenantPrisma(ctx) }
  }
  const owner = await mk('OWNER')
  await abrirTurno(t.id, owner.ctx.userId, branch.id)
  const vendedor = await mk('VENDEDOR')
  const kilo = await prisma.product.create({ data: { tenantId: t.id, sku: 'CLA', name: 'Clavos 3"', salePrice: 7.5, unitType: 'KILOGRAMO' } })
  const bolsa = await prisma.product.create({ data: { tenantId: t.id, sku: 'CEM', name: 'Cemento & Cía', salePrice: 32.9, unitType: 'BOLSA' } })
  for (const p of [kilo, bolsa]) await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: w.id, quantity: 1000 } })
  const dni = await prisma.customer.create({ data: { tenantId: t.id, docType: 'DNI', docNumber: '41235678', name: 'María Flores' } })
  /** Una boleta emitida lista para enviar. */
  const boleta = async () => {
    const v = await registerSale(owner.db, owner.ctx, registerSaleSchema.parse({
      warehouseId: w.id, customerId: dni.id,
      items: [{ productId: kilo.id, quantity: 2.5 }, { productId: bolsa.id, quantity: 3, discount: 1.1 }],
      payments: [{ method: 'YAPE', amount: 116.35 }], idempotencyKey: randomUUID(),
    }))
    const d = await issueTaxDocument(owner.db, owner.ctx, { saleId: v.saleId, documentType: 'BOLETA' })
    return { sale: v, doc: d }
  }
  return { t, owner, vendedor, boleta }
}

async function main() {
  reiniciarMock()
  const A = await negocio('a')

  console.log('\n1) El comprobante que se arma desde la venta')
  const b = await A.boleta()
  const sale = await prisma.sale.findUniqueOrThrow({ where: { id: b.sale.saleId } })
  const { comprobante: c } = await cargarComprobanteFiscal(A.owner.db, b.doc.id)
  check('tipo 03, serie y correlativo del documento emitido', c.tipoComprobante === '03' && c.serie === b.doc.series && c.correlativo === b.doc.correlativo)
  check('>>> los totales son EXACTAMENTE los de la venta', c.total === Number(sale.total) && c.totalIgv === Number(sale.taxTotal) && c.totalGravado === Number(sale.subtotal),
    `${c.total}/${sale.total} ${c.totalIgv}/${sale.taxTotal} ${c.totalGravado}/${sale.subtotal}`)
  check('2 líneas con su unidad de medida (KGM y BG)', c.lineas.length === 2 && c.lineas[0]!.unidadMedida === 'KGM' && c.lineas[1]!.unidadMedida === 'BG')
  check('el descuento ya va dentro del precio de la línea', c.totalDescuentos === 0 && c.lineas[1]!.importeTotal === 97.6, String(c.lineas[1]?.importeTotal))
  check('emisor con RUC válido y razón social', /^20\d{9}$/.test(c.emisor.ruc) && c.emisor.razonSocial.startsWith('ENVIO A'))
  check('receptor con DNI (tipo 1)', c.receptor.tipoDocumento === '1' && c.receptor.numeroDocumento === '41235678')
  check('importe en letras', c.totalEnLetras.startsWith('SON: '))
  const xml = construirXmlUbl(c)
  check('>>> y ese comprobante genera un UBL con los totales cuadrados', xml.includes(`>${c.total.toFixed(2)}</cbc:PayableAmount>`) && xml.includes('Cemento &amp; Cía'))

  console.log('\n2) Enviar y aceptar')
  const r = await enviarComprobante(A.owner.db, A.owner.ctx, b.doc.id, { proveedor: mock, credenciales: cred('acepta') })
  check('>>> queda ACEPTADO', r.estado === 'ACEPTADO' && !r.reintentable)
  const d = await prisma.taxDocument.findUniqueOrThrow({ where: { id: b.doc.id } })
  check('guarda el hash, el código de respuesta y las fechas', !!d.xmlHash && !!d.responseCode && !!d.sentAt && !!d.acceptedAt && d.rejectedAt === null)
  check('y el identificador del proveedor', !!d.externalId)
  check('queda auditado', (await prisma.auditLog.count({ where: { tenantId: A.t.id, action: 'comprobante.enviar', entityId: d.id } })) === 1)
  check('>>> un comprobante ya aceptado no se reenvía', await code(enviarComprobante(A.owner.db, A.owner.ctx, b.doc.id, { proveedor: mock, credenciales: cred('acepta') })) === 'INVALID_DOCUMENT')

  console.log('\n3) Rechazo del proveedor')
  const bR = await A.boleta()
  const rr = await enviarComprobante(A.owner.db, A.owner.ctx, bR.doc.id, { proveedor: mock, credenciales: cred('rechaza') })
  const dR = await prisma.taxDocument.findUniqueOrThrow({ where: { id: bR.doc.id } })
  check('>>> queda RECHAZADO con el motivo del proveedor', rr.estado === 'RECHAZADO' && !!dR.statusMessage && !!dR.rejectedAt && dR.acceptedAt === null, dR.statusMessage ?? '')
  check('un rechazado no se reenvía solo: hay que corregirlo', await code(enviarComprobante(A.owner.db, A.owner.ctx, bR.doc.id, { proveedor: mock, credenciales: cred('acepta') })) === 'INVALID_DOCUMENT')

  console.log('\n4) Fallo transitorio: reintentar es seguro')
  const bT = await A.boleta()
  const rt = await enviarComprobante(A.owner.db, A.owner.ctx, bT.doc.id, { proveedor: mock, credenciales: cred('transitorio') })
  const dT = await prisma.taxDocument.findUniqueOrThrow({ where: { id: bT.doc.id } })
  check('>>> sigue PENDIENTE y marcado reintentable', rt.estado === 'PENDIENTE' && rt.reintentable && dT.status === 'PENDIENTE' && dT.rejectedAt === null)
  const rt2 = await enviarComprobante(A.owner.db, A.owner.ctx, bT.doc.id, { proveedor: mock, credenciales: cred('acepta') })
  check('el reintento funciona', rt2.estado === 'ACEPTADO')

  console.log('\n5) Proveedor asíncrono: se consulta después')
  const bA = await A.boleta()
  const ra = await enviarComprobante(A.owner.db, A.owner.ctx, bA.doc.id, { proveedor: mock, credenciales: cred('asincrono') })
  check('queda ENVIADO esperando respuesta', ra.estado === 'ENVIADO')
  let estado = (await refrescarEstado(A.owner.db, A.owner.ctx, bA.doc.id, { proveedor: mock, credenciales: cred('asincrono') })).estado
  for (let i = 0; i < 4 && estado === 'ENVIADO'; i++) {
    estado = (await refrescarEstado(A.owner.db, A.owner.ctx, bA.doc.id, { proveedor: mock, credenciales: cred('asincrono') })).estado
  }
  check('>>> al consultar acaba ACEPTADO', estado === 'ACEPTADO' && (await prisma.taxDocument.findUniqueOrThrow({ where: { id: bA.doc.id } })).acceptedAt !== null)
  check('refrescar uno que ya no espera no cambia nada', (await refrescarEstado(A.owner.db, A.owner.ctx, bA.doc.id, { proveedor: mock, credenciales: cred('asincrono') })).estado === 'ACEPTADO')

  console.log('\n6) >>> Un negocio REAL no usa el proveedor simulado')
  const bX = await A.boleta()
  check('sin proveedor real configurado se rechaza y NO se marca aceptado',
    await code(enviarComprobante(A.owner.db, A.owner.ctx, bX.doc.id)) === 'INVALID_DOCUMENT' &&
    (await prisma.taxDocument.findUniqueOrThrow({ where: { id: bX.doc.id } })).status === 'PENDIENTE')
  check('con proveedor pero SIN credenciales del negocio tampoco (no se inventan)',
    await code(enviarComprobante(A.owner.db, A.owner.ctx, bX.doc.id, { proveedor: obtenerProveedor('mock') })) === 'INVALID_DOCUMENT')
  check('>>> el VENDEDOR no puede enviar comprobantes', await code(enviarComprobante(A.vendedor.db, A.vendedor.ctx, bX.doc.id, { proveedor: mock, credenciales: cred('acepta') })) === 'FORBIDDEN_ROLE')

  console.log('\n7) Datos fiscales incompletos')
  const S = await negocio('sin-fiscal', { fiscal: false })
  const bS = await S.boleta()
  check('>>> sin RUC del negocio no se arma el comprobante', await code(enviarComprobante(S.owner.db, S.owner.ctx, bS.doc.id, { proveedor: mock, credenciales: cred('acepta') })) === 'INVALID_DOCUMENT')

  console.log('\n8) La cuenta demo sí envía (con el proveedor simulado)')
  const D = await negocio('demo', { demo: true })
  const bD = await D.boleta()
  const rd = await enviarComprobante(D.owner.db, D.owner.ctx, bD.doc.id)
  check('>>> sin configurar nada, queda ACEPTADO (simulado)', rd.estado === 'ACEPTADO')

  console.log('\n9) Aislamiento')
  check('>>> otro negocio no puede cargar el comprobante ajeno', await code(cargarComprobanteFiscal(S.owner.db, b.doc.id)) === 'NOT_FOUND')
  check('ni enviarlo', await code(enviarComprobante(S.owner.db, S.owner.ctx, b.doc.id, { proveedor: mock, credenciales: cred('acepta') })) === 'NOT_FOUND')

  await prisma.tenant.deleteMany({ where: { id: { in: [A.t.id, S.t.id, D.t.id] } } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
