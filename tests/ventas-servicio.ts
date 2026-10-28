import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { openCashSession } from '../src/features/branches/cash-service'
import { openCashSchema } from '../src/features/branches/cash-schemas'
import { anularOdevolverVenta, diagnosticarDevolucion } from '../src/features/devoluciones/service'
import { anularOdevolverVentaSchema } from '../src/features/devoluciones/schemas'
import { listarVentas, obtenerVenta } from '../src/features/ventas/service'
import { parametrosVentasListaSchema, TAMANO_PAGINA_VENTAS } from '../src/features/ventas/schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.1b · Historial de ventas y detalle, contra la base: permisos, aislamiento por negocio y sucursal, filtros (periodo en la zona del
 * negocio, estado, comprobante, búsqueda), paginación sin repetir ni saltar, trazabilidad tras una devolución real y que NADA de costos
 * salga de estas dos lecturas.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const params = (o: Record<string, unknown> = {}) => parametrosVentasListaSchema.parse(o)
const TODO_EL_ANO = params({ p: 'RANGO', desde: '2026-01-01', hasta: '2026-12-31' })

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `rp-vt-${tag}-${randomUUID().slice(0, 6)}`, name: `Ventas ${tag}`, taxId: ruc(), planId: plan.id, realBillingEnabledAt: new Date('2026-01-01T00:00:00Z') } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_vt' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { almacenCode: 'ALM2', seriesNumber: 2, branchCode: 'B2', establishmentCode: '0002' })
  const todas = [b1.branch.id, b2.branch.id]
  const u: Record<string, TenantContext> = {}
  for (const role of ['OWNER', 'ADMIN', 'CONTADOR', 'CAJERO', 'VENDEDOR', 'ALMACENERO'] as Role[]) {
    const x = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    for (const b of todas) await asignarSucursal(t.id, x.id, b)
    u[role] = { tenantId: t.id, userId: x.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: todas, permisosExtra: [] }
  }
  // Una cajera que solo trabaja en la sucursal 1.
  const solo = await prisma.user.create({ data: { tenantId: t.id, email: `solo-${randomUUID()}@x.com`, name: 'Solo B1', role: 'CAJERO' } })
  await asignarSucursal(t.id, solo.id, b1.branch.id)
  u.SOLO_B1 = { tenantId: t.id, userId: solo.id, role: 'CAJERO', access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  const P1 = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Cemento Sol', unitType: 'UNIDAD', salePrice: 100, costPrice: 61.37 } })
  const P2 = await prisma.product.create({ data: { tenantId: t.id, sku: 'P2', name: 'Servicio de corte', unitType: 'UNIDAD', salePrice: 10, costPrice: 0, trackStock: false } })
  for (const w of [b1.warehouse, b2.warehouse]) await prisma.stock.create({ data: { tenantId: t.id, productId: P1.id, warehouseId: w.id, quantity: 500 } })
  const cliente = await prisma.customer.create({ data: { tenantId: t.id, name: 'Constructora Andina SAC', docType: 'RUC', docNumber: ruc(), creditLimit: 5000 } })
  const db = (c: TenantContext) => getTenantPrisma(c)
  const O = u.OWNER!
  const sedes = { b1: { ctx: O, w: b1.warehouse.id }, b2: { ctx: { ...O, branchId: b2.branch.id } as TenantContext, w: b2.warehouse.id } }
  const vender = (items: unknown[], payments: unknown[], over: Record<string, unknown> = {}, sede: 'b1' | 'b2' = 'b1') => {
    const s = sedes[sede]
    return registerSale(db(s.ctx), s.ctx, registerSaleSchema.parse({ warehouseId: s.w, items, payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID(), ...over }) as never)
  }
  const L = (productId: string, quantity: number) => ({ productId, quantity, discount: 0 })
  let corr = 0
  const doc = async (saleId: string, tipo: 'BOLETA' | 'FACTURA', estado = 'ACEPTADO') => {
    const s = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } })
    const serie = tipo === 'FACTURA' ? 'F001' : 'B001', c = ++corr
    return prisma.taxDocument.create({ data: {
      tenantId: t.id, saleId, documentType: tipo, series: serie, correlativo: c, fullNumber: `${serie}-${String(c).padStart(8, '0')}`, status: estado as never, isTrial: false,
      subtotal: s.subtotal, taxTotal: s.taxTotal, discountTotal: s.discountTotal, total: s.total, issuedAt: new Date(),
      receiverDocType: tipo === 'FACTURA' ? 'RUC' : 'SIN_DOCUMENTO', receiverDocNumber: tipo === 'FACTURA' ? ruc() : null, receiverName: 'Cliente', externalId: `ext-${randomUUID().slice(0, 8)}`,
    } })
  }
  const fechar = (saleId: string, iso: string) => prisma.sale.update({ where: { id: saleId }, data: { completedAt: new Date(iso) } })
  return { t, b1, b2, u, O, db, P1, P2, cliente, vender, L, doc, fechar }
}

