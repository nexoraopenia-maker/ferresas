import './guard'
import { correr } from './teardown'
import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { SyntaxKind } from 'ts-morph'
import { ficheros, proyecto, RAIZ, rel } from './ast'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { issueTaxDocument } from '../src/features/invoicing/service'
import { estadoEnvioFiscal } from '../src/features/invoicing/alarma-envio'
import { obtenerProveedor, type CredencialesProveedor, type ProveedorFacturacion, type ResultadoEmision } from '../src/features/invoicing/providers'
import { secretosIguales } from '../src/lib/comparar-secreto'
import {
  LEASE_MS, MAX_INTENTOS, RAMPA_SEGUNDOS, claveIdempotencia, proximoIntento, recortarError, tiempoRestante,
} from '../src/features/cola-fiscal/reglas'
import { seEncola } from '../src/features/cola-fiscal/encolar'
import { adoptarHuerfanos, agotar, agotarVencidos, completar, reclamarSiguiente, reprogramar } from '../src/features/cola-fiscal/repositorio'
import { ejecutarWorker } from '../src/features/cola-fiscal/worker'
import { enviarManual } from '../src/features/cola-fiscal/manual'
import { getSuperAdminDashboard } from '../src/features/superadmin/queries'
import { POST as workerPOST, GET as workerGET } from '../src/app/api/fiscal/worker/route'
import type { TenantContext } from '../src/lib/tenant-context'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (p: Promise<unknown>) => p.then(() => '').catch((e) => String(e.message ?? e))
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))
const cred: CredencialesProveedor = { usuario: 'mock:acepta', clave: 'x', modoPruebas: true }
const OK: ResultadoEmision = { estado: 'ACEPTADO', idExterno: 'ext-1', ticket: null, codigoRespuesta: '0', mensaje: 'La Boleta ha sido aceptada', hashXml: 'HASH-DEL-PROVEEDOR', reintentable: false }
const TRANSITORIO: ResultadoEmision = { estado: 'PENDIENTE', idExterno: null, ticket: null, codigoRespuesta: null, mensaje: 'El proveedor devolvió 503', hashXml: null, reintentable: true }
const mas = (d: Date, s: number) => new Date(d.getTime() + s * 1000)

type Negocio = Awaited<ReturnType<typeof mkNegocio>>

async function mkNegocio(tag: string, modo: 'REAL' | 'PAUSADO' | 'ENSAYO' | 'DEMO') {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({
    data: {
      slug: `cf-${tag}-${randomUUID().slice(0, 6)}`, name: `Cola ${tag}`, legalName: `COLA ${tag.toUpperCase()} SAC`, taxId, planId: plan.id,
      pseConfiguredAt: new Date(), isDemo: modo === 'DEMO',
      ...(modo === 'REAL' || modo === 'PAUSADO' ? { realBillingEnabledAt: new Date(Date.now() - 5 * 86_400_000) } : {}),
      ...(modo === 'PAUSADO' ? { realBillingPausedAt: new Date(Date.now() - 3_600_000) } : {}),
    },
  })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cf' } })
  const { branch, warehouse: w } = await crearSucursalConAlmacen(t.id)
  const u = await prisma.user.create({ data: { tenantId: t.id, email: `o-${randomUUID()}@x.com`, name: 'Dueño', role: 'OWNER' } })
  await asignarSucursal(t.id, u.id, branch.id)
  const ctx: TenantContext = { tenantId: t.id, userId: u.id, role: 'OWNER', access: 'FULL', branchId: branch.id, branchIds: [branch.id] }
  const db = getTenantPrisma(ctx)
  const p = await prisma.product.create({ data: { tenantId: t.id, sku: 'P', name: 'Cemento Sol', salePrice: 11.8 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: w.id, quantity: 100_000 } })
  let correlativo = 0

  /** Documentos creados a mano, con sus líneas (el XML tiene que cuadrar), sin pasar por la emisión: rápido y determinista. */
  const docs = async (n: number, o: { trial?: boolean; cola?: boolean; proximo?: Date; serie?: string } = {}) => {
    const serie = o.serie ?? (o.trial ? 'PB001' : 'B001')
    const ids = Array.from({ length: n }, () => ({ sale: randomUUID(), doc: randomUUID() }))
    await prisma.sale.createMany({ data: ids.map((x, i) => ({ id: x.sale, tenantId: t.id, branchId: branch.id, warehouseId: w.id, userId: u.id, number: `V-${tag}-${randomUUID().slice(0, 6)}-${i}`, status: 'COMPLETADA' as const })) })
    await prisma.saleItem.createMany({ data: ids.map((x) => ({ tenantId: t.id, saleId: x.sale, productId: p.id, nameSnapshot: 'Cemento Sol', skuSnapshot: 'P', quantity: 1, unitPrice: 11.8, lineTotal: 11.8 })) })
    const numeros = ids.map(() => ++correlativo)
    await prisma.taxDocument.createMany({ data: ids.map((x, i) => ({
      id: x.doc, tenantId: t.id, saleId: x.sale, documentType: 'BOLETA' as const, series: serie, correlativo: numeros[i]!,
      fullNumber: `${serie}-${String(numeros[i]).padStart(8, '0')}`, status: 'PENDIENTE' as const, isTrial: !!o.trial,
      issuerTaxId: taxId, issuerLegalName: `COLA ${tag.toUpperCase()} SAC`, subtotal: 10, taxTotal: 1.8, total: 11.8, issuedAt: new Date(Date.now() - 600_000),
    })) })
    if (o.cola !== false) {
      await prisma.fiscalDispatch.createMany({ data: ids.map((x) => ({ tenantId: t.id, taxDocumentId: x.doc, nextAttemptAt: o.proximo ?? new Date(Date.now() - 1000), idempotencyKey: claveIdempotencia(t.id, x.doc) })) })
    }
    return ids.map((x, i) => ({ id: x.doc, fullNumber: `${serie}-${String(numeros[i]).padStart(8, '0')}` }))
  }
  const fila = (docId: string) => prisma.fiscalDispatch.findFirst({ where: { taxDocumentId: docId } })
  const doc = (docId: string) => prisma.taxDocument.findUniqueOrThrow({ where: { id: docId } })
  const venta = async () => (await registerSale(db, ctx, registerSaleSchema.parse({ warehouseId: w.id, items: [{ productId: p.id, quantity: 1 }], payments: [{ method: 'EFECTIVO', amount: 11.8 }], idempotencyKey: randomUUID() }))).saleId
  const emitir = async () => issueTaxDocument(db, ctx, { saleId: await venta(), documentType: 'BOLETA' })
  const retirar = async () => { await prisma.taxDocument.deleteMany({ where: { tenantId: t.id } }); await prisma.tenant.deleteMany({ where: { id: t.id } }) }
  return { t, taxId, branch, w, ctx, db, docs, fila, doc, emitir, retirar }
}

