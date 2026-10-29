import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { diaLocal } from '../src/lib/periodos'
import { guardarCredencialesSunat } from '../src/features/sunat/credenciales'
import { guardarArchivosBaja, leerArchivoBaja, sha256 } from '../src/features/sunat/archivos'
import { verificarFirmaXml } from '../src/features/sunat/firma'
import { construirXmlBaja, identificadorDeBaja, MOTIVO_BAJA_MAX } from '../src/features/sunat/baja-xml'
import { dentroDelPlazoDeBaja, diasEntre, PLAZO_BAJA_DIAS } from '../src/features/sunat/plazos'
import { motivoDeNoBaja, reintentarBaja, solicitarBajaComprobante, bajasDeComprobantes, type EntradaBaja } from '../src/features/sunat/baja'
import { crearProveedorSunatDirecto } from '../src/features/sunat/proveedor'
import type { CredencialesProveedor, SolicitudBaja } from '../src/features/invoicing/providers/types'
import { ejecutarWorker } from '../src/features/cola-fiscal/worker'
import { procesarBaja } from '../src/features/cola-fiscal/procesar-baja'
import { reclamarBaja } from '../src/features/cola-fiscal/repositorio'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { generarCertificadoDePrueba } from './falsos/certificado-prueba'
import { iniciarSunatFalso } from './falsos/sunat-falso'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * S4 · Comunicación de baja: reglas puras (plazo de 7 días calendario, qué se puede dar de baja), el XML, el proveedor contra el SUNAT falso y, de punta a punta con la base y la
 * cola real, la solicitud → envío → ticket → consulta → comprobante ANULADO, con el XML firmado y el CDR guardados e inmutables. ⚠️ Prueba NUESTRA mecánica contra un falso:
 * no que SUNAT acepte el XML ni el nombre RA-… (docs/SUNAT-SUPUESTOS.md).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '', (e) => String(e.message))
const mas = (d: Date, s: number) => new Date(d.getTime() + s * 1000)
const DIA = 86_400_000

const SOL = 'ClaveSol-Secreta-7Z', CLAVE_PFX = 'Clave-Pfx-Secreta-9X'
const antes = { c: process.env.SECRETOS_CLAVES, a: process.env.SECRETOS_CLAVE_ACTUAL }

const base: EntradaBaja = { documentType: 'FACTURA', series: 'F001', isTrial: false, status: 'ACEPTADO', diaEmision: '2026-10-20', diaHoy: '2026-10-22', bajaPrevia: null, notasVivas: 0 }