async function main() {
  try { return await cuerpo() } catch (e) {
    check('>>> la prueba termina sin excepciones inesperadas', false, e instanceof Error ? e.message.slice(0, 300) : String(e))
    console.log(`\n✖ ${pass} pasaron, ${fail} fallaron`)
    return fail
  }
}

async function cuerpo() {
  const A = await negocio('a')
  const B = await negocio('b')
  const ahora = new Date()

  console.log('\nA) Preparación')
  const sCont = await A.vender([A.L(A.P1.id, 2)], [{ method: 'EFECTIVO', amount: 200 }])
  const sBol = await A.vender([A.L(A.P1.id, 1)], [{ method: 'YAPE', amount: 100 }])
  const sFac = await A.vender([A.L(A.P1.id, 3)], [{ method: 'EFECTIVO', amount: 300 }], { customerId: A.cliente.id })
  const sB2 = await A.vender([A.L(A.P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }], {}, 'b2')
  const sViejo = await A.vender([A.L(A.P2.id, 1)], [{ method: 'EFECTIVO', amount: 10 }])
  await A.doc(sBol.saleId, 'BOLETA'); const dFac = await A.doc(sFac.saleId, 'FACTURA')
  await A.fechar(sViejo.saleId, '2026-03-05T15:00:00.000Z')
  const ajena = await B.vender([B.L(B.P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }])
  check('(preparación) 5 ventas en el negocio A (una antigua, una en otra sucursal) y 1 en el negocio B', !!sCont.saleId && !!sViejo.saleId && !!ajena.saleId)

  console.log('\nB) Permiso de ver: quien cobra, quien anula, quien revisa reportes')
  for (const [rol, ok] of [['OWNER', true], ['ADMIN', true], ['CAJERO', true], ['CONTADOR', true], ['VENDEDOR', false], ['ALMACENERO', false]] as const) {
    const c = A.u[rol]!
    const l = await code(listarVentas(A.db(c), c, params(), ahora)), d = await code(obtenerVenta(A.db(c), c, sCont.saleId))
    check(`>>> ${rol}: ${ok ? 'puede' : 'NO puede'} ver el historial y el detalle`, ok ? l === null && d === null : l === 'FORBIDDEN_ROLE' && d === 'FORBIDDEN_ROLE', `${l}/${d}`)
  }
  const cont = A.u.CONTADOR!
  check('>>> el contador VE pero no puede diagnosticar una devolución (necesita ventas.anular)', await code(diagnosticarDevolucion(A.db(cont), cont, sCont.saleId)) === 'FORBIDDEN_ROLE')
  const caj = A.u.CAJERO!
  check('>>> el cajero VE pero tampoco puede diagnosticar (ver no concede anular)', await code(diagnosticarDevolucion(A.db(caj), caj, sCont.saleId)) === 'FORBIDDEN_ROLE')

  console.log('\nC) Aislamiento por negocio y por sucursal')
  const O = A.O
  const todo = await listarVentas(A.db(O), O, TODO_EL_ANO, ahora)
  const ids = todo.filas.map((f) => f.id)
  check('>>> el dueño de A ve sus 5 ventas y NINGUNA del negocio B', ids.length === 5 && !ids.includes(ajena.saleId), String(ids.length))
  check('>>> el detalle de una venta de OTRO negocio es NOT_FOUND (no se confirma que exista)', await code(obtenerVenta(A.db(O), O, ajena.saleId)) === 'NOT_FOUND')
  check('>>> el detalle de un id inexistente es el mismo NOT_FOUND', await code(obtenerVenta(A.db(O), O, 'no-existe-123456')) === 'NOT_FOUND')
  const solo = A.u.SOLO_B1!
  const deSolo = await listarVentas(A.db(solo), solo, TODO_EL_ANO, ahora)
  check('>>> una cajera de la sucursal 1 NO ve la venta de la sucursal 2 en el historial', !deSolo.filas.some((f) => f.id === sB2.saleId) && deSolo.filas.length === 4, String(deSolo.filas.length))
  check('>>> ni su detalle (NOT_FOUND)', await code(obtenerVenta(A.db(solo), solo, sB2.saleId)) === 'NOT_FOUND')
  check('>>> el selector de sucursales solo lista las suyas', deSolo.sucursales.length === 1 && deSolo.sucursales[0]!.id === A.b1.branch.id)
  const filtroAjeno = await listarVentas(A.db(solo), solo, params({ p: 'RANGO', desde: '2026-01-01', hasta: '2026-12-31', sucursal: A.b2.branch.id }), ahora)
  check('>>> forzar ?sucursal= de otra sucursal no da nada', filtroAjeno.filas.length === 0)

  console.log('\nD) Filtros')
  const semana = await listarVentas(A.db(O), O, params(), ahora)
  check('>>> sin filtros: la semana actual (la venta de marzo no sale) y trae el periodo escrito', !semana.filas.some((f) => f.id === sViejo.saleId) && semana.filas.length === 4 && !!semana.textoPeriodo)
  const buscaViejo = await listarVentas(A.db(O), O, params({ q: todo.filas.find((f) => f.id === sViejo.saleId)!.numero }), ahora)
  check('>>> buscar por número IGNORA el periodo: encuentra la venta de marzo', buscaViejo.filas.length === 1 && buscaViejo.filas[0]!.id === sViejo.saleId && buscaViejo.textoPeriodo === null)
  const porFac = await listarVentas(A.db(O), O, params({ q: dFac.fullNumber }), ahora)
  check('>>> buscar por número de comprobante (F001-…) encuentra su venta', porFac.filas.length === 1 && porFac.filas[0]!.id === sFac.saleId && porFac.filas[0]!.comprobante?.numero === dFac.fullNumber)
  const porCli = await listarVentas(A.db(O), O, params({ q: 'andina' }), ahora)
  check('>>> buscar por cliente (sin mayúsculas) y por su documento', porCli.filas.length === 1 && porCli.filas[0]!.cliente === 'Constructora Andina SAC' && (await listarVentas(A.db(O), O, params({ q: A.cliente.docNumber! }), ahora)).filas.length === 1)
  const sinDoc = (await listarVentas(A.db(O), O, params({ comprobante: 'SIN' }), ahora)).filas.map((f) => f.id).sort().join()
  check('>>> comprobante=FACTURA / BOLETA / SIN (SIN trae exactamente las ventas sin boleta ni factura)', sinDoc === [sCont.saleId, sB2.saleId].sort().join() && (await listarVentas(A.db(O), O, params({ comprobante: 'FACTURA' }), ahora)).filas.length === 1 && (await listarVentas(A.db(O), O, params({ comprobante: 'BOLETA' }), ahora)).filas.length === 1 && (await listarVentas(A.db(O), O, params({ comprobante: 'SIN' }), ahora)).filas.length === 2)
  check('>>> sucursal=B2 trae solo la de B2', (await listarVentas(A.db(O), O, params({ sucursal: A.b2.branch.id }), ahora)).filas.map((f) => f.id).join() === sB2.saleId)
  await anularOdevolverVenta(A.db(O), O, anularOdevolverVentaSchema.parse({ saleId: sCont.saleId, kind: 'ANULACION', reason: 'Error de digitación', idempotencyKey: randomUUID(), refunds: [{ mode: 'SIN_SALIDA', amount: 200, reference: 'Se devolvió en mostrador' }] }))
  const an = await listarVentas(A.db(O), O, params({ estado: 'ANULADA' }), ahora), co = await listarVentas(A.db(O), O, params({ estado: 'COMPLETADA' }), ahora)
  check('>>> estado=ANULADA muestra la anulada; COMPLETADA ya no la incluye; DEVUELTA vacío', an.filas.length === 1 && an.filas[0]!.id === sCont.saleId && an.filas[0]!.estado === 'ANULADA' && !co.filas.some((f) => f.id === sCont.saleId) && (await listarVentas(A.db(O), O, params({ estado: 'DEVUELTA' }), ahora)).filas.length === 0)
  // Frontera del día en Lima (UTC−5): 23:30 del 26/10 en Lima es 04:30Z del 27.
  await A.fechar(sBol.saleId, '2026-10-27T04:30:00.000Z')
  const dia26 = await listarVentas(A.db(O), O, params({ p: 'RANGO', desde: '2026-10-26', hasta: '2026-10-26' }), ahora)
  const dia27 = await listarVentas(A.db(O), O, params({ p: 'RANGO', desde: '2026-10-27', hasta: '2026-10-27' }), ahora)
  check('>>> el periodo es del día DEL NEGOCIO: 23:30 en Lima del 26 (04:30Z del 27) cae en el 26 y no en el 27', dia26.filas.some((f) => f.id === sBol.saleId) && !dia27.filas.some((f) => f.id === sBol.saleId))
  check('>>> un rango invertido es INVALID_DOCUMENT (no un error de servidor)', await code(listarVentas(A.db(O), O, params({ p: 'RANGO', desde: '2026-10-27', hasta: '2026-10-01' }), ahora)) === 'INVALID_DOCUMENT')

  console.log('\nE) Paginación: sin repetir ni saltar, con empates')
  const P = await negocio('pag')
  const T = '2026-10-20T15:00:00.000Z'
  const creadas: string[] = []
  for (let i = 0; i < TAMANO_PAGINA_VENTAS + 6; i++) { const s = await P.vender([P.L(P.P2.id, 1)], [{ method: 'EFECTIVO', amount: 10 }]); creadas.push(s.saleId); await P.fechar(s.saleId, i < 20 ? T : `2026-10-${21 + (i % 3)}T15:00:00.000Z`) }
  const vistos: string[] = []; let cursor: string | undefined, paginas = 0
  for (; paginas < 5; paginas++) {
    const pg = await listarVentas(P.db(P.O), P.O, params({ p: 'RANGO', desde: '2026-10-01', hasta: '2026-10-26', ...(cursor ? { cursor } : {}) }), ahora)
    vistos.push(...pg.filas.map((f) => f.id)); if (!pg.siguiente) break; cursor = pg.siguiente
  }
  check(`>>> recorrer todas las páginas trae las ${creadas.length} ventas, una sola vez cada una (con 20 empatadas en el mismo instante)`, vistos.length === creadas.length && new Set(vistos).size === creadas.length && creadas.every((i) => vistos.includes(i)), `${vistos.length} en ${paginas + 1} páginas`)
  check('>>> la primera página trae exactamente el tamaño de página y hay siguiente', (await listarVentas(P.db(P.O), P.O, params({ p: 'RANGO', desde: '2026-10-01', hasta: '2026-10-26' }), ahora)).filas.length === TAMANO_PAGINA_VENTAS)
  check('>>> un cursor mal formado se rechaza en el esquema', ['x', '2026-10-20|abc', '2026-10-20T15:00:00.000Z|\'; drop table', 'a'.repeat(300)].every((c) => !parametrosVentasListaSchema.safeParse({ cursor: c }).success))

  console.log('\nF) Detalle y trazabilidad tras una devolución real')
  const d0 = await obtenerVenta(A.db(O), O, sFac.saleId)
  check('el detalle trae cliente, sucursal, vendedor, líneas, pagos y comprobante vivo', d0.cliente?.nombre === 'Constructora Andina SAC' && d0.sucursal.nombre.length > 0 && d0.cobro.length > 0 && d0.lineas.length === 1 && d0.lineas[0]!.cantidad === 3 && d0.pagos.length === 1 && d0.comprobantes.length === 1 && d0.estado === 'COMPLETADA' && d0.devoluciones.length === 0)
  const dg = await diagnosticarDevolucion(A.db(O), O, sFac.saleId)
  check('>>> la factura ACEPTADA permite devolver y anuncia que emitirá la nota de crédito', dg.puede && dg.nota?.comprobante === dFac.fullNumber)
  await anularOdevolverVenta(A.db(O), O, anularOdevolverVentaSchema.parse({ saleId: sFac.saleId, kind: 'DEVOLUCION', reason: 'Material equivocado', idempotencyKey: randomUUID(), refunds: [{ mode: 'EXTERNO', method: 'YAPE', amount: 300, reference: 'OP-778' }] }))
  const d1 = await obtenerVenta(A.db(O), O, sFac.saleId)
  const r = d1.devoluciones[0]!
  check('>>> DEVUELTA con su registro D001-…, motivo, quién autorizó, fecha y la línea', d1.estado === 'DEVUELTA' && d1.devoluciones.length === 1 && /^D\d{3}-\d{8}$/.test(r.numero) && r.tipo === 'DEVOLUCION' && r.motivo === 'Material equivocado' && r.autorizo.length > 0 && r.lineas === 1)
  check('>>> el reembolso externo con su medio y referencia; ningún turno afectado', r.reembolsos.length === 1 && r.reembolsos[0]!.modo === 'EXTERNO' && r.reembolsos[0]!.medio === 'YAPE' && r.reembolsos[0]!.referencia === 'OP-778' && r.turno === null)
  check('>>> el comprobante vinculado y su NOTA DE CRÉDITO (06, devolución) aparecen enlazados', d1.comprobantes.length === 2 && r.notaDeCredito !== null && d1.comprobantes.some((c) => c.tipo === 'NOTA_CREDITO' && c.relacionado === dFac.fullNumber && c.numero === r.notaDeCredito))
  const dg1 = await diagnosticarDevolucion(A.db(O), O, sFac.saleId)
  check('>>> y una venta ya devuelta no se puede devolver otra vez (el diagnóstico lo dice)', !dg1.puede && !!dg1.bloqueo)
  const dAn = await obtenerVenta(A.db(O), O, sCont.saleId)
  check('>>> la anulada en efectivo sin turno abierto: anulada, sin nota (nota de venta) y con su motivo', dAn.estado === 'ANULADA' && dAn.devoluciones[0]?.tipo === 'ANULACION' && dAn.devoluciones[0]?.notaDeCredito === null)

  const turno = await openCashSession(A.db(O), O, openCashSchema.parse({ openingAmount: 50 }))
  const sCaja = await A.vender([A.L(A.P1.id, 1)], [{ method: 'EFECTIVO', amount: 100 }])
  const dgCaja = await diagnosticarDevolucion(A.db(O), O, sCaja.saleId)
  check('>>> con turno abierto el diagnóstico lo sabe y propone devolver el efectivo desde el cajón', dgCaja.puede && dgCaja.hayTurnoAbierto && dgCaja.reembolsos.length === 1 && dgCaja.reembolsos[0]!.mode === 'CAJA' && dgCaja.pagadoNeto === 100)
  await anularOdevolverVenta(A.db(O), O, anularOdevolverVentaSchema.parse({ saleId: sCaja.saleId, kind: 'DEVOLUCION', reason: 'No era el modelo', idempotencyKey: randomUUID() }))
  const dCaja = (await obtenerVenta(A.db(O), O, sCaja.saleId)).devoluciones[0]!
  check('>>> el reembolso en CAJA deja el turno afectado en la trazabilidad (el de la apertura de ese turno)', dCaja.turno?.id === turno.id && dCaja.reembolsos[0]!.modo === 'CAJA' && dCaja.reembolsos[0]!.medio === 'EFECTIVO' && dCaja.reembolsos[0]!.monto === 100)

  console.log('\nG) Ni un solo dato de costo en estas lecturas')
  const textos = [JSON.stringify(todo), JSON.stringify(semana), JSON.stringify(d0), JSON.stringify(d1), JSON.stringify(dAn)]
  check('>>> ninguna clave de la lista ni del detalle habla de costo, utilidad, margen o ganancia', textos.every((x) => !/"[a-zA-Z]*(cost|costo|utilidad|margen|profit|ganancia)[a-zA-Z]*"\s*:/i.test(x)))
  check('>>> el costo real del producto (61.37) no aparece en ningún valor', textos.every((x) => !x.includes('61.37')))
  const crudo = await A.db(O).sale.findFirstOrThrow({ where: { id: sFac.saleId }, select: { items: { select: { unitCost: true } } } })
  check('(control) el costo SÍ existe en la base: la ausencia en las pantallas es decisión del servicio, no un dato vacío', Number(crudo.items[0]!.unitCost?.toString()) === 61.37)

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

correr(main)