/** Proveedor espía: cuenta las llamadas por comprobante y recuerda a qué emisor se le envió. */
function espia(guion: (n: number, fullNumber: string) => Promise<ResultadoEmision> | ResultadoEmision, demoraMs = 0) {
  const porDoc = new Map<string, number>()
  const emisores: Array<{ fullNumber: string; ruc: string }> = []
  let total = 0
  let consultas = 0
  const base = obtenerProveedor('mock')
  let respuestaConsulta: Awaited<ReturnType<ProveedorFacturacion['consultarEstado']>> = { estado: 'ACEPTADO', hashXml: 'HASH-CONSULTA', codigoRespuesta: '0', mensaje: 'Aceptado', aceptadoEn: null }
  const proveedor: ProveedorFacturacion = {
    ...base,
    emitir: async (c) => {
      total++
      const full = `${c.serie}-${String(c.correlativo).padStart(8, '0')}`
      const n = (porDoc.get(full) ?? 0) + 1
      porDoc.set(full, n)
      emisores.push({ fullNumber: full, ruc: c.emisor.ruc })
      if (demoraMs) await dormir(demoraMs)
      return guion(n, full)
    },
    consultarEstado: async () => { consultas++; return respuestaConsulta },
  }
  return { proveedor, porDoc, emisores, get total() { return total }, get consultas() { return consultas }, set consulta(v: typeof respuestaConsulta) { respuestaConsulta = v } }
}
const correr_ = (t0: Date, p: ProveedorFacturacion, extra: Record<string, unknown> = {}) =>
  ejecutarWorker({ reloj: () => t0, deps: { proveedor: p, credenciales: cred }, presupuestoMs: 600_000, margenEnvioMs: 0, ...extra })