async function cuerpo() {
  process.env.SECRETOS_CLAVES = JSON.stringify({ a: Buffer.alloc(32, 7).toString('base64') })
  process.env.SECRETOS_CLAVE_ACTUAL = 'a'

  console.log('\n1) Plazo de 7 días calendario y qué se puede dar de baja (puro)')
  check('el plazo del dueño es 7 y es una constante con nombre', PLAZO_BAJA_DIAS === 7)
  check('>>> diasEntre cuenta días calendario, también entre meses y años', diasEntre('2026-10-20', '2026-10-27') === 7 && diasEntre('2026-10-29', '2026-11-05') === 7 && diasEntre('2026-12-30', '2027-01-02') === 3 && diasEntre('2026-10-29', '2026-10-29') === 0 && diasEntre('2026-10-29', '2026-10-28') === -1)
  check('>>> el día 7 todavía vale y el día 8 ya no (estricto)', dentroDelPlazoDeBaja('2026-10-20', '2026-10-27') && !dentroDelPlazoDeBaja('2026-10-20', '2026-10-28') && dentroDelPlazoDeBaja('2026-10-20', '2026-10-20'))
  check('el mismo día de emisión y un reloj atrasado (negativo) no bloquean', dentroDelPlazoDeBaja('2026-10-20', '2026-10-19'))
  check('>>> una factura aceptada dentro del plazo SÍ se puede dar de baja', motivoDeNoBaja(base) === null)
  check('una factura observada también', motivoDeNoBaja({ ...base, status: 'OBSERVADO' }) === null)
  check('una nota de serie F también (nota de una factura)', motivoDeNoBaja({ ...base, documentType: 'NOTA_CREDITO', series: 'FC01' }) === null)
  check('>>> una boleta NO (va en el resumen diario)', /resumen diario/.test(motivoDeNoBaja({ ...base, documentType: 'BOLETA', series: 'B001' }) ?? ''))
  check('una nota de una boleta tampoco', /resumen diario/.test(motivoDeNoBaja({ ...base, documentType: 'NOTA_CREDITO', series: 'BC01' }) ?? ''))
  check('una nota de venta tampoco', motivoDeNoBaja({ ...base, documentType: 'NOTA_VENTA' }) !== null)
  check('>>> un documento de PRUEBA nunca', /prueba/.test(motivoDeNoBaja({ ...base, isTrial: true }) ?? ''))
  for (const s of ['PENDIENTE', 'ENVIADO', 'RECHAZADO', 'ANULADO'] as const) check(`un comprobante ${s} no se da de baja`, motivoDeNoBaja({ ...base, status: s }) !== null)
  check('>>> vencido el plazo se dice cuántos días pasaron y se manda a la nota de crédito', /Venció el plazo de 7 días.*hace 8 días.*nota de crédito/.test(motivoDeNoBaja({ ...base, diaEmision: '2026-10-14', diaHoy: '2026-10-22' }) ?? ''))
  for (const s of ['PENDIENTE', 'ENVIADA', 'ACEPTADA']) check(`con una baja ${s} ya en curso no se pide otra`, /baja en curso/.test(motivoDeNoBaja({ ...base, bajaPrevia: { status: s, ticket: null } }) ?? ''))
  check('con una baja RECHAZADA sí se puede volver a pedir', motivoDeNoBaja({ ...base, bajaPrevia: { status: 'RECHAZADA', ticket: 'T1' } }) === null)
  check('una baja AGOTADA sin ticket permite pedir otra; con ticket NO (se reintenta la consulta)', motivoDeNoBaja({ ...base, bajaPrevia: { status: 'AGOTADA', ticket: null } }) === null && /reintenta su consulta/.test(motivoDeNoBaja({ ...base, bajaPrevia: { status: 'AGOTADA', ticket: 'T1' } }) ?? ''))
  check('>>> con una nota viva no se da de baja (la corrige la nota)', /nota/.test(motivoDeNoBaja({ ...base, notasVivas: 1 }) ?? ''))

  console.log('\n2) Identificador y XML de la baja (puro)')
  check('el identificador es RA-AAAAMMDD-N', identificadorDeBaja('2026-10-29', 3) === 'RA-20261029-3')
  check('un día o un número inválidos se rechazan', await code(Promise.resolve().then(() => identificadorDeBaja('29-10-2026', 1))) === 'BajaInvalida' && await code(Promise.resolve().then(() => identificadorDeBaja('2026-10-29', 0))) === 'BajaInvalida')
  const sol: SolicitudBaja = { identificador: 'RA-20261029-1', fechaGeneracion: '2026-10-29', fechaEmision: '2026-10-27', emisor: { ruc: '20123456789', razonSocial: 'FERRETERÍA <EL & CLAVO> SAC' }, tipoComprobante: '01', serie: 'F001', correlativo: 15, motivo: 'Error en el RUC del cliente' }
  const xml = construirXmlBaja(sol)
  check('>>> el XML es VoidedDocuments con su identificador, las dos fechas, el emisor y UNA línea del comprobante', /<VoidedDocuments /.test(xml) && xml.includes('<cbc:ID>RA-20261029-1</cbc:ID>') && xml.includes('<cbc:ReferenceDate>2026-10-27</cbc:ReferenceDate>') && xml.includes('<cbc:IssueDate>2026-10-29</cbc:IssueDate>') && xml.includes('<cbc:CustomerAssignedAccountID>20123456789</cbc:CustomerAssignedAccountID>') && (xml.match(/<sac:VoidedDocumentsLine>/g) ?? []).length === 1)
  check('la línea lleva tipo, serie, número (sin ceros) y motivo', xml.includes('<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode>') && xml.includes('<sac:DocumentSerialID>F001</sac:DocumentSerialID>') && xml.includes('<sac:DocumentNumberID>15</sac:DocumentNumberID>') && xml.includes('<sac:VoidReasonDescription>Error en el RUC del cliente</sac:VoidReasonDescription>'))
  check('>>> la razón social y el motivo se escapan (no rompen el XML)', xml.includes('FERRETERÍA &lt;EL &amp; CLAVO&gt; SAC') && construirXmlBaja({ ...sol, motivo: 'a <b> & "c"' }).includes('a &lt;b&gt; &amp; &quot;c&quot;'))
  check('lleva el hueco de la firma (ext:ExtensionContent) vacío', /<ext:ExtensionContent\/>/.test(xml))
  const malas: [string, Partial<SolicitudBaja>][] = [
    ['identificador mal formado', { identificador: 'RB-20261029-1' }], ['identificador de otro día', { identificador: 'RA-20261028-1' }], ['fecha mal escrita', { fechaEmision: '27/10/2026' }],
    ['RUC corto', { emisor: { ruc: '123', razonSocial: 'X' } }], ['motivo vacío', { motivo: '   ' }], ['motivo largo', { motivo: 'x'.repeat(MOTIVO_BAJA_MAX + 1) }],
    ['serie mal formada', { serie: 'F1' }], ['correlativo cero', { correlativo: 0 }],
  ]
  for (const [n, c] of malas) check(`${n}: BajaInvalida`, await code(Promise.resolve().then(() => construirXmlBaja({ ...sol, ...c }))) === 'BajaInvalida')
  check('un motivo de exactamente el máximo sí pasa', construirXmlBaja({ ...sol, motivo: 'x'.repeat(MOTIVO_BAJA_MAX) }).length > 0)

  console.log('\n3) Proveedor sunat-directo contra el SUNAT falso')
  const RUC = completarRuc('2011111111')
  const cert = generarCertificadoDePrueba({ ruc: RUC, clave: CLAVE_PFX })
  const falsoP = await iniciarSunatFalso({ usuarios: { [`${RUC}USERSOL1`]: SOL } })
  const cred: CredencialesProveedor = { usuario: '', clave: '', modoPruebas: true, urlBase: falsoP.url, certificadoBase64: cert.pfx.toString('base64'), claveCertificado: CLAVE_PFX, usuarioSol: 'USERSOL1', claveSol: SOL }
  const prov = crearProveedorSunatDirecto()
  const solP: SolicitudBaja = { ...sol, emisor: { ruc: RUC, razonSocial: 'FERRETERIA SAC' } }
  const e1 = await prov.comunicarBaja(solP, cred)
  const rec = falsoP.recibidas.find((r) => r.operacion === 'sendSummary')
  check('>>> comunicar envía por sendSummary un ZIP RUC-RA-AAAAMMDD-N con el XML FIRMADO (firma válida) y devuelve el ticket', e1.tipo === 'ticket' && !!e1.ticket && rec?.nombreZip === `${RUC}-RA-20261029-1.zip` && rec.firmaValida === true && /<VoidedDocuments /.test(rec.xml ?? ''))
  check('>>> el XML que devuelve es EXACTAMENTE el que recibió SUNAT', e1.tipo === 'ticket' && e1.xmlFirmado === rec?.xml && verificarFirmaXml(e1.xmlFirmado).valida)
  const e1b = await prov.comunicarBaja(solP, cred)
  check('>>> reenviar la MISMA comunicación devuelve el mismo ticket (idempotente por identificador)', e1b.tipo === 'ticket' && e1.tipo === 'ticket' && e1b.ticket === e1.ticket)
  const t = e1.tipo === 'ticket' ? e1.ticket : ''
  const c1 = await prov.consultarBaja(t, RUC, cred)
  check('>>> la primera consulta del ticket dice «en proceso»', c1.tipo === 'en_proceso')
  const c2 = await prov.consultarBaja(t, RUC, cred)
  check('>>> la siguiente trae el CDR: aceptada, con su código 0 y el XML de la constancia', c2.tipo === 'resuelta' && c2.aceptada && c2.codigo === '0' && /ApplicationResponse/.test(c2.cdrXml))
  falsoP.programar(RUC, 'rechazo')
  const e2 = await prov.comunicarBaja({ ...solP, identificador: 'RA-20261029-2' }, cred)
  await prov.consultarBaja(e2.tipo === 'ticket' ? e2.ticket : '', RUC, cred)
  const c3 = await prov.consultarBaja(e2.tipo === 'ticket' ? e2.ticket : '', RUC, cred)
  check('>>> un CDR de rechazo NO se toma por aceptado (aceptada=false, con su código)', c3.tipo === 'resuelta' && !c3.aceptada && c3.codigo === '3030')
  falsoP.programar(RUC, 'observado')
  const e3 = await prov.comunicarBaja({ ...solP, identificador: 'RA-20261029-3' }, cred)
  await prov.consultarBaja(e3.tipo === 'ticket' ? e3.ticket : '', RUC, cred)
  const c4 = await prov.consultarBaja(e3.tipo === 'ticket' ? e3.ticket : '', RUC, cred)
  check('una baja aceptada con observaciones sigue siendo aceptada, y las notas viajan en el mensaje', c4.tipo === 'resuelta' && c4.aceptada && /4252/.test(c4.mensaje))
  falsoP.programar(RUC, 'invalido')
  const e4 = await prov.comunicarBaja({ ...solP, identificador: 'RA-20261029-4' }, cred)
  check('>>> un error de contenido de SUNAT al enviar es un RECHAZO definitivo, con su código, y conserva el XML enviado', e4.tipo === 'rechazo' && e4.codigo === '0305' && /<VoidedDocuments /.test(e4.xmlFirmado))
  for (const esc of ['http500', 'servidor', 'ilegible'] as const) {
    falsoP.programar(RUC, esc)
    const r = await prov.comunicarBaja({ ...solP, identificador: 'RA-20261029-5' }, cred)
    check(`>>> sin respuesta utilizable (${esc}) es TRANSITORIO, nunca rechazo ni ticket`, r.tipo === 'transitorio')
  }
  falsoP.programar(RUC, 'auth')
  check('>>> usuario o clave SOL incorrectos al enviar: error de CONFIGURACIÓN, no rechazo de la baja', await code(prov.comunicarBaja({ ...solP, identificador: 'RA-20261029-6' }, cred)) === 'ErrorConfiguracionProveedor')
  falsoP.programar(RUC, 'auth')
  check('lo mismo al consultar el ticket', await code(prov.consultarBaja(t, RUC, cred)) === 'ErrorConfiguracionProveedor')
  falsoP.programar(RUC, 'http500')
  check('una consulta que falla no resuelve nada (transitorio)', (await prov.consultarBaja(t, RUC, cred)).tipo === 'transitorio')
  const desconocido = await prov.consultarBaja('9999999', RUC, cred)
  check('>>> un ticket que SUNAT no reconoce NO se da por rechazada la baja: se vuelve a preguntar', desconocido.tipo === 'transitorio')
  check('sin certificado o con otro RUC no se firma ni se envía', await code(prov.comunicarBaja(solP, { ...cred, certificadoBase64: undefined })) === 'ErrorConfiguracionProveedor' && await code(prov.comunicarBaja({ ...solP, emisor: { ruc: completarRuc('2099999999'), razonSocial: 'OTRO' } }, cred)) === 'ErrorConfiguracionProveedor')
  check('la baja de una sola llamada (`anular`) no existe para SUNAT directo', await code(prov.anular({ idExterno: null, serie: 'F001', correlativo: 1, tipoComprobante: '01' }, 'x', cred)) === 'ErrorConfiguracionProveedor')
  await falsoP.detener()

  console.log('\n4) De punta a punta: base, cola y permisos')
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  async function negocio(tag: string, o: { ambiente?: 'BETA' | 'PRODUCCION'; modo?: 'REAL' | 'ENSAYO' | 'DEMO' } = {}) {
    const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
    const t = await prisma.tenant.create({ data: { slug: `sb-${tag}-${randomUUID().slice(0, 6)}`, name: `Baja ${tag}`, legalName: `BAJA ${tag.toUpperCase()} SAC`, taxId, planId: plan.id, isDemo: o.modo === 'DEMO', realBillingEnabledAt: o.modo === 'ENSAYO' ? null : new Date(Date.now() - 30 * DIA) } })
    await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_sb' } })
    const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
    const mk = async (role: Role) => { const u = await prisma.user.create({ data: { tenantId: t.id, email: `u-${randomUUID()}@x.com`, name: role, role } }); await asignarSucursal(t.id, u.id, branch.id); return u }
    const [owner, adm, caj] = [await mk('OWNER'), await mk('ADMIN'), await mk('CAJERO')]
    const ctxDe = (u: { id: string }, role: Role): TenantContext => ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: branch.id, branchIds: [branch.id], permisosExtra: [] })
    const ctx = ctxDe(owner, 'OWNER'), ctxAdm = ctxDe(adm, 'ADMIN'), ctxCaj = ctxDe(caj, 'CAJERO')
    const db = getTenantPrisma(ctx)
    const p = await prisma.product.create({ data: { tenantId: t.id, sku: 'P', name: 'Cemento', salePrice: 11.8 } })
    if (o.modo !== 'ENSAYO' && o.modo !== 'DEMO') {
      const c = generarCertificadoDePrueba({ ruc: taxId, clave: CLAVE_PFX })
      await guardarCredencialesSunat(db, ctx, { pfxBase64: c.pfx.toString('base64'), claveCertificado: CLAVE_PFX, usuarioSol: 'USERSOL1', claveSol: SOL })
      if (o.ambiente) await prisma.sunatCredential.update({ where: { tenantId: t.id }, data: { ambiente: o.ambiente } })
    }
    let n = 0
    const doc = async (tipo: 'FACTURA' | 'BOLETA' = 'FACTURA', status: 'ACEPTADO' | 'PENDIENTE' | 'RECHAZADO' = 'ACEPTADO', o2: { hace?: number; trial?: boolean } = {}) => {
      const sale = await prisma.sale.create({ data: { tenantId: t.id, branchId: branch.id, warehouseId: w.id, userId: owner.id, number: `V-${tag}-${randomUUID().slice(0, 6)}`, status: 'COMPLETADA' } })
      await prisma.saleItem.create({ data: { tenantId: t.id, saleId: sale.id, productId: p.id, nameSnapshot: 'Cemento', skuSnapshot: 'P', quantity: 1, unitPrice: 11.8, lineTotal: 11.8 } })
      n++
      const serie = o2.trial ? 'PF001' : tipo === 'FACTURA' ? 'F001' : 'B001'
      return prisma.taxDocument.create({ data: {
        tenantId: t.id, saleId: sale.id, documentType: tipo, series: serie, correlativo: n, fullNumber: `${serie}-${String(n).padStart(8, '0')}`, status, isTrial: o2.trial ?? false,
        receiverDocType: 'RUC', receiverDocNumber: completarRuc('2055555555'), receiverName: 'CLIENTE', issuerTaxId: taxId, issuerLegalName: 'BAJA SAC',
        subtotal: 10, taxTotal: 1.8, total: 11.8, issuedAt: new Date(Date.now() - (o2.hace ?? 0) * DIA - 600_000),
      } })
    }
    const nota = async (orig: { id: string; saleId: string }, status: 'ACEPTADO' | 'RECHAZADO') => {
      n++
      return prisma.taxDocument.create({ data: { tenantId: t.id, saleId: orig.saleId, documentType: 'NOTA_CREDITO', series: 'FC01', correlativo: n, fullNumber: `FC01-${String(n).padStart(8, '0')}`, status, relatedDocumentId: orig.id, reasonCode: '06', reasonDescription: 'Devolución total', receiverDocType: 'RUC', receiverDocNumber: completarRuc('2055555555'), receiverName: 'CLIENTE', subtotal: 10, taxTotal: 1.8, total: 11.8 } })
    }
    return {
      t, taxId, ctx, ctxAdm, ctxCaj, db, doc, nota,
      d: (id: string) => prisma.taxDocument.findUniqueOrThrow({ where: { id } }),
      v: (id: string) => prisma.taxVoid.findFirstOrThrow({ where: { taxDocumentId: id }, orderBy: { createdAt: 'desc' } }),
      vs: (id: string) => prisma.taxVoid.findMany({ where: { taxDocumentId: id }, orderBy: { seq: 'asc' } }),
      archivos: (voidId: string) => prisma.taxVoidFile.findMany({ where: { taxVoidId: voidId }, orderBy: { kind: 'asc' } }),
    }
  }
  const A = await negocio('a'), B = await negocio('b')
  const falso = await iniciarSunatFalso({ usuarios: { [`${A.taxId}USERSOL1`]: SOL, [`${B.taxId}USERSOL1`]: SOL } })
  const worker = (t0 = new Date(), urlSunat: string | null = falso.url) => ejecutarWorker({ reloj: () => t0, deps: urlSunat ? { urlSunat } : {}, presupuestoMs: 600_000, margenEnvioMs: 0 })
  const hoy = diaLocal(A.t.timezone, new Date())
  const resumenes = () => falso.recibidas.filter((r) => r.operacion === 'sendSummary')
  const MOTIVO = 'Error en el RUC del cliente'
  // Cada bloque cuenta lo que SUNAT recibe: se cierran a mano las bajas vivas de los bloques anteriores para que el worker no las mezcle.
  const cierra = () => prisma.taxVoid.updateMany({ where: { tenant: { slug: { startsWith: 'sb-' } }, status: { in: ['PENDIENTE', 'ENVIADA'] } }, data: { status: 'RECHAZADA' } })

  console.log('\n4a) Permisos y validaciones de la solicitud')
  const fa = await A.doc()
  check('>>> el cajero NO puede pedir una baja (FORBIDDEN_ROLE) y no se escribe nada', await code(solicitarBajaComprobante(getTenantPrisma(A.ctxCaj), A.ctxCaj, fa.id, MOTIVO)) === 'FORBIDDEN_ROLE' && (await A.vs(fa.id)).length === 0)
  check('>>> durante una suplantación de soporte tampoco', await code(solicitarBajaComprobante(A.db, { ...A.ctx, impersonationId: 'imp-1' }, fa.id, MOTIVO)) === 'FORBIDDEN_ROLE' && (await A.vs(fa.id)).length === 0)
  check('el motivo vacío o demasiado largo se rechaza', await code(solicitarBajaComprobante(A.db, A.ctx, fa.id, '   ')) === 'INVALID_DOCUMENT' && await code(solicitarBajaComprobante(A.db, A.ctx, fa.id, 'x'.repeat(MOTIVO_BAJA_MAX + 1))) === 'INVALID_DOCUMENT')
  check('un comprobante que no existe (o es de otro negocio) es NOT_FOUND', await code(solicitarBajaComprobante(B.db, B.ctx, fa.id, MOTIVO)) === 'NOT_FOUND' && await code(solicitarBajaComprobante(A.db, A.ctx, 'no-existe', MOTIVO)) === 'NOT_FOUND')
  const bo = await A.doc('BOLETA')
  check('>>> una boleta se rechaza con el motivo del resumen diario', /resumen diario/.test(await msg(solicitarBajaComprobante(A.db, A.ctx, bo.id, MOTIVO))))
  const pen = await A.doc('FACTURA', 'PENDIENTE'), rech = await A.doc('FACTURA', 'RECHAZADO'), ensayo = await A.doc('FACTURA', 'ACEPTADO', { trial: true })
  check('una factura que SUNAT no aceptó (pendiente o rechazada) no se da de baja', await code(solicitarBajaComprobante(A.db, A.ctx, pen.id, MOTIVO)) === 'INVALID_DOCUMENT' && await code(solicitarBajaComprobante(A.db, A.ctx, rech.id, MOTIVO)) === 'INVALID_DOCUMENT')
  check('>>> un documento de prueba no se da de baja', /prueba/.test(await msg(solicitarBajaComprobante(A.db, A.ctx, ensayo.id, MOTIVO))))
  const f7 = await A.doc('FACTURA', 'ACEPTADO', { hace: 7 }), f8 = await A.doc('FACTURA', 'ACEPTADO', { hace: 8 })
  check('>>> emitida hace 7 días todavía se puede; hace 8 ya no (y no se escribe nada)', (await solicitarBajaComprobante(A.db, A.ctx, f7.id, MOTIVO)).identificador.startsWith(`RA-${hoy.replace(/-/g, '')}-`) && /Venció el plazo/.test(await msg(solicitarBajaComprobante(A.db, A.ctx, f8.id, MOTIVO))) && (await A.vs(f8.id)).length === 0)
  const fn = await A.doc(), nv = await A.nota(fn, 'ACEPTADO')
  check('>>> con una nota de crédito viva no se pide la baja', /nota/.test(await msg(solicitarBajaComprobante(A.db, A.ctx, fn.id, MOTIVO))))
  await prisma.taxDocument.update({ where: { id: nv.id }, data: { status: 'RECHAZADO' } })
  check('con la nota RECHAZADA sí', (await solicitarBajaComprobante(A.db, A.ctxAdm, fn.id, MOTIVO)).identificador.length > 0)
  const ens = await negocio('ens', { modo: 'ENSAYO' }), dem = await negocio('dem', { modo: 'DEMO' })
  check('>>> un negocio en ENSAYO o una cuenta DEMO no comunican bajas', await code(solicitarBajaComprobante(ens.db, ens.ctx, (await ens.doc()).id, MOTIVO)) === 'INVALID_DOCUMENT' && await code(solicitarBajaComprobante(dem.db, dem.ctx, (await dem.doc()).id, MOTIVO)) === 'INVALID_DOCUMENT')

  await cierra()
  console.log('\n4b) Solicitud → envío → ticket → consulta → ANULADO, por la cola real')
  const fb = await A.doc()
  const t0 = new Date()
  const sol1 = await solicitarBajaComprobante(A.db, A.ctx, fb.id, MOTIVO, { ahora: t0 })
  const v0 = await A.v(fb.id)
  check('>>> la solicitud queda PENDIENTE con su identificador RA-hoy-N, el motivo y quién la pidió; el comprobante no cambia', v0.status === 'PENDIENTE' && v0.identifier === sol1.identificador && v0.issueDay === hoy && v0.reason === MOTIVO && v0.requestedBy === A.ctx.userId && v0.attempts === 0 && v0.ticket === null && (await A.d(fb.id)).status === 'ACEPTADO')
  const antesEnvios = resumenes().length
  const w1 = await worker(t0)
  const v1 = await A.v(fb.id)
  check('>>> el worker la ENVÍA: queda ENVIADA con el ticket de SUNAT, y SUNAT recibió un sendSummary firmado', w1.bajas.procesadas >= 1 && v1.status === 'ENVIADA' && !!v1.ticket && resumenes().length === antesEnvios + 1 && resumenes().at(-1)!.nombreZip === `${A.taxId}-${sol1.identificador}.zip` && resumenes().at(-1)!.firmaValida === true)
  check('el envío gastó UN intento y los intentos se reinician para la consulta; la próxima revisión es en 60 s y no hay lease', v1.attempts === 0 && v1.sentAt !== null && Math.abs(v1.nextAttemptAt.getTime() - (t0.getTime() + 60_000)) < 2000 && v1.lockedBy === null && v1.lockedUntil === null)
  const a1 = await A.archivos(v1.id)
  check('>>> el XML firmado se guardó EN ESTE momento, igual al que recibió SUNAT, con huella y tamaño del contenido sin comprimir', a1.length === 1 && a1[0]!.kind === 'XML_FIRMADO' && a1[0]!.sha256 === sha256(resumenes().at(-1)!.xml!))
  check('>>> el comprobante sigue ACEPTADO mientras SUNAT no confirme la baja', (await A.d(fb.id)).status === 'ACEPTADO' && (await A.d(fb.id)).voidedAt === null)
  const w2 = await worker(mas(t0, 30))
  check('antes de la hora de revisión no se hace nada', w2.bajas.procesadas === 0 && (await A.v(fb.id)).attempts === 0)
  const w3 = await worker(mas(t0, 61))
  const v3 = await A.v(fb.id)
  check('>>> «en proceso» en SUNAT NO resuelve nada: sigue ENVIADA, gasta un intento y se vuelve a preguntar más tarde', w3.bajas.reintentos === 1 && v3.status === 'ENVIADA' && v3.attempts === 1 && /procesando/.test(v3.lastError ?? '') && v3.nextAttemptAt.getTime() > mas(t0, 61).getTime() && (await A.d(fb.id)).status === 'ACEPTADO')
  const w4 = await worker(mas(t0, 125))
  const v4 = await A.v(fb.id), d4 = await A.d(fb.id)
  check('>>> con el CDR aceptado la baja queda ACEPTADA (código 0) y el comprobante pasa a ANULADO, con la fecha y el motivo', w4.bajas.completadas === 1 && v4.status === 'ACEPTADA' && v4.responseCode === '0' && v4.resolvedAt !== null && d4.status === 'ANULADO' && d4.voidedAt !== null && d4.voidReason === MOTIVO && /RA-/.test(d4.statusMessage ?? ''))
  const a4 = await A.archivos(v4.id)
  check('>>> se guardaron los DOS archivos de la baja: el XML enviado y el CDR del ticket', a4.map((a) => a.kind).sort().join() === 'CDR,XML_FIRMADO' && a4.every((a) => /^[0-9a-f]{64}$/.test(a.sha256)))
  const xmlBaja = await leerArchivoBaja(A.db, A.ctx, fb.id, 'XML_FIRMADO'), cdrBaja = await leerArchivoBaja(A.db, A.ctx, fb.id, 'CDR')
  check('>>> se descargan con su nombre RA-… y la huella coincide; el CDR es el ApplicationResponse', xmlBaja.nombre === `${sol1.identificador}.xml` && cdrBaja.nombre === `R-${sol1.identificador}.xml` && /<VoidedDocuments /.test(xmlBaja.contenido) && /ApplicationResponse/.test(cdrBaja.contenido) && sha256(cdrBaja.contenido) === cdrBaja.sha256)
  check('>>> ni el XML ni el CDR guardados llevan secretos', ![xmlBaja.contenido, cdrBaja.contenido].some((x) => x.includes(SOL) || x.includes(CLAVE_PFX)))
  check('>>> un archivo de baja NO se puede modificar (disparador) y reescribirlo no cambia lo guardado', await code(prisma.taxVoidFile.update({ where: { id: a4[0]!.id }, data: { sha256: sha256('otra cosa') } })) !== null && await code(prisma.$transaction(async (tx) => { await guardarArchivosBaja(tx as never, A.t.id, v4.id, { xmlFirmado: '<otro/>', cdrXml: '<otro/>' }) })) === null && (await A.archivos(v4.id)).every((a, i) => a.sha256 === a4[i]!.sha256))
  const bajasMap = await bajasDeComprobantes(A.db, [fb.id])
  check('la pantalla ve la baja más reciente con su identificador y estado', bajasMap[fb.id]?.identificador === sol1.identificador && bajasMap[fb.id]?.status === 'ACEPTADA')
  check('>>> un comprobante ya ANULADO no admite otra baja', /anulado/.test(await msg(solicitarBajaComprobante(A.db, A.ctx, fb.id, MOTIVO))))
  const aud = await prisma.auditLog.findMany({ where: { tenantId: A.t.id, entityId: fb.id, action: { startsWith: 'baja.' } }, orderBy: { createdAt: 'asc' } })
  check('>>> la auditoría cuenta la historia (solicitada por la persona; enviada y aceptada por el sistema) sin ningún secreto', aud.map((a) => a.action).join() === 'baja.solicitada,baja.enviada,baja.aceptada' && aud[0]!.actorId === A.ctx.userId && aud[1]!.actorId === null && !JSON.stringify(aud).includes(SOL) && !JSON.stringify(aud).includes(CLAVE_PFX))
  const almacenero = await prisma.user.create({ data: { tenantId: A.t.id, email: `al-${randomUUID()}@x.com`, name: 'Alm', role: 'ALMACENERO' } })
  const ctxAlm: TenantContext = { ...A.ctx, userId: almacenero.id, role: 'ALMACENERO' }
  check('>>> quien no emite, ni ve reportes, ni da de baja NO descarga; otro negocio ni lo ve (NOT_FOUND)', await code(leerArchivoBaja(getTenantPrisma(ctxAlm), ctxAlm, fb.id, 'CDR')) === 'FORBIDDEN_ROLE' && await code(leerArchivoBaja(B.db, B.ctx, fb.id, 'CDR')) === 'NOT_FOUND' && (await B.db.taxVoid.findMany()).length === 0)
  check('un comprobante sin baja no tiene archivos de baja que descargar', await code(leerArchivoBaja(A.db, A.ctx, fa.id, 'CDR')) === 'NOT_FOUND')
  const idFn = (await A.v(fn.id)).id
  await prisma.taxVoidFile.create({ data: { tenantId: A.t.id, taxVoidId: idFn, kind: 'XML_FIRMADO', content: gzipSync(Buffer.from('contenido')), sha256: sha256('otro contenido'), size: 9 } })
  await prisma.taxVoidFile.create({ data: { tenantId: A.t.id, taxVoidId: idFn, kind: 'CDR', content: Buffer.from('1f8b', 'hex'), sha256: sha256('x'), size: 2 } })
  check('>>> si la huella no coincide con el contenido, NO se entrega como si estuviera bien', /huella/.test(await msg(leerArchivoBaja(A.db, A.ctx, fn.id, 'XML_FIRMADO'))))
  check('>>> un contenido que no se puede descomprimir tampoco', /dañado/.test(await msg(leerArchivoBaja(A.db, A.ctx, fn.id, 'CDR'))))

  console.log('\n4c) Desenlaces: rechazo, error de contenido, caída y reintentos')
  await cierra()
  falso.programar(A.taxId, 'rechazo')
  const fr = await A.doc()
  await solicitarBajaComprobante(A.db, A.ctx, fr.id, MOTIVO, { ahora: t0 })
  await worker(t0); await worker(mas(t0, 61)); await worker(mas(t0, 125))
  const vr = await A.v(fr.id)
  check('>>> si SUNAT rechaza la baja queda RECHAZADA con su código y motivo, el comprobante sigue ACEPTADO y se guardó el CDR', vr.status === 'RECHAZADA' && vr.responseCode === '3030' && (vr.responseMessage ?? '').length > 0 && (await A.d(fr.id)).status === 'ACEPTADO' && (await A.archivos(vr.id)).map((a) => a.kind).sort().join() === 'CDR,XML_FIRMADO')
  const otra = await solicitarBajaComprobante(A.db, A.ctx, fr.id, 'Segundo intento tras corregir')
  check('>>> tras un rechazo se puede volver a pedir, con un identificador NUEVO', otra.identificador !== vr.identifier && (await A.vs(fr.id)).length === 2)
  await cierra()
  check('la pantalla muestra la baja MÁS RECIENTE de un comprobante con varias', (await bajasDeComprobantes(A.db, [fr.id]))[fr.id]?.identificador === otra.identificador)
  falso.programar(A.taxId, 'invalido')
  const fi = await A.doc()
  await solicitarBajaComprobante(A.db, A.ctx, fi.id, MOTIVO, { ahora: t0 })
  await worker(t0)
  const vi = await A.v(fi.id)
  check('>>> un error de contenido al enviar cierra la baja como RECHAZADA al instante, con su código, el XML enviado y sin CDR; el comprobante intacto', vi.status === 'RECHAZADA' && vi.responseCode === '0305' && vi.ticket === null && (await A.archivos(vi.id)).map((a) => a.kind).join() === 'XML_FIRMADO' && (await A.d(fi.id)).status === 'ACEPTADO')
  await cierra()
  falso.programar(A.taxId, 'http500')
  const ft = await A.doc()
  await solicitarBajaComprobante(A.db, A.ctx, ft.id, MOTIVO, { ahora: t0 })
  const enviosAntes = resumenes().length
  await worker(t0)
  const vt = await A.v(ft.id)
  check('>>> un 500 de SUNAT NO es un rechazo: sigue PENDIENTE, gasta un intento, guarda el motivo y reprograma con la rampa (60 s)', vt.status === 'PENDIENTE' && vt.attempts === 1 && vt.ticket === null && (vt.lastError ?? '').length > 0 && Math.abs(vt.nextAttemptAt.getTime() - (t0.getTime() + 60_000)) < 2000 && (await A.archivos(vt.id)).length === 0)
  await worker(mas(t0, 61))
  const vt2 = await A.v(ft.id)
  const envios = resumenes().slice(enviosAntes)
  check('>>> el reintento usa el MISMO identificador (SUNAT lo reconoce como la misma comunicación) y esta vez recibe el ticket', vt2.status === 'ENVIADA' && vt2.identifier === vt.identifier && envios.length === 2 && envios[1]!.nombreZip === `${A.taxId}-${vt.identifier}.zip`)

  await cierra()
  falso.programar(A.taxId, 'http500', 'http500', 'http500', 'http500', 'http500', 'http500')
  const fg = await A.doc()
  await solicitarBajaComprobante(A.db, A.ctx, fg.id, MOTIVO, { ahora: t0 })
  let reloj = t0
  for (let i = 0; i < 6; i++) { await worker(reloj); reloj = mas(reloj, 13 * 3600) }
  const vg = await A.v(fg.id)
  check('>>> tras los 6 intentos sin respuesta queda AGOTADA (no «rechazada»), con el comprobante intacto y la alarma en la auditoría', vg.status === 'AGOTADA' && vg.attempts === 6 && vg.exhaustedAt !== null && (await A.d(fg.id)).status === 'ACEPTADO' && !!(await prisma.auditLog.findFirst({ where: { tenantId: A.t.id, entityId: fg.id, action: 'baja.agotada' } })))
  const w7 = await worker(reloj)
  check('una baja AGOTADA no se vuelve a tocar sola', w7.bajas.procesadas === 0 && (await A.v(fg.id)).attempts === 6)
  check('el cajero no puede reintentar una baja (FORBIDDEN_ROLE)', await code(reintentarBaja(getTenantPrisma(A.ctxCaj), A.ctxCaj, fg.id)) === 'FORBIDDEN_ROLE')
  await reintentarBaja(A.db, A.ctx, fg.id, { ahora: reloj })
  const vg2 = await A.v(fg.id)
  check('>>> reintentar la deja PENDIENTE con intentos en cero y la auditoría lo anota', vg2.status === 'PENDIENTE' && vg2.attempts === 0 && vg2.exhaustedAt === null && !!(await prisma.auditLog.findFirst({ where: { tenantId: A.t.id, entityId: fg.id, action: 'baja.reintentada' } })))
  await worker(reloj)
  check('y al procesarse recibe su ticket (mismo identificador)', (await A.v(fg.id)).status === 'ENVIADA' && (await A.v(fg.id)).identifier === vg.identifier)
  check('reintentar lo que no está agotado es NOT_FOUND', await code(reintentarBaja(A.db, A.ctx, fg.id)) === 'NOT_FOUND')
  await cierra()
  const fk = await A.doc()
  await solicitarBajaComprobante(A.db, A.ctx, fk.id, MOTIVO, { ahora: t0 })
  await prisma.taxVoid.updateMany({ where: { taxDocumentId: fk.id }, data: { status: 'AGOTADA', ticket: 'T-1', attempts: 6 } })
  check('>>> una baja AGOTADA CON ticket no se reemplaza por otra: se reintenta su consulta', /reintenta su consulta/.test(await msg(solicitarBajaComprobante(A.db, A.ctx, fk.id, MOTIVO))))
  await reintentarBaja(A.db, A.ctx, fk.id)
  check('y su reintento vuelve a CONSULTAR (ENVIADA), no a enviar', (await A.v(fk.id)).status === 'ENVIADA' && (await A.v(fk.id)).ticket === 'T-1')

  console.log('\n4d) El plazo, la configuración y lo que la cola nunca toca')
  await cierra()
  const fp = await A.doc()
  await solicitarBajaComprobante(A.db, A.ctx, fp.id, MOTIVO, { ahora: t0 })
  const antesPlazo = resumenes().length
  await worker(mas(t0, 8 * 86400))
  const vp = await A.v(fp.id)
  check('>>> si el plazo vence ANTES de que salga, se cierra RECHAZADA sin llamar a SUNAT, con el motivo, y el comprobante intacto', vp.status === 'RECHAZADA' && /Venció el plazo/.test(vp.responseMessage ?? '') && resumenes().length === antesPlazo && (await A.d(fp.id)).status === 'ACEPTADO')
  await cierra()
  const fa2 = await A.doc()
  await solicitarBajaComprobante(A.db, A.ctx, fa2.id, MOTIVO, { ahora: t0 })
  await prisma.taxDocument.update({ where: { id: fa2.id }, data: { status: 'ANULADO' } })
  const antesA = resumenes().length
  await worker(t0)
  check('>>> si el comprobante ya no está aceptado al momento de enviar, no se llama a SUNAT y se cierra con el motivo', (await A.v(fa2.id)).status === 'RECHAZADA' && /ya no está aceptado/.test((await A.v(fa2.id)).responseMessage ?? '') && resumenes().length === antesA)
  await cierra()
  const C = await negocio('c', { ambiente: 'BETA' })
  const fc = await C.doc()
  await solicitarBajaComprobante(C.db, C.ctx, fc.id, MOTIVO, { ahora: t0 })
  const antesC = falso.recibidas.length
  await worker(t0, null)
  const vc = await C.v(fc.id)
  check('>>> con la conexión en ambiente de PRUEBAS no sale nada: reintenta con el motivo a la vista y el comprobante intacto', vc.status === 'PENDIENTE' && vc.attempts === 1 && /PRUEBAS/.test(vc.lastError ?? '') && falso.recibidas.length === antesC && (await C.d(fc.id)).status === 'ACEPTADO')
  await prisma.tenant.update({ where: { id: C.t.id }, data: { realBillingPausedAt: new Date() } })
  const w8 = await worker(mas(t0, 3600), null)
  check('>>> con el envío PAUSADO la cola ni la reclama (intentos sin cambio)', (await C.v(fc.id)).attempts === 1 && w8.bajas.procesadas === 0)
  await prisma.tenant.update({ where: { id: C.t.id }, data: { realBillingPausedAt: null } })
  const D = await negocio('d')
  const fd = await D.doc('FACTURA', 'ACEPTADO', { trial: true })
  const vd = await prisma.taxVoid.create({ data: { tenantId: D.t.id, taxDocumentId: fd.id, issueDay: hoy, seq: 1, identifier: `RA-${hoy.replace(/-/g, '')}-1`, reason: MOTIVO } })
  const c9 = await reclamarBaja('w-t', mas(t0, 7200))
  await worker(mas(t0, 7200))
  check('>>> una baja de un documento de PRUEBA jamás se reclama, aunque alguien la inserte a mano', c9?.id !== vd.id && (await prisma.taxVoid.findUniqueOrThrow({ where: { id: vd.id } })).attempts === 0)

  console.log('\n4e) Concurrencia y cerco del lease')
  await cierra()
  const [x1, x2] = [await A.doc(), await A.doc()]
  const [r1, r2, r3] = await Promise.allSettled([solicitarBajaComprobante(A.db, A.ctx, x1.id, MOTIVO), solicitarBajaComprobante(A.db, A.ctx, x1.id, MOTIVO), solicitarBajaComprobante(A.db, A.ctx, x2.id, MOTIVO)])
  check('>>> dos pedidos simultáneos de la MISMA factura dejan UNA sola baja viva (la otra recibe un error claro)', [r1, r2].filter((r) => r.status === 'fulfilled').length === 1 && (await A.vs(x1.id)).length === 1)
  const ids = [r1, r2, r3].filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ identificador: string }>).value.identificador)
  check('>>> y pedidos simultáneos de facturas distintas reciben identificadores distintos', r3.status === 'fulfilled' && new Set(ids).size === ids.length)
  const E = await negocio('e')
  const fe = await E.doc()
  await solicitarBajaComprobante(E.db, E.ctx, fe.id, MOTIVO, { ahora: t0 })
  const t1 = mas(t0, 5)
  const [c1x, c2x] = await Promise.all([reclamarBaja('w1', t1), reclamarBaja('w2', t1)])
  check('>>> dos workers a la vez NO reclaman la misma baja', [c1x, c2x].filter((c) => c && c.taxDocumentId === fe.id).length <= 1 && (await E.v(fe.id)).attempts === 1)
  const mia = [c1x, c2x].find((c) => c?.taxDocumentId === fe.id)!
  const nueva = await reclamarBaja('w3', mas(t1, 200))
  check('vencido el lease otro worker la recupera y gasta otro intento', nueva?.taxDocumentId === fe.id && nueva.attempts === 2)
  const aEnviar = resumenes().length
  const rr = await procesarBaja(mia, { urlSunat: falso.url }, mas(t1, 201))
  check('>>> el worker viejo, con el lease ya reasignado, NO puede cerrar nada: «perdido», sin envíos ni cambios', rr !== 'completado' && (await E.v(fe.id)).status === 'PENDIENTE' && (await E.v(fe.id)).lockedBy === 'w3' && resumenes().length >= aEnviar && (await E.archivos((await E.v(fe.id)).id)).length === 0)

  console.log('\n4f) Pausa en carrera, worker caído y tope de filas')
  await cierra()
  const F = await negocio('f')
  const ff = await F.doc()
  await solicitarBajaComprobante(F.db, F.ctx, ff.id, 'x'.repeat(MOTIVO_BAJA_MAX), { ahora: t0 })
  check('un motivo de exactamente el máximo sí lo acepta el servicio', (await F.v(ff.id)).reason.length === MOTIVO_BAJA_MAX)
  const cf = await reclamarBaja('w-p', mas(t0, 10))
  await prisma.tenant.update({ where: { id: F.t.id }, data: { realBillingPausedAt: new Date() } })
  const enviosF = resumenes().length
  const rF = await procesarBaja(cf!, { urlSunat: falso.url }, mas(t0, 10))
  const vF = await F.v(ff.id)
  check('>>> si el negocio se pausó entre el reclamo y el proceso, se LIBERA sin gastar el intento y sin llamar a SUNAT', cf?.taxDocumentId === ff.id && rF === 'liberado' && vF.attempts === 0 && vF.lockedBy === null && resumenes().length === enviosF && vF.status === 'PENDIENTE')
  const G = await negocio('g')
  const fgx = await G.doc()
  await solicitarBajaComprobante(G.db, G.ctx, fgx.id, MOTIVO, { ahora: t0 })
  await prisma.taxVoid.updateMany({ where: { taxDocumentId: fgx.id }, data: { attempts: 6, lockedBy: 'w-muerto', lockedUntil: mas(t0, -3600) } })
  const enviosG = resumenes().length
  const wG = await worker(t0)
  const vG = await G.v(fgx.id)
  check('>>> si el worker murió en el ÚLTIMO intento, la baja pasa a AGOTADA (visible) y no se reclama más', wG.bajas.agotadasPorCaida === 1 && vG.status === 'AGOTADA' && vG.attempts === 6 && resumenes().length === enviosG && !!(await prisma.auditLog.findFirst({ where: { tenantId: G.t.id, entityId: fgx.id, action: 'baja.agotada' } })))
  await cierra()
  const H = await negocio('h')
  falso.usuarios[`${H.taxId}USERSOL1`] = SOL
  const [h1, h2] = [await H.doc(), await H.doc()]
  await solicitarBajaComprobante(H.db, H.ctx, h1.id, MOTIVO, { ahora: t0 }); await solicitarBajaComprobante(H.db, H.ctx, h2.id, MOTIVO, { ahora: t0 })
  const tope = await ejecutarWorker({ reloj: () => t0, deps: { urlSunat: falso.url }, presupuestoMs: 600_000, margenEnvioMs: 0, maxFilas: 1 })
  check('>>> el tope de filas por pasada se respeta también con las bajas, y avisa que queda trabajo', tope.bajas.procesadas === 1 && tope.restante === true)
  const topes = await ejecutarWorker({ reloj: () => t0, deps: { urlSunat: falso.url }, presupuestoMs: 600_000, margenEnvioMs: 0, maxFilas: 1 })
  check('y la siguiente pasada procesa la otra', topes.bajas.procesadas === 1 && (await H.v(h1.id)).status === 'ENVIADA' && (await H.v(h2.id)).status === 'ENVIADA')
  const seqs = (await prisma.taxVoid.findMany({ where: { tenantId: A.t.id, issueDay: hoy }, select: { seq: true } })).map((x) => x.seq).sort((a, b) => a - b)
  check('>>> los números del día son consecutivos, sin saltos ni repetidos (1..N)', seqs.length > 5 && seqs.every((n, i) => n === i + 1))

  console.log('\n4g) Lo que el reclamo nunca toma, y la historia más reciente')
  await cierra()
  const J = await negocio('j')
  const mkVoid = async (n: number, extra: Record<string, unknown> = {}, tenant = J) => {
    const f = await tenant.doc()
    return prisma.taxVoid.create({ data: { tenantId: tenant.t.id, taxDocumentId: f.id, issueDay: hoy, seq: n, identifier: `RA-${hoy.replace(/-/g, '')}-${n}`, reason: MOTIVO, nextAttemptAt: mas(t0, -60), ...extra } })
  }
  const vSin = await mkVoid(1, { attempts: 6 })
  check('>>> una baja sin intentos que gastar no se reclama (aunque no tenga lease)', await reclamarBaja('w-q', t0) === null)
  await prisma.taxVoid.delete({ where: { id: vSin.id } })
  const vLease = await mkVoid(2, { lockedBy: 'otro', lockedUntil: mas(t0, 300) })
  check('>>> con el lease de otro worker vigente no se reclama', await reclamarBaja('w-q', t0) === null)
  await prisma.taxVoid.delete({ where: { id: vLease.id } })
  const vAg = await mkVoid(3, { status: 'AGOTADA', attempts: 2 })
  check('>>> una baja AGOTADA no se reclama', await reclamarBaja('w-q', t0) === null)
  await prisma.taxVoid.delete({ where: { id: vAg.id } })
  const vDemo = await mkVoid(4, {}, dem)
  check('>>> la baja de una cuenta DEMO no se reclama', await reclamarBaja('w-q', t0) === null)
  await prisma.taxVoid.delete({ where: { id: vDemo.id } })
  const vTrial = await prisma.taxVoid.create({ data: { tenantId: J.t.id, taxDocumentId: (await J.doc('FACTURA', 'ACEPTADO', { trial: true })).id, issueDay: hoy, seq: 5, identifier: `RA-${hoy.replace(/-/g, '')}-5`, reason: MOTIVO, nextAttemptAt: mas(t0, -60), lockedBy: 'w-t', lockedUntil: mas(t0, 60), attempts: 1 } })
  const enviosJ = resumenes().length
  const rT = await procesarBaja({ id: vTrial.id, tenantId: J.t.id, taxDocumentId: vTrial.taxDocumentId, ticket: null, attempts: 1, lockedBy: 'w-t' }, { urlSunat: falso.url }, t0)
  check('>>> aunque se procese a mano, la baja de un documento de PRUEBA se cierra sin llamar a SUNAT', rT === 'completado' && resumenes().length === enviosJ && (await prisma.taxVoid.findUniqueOrThrow({ where: { id: vTrial.id } })).status === 'RECHAZADA')
  const aud0 = await prisma.auditLog.findFirst({ where: { tenantId: A.t.id, action: 'baja.solicitada', entityId: fb.id } })
  check('>>> la auditoría de la solicitud anota el motivo y el identificador', JSON.stringify(aud0?.after).includes(MOTIVO) && JSON.stringify(aud0?.after).includes(sol1.identificador))
  const filaCdr = (await A.archivos(v4.id)).find((a) => a.kind === 'CDR')!
  check('el tamaño guardado es el del contenido SIN comprimir', filaCdr.size === Buffer.byteLength(cdrBaja.contenido, 'utf8'))
  const vOtra = await A.v(fr.id)
  await prisma.$transaction(async (tx) => { await guardarArchivosBaja(tx as never, A.t.id, vOtra.id, { xmlFirmado: '<segunda/>' }) })
  check('>>> con dos bajas de un mismo comprobante se descarga el archivo de la MÁS RECIENTE', (await leerArchivoBaja(A.db, A.ctx, fr.id, 'XML_FIRMADO')).contenido === '<segunda/>')
  await prisma.tenant.delete({ where: { id: J.t.id } })

  console.log('\n5) La estructura de la base y del código')
  const mig = readFileSync('prisma/migrations/20261127100000_comunicacion_baja/migration.sql', 'utf8')
  check('>>> la migración trae el índice de UNA baja viva por comprobante, el disparador de inmutabilidad y los CHECK', /tax_voids_una_viva_key[\s\S]*WHERE "status" IN \('PENDIENTE', 'ENVIADA', 'ACEPTADA'\)/.test(mig) && /tax_void_files_no_update BEFORE UPDATE/.test(mig) && /tax_voids_motivo_chk/.test(mig) && /tax_void_files_hash_chk/.test(mig))
  check('la base rechaza un motivo vacío, un día mal escrito y un archivo con huella inválida', await code(prisma.taxVoid.create({ data: { tenantId: A.t.id, taxDocumentId: fa.id, issueDay: '2026-10-29', seq: 99, identifier: 'RA-20261029-99', reason: '  ' } })) !== null && await code(prisma.taxVoid.create({ data: { tenantId: A.t.id, taxDocumentId: fa.id, issueDay: '29/10', seq: 98, identifier: 'RA-X-98', reason: 'ok' } })) !== null && await code(prisma.taxVoidFile.create({ data: { tenantId: A.t.id, taxVoidId: v4.id, kind: 'XML_FIRMADO', content: Buffer.from('x'), sha256: 'zz', size: 1 } })) !== null)
  const tenantPrisma = readFileSync('src/lib/tenant-prisma.ts', 'utf8')
  check('>>> TaxVoid y TaxVoidFile están aisladas por negocio (TENANT_SCOPED)', /'TaxVoid',/.test(tenantPrisma) && /'TaxVoidFile',/.test(tenantPrisma))
  check('el borrado de un negocio arrastra sus bajas y sus archivos', await (async () => { const n = await negocio('del'); const f = await n.doc(); await solicitarBajaComprobante(n.db, n.ctx, f.id, MOTIVO); await prisma.tenant.delete({ where: { id: n.t.id } }); return (await prisma.taxVoid.count({ where: { tenantId: n.t.id } })) === 0 })())
  const ui = readFileSync('src/features/invoicing/components/DarDeBajaDialog.tsx', 'utf8')
  const lista = readFileSync('src/features/invoicing/components/TaxDocumentList.tsx', 'utf8')
  check('>>> el diálogo exige motivo y una confirmación explícita, y avisa que solo cambia lo tributario', /disabled=\{pendiente \|\| !confirmado \|\| motivo\.trim\(\)\.length === 0\}/.test(ui) && /Solo cambia lo tributario/.test(ui) && /maxLength=\{MOTIVO_MAX\}/.test(ui))
  check('la lista no ofrece la baja en boletas ni en documentos de prueba, y enlaza el XML y el CDR de la baja', /puedeDarBaja && !d\.isTrial && d\.documentType !== 'BOLETA'/.test(lista) && /tipo=baja-xml/.test(lista) && /tipo=baja-cdr/.test(lista))
  const pagina = readFileSync('src/app/(dashboard)/comprobantes/page.tsx', 'utf8')
  check('>>> la página solo ofrece la baja con el permiso propio, acceso completo y facturación real activa', /puede\(ctx, 'comprobantes\.dar_baja'\) && \(ctx\.access === 'FULL' \|\| ctx\.access === 'WARN'\) && facturacionActiva/.test(pagina))
  const worker_ = readFileSync('src/features/cola-fiscal/worker.ts', 'utf8')
  check('el worker procesa las bajas DESPUÉS de los comprobantes y con el mismo presupuesto de tiempo', worker_.indexOf('reclamarSiguiente(') < worker_.indexOf('reclamarBaja(') && /tiempoRestante\(inicio, presupuesto, Date\.now\(\)\) < margen/.test(worker_.slice(worker_.indexOf('reclamarBaja(') - 400)))

  await falso.detener()
  await prisma.tenant.deleteMany({ where: { id: { in: [A.t.id, B.t.id, C.t.id, D.t.id, E.t.id, F.t.id, G.t.id, H.t.id, ens.t.id, dem.t.id] } } })
}

async function main() {
  try { await cuerpo() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? (e.stack ?? e.message).slice(0, 500) : e}`, false) }
  Object.assign(process.env, { SECRETOS_CLAVES: antes.c, SECRETOS_CLAVE_ACTUAL: antes.a })
  for (const k of ['SECRETOS_CLAVES', 'SECRETOS_CLAVE_ACTUAL'] as const) if (process.env[k] === undefined || process.env[k] === 'undefined') delete process.env[k]
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
