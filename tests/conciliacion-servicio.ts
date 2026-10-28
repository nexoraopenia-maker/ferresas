import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { parametrosRegistrosSchema, type ParametrosRegistros } from '../src/features/registros/schemas'
import { calcularConciliacion, exportarConciliacionCsv, informeConciliacion } from '../src/features/conciliacion/conciliacion-service'
import { MENSAJE_SIN_COMPROBANTES, type Hallazgo } from '../src/features/conciliacion/conciliacion-calculo'
import { crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { crearBorrador, recibirCompra } from '../src/features/compras/service'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F5.7 · Conciliación fiscal contra la base. Lo que más importa: un negocio sano sale LIMPIO; cada problema real sale con su nivel; los
 * negocios en ENSAYO o DEMO NUNCA salen con errores ni advertencias («Sin comprobantes reales que conciliar»); cada sucursal ve lo suyo;
 * `reportes.ver` y nada más; y el script de consola es de solo lectura con los códigos de salida prometidos.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const AHORA = new Date('2026-10-27T03:00:00Z')   // lunes 26/10/2026 22:00 en Lima
const hace = (h: number) => new Date(AHORA.getTime() - h * 3_600_000)
const P = (o: Record<string, unknown> = {}): ParametrosRegistros => parametrosRegistrosSchema.parse({ p: 'RANGO', desde: '2026-10-20', hasta: '2026-10-26', ...o })
const RUC_CLIENTE = '20123456789'

type Modo = 'REAL' | 'ENSAYO' | 'DEMO' | 'PAUSADO'
async function negocio(tag: string, modo: Modo = 'REAL') {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: {
    slug: `rp-${tag}-${randomUUID().slice(0, 6)}`, name: `Conciliacion ${tag}`, taxId: ruc(), planId: plan.id,
    ...(modo === 'REAL' || modo === 'PAUSADO' ? { realBillingEnabledAt: new Date('2026-01-01T00:00:00Z') } : {}),
    ...(modo === 'PAUSADO' ? { realBillingPausedAt: new Date('2026-10-01T00:00:00Z') } : {}), ...(modo === 'DEMO' ? { isDemo: true } : {}),
  } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_rp' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const u: Record<string, { id: string; ctx: TenantContext }> = {}
  for (const [nombre, role] of [['owner', 'OWNER'], ['admin', 'ADMIN'], ['contador', 'CONTADOR'], ['cajero', 'CAJERO'], ['vendedor', 'VENDEDOR'], ['almacenero', 'ALMACENERO']] as [string, Role][]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${nombre}-${randomUUID()}@x.com`.toLowerCase(), name: nombre, role } })
    await asignarSucursal(t.id, x.id, b1.branch.id)
    u[nombre] = { id: x.id, ctx: { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id, b2.branch.id], permisosExtra: [] } }
  }
  return { t, b1, b2, u, soloB1: { ...u.admin!.ctx, branchIds: [b1.branch.id] } as TenantContext, owner: u.owner!.ctx, db: (c: TenantContext) => getTenantPrisma(c) }
}
type N = Awaited<ReturnType<typeof negocio>>

let seq = 0
interface OpDoc { tipo?: 'BOLETA' | 'FACTURA'; serie?: string; correlativo?: number; estado?: string; trial?: boolean; total?: number; emitido?: Date; ruc?: string | null }
async function venta(n: N, o: { pide?: 'NOTA_VENTA' | 'BOLETA' | 'FACTURA'; status?: 'COMPLETADA' | 'ANULADA' | 'DEVUELTA'; total?: number; en: Date; branch?: 'b1' | 'b2'; doc?: OpDoc | null }) {
  const b = o.branch === 'b2' ? n.b2 : n.b1
  const total = o.total ?? 118, base = Math.round((total / 1.18) * 100) / 100, igv = Math.round((total - base) * 100) / 100
  const sale = await prisma.sale.create({ data: { tenantId: n.t.id, branchId: b.branch.id, warehouseId: b.warehouse.id, userId: n.owner.userId, number: `V-${++seq}-${randomUUID().slice(0, 4)}`, documentType: o.pide ?? 'BOLETA', status: o.status ?? 'COMPLETADA', ...((o.status ?? 'COMPLETADA') === 'ANULADA' || o.status === 'DEVUELTA' ? { voidedAt: new Date(), voidReason: 'Prueba' } : {}),  subtotal: base, taxTotal: igv, total, completedAt: o.en } })
  let doc = null
  if (o.doc) doc = await documento(n, sale.id, { total, ...o.doc, emitido: o.doc.emitido ?? o.en }, o.pide === 'FACTURA' ? 'FACTURA' : 'BOLETA')
  return { sale, doc }
}
async function documento(n: N, saleId: string, d: OpDoc, tipoPorDefecto: 'BOLETA' | 'FACTURA' = 'BOLETA') {
  const tipo = d.tipo ?? tipoPorDefecto, total = d.total ?? 118, base = Math.round((total / 1.18) * 100) / 100
  const serie = d.serie ?? (d.trial ? (tipo === 'FACTURA' ? 'PF001' : 'PB001') : tipo === 'FACTURA' ? 'F001' : 'B001'), correlativo = d.correlativo ?? ++seq
  return prisma.taxDocument.create({ data: {
    tenantId: n.t.id, saleId, documentType: tipo, series: serie, correlativo, fullNumber: `${serie}-${String(correlativo).padStart(8, '0')}`, status: (d.estado ?? 'ACEPTADO') as never, isTrial: d.trial ?? false,
    subtotal: base, taxTotal: Math.round((total - base) * 100) / 100, total, issuedAt: d.emitido ?? new Date(), receiverDocType: tipo === 'FACTURA' ? (d.ruc === null ? 'SIN_DOCUMENTO' : 'RUC') : 'SIN_DOCUMENTO',
    receiverDocNumber: tipo === 'FACTURA' ? (d.ruc === undefined ? RUC_CLIENTE : d.ruc) : null, receiverName: 'Cliente',
  } })
}
async function nota(n: N, original: { id: string; saleId: string }, o: { total: number; correlativo?: number; estado?: string; total_?: boolean; en: Date; serie?: string; trial?: boolean }) {
  const serie = o.serie ?? 'BC01', correlativo = o.correlativo ?? ++seq, base = Math.round((o.total / 1.18) * 100) / 100
  return prisma.taxDocument.create({ data: {
    tenantId: n.t.id, saleId: original.saleId, documentType: 'NOTA_CREDITO', series: serie, correlativo, fullNumber: `${serie}-${String(correlativo).padStart(8, '0')}`, status: (o.estado ?? 'ACEPTADO') as never, isTrial: o.trial ?? false,
    subtotal: base, taxTotal: Math.round((o.total - base) * 100) / 100, total: o.total, issuedAt: o.en, relatedDocumentId: original.id, reasonCode: o.total_ ? '01' : '07', reasonDescription: 'Prueba',
  } })
}
const contador = (n: N, scope: string, series: string, next: number, startNumber = 1, branch: 'b1' | 'b2' = 'b1') =>
  prisma.documentCounter.create({ data: { tenantId: n.t.id, branchId: (branch === 'b2' ? n.b2 : n.b1).branch.id, scope, series, prefix: '', next, startNumber } })

const informe = (n: N, c: TenantContext = n.owner, p = P()) => informeConciliacion(n.db(c), c, p, AHORA)
const cods = (hs: Hallazgo[]) => hs.map((h) => `${h.codigo}:${h.nivel}`).sort().join()
const de = (hs: Hallazgo[], codigo: string) => hs.filter((h) => h.codigo === codigo)

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 260) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  console.log('\nA) Un negocio sano')
  const A = await negocio('sano')
  await venta(A, { pide: 'BOLETA', en: new Date('2026-10-22T15:00:00Z'), doc: { correlativo: 1 } })
  await venta(A, { pide: 'FACTURA', total: 236, en: new Date('2026-10-23T15:00:00Z'), doc: { correlativo: 1, estado: 'OBSERVADO' } })
  await venta(A, { pide: 'NOTA_VENTA', total: 59, en: new Date('2026-10-24T15:00:00Z') })
  await contador(A, 'TAX_BOLETA', 'B001', 2); await contador(A, 'TAX_FACTURA', 'F001', 2)
  const a = (await informe(A)).informe
  check('>>> sano: estado LIMPIO, sin errores ni advertencias', a.estado === 'LIMPIO' && a.resumen.errores === 0 && a.resumen.advertencias === 0 && a.modo === 'REAL', `${a.estado} ${cods(a.hallazgos)}`)
  check('>>> el puente cuadra: 3 ventas (413.00) = 1 nota de venta (59.00) + 2 con comprobante válido (354.00); diferencia 0', a.puente.ventasCompletadas.documentos === 3 && a.puente.ventasCompletadas.total === 413 && a.puente.notasDeVenta.total === 59 && a.puente.clasificacion.valido.documentos === 2 && a.puente.clasificacion.valido.total === 354 && a.puente.diferencia === 0)
  check('>>> el registro de ventas cuadra con el cálculo independiente de la base (354.00 = 354.00)', a.cuadreVentas.registro === 354 && a.cuadreVentas.independiente === 354 && a.cuadreVentas.diferencia === 0 && a.cuadreCompras.diferencia === 0)
  check('comprobantes reales contados: 2', a.comprobantesReales === 2)

  console.log('\nA2) Un negocio real con comprobantes de ENSAYO de antes: no los mezcla')
  const A2 = await negocio('real-con-ensayo')
  await venta(A2, { en: new Date('2026-10-22T15:00:00Z'), doc: { correlativo: 1 } })                                                                  // el único comprobante real
  const tv = await venta(A2, { en: new Date('2026-10-23T15:00:00Z'), total: 500, doc: { correlativo: 1, trial: true } })                               // de prueba, aceptado, 500.00
  await venta(A2, { en: new Date('2026-10-23T16:00:00Z'), doc: { correlativo: 2, trial: true, estado: 'PENDIENTE', emitido: hace(500) } })            // de prueba, pendiente hace 500 h
  await nota(A2, { id: tv.doc!.id, saleId: tv.sale.id }, { total: 400, trial: true, en: new Date('2026-10-24T10:00:00Z'), correlativo: 1, serie: 'PC01' })
  await nota(A2, { id: tv.doc!.id, saleId: tv.sale.id }, { total: 400, trial: true, en: new Date('2026-10-24T11:00:00Z'), correlativo: 2, serie: 'PC01' })   // suman 800 sobre 500, pero son de prueba
  await contador(A2, 'TAX_BOLETA', 'B001', 2)
  const a2 = (await informe(A2)).informe
  check('>>> LIMPIO: lo de ensayo no genera hallazgos (ni pendiente de 500 h, ni notas que exceden, ni series)', a2.estado === 'LIMPIO' && a2.hallazgos.length === 0, `${a2.estado} ${cods(a2.hallazgos)}`)
  check('>>> el cálculo independiente NO incluye lo de ensayo: ambos registros dan 118.00 (solo el real)', a2.cuadreVentas.registro === 118 && a2.cuadreVentas.independiente === 118 && a2.comprobantesReales === 1)
  check('el puente sí enseña los de ensayo, en su propia fila y sin diferencia', a2.puente.clasificacion.ensayo.documentos === 2 && a2.puente.clasificacion.valido.documentos === 1 && a2.puente.diferencia === 0)

  console.log('\nB) Ventas que piden comprobante y no lo tienen')
  const B = await negocio('sin-comprobante')
  await venta(B, { en: hace(2) })                       // 2 h: normal
  const v30 = await venta(B, { en: hace(30) })          // advertencia
  await venta(B, { en: hace(80), pide: 'FACTURA' })     // error
  await venta(B, { en: hace(500), pide: 'NOTA_VENTA' }) // nunca es hallazgo
  const b = (await informe(B, B.owner, P({ desde: '2026-10-01' }))).informe
  const sc = de(b.hallazgos, 'VENTA_SIN_COMPROBANTE')
  check('>>> 2 h nada; 30 h advertencia; 80 h error; la nota de venta, nunca', cods(sc) === 'VENTA_SIN_COMPROBANTE:ADVERTENCIA,VENTA_SIN_COMPROBANTE:ERROR' && sc.every((h) => h.cantidad === 1))
  check('y el puente las cuenta aparte (3 piden y no tienen), sin diferencia', b.puente.clasificacion.sinComprobante.documentos === 3 && b.puente.diferencia === 0 && b.estado === 'ERRORES')
  check('el aviso lleva el umbral operativo ⚠️', sc[0]!.explicacion.includes('⚠️') && sc[0]!.explicacion.includes('no son plazos de SUNAT'))
  void v30

  console.log('\nC) Comprobante distinto a su venta y factura sin RUC')
  const C = await negocio('distinto')
  const vc = await venta(C, { en: new Date('2026-10-22T15:00:00Z'), doc: { correlativo: 1 } })
  await prisma.taxDocument.update({ where: { id: vc.doc!.id }, data: { total: 100, subtotal: 84.75, taxTotal: 15.25 } })
  await venta(C, { pide: 'FACTURA', en: new Date('2026-10-22T16:00:00Z'), doc: { correlativo: 1, ruc: null } })
  await contador(C, 'TAX_BOLETA', 'B001', 2); await contador(C, 'TAX_FACTURA', 'F001', 2)
  const c = (await informe(C)).informe
  check('>>> el comprobante con 100.00 contra una venta de 118.00 → ERROR con la diferencia −18.00', de(c.hallazgos, 'COMPROBANTE_DISTINTO_A_VENTA')[0]?.nivel === 'ERROR' && de(c.hallazgos, 'COMPROBANTE_DISTINTO_A_VENTA')[0]?.importe === -18)
  check('>>> la factura sin RUC → advertencia', de(c.hallazgos, 'FACTURA_SIN_RUC')[0]?.nivel === 'ADVERTENCIA')

  console.log('\nD) Ventas anuladas o devueltas con comprobante vivo')
  const D = await negocio('cerradas')
  const sa = await venta(D, { status: 'ANULADA', en: new Date('2026-10-22T15:00:00Z'), doc: { correlativo: 1 } })
  const sd = await venta(D, { status: 'DEVUELTA', en: new Date('2026-10-22T16:00:00Z'), doc: { correlativo: 2 } })
  const sp = await venta(D, { status: 'ANULADA', en: new Date('2026-10-22T17:00:00Z'), doc: { correlativo: 3 } })
  const sn = await venta(D, { status: 'ANULADA', en: new Date('2026-10-22T18:00:00Z'), doc: { correlativo: 4 } })
  const sr = await venta(D, { status: 'DEVUELTA', en: new Date('2026-10-22T19:00:00Z'), doc: { correlativo: 5, estado: 'RECHAZADO' } })
  await nota(D, { id: sn.doc!.id, saleId: sn.sale.id }, { total: 118, total_: true, en: new Date('2026-10-23T10:00:00Z'), correlativo: 1 })       // neutraliza con NC total
  await nota(D, { id: sp.doc!.id, saleId: sp.sale.id }, { total: 50, en: new Date('2026-10-23T10:00:00Z'), correlativo: 2 })                          // parcial: no alcanza
  await contador(D, 'TAX_BOLETA', 'B001', 6); await contador(D, 'TAX_NC_BOLETA', 'BC01', 3)
  const d = (await informe(D)).informe
  const vivos = de(d.hallazgos, 'COMPROBANTE_VIVO_EN_VENTA_CERRADA')[0]
  check('>>> viven sin nota: la anulada (B001-1), la devuelta (B001-2) y la de nota parcial (B001-3); NO la de nota total ni la rechazada', vivos?.nivel === 'ERROR' && vivos.cantidad === 3 && vivos.items.map((i) => i.referencia).sort().join() === 'B001-00000001,B001-00000002,B001-00000003', vivos?.items.map((i) => i.referencia).join())
  check('>>> las ventas anuladas y devueltas del periodo van en líneas INFORMATIVAS del puente y no suman', d.puente.anuladas.documentos === 3 && d.puente.devueltas.documentos === 2 && d.puente.ventasCompletadas.documentos === 0 && d.puente.diferencia === 0 && de(d.hallazgos, 'VENTAS_ANULADAS_O_DEVUELTAS')[0]?.nivel === 'INFO')
  void sa; void sd; void sr

  console.log('\nE) Envíos: pendientes, enviados, rechazados y agotados')
  const E = await negocio('envio')
  const ve = await venta(E, { en: hace(30), doc: { correlativo: 1, estado: 'PENDIENTE', emitido: hace(30) } })
  await venta(E, { en: hace(80), doc: { correlativo: 2, estado: 'ENVIADO', emitido: hace(80) } })
  await venta(E, { en: hace(10), doc: { correlativo: 3, estado: 'PENDIENTE', emitido: hace(10) } })   // 10 h: normal
  await venta(E, { en: hace(100), doc: { correlativo: 4, estado: 'RECHAZADO', emitido: hace(100) } })
  await prisma.fiscalDispatch.create({ data: { tenantId: E.t.id, taxDocumentId: ve.doc!.id, status: 'AGOTADO', attempts: 5, lastError: 'timeout del proveedor', idempotencyKey: randomUUID(), exhaustedAt: hace(5) } })
  await contador(E, 'TAX_BOLETA', 'B001', 5)
  const e = (await informe(E)).informe
  check('>>> 30 h pendiente → advertencia; 80 h enviado → error; 10 h → nada', cods(de(e.hallazgos, 'COMPROBANTE_PENDIENTE')) === 'COMPROBANTE_PENDIENTE:ADVERTENCIA,COMPROBANTE_PENDIENTE:ERROR')
  check('>>> el rechazado → advertencia; el envío agotado → ERROR, con el último error', de(e.hallazgos, 'COMPROBANTE_RECHAZADO')[0]?.nivel === 'ADVERTENCIA' && de(e.hallazgos, 'ENVIO_AGOTADO')[0]?.nivel === 'ERROR' && de(e.hallazgos, 'ENVIO_AGOTADO')[0]!.items[0]!.detalle.includes('timeout del proveedor'))
  const EP = await negocio('envio-pausado', 'PAUSADO')
  await venta(EP, { en: hace(30), doc: { correlativo: 1, estado: 'PENDIENTE', emitido: hace(100) } })
  await venta(EP, { en: hace(30), doc: { correlativo: 2, estado: 'ENVIADO', emitido: hace(100) } })
  await contador(EP, 'TAX_BOLETA', 'B001', 3)
  const ep = (await informe(EP)).informe
  check('>>> con el envío en PAUSA lo pendiente es información (espera por decisión del dueño), pero lo enviado sin respuesta sigue siendo error', ep.modo === 'PAUSADO' && cods(de(ep.hallazgos, 'COMPROBANTE_PENDIENTE')) === 'COMPROBANTE_PENDIENTE:ERROR,COMPROBANTE_PENDIENTE:INFO')

  console.log('\nF) Numeración')
  const F = await negocio('numeracion')
  for (const k of [1, 2, 3, 4, 6]) await venta(F, { en: new Date('2026-10-22T15:00:00Z'), doc: { correlativo: k } })   // falta el 5
  await contador(F, 'TAX_BOLETA', 'B001', 7)
  const f = (await informe(F)).informe
  check('>>> falta el B001-5: SERIE_CON_HUECOS (error) nombrándolo', de(f.hallazgos, 'SERIE_CON_HUECOS')[0]?.nivel === 'ERROR' && de(f.hallazgos, 'SERIE_CON_HUECOS')[0]!.items[0]!.detalle.includes('B001-00000005'))
  await prisma.documentCounter.updateMany({ where: { tenantId: F.t.id, series: 'B001' }, data: { next: 6 } })
  check('>>> con el contador por detrás (próximo B001-6 pero ya existe) → CONTADOR_ATRASADO error', de((await informe(F)).informe.hallazgos, 'CONTADOR_ATRASADO')[0]?.nivel === 'ERROR')
  await prisma.documentCounter.updateMany({ where: { tenantId: F.t.id, series: 'B001' }, data: { next: 9 } })
  check('con el contador por delante (próximo B001-9, último 6) → advertencia', de((await informe(F)).informe.hallazgos, 'CONTADOR_ADELANTADO')[0]?.nivel === 'ADVERTENCIA')
  const F2 = await negocio('numeracion-arranque')
  await venta(F2, { en: new Date('2026-10-22T15:00:00Z'), doc: { correlativo: 500 } }); await venta(F2, { en: new Date('2026-10-22T16:00:00Z'), doc: { correlativo: 501 } })
  await contador(F2, 'TAX_BOLETA', 'B001', 502, 500)
  check('>>> una serie que arrancó en 500 a propósito no tiene huecos', de((await informe(F2)).informe.hallazgos, 'SERIE_CON_HUECOS').length === 0 && (await informe(F2)).informe.estado === 'LIMPIO')
  const F3 = await negocio('numeracion-arranque-tardio')
  await venta(F3, { en: new Date('2026-10-22T15:00:00Z'), doc: { correlativo: 4 } })
  await contador(F3, 'TAX_BOLETA', 'B001', 5, 1)
  check('>>> si el contador arrancó en 1 y lo primero emitido es el 4, faltan 1, 2 y 3', de((await informe(F3)).informe.hallazgos, 'SERIE_CON_HUECOS')[0]?.items[0]?.detalle.includes('Faltan 3') === true)
  const F4 = await negocio('numeracion-ensayo-ignorada')
  for (const k of [1, 9]) await venta(F4, { en: new Date('2026-10-22T15:00:00Z'), doc: { correlativo: k, trial: true } })
  check('las series de PRUEBA no cuentan: aunque tengan huecos no son hallazgo', de((await informe(F4)).informe.hallazgos, 'SERIE_CON_HUECOS').length === 0)

  console.log('\nG) Notas de crédito')
  const G = await negocio('notas')
  const og = await venta(G, { en: new Date('2026-10-22T15:00:00Z'), doc: { correlativo: 1 } })
  await nota(G, { id: og.doc!.id, saleId: og.sale.id }, { total: 100, en: new Date('2026-10-23T10:00:00Z'), correlativo: 1 })
  await nota(G, { id: og.doc!.id, saleId: og.sale.id }, { total: 30, en: new Date('2026-10-23T11:00:00Z'), correlativo: 2 })
  await contador(G, 'TAX_BOLETA', 'B001', 2); await contador(G, 'TAX_NC_BOLETA', 'BC01', 3)
  const g = (await informe(G)).informe
  check('>>> notas de crédito que suman 130 sobre un comprobante de 118 → ERROR con el exceso (12.00)', de(g.hallazgos, 'NOTA_EXCEDE_ORIGINAL')[0]?.nivel === 'ERROR' && de(g.hallazgos, 'NOTA_EXCEDE_ORIGINAL')[0]?.importe === 12)
  check('y las notas restan en el cuadre del registro (118 − 100 − 30 = −12.00), que sigue cuadrando', g.cuadreVentas.registro === -12 && g.cuadreVentas.diferencia === 0)

  console.log('\nH) Compras')
  const H = await negocio('compras')
  const prod = await prisma.product.create({ data: { tenantId: H.t.id, sku: 'H-1', name: 'Cemento', unitType: 'UNIDAD', salePrice: 30, costPrice: 0 } })
  const prov = await prisma.supplier.create({ data: { tenantId: H.t.id, name: 'Prov sin RUC' } })
  const k = await crearBorrador(H.db(H.owner), H.owner, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: H.b1.warehouse.id, supplierId: prov.id, invoiceRef: 'LIBRE-1', items: [{ productId: prod.id, enteredQuantity: 10, unitCost: 5 }] }))
  await recibirCompra(H.db(H.owner), H.owner, recibirCompraSchema.parse({ purchaseId: k.id }))
  await prisma.purchase.update({ where: { id: k.id }, data: { receivedAt: new Date('2026-10-24T15:00:00Z') } })
  const h = (await informe(H)).informe
  check('>>> compra sin documento y proveedor sin RUC → dos advertencias, cada una con enlace a la compra', cods(h.hallazgos) === 'COMPRAS_PROVEEDOR_SIN_RUC:ADVERTENCIA,COMPRAS_PROVISIONALES:ADVERTENCIA' && h.hallazgos.every((x) => x.items[0]?.enlace === `/compras/${k.id}`))
  check('>>> y el registro de compras cuadra con el cálculo independiente (59.00)', h.cuadreCompras.registro === 59 && h.cuadreCompras.independiente === 59 && h.cuadreCompras.diferencia === 0)

  console.log('\nI) Ensayo y demostración: nada alarma')
  for (const modo of ['ENSAYO', 'DEMO'] as const) {
    const X = await negocio(`modo-${modo.toLowerCase()}`, modo)
    await venta(X, { en: new Date('2026-10-22T15:00:00Z'), doc: { correlativo: 1, trial: true, estado: 'PENDIENTE', emitido: hace(500) } })   // de prueba, pendiente hace 500 h
    await venta(X, { pide: 'FACTURA', en: hace(300) })                                                                              // pide factura y no tiene
    await venta(X, { en: new Date('2026-10-23T15:00:00Z'), doc: { correlativo: 9, trial: true } })                                  // serie de prueba con huecos
    const x = (await informe(X)).informe
    check(`>>> ${modo}: estado «Sin comprobantes reales que conciliar», cero errores y cero advertencias`, x.estado === 'SIN_COMPROBANTES' && x.mensaje === MENSAJE_SIN_COMPROBANTES && x.resumen.errores === 0 && x.resumen.advertencias === 0 && x.modo === modo, `${x.estado} ${cods(x.hallazgos)}`)
    check(`${modo}: todo lo que aparece es información y se explica el modo`, x.hallazgos.length > 0 && x.hallazgos.every((hh) => hh.nivel === 'INFO') && de(x.hallazgos, 'MODO_SIN_VALOR_FISCAL').length === 1)
    check(`${modo}: los comprobantes de prueba se ven en el puente como «ensayo», sin diferencia, y no cuentan como reales`, x.puente.clasificacion.ensayo.documentos === 2 && x.puente.diferencia === 0 && x.comprobantesReales === 0 && x.cuadreVentas.registro === 0 && x.cuadreVentas.independiente === 0 && x.cuadreVentas.diferencia === 0)
  }
  const Z = await negocio('vacio')
  const z = (await informe(Z)).informe
  check('>>> un negocio sin movimientos (real, recién creado): «Sin comprobantes reales que conciliar», sin alertas', z.estado === 'SIN_COMPROBANTES' && z.hallazgos.length === 0 && z.resumen.errores + z.resumen.advertencias === 0)

  console.log('\nJ) Sucursales')
  const J = await negocio('sucursales')
  await venta(J, { en: new Date('2026-10-22T15:00:00Z'), doc: { correlativo: 1 } })
  await venta(J, { branch: 'b2', pide: 'BOLETA', total: 59, en: hace(80) })                                      // sin comprobante en la sucursal 2
  const vb2 = await venta(J, { branch: 'b2', status: 'ANULADA', en: new Date('2026-10-22T16:00:00Z'), doc: { correlativo: 2, serie: 'B002' } })
  await prisma.fiscalDispatch.create({ data: { tenantId: J.t.id, taxDocumentId: vb2.doc!.id, status: 'AGOTADO', attempts: 3, idempotencyKey: randomUUID() } })
  await contador(J, 'TAX_BOLETA', 'B001', 2); await contador(J, 'TAX_BOLETA', 'B002', 1, 1, 'b2')   // B002 con contador atrasado (ya emitió el 2)
  const jTodo = (await informe(J)).informe, jUna = (await informe(J, J.soloB1)).informe
  check('>>> el dueño (todas las sucursales) ve los problemas de la sucursal 2', jTodo.estado === 'ERRORES' && de(jTodo.hallazgos, 'VENTA_SIN_COMPROBANTE').length === 1 && de(jTodo.hallazgos, 'ENVIO_AGOTADO').length === 1 && de(jTodo.hallazgos, 'COMPROBANTE_VIVO_EN_VENTA_CERRADA').length === 1 && de(jTodo.hallazgos, 'CONTADOR_ATRASADO').length === 1)
  check('>>> quien solo ve la sucursal 1 NO ve nada de la 2: ni ventas, ni envíos, ni contadores, ni comprobantes vivos', jUna.estado === 'LIMPIO' && jUna.hallazgos.length === 0 && jUna.puente.ventasCompletadas.documentos === 1)

  console.log('\nK) Permiso: reportes.ver')
  const probar = async (x: TenantContext) => [await code(informeConciliacion(A.db(x), x, P(), AHORA)), await code(exportarConciliacionCsv(A.db(x), x, P(), AHORA))]
  for (const r of ['owner', 'admin', 'contador']) check(`>>> ${r} puede ver y descargar`, (await probar(A.u[r]!.ctx)).every((x) => x === null))
  for (const r of ['cajero', 'vendedor', 'almacenero']) check(`>>> ${r} NO puede (FORBIDDEN_ROLE)`, (await probar(A.u[r]!.ctx)).every((x) => x === 'FORBIDDEN_ROLE'))
  check('>>> un rango imposible → INVALID_DOCUMENT', (await code(informe(A, A.owner, P({ desde: '2026-10-26', hasta: '2026-10-20' })))) === 'INVALID_DOCUMENT')

  console.log('\nL) CSV y auditoría')
  const antes = await prisma.auditLog.count({ where: { tenantId: D.t.id, action: 'reporte.exportado' } })
  const csv = await exportarConciliacionCsv(D.db(D.owner), D.owner, P(), AHORA)
  check('>>> el archivo se llama conciliacion-fiscal-DESDE_HASTA.csv, con BOM, hallazgos, puente y cuadre', csv.nombre === 'conciliacion-fiscal-2026-10-20_2026-10-26.csv' && csv.contenido.startsWith('﻿') && csv.contenido.includes('COMPROBANTE_VIVO_EN_VENTA_CERRADA') && csv.contenido.includes('PUENTE') && csv.contenido.includes('CUADRE'))
  const reg = await prisma.auditLog.findFirst({ where: { tenantId: D.t.id, action: 'reporte.exportado', entityId: 'conciliacion-fiscal' } })
  check('>>> la descarga queda en la auditoría con quién, el periodo y el resultado', (await prisma.auditLog.count({ where: { tenantId: D.t.id, action: 'reporte.exportado' } })) === antes + 1 && reg?.actorId === D.owner.userId && JSON.stringify(reg?.after).includes('"estado":"ERRORES"'))
  check('>>> sin permiso no se descarga ni se audita', (await code(exportarConciliacionCsv(D.db(D.u.cajero!.ctx), D.u.cajero!.ctx, P(), AHORA))) === 'FORBIDDEN_ROLE' && (await prisma.auditLog.count({ where: { tenantId: D.t.id, action: 'reporte.exportado' } })) === antes + 1)

  console.log('\nM) Más de 1000 ventas (lotes) y aislamiento')
  const M = await negocio('lotes')
  await prisma.sale.createMany({ data: Array.from({ length: 1100 }, (_, i) => ({ tenantId: M.t.id, branchId: M.b1.branch.id, warehouseId: M.b1.warehouse.id, userId: M.owner.userId, number: `M-${i}`, documentType: 'NOTA_VENTA' as const, status: 'COMPLETADA' as const, subtotal: 1, taxTotal: 0, total: 1, completedAt: new Date('2026-10-22T15:00:00Z') })) })
  const m = (await informe(M)).informe
  check('>>> las 1100 ventas se leen todas (lotes de 1000): 1100 notas de venta = 1100.00 y diferencia 0', m.puente.ventasCompletadas.documentos === 1100 && m.puente.notasDeVenta.documentos === 1100 && m.puente.ventasCompletadas.total === 1100 && m.puente.diferencia === 0)
  check('>>> cada negocio ve lo suyo: el sano no ve nada de los demás', a.puente.ventasCompletadas.documentos === 3 && (await informe(A)).informe.hallazgos.length === 0)

  console.log('\nN) El script de consola (solo lectura)')
  const entorno = { ...process.env }
  const correrScript = (...args: string[]) => spawnSync('npx', ['tsx', 'scripts/auditar-fiscal.ts', ...args], { env: entorno, encoding: 'utf8', timeout: 120_000 })
  const cuentas = async () => [await prisma.taxDocument.count(), await prisma.auditLog.count(), await prisma.sale.count(), await prisma.documentCounter.count(), await prisma.purchase.count()].join()
  const antesDatos = await cuentas()
  const rA = correrScript('--negocio', A.t.slug, '--desde', '2026-10-20', '--hasta', '2026-10-26')
  check('>>> negocio sano: sale 0 y lo muestra limpio', rA.status === 0 && rA.stdout.includes('Todo cuadra') && rA.stdout.includes('SOLO LECTURA'), `${rA.status} ${rA.stderr.slice(0, 200)}`)
  const rD = correrScript('--negocio', D.t.slug, '--desde', '2026-10-20', '--hasta', '2026-10-26')
  check('>>> negocio con errores: sale 3 y los muestra', rD.status === 3 && rD.stdout.includes('[ERROR]') && rD.stdout.includes('comprobante vivo'), `${rD.status}`)
  const rE = correrScript('--negocio', (await prisma.tenant.findFirstOrThrow({ where: { slug: { startsWith: 'rp-modo-ensayo' } } })).slug, '--desde', '2026-10-20', '--hasta', '2026-10-26')
  check('>>> negocio en ensayo: sale 0 (sin errores) y dice que no hay comprobantes reales', rE.status === 0 && rE.stdout.includes(MENSAJE_SIN_COMPROBANTES), `${rE.status}`)
  check('una opción desconocida se rechaza (sale 1) y no revisa nada', correrScript('--negocios', 'x').status === 1)
  check('un rango inválido se rechaza (sale 1)', correrScript('--negocio', A.t.slug, '--desde', '2026-10-26', '--hasta', '2026-10-20').status === 1)
  check('>>> es de SOLO LECTURA: no cambió ni un comprobante, ni la auditoría, ni ventas, contadores o compras', (await cuentas()) === antesDatos)
  void execFileSync

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
void calcularConciliacion