async function main() {
  const actor = { id: (await prisma.user.create({ data: { email: `sa-${randomUUID()}@x.com`, name: 'SA', role: 'SUPERADMIN' } })).id }
  const secretoAntes = process.env.FISCAL_WORKER_SECRET
  const abiertos: Negocio[] = []
  const nuevo = async (tag: string, modo: Parameters<typeof mkNegocio>[1]) => { const n = await mkNegocio(tag, modo); abiertos.push(n); return n }

  try {
    console.log('\n1) Reglas de la cola (puras)')
    check('>>> la rampa es exactamente 1 min, 5 min, 30 min, 2 h y 12 h', JSON.stringify(RAMPA_SEGUNDOS) === JSON.stringify([60, 300, 1800, 7200, 43200]))
    check('1 intento inmediato + 5 reintentos = 6 intentos', MAX_INTENTOS === 6)
    const t0 = new Date('2026-10-23T12:00:00.000Z')
    const esperas = [1, 2, 3, 4, 5].map((n) => proximoIntento(n, t0))
    check('>>> tras cada fallo espera lo que toca', esperas.every((e, i) => !e.agotado && e.segundos === RAMPA_SEGUNDOS[i] && e.en!.getTime() === t0.getTime() + RAMPA_SEGUNDOS[i]! * 1000))
    check('>>> tras el SEXTO intento fallido ya no hay más: agotado', proximoIntento(6, t0).agotado === true && proximoIntento(7, t0).agotado === true)
    check('la clave de idempotencia es estable e incluye negocio, documento y operación', claveIdempotencia('t1', 'd1') === claveIdempotencia('t1', 'd1', 'ENVIAR') && claveIdempotencia('t1', 'd1', 'CONSULTAR') !== claveIdempotencia('t1', 'd1') && claveIdempotencia('t2', 'd1') !== claveIdempotencia('t1', 'd1'))
    check('los errores largos se recortan', recortarError(new Error('x'.repeat(2000))).length <= 500 && recortarError('boom') === 'boom')
    check('el lease dura más que un envío (15 s)', LEASE_MS > 15_000)
    check('presupuesto de tiempo: lo que queda', tiempoRestante(1000, 45_000, 6000) === 40_000)
    check('>>> los documentos de PRUEBA no se encolan en ningún modo; la demo y el ensayo tampoco',
      (['DEMO', 'ENSAYO', 'REAL', 'PAUSADO'] as const).every((m) => !seEncola({ isTrial: true }, m)) && !seEncola({ isTrial: false }, 'DEMO') && !seEncola({ isTrial: false }, 'ENSAYO')
      && seEncola({ isTrial: false }, 'REAL') && seEncola({ isTrial: false }, 'PAUSADO'))

    console.log('\n2) Secreto del endpoint: comparación en tiempo constante')
    check('iguales → true; distintos → false', secretosIguales('abc-123-secreto-largo', 'abc-123-secreto-largo') && !secretosIguales('abc-123-secreto-largo', 'abc-123-secreto-largp'))
    check('>>> longitudes distintas → false, sin lanzar (no filtra la longitud)', !secretosIguales('corto', 'un-secreto-bastante-mas-largo') && !secretosIguales('', 'x') && !secretosIguales('', ''.padEnd(1, 'x')))
    check('unicode y vacío', secretosIguales('clave-ñandú', 'clave-ñandú') && !secretosIguales('clave-ñandú', 'clave-nandu'))

    console.log('\n3) Entrada a la cola: dentro de la transacción de la emisión')
    const R = await nuevo('real', 'REAL')
    const emitido = await R.emitir()
    const filaE = await R.fila(emitido.id)
    check('>>> un comprobante REAL nace con su fila en la cola, pendiente y sin intentos', !emitido.isTrial && filaE?.status === 'PENDIENTE' && filaE.attempts === 0 && filaE.op === 'ENVIAR')
    check('con la clave de idempotencia estable', filaE?.idempotencyKey === claveIdempotencia(R.t.id, emitido.id))
    check('>>> una segunda fila para el mismo documento se rechaza (único por negocio y documento)', await code(R.db.fiscalDispatch.create({ data: { tenantId: R.t.id, taxDocumentId: emitido.id, idempotencyKey: `otra-${randomUUID()}` } })) === 'P2002')
    check('y la misma clave de idempotencia tampoco se repite', await code(prisma.fiscalDispatch.create({ data: { tenantId: R.t.id, taxDocumentId: (await R.docs(1, { cola: false, serie: 'B777' }))[0]!.id, idempotencyKey: claveIdempotencia(R.t.id, emitido.id) } })) === 'P2002')
    const P = await nuevo('pausa', 'PAUSADO')
    const emPausa = await P.emitir()
    check('en PAUSA también se encola (espera hasta reanudar)', !emPausa.isTrial && (await P.fila(emPausa.id))?.status === 'PENDIENTE')
    const E = await nuevo('ensayo', 'ENSAYO')
    const emEnsayo = await E.emitir()
    check('>>> en ENSAYO el documento es de prueba y NO hay fila en la cola', emEnsayo.isTrial && (await E.fila(emEnsayo.id)) === null)
    const D = await nuevo('demo', 'DEMO')
    const emDemo = await D.emitir()
    check('la demo emite sin cola (envía por su camino, al simulado)', !emDemo.isTrial && (await D.fila(emDemo.id)) === null)
    for (const n of [R, P, E, D]) await n.retirar()
    abiertos.length = 0

    console.log('\n4) >>> Reclamo atómico: N workers concurrentes, ningún doble envío')
    const C = await nuevo('conc', 'REAL')
    const lote = await C.docs(10)
    const sp = espia(() => OK, 120)
    const ahora = new Date()
    const resumenes = await Promise.all([1, 2, 3, 4, 5].map((i) => correr_(ahora, sp.proveedor, { workerId: `w${i}` })))
    check('>>> los 10 comprobantes se enviaron EXACTAMENTE una vez cada uno', lote.every((d) => sp.porDoc.get(d.fullNumber) === 1) && sp.total >= 10, `${[...sp.porDoc.values()].join(',')}`)
    check('>>> entre los 5 workers procesaron 10 filas, ni una de más', resumenes.reduce((a, r) => a + r.procesados, 0) === 10, resumenes.map((r) => r.procesados).join('+'))
    check('todos ACEPTADO por la respuesta del proveedor (hash guardado)', (await Promise.all(lote.map((d) => C.doc(d.id)))).every((d) => d.status === 'ACEPTADO' && d.xmlHash === 'HASH-DEL-PROVEEDOR'))
    check('filas COMPLETADO, con un solo intento y sin lease', (await Promise.all(lote.map((d) => C.fila(d.id)))).every((f) => f?.status === 'COMPLETADO' && f.attempts === 1 && f.lockedBy === null && f.lockedUntil === null))
    check('>>> cada comprobante se envió a SU emisor (sin mezclar negocios)', sp.emisores.every((e) => e.ruc === C.taxId))

    const C2 = await nuevo('conc2', 'REAL')
    await C2.docs(5)
    const reclamos = await Promise.all(Array.from({ length: 20 }, (_, i) => reclamarSiguiente(`r${i}`, new Date())))
    const ids = reclamos.filter(Boolean).map((r) => r!.id)
    check('>>> 20 reclamos simultáneos sobre 5 filas: exactamente 5 reciben una, todas DISTINTAS', ids.length === 5 && new Set(ids).size === 5, `${ids.length}/${new Set(ids).size}`)
    check('las otras 15 reciben «no hay trabajo»', reclamos.filter((r) => r === null).length === 15)
    check('cada fila reclamada quedó EN_CURSO con su lease y su dueño', (await prisma.fiscalDispatch.findMany({ where: { tenantId: C2.t.id } })).every((f) => f.status === 'EN_CURSO' && f.lockedUntil !== null && f.lockedBy !== null && f.attempts === 1))
    await C.retirar(); await C2.retirar()
    abiertos.length = 0

    console.log('\n5) Solapamiento: una pasada lenta no impide que otra avance, ni se pisan')
    const S = await nuevo('solape', 'REAL')
    const lS = await S.docs(6)
    const lento = espia(() => OK, 250)
    const [a, b] = await Promise.all([correr_(new Date(), lento.proveedor, { workerId: 'lenta-a', maxFilas: 3 }), (async () => { await dormir(60); return correr_(new Date(), lento.proveedor, { workerId: 'lenta-b' }) })()])
    check('>>> A y B solapadas: 6 documentos, cada uno enviado una sola vez', lS.every((d) => lento.porDoc.get(d.fullNumber) === 1) && a.procesados + b.procesados === 6, `${a.procesados}+${b.procesados}`)
    check('y B no esperó a que A terminara (procesó lo que A no tenía)', b.procesados >= 3)
    await S.retirar(); abiertos.length = 0

    console.log('\n6) >>> Lease: si el worker se cae a mitad de un envío, la fila se recupera')
    const L = await nuevo('lease', 'REAL')
    const [dl] = await L.docs(1)
    const tc = new Date()
    const reclamada = await reclamarSiguiente('w-muerto', tc)
    check('el worker «que va a morir» reclama la fila: EN_CURSO con lease', reclamada?.id === (await L.fila(dl!.id))?.id && (await L.fila(dl!.id))?.status === 'EN_CURSO')
    const spL = espia(() => OK)
    const durante = await correr_(new Date(tc.getTime() + LEASE_MS - 5_000), spL.proveedor)
    check('>>> con el lease VIGENTE nadie más la toca (no se envía dos veces)', durante.procesados === 0 && spL.total === 0)
    const tras = await correr_(new Date(tc.getTime() + LEASE_MS + 1_000), spL.proveedor)
    check('>>> con el lease VENCIDO otro worker la recupera y la envía', tras.procesados === 1 && spL.porDoc.get(dl!.fullNumber) === 1 && (await L.doc(dl!.id)).status === 'ACEPTADO')
    const fl = await L.fila(dl!.id)
    check('la caída gastó un intento (2 en total) y la fila quedó COMPLETADO sin lease', fl?.attempts === 2 && fl.status === 'COMPLETADO' && fl.lockedBy === null)

    console.log('\n7) Fencing: un worker lento no puede pisar el resultado del que recuperó su fila')
    const [dF] = await L.docs(1)
    const t1 = new Date()
    const filaA = (await reclamarSiguiente('worker-A', t1))!
    const filaB = (await reclamarSiguiente('worker-B', new Date(t1.getTime() + LEASE_MS + 1_000)))!
    check('B recupera la fila de A tras vencer el lease', filaB.id === filaA.id && filaB.lockedBy === 'worker-B' && filaB.attempts === 2)
    // El caso que importa: A despierta MIENTRAS B todavía tiene el lease (EN_CURSO). Sin fencing por `lockedBy`, A pisaría a B.
    check('>>> A, que despierta tarde MIENTRAS B tiene la fila, NO puede completarla, reprogramarla ni agotarla', (await completar(filaA, new Date(), 'tarde')) === false && (await reprogramar(filaA, new Date(), 'tarde')) === false && (await agotar(filaA, new Date(), 'tarde')) === false)
    const enCursoB = await L.fila(dF!.id)
    check('>>> y la fila sigue siendo de B, EN_CURSO e intacta', enCursoB?.status === 'EN_CURSO' && enCursoB.lockedBy === 'worker-B' && enCursoB.lastError === null && enCursoB.attempts === 2)
    check('B la completa', (await completar(filaB, new Date(), null)) === true)
    check('después de cerrada, A tampoco puede tocarla', (await completar(filaA, new Date(), 'tarde')) === false && (await L.fila(dF!.id))?.status === 'COMPLETADO' && (await L.fila(dF!.id))?.lastError === null)

    console.log('\n8) Caída en el ÚLTIMO intento: sin reintentos que gastar → AGOTADO, sin respuesta del proveedor')
    const [dU] = await L.docs(1)
    await prisma.fiscalDispatch.updateMany({ where: { taxDocumentId: dU!.id }, data: { attempts: MAX_INTENTOS - 1 } })
    const t2 = new Date()
    await reclamarSiguiente('w-muerto-2', t2)
    check('el sexto intento queda EN_CURSO', (await L.fila(dU!.id))?.attempts === MAX_INTENTOS)
    const spU = espia(() => OK)
    const vencida = await correr_(new Date(t2.getTime() + LEASE_MS + 1_000), spU.proveedor)
    const fu = await L.fila(dU!.id)
    check('>>> la fila vencida del último intento pasa a AGOTADO (no se reclama más)', fu?.status === 'AGOTADO' && fu.exhaustedAt !== null && vencida.agotadosPorCaida === 1 && spU.total === 0)
    check('>>> y el comprobante sigue PENDIENTE: nunca se marcó aceptado', (await L.doc(dU!.id)).status === 'PENDIENTE')
    check('queda auditado', (await prisma.auditLog.count({ where: { tenantId: L.t.id, action: 'cola.agotado', entityId: dU!.id } })) === 1)
    await L.retirar(); abiertos.length = 0

    console.log('\n9) Reintentos con la rampa exacta, y NUNCA «aceptado» sin respuesta')
    const T = await nuevo('rampa', 'REAL')
    const [dr] = await T.docs(1, { proximo: new Date(Date.now() - 1000) })
    const spT = espia(() => TRANSITORIO)
    const tt0 = new Date()
    const instantes = [tt0]
    for (const s of RAMPA_SEGUNDOS) instantes.push(mas(instantes.at(-1)!, s))
    // Un intento puede gastarse ANTES de llegar al proveedor (un corte de la base dentro de la zona protegida:
    // se reprograma igual y no hay llamada). Se contabilizan para que «llamadas = intentos − gastados» sea EXACTO
    // aunque Neon corte la conexión a mitad de la prueba. (El caso queda fijado de forma determinista en la sección 9b.)
    let gastados = 0
    const contarGastado = async (llamadasAntes: number) => {
      const f = (await T.fila(dr!.id))!
      if (spT.total === llamadasAntes) { gastados++; console.log(`   ℹ intento sin llamada al proveedor (infraestructura): ${(f.lastError ?? '').slice(0, 80)}`) }
    }
    // Intentos 1 a 5: cada uno falla y reprograma según la rampa.
    for (let i = 0; i < 5; i++) {
      const antesTotal = spT.total
      const r = await correr_(instantes[i]!, spT.proveedor)
      await contarGastado(antesTotal)
      const f = (await T.fila(dr!.id))!
      check(`intento ${i + 1}: falla, queda PENDIENTE y reintenta a los ${RAMPA_SEGUNDOS[i]} s exactos`, r.reintentos === 1 && f.status === 'PENDIENTE' && f.attempts === i + 1 && f.nextAttemptAt.getTime() === mas(instantes[i]!, RAMPA_SEGUNDOS[i]!).getTime())
      const antes = await correr_(new Date(mas(instantes[i]!, RAMPA_SEGUNDOS[i]!).getTime() - 1000), spT.proveedor)
      check(`   1 s antes de tiempo no se vuelve a intentar`, antes.procesados === 0)
    }
    check('>>> tras 5 fallos el comprobante sigue PENDIENTE, sin hash, sin fecha de aceptación', await (async () => { const d = await T.doc(dr!.id); return d.status === 'PENDIENTE' && d.xmlHash === null && d.acceptedAt === null })())
    const antes6 = spT.total
    const r6 = await correr_(instantes[5]!, spT.proveedor)
    await contarGastado(antes6)
    const f6 = (await T.fila(dr!.id))!
    check('>>> el SEXTO fallo agota: AGOTADO, sin más reintentos programados', r6.agotados === 1 && f6.status === 'AGOTADO' && f6.attempts === 6 && f6.exhaustedAt !== null)
    check('>>> contabilidad exacta: llamadas al proveedor = 6 intentos − los gastados antes de llegar a él', spT.total === 6 - gastados && f6.attempts === 6, `llamadas=${spT.total} gastados=${gastados} intentos=${f6.attempts}`)
    check('>>> y NUNCA más llamadas que intentos (ningún envío duplicado)', spT.total <= f6.attempts)
    check('>>> y el comprobante SIGUE PENDIENTE: nunca se marcó aceptado sin respuesta del proveedor', (await T.doc(dr!.id)).status === 'PENDIENTE')
    check('guarda el último error', (f6.lastError ?? '') !== '' && (gastados > 0 || (f6.lastError ?? '').includes('503')))
    check('>>> la clave de idempotencia fue la MISMA en todos los intentos', f6.idempotencyKey === claveIdempotencia(T.t.id, dr!.id))
    check('un agotado ya no se reclama aunque pase el tiempo', await (async () => { const r = await correr_(mas(instantes[5]!, 10 * 86_400), spT.proveedor); return r.procesados === 0 && spT.total === 6 - gastados })(), `total=${spT.total}`)

    console.log('\n9b) >>> Un error ANTES de llegar al proveedor gasta el intento, pero nunca duplica ni pierde un envío')
    const Y = await nuevo('antes', 'REAL')
    const [dy] = await Y.docs(1, { proximo: new Date(Date.now() - 1000) })
    const ventaY = (await Y.doc(dy!.id)).saleId
    const lineaY = (await prisma.saleItem.findFirstOrThrow({ where: { saleId: ventaY } }))
    const copiaLinea = { tenantId: Y.t.id, saleId: ventaY, productId: lineaY.productId, nameSnapshot: lineaY.nameSnapshot, skuSnapshot: lineaY.skuSnapshot, quantity: 1, unitPrice: 11.8, lineTotal: 11.8 }
    const spY = espia(() => TRANSITORIO)
    const iy = [new Date()]
    for (const x of RAMPA_SEGUNDOS) iy.push(mas(iy.at(-1)!, x))
    const traza: string[] = []
    for (let k = 0; k < 6; k++) {
      // En el intento 3 se vacían las líneas de la venta: el comprobante es inconsistente y falla ANTES del proveedor.
      if (k === 2) await prisma.saleItem.deleteMany({ where: { saleId: ventaY } })
      if (k === 3) await prisma.saleItem.create({ data: copiaLinea })
      await correr_(iy[k]!, spY.proveedor)
      const f = (await Y.fila(dy!.id))!
      traza.push(`${f.attempts}/${spY.total}`)
      if (k === 2) {
        check('>>> el intento 3 falla ANTES del proveedor: gasta el intento (3), NO hay llamada (siguen 2)', f.attempts === 3 && spY.total === 2 && (f.lastError ?? '').includes('no tiene líneas'))
        check('...se reprograma con la rampa (5 min) y el comprobante sigue PENDIENTE', f.status === 'PENDIENTE' && f.nextAttemptAt.getTime() === mas(iy[2]!, RAMPA_SEGUNDOS[2]!).getTime() && (await Y.doc(dy!.id)).status === 'PENDIENTE')
      }
      check(`   paso ${k + 1}: nunca más llamadas que intentos`, spY.total <= f.attempts)
    }
    const fy = (await Y.fila(dy!.id))!
    check('>>> el síntoma exacto de la prueba original: 6 intentos, AGOTADO y solo 5 llamadas al proveedor', fy.status === 'AGOTADO' && fy.attempts === 6 && spY.total === 5, traza.join(' '))
    check('>>> y el comprobante sigue PENDIENTE: ni aceptado sin respuesta ni perdido', (await Y.doc(dy!.id)).status === 'PENDIENTE')
    check('ningún documento recibió más de una llamada por intento', [...spY.porDoc.values()].every((n) => n <= 6))
    // Y si el error previo es pasajero, el siguiente intento SÍ llega al proveedor y se acepta (nada se pierde).
    const [dy2] = await Y.docs(1, { proximo: new Date(Date.now() - 1000) })
    const venta2 = (await Y.doc(dy2!.id)).saleId
    const linea2 = await prisma.saleItem.findFirstOrThrow({ where: { saleId: venta2 } })
    await prisma.saleItem.deleteMany({ where: { saleId: venta2 } })
    const spOK2 = espia(() => OK)
    const ty = new Date()
    await correr_(ty, spOK2.proveedor)
    check('un error previo pasajero: intento 1 sin llamada', (await Y.fila(dy2!.id))?.attempts === 1 && spOK2.total === 0)
    await prisma.saleItem.create({ data: { tenantId: Y.t.id, saleId: venta2, productId: linea2.productId, nameSnapshot: linea2.nameSnapshot, skuSnapshot: linea2.skuSnapshot, quantity: 1, unitPrice: 11.8, lineTotal: 11.8 } })
    await correr_(mas(ty, 60), spOK2.proveedor)
    check('>>> al reintentar llega al proveedor UNA vez y se acepta: ni duplicado ni perdido', spOK2.porDoc.get(dy2!.fullNumber) === 1 && (await Y.doc(dy2!.id)).status === 'ACEPTADO' && (await Y.fila(dy2!.id))?.attempts === 2 && (await Y.fila(dy2!.id))?.status === 'COMPLETADO')
    await Y.retirar(); abiertos.length = 0

    console.log('\n10) Alarma al dueño y al SuperAdmin cuando se agota')
    const est = await estadoEnvioFiscal(T.db)
    check('>>> el estado del negocio cuenta el agotado y es CRÍTICO', est.agotados === 1 && est.nivel === 'critico' && est.mostrar)
    const panel = await getSuperAdminDashboard()
    const fila = panel.tenants.find((x) => x.id === T.t.id)
    check('>>> el SuperAdmin lo ve: 1 agotado, nivel crítico', fila?.envioFiscal.agotados === 1 && fila.envioFiscal.nivel === 'critico')

    console.log('\n11) Reintento manual de un agotado: reabre y envía por la misma cola')
    const spOK = espia(() => OK)
    const manual = await enviarManual(T.db, T.ctx, dr!.id, { proveedor: spOK.proveedor, credenciales: cred })
    check('>>> «Reintentar» lo reabre y el proveedor lo acepta', manual.estado === 'ACEPTADO' && (await T.doc(dr!.id)).status === 'ACEPTADO' && spOK.total === 1)
    check('la fila queda COMPLETADO y se audita el reintento manual', (await T.fila(dr!.id))?.status === 'COMPLETADO' && (await prisma.auditLog.count({ where: { tenantId: T.t.id, action: 'cola.reintento_manual', entityId: dr!.id } })) === 1)
    check('con la cola ya resuelta, la alarma se apaga', (await estadoEnvioFiscal(T.db)).agotados === 0)
    check('>>> un clic manual sobre uno que YA está EN_CURSO de otro worker no envía dos veces', await (async () => {
      const [dm] = await T.docs(1)
      await reclamarSiguiente('otro-worker', new Date())
      const sp2 = espia(() => OK)
      const e = await code(enviarManual(T.db, T.ctx, dm!.id, { proveedor: sp2.proveedor, credenciales: cred }))
      return e === 'INVALID_DOCUMENT' && sp2.total === 0
    })())
    await T.retirar(); abiertos.length = 0

    console.log('\n12) Rechazos, excepciones y proveedores asíncronos')
    const X = await nuevo('resp', 'REAL')
    const [dRech, dExc, dAsinc, dTres] = await X.docs(4)
    const spX = espia((n, full) => {
      if (full === dRech!.fullNumber) return { ...OK, estado: 'RECHAZADO', codigoRespuesta: '2800', mensaje: 'RUC del receptor inválido', hashXml: null }
      if (full === dExc!.fullNumber) throw new Error(`ECONNRESET ${'x'.repeat(900)}`)
      if (full === dAsinc!.fullNumber) return { ...OK, estado: 'ENVIADO', ticket: 'TCK-1', codigoRespuesta: null, mensaje: 'Recibido', hashXml: null }
      return n < 3 ? TRANSITORIO : OK
    })
    const tx = new Date()
    await correr_(tx, spX.proveedor)
    check('>>> un RECHAZO es definitivo: COMPLETADO con el motivo, sin reintentos', (await X.fila(dRech!.id))?.status === 'COMPLETADO' && (await X.doc(dRech!.id)).status === 'RECHAZADO' && ((await X.fila(dRech!.id))?.lastError ?? '').includes('RUC') && spX.porDoc.get(dRech!.fullNumber) === 1)
    const fExc = (await X.fila(dExc!.id))!
    check('>>> una excepción de red reprograma, no marca nada, y el error se recorta', fExc.status === 'PENDIENTE' && fExc.attempts === 1 && (fExc.lastError ?? '').length <= 500 && (await X.doc(dExc!.id)).status === 'PENDIENTE')
    const fAs = (await X.fila(dAsinc!.id))!
    check('>>> un proveedor asíncrono (ENVIADO) NO es aceptado: la fila pasa a CONSULTAR en 60 s', fAs.op === 'CONSULTAR' && fAs.status === 'PENDIENTE' && fAs.attempts === 0 && fAs.nextAttemptAt.getTime() === mas(tx, 60).getTime() && fAs.idempotencyKey.endsWith(':CONSULTAR') && (await X.doc(dAsinc!.id)).status === 'ENVIADO')
    spX.consulta = { estado: 'ACEPTADO', hashXml: 'H-C', codigoRespuesta: '0', mensaje: 'Aceptado', aceptadoEn: null }
    await correr_(mas(tx, 61), spX.proveedor)
    check('>>> al consultar y recibir la respuesta definitiva, se acepta y se completa', (await X.doc(dAsinc!.id)).status === 'ACEPTADO' && (await X.fila(dAsinc!.id))?.status === 'COMPLETADO' && spX.consultas >= 1)
    await correr_(mas(tx, 62), spX.proveedor)
    await correr_(mas(tx, 62 + 300 + 5), spX.proveedor)
    const fTres = (await X.fila(dTres!.id))!
    check('éxito tras dos fallos: COMPLETADO con 3 intentos', fTres.status === 'COMPLETADO' && fTres.attempts === 3 && (await X.doc(dTres!.id)).status === 'ACEPTADO')
    await X.retirar(); abiertos.length = 0

    console.log('\n13) >>> El worker ignora la PAUSA y los modos sin facturación real; las series de prueba NUNCA entran')
    const Pz = await nuevo('pz', 'PAUSADO')
    const [dp] = await Pz.docs(1)
    const spP = espia(() => OK)
    const enPausa = await correr_(new Date(), spP.proveedor)
    check('>>> en PAUSA el worker no toca la fila: sigue pendiente y sin intentos', enPausa.procesados === 0 && spP.total === 0 && (await Pz.fila(dp!.id))?.status === 'PENDIENTE' && (await Pz.fila(dp!.id))?.attempts === 0)
    await prisma.tenant.update({ where: { id: Pz.t.id }, data: { realBillingPausedAt: null } })
    await correr_(new Date(), spP.proveedor)
    check('al reanudar, SE ENVÍA lo que esperaba', spP.porDoc.get(dp!.fullNumber) === 1 && (await Pz.doc(dp!.id)).status === 'ACEPTADO')

    const Tr = await nuevo('trial', 'REAL')
    const [dt] = await Tr.docs(1, { trial: true })   // documento de PRUEBA con su fila metida A MANO, saltándose el encolado
    const spTr = espia(() => OK)
    await correr_(new Date(), spTr.proveedor)
    check('>>> un documento de PRUEBA con fila insertada a mano NUNCA se reclama ni llega al proveedor', spTr.total === 0 && (await Tr.fila(dt!.id))?.status === 'PENDIENTE' && (await Tr.fila(dt!.id))?.attempts === 0)
    check('...y el envío manual tampoco', (await msg(enviarManual(Tr.db, Tr.ctx, dt!.id, { proveedor: spTr.proveedor, credenciales: cred }))).includes('prueba') && spTr.total === 0)
    const [dtSinFila] = await Tr.docs(1, { trial: true, cola: false })
    await correr_(new Date(), spTr.proveedor)
    check('>>> un documento de prueba SIN fila tampoco se «adopta»', (await Tr.fila(dtSinFila!.id)) === null && spTr.total === 0)

    const Es = await nuevo('ens', 'ENSAYO')
    const [de] = await Es.docs(1)
    await correr_(new Date(), spTr.proveedor)
    check('>>> un negocio en ENSAYO nunca envía, aunque tenga una fila (estado inconsistente)', spTr.total === 0 && (await Es.fila(de!.id))?.attempts === 0)
    const Dm = await nuevo('dem', 'DEMO')
    const [dd] = await Dm.docs(1)
    await correr_(new Date(), spTr.proveedor)
    check('>>> una demo nunca la procesa el worker', spTr.total === 0 && (await Dm.fila(dd!.id))?.attempts === 0)

    console.log('\n14) Huérfanos: lo REAL pendiente sin fila se adopta; lo demás, no')
    const Ho = await nuevo('huer', 'REAL')
    const [dh] = await Ho.docs(1, { cola: false })
    const Hp = await nuevo('huerp', 'PAUSADO')
    const [dhp] = await Hp.docs(1, { cola: false })
    const [dhd] = await Dm.docs(1, { cola: false })
    const [dhe] = await Es.docs(1, { cola: false })
    const adoptados = await adoptarHuerfanos(new Date(), 100)
    check('>>> se adopta el real de un negocio REAL y el de uno en PAUSA', (await Ho.fila(dh!.id)) !== null && (await Hp.fila(dhp!.id)) !== null && adoptados >= 2)
    check('>>> no se adopta ni el de una demo ni el de un negocio en ensayo', (await Dm.fila(dhd!.id)) === null && (await Es.fila(dhe!.id)) === null)
    check('adoptar dos veces no duplica', (await adoptarHuerfanos(new Date(), 100)) === 0 && (await prisma.fiscalDispatch.count({ where: { taxDocumentId: dh!.id } })) === 1)
    const spH = espia(() => OK)
    await correr_(new Date(), spH.proveedor)
    check('lo adoptado de un negocio REAL se envía; lo de la pausa espera', spH.porDoc.get(dh!.fullNumber) === 1 && (await Hp.fila(dhp!.id))?.attempts === 0)
    for (const n of [Pz, Tr, Es, Dm, Ho, Hp]) await n.retirar()
    abiertos.length = 0

    console.log('\n15) >>> Aislamiento por negocio en la tabla nueva')
    const A = await nuevo('aisla', 'REAL')
    const B = await nuevo('aislb', 'REAL')
    const lotesA = await A.docs(2)
    const lotesB = await B.docs(2, { serie: 'B002' })   // serie distinta: así `fullNumber` identifica al negocio sin ambigüedad
    const db_ = lotesB[0]!
    check('>>> A solo ve SUS filas', (await A.db.fiscalDispatch.findMany()).every((f) => f.tenantId === A.t.id) && (await A.db.fiscalDispatch.count()) === 2)
    check('>>> A no puede leer la fila de B por su documento', (await A.db.fiscalDispatch.findFirst({ where: { taxDocumentId: db_.id } })) === null)
    const fB = (await B.fila(db_.id))!
    check('>>> A no puede modificar ni borrar la fila de B', (await A.db.fiscalDispatch.updateMany({ where: { id: fB.id }, data: { status: 'AGOTADO' } })).count === 0 && (await A.db.fiscalDispatch.deleteMany({ where: { id: fB.id } })).count === 0 && (await B.fila(db_.id))?.status === 'PENDIENTE')
    check('>>> A no puede crear una fila a nombre de B', await code(A.db.fiscalDispatch.create({ data: { tenantId: B.t.id, taxDocumentId: db_.id, idempotencyKey: `x-${randomUUID()}` } })) !== null)
    check('>>> ni una fila de A apuntando al documento de B (la clave foránea compuesta lo impide)', await code(prisma.fiscalDispatch.create({ data: { tenantId: A.t.id, taxDocumentId: db_.id, idempotencyKey: `y-${randomUUID()}` } })) !== null)
    check('las alarmas de cada negocio no se mezclan', (await estadoEnvioFiscal(A.db)).agotados === 0 && (await estadoEnvioFiscal(B.db)).agotados === 0)
    const spAB = espia(() => OK)
    await correr_(new Date(), spAB.proveedor)
    const delA = new Set(lotesA.map((d) => d.fullNumber))
    check('>>> el worker envía cada documento al emisor de SU negocio (A y B nunca se cruzan)',
      spAB.emisores.length === 4 && spAB.emisores.every((e) => e.ruc === (delA.has(e.fullNumber) ? A.taxId : B.taxId)) && spAB.emisores.filter((e) => e.ruc === A.taxId).length === 2)
    await A.retirar(); await B.retirar(); abiertos.length = 0

    console.log('\n16) Endpoint /api/fiscal/worker')
    const req = (cab: Record<string, string> = {}, metodo = 'POST') => new NextRequest('http://localhost/api/fiscal/worker', { method: metodo, headers: cab })
    const SECRETO = `secreto-de-prueba-${randomUUID()}`
    delete process.env.FISCAL_WORKER_SECRET
    check('>>> sin secreto configurado se NIEGA a ejecutar: 503', (await workerPOST(req({ authorization: 'Bearer lo-que-sea' }))).status === 503)
    process.env.FISCAL_WORKER_SECRET = 'corto'
    check('>>> un secreto demasiado corto se trata como no configurado: 503', (await workerPOST(req({ authorization: 'Bearer corto' }))).status === 503)
    process.env.FISCAL_WORKER_SECRET = SECRETO
    check('sin cabecera: 401', (await workerPOST(req())).status === 401)
    check('>>> secreto equivocado: 401', (await workerPOST(req({ authorization: 'Bearer nope' }))).status === 401)
    check('>>> uno casi igual (distinto en el último carácter) y otro de otra longitud: 401, sin excepción', (await workerPOST(req({ authorization: `Bearer ${SECRETO.slice(0, -1)}X` }))).status === 401 && (await workerPOST(req({ authorization: `Bearer ${SECRETO}extra` }))).status === 401)
    const ok1 = await workerPOST(req({ authorization: `Bearer ${SECRETO}` }))
    const j1 = await ok1.json()
    check('>>> con el secreto correcto y SIN trabajo: 200 (el programador no debe reintentar por eso)', ok1.status === 200 && j1.ok === true && j1.procesados === 0 && j1.restante === false)
    check('también por la cabecera x-worker-secret', (await workerPOST(req({ 'x-worker-secret': SECRETO }))).status === 200)
    check('la respuesta trae el resumen y NO filtra el secreto', typeof j1.duracionMs === 'number' && j1.workerId && !JSON.stringify(j1).includes(SECRETO))
    check('un GET no ejecuta nada: 405', (await workerGET()).status === 405)
    check('tres llamadas SIMULTÁNEAS sin trabajo: todas 200', (await Promise.all([1, 2, 3].map(() => workerPOST(req({ authorization: `Bearer ${SECRETO}` }))))).every((r) => r.status === 200))

    console.log('\n17) Lotes acotados por tiempo y por tamaño')
    const Lt = await nuevo('lote', 'REAL')
    await Lt.docs(5)
    const spLt = espia(() => OK)
    const sinTiempo = await correr_(new Date(), spLt.proveedor, { presupuestoMs: 50, margenEnvioMs: 10_000 })
    check('>>> sin margen para un envío completo NO empieza ninguno y avisa de que queda trabajo', sinTiempo.procesados === 0 && sinTiempo.restante === true && spLt.total === 0)
    const dos = await correr_(new Date(), spLt.proveedor, { maxFilas: 2 })
    check('>>> el tope de filas se respeta y avisa de que queda más', dos.procesados === 2 && dos.restante === true && spLt.total === 2)
    const resto = await correr_(new Date(), spLt.proveedor)
    check('la siguiente pasada termina el resto y dice que ya no queda', resto.procesados === 3 && resto.restante === false && spLt.total === 5)
    await Lt.retirar(); abiertos.length = 0

    console.log('\n18) La migración y el esquema de la tabla nueva')
    const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE tablename = 'fiscal_dispatches'`)
    const nombres = idx.map((i) => i.indexname)
    check('>>> único por negocio y documento, único por clave de idempotencia', nombres.includes('fiscal_dispatches_tenantId_taxDocumentId_key') && nombres.includes('fiscal_dispatches_idempotencyKey_key'))
    check('>>> índices de reclamo (estado + próximo intento) y de recuperación (estado + lease)', nombres.includes('fiscal_dispatches_status_nextAttemptAt_idx') && nombres.includes('fiscal_dispatches_status_lockedUntil_idx'))
    const fks = await prisma.$queryRawUnsafe<{ conname: string }[]>(`SELECT conname FROM pg_constraint WHERE conrelid = 'fiscal_dispatches'::regclass AND contype = 'f'`)
    check('claves foráneas: al negocio y al comprobante (compuesta con el negocio)', fks.some((f) => f.conname.endsWith('tenantId_taxDocumentId_fkey')) && fks.some((f) => f.conname === 'fiscal_dispatches_tenantId_fkey'))
    const enums = await prisma.$queryRawUnsafe<{ enumlabel: string }[]>(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'FiscalDispatchStatus' ORDER BY e.enumsortorder`)
    check('estados: PENDIENTE, EN_CURSO, COMPLETADO, AGOTADO', enums.map((e) => e.enumlabel).join() === 'PENDIENTE,EN_CURSO,COMPLETADO,AGOTADO')
    const carpetas = readdirSync(join(RAIZ, 'prisma/migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    const miMigracion = carpetas.find((c) => c.endsWith('_fiscal_dispatches'))!
    check('>>> su marca es MAYOR que la de la migración anterior a ella (el orden de aplicación no retrocede)', miMigracion > '20261102120000_fiscal_modo_ensayo' && carpetas.indexOf(miMigracion) === carpetas.indexOf('20261102120000_fiscal_modo_ensayo') + 1, miMigracion)
    check('las marcas de las migraciones no se repiten', new Set(carpetas.map((c) => c.slice(0, 14))).size === carpetas.length)

    console.log('\n19) ESTRUCTURA')
    const proj = proyecto()
    const violaciones: string[] = []
    for (const f of ficheros(join(RAIZ, 'src/features/cola-fiscal'), (p) => p.endsWith('.ts'))) {
      const sf = proj.addSourceFileAtPath(f)
      for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
        if (['status', 'estado'].includes(pa.getName()) && /^'(ACEPTADO|OBSERVADO)'$/.test(pa.getInitializer()?.getText() ?? '')) violaciones.push(`${rel(f)}: ${pa.getText()}`)
      }
    }
    check('>>> el código de la cola NUNCA escribe «aceptado» ni «observado»: solo lo fija la respuesta del proveedor', violaciones.length === 0, violaciones.join(' | '))
    const repo = proj.addSourceFileAtPath(join(RAIZ, 'src/features/cola-fiscal/repositorio.ts')).getFullText()
    check('>>> el reclamo usa FOR UPDATE SKIP LOCKED y el lease', repo.includes('FOR UPDATE OF d SKIP LOCKED') && repo.includes('"lockedUntil"'))
    check('>>> el reclamo excluye demo, sin habilitar, en pausa y documentos de prueba', ['"isDemo" = false', '"realBillingEnabledAt" IS NOT NULL', '"realBillingPausedAt" IS NULL', 'td."isTrial" = false'].every((c) => repo.includes(c)))
    check('el reclamo ignora las filas sin intentos que gastar', repo.includes('d.attempts <'))
    check('toda finalización exige seguir siendo el dueño del lease (fencing)', (repo.match(/where: dueño\(f\)/g) ?? []).length >= 5)
  } finally {
    process.env.FISCAL_WORKER_SECRET = secretoAntes
    if (secretoAntes === undefined) delete process.env.FISCAL_WORKER_SECRET
    for (const n of abiertos) await n.retirar().catch(() => {})
    await prisma.user.delete({ where: { id: actor.id } }).catch(() => {})
  }

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
