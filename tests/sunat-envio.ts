import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { guardarCredencialesSunat } from '../src/features/sunat/credenciales'
import { archivosDeComprobante, guardarArchivosFiscales, leerArchivoFiscal, sha256 } from '../src/features/sunat/archivos'
import { verificarFirmaXml } from '../src/features/sunat/firma'
import { PLAZO_BAJA_DIAS, PLAZO_ENVIO_DIAS, CONSERVACION_ANIOS } from '../src/features/sunat/plazos'
import { UMBRAL_CRITICO_POR_DEFECTO_HORAS } from '../src/features/invoicing/alarma-envio'
import { consultarInterno } from '../src/features/invoicing/envio'
import { ejecutarWorker } from '../src/features/cola-fiscal/worker'
import { claveIdempotencia } from '../src/features/cola-fiscal/reglas'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { generarCertificadoDePrueba } from './falsos/certificado-prueba'
import { iniciarSunatFalso } from './falsos/sunat-falso'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * S3 · De punta a punta con la base y la cola real: factura, boleta y nota de crédito se emiten por SUNAT directo (contra el SUNAT falso), el XML firmado y el CDR quedan guardados
 * aislados por negocio e INMUTABLES, y cada desenlace (rechazo, caída, acceso denegado, sin credenciales, ambiente de pruebas) deja el comprobante en el estado que dice la verdad.
 * ⚠️ Prueba NUESTRA mecánica contra un falso, no que SUNAT acepte el XML (docs/SUNAT-SUPUESTOS.md).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const mas = (d: Date, s: number) => new Date(d.getTime() + s * 1000)

const SOL = 'ClaveSol-Secreta-7Z', CLAVE_PFX = 'Clave-Pfx-Secreta-9X'
const antes = { c: process.env.SECRETOS_CLAVES, a: process.env.SECRETOS_CLAVE_ACTUAL }

