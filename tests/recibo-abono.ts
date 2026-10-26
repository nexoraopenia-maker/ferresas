import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { anularAbono, configurarCredito, hoyEnZona, registrarAbono } from '../src/features/credito/credito-service'
import { anularAbonoSchema, configurarCreditoSchema, registrarAbonoSchema } from '../src/features/credito/schemas'
import { openCashSession } from '../src/features/branches/cash-service'
import { openCashSchema } from '../src/features/branches/cash-schemas'
import { crearCliente } from '../src/features/clientes/service'
import { crearClienteSchema } from '../src/features/clientes/schemas'
import { getReciboAbono, numeroDeRecibo, type ReciboAbono } from '../src/features/printing/recibo-abono'
import { TicketAbono } from '../src/features/printing/components/TicketAbono'
import { esTipoImpresion } from '../src/features/printing/queries'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 3, subpaso 5.5: el recibo de abono de 80 mm (el comprobante de caja del cliente que paga una deuda).
 * Lo que más importa: dice exactamente lo cobrado y a qué se aplicó, la deuda restante es la de AQUELLA tarde (no la de hoy), un
 * abono anulado no puede pasar por vigente, y nadie ve el recibo de otro negocio.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const num = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? 'NaN')
const html = (r: ReciboAbono) => renderToStaticMarkup(createElement(TicketAbono, { recibo: r }))

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: { slug: `ra-${tag}-${randomUUID().slice(0, 6)}`, name: `Recibo ${tag}`, legalName: `RECIBO ${tag.toUpperCase()} SAC`, taxId, planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cl' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const mk = async (role: Role) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, u.id, b1.branch.id)
    return u
  }
  const ctxs: Record<string, TenantContext> = {}
  for (const r of ['OWNER', 'ADMIN', 'CAJERO', 'VENDEDOR', 'ALMACENERO', 'CONTADOR'] as Role[]) {
    const u = await mk(r)
    ctxs[r] = { tenantId: t.id, userId: u.id, role: r, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: r === 'CAJERO' ? ['credito.otorgar'] : [] }
  }
  const dbOf = (c: TenantContext) => getTenantPrisma(c)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Producto', salePrice: 100 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: b1.warehouse.id, quantity: 10000 } })
  const O = ctxs.OWNER!
  const vender = (monto: number, payments: { method: string; amount: number }[], customerId: string, c: TenantContext = O) =>
    registerSale(dbOf(c), c, { warehouseId: b1.warehouse.id, customerId, items: [{ productId: prod.id, quantity: monto / 100, discount: 0 }], payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() } as never)
  const linea = (customerId: string, limite: number, dias = 30) => configurarCredito(dbOf(O), O, configurarCreditoSchema.parse({ customerId, creditLimit: limite, creditTermDays: dias, bloqueado: false }))
  const abrirCaja = () => openCashSession(dbOf(O), O, openCashSchema.parse({ openingAmount: 0 }))
  return { t, b1, ctxs, dbOf, prod, vender, linea, abrirCaja, O }
}



