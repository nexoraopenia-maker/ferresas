import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SyntaxKind } from 'ts-morph'
import { abrir, ficheros, proyecto, RAIZ, rel } from './ast'
import { asignarSucursal, crearSucursalConAlmacen, abrirTurno } from './fixtures'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { issueTaxDocument } from '../src/features/invoicing/service'
import { enviarComprobante, refrescarEstado } from '../src/features/invoicing/envio'
import { fijarArranqueSerie, listarSeriesConfigurables } from '../src/features/invoicing/counter-service'
import { esEnviable, modoFiscal, numeraEnPrueba, puedeEnviarAlProveedor } from '../src/features/invoicing/modo-fiscal'
import {
  describirAntiguedad, estadoEnvioFiscal, nivelDeAlarma, umbralesEfectivos,
  UMBRAL_AVISO_POR_DEFECTO_HORAS, UMBRAL_CRITICO_POR_DEFECTO_HORAS,
} from '../src/features/invoicing/alarma-envio'
import { obtenerProveedor, type CredencialesProveedor, type ProveedorFacturacion } from '../src/features/invoicing/providers'
import { cambiarFacturacionReal, contarDocumentosEnSerieReal, faltantesParaHabilitar, fijarUmbralesAlerta } from '../src/features/superadmin/facturacion-real-service'
import { getSuperAdminDashboard } from '../src/features/superadmin/queries'
import { getDocumentoImprimible } from '../src/features/printing/queries'
import { TicketTermico } from '../src/features/printing/components/TicketTermico'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '').catch((e) => String(e.message ?? e))
const cred: CredencialesProveedor = { usuario: 'mock:acepta', clave: 'x', modoPruebas: true }
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000)

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const creados: string[] = []
  const actor = { id: (await prisma.user.create({ data: { email: `sa-${randomUUID()}@x.com`, name: 'SA', role: 'SUPERADMIN' } })).id, email: 'soporte@plataforma.pe' }

  try {
    console.log('\n1) Modo fiscal (puro)')
    const base = { isDemo: false, realBillingEnabledAt: null, realBillingPausedAt: null }
    const ahora = new Date()
    check('demo → DEMO; sin habilitar → ENSAYO', modoFiscal({ ...base, isDemo: true }) === 'DEMO' && modoFiscal(base) === 'ENSAYO')
    check('habilitado → REAL; con pausa → PAUSADO', modoFiscal({ ...base, realBillingEnabledAt: ahora }) === 'REAL' && modoFiscal({ ...base, realBillingEnabledAt: ahora, realBillingPausedAt: ahora }) === 'PAUSADO')
    check('>>> solo el ENSAYO numera en serie de prueba', numeraEnPrueba('ENSAYO') && !numeraEnPrueba('REAL') && !numeraEnPrueba('PAUSADO') && !numeraEnPrueba('DEMO'))
    check('solo REAL (y la demo, con el simulado) pueden hablar con un proveedor', puedeEnviarAlProveedor('REAL') && puedeEnviarAlProveedor('DEMO') && !puedeEnviarAlProveedor('ENSAYO') && !puedeEnviarAlProveedor('PAUSADO'))
    check('>>> un documento de PRUEBA no es enviable en NINGÚN modo', (['DEMO', 'ENSAYO', 'REAL', 'PAUSADO'] as const).every((m) => !esEnviable({ isTrial: true }, m)))
    check('uno real solo en REAL o DEMO', esEnviable({ isTrial: false }, 'REAL') && esEnviable({ isTrial: false }, 'DEMO') && !esEnviable({ isTrial: false }, 'PAUSADO') && !esEnviable({ isTrial: false }, 'ENSAYO'))

    console.log('\n2) Alarma de comprobantes sin enviar (pura)')
    const sin = { fiscalAlertWarnHours: null, fiscalAlertCriticalHours: null }
    check('umbrales por defecto: 24 h y 72 h (de trabajo, NO plazos de SUNAT)', umbralesEfectivos(sin, {}).avisoHoras === 24 && umbralesEfectivos(sin, {}).criticoHoras === 72 && UMBRAL_AVISO_POR_DEFECTO_HORAS === 24 && UMBRAL_CRITICO_POR_DEFECTO_HORAS === 72)
    check('la plataforma los puede cambiar por entorno', umbralesEfectivos(sin, { FISCAL_ALERTA_AVISO_HORAS: '6', FISCAL_ALERTA_CRITICO_HORAS: '12' }).criticoHoras === 12)
    check('>>> el negocio manda sobre la plataforma', umbralesEfectivos({ fiscalAlertWarnHours: 2, fiscalAlertCriticalHours: 5 }, { FISCAL_ALERTA_AVISO_HORAS: '6' }).avisoHoras === 2)
    check('un entorno inválido se ignora', umbralesEfectivos(sin, { FISCAL_ALERTA_AVISO_HORAS: 'abc' }).avisoHoras === 24)
    check('>>> aviso ≥ crítico no deja la alarma muda: se corrige', umbralesEfectivos({ fiscalAlertWarnHours: 10, fiscalAlertCriticalHours: 10 }, {}).criticoHoras === 11)
    const u = { avisoHoras: 24, criticoHoras: 72 }
    const n = (modo: 'DEMO' | 'ENSAYO' | 'REAL' | 'PAUSADO', sinEnviar: number, h: number | null) => nivelDeAlarma({ modo, sinEnviar, masAntiguoHoras: h, umbrales: u })
    check('>>> ENSAYO y DEMO nunca alarman, aunque haya "pendientes"', !n('ENSAYO', 9, 500).mostrar && !n('DEMO', 9, 500).mostrar)
    check('REAL sin pendientes: no se muestra nada', !n('REAL', 0, null).mostrar)
    check('REAL con pendientes recientes (5 h): no molesta', n('REAL', 3, 5).nivel === 'ok' && !n('REAL', 3, 5).mostrar)
    check('REAL a las 24 h: aviso; a las 72 h: crítico', n('REAL', 1, 24).nivel === 'aviso' && n('REAL', 1, 72).nivel === 'critico' && n('REAL', 1, 23.9).nivel === 'ok')
    check('>>> PAUSADO se ve SIEMPRE, aunque no haya nada pendiente', n('PAUSADO', 0, null).nivel === 'aviso' && n('PAUSADO', 0, null).mostrar)
    check('PAUSADO con lo pendiente muy viejo: crítico', n('PAUSADO', 4, 100).nivel === 'critico')
    check('antigüedad legible', describirAntiguedad(0.2) === '12 min' && describirAntiguedad(5) === '5 h' && describirAntiguedad(72) === '3 días')

    // ── Negocios de prueba ────────────────────────────────────────────────
    const mkNegocio = async (tag: string, opts: { demo?: boolean } = {}) => {
      const t = await prisma.tenant.create({ data: { slug: `mf-${tag}-${randomUUID().slice(0, 6)}`, name: `Modo ${tag}`, legalName: `MODO ${tag.toUpperCase()} SAC`, taxId: ruc(), planId: plan.id, isDemo: !!opts.demo, pseConfiguredAt: new Date() } })
      creados.push(t.id)
      await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_mf' } })
      const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
      await prisma.branch.update({ where: { id: branch.id }, data: { address: 'Av. Los Constructores 123, Lima', ubigeo: '150101' } })
      const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER' } })
      await asignarSucursal(t.id, u.id, branch.id)
      const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
      await abrirTurno(t.id, u.id, branch.id)
      const db = getTenantPrisma(ctx)
      const p = await prisma.product.create({ data: { tenantId: t.id, sku: 'P', name: 'Cemento Sol', salePrice: 30 } })
      await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: w.id, quantity: 10_000 } })
      const cli = await prisma.customer.create({ data: { tenantId: t.id, docType: 'DNI', docNumber: '41235678', name: 'María Flores' } })
      const doc = async (tipo: 'BOLETA' | 'FACTURA' = 'BOLETA') => {
        const cliente = tipo === 'FACTURA' ? await prisma.customer.upsert({ where: { tenantId_docType_docNumber: { tenantId: t.id, docType: 'RUC', docNumber: completarRuc('2000000001') } }, update: {}, create: { tenantId: t.id, docType: 'RUC', docNumber: completarRuc('2000000001'), name: 'Constructora Andes SAC' } }) : cli
        const v = await registerSale(db, ctx, registerSaleSchema.parse({ warehouseId: w.id, customerId: cliente.id, items: [{ productId: p.id, quantity: 2 }], payments: [{ method: 'EFECTIVO', amount: 60 }], idempotencyKey: randomUUID() }))
        return issueTaxDocument(db, ctx, { saleId: v.saleId, documentType: tipo })
      }
      const venta = async () => (await registerSale(db, ctx, registerSaleSchema.parse({ warehouseId: w.id, customerId: cli.id, items: [{ productId: p.id, quantity: 1 }], payments: [{ method: 'EFECTIVO', amount: 30 }], idempotencyKey: randomUUID() }))).saleId
      return { t, branch, ctx, db, doc, venta }
    }
    let llamadas = 0
    const espia: ProveedorFacturacion = { ...obtenerProveedor('mock'), emitir: async (...a) => { llamadas++; return obtenerProveedor('mock').emitir(...a) } }
    const enviar = (N: Awaited<ReturnType<typeof mkNegocio>>, id: string) => enviarComprobante(N.db, N.ctx, id, { proveedor: espia, credenciales: cred })

    console.log('\n3) ENSAYO: los documentos van en serie de PRUEBA y no tocan la real')
    const A = await mkNegocio('a')
    const b1 = await A.doc(), b2 = await A.doc(), b3 = await A.doc(), f1 = await A.doc('FACTURA')
    check('>>> boletas PB001-1..3 y factura PF001-1, todas isTrial', [b1, b2, b3].every((d) => d.isTrial) && b1.fullNumber === 'PB001-00000001' && b3.fullNumber === 'PB001-00000003' && f1.fullNumber === 'PF001-00000001' && f1.isTrial, `${b1.fullNumber} ${b3.fullNumber} ${f1.fullNumber}`)
    check('>>> la serie real NO se tocó: ningún documento en serie real', (await contarDocumentosEnSerieReal(A.t.id)) === 0)
    const contadoresReales = await prisma.documentCounter.findMany({ where: { tenantId: A.t.id, scope: { in: ['TAX_BOLETA', 'TAX_FACTURA'] } } })
    check('los contadores reales no avanzaron (next = startNumber)', contadoresReales.every((c) => c.next === c.startNumber))
    const series = await listarSeriesConfigurables(A.db, A.ctx, A.branch.id)
    check('>>> el panel de series sigue mostrando la real EDITABLE: el ensayo no la bloquea', series.find((s) => s.scope === 'TAX_BOLETA')!.editable === true)
    await fijarArranqueSerie(A.db, A.ctx, { branchId: A.branch.id, scope: 'TAX_BOLETA', startNumber: 500 } as never)
    check('el dueño fija en qué número arranca la serie real mientras está en ensayo', (await listarSeriesConfigurables(A.db, A.ctx, A.branch.id)).find((s) => s.scope === 'TAX_BOLETA')!.next === 500)

    console.log('\n4) >>> Un documento de PRUEBA nunca llega al proveedor')
    llamadas = 0
    check('en ensayo: rechazado por ser de prueba', (await msg(enviar(A, b1.id))).includes('documento de prueba'))
    check('>>> el proveedor NO fue invocado', llamadas === 0)
    check('refrescar el estado de uno de prueba también se rechaza', await code(refrescarEstado(A.db, A.ctx, b1.id, { proveedor: espia, credenciales: cred })) === 'INVALID_DOCUMENT')
    await prisma.taxDocument.update({ where: { id: b1.id }, data: { status: 'ENVIADO' } })
    check('>>> aunque estuviera marcado ENVIADO por error, tampoco se consulta', await code(refrescarEstado(A.db, A.ctx, b1.id, { proveedor: espia, credenciales: cred })) === 'INVALID_DOCUMENT' && llamadas === 0)
    await prisma.taxDocument.update({ where: { id: b1.id }, data: { status: 'PENDIENTE' } })

    console.log('\n5) Habilitar: la serie real nace limpia, y el modelo antiguo bloquea')
    check('>>> con prerrequisitos completos y SIN documentos del modelo antiguo, no falta nada', (await faltantesParaHabilitar(A.t.id)).length === 0)
    const L = await mkNegocio('legado')
    // Simula el modelo ANTIGUO: un documento de serie real (isTrial=false) emitido sin haber habilitado nunca.
    const dl = await L.doc()
    await prisma.taxDocument.update({ where: { id: dl.id }, data: { isTrial: false, series: 'B001', fullNumber: 'B001-00000001', correlativo: 1 } })
    const fl = await faltantesParaHabilitar(L.t.id)
    check('>>> un negocio con documentos del modelo antiguo NO se puede habilitar', fl.some((x) => x.includes('modelo anterior')), fl.join(' | ').slice(0, 140))
    check('...y no se reubican solos: dice que requiere revisión contable', fl.some((x) => x.includes('contador')))
    check('habilitar se rechaza', await code(cambiarFacturacionReal({ tenantId: L.t.id, accion: 'habilitar', reason: 'Intento con documentos heredados' }, actor)) === 'INVALID_DOCUMENT')
    check('...y no cambió nada', (await prisma.tenant.findUniqueOrThrow({ where: { id: L.t.id } })).realBillingEnabledAt === null && (await prisma.taxDocument.findUniqueOrThrow({ where: { id: dl.id } })).fullNumber === 'B001-00000001')

    await cambiarFacturacionReal({ tenantId: A.t.id, accion: 'habilitar', reason: 'Sandbox validado el 12/11' }, actor)
    const real1 = await A.doc()
    check('>>> al habilitar, el primer documento real arranca en el correlativo que fijó el dueño (500)', !real1.isTrial && real1.fullNumber === 'B001-00000500', real1.fullNumber)
    check('los documentos de prueba de antes siguen siendo de prueba (no se renumeran ni se tocan)', (await prisma.taxDocument.findUniqueOrThrow({ where: { id: b2.id } })).isTrial === true && b2.fullNumber === 'PB001-00000002')
    check('>>> los de prueba NO cuentan como documentos en serie real', (await contarDocumentosEnSerieReal(A.t.id)) === 1)
    check('>>> volver a ensayo se rechaza: ya hay un documento real', (await msg(cambiarFacturacionReal({ tenantId: A.t.id, accion: 'volver_a_ensayo', reason: 'Quiero volver a ensayo' }, actor))).includes('ya se emitieron'))

    console.log('\n6) Los de prueba siguen sin llegar al proveedor con el negocio ya en REAL y en PAUSA')
    llamadas = 0
    check('en REAL: el de prueba se rechaza y el proveedor no se invoca', (await msg(enviar(A, b2.id))).includes('documento de prueba') && llamadas === 0)
    await cambiarFacturacionReal({ tenantId: A.t.id, accion: 'pausar', reason: 'El proveedor falla; se pausa' }, actor)
    check('en PAUSA: el de prueba también', (await msg(enviar(A, b3.id))).includes('documento de prueba') && llamadas === 0)

    console.log('\n7) PAUSADO: numeración real, envío detenido, y se reanuda')
    const pausado = await A.doc()
    check('>>> en pausa se sigue emitiendo en serie REAL (nunca en prueba)', !pausado.isTrial && pausado.fullNumber === 'B001-00000501', pausado.fullNumber)
    check('el envío se rechaza por la pausa, con un mensaje claro', (await msg(enviar(A, pausado.id))).includes('en pausa'))
    check('>>> y el proveedor NO fue invocado', llamadas === 0)
    check('el comprobante queda PENDIENTE', (await prisma.taxDocument.findUniqueOrThrow({ where: { id: pausado.id } })).status === 'PENDIENTE')
    await prisma.branch.update({ where: { id: A.branch.id }, data: { address: null } })
    check('>>> en pausa también se exigen los requisitos de sucursal al emitir', (await msg(A.doc())).includes('falta:'))
    await prisma.branch.update({ where: { id: A.branch.id }, data: { address: 'Av. Los Constructores 123, Lima' } })
    await cambiarFacturacionReal({ tenantId: A.t.id, accion: 'reanudar', reason: 'El proveedor corrigió el fallo' }, actor)
    check('reanudado, el pendiente SÍ sale al proveedor', (await enviar(A, pausado.id)).estado === 'ACEPTADO' && llamadas === 1)

    console.log('\n8) Alarma contra la base: los de prueba no cuentan')
    const R = await mkNegocio('real')
    await cambiarFacturacionReal({ tenantId: R.t.id, accion: 'habilitar', reason: 'Sandbox validado el 12/11' }, actor)
    const real = await R.doc(); const real2 = await R.doc()
    // Tres documentos de PRUEBA, más viejos que los reales, no deben influir en nada.
    for (let i = 0; i < 3; i++) {
      await prisma.taxDocument.create({ data: { tenantId: R.t.id, saleId: await R.venta(), documentType: 'BOLETA', series: 'PB001', correlativo: 900 + i, fullNumber: `PB001-0000090${i}`, status: 'PENDIENTE', isTrial: true, subtotal: 1, taxTotal: 0, total: 1, issuedAt: horasAtras(500) } })
    }
    check('(preparación) hay 3 documentos de prueba pendientes, mucho más viejos que los reales', (await prisma.taxDocument.count({ where: { tenantId: R.t.id, isTrial: true, status: 'PENDIENTE' } })) === 3)
    await prisma.taxDocument.update({ where: { id: real.id }, data: { issuedAt: horasAtras(30) } })
    await prisma.taxDocument.update({ where: { id: real2.id }, data: { issuedAt: horasAtras(2) } })
    const e1 = await estadoEnvioFiscal(R.db)
    check('>>> cuenta SOLO los reales: 2 sin enviar', e1.sinEnviar === 2, String(e1.sinEnviar))
    check('>>> la antigüedad es la del real más viejo (≈30 h), no la de los de prueba (500 h)', e1.masAntiguoHoras !== null && e1.masAntiguoHoras > 29 && e1.masAntiguoHoras < 31, String(e1.masAntiguoHoras))
    check('a las 30 h con umbral de 24 h: aviso', e1.nivel === 'aviso' && e1.mostrar)
    await prisma.taxDocument.update({ where: { id: real.id }, data: { issuedAt: horasAtras(80) } })
    check('a las 80 h con umbral de 72 h: crítico', (await estadoEnvioFiscal(R.db)).nivel === 'critico')

    console.log('\n9) Umbrales configurables por negocio (los plazos de SUNAT los confirma el usuario)')
    await fijarUmbralesAlerta({ tenantId: R.t.id, warnHours: 100, criticalHours: 200, reason: 'Plazo confirmado por el contador' }, actor)
    const e2 = await estadoEnvioFiscal(R.db)
    check('>>> con umbrales de 100/200 h, lo de 80 h ya no alarma', e2.nivel === 'ok' && !e2.mostrar && e2.umbrales.avisoHoras === 100 && e2.umbrales.criticoHoras === 200)
    check('queda auditado con antes y después', (await prisma.auditLog.count({ where: { tenantId: R.t.id, action: 'tenant.facturacion_real.umbrales' } })) === 1)
    check('aviso ≥ crítico se rechaza', await code(fijarUmbralesAlerta({ tenantId: R.t.id, warnHours: 50, criticalHours: 50, reason: 'Umbrales incoherentes' }, actor)) === 'INVALID_DOCUMENT')
    check('valores no enteros o fuera de rango se rechazan', await code(fijarUmbralesAlerta({ tenantId: R.t.id, warnHours: 1.5, criticalHours: 10, reason: 'No entero' }, actor)) === 'INVALID_DOCUMENT' && await code(fijarUmbralesAlerta({ tenantId: R.t.id, warnHours: 0, criticalHours: 10, reason: 'Cero horas' }, actor)) === 'INVALID_DOCUMENT')
    await fijarUmbralesAlerta({ tenantId: R.t.id, warnHours: null, criticalHours: null, reason: 'Vuelve al valor por defecto' }, actor)
    check('vacío = valor por defecto de la plataforma', (await estadoEnvioFiscal(R.db)).umbrales.avisoHoras === 24)
    const sinAlarma = await estadoEnvioFiscal(A.db)
    check('un negocio en ensayo no tiene alarma', (await estadoEnvioFiscal(L.db)).mostrar === false)
    void sinAlarma

    console.log('\n10) El SuperAdmin ve el modo y la alarma de cada negocio')
    await cambiarFacturacionReal({ tenantId: R.t.id, accion: 'pausar', reason: 'Pausa para probar el panel' }, actor)
    const panel = await getSuperAdminDashboard()
    const fila = panel.tenants.find((t) => t.id === R.t.id)
    check('>>> aparece como PAUSADO, con cuántos sin enviar y cuánto lleva el más viejo', fila?.modoFiscal === 'PAUSADO' && fila.envioFiscal.sinEnviar === 2 && (fila.envioFiscal.masAntiguoHoras ?? 0) > 79, JSON.stringify(fila?.envioFiscal))
    check('y el nivel es crítico (80 h > 72 h)', fila?.envioFiscal.nivel === 'critico')
    check('el negocio en ensayo figura como ENSAYO y sin alarma', panel.tenants.find((t) => t.id === L.t.id)?.modoFiscal === 'ENSAYO' && panel.tenants.find((t) => t.id === L.t.id)?.envioFiscal.nivel === 'ok')

    console.log('\n11) >>> El ticket de un documento de PRUEBA no se parece a un comprobante electrónico')
    const trial = await getDocumentoImprimible(A.db, 'comprobante', b2.id)
    const htmlT = renderToStaticMarkup(createElement(TicketTermico, { doc: trial }))
    check('es un documento interno de prueba, no un comprobante', trial.tipo === 'venta' && trial.titulo === 'DOCUMENTO DE PRUEBA')
    check('>>> lleva la leyenda «DOCUMENTO DE PRUEBA, SIN VALOR TRIBUTARIO»', htmlT.includes('DOCUMENTO DE PRUEBA') && htmlT.includes('SIN VALOR TRIBUTARIO'))
    check('>>> NO dice «electrónic*» en ninguna parte', !/electr[oó]nic/i.test(htmlT), (htmlT.match(/.{20}electr[oó]nic.{20}/i) ?? [''])[0])
    check('>>> NO invita a consultar la validez en SUNAT ni habla de validación', !/sunat/i.test(htmlT) && !/validaci[oó]n/i.test(htmlT))
    check('>>> sin QR ni hash', trial.qr === null && trial.hashXml === null && !htmlT.includes('<svg') && !htmlT.includes('Hash:'))
    check('lleva la marca de agua PRUEBA', trial.marcaAgua === 'PRUEBA' && htmlT.includes('PRUEBA'))
    check('el número es el de la serie de prueba (nunca B001/F001)', trial.numero.startsWith('PB001-') && !/\b[BF]\d{3}-/.test(trial.numero))
    check('no muestra estado tributario', trial.estadoTributario === null)
    await prisma.taxDocument.update({ where: { id: pausado.id }, data: { status: 'ACEPTADO', xmlHash: 'HASH-REAL-DEL-PROVEEDOR', acceptedAt: new Date() } })
    const realDoc = await getDocumentoImprimible(A.db, 'comprobante', pausado.id)
    const htmlR = renderToStaticMarkup(createElement(TicketTermico, { doc: realDoc }))
    check('control: el ticket de un comprobante REAL aceptado sí es «electrónico» y lleva su hash', realDoc.tipo === 'comprobante' && /electr[oó]nic/i.test(htmlR) && htmlR.includes('HASH-REAL-DEL-PROVEEDOR'))
    check('y NO lleva la leyenda de prueba', !htmlR.includes('SIN VALOR TRIBUTARIO') && !htmlR.includes('DOCUMENTO DE PRUEBA'))

    console.log('\n12) ESTRUCTURA')
    const proj = proyecto()
    const envio = abrir(proj, 'src/features/invoicing/envio.ts')
    const interno = envio.getFunction('enviarInterno')!.getText()
    check('>>> enviarInterno rechaza el documento de prueba ANTES de elegir proveedor', interno.indexOf('doc.isTrial') !== -1 && interno.indexOf('doc.isTrial') < interno.indexOf('elegirProveedor('))
    check('consultarInterno también lo comprueba', envio.getFunction('consultarInterno')!.getText().includes('doc.isTrial'))
    check('>>> los envoltorios con permisos (enviarComprobante, refrescarEstado) DELEGAN en los internos: no hay otro camino hacia el proveedor',
      envio.getFunction('enviarComprobante')!.getText().includes('enviarInterno(') && envio.getFunction('refrescarEstado')!.getText().includes('consultarInterno('))
    check('>>> y el proveedor solo se invoca desde los internos (`proveedor.emitir` / `consultarEstado`)',
      envio.getDescendantsOfKind(SyntaxKind.CallExpression).filter((c) => /proveedor\.(emitir|consultarEstado)$/.test(c.getExpression().getText()))
        .every((c) => ['enviarInterno', 'consultarInterno'].includes(c.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)?.getName() ?? '')))
    const sinFiltro: string[] = []
    const PERMITIDOS = new Set(['src/features/invoicing/counter-service.ts', 'src/app/api/diagnostics/perf/route.ts'])
    for (const f of ficheros(join(RAIZ, 'src'), (p) => /\.(ts|tsx)$/.test(p))) {
      const r = rel(f)
      if (r.startsWith('src/generated/') || PERMITIDOS.has(r)) continue
      const sf = proj.addSourceFileAtPath(f)
      for (const c of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const e = c.getExpression().getText()
        if (/taxDocument\.(count|groupBy|aggregate)$/.test(e) && !c.getText().includes('isTrial')) sinFiltro.push(`${r}: ${e}`)
      }
    }
    check('>>> todo conteo o agregado de comprobantes excluye los de prueba (o es por serie)', sinFiltro.length === 0, sinFiltro.join(' | '))
  } finally {
    if (creados.length) await prisma.tenant.deleteMany({ where: { id: { in: creados } } })
    await prisma.user.delete({ where: { id: actor.id } }).catch(() => {})
  }

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
