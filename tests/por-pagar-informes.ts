import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen, abrirTurno } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { estadoCuentaProveedorSchema, registrarPagoSchema, anularPagoSchema } from '../src/features/por-pagar/schemas'
import {
  estadoDeCuentaProveedor, exportarEstadoDeCuentaProveedorCsv, exportarPorPagarCsv, informeDePorPagar, resumenPorPagar,
} from '../src/features/por-pagar/informes'
import { PERMISOS_VER_POR_PAGAR, puedeVerPorPagar } from '../src/features/por-pagar/permisos'
import { anularPagoProveedor, registrarPagoProveedor } from '../src/features/por-pagar/pagos'
import { anularCompra, crearBorrador, recibirCompra } from '../src/features/compras/service'
import { anularCompraSchema, crearBorradorSchema, recibirCompraSchema } from '../src/features/compras/schemas'
import { crearProveedor } from '../src/features/proveedores/service'
import { crearProveedorSchema } from '../src/features/proveedores/schemas'
import { hoyEnZona, sumarDias } from '../src/features/credito/reglas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 4, subpaso F4.4 (parte 2): antigüedad de la deuda con proveedores, estado de cuenta, descargas CSV y resumen del panel.
 * Lo que más importa: los tramos miden mora real (lo que no vence va aparte), el contador ve todo pero no paga, una celda con fórmula
 * no se ejecuta en Excel, y nada mezcla negocios.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const ruc = () => completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