async function main() {
  const base: ReciboAbono = {
    numero: 'AB-20261026-3F9A1C', fecha: '2026-10-26T15:30:00.000Z', zonaHoraria: 'America/Lima', locale: 'es-PE',
    emisor: { nombre: 'Ferretería Demo', razonSocial: 'FERRETERÍA DEMO SAC', ruc: '20123456789', direccion: 'Av. Principal 123', telefono: '999888777' },
    cliente: { nombre: 'Ana Quispe', docEtiqueta: 'DNI', docNumero: '41300001' }, cobradoPor: 'Rosa', metodo: 'YAPE', referencia: 'OP-998877',
    monto: 1250.5, reparto: [{ venta: 'V001-00000001', monto: 1000 }, { venta: 'V001-00000002', monto: 250.5 }], deudaDespues: 349.5, anulado: false, motivoAnulacion: null,
  }

  console.log('\nA) El papel')
  const h = html(base)
  check('>>> encabezado del NEGOCIO (nombre, razón social, RUC, dirección, teléfono), título «RECIBO DE ABONO» y el número', ['FERRETERÍA DEMO SAC', 'RUC 20123456789', 'Av. Principal 123', 'Tel. 999888777', 'RECIBO DE ABONO', 'AB-20261026-3F9A1C'].every((x) => h.includes(x)))
  check('>>> fecha y hora en la zona del negocio (10:30 en Lima), quién cobró, el cliente y su documento', h.includes('26/10/2026') && h.includes('10:30') && h.includes('>Rosa<') && h.includes('Ana Quispe') && h.includes('>DNI<') && h.includes('41300001'))
  check('>>> forma de pago en español, la referencia, y el monto con separador de miles (S/ 1,250.50) bien visible', h.includes('Yape') && h.includes('OP-998877') && /data-ticket="monto"[\s\S]*?S\/ 1,250\.50/.test(h))
  check('>>> «Aplicado a» lista cada venta con lo aplicado (1,000.00 y 250.50) y la deuda restante (349.50)', h.includes('Aplicado a:') && h.includes('V001-00000001') && h.includes('S/ 1,000.00') && h.includes('V001-00000002') && h.includes('S/ 250.50') && /data-ticket="deuda"[\s\S]*?S\/ 349\.50/.test(h))
  check('>>> el pie dice que es un recibo INTERNO y no un comprobante electrónico; sin QR, sin «SUNAT»', h.includes('Recibo interno de caja. No es un comprobante de pago electrónico.') && !h.includes('SUNAT') && !h.includes('Hash'))
  check('>>> un abono vigente NO lleva marca de agua ni «anulado»', !h.includes('t-marca') && !h.includes('ANULADO'))
  const hA = html({ ...base, anulado: true, motivoAnulacion: 'se digitó mal' })
  check('>>> un abono ANULADO lo declara: marca de agua, «** RECIBO ANULADO **» y el motivo (nadie lo presenta como cobro vigente)', hA.includes('t-marca') && hA.includes('ANULADO') && hA.includes('** RECIBO ANULADO **') && hA.includes('se digitó mal'))
  check('sin referencia no hay línea «Ref.»; sin deuda registrada se omite «Deuda restante»; sin documento no hay fila de documento; sin reparto no hay «Aplicado a»',
    !html({ ...base, referencia: null }).includes('>Ref.<') && !html({ ...base, deudaDespues: null }).includes('Deuda restante') && !html({ ...base, cliente: { nombre: 'Sin Doc', docEtiqueta: null, docNumero: null } }).includes('>DNI<') && !html({ ...base, reparto: [] }).includes('Aplicado a'))
  check('una deuda restante de cero se IMPRIME (S/ 0.00: «ya no debes nada» es información), no se omite', html({ ...base, deudaDespues: 0 }).includes('Deuda restante') && /data-ticket="deuda"[\s\S]*?S\/ 0\.00/.test(html({ ...base, deudaDespues: 0 })))
  check('el nombre del negocio igual a la razón social no se repite', (html({ ...base, emisor: { ...base.emisor, nombre: 'SAC X', razonSocial: 'SAC X' } }).match(/SAC X/g) ?? []).length === 1)

  console.log('\nB) El número del recibo')
  check('>>> AB-AAAAMMDD-XXXXXX: el día del negocio y los últimos 6 del identificador, en mayúsculas', numeroDeRecibo('cmvpabcdef123456', '2026-10-26') === 'AB-20261026-123456' && numeroDeRecibo('cmvpabcdefabc123', '2026-01-02') === 'AB-20260102-ABC123')
  check('es estable: el mismo abono, el mismo número, siempre', numeroDeRecibo('cmv0123456abcdef', '2026-10-26') === numeroDeRecibo('cmv0123456abcdef', '2026-10-26'))

  const E = await negocio('a')
  const { O, ctxs, dbOf, vender, linea, abrirCaja, t: tn } = E
  const db = dbOf(O)
  const tz = (await prisma.tenant.findUniqueOrThrow({ where: { id: tn.id } })).timezone
  void tz
  await prisma.tenant.update({ where: { id: tn.id }, data: { phone: '014445566', address: 'Jr. Lima 100' } })
  let dn = 46000000
  const cli = (name: string) => crearCliente(db, O, crearClienteSchema.parse({ name, docNumber: String(dn++) }))
  const abonar = (customerId: string, amount: number, method = 'EFECTIVO', extra: Record<string, unknown> = {}) =>
    registrarAbono(db, O, registrarAbonoSchema.parse({ customerId, method, amount, idempotencyKey: randomUUID(), ...extra }))

  console.log('\nC) Con datos reales')
  const A = await cli('Ana Recibo'); await linea(A.id, 5000)
  await abrirCaja()
  const v1 = await vender(300, [{ method: 'CREDITO', amount: 300 }], A.id), v2 = await vender(200, [{ method: 'CREDITO', amount: 200 }], A.id), v3 = await vender(100, [{ method: 'CREDITO', amount: 100 }], A.id)
  void v1; void v2; void v3
  const ab1 = await abonar(A.id, 350, 'YAPE', { reference: 'OP-12345' })
  const rec = await getReciboAbono(db, O, ab1.paymentId)
  const ventas = await prisma.sale.findMany({ where: { tenantId: tn.id }, orderBy: { createdAt: 'asc' }, select: { number: true } })
  check('>>> el recibo real trae monto 350, Yape, la referencia, el cliente con su DNI, quién cobró y el negocio', rec.monto === 350 && rec.metodo === 'YAPE' && rec.referencia === 'OP-12345' && rec.cliente.nombre === 'Ana Recibo' && rec.cliente.docEtiqueta === 'DNI' && rec.cobradoPor === 'OWNER' && rec.emisor.nombre === 'Recibo a' && rec.emisor.telefono === '014445566' && rec.emisor.direccion === 'Jr. Lima 100')
  check('>>> el reparto del recibo es el del servicio (FIFO): 300 a la primera venta y 50 a la segunda', rec.reparto.length === 2 && rec.reparto[0]!.venta === ventas[0]!.number && rec.reparto[0]!.monto === 300 && rec.reparto[1]!.monto === 50 && ab1.reparto.every((x, k) => x.venta === rec.reparto[k]!.venta && x.monto === rec.reparto[k]!.monto))
  check('>>> la deuda restante es la de ese momento: 600 − 350 = 250', rec.deudaDespues === 250 && rec.deudaDespues === ab1.deudaDespues)
  check('el número tiene el formato y termina en los 6 últimos del abono', /^AB-\d{8}-[0-9A-Z]{6}$/.test(rec.numero) && rec.numero.endsWith(ab1.paymentId.slice(-6).toUpperCase()))
  const ab2 = await abonar(A.id, 100, 'EFECTIVO')
  const v4 = await vender(500, [{ method: 'CREDITO', amount: 500 }], A.id)
  void v4
  const recDespues = await getReciboAbono(db, O, ab1.paymentId)
  check('>>> REIMPRIMIR días después: tras otro abono y otra venta fiada (deuda de hoy: 650) el recibo viejo SIGUE diciendo 250, y es idéntico', recDespues.deudaDespues === 250 && JSON.stringify(recDespues) === JSON.stringify(rec) && num((await prisma.customer.findUniqueOrThrow({ where: { id: A.id } })).creditBalance) === 650)
  const rec2 = await getReciboAbono(db, O, ab2.paymentId)
  check('el segundo recibo dice 150 (250 − 100): cada uno refleja su momento; y el efectivo sale como «Efectivo»', rec2.deudaDespues === 150 && html(rec2).includes('Efectivo') && rec2.numero !== rec.numero)
  const repetido = await registrarAbono(db, O, registrarAbonoSchema.parse({ customerId: A.id, method: 'EFECTIVO', amount: 100, idempotencyKey: (await prisma.customerPayment.findUniqueOrThrow({ where: { id: ab2.paymentId } })).idempotencyKey! }))
  check('>>> un reintento (misma clave) devuelve el MISMO abono y por tanto el MISMO recibo (no se imprime otro número)', repetido.replayed && repetido.paymentId === ab2.paymentId && (await getReciboAbono(db, O, repetido.paymentId)).numero === rec2.numero)
  await anularAbono(db, O, anularAbonoSchema.parse({ paymentId: ab2.paymentId, motivo: 'error al digitar' }))
  const recAnul = await getReciboAbono(db, O, ab2.paymentId)
  check('>>> el recibo de un abono anulado sale marcado ANULADO con su motivo (y conserva los demás datos)', recAnul.anulado && recAnul.motivoAnulacion === 'error al digitar' && recAnul.monto === 100 && html(recAnul).includes('** RECIBO ANULADO **'))
  check('el del abono vigente sigue sin marca', !(await getReciboAbono(db, O, ab1.paymentId)).anulado)

  console.log('\nD) Permisos y negocios')
  check('>>> el CAJERO (quien cobra) puede imprimir el recibo; el vendedor, el almacenero y el CONTADOR no', (await getReciboAbono(dbOf(ctxs.CAJERO!), ctxs.CAJERO!, ab1.paymentId)).numero === rec.numero && (await Promise.all(['VENDEDOR', 'ALMACENERO', 'CONTADOR'].map((r) => code(getReciboAbono(dbOf(ctxs[r]!), ctxs[r]!, ab1.paymentId))))).every((c) => c === 'FORBIDDEN_ROLE'))
  const E2 = await negocio('b')
  const ajeno = await crearCliente(E2.dbOf(E2.O), E2.O, crearClienteSchema.parse({ name: 'Cliente Ajeno', docNumber: String(dn++) }))
  await E2.linea(ajeno.id, 900); await E2.abrirCaja(); await E2.vender(900, [{ method: 'CREDITO', amount: 900 }], ajeno.id)
  const abAjeno = await registrarAbono(E2.dbOf(E2.O), E2.O, registrarAbonoSchema.parse({ customerId: ajeno.id, method: 'YAPE', amount: 100, idempotencyKey: randomUUID() }))
  check('>>> el recibo de OTRO negocio no existe (NOT_FOUND, sin filtrar nada) y un id inventado tampoco', await code(getReciboAbono(db, O, abAjeno.paymentId)) === 'NOT_FOUND' && await code(getReciboAbono(db, O, 'no-existe')) === 'NOT_FOUND')
  check('>>> y el recibo del otro negocio lleva SUS datos, no los nuestros', (await getReciboAbono(E2.dbOf(E2.O), E2.O, abAjeno.paymentId)).cliente.nombre === 'Cliente Ajeno' && (await getReciboAbono(E2.dbOf(E2.O), E2.O, abAjeno.paymentId)).emisor.telefono !== '014445566')
  const antes = JSON.stringify([await prisma.customerPayment.findMany({ where: { tenantId: tn.id }, orderBy: { id: 'asc' } }), await prisma.auditLog.count({ where: { tenantId: tn.id } })])
  await getReciboAbono(db, O, ab1.paymentId); await getReciboAbono(db, O, ab1.paymentId)
  check('>>> imprimir es de SOLO LECTURA: los abonos y la auditoría quedan idénticos', JSON.stringify([await prisma.customerPayment.findMany({ where: { tenantId: tn.id }, orderBy: { id: 'asc' } }), await prisma.auditLog.count({ where: { tenantId: tn.id } })]) === antes)
  void hoyEnZona; void configurarCredito; void configurarCreditoSchema

  console.log('\nE) Rutas y enlaces')
  const ruta = readFileSync('src/app/(print)/imprimir/abono/[id]/page.tsx', 'utf8')
  check('>>> la ruta /imprimir/abono/[id]: 404 si no existe, es de otro negocio o no se puede ver; el id se acota; imprime solo al abrir con ?auto=1', /NOT_FOUND' \|\| e\.code === 'FORBIDDEN_ROLE'/.test(ruta) && ruta.includes('notFound()') && ruta.includes('id.slice(0, 64)') && ruta.includes("auto === '1'") && ruta.includes('TicketAbono'))
  check('>>> «abono» NO es un tipo del ruteador genérico (no hay colisión con /imprimir/[tipo]/[id]) y comparte layout y hoja de estilos del ticket', !esTipoImpresion('abono') && !readFileSync('src/features/printing/queries.ts', 'utf8').includes("'abono'") && ruta.includes('BarraImpresion'))
  const modal = readFileSync('src/features/clientes/components/ModalAbono.tsx', 'utf8'), cuentas = readFileSync('src/features/clientes/components/CuentasYAbonos.tsx', 'utf8')
  check('>>> el modal ofrece imprimir el recibo recién hecho (?auto=1) y cada abono de la ficha tiene su enlace «Recibo»', modal.includes('/imprimir/abono/${resultado.paymentId}?auto=1') && modal.includes('paymentId: r.data.paymentId') && cuentas.includes('/imprimir/abono/${a.id}') && cuentas.includes('data-enlace="recibo"'))
  const svc = readFileSync('src/features/printing/recibo-abono.ts', 'utf8')
  check('el servicio del recibo no escribe nada ni usa SQL crudo, y toma la deuda restante de la auditoría del propio abono', !/\.(create|update|delete|upsert)\w*\(|\$queryRaw|\$executeRaw|\$transaction/.test(svc) && svc.includes("action: 'credito.abono'") && svc.includes('deudaDespues'))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