async function cuerpo() {
  process.env.SECRETOS_CLAVES = JSON.stringify({ a: Buffer.alloc(32, 7).toString('base64') })
  process.env.SECRETOS_CLAVE_ACTUAL = 'a'
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  async function negocio(tag: string, o: { credenciales?: boolean; ambiente?: 'BETA' | 'PRODUCCION' } = {}) {
    const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
    const t = await prisma.tenant.create({ data: { slug: `se-${tag}-${randomUUID().slice(0, 6)}`, name: `Envío ${tag}`, legalName: `ENVIO ${tag.toUpperCase()} SAC`, taxId, planId: plan.id, realBillingEnabledAt: new Date(Date.now() - 86_400_000) } })
    await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_se' } })
    const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER' } })
    await asignarSucursal(t.id, u.id, branch.id)
    const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id], permisosExtra: [] }
    const db = getTenantPrisma(ctx)
    const p = await prisma.product.create({ data: { tenantId: t.id, sku: 'P', name: 'Cemento', salePrice: 11.8 } })
    if (o.credenciales !== false) {
      const cert = generarCertificadoDePrueba({ ruc: taxId, clave: CLAVE_PFX })
      await guardarCredencialesSunat(db, ctx, { pfxBase64: cert.pfx.toString('base64'), claveCertificado: CLAVE_PFX, usuarioSol: 'USERSOL1', claveSol: SOL })
      if (o.ambiente) await prisma.sunatCredential.update({ where: { tenantId: t.id }, data: { ambiente: o.ambiente } })
    }
    let n = 0, nn = 0
    const doc = async (tipo: 'FACTURA' | 'BOLETA', status: 'PENDIENTE' | 'ACEPTADO' = 'PENDIENTE', cuando: Date | null = new Date(Date.now() - 1000)) => {
      const sale = await prisma.sale.create({ data: { tenantId: t.id, branchId: branch.id, warehouseId: w.id, userId: u.id, number: `V-${tag}-${randomUUID().slice(0, 6)}`, status: 'COMPLETADA' } })
      await prisma.saleItem.create({ data: { tenantId: t.id, saleId: sale.id, productId: p.id, nameSnapshot: 'Cemento', skuSnapshot: 'P', quantity: 1, unitPrice: 11.8, lineTotal: 11.8 } })
      n++
      const serie = tipo === 'FACTURA' ? 'F001' : 'B001'
      const d = await prisma.taxDocument.create({ data: {
        tenantId: t.id, saleId: sale.id, documentType: tipo, series: serie, correlativo: n, fullNumber: `${serie}-${String(n).padStart(8, '0')}`, status,
        receiverDocType: tipo === 'FACTURA' ? 'RUC' : 'DNI', receiverDocNumber: tipo === 'FACTURA' ? completarRuc('2055555555') : '41235678', receiverName: 'CLIENTE', issuerTaxId: taxId, issuerLegalName: 'ENVIO SAC',
        subtotal: 10, taxTotal: 1.8, total: 11.8, issuedAt: new Date(Date.now() - 600_000),
      } })
      if (cuando) await prisma.fiscalDispatch.create({ data: { tenantId: t.id, taxDocumentId: d.id, nextAttemptAt: cuando, idempotencyKey: claveIdempotencia(t.id, d.id) } })
      return d
    }
    const nota = async (orig: { id: string; saleId: string }) => {
      nn++
      const d = await prisma.taxDocument.create({ data: { tenantId: t.id, saleId: orig.saleId, documentType: 'NOTA_CREDITO', series: 'FC01', correlativo: nn, fullNumber: `FC01-${String(nn).padStart(8, '0')}`, status: 'PENDIENTE', relatedDocumentId: orig.id, reasonCode: '06', reasonDescription: 'Devolución total', receiverDocType: 'RUC', receiverDocNumber: completarRuc('2055555555'), receiverName: 'CLIENTE', issuerTaxId: taxId, issuerLegalName: 'ENVIO SAC', subtotal: 10, taxTotal: 1.8, total: 11.8, issuedAt: new Date(Date.now() - 500_000) } })
      await prisma.fiscalDispatch.create({ data: { tenantId: t.id, taxDocumentId: d.id, nextAttemptAt: new Date(Date.now() - 1000), idempotencyKey: claveIdempotencia(t.id, d.id) } })
      return d
    }
    return { t, taxId, ctx, db, u, doc, nota, fila: (id: string) => prisma.fiscalDispatch.findFirst({ where: { taxDocumentId: id } }), d: (id: string) => prisma.taxDocument.findUniqueOrThrow({ where: { id } }), archivos: (id: string) => prisma.taxDocumentFile.findMany({ where: { taxDocumentId: id }, orderBy: { kind: 'asc' } }) }
  }
  const A = await negocio('a')
  const falso = await iniciarSunatFalso({ usuarios: { [`${A.taxId}USERSOL1`]: SOL } })
  const worker = (t0 = new Date()) => ejecutarWorker({ reloj: () => t0, deps: { urlSunat: falso.url }, presupuestoMs: 600_000, margenEnvioMs: 0 })

  console.log('\n1) Factura, boleta y nota de crédito, por la cola real')
  const fa = await A.doc('FACTURA'), bo = await A.doc('BOLETA')
  await worker()
  const dFa = await A.d(fa.id), dBo = await A.d(bo.id)
  check('>>> la factura quedó ACEPTADA (código 0), con su identificador RUC-01-SERIE-N y la hora de aceptación', dFa.status === 'ACEPTADO' && dFa.responseCode === '0' && dFa.externalId === `${A.taxId}-01-F001-${fa.correlativo}` && dFa.acceptedAt !== null)
  check('>>> la boleta también, enviada una por una (sendBill) con su nombre RUC-03-B001-N', dBo.status === 'ACEPTADO' && falso.recibidas.some((r) => r.operacion === 'sendBill' && r.nombreZip === `${A.taxId}-03-B001-${bo.correlativo}.zip`))
  const fila = (await A.fila(fa.id))!
  check('la fila de la cola quedó COMPLETADA con un solo intento', fila.status === 'COMPLETADO' && fila.attempts === 1)
  check('>>> se guardaron los DOS archivos fiscales del comprobante (el XML firmado y el CDR)', (await archivosDeComprobante(A.db, fa.id)).sort().join() === 'CDR,XML_FIRMADO')
  const archivos = await A.archivos(fa.id)
  const xmlF = archivos.find((x) => x.kind === 'XML_FIRMADO')!, cdrF = archivos.find((x) => x.kind === 'CDR')!
  const xmlTexto = gunzipSync(xmlF.content).toString('utf8'), cdrTexto = gunzipSync(cdrF.content).toString('utf8')
  const enviado = falso.recibidas.find((r) => r.nombreZip === `${A.taxId}-01-F001-${fa.correlativo}.zip`)!
  check('>>> el XML guardado es EXACTAMENTE el que recibió SUNAT, con firma válida, y su hash y tamaño son los del contenido sin comprimir', xmlTexto === enviado.xml && verificarFirmaXml(xmlTexto).valida && xmlF.sha256 === sha256(xmlTexto) && xmlF.size === Buffer.byteLength(xmlTexto, 'utf8') && enviado.firmaValida === true)
  check('>>> el CDR guardado es el ApplicationResponse de SUNAT (código 0)', /ApplicationResponse/.test(cdrTexto) && /<cbc:ResponseCode>0<\/cbc:ResponseCode>/.test(cdrTexto) && cdrF.sha256 === sha256(cdrTexto))
  check('>>> el hash del comprobante (el del QR) es el DigestValue de la firma enviada', dFa.xmlHash === /<ds:DigestValue>([^<]+)<\/ds:DigestValue>/.exec(xmlTexto)![1])
  const auditoria = await prisma.auditLog.findFirst({ where: { tenantId: A.t.id, action: 'comprobante.enviar', entityId: fa.id } })
  check('>>> la auditoría dice que lo envió el sistema (cola) por sunat-directo, sin ningún secreto', JSON.stringify(auditoria?.after).includes('sunat-directo') && JSON.stringify(auditoria?.after).includes('cola') && !JSON.stringify(auditoria).includes(SOL) && !JSON.stringify(auditoria).includes(CLAVE_PFX))
  const nc = await A.nota(fa)
  await worker()
  const dNc = await A.d(nc.id)
  const enviadoNc = falso.recibidas.find((r) => r.nombreZip === `${A.taxId}-07-FC01-${nc.correlativo}.zip`)
  check('>>> la nota de crédito sobre la factura ACEPTADA sale por el mismo envío y queda ACEPTADA, con su XML y CDR', dNc.status === 'ACEPTADO' && !!enviadoNc && /<CreditNote /.test(enviadoNc.xml!) && (await A.archivos(nc.id)).length === 2)

  console.log('\n2) Desenlaces')
  falso.programar(A.taxId, 'rechazo')
  const fr = await A.doc('FACTURA')
  await worker()
  const dFr = await A.d(fr.id)
  check('>>> un rechazo deja el comprobante RECHAZADO, con el código y el motivo, y la fila completada (no reintenta)', dFr.status === 'RECHAZADO' && dFr.responseCode === '3030' && (dFr.statusMessage ?? '').length > 0 && (await A.fila(fr.id))!.status === 'COMPLETADO')
  check('>>> de un rechazo se conserva lo que se envió y la respuesta de SUNAT', (await A.archivos(fr.id)).length === 2)
  falso.programar(A.taxId, 'servidor')
  const ft = await A.doc('FACTURA')
  const t0 = new Date()
  await worker(t0)
  const dFt = await A.d(ft.id)
  const filaT = (await A.fila(ft.id))!
  check('>>> si SUNAT está caído el comprobante sigue PENDIENTE (jamás aceptado), la fila se reprograma y NO se guarda ningún archivo', dFt.status === 'PENDIENTE' && filaT.attempts === 1 && filaT.status === 'PENDIENTE' && filaT.nextAttemptAt.getTime() > t0.getTime() && (await A.archivos(ft.id)).length === 0)
  await worker(mas(filaT.nextAttemptAt, 1))
  check('>>> al reintentar se acepta y RECIÉN ahí se guardan los archivos (una sola vez)', (await A.d(ft.id)).status === 'ACEPTADO' && (await A.archivos(ft.id)).length === 2)
  falso.programar(A.taxId, 'auth')
  const fx = await A.doc('FACTURA')
  await worker()
  const dFx = await A.d(fx.id), filaX = (await A.fila(fx.id))!
  check('>>> si SUNAT rechaza el ACCESO es un problema de configuración: el comprobante NO se rechaza, queda PENDIENTE y se dice por qué (sin secretos)', dFx.status === 'PENDIENTE' && /acceso/i.test(filaX.lastError ?? '') && !(filaX.lastError ?? '').includes(SOL) && (await A.archivos(fx.id)).length === 0)

  // Una consulta tardía: el comprobante figura ENVIADO sin su constancia, y SUNAT ya lo conoce.
  await prisma.taxDocumentFile.deleteMany({ where: { taxDocumentId: fa.id, kind: 'CDR' } })
  await prisma.taxDocument.update({ where: { id: fa.id }, data: { status: 'ENVIADO' } })
  const consulta = await consultarInterno(A.db, { tenantId: A.t.id, id: null, role: null, origen: 'cola' }, fa.id, { urlSunat: falso.url })
  const trasConsulta = await A.archivos(fa.id)
  check('>>> una consulta tardía acepta el comprobante y guarda su CDR sin tocar el XML ya guardado', consulta.estado === 'ACEPTADO' && (await A.d(fa.id)).status === 'ACEPTADO' && trasConsulta.map((x) => x.kind).sort().join() === 'CDR,XML_FIRMADO' && Buffer.compare(trasConsulta.find((x) => x.kind === 'XML_FIRMADO')!.content, xmlF.content) === 0)

  console.log('\n3) Sin credenciales, ambiente de pruebas y modos')
  const B = await negocio('b', { credenciales: false })
  const fb = await B.doc('FACTURA')
  await worker()
  check('>>> sin credenciales de SUNAT el comprobante queda PENDIENTE con un mensaje claro', (await B.d(fb.id)).status === 'PENDIENTE' && /credenciales de SUNAT/.test((await B.fila(fb.id))!.lastError ?? ''))
  const C = await negocio('c')
  const fc = await C.doc('FACTURA')
  const llamadasAntes = falso.recibidas.length
  await ejecutarWorker({ reloj: () => new Date(), deps: {}, presupuestoMs: 600_000, margenEnvioMs: 0 })
  check('>>> en el ambiente de PRUEBAS (BETA) los comprobantes reales NO se envían: quedan PENDIENTES y no sale nada hacia SUNAT', (await C.d(fc.id)).status === 'PENDIENTE' && /ambiente de PRUEBAS/.test((await C.fila(fc.id))!.lastError ?? '') && falso.recibidas.length === llamadasAntes)
  await prisma.tenant.update({ where: { id: C.t.id }, data: { realBillingPausedAt: new Date() } })
  const fp = await C.doc('FACTURA')
  await worker()
  check('>>> con el envío PAUSADO no sale nada (el modo fiscal sigue mandando)', (await C.d(fp.id)).status === 'PENDIENTE' && falso.recibidas.every((r) => r.usuario !== `${C.taxId}USERSOL1`))
  const ftr = await A.doc('FACTURA')
  await prisma.taxDocument.update({ where: { id: ftr.id }, data: { isTrial: true, series: 'PF001', fullNumber: 'PF001-00000099' } })
  const llamadas2 = falso.recibidas.length
  await worker()
  check('>>> un documento de PRUEBA jamás se envía, ni con la facturación real habilitada y credenciales cargadas', (await A.d(ftr.id)).status === 'PENDIENTE' && falso.recibidas.length === llamadas2 && (await A.archivos(ftr.id)).length === 0)

  console.log('\n4) Los archivos: inmutables, aislados y con integridad')
  const antesXml = xmlF.content
  await guardarArchivosFiscales(A.db, A.t.id, fa.id, { xmlFirmado: '<otro/>', cdrXml: '<otro/>' })
  const trasReintento = (await A.archivos(fa.id)).find((x) => x.kind === 'XML_FIRMADO')!
  check('>>> guardar de nuevo NO reemplaza lo que SUNAT recibió la primera vez', Buffer.compare(trasReintento.content, antesXml) === 0)
  check('>>> y la base impide modificarlos a mano (disparador)', await code(prisma.taxDocumentFile.update({ where: { id: xmlF.id }, data: { content: Buffer.from('x') } })) !== null && await code(prisma.taxDocumentFile.update({ where: { id: xmlF.id }, data: { sha256: 'a'.repeat(64) } })) !== null)
  check('>>> hash mal formado, tamaño cero o descomunal, o un segundo XML del mismo comprobante, se rechazan', await code(prisma.taxDocumentFile.create({ data: { tenantId: A.t.id, taxDocumentId: fb.id, kind: 'CDR', content: Buffer.from('x'), sha256: 'corto', size: 1 } })) !== null && await code(prisma.taxDocumentFile.create({ data: { tenantId: A.t.id, taxDocumentId: bo.id, kind: 'CDR', content: Buffer.from('x'), sha256: 'a'.repeat(64), size: 0 } })) !== null && await code(prisma.taxDocumentFile.create({ data: { tenantId: A.t.id, taxDocumentId: bo.id, kind: 'XML_FIRMADO', content: Buffer.from('x'), sha256: 'a'.repeat(64), size: 1 } })) !== null)
  check('>>> un archivo de un comprobante de OTRO negocio no se puede crear (clave compuesta)', await code(prisma.taxDocumentFile.create({ data: { tenantId: B.t.id, taxDocumentId: fa.id, kind: 'CDR', content: Buffer.from('x'), sha256: 'a'.repeat(64), size: 1 } })) !== null)
  const leido = await leerArchivoFiscal(A.db, A.ctx, fa.id, 'XML_FIRMADO')
  check('>>> el dueño lo descarga: nombre F001-N.xml, contenido idéntico y su huella', leido.contenido === xmlTexto && leido.nombre === `${fa.fullNumber}.xml` && leido.sha256 === xmlF.sha256 && (await leerArchivoFiscal(A.db, A.ctx, fa.id, 'CDR')).nombre === `R-${fa.fullNumber}.xml`)
  const almacenero = { ...A.ctx, role: 'ALMACENERO' as Role }
  check('>>> quien no emite comprobantes ni ve reportes NO lo descarga; otro negocio ni lo ve (NOT_FOUND)', await code(leerArchivoFiscal(getTenantPrisma(almacenero), almacenero, fa.id, 'XML_FIRMADO')) === 'FORBIDDEN_ROLE' && await code(leerArchivoFiscal(B.db, B.ctx, fa.id, 'XML_FIRMADO')) === 'NOT_FOUND')
  check('>>> un comprobante sin respuesta de SUNAT no tiene archivos que descargar', await code(leerArchivoFiscal(A.db, A.ctx, fx.id, 'CDR')) === 'NOT_FOUND')
  await prisma.taxDocumentFile.create({ data: { tenantId: B.t.id, taxDocumentId: fb.id, kind: 'XML_FIRMADO', content: gzipSync(Buffer.from('contenido')), sha256: sha256('otro contenido'), size: 9 } })
  const dañado = await leerArchivoFiscal(B.db, B.ctx, fb.id, 'XML_FIRMADO').then(() => '', (e) => String(e.message))
  check('>>> si la huella no coincide con el contenido, NO se entrega como si estuviera bien', /huella/.test(dañado))
  const ruta = readFileSync('src/app/api/comprobantes/[id]/archivo/route.ts', 'utf8')
  check('>>> la ruta de descarga exige sesión (401), oculta lo que no se puede ver (404) y entrega como adjunto sin caché', /status: 401/.test(ruta) && /FORBIDDEN_ROLE' \|\| e\.code === 'NOT_FOUND' \? 404/.test(ruta) && /attachment/.test(ruta) && /no-store/.test(ruta) && /nosniff/.test(ruta))

  console.log('\n5) Plazos y retiro del PSE')
  check('>>> los plazos del dueño son constantes con nombre (3, 7 y 5)', PLAZO_ENVIO_DIAS === 3 && PLAZO_BAJA_DIAS === 7 && CONSERVACION_ANIOS === 5)
  check('>>> el aviso CRÍTICO de comprobantes sin enviar coincide con el plazo de envío (3 días = 72 h)', UMBRAL_CRITICO_POR_DEFECTO_HORAS === PLAZO_ENVIO_DIAS * 24)
  const codigo = ['src/features/invoicing/envio.ts', 'src/features/invoicing/providers/index.ts', 'src/features/invoicing/actions.ts'].map((f) => readFileSync(f, 'utf8')).join('\n')
  check('>>> el código del PSE ya no existe (sin pse-rest, pse-config ni sus acciones)', !/pse-rest|pse-config|credencialesPseDelNegocio|guardarProveedorPse/.test(codigo))
  await falso.detener()
  await prisma.tenant.deleteMany({ where: { id: { in: [A.t.id, B.t.id, C.t.id] } } })
}

async function main() {
  try { await cuerpo() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? (e.stack ?? e.message).slice(0, 500) : e}`, false) }
  Object.assign(process.env, { SECRETOS_CLAVES: antes.c, SECRETOS_CLAVE_ACTUAL: antes.a })
  for (const k of ['SECRETOS_CLAVES', 'SECRETOS_CLAVE_ACTUAL'] as const) if (process.env[k] === undefined || process.env[k] === 'undefined') delete process.env[k]
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
