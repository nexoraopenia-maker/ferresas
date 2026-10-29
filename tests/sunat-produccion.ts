import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { guardarCredencialesSunat } from '../src/features/sunat/credenciales'
import { dentroDelPlazoDeEnvio, PLAZO_ENVIO_DIAS } from '../src/features/sunat/plazos'
import { solicitarBajaComprobante } from '../src/features/sunat/baja'
import { evaluarPaseASunatProduccion, pasarASunatProduccion, volverASunatBeta, VIGENCIA_PRUEBA_HORAS } from '../src/features/superadmin/produccion-sunat-service'
import { enviarManual } from '../src/features/cola-fiscal/manual'
import { ejecutarWorker } from '../src/features/cola-fiscal/worker'
import { claveIdempotencia } from '../src/features/cola-fiscal/reglas'
import { asignarSucursal, credencialSunatFalsa, crearSucursalConAlmacen } from './fixtures'
import { generarCertificadoDePrueba } from './falsos/certificado-prueba'
import { iniciarSunatFalso } from './falsos/sunat-falso'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * S5 · Pase a producción de SUNAT, solo SuperAdmin: las comprobaciones previas (certificado vigente, mismo RUC, prueba de conexión reciente y exitosa…), qué pasa con lo que
 * quedó PENDIENTE mientras la conexión estaba en pruebas (lo que está en plazo vuelve a la cola; lo que lo superó se RETIENE con advertencia), y el camino de vuelta.
 * ⚠️ Qué hace falta para «estar listo» es criterio nuestro (docs/SUNAT-SUPUESTOS.md #28).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '', (e) => String(e.message))
const DIA = 86_400_000, H = 3_600_000
const SOL = 'ClaveSol-Secreta-7Z', CLAVE_PFX = 'Clave-Pfx-Secreta-9X'
const ENV = ['SECRETOS_CLAVES', 'SECRETOS_CLAVE_ACTUAL', 'PSE_MASTER_KEY', 'PSE_MASTER_KEY_PREVIOUS'] as const
const antes = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
let actor = { id: '', email: 'soporte@plataforma.pe' }
const MOTIVO = 'Certificado y usuario SOL verificados con el dueño'

async function cuerpo() {
  process.env.SECRETOS_CLAVES = JSON.stringify({ a: Buffer.alloc(32, 7).toString('base64') })
  process.env.SECRETOS_CLAVE_ACTUAL = 'a'
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const creados: string[] = []
  actor = { ...actor, id: (await prisma.user.create({ data: { email: `sa-${randomUUID()}@x.com`, name: 'SA', role: 'SUPERADMIN' } })).id }

  async function negocio(tag: string, o: { demo?: boolean; ensayo?: boolean; sinRuc?: boolean; real?: boolean } = {}) {
    const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
    const t = await prisma.tenant.create({ data: { slug: `sp-${tag}-${randomUUID().slice(0, 6)}`, name: `Prod ${tag}`, legalName: `PROD ${tag.toUpperCase()} SAC`, taxId: o.sinRuc ? null : taxId, planId: plan.id, isDemo: !!o.demo, realBillingEnabledAt: o.ensayo || o.demo ? null : new Date(Date.now() - 30 * DIA) } })
    creados.push(t.id)
    await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_sp' } })
    const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER' } })
    await asignarSucursal(t.id, u.id, branch.id)
    const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id], permisosExtra: [] }
    const p = await prisma.product.create({ data: { tenantId: t.id, sku: 'P', name: 'Cemento', salePrice: 11.8 } })
    let n = 0
    const doc = async (o2: { hace?: number; status?: 'PENDIENTE' | 'ACEPTADO'; trial?: boolean; cola?: { status: 'PENDIENTE' | 'AGOTADO'; attempts: number } | null } = {}) => {
      const sale = await prisma.sale.create({ data: { tenantId: t.id, branchId: branch.id, warehouseId: w.id, userId: u.id, number: `V-${tag}-${randomUUID().slice(0, 6)}`, status: 'COMPLETADA' } })
      await prisma.saleItem.create({ data: { tenantId: t.id, saleId: sale.id, productId: p.id, nameSnapshot: 'Cemento', skuSnapshot: 'P', quantity: 1, unitPrice: 11.8, lineTotal: 11.8 } })
      n++
      const serie = o2.trial ? 'PF001' : 'F001'
      const d = await prisma.taxDocument.create({ data: {
        tenantId: t.id, saleId: sale.id, documentType: 'FACTURA', series: serie, correlativo: n, fullNumber: `${serie}-${String(n).padStart(8, '0')}`, status: o2.status ?? 'PENDIENTE', isTrial: o2.trial ?? false,
        receiverDocType: 'RUC', receiverDocNumber: completarRuc('2055555555'), receiverName: 'CLIENTE', issuerTaxId: taxId, issuerLegalName: 'PROD SAC',
        subtotal: 10, taxTotal: 1.8, total: 11.8, issuedAt: new Date(Date.now() - (o2.hace ?? 0) * DIA - 600_000),
      } })
      if (o2.cola) await prisma.fiscalDispatch.create({ data: { tenantId: t.id, taxDocumentId: d.id, status: o2.cola.status, attempts: o2.cola.attempts, nextAttemptAt: new Date(Date.now() + 5 * H), idempotencyKey: claveIdempotencia(t.id, d.id), ...(o2.cola.status === 'AGOTADO' ? { exhaustedAt: new Date(), lastError: 'BETA' } : {}) } })
      return d
    }
    return { t, taxId, ctx, db: getTenantPrisma(ctx), doc, u, cola: (id: string) => prisma.fiscalDispatch.findFirst({ where: { taxDocumentId: id } }), d: (id: string) => prisma.taxDocument.findUniqueOrThrow({ where: { id } }), cred: () => prisma.sunatCredential.findUniqueOrThrow({ where: { tenantId: t.id } }) }
  }
  /** Un negocio con todo en regla para el pase (credenciales de mentira, RUC igual, prueba reciente). */
  async function listo(tag: string) {
    const A = await negocio(tag)
    await credencialSunatFalsa(A.t.id, { ruc: A.taxId, prueba: { en: new Date(Date.now() - H), ok: true } })
    return A
  }

  console.log('\n1) Plazo de envío (puro)')
  check('el plazo de envío del dueño es 3 días calendario y se cuenta igual que el de baja', PLAZO_ENVIO_DIAS === 3 && dentroDelPlazoDeEnvio('2026-10-20', '2026-10-23') && !dentroDelPlazoDeEnvio('2026-10-20', '2026-10-24') && dentroDelPlazoDeEnvio('2026-10-20', '2026-10-20'))

  console.log('\n2) Qué impide el pase (cada cosa por separado)')
  const ok = await listo('ok')
  const evOk = await evaluarPaseASunatProduccion(ok.t.id)
  check('>>> con todo en regla no falta nada y no hay advertencias', evOk.faltantes.length === 0 && evOk.advertencias.length === 0 && evOk.ambiente === 'BETA', evOk.faltantes.join(' | '))
  const faltaCon = async (tag: string, cambia: (A: Awaited<ReturnType<typeof negocio>>) => Promise<void>, clave: RegExp, unico = false) => {
    const A = await listo(tag)
    await cambia(A)
    const ev = await evaluarPaseASunatProduccion(A.t.id)
    check(`>>> ${tag}: impide el pase (${clave.source})`, ev.faltantes.some((f) => clave.test(f)) && (unico || ev.faltantes.length === 1), ev.faltantes.join(' | '))
    return A
  }
  const upCred = (A: { t: { id: string } }, data: Record<string, unknown>) => prisma.sunatCredential.update({ where: { tenantId: A.t.id }, data })
  await faltaCon('certificado vencido', (A) => upCred(A, { certValidFrom: new Date(Date.now() - 400 * DIA), certValidTo: new Date(Date.now() - DIA) }).then(() => {}), /VENCIDO/)
  await faltaCon('certificado aún no vigente', (A) => upCred(A, { certValidFrom: new Date(Date.now() + DIA), certValidTo: new Date(Date.now() + 400 * DIA) }).then(() => {}), /todavía no empieza/)
  await faltaCon('certificado de otro RUC', (A) => upCred(A, { certRuc: completarRuc('2099999999') }).then(() => {}), /mismo RUC/)
  await faltaCon('certificado sin RUC legible', (A) => upCred(A, { certRuc: null }).then(() => {}), /RUC legible/)
  await faltaCon('sin prueba de conexión', (A) => upCred(A, { lastTestAt: null, lastTestOk: null, lastTestMessage: null }).then(() => {}), /prueba de conexión/)
  await faltaCon('prueba fallida', (A) => upCred(A, { lastTestOk: false }).then(() => {}), /prueba de conexión/)
  await faltaCon('prueba vieja', (A) => upCred(A, { lastTestAt: new Date(Date.now() - (VIGENCIA_PRUEBA_HORAS + 1) * H) }).then(() => {}), /reciente/)
  const casi = await listo('prueba casi vieja')
  await upCred(casi, { lastTestAt: new Date(Date.now() - (VIGENCIA_PRUEBA_HORAS - 1) * H) })
  check('una prueba de hace menos de 24 h todavía sirve', (await evaluarPaseASunatProduccion(casi.t.id)).faltantes.length === 0)
  await faltaCon('ya en producción', (A) => upCred(A, { ambiente: 'PRODUCCION' }).then(() => {}), /ya está en producción/)
  await faltaCon('negocio en ensayo', (A) => prisma.tenant.update({ where: { id: A.t.id }, data: { realBillingEnabledAt: null } }).then(() => {}), /modo ensayo/)
  await faltaCon('RUC del negocio inválido', (A) => prisma.tenant.update({ where: { id: A.t.id }, data: { taxId: '12345' } }).then(() => {}), /RUC del negocio/, true)
  const sinCred = await negocio('sin credenciales')
  check('>>> sin credenciales cargadas lo dice', (await evaluarPaseASunatProduccion(sinCred.t.id)).faltantes.some((f) => /credenciales de SUNAT/.test(f)))
  const porVencer = await listo('por vencer')
  await upCred(porVencer, { certValidTo: new Date(Date.now() + 10 * DIA) })
  const evPv = await evaluarPaseASunatProduccion(porVencer.t.id)
  check('>>> un certificado por vencer NO impide el pase, pero advierte con la fecha', evPv.faltantes.length === 0 && evPv.advertencias.some((a) => /vence el \d{4}-\d{2}-\d{2}/.test(a)))
  const claveBorrada = await listo('sin clave maestra')
  for (const k of ENV) delete process.env[k]
  const evSc = await evaluarPaseASunatProduccion(claveBorrada.t.id)
  process.env.SECRETOS_CLAVES = JSON.stringify({ a: Buffer.alloc(32, 7).toString('base64') }); process.env.SECRETOS_CLAVE_ACTUAL = 'a'
  check('>>> sin clave maestra en el servidor no se pasa a producción', evSc.faltantes.some((f) => /clave maestra/.test(f)))
  const demo = await negocio('demo', { demo: true })
  check('una cuenta DEMO nunca (FORBIDDEN_ROLE) y un negocio inexistente es TENANT_MISMATCH', await code(evaluarPaseASunatProduccion(demo.t.id)) === 'FORBIDDEN_ROLE' && await code(pasarASunatProduccion({ tenantId: demo.t.id, reason: MOTIVO }, actor)) === 'FORBIDDEN_ROLE' && await code(evaluarPaseASunatProduccion('no-existe')) === 'TENANT_MISMATCH')
  const varios = await negocio('varios', { sinRuc: true, ensayo: true })
  const evV = await evaluarPaseASunatProduccion(varios.t.id)
  check('>>> lo que falta se dice todo junto', evV.faltantes.length >= 3, String(evV.faltantes.length))

  console.log('\n3) Pasar: lo que cambia, lo que no, y la concurrencia')
  const bloq = await negocio('bloq')
  await credencialSunatFalsa(bloq.t.id, { ruc: bloq.taxId, prueba: null })
  check('>>> con faltantes se rechaza, los nombra y NO cambia nada (ni auditoría)', /Falta:.*prueba de conexión/.test(await msg(pasarASunatProduccion({ tenantId: bloq.t.id, reason: MOTIVO }, actor))) && (await bloq.cred()).ambiente === 'BETA' && (await prisma.auditLog.count({ where: { tenantId: bloq.t.id, action: 'tenant.sunat.produccion' } })) === 0)
  const [p1, p2] = await Promise.allSettled([pasarASunatProduccion({ tenantId: ok.t.id, reason: MOTIVO }, actor), pasarASunatProduccion({ tenantId: ok.t.id, reason: MOTIVO }, actor)])
  const cOk = await ok.cred()
  check('>>> dos SuperAdmin a la vez: pasa UNO, y una sola auditoría', [p1, p2].filter((r) => r.status === 'fulfilled').length === 1 && cOk.ambiente === 'PRODUCCION' && (await prisma.auditLog.count({ where: { tenantId: ok.t.id, action: 'tenant.sunat.produccion' } })) === 1)
  check('>>> al pasar, la prueba de conexión se borra (se repite ya en producción) y queda quién lo hizo', cOk.lastTestAt === null && cOk.lastTestOk === null && cOk.lastTestMessage === null && cOk.updatedById === actor.id)
  const aud = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: ok.t.id, action: 'tenant.sunat.produccion' } })
  check('>>> la auditoría lleva el motivo, el correo de quien lo hizo, el antes y el después, sin secretos', aud.reason === MOTIVO && aud.actorEmail === actor.email && aud.actorRole === 'SUPERADMIN' && JSON.stringify(aud.before).includes('BETA') && JSON.stringify(aud.after).includes('PRODUCCION') && !JSON.stringify(aud).includes(SOL))
  check('pasar otra vez se rechaza', await code(pasarASunatProduccion({ tenantId: ok.t.id, reason: MOTIVO }, actor)) === 'INVALID_DOCUMENT')

  console.log('\n4) Lo PENDIENTE de la etapa de pruebas, de punta a punta')
  const R = await negocio('real')
  const cert = generarCertificadoDePrueba({ ruc: R.taxId, clave: CLAVE_PFX })
  await guardarCredencialesSunat(R.db, R.ctx, { pfxBase64: cert.pfx.toString('base64'), claveCertificado: CLAVE_PFX, usuarioSol: 'USERSOL1', claveSol: SOL })
  const falso = await iniciarSunatFalso({ usuarios: { [`${R.taxId}USERSOL1`]: SOL } })
  const dentro1 = await R.doc({ cola: { status: 'AGOTADO', attempts: 6 } })
  const dentro2 = await R.doc({ hace: 2, cola: { status: 'PENDIENTE', attempts: 3 } })
  const dentro3 = await R.doc({ hace: 1 })
  const fuera1 = await R.doc({ hace: 5, cola: { status: 'PENDIENTE', attempts: 2 } })
  const fuera2 = await R.doc({ hace: 9 })
  const prueba = await R.doc({ trial: true })
  const aceptado = await R.doc({ status: 'ACEPTADO', cola: { status: 'PENDIENTE', attempts: 0 } })
  const fbaja = await R.doc({ status: 'ACEPTADO' })
  const worker = (urlSunat: string | null) => ejecutarWorker({ reloj: () => new Date(), deps: urlSunat ? { urlSunat } : {}, presupuestoMs: 600_000, margenEnvioMs: 0 })
  await solicitarBajaComprobante(R.db, R.ctx, fbaja.id, 'Error en el RUC del cliente')
  await prisma.taxVoid.updateMany({ where: { taxDocumentId: fbaja.id }, data: { attempts: 3, nextAttemptAt: new Date(Date.now() + 5 * H), lastError: 'BETA' } })
  await worker(null)
  check('>>> en BETA el worker no envía nada a SUNAT (los comprobantes reales no salen)', falso.recibidas.length === 0 && (await R.d(dentro3.id)).status === 'PENDIENTE')
  const ev = await evaluarPaseASunatProduccion(R.t.id)
  check('la previsualización cuenta lo pendiente: 3 en plazo y 2 fuera de plazo (sin contar pruebas ni aceptados), y 1 baja', ev.pendientes.enPlazo === 3 && ev.pendientes.fueraDePlazo === 2 && ev.bajasPendientes === 1 && ev.advertencias.some((a) => /2 comprobante.*superaron el plazo/.test(a)))
  check('>>> y mientras no haya prueba reciente no se puede pasar', /prueba de conexión/.test(await msg(pasarASunatProduccion({ tenantId: R.t.id, reason: MOTIVO }, actor))))
  await prisma.sunatCredential.update({ where: { tenantId: R.t.id }, data: { lastTestAt: new Date(), lastTestOk: true, lastTestMessage: 'ok' } })
  const ahora = new Date()
  const pase = await pasarASunatProduccion({ tenantId: R.t.id, reason: MOTIVO }, actor, ahora)
  check('>>> el pase informa cuántos volvieron a la cola (3: el worker ya había adoptado al que no tenía fila), cuántos quedaron retenidos y cuántas bajas', pase.reencolados === 3 && pase.retenidos === 2 && pase.bajasReencoladas === 1 && pase.ambiente === 'PRODUCCION', JSON.stringify(pase))
  const c1 = await R.cola(dentro1.id), c2 = await R.cola(dentro2.id)
  check('>>> lo que estaba en plazo (agotado o con intentos gastados) vuelve a PENDIENTE con intentos en cero y listo para enviar ya', [c1, c2].every((c) => c?.status === 'PENDIENTE' && c.attempts === 0 && c.lastError === null && c.exhaustedAt === null && c.nextAttemptAt.getTime() <= ahora.getTime() + 1000))
  const cf1 = await R.cola(fuera1.id), cf2 = await R.cola(fuera2.id)
  check('>>> lo que superó el plazo queda RETENIDO (AGOTADO) con el motivo a la vista; también el que el worker había adoptado sin fila', cf1?.status === 'AGOTADO' && /plazo de envío/.test(cf1.lastError ?? '') && cf2?.status === 'AGOTADO' && /plazo de envío/.test(cf2.lastError ?? ''))
  check('el documento de prueba y el ya aceptado no se tocan', (await R.cola(prueba.id)) === null && (await R.cola(aceptado.id))?.attempts === 0 && (await R.d(prueba.id)).status === 'PENDIENTE')
  const vb = await prisma.taxVoid.findFirstOrThrow({ where: { taxDocumentId: fbaja.id } })
  check('la baja pendiente vuelve a la cola con intentos nuevos', vb.attempts === 0 && vb.lastError === null && vb.nextAttemptAt.getTime() <= ahora.getTime() + 1000)
  await worker(falso.url)
  check('>>> el worker envía a SUNAT lo que estaba en plazo (con y sin fila de cola) y SOLO eso', (await R.d(dentro1.id)).status === 'ACEPTADO' && (await R.d(dentro2.id)).status === 'ACEPTADO' && (await R.d(dentro3.id)).status === 'ACEPTADO')
  check('>>> lo retenido NO se envió solo: sigue PENDIENTE y SUNAT jamás lo vio', (await R.d(fuera1.id)).status === 'PENDIENTE' && (await R.d(fuera2.id)).status === 'PENDIENTE' && falso.recibidas.filter((r) => r.operacion === 'sendBill').length === 3)
  check('ni el documento de prueba', (await R.d(prueba.id)).status === 'PENDIENTE' && falso.recibidas.every((r) => !(r.nombreZip ?? '').includes('PF001')))
  check('la baja pendiente salió hacia SUNAT (ENVIADA con ticket)', (await prisma.taxVoid.findFirstOrThrow({ where: { taxDocumentId: fbaja.id } })).status === 'ENVIADA')
  const manual = await enviarManual(R.db, R.ctx, fuera1.id, { urlSunat: falso.url })
  check('>>> lo retenido SÍ sale cuando una persona lo envía a mano', manual.estado === 'ACEPTADO' && (await R.d(fuera1.id)).status === 'ACEPTADO')
  check('>>> y ya no se puede volver a pruebas: salieron comprobantes a SUNAT real (se indica cuántos)', /ya salieron \d+ comprobante/.test(await msg(volverASunatBeta({ tenantId: R.t.id, reason: MOTIVO }, actor))) && (await R.cred()).ambiente === 'PRODUCCION')
  await falso.detener()

  const O = await listo('huerfanos')
  const oFuera = await O.doc({ hace: 6 }), oDentro = await O.doc({ hace: 1 })
  await pasarASunatProduccion({ tenantId: O.t.id, reason: MOTIVO }, actor)
  const filaFuera = await O.cola(oFuera.id)
  check('>>> un pendiente fuera de plazo SIN fila de cola recibe una fila retenida (AGOTADO, con su idempotencia) y el de en plazo no recibe nada todavía', filaFuera?.status === 'AGOTADO' && filaFuera.idempotencyKey === claveIdempotencia(O.t.id, oFuera.id) && (await O.cola(oDentro.id)) === null)
  await worker(null)
  check('>>> el worker adopta al de en plazo pero JAMÁS al retenido', (await O.cola(oDentro.id)) !== null && (await prisma.fiscalDispatch.count({ where: { taxDocumentId: oFuera.id } })) === 1 && (await O.cola(oFuera.id))?.status === 'AGOTADO')

  console.log('\n5) El camino de vuelta')
  check('no se vuelve a pruebas si ya está en pruebas', /no está en producción/.test(await msg(volverASunatBeta({ tenantId: casi.t.id, reason: MOTIVO }, actor))) && (await casi.cred()).ambiente === 'BETA')
  const V = await listo('vuelta')
  await pasarASunatProduccion({ tenantId: V.t.id, reason: MOTIVO }, actor)
  await prisma.sunatCredential.update({ where: { tenantId: V.t.id }, data: { lastTestAt: new Date(), lastTestOk: true, lastTestMessage: 'ok en producción' } })
  await prisma.taxDocument.update({ where: { id: (await V.doc({ trial: true })).id }, data: { sentAt: new Date() } })
  const vb2 = await volverASunatBeta({ tenantId: V.t.id, reason: 'Se pasó por error antes de verificar' }, actor)
  const cV = await V.cred()
  check('>>> si no salió nada (un documento de prueba con fecha de envío no cuenta), vuelve a pruebas, con la prueba de conexión borrada y su auditoría', vb2.ambiente === 'BETA' && cV.ambiente === 'BETA' && cV.lastTestAt === null && cV.lastTestOk === null && cV.lastTestMessage === null && (await prisma.auditLog.count({ where: { tenantId: V.t.id, action: 'tenant.sunat.beta' } })) === 1)
  const W = await listo('vuelta con baja')
  await pasarASunatProduccion({ tenantId: W.t.id, reason: MOTIVO }, actor)
  const dw = await W.doc({ status: 'ACEPTADO' })
  const vw = await prisma.taxVoid.create({ data: { tenantId: W.t.id, taxDocumentId: dw.id, issueDay: '2026-10-29', seq: 1, identifier: 'RA-20261029-1', reason: 'x', sentAt: new Date(), status: 'ENVIADA', ticket: 'T1' } })
  check('>>> una baja ya enviada a SUNAT real también impide volver a pruebas', /baja/.test(await msg(volverASunatBeta({ tenantId: W.t.id, reason: MOTIVO }, actor))) && (await W.cred()).ambiente === 'PRODUCCION' && vw.id.length > 0)
  const X = await listo('recarga')
  await pasarASunatProduccion({ tenantId: X.t.id, reason: MOTIVO }, actor)
  const cert2 = generarCertificadoDePrueba({ ruc: X.taxId, clave: CLAVE_PFX })
  await guardarCredencialesSunat(X.db, X.ctx, { pfxBase64: cert2.pfx.toString('base64'), claveCertificado: CLAVE_PFX, usuarioSol: 'USERSOL1', claveSol: SOL })
  check('>>> si el dueño carga otro certificado, la conexión VUELVE a pruebas y exige repetir la prueba y el pase', (await X.cred()).ambiente === 'BETA')

  console.log('\n6) Solo el SuperAdmin')
  const acciones = readFileSync('src/features/superadmin/actions.ts', 'utf8')
  const pasa = acciones.slice(acciones.indexOf('export async function setAmbienteSunatAction'))
  check('>>> la acción exige SuperAdmin ANTES de tocar nada, y exige un motivo de 10 caracteres', pasa.indexOf('requireSuperAdmin()') > 0 && pasa.indexOf('requireSuperAdmin()') < pasa.indexOf('pasarASunatProduccion(') && /min\(10/.test(readFileSync('src/features/superadmin/schemas.ts', 'utf8').slice(readFileSync('src/features/superadmin/schemas.ts', 'utf8').indexOf('ambienteSunatSchema'))))
  check('la previsualización también es solo del SuperAdmin', /previsualizarPaseSunatAction[\s\S]*requireSuperAdmin\(\)[\s\S]*evaluarPaseASunatProduccion/.test(acciones))
  const escritores = (await import('node:child_process')).execSync(`grep -rln "ambiente: 'PRODUCCION'" src --include='*.ts' --include='*.tsx' | grep -v generated`).toString().trim().split('\n').sort()
  check('>>> ningún otro código de la aplicación escribe el ambiente de PRODUCCION (solo el servicio del SuperAdmin; el resto lo compara)', escritores.every((f) => f === 'src/features/superadmin/produccion-sunat-service.ts' || !/data:[^}]*ambiente: 'PRODUCCION'/.test(readFileSync(f, 'utf8'))), escritores.join(', '))
  const ui = readFileSync('src/features/superadmin/components/TenantActions.tsx', 'utf8')
  check('>>> la pantalla del SuperAdmin muestra lo que falta y no deja confirmar mientras falte algo ni sin motivo', /reason\.trim\(\)\.length >= 10 && pase !== null && pase\.faltantes\.length === 0/.test(ui) && /sunat_produccion/.test(ui) && /Falta antes de pasar/.test(ui) && /ambienteSunat === 'BETA'/.test(ui))
  check('el menú ofrece volver a pruebas solo con la conexión en producción', /ambienteSunat === 'PRODUCCION' && <DropdownMenuItem onSelect=\{\(\) => abrir\('sunat_beta'\)\}/.test(ui))

  await prisma.tenant.deleteMany({ where: { id: { in: creados } } })
}

async function main() {
  try { await cuerpo() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? (e.stack ?? e.message).slice(0, 500) : e}`, false) }
  for (const k of ENV) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k] }
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
