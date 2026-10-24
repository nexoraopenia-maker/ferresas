import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { cargarComprobanteFiscal } from '../src/features/invoicing/envio'
import { construirXmlUbl, ComprobanteInconsistente } from '../src/features/invoicing/ubl'
import { documentoRelacionadoDe, NotaEsperaOriginal, type NotaParaEnviar } from '../src/features/invoicing/notas'
import { tipoComprobante } from '../src/features/invoicing/catalogos'
import { obtenerProveedor, type ComprobanteFiscal, type ProveedorFacturacion, type ResultadoEmision } from '../src/features/invoicing/providers'
import { ejecutarWorker } from '../src/features/cola-fiscal/worker'
import { claveIdempotencia, RAMPA_SEGUNDOS, MAX_INTENTOS } from '../src/features/cola-fiscal/reglas'

/**
 * Envío de notas de crédito y de débito: UBL (07/08), reglas de la nota y comportamiento en la cola.
 * ⚠️ Lo normativo (códigos, series, estructura XML) está sin validar contra SUNAT/PSE: se prueba lo que construimos.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const lanza = async (f: () => unknown) => { try { await f(); return null } catch (e) { return e as Error & { code?: string } } }
const mas = (d: Date, s: number) => new Date(d.getTime() + s * 1000)
const OK: ResultadoEmision = { estado: 'ACEPTADO', idExterno: 'ext-1', ticket: null, codigoRespuesta: '0', mensaje: 'Aceptado', hashXml: 'HASH', reintentable: false }
const cred = { usuario: 'mock:acepta', clave: 'x', modoPruebas: true }

/** Comprobante de ejemplo, coherente (una línea gravada de 11.80). */
function ejemplo(tipo: '01' | '03' | '07' | '08', rel?: ComprobanteFiscal['documentoRelacionado']): ComprobanteFiscal {
  return {
    tipoComprobante: tipo, serie: tipo === '07' ? 'FC01' : tipo === '08' ? 'FD01' : 'F001', correlativo: 7, fechaEmision: '2026-10-24', moneda: 'PEN',
    emisor: { ruc: completarRuc('2012345678'), razonSocial: 'FERRETERIA SAC', nombreComercial: 'Ferre', direccion: 'Av. 1', ubigeo: '150101', codigoEstablecimiento: '0000' },
    receptor: { tipoDocumento: '6', numeroDocumento: completarRuc('2099999999'), razonSocial: 'CLIENTE SAC', direccion: null },
    lineas: [{ numero: 1, descripcion: 'Cemento', codigoProducto: 'C1', unidadMedida: 'NIU', cantidad: 1, precioUnitario: 11.8, valorUnitario: 10, igv: 1.8, tasaIgv: 0.18, tipoAfectacionIgv: '10', importeTotal: 11.8, descuento: 0 }],
    totalGravado: 10, totalExonerado: 0, totalInafecto: 0, totalIgv: 1.8, totalDescuentos: 0, total: 11.8, totalEnLetras: 'ONCE CON 80/100 SOLES',
    ...(rel ? { documentoRelacionado: rel } : {}),
  }
}
const REL = { tipoComprobante: '01' as const, serie: 'F001', correlativo: 3, motivo: '06', descripcionMotivo: 'Devolución total' }

const nota = (o: Partial<NotaParaEnviar> = {}): NotaParaEnviar => ({
  documentType: 'NOTA_CREDITO', series: 'FC01', isTrial: false, total: 11.8, currency: 'PEN', reasonCode: '06', reasonDescription: 'Devolución total',
  relatedDocument: { documentType: 'FACTURA', series: 'F001', correlativo: 3, status: 'ACEPTADO', isTrial: false, total: 11.8, currency: 'PEN' }, ...o,
})
const conOriginal = (r: Partial<NonNullable<NotaParaEnviar['relatedDocument']>>) => nota({ relatedDocument: { ...nota().relatedDocument!, ...r } })