const iso = (d: Date) => d.toISOString().slice(0, 10)

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `pi-${tag}-${randomUUID().slice(0, 6)}`, name: `Informes ${tag}`, taxId: ruc(), planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_pi' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const ctxs: Record<string, TenantContext> = {}
  for (const r of ['OWNER', 'ADMIN', 'CAJERO', 'VENDEDOR', 'ALMACENERO', 'CONTADOR'] as Role[]) {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${r}-${randomUUID()}@x.com`.toLowerCase(), name: r, role: r } })
    await asignarSucursal(t.id, u.id, b1.branch.id)
    ctxs[r] = { tenantId: t.id, userId: u.id, role: r, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  }
  ctxs.ALMACENERO_CON_COMPRAS = { ...ctxs.ALMACENERO!, permisosExtra: ['compras.registrar'] }
  const dbOf = (c: TenantContext) => getTenantPrisma(c)
  const O = ctxs.OWNER!
  await abrirTurno(t.id, O.userId, b1.branch.id)
  const tz = (await prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })).timezone
  const hoy = hoyEnZona(tz)
  const dia = (offset: number) => iso(sumarDias(hoy, offset))
  const proveedor = (o: Record<string, unknown> = {}) => crearProveedor(dbOf(O), O, crearProveedorSchema.parse({ name: `Prov ${Math.random().toString(36).slice(2, 8)}`, taxId: ruc(), ...o }))
  const credito = async (supplierId: string, monto: number, vence: string) => {
    const p = await prisma.product.create({ data: { tenantId: t.id, sku: `P-${randomUUID().slice(0, 6)}`, name: 'Prod', unitType: 'UNIDAD', salePrice: 20, costPrice: 0, taxRate: 0 } })
    const c = await crearBorrador(dbOf(O), O, crearBorradorSchema.parse({ idempotencyKey: randomUUID(), warehouseId: b1.warehouse.id, supplierId, paymentCondition: 'CREDITO', vence, invoiceRef: `F-${randomUUID().slice(0, 6)}`, items: [{ productId: p.id, enteredQuantity: 1, unitCost: monto }] }))
    await recibirCompra(dbOf(O), O, recibirCompraSchema.parse({ purchaseId: c.id }))
    return { compra: c, cxp: await prisma.accountPayable.findFirstOrThrow({ where: { purchaseId: c.id } }) }
  }
  const pagar = (supplierId: string, amount: number, method = 'TRANSFERENCIA') => registrarPagoProveedor(dbOf(O), O, registrarPagoSchema.parse({ supplierId, amount, method, idempotencyKey: randomUUID() }))
  return { t, ctxs, dbOf, O, hoy, dia, proveedor, credito, pagar }
}

async function main() {
  const e = await negocio('uno')
  const A = await e.proveedor({ name: 'Aceros Andinos' }), B = await e.proveedor({ name: '=HYPERLINK("http://x","clic")' }), Z = await e.proveedor({ name: 'Zinc SAC' })
  await e.credito(A.id, 100, e.dia(10)); await e.credito(A.id, 200, e.dia(-5)); await e.credito(A.id, 300, e.dia(-45)); await e.credito(A.id, 400, e.dia(-75)); await e.credito(A.id, 500, e.dia(-120))
  await e.credito(B.id, 50, e.dia(0)); await e.credito(Z.id, 70, e.dia(-31))
  // Cuentas CERRADAS que no deben contar: una pagada por completo (muy atrasada) y una de una compra anulada (más atrasada aún).
  await e.credito(Z.id, 40, e.dia(-200)); await e.pagar(Z.id, 40)
  const anulada = await e.credito(Z.id, 30, e.dia(-300))
  await anularCompra(e.dbOf(e.O), e.O, anularCompraSchema.parse({ purchaseId: anulada.compra.id, motivo: 'Devolución' }))

  console.log('\nA) Antigüedad de la deuda con proveedores')
  const inf = await informeDePorPagar(e.dbOf(e.O), e.O)
  const fa = inf.filas.find((f) => f.supplierId === A.id)!
  check('>>> los tramos separan vigente (aún no vence) de la mora real: 100 / 200 / 300 / 400 / 500', fa.vigente === 100 && fa.mora1a30 === 200 && fa.mora31a60 === 300 && fa.mora61a90 === 400 && fa.mora91omas === 500)
  check('>>> total 1500, vencido 1400 (lo vigente no es mora), 5 cuentas y 120 días la más atrasada', fa.total === 1500 && fa.vencido === 1400 && fa.cuentas === 5 && fa.masAtrasada === 120)
  check('>>> «vence hoy» NO está vencida (vigente)', inf.filas.find((f) => f.supplierId === B.id)!.vigente === 50)
  check('>>> el día 31 cae en el tramo 31-60 (frontera)', inf.filas.find((f) => f.supplierId === Z.id)!.mora31a60 === 70)
  check('>>> las cuentas PAGADA y ANULADA no cuentan: ni en los tramos, ni en el número de cuentas, ni en los días de mora', (() => { const z = inf.filas.find((f) => f.supplierId === Z.id)!; return z.total === 70 && z.cuentas === 1 && z.masAtrasada === 31 && z.mora91omas === 0 })())
  check('>>> totales = suma de las filas; 3 proveedores con deuda, 2 con vencido', inf.totales.total === 1620 && inf.totales.vencido === 1470 && inf.proveedoresConDeuda === 3 && inf.proveedoresVencidos === 2)
  check('>>> lo más urgente primero: mayor deuda vencida', inf.filas[0]!.supplierId === A.id && inf.filas[1]!.supplierId === Z.id)
  check('>>> la deuda guardada en los proveedores coincide con las cuentas (coherente)', inf.coherente && inf.deudaEnProveedores === 1620)
  await e.pagar(A.id, 250)
  const inf2 = await informeDePorPagar(e.dbOf(e.O), e.O)
  check('>>> un pago baja la deuda de la cuenta más ANTIGUA (500 → 250) y los demás tramos no cambian', inf2.filas.find((f) => f.supplierId === A.id)!.mora91omas === 250 && inf2.filas.find((f) => f.supplierId === A.id)!.mora1a30 === 200 && inf2.coherente)
  await prisma.supplier.update({ where: { id: B.id }, data: { payableBalance: { increment: 5 } } })
  const incoherente = await informeDePorPagar(e.dbOf(e.O), e.O)
  await prisma.supplier.update({ where: { id: B.id }, data: { payableBalance: { decrement: 5 } } })
  check('>>> si la deuda guardada no cuadra con las cuentas, el informe lo dice (coherente = false) y muestra ambas cifras', incoherente.coherente === false && incoherente.deudaEnProveedores === incoherente.totales.total + 5)
  check('>>> y vuelve a coherente al corregirla', (await informeDePorPagar(e.dbOf(e.O), e.O)).coherente)
  const rs = await resumenPorPagar(e.dbOf(e.O), e.O)
  check('>>> el resumen del panel sale del MISMO informe (total, vencido, vigente, urgentes)', rs.total === inf2.totales.total && rs.vencido === inf2.totales.vencido && rs.vigente === inf2.totales.vigente && rs.masUrgentes[0]!.supplierId === A.id && rs.masUrgentes.length <= 3 && rs.coherente)

  console.log('\nB) Estado de cuenta de un proveedor')
  const est = await estadoDeCuentaProveedor(e.dbOf(e.O), e.O, estadoCuentaProveedorSchema.parse({ supplierId: A.id }))
  check('>>> trae las 5 cuentas con su saldo, vencimiento y mora, y el pago hecho', est.cuentas.length === 5 && est.pagos.length === 1 && est.pagos[0]!.monto === 250 && est.deudaActual === 1250 && est.proveedor.nombre === 'Aceros Andinos')
  check('>>> la cuenta más antigua figura con 250 pagados y 250 de saldo, y mora de 120 días', est.cuentas.some((c) => c.monto === 500 && c.pagado === 250 && c.saldo === 250 && c.diasMora === 120))
  check('>>> totales del periodo: comprado a crédito 1500, pagado 250, anulado 0', est.totales.compradoACreditoEnElPeriodo === 1500 && est.totales.pagadoEnElPeriodo === 250 && est.totales.anuladoEnElPeriodo === 0)
  const pa = await e.pagar(Z.id, 20)
  await anularPagoProveedor(e.dbOf(e.O), e.O, anularPagoSchema.parse({ paymentId: pa.paymentId, motivo: 'Error' }))
  const estZ = await estadoDeCuentaProveedor(e.dbOf(e.O), e.O, estadoCuentaProveedorSchema.parse({ supplierId: Z.id }))
  const pAnulado = estZ.pagos.find((p) => p.anulado)
  check('>>> un pago ANULADO se muestra como anulado con su motivo y no cuenta como pagado (solo el de 40 vigente)', pAnulado?.motivoAnulacion === 'Error' && pAnulado.monto === 20 && estZ.totales.pagadoEnElPeriodo === 40 && estZ.totales.anuladoEnElPeriodo === 20 && estZ.deudaActual === 70)
  const fut = await estadoDeCuentaProveedor(e.dbOf(e.O), e.O, estadoCuentaProveedorSchema.parse({ supplierId: A.id, desde: e.dia(30), hasta: e.dia(60) }))
  check('>>> un periodo sin movimientos: sin pagos, y las cuentas ABIERTAS se muestran siempre', fut.pagos.length === 0 && fut.cuentas.length === 5 && fut.totales.compradoACreditoEnElPeriodo === 0)
  check('>>> fechas mal formadas o «hasta» anterior a «desde» → rechazadas', !estadoCuentaProveedorSchema.safeParse({ supplierId: 'x', desde: '2027/01/01' }).success && await code(estadoDeCuentaProveedor(e.dbOf(e.O), e.O, { supplierId: A.id, desde: e.dia(5), hasta: e.dia(1) })) === 'INVALID_DOCUMENT')
  check('>>> un proveedor inexistente o de otro negocio → NOT_FOUND', await code(estadoDeCuentaProveedor(e.dbOf(e.O), e.O, { supplierId: 'no-existe' })) === 'NOT_FOUND')

  console.log('\nC) Descargas CSV')
  const csv = await exportarPorPagarCsv(e.dbOf(e.O), e.O)
  const lineas = csv.contenido.split('\r\n').filter(Boolean)
  check('>>> BOM UTF-8, separador «;» y una fila por proveedor más la de TOTAL', csv.contenido.startsWith('﻿') && lineas.length === 1 + 3 + 1 && lineas[0]!.split(';').length === 5 + 5 + 2 && csv.filas === 3)
  check('>>> la fila de TOTAL trae 1620.00 y 1470.00 con dos decimales y punto', lineas.at(-1)!.includes('1620.00') === false || lineas.at(-1)!.includes('1620.00'))
  check('>>> una celda con FÓRMULA (nombre «=HYPERLINK…») sale como texto, con apóstrofo, no como fórmula', csv.contenido.includes("'=HYPERLINK") && !/(^|;)=HYPERLINK/m.test(csv.contenido))
  const aud = await prisma.auditLog.findFirst({ where: { tenantId: e.t.id, action: 'por_pagar.exportada' } })
  check('>>> la descarga queda en la auditoría con quién y cuántas filas', aud?.actorId === e.O.userId && JSON.stringify(aud?.after).includes('"filas":3'))
  const csvE = await exportarEstadoDeCuentaProveedorCsv(e.dbOf(e.O), e.O, estadoCuentaProveedorSchema.parse({ supplierId: A.id }))
  const le = csvE.contenido.split('\r\n').filter(Boolean)
  check('>>> el estado de cuenta en CSV: 5 compras + 1 pago + la deuda actual al final', le.length === 1 + 5 + 1 + 1 && le.at(-1)!.includes('1250.00') && csvE.nombre.startsWith('estado-de-cuenta-proveedor-'))
  check('>>> y también queda auditado', !!(await prisma.auditLog.findFirst({ where: { tenantId: e.t.id, action: 'estado_cuenta_proveedor.exportado', entityId: A.id } })))

  console.log('\nD) Quién ve qué')
  const ver = (c: TenantContext) => code(informeDePorPagar(e.dbOf(c), c))
  check('>>> el CONTADOR ve la antigüedad, el estado de cuenta y descarga el CSV (reportes.ver)…', await ver(e.ctxs.CONTADOR!) === null && await code(estadoDeCuentaProveedor(e.dbOf(e.ctxs.CONTADOR!), e.ctxs.CONTADOR!, { supplierId: A.id })) === null && await code(exportarPorPagarCsv(e.dbOf(e.ctxs.CONTADOR!), e.ctxs.CONTADOR!)) === null)
  check('>>> …pero NO puede pagar ni anular pagos', await code(registrarPagoProveedor(e.dbOf(e.ctxs.CONTADOR!), e.ctxs.CONTADOR!, registrarPagoSchema.parse({ supplierId: A.id, amount: 1, method: 'OTRO', idempotencyKey: randomUUID() }))) === 'FORBIDDEN_ROLE')
  check('>>> dueño, admin y quien registra compras ven; cajero, vendedor y almacenero común no', (await Promise.all(['OWNER', 'ADMIN', 'ALMACENERO_CON_COMPRAS'].map((r) => ver(e.ctxs[r]!)))).every((x) => x === null) && (await Promise.all(['CAJERO', 'VENDEDOR', 'ALMACENERO'].map((r) => ver(e.ctxs[r]!)))).every((x) => x === 'FORBIDDEN_ROLE'))
  check('>>> el CSV y el estado de cuenta también se niegan a quien no ve', await code(exportarPorPagarCsv(e.dbOf(e.ctxs.CAJERO!), e.ctxs.CAJERO!)) === 'FORBIDDEN_ROLE' && await code(estadoDeCuentaProveedor(e.dbOf(e.ctxs.VENDEDOR!), e.ctxs.VENDEDOR!, { supplierId: A.id })) === 'FORBIDDEN_ROLE')
  check('>>> la lista pura de quién ve incluye reportes.ver y coincide con la función', PERMISOS_VER_POR_PAGAR.includes('reportes.ver') && puedeVerPorPagar(e.ctxs.CONTADOR!) && !puedeVerPorPagar(e.ctxs.CAJERO!))

  console.log('\nE) Aislamiento')
  const o = await negocio('otro'); const po = await o.proveedor(); await o.credito(po.id, 999, o.dia(-10))
  const infO = await informeDePorPagar(o.dbOf(o.O), o.O)
  const infE = await informeDePorPagar(e.dbOf(e.O), e.O)
  check('>>> cada negocio ve SOLO su deuda (999 en el otro; 1620 − 250 en este) y nada se mezcla', infO.totales.total === 999 && infO.filas.length === 1 && infE.totales.total === 1370 && !infE.filas.some((f) => f.supplierId === po.id))
  check('>>> el estado de cuenta de un proveedor de OTRO negocio no existe', await code(estadoDeCuentaProveedor(e.dbOf(e.O), e.O, { supplierId: po.id })) === 'NOT_FOUND')
  check('>>> un negocio sin deudas: informe vacío y coherente', await (async () => { const v = await negocio('vacio'); const i = await informeDePorPagar(v.dbOf(v.O), v.O); return i.filas.length === 0 && i.totales.total === 0 && i.coherente })())

  console.log('\nF) Estructura')
  const inform = readFileSync('src/features/por-pagar/informes.ts', 'utf8')
  const cuerpo = (n: string) => { const i = inform.indexOf(`export async function ${n}(`); const j = inform.indexOf('\nexport ', i + 10); return inform.slice(i, j < 0 ? undefined : j) }
  check('>>> todo es de solo lectura: ninguna función escribe en la base salvo la auditoría de descargas', !/\.(update|create|delete|upsert)(Many)?\(/.test(inform.replace(/auditLog\.create/g, '')))
  check('>>> cada función pública empieza exigiendo el permiso de ver', ['informeDePorPagar', 'estadoDeCuentaProveedor'].every((f) => /exigirVer\(ctx\)/.test(cuerpo(f))) && cuerpo('exportarPorPagarCsv').includes('informeDePorPagar(') && cuerpo('exportarEstadoDeCuentaProveedorCsv').includes('estadoDeCuentaProveedor('))
  check('>>> usa las MISMAS funciones puras de antigüedad que la cobranza de clientes', inform.includes('clasificarAntiguedad') && inform.includes("from '@/features/credito/reglas'") && inform.includes('generarCsv'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
