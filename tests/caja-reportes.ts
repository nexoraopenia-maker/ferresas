import './guard'
import { correr } from './teardown'
import { abrirTurno, asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { closeCashSession } from '../src/features/branches/cash-service'
import { closeCashSchema } from '../src/features/branches/cash-schemas'
import { consolidadoDelDia, exportarConsolidadoCsv, leerFecha } from '../src/features/branches/consolidado-caja'
import { exportarCierreCsv, getTicketCierre } from '../src/features/printing/cierre-caja'
import { TicketCierreCaja } from '../src/features/printing/components/TicketCierreCaja'
import { CierreCajaA4 } from '../src/features/printing/components/CierreCajaA4'
import { ConsolidadoCajaVista } from '../src/features/branches/components/ConsolidadoCaja'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.8c · Los reportes de caja contra la base: el cierre de UN turno (ticket de 80 mm, A4 y CSV) sale de la foto congelada con Yape y Plin aparte, y el consolidado del día une todas
 * las cajas de cada sucursal. Lo que más importa: quién puede ver qué (`caja.arqueo` / el propio turno / `caja.consolidado`), que el día es el del negocio, que un turno abierto no enseña
 * arqueo y que NINGÚN reporte lleva cifras de costo.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `cr-${randomUUID().slice(0, 8)}`, name: 'Reportes de caja', taxId: completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cr' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const b2 = await crearSucursalConAlmacen(t.id, { seriesNumber: 2, branchCode: 'S2', almacenCode: 'A2', establishmentCode: '0002' })
  const todas = [b1.branch.id, b2.branch.id]
  const mk = async (role: Role, nombre: string) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${nombre}-${randomUUID()}@x.com`.toLowerCase(), name: nombre, role } })
    for (const b of todas) await asignarSucursal(t.id, u.id, b)
    return u
  }
  const [owner, owner2, adm, ana, beto, carla, conta] = [await mk('OWNER', 'Dueño'), await mk('OWNER', 'Dueña 2'), await mk('ADMIN', 'Admin'), await mk('CAJERO', 'Ana'), await mk('CAJERO', 'Beto'), await mk('CAJERO', 'Carla'), await mk('CONTADOR', 'Conta')]
  const ctx = (u: { id: string }, role: Role, branchId: string, branchIds = todas): TenantContext => ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId, branchIds, permisosExtra: [] })
  const O = ctx(owner, 'OWNER', b1.branch.id), O2 = ctx(owner2, 'OWNER', b2.branch.id), AD = ctx(adm, 'ADMIN', b1.branch.id), A = ctx(ana, 'CAJERO', b1.branch.id), B = ctx(beto, 'CAJERO', b1.branch.id), C = ctx(carla, 'CAJERO', b1.branch.id), K = ctx(conta, 'CONTADOR', b1.branch.id)
  const db = (c: TenantContext) => getTenantPrisma(c)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Producto', salePrice: 100, costPrice: 61.37, taxRate: 0 } })
  for (const w of [b1.warehouse, b2.warehouse]) await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: w.id, quantity: 1000 } })
  const vender = (c: TenantContext, method: string, monto: number, wh = b1.warehouse.id) =>
    registerSale(db(c), c, { warehouseId: wh, items: [{ productId: prod.id, quantity: monto / 100, discount: 0 }], payments: [{ method, amount: monto }], documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() } as never)
  const cerrar = (c: TenantContext, id: string, contado: number) => closeCashSession(db(c), c, closeCashSchema.parse({ sessionId: id, countedAmount: contado }))

  // Hoy, en tres cajas de la sucursal 1 (Ana y Beto cierran; Carla queda abierta) y una de la 2.
  const tA = await abrirTurno(t.id, ana.id, b1.branch.id, { fondo: 100 }), tB = await abrirTurno(t.id, beto.id, b1.branch.id, { fondo: 50 })
  const tC = await abrirTurno(t.id, carla.id, b1.branch.id, { fondo: 20 }), t2 = await abrirTurno(t.id, owner2.id, b2.branch.id, { fondo: 0 })
  await vender(A, 'EFECTIVO', 300); await vender(A, 'YAPE', 100); await vender(A, 'PLIN', 50); await vender(A, 'TARJETA_DEBITO', 70)
  await vender(B, 'YAPE', 200); await vender(C, 'EFECTIVO', 25); await vender(O2, 'EFECTIVO', 40, b2.warehouse.id)
  await cerrar(A, tA, 400); await cerrar(B, tB, 50); await cerrar(O2, t2, 40)

  console.log('\n1) El cierre de UN turno sale de la foto congelada')
  const tk = await getTicketCierre(db(A), A, tA)
  check('>>> el cierre dice en qué caja se trabajó y trae el desglose', tk.caja === 'Caja principal' && tk.desglose !== null && tk.desglose.version === 1)
  check('>>> Yape y Plin salen en líneas PROPIAS (100 y 50), con la tarjeta aparte', tk.desglose?.ventasPorMetodo.YAPE.monto === 100 && tk.desglose.ventasPorMetodo.PLIN.monto === 50 && tk.desglose.ventasPorMetodo.TARJETA_DEBITO.monto === 70 && tk.desglose.ventasPorMetodo.EFECTIVO.monto === 300)
  const h80 = renderToStaticMarkup(createElement(TicketCierreCaja, { ticket: tk }))
  check('>>> el ticket de 80 mm enseña «Yape», «Plin» y la caja', h80.includes('data-ticket="por-medio"') && h80.includes('Yape (1)') && h80.includes('Plin (1)') && h80.includes('Caja principal'))
  const hA4 = renderToStaticMarkup(createElement(CierreCajaA4, { ticket: tk }))
  check('>>> el A4 trae las ventas por medio, la cuenta del cajón, el arqueo y las firmas', hA4.includes('data-a4="por-medio"') && hA4.includes('Yape') && hA4.includes('Plin') && hA4.includes('Cuenta del cajón') && hA4.includes('data-a4="diferencia"') && hA4.includes('firma'))
  check('>>> ni el ticket ni el A4 llevan cifras de costo (61.37) ni la palabra costo/margen/utilidad', ![h80, hA4].some((h) => /61[.,]37|costo|margen|utilidad/i.test(h)))
  const csv = await exportarCierreCsv(db(A), A, tA)
  check('>>> el CSV lleva Yape y Plin en filas propias, la caja y el arqueo, con nombre del cierre', /Ventas por medio;Yape;1;100\.00/.test(csv.contenido) && /Ventas por medio;Plin;1;50\.00/.test(csv.contenido) && /Cierre;Caja;;Caja principal/.test(csv.contenido) && /Arqueo;Contado;;400\.00/.test(csv.contenido) && csv.nombre === `${tk.numero}.csv`)
  check('>>> el CSV no lleva costos', !/61[.,]37|costo|margen|utilidad|inventario/i.test(csv.contenido))
  const fotoAntes = JSON.stringify((await prisma.cashSession.findUniqueOrThrow({ where: { id: tA } })).closingBreakdown)
  await vender(B, 'EFECTIVO', 10).catch(() => undefined)
  check('>>> reimprimir el mismo cierre sale idéntico (la foto no se recalcula)', JSON.stringify((await getTicketCierre(db(A), A, tA)).desglose) === fotoAntes)

  console.log('\n2) Quién puede ver el cierre')
  check('>>> Beto NO ve el cierre de Ana (NOT_FOUND, ni ticket ni CSV); el dueño y el contador (caja.arqueo) sí', await code(getTicketCierre(db(B), B, tA)) === 'NOT_FOUND' && await code(exportarCierreCsv(db(B), B, tA)) === 'NOT_FOUND' && await code(getTicketCierre(db(O), O, tA)) === null && await code(getTicketCierre(db(K), K, tA)) === null)
  check('>>> Ana sí ve el suyo; un turno ABIERTO no se imprime (Carla)', await code(exportarCierreCsv(db(A), A, tA)) === null && await code(exportarCierreCsv(db(C), C, tC)) === 'NOT_FOUND')
  check('>>> un id inexistente es el mismo NOT_FOUND', await code(exportarCierreCsv(db(O), O, 'no-existe')) === 'NOT_FOUND')

  console.log('\n3) El consolidado del día')
  const c = await consolidadoDelDia(db(O), O)
  const s1 = c.sucursales.find((s) => s.branchId === b1.branch.id)!, s2 = c.sucursales.find((s) => s.branchId === b2.branch.id)!
  check('>>> reúne las dos sucursales; la 1 con sus 3 turnos (2 cerrados y 1 abierto)', c.sucursales.length === 2 && s1.turnos.length === 3 && s1.cerrados === 2 && s1.abiertos === 1 && s2.turnos.length === 1)
  check('>>> el total de la sucursal 1 suma TODAS sus cajas: Yape 300 (100 + 200), Plin 50, efectivo 325 (el turno abierto de Carla cuenta lo que lleva)', s1.total.ventasPorMetodo.YAPE.monto === 300 && s1.total.ventasPorMetodo.PLIN.monto === 50 && s1.total.ventasPorMetodo.EFECTIVO.monto === 325 && s1.total.ventas.cantidad === 6, JSON.stringify([s1.total.ventasPorMetodo.YAPE.monto, s1.total.ventasPorMetodo.EFECTIVO.monto, s1.total.ventas.cantidad]))
  check('>>> el total general suma las dos sucursales (efectivo 325 + 40)', c.general.total.ventasPorMetodo.EFECTIVO.monto === 365 && c.general.total.ventas.cantidad === 7 && c.general.cerrados === 3 && c.general.abiertos === 1)
  const abierto = s1.turnos.find((x) => x.estado === 'ABIERTA')!
  check('>>> un turno ABIERTO no enseña arqueo (esperado, contado y diferencia nulos): el arqueo es a ciegas', abierto.cajero === 'Carla' && abierto.esperado === null && abierto.contado === null && abierto.diferencia === null)
  const turnoAna = s1.turnos.find((x) => x.cajero === 'Ana')!
  check('>>> el cerrado sí: Ana esperaba 100 + 300 = 400 y contó 400', turnoAna.esperado === 400 && turnoAna.contado === 400 && turnoAna.diferencia === 0 && turnoAna.caja === 'Caja principal')
  check('>>> el arqueo de la sucursal suma solo los cerrados (400 + 50 esperados)', s1.arqueo.esperado === 450 && s1.arqueo.contado === 450)
  const hv = renderToStaticMarkup(createElement(ConsolidadoCajaVista, { c }))
  check('>>> la vista lista las sucursales, los turnos y los medios (Yape y Plin) y no lleva costos', hv.includes('data-consolidado="sucursal"') && hv.includes('Yape') && hv.includes('Plin') && hv.includes('Todas las sucursales') && !/61[.,]37|costo|margen|utilidad/i.test(hv))
  const cc = await exportarConsolidadoCsv(db(O), O)
  check('>>> el CSV trae un renglón por turno, el total por sucursal y el general, con Yape y Plin; sin costos', /Ventas · Yape/.test(cc.contenido) && /Ventas · Plin/.test(cc.contenido) && /TOTAL SUCURSAL/.test(cc.contenido) && /TODAS LAS SUCURSALES/.test(cc.contenido) && !/61[.,]37|costo|margen|utilidad/i.test(cc.contenido) && cc.nombre.startsWith('consolidado-caja-'))

  console.log('\n4) Permiso y alcance')
  check('>>> el administrador SÍ (de fábrica); el cajero y el contador NO (FORBIDDEN_ROLE), también en el CSV', await code(consolidadoDelDia(db(AD), AD)) === null && await code(consolidadoDelDia(db(A), A)) === 'FORBIDDEN_ROLE' && await code(consolidadoDelDia(db(K), K)) === 'FORBIDDEN_ROLE' && await code(exportarConsolidadoCsv(db(A), A)) === 'FORBIDDEN_ROLE')
  check('>>> un cajero a quien se le CONCEDE `caja.consolidado` lo ve (un permiso = un poder)', await code(consolidadoDelDia(db({ ...A, permisosExtra: ['caja.consolidado'] }), { ...A, permisosExtra: ['caja.consolidado'] })) === null)
  const ADs1 = ctx(adm, 'ADMIN', b1.branch.id, [b1.branch.id])
  const so = await consolidadoDelDia(db(ADs1), ADs1)
  check('>>> un administrador acotado a la sucursal 1 solo ve la 1', so.sucursales.length === 1 && so.sucursales[0]!.branchId === b1.branch.id && so.general.total.ventasPorMetodo.EFECTIVO.monto === 325)
  const ajeno = await prisma.tenant.create({ data: { slug: `cr-aj-${randomUUID().slice(0, 6)}`, name: 'Ajeno', planId: plan.id } })
  const ca = await consolidadoDelDia(db({ ...O, tenantId: ajeno.id } as TenantContext), { ...O, tenantId: ajeno.id } as TenantContext).catch(() => null)
  check('>>> otro negocio no ve nada de este', ca === null || ca.sucursales.length === 0)

  console.log('\n5) El día es el del negocio y la fecha se valida')
  check('>>> leerFecha acepta AAAA-MM-DD reales y rechaza 2026-02-30, texto y vacío', leerFecha('2026-10-29')?.iso === '2026-10-29' && leerFecha('2026-02-30') === null && leerFecha('hoy') === null && leerFecha('') === null && leerFecha(null) === null)
  check('>>> una fecha mala es INVALID_DOCUMENT', await code(consolidadoDelDia(db(O), O, '2026-13-01')) === 'INVALID_DOCUMENT')
  check('>>> otro día sin turnos: lista vacía', (await consolidadoDelDia(db(O), O, '2020-01-01')).sucursales.length === 0)
  // Un turno que abrió AYER (zona del negocio) no cuenta hoy.
  const ayer = new Date(Date.now() - 36 * 3_600_000)
  await prisma.cashSession.update({ where: { id: tB }, data: { openedAt: ayer } })
  const hoy2 = await consolidadoDelDia(db(O), O)
  const diaAyer = new Intl.DateTimeFormat('en-CA', { timeZone: hoy2.zonaHoraria }).format(ayer)
  const antier = await consolidadoDelDia(db(O), O, diaAyer)
  check('>>> el turno abierto ayer sale en el consolidado de AYER y no en el de hoy', !hoy2.sucursales.flatMap((s) => s.turnos).some((x) => x.id === tB) && antier.sucursales.flatMap((s) => s.turnos).some((x) => x.id === tB))

  console.log('\n6) Cierres anteriores al detalle (sin foto)')
  await prisma.cashSession.update({ where: { id: tA }, data: { closingBreakdown: null as never } }).catch(async () => { await prisma.$executeRaw`UPDATE cash_sessions SET "closingBreakdown" = NULL WHERE id = ${tA}` })
  const viejo = await getTicketCierre(db(A), A, tA)
  const hViejo = renderToStaticMarkup(createElement(CierreCajaA4, { ticket: viejo }))
  const csvViejo = await exportarCierreCsv(db(A), A, tA)
  check('>>> el ticket sigue saliendo con sus totales y el A4 y el CSV avisan que no hay detalle por medio', viejo.desglose === null && hViejo.includes('data-a4="sin-desglose"') && /Aviso/.test(csvViejo.contenido))
  const c2 = await consolidadoDelDia(db(O), O)
  check('>>> el consolidado lo lista, avisa que no entra al detalle y no se rompe', c2.sucursales.find((s) => s.branchId === b1.branch.id)!.sinDesglose === 1)
}

async function main() {
  try { await cuerpo() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? (e.stack ?? e.message).slice(0, 400) : e}`, false) }
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