async function main() {
  console.log('\n1) Catálogo 01: tipos de comprobante')
  check('NOTA_CREDITO → 07 y NOTA_DEBITO → 08 (⚠️ sin validar)', tipoComprobante('NOTA_CREDITO') === '07' && tipoComprobante('NOTA_DEBITO') === '08')
  check('factura 01, boleta 03; nota de venta y ticket no son electrónicos', tipoComprobante('FACTURA') === '01' && tipoComprobante('BOLETA') === '03' && tipoComprobante('NOTA_VENTA') === null && tipoComprobante('TICKET') === null)

  console.log('\n2) UBL 2.1 de la nota de crédito (07)')
  const c07 = construirXmlUbl(ejemplo('07', REL))
  check('>>> raíz CreditNote con su espacio de nombres', c07.includes('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"') && c07.endsWith('</CreditNote>'))
  check('líneas CreditNoteLine con CreditedQuantity', c07.includes('<cac:CreditNoteLine>') && c07.includes('<cbc:CreditedQuantity') && !c07.includes('InvoiceLine') && !c07.includes('DebitedQuantity'))
  check('totales en LegalMonetaryTotal', c07.includes('<cac:LegalMonetaryTotal>') && !c07.includes('RequestedMonetaryTotal'))
  check('>>> DiscrepancyResponse: comprobante modificado, código del catálogo 09 y sustento',
    c07.includes('<cac:DiscrepancyResponse><cbc:ReferenceID>F001-3</cbc:ReferenceID>') && /catalogo09">06<\/cbc:ResponseCode>/.test(c07) && c07.includes('<cbc:Description>Devolución total</cbc:Description>'))
  check('>>> BillingReference/InvoiceDocumentReference: serie-correlativo y tipo 01',
    c07.includes('<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>F001-3</cbc:ID>') && /catalogo01">01<\/cbc:DocumentTypeCode><\/cac:InvoiceDocumentReference>/.test(c07))
  check('no lleva InvoiceTypeCode (eso es de facturas y boletas)', !c07.includes('InvoiceTypeCode'))

  console.log('\n3) UBL 2.1 de la nota de débito (08)')
  const c08 = construirXmlUbl(ejemplo('08', { ...REL, motivo: '02', descripcionMotivo: 'Aumento en el valor' }))
  check('>>> raíz DebitNote con su espacio de nombres', c08.includes('<DebitNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2"') && c08.endsWith('</DebitNote>'))
  check('>>> líneas DebitNoteLine con DebitedQuantity', c08.includes('<cac:DebitNoteLine>') && c08.includes('<cbc:DebitedQuantity') && !c08.includes('CreditedQuantity') && !c08.includes('InvoiceLine'))
  check('>>> totales en RequestedMonetaryTotal (no LegalMonetaryTotal)', c08.includes('<cac:RequestedMonetaryTotal>') && c08.includes('</cac:RequestedMonetaryTotal>') && !c08.includes('LegalMonetaryTotal'))
  check('>>> el motivo apunta al catálogo 10 (no al 09)', /catalogo10">02<\/cbc:ResponseCode>/.test(c08) && !c08.includes('catalogo09'))
  check('misma referencia al original', c08.includes('<cbc:ReferenceID>F001-3</cbc:ReferenceID>') && c08.includes('<cac:BillingReference>'))

  console.log('\n4) Factura y boleta no cambian')
  const f01 = construirXmlUbl(ejemplo('01'))
  check('factura: raíz Invoice, InvoicedQuantity, LegalMonetaryTotal, sin referencia', f01.startsWith('<?xml') && f01.includes('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"') && f01.includes('InvoicedQuantity') && f01.includes('LegalMonetaryTotal') && !f01.includes('BillingReference') && !f01.includes('DiscrepancyResponse'))
  check('>>> una nota SIN comprobante relacionado no genera XML', (await lanza(() => construirXmlUbl(ejemplo('07')))) instanceof ComprobanteInconsistente && (await lanza(() => construirXmlUbl(ejemplo('08')))) instanceof ComprobanteInconsistente)
  check('>>> una factura CON comprobante relacionado tampoco', (await lanza(() => construirXmlUbl(ejemplo('01', REL)))) instanceof ComprobanteInconsistente)

  console.log('\n5) Reglas de la nota')
  check('una nota de crédito total válida da su bloque de referencia', JSON.stringify(documentoRelacionadoDe(nota())) === JSON.stringify({ tipoComprobante: '01', serie: 'F001', correlativo: 3, motivo: '06', descripcionMotivo: 'Devolución total' }))
  check('sobre una BOLETA: serie BC01, referencia tipo 03', documentoRelacionadoDe(nota({ series: 'BC01', relatedDocument: { ...nota().relatedDocument!, documentType: 'BOLETA', series: 'B001' } })).tipoComprobante === '03')
  const serieMala = (s: string, o: Partial<NotaParaEnviar> = {}) => lanza(() => documentoRelacionadoDe(nota({ series: s, ...o })))
  check('>>> serie que NO hereda la letra del original (BC01 sobre factura F001) → rechazada', (await serieMala('BC01'))?.code === 'INVALID_DOCUMENT')
  check('>>> serie de factura (F001) o sin la letra C/D → rechazada', (await serieMala('F001'))?.code === 'INVALID_DOCUMENT' && (await serieMala('FX01'))?.code === 'INVALID_DOCUMENT')
  check('>>> serie de DÉBITO (FD01) en una nota de crédito → rechazada', (await serieMala('FD01'))?.code === 'INVALID_DOCUMENT')
  check('>>> mezcla de prueba y real (en cualquier sentido) → rechazada', (await lanza(() => documentoRelacionadoDe(nota({ isTrial: true }))))?.code === 'INVALID_DOCUMENT' && (await lanza(() => documentoRelacionadoDe(conOriginal({ isTrial: true }))))?.code === 'INVALID_DOCUMENT')
  check('el original debe ser factura o boleta (no otra nota, ni un ticket)', (await lanza(() => documentoRelacionadoDe(conOriginal({ documentType: 'NOTA_CREDITO' }))))?.code === 'INVALID_DOCUMENT' && (await lanza(() => documentoRelacionadoDe(conOriginal({ documentType: 'TICKET' }))))?.code === 'INVALID_DOCUMENT')
  check('sin original → rechazada', (await lanza(() => documentoRelacionadoDe(nota({ relatedDocument: null }))))?.code === 'INVALID_DOCUMENT')
  check('otra moneda → rechazada', (await lanza(() => documentoRelacionadoDe(conOriginal({ currency: 'USD' }))))?.code === 'INVALID_DOCUMENT')
  check('>>> solo notas TOTALES: 01, 02 y 06 pasan', ['01', '02', '06'].every((c) => !!documentoRelacionadoDe(nota({ reasonCode: c })).motivo))
  check('>>> los demás códigos se rechazan EXPLÍCITAMENTE por falta de TaxDocumentItem', ['03', '04', '05', '07', '08', '09', '10', '13'].every((c) => { try { documentoRelacionadoDe(nota({ reasonCode: c })); return false } catch (e) { return (e as Error).message.includes('TaxDocumentItem') } }))
  check('>>> las notas de débito aún no se envían (mismo motivo)', (await lanza(() => documentoRelacionadoDe(nota({ documentType: 'NOTA_DEBITO', series: 'FD01', reasonCode: '02' }))))?.message.includes('TaxDocumentItem') === true)
  check('>>> una nota total debe igualar el importe del original', (await lanza(() => documentoRelacionadoDe(nota({ total: 5 }))))?.code === 'INVALID_DOCUMENT')
  check('el motivo sin sustento → rechazada', (await lanza(() => documentoRelacionadoDe(nota({ reasonDescription: '  ' }))))?.code === 'INVALID_DOCUMENT')

  console.log('\n6) Estado del original')
  check('>>> PENDIENTE y ENVIADO → NotaEsperaOriginal (no es un fallo de la nota)', (await lanza(() => documentoRelacionadoDe(conOriginal({ status: 'PENDIENTE' })))) instanceof NotaEsperaOriginal && (await lanza(() => documentoRelacionadoDe(conOriginal({ status: 'ENVIADO' })))) instanceof NotaEsperaOriginal)
  check('ACEPTADO → pasa', !(await lanza(() => documentoRelacionadoDe(conOriginal({ status: 'ACEPTADO' })))))
  check('>>> OBSERVADO y RECHAZADO NO se esperan (nunca pasarán a ACEPTADO): error permanente, con mensaje', ['OBSERVADO', 'RECHAZADO'].every((s) => { try { documentoRelacionadoDe(conOriginal({ status: s })); return false } catch (e) { return !(e instanceof NotaEsperaOriginal) && (e as { code?: string }).code === 'INVALID_DOCUMENT' } }))
  check('los errores permanentes se dicen ANTES de esperar (una nota inválida no espera en vano)', (await lanza(() => documentoRelacionadoDe(conOriginal({ status: 'PENDIENTE', currency: 'USD' }))))?.code === 'INVALID_DOCUMENT')

  console.log('\n7) Con la base: cargarComprobanteFiscal')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  async function negocio(tag: string) {
    const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
    const t = await prisma.tenant.create({ data: { slug: `nv-${tag}-${randomUUID().slice(0, 6)}`, name: `Notas ${tag}`, legalName: `NOTAS ${tag.toUpperCase()} SAC`, taxId, planId: plan.id, pseConfiguredAt: new Date(), realBillingEnabledAt: new Date(Date.now() - 86_400_000) } })
    await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_nv' } })
    const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER' } })
    await asignarSucursal(t.id, u.id, branch.id)
    const p = await prisma.product.create({ data: { tenantId: t.id, sku: 'P', name: 'Cemento', salePrice: 11.8 } })
    let n = 0, nn = 0
    /** Una factura con su venta y líneas, en el estado dado, y (opcional) con fila en la cola programada para `cuando`. */
    const factura = async (status: 'PENDIENTE' | 'ENVIADO' | 'ACEPTADO' | 'OBSERVADO' | 'RECHAZADO', cuando: Date | null = new Date(Date.now() + 10 * 86_400_000), trial = false) => {
      const sale = await prisma.sale.create({ data: { tenantId: t.id, branchId: branch.id, warehouseId: w.id, userId: u.id, number: `V-${tag}-${randomUUID().slice(0, 6)}`, status: 'COMPLETADA' } })
      await prisma.saleItem.create({ data: { tenantId: t.id, saleId: sale.id, productId: p.id, nameSnapshot: 'Cemento', skuSnapshot: 'P', quantity: 1, unitPrice: 11.8, lineTotal: 11.8 } })
      n++
      const d = await prisma.taxDocument.create({ data: { tenantId: t.id, saleId: sale.id, documentType: 'FACTURA', series: trial ? 'PF001' : 'F001', correlativo: n, fullNumber: `F001-${String(n).padStart(8, '0')}`, status, isTrial: trial, receiverDocType: 'RUC', receiverDocNumber: completarRuc('2055555555'), receiverName: 'CLIENTE SAC', issuerTaxId: taxId, issuerLegalName: `NOTAS ${tag.toUpperCase()} SAC`, subtotal: 10, taxTotal: 1.8, total: 11.8, issuedAt: new Date(Date.now() - 600_000) } })
      if (cuando) await prisma.fiscalDispatch.create({ data: { tenantId: t.id, taxDocumentId: d.id, nextAttemptAt: cuando, idempotencyKey: claveIdempotencia(t.id, d.id) } })
      return d
    }
    /** Una nota de crédito sobre `orig`, con su fila en la cola lista para enviarse. */
    const notaSobre = async (orig: { id: string; saleId: string }, o: { serie?: string; codigo?: string; trial?: boolean; cola?: Date | null } = {}) => {
      nn++
      const d = await prisma.taxDocument.create({ data: { tenantId: t.id, saleId: orig.saleId, documentType: 'NOTA_CREDITO', series: o.serie ?? 'FC01', correlativo: nn, fullNumber: `${o.serie ?? 'FC01'}-${String(nn).padStart(8, '0')}`, status: 'PENDIENTE', isTrial: !!o.trial, relatedDocumentId: orig.id, reasonCode: o.codigo ?? '06', reasonDescription: 'Devolución total', receiverDocType: 'RUC', receiverDocNumber: completarRuc('2055555555'), receiverName: 'CLIENTE SAC', issuerTaxId: taxId, issuerLegalName: `NOTAS ${tag.toUpperCase()} SAC`, subtotal: 10, taxTotal: 1.8, total: 11.8, issuedAt: new Date(Date.now() - 300_000) } })
      if (o.cola !== null) await prisma.fiscalDispatch.create({ data: { tenantId: t.id, taxDocumentId: d.id, nextAttemptAt: o.cola ?? new Date(Date.now() - 1000), idempotencyKey: claveIdempotencia(t.id, d.id) } })
      return d
    }
    const db = getTenantPrisma({ tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] })
    return { t, db, factura, notaSobre, fila: (id: string) => prisma.fiscalDispatch.findFirst({ where: { taxDocumentId: id } }), doc: (id: string) => prisma.taxDocument.findUniqueOrThrow({ where: { id } }) }
  }
  const A = await negocio('a'); const B = await negocio('b')
  const origA = await A.factura('ACEPTADO')
  const LEJOS = new Date(Date.now() + 10 * 86_400_000) // con fila programada lejos: el worker no los adopta ni los toca
  const nA = await A.notaSobre(origA, { cola: LEJOS })
  const { comprobante: cf } = await cargarComprobanteFiscal(A.db, nA.id)
  check('>>> la nota se arma como 07 con el original, el motivo y el sustento', cf.tipoComprobante === '07' && cf.documentoRelacionado?.serie === 'F001' && cf.documentoRelacionado.correlativo === origA.correlativo && cf.documentoRelacionado.tipoComprobante === '01' && cf.documentoRelacionado.motivo === '06' && cf.documentoRelacionado.descripcionMotivo === 'Devolución total')
  check('...con serie y correlativo propios, y las líneas de la venta', cf.serie === 'FC01' && cf.correlativo === nA.correlativo && cf.lineas.length === 1 && cf.total === 11.8)
  check('y el XML sale con la referencia', construirXmlUbl(cf).includes(`<cbc:ID>F001-${origA.correlativo}</cbc:ID>`))
  check('>>> el original de OTRO negocio no se ve: con el cliente de B la nota de A no existe', (await lanza(() => cargarComprobanteFiscal(B.db, nA.id)))?.code === 'NOT_FOUND')
  const ventaB = (await B.factura('ACEPTADO', LEJOS)).saleId
  const fkAjena = await lanza(() => prisma.taxDocument.create({ data: { tenantId: B.t.id, saleId: ventaB, documentType: 'NOTA_CREDITO', series: 'FC01', correlativo: 99, fullNumber: 'FC01-00000099', relatedDocumentId: origA.id, reasonCode: '06', reasonDescription: 'x', subtotal: 10, taxTotal: 1.8, total: 11.8 } }))
  check('>>> y la base impide que la nota de B apunte al original de A', (fkAjena as { code?: string } | null)?.code === 'P2003')
  const origT = await A.factura('ACEPTADO', LEJOS, true)
  const nT = await A.notaSobre(origT, { serie: 'FC01', cola: LEJOS })
  check('>>> nota REAL sobre un original de PRUEBA → rechazada al cargar', (await lanza(() => cargarComprobanteFiscal(A.db, nT.id)))?.code === 'INVALID_DOCUMENT')
  // Una sola nota total viva por comprobante (índice único parcial): la de serie incorrecta va sobre OTRO original.
  const origS = await A.factura('ACEPTADO', LEJOS)
  const nS = await A.notaSobre(origS, { serie: 'BC01', cola: LEJOS })
  check('>>> serie incorrecta al cargar → rechazada', (await lanza(() => cargarComprobanteFiscal(A.db, nS.id)))?.message.includes('serie') === true)

  console.log('\n8) En la cola: la nota espera a su original SIN gastar intentos')
  const emitidos: ComprobanteFiscal[] = []
  const base = obtenerProveedor('mock')
  const proveedor: ProveedorFacturacion = { ...base, emitir: async (c) => { emitidos.push(c); return OK } }
  const correr_ = (t0: Date) => ejecutarWorker({ reloj: () => t0, deps: { proveedor, credenciales: cred }, presupuestoMs: 600_000, margenEnvioMs: 0 })
  const origW = await A.factura('PENDIENTE')
  const nW = await A.notaSobre(origW)
  const t0 = new Date()
  const pasos = MAX_INTENTOS + 3
  for (let i = 0; i < pasos; i++) await correr_(mas(t0, 300 * i))
  const fW = (await A.fila(nW.id))!
  check(`>>> tras ${pasos} pasadas (más que ${MAX_INTENTOS} intentos) la nota sigue PENDIENTE: NO se agotó`, fW.status === 'PENDIENTE' && fW.attempts === 0 && fW.exhaustedAt === null, `intentos=${fW.attempts} estado=${fW.status}`)
  check('>>> ni una llamada al proveedor con la nota (ni con el original, que no está programado)', emitidos.length === 0)
  check('se ve POR QUÉ espera, y vuelve a mirar en 5 min', (fW.lastError ?? '').includes('original') && fW.nextAttemptAt.getTime() === mas(t0, 300 * (pasos - 1) + 300).getTime())
  check('el comprobante de la nota sigue PENDIENTE', (await A.doc(nW.id)).status === 'PENDIENTE')

  console.log('\n9) ...y sale cuando el original se acepta')
  await prisma.taxDocument.update({ where: { id: origW.id }, data: { status: 'ACEPTADO' } })
  const tSale = mas(t0, 300 * pasos)
  await correr_(tSale)
  const e = emitidos.filter((c) => c.tipoComprobante === '07')
  check('>>> el proveedor recibió la nota UNA vez, como 07, con su referencia y motivo', e.length === 1 && e[0]!.documentoRelacionado?.correlativo === origW.correlativo && e[0]!.documentoRelacionado?.motivo === '06', JSON.stringify(e[0]?.documentoRelacionado))
  const fW2 = (await A.fila(nW.id))!
  check('la nota quedó ACEPTADA, la fila COMPLETADA y gastó UN solo intento', (await A.doc(nW.id)).status === 'ACEPTADO' && fW2.status === 'COMPLETADO' && fW2.attempts === 1)
  check('...con su propia clave de idempotencia (distinta de la del original)', fW2.idempotencyKey === claveIdempotencia(A.t.id, nW.id) && fW2.idempotencyKey !== claveIdempotencia(A.t.id, origW.id))

  console.log('\n10) Errores permanentes de la nota NO se esperan: siguen la rampa normal')
  const origM = await A.factura('ACEPTADO')
  const nM = await A.notaSobre(origM, { serie: 'BC01' })
  const antes = emitidos.length
  await correr_(mas(tSale, 10))
  const fM = (await A.fila(nM.id))!
  check('>>> serie incorrecta: gasta el intento (1), se reprograma por la rampa y NO llega al proveedor', fM.attempts === 1 && fM.status === 'PENDIENTE' && fM.nextAttemptAt.getTime() === mas(mas(tSale, 10), RAMPA_SEGUNDOS[0]!).getTime() && emitidos.length === antes && (fM.lastError ?? '').includes('serie'))
  const origP = await A.factura('ACEPTADO')
  const nP = await A.notaSobre(origP, { codigo: '04' })
  await correr_(mas(tSale, 20))
  check('>>> un motivo no soportado (04, descuento global) tampoco llega al proveedor', emitidos.length === antes && ((await A.fila(nP.id))?.lastError ?? '').includes('TaxDocumentItem'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
