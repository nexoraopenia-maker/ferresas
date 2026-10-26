import './guard'
import { correr } from './teardown'
import { asignarSucursal, crearSucursalConAlmacen } from './fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { completarRuc } from '../src/lib/documentos'
import { registerSale } from '../src/features/pos/sale-service'
import { configurarCredito } from '../src/features/credito/credito-service'
import { configurarCreditoSchema } from '../src/features/credito/schemas'
import { construirInfoCredito, motivoNoCabe, type ClienteCredito, type InfoCreditoCliente } from '../src/features/credito/reglas'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { openCashSession } from '../src/features/branches/cash-service'
import { openCashSchema } from '../src/features/branches/cash-schemas'
import type { MetodoPago } from '../src/features/pos/pagos'
import { conFiadoPorElSaldo, disponibilidadFiado, evaluarPagos, lineasConImporte, type LineaPago } from '../src/features/pos/pagos-ui'
import { METODOS_POS } from '../src/features/pos/metodos'
import { FichaCredito } from '../src/features/pos/components/FichaCredito'
import { lineasDeFilas, MAX_FILAS_PAGO, PanelPagos, quitarFiado, type FilaPago } from '../src/features/pos/components/PanelPagos'
import { ReciboEmitido } from '../src/features/pos/components/ReciboEmitido'
import { registerQuote, convertQuoteToSale } from '../src/features/pos/quote-service'
import { registerQuoteSchema, convertQuoteSchema } from '../src/features/pos/schemas'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * Fase 3, subpaso 4.2: las pantallas del POS con fiado y pago dividido, renderizadas AISLADAS (sin navegador).
 * Lo que más importa: el rótulo «Crédito» ya no es de la tarjeta, la mora avisa sin bloquear, el fiado no se ofrece donde no corresponde,
 * y lo que la pantalla arma es lo que el servidor cobra.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const msg = (f: () => unknown): string | null => { try { f(); return null } catch (e) { return (e as Error).message } }

async function negocio(tag: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const taxId = completarRuc(`20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`)
  const t = await prisma.tenant.create({ data: { slug: `pu-${tag}-${randomUUID().slice(0, 6)}`, name: `PosUi ${tag}`, legalName: `POSUI ${tag.toUpperCase()} SAC`, taxId, planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, provider: 'STRIPE', status: 'ACTIVE', externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, externalCustomerId: 'cus_cc' } })
  const b1 = await crearSucursalConAlmacen(t.id)
  const mk = async (role: Role) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role}-${randomUUID()}@x.com`.toLowerCase(), name: role, role } })
    await asignarSucursal(t.id, u.id, b1.branch.id)
    return u
  }
  const owner = await mk('OWNER')
  const O: TenantContext = { tenantId: t.id, userId: owner.id, role: 'OWNER', access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: [] }
  const db = getTenantPrisma(O)
  const prod = await prisma.product.create({ data: { tenantId: t.id, sku: 'P1', name: 'Producto', salePrice: 100 } })
  await prisma.stock.create({ data: { tenantId: t.id, productId: prod.id, warehouseId: b1.warehouse.id, quantity: 10000 } })
  let dni = 41400000
  const cliente = (over: Record<string, unknown> = {}) => prisma.customer.create({ data: { tenantId: t.id, name: `Cliente ${dni}`, docType: 'DNI', docNumber: String(dni++), creditLimit: 5000, ...over } })
  const vender = (monto: number, payments: { method: string; amount: number }[], customerId?: string) =>
    registerSale(db, O, { warehouseId: b1.warehouse.id, ...(customerId ? { customerId } : {}), items: [{ productId: prod.id, quantity: monto / 100, discount: 0 }], payments, documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() } as never)
  const abrir = (fondo: number) => openCashSession(db, O, openCashSchema.parse({ openingAmount: fondo }))
  const ctxDe = (u: { id: string }, role: Role, extra: TenantContext['permisosExtra'] = []): TenantContext =>
    ({ tenantId: t.id, userId: u.id, role, access: 'FULL', branchId: b1.branch.id, branchIds: [b1.branch.id], permisosExtra: extra })
  const almU = await mk('ALMACENERO'), cajU = await mk('CAJERO')
  return { t, b1, owner, O, db, prod, cliente, vender, abrir, Alm: ctxDe(almU, 'ALMACENERO'), Caj: ctxDe(cajU, 'CAJERO'), Caj2: ctxDe(cajU, 'CAJERO', ['credito.otorgar']) }
}



const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

async function main() {
  const fichaBase: InfoCreditoCliente = {
    customerId: 'c', nombre: 'Ana', limite: 500, deuda: 200, disponible: 300, plazoDias: 20, venceSiFia: '2026-11-14',
    bloqueado: false, documentoValido: true, vencido: 0, cuentasVencidas: 0, puedeFiar: true, motivo: null,
  }
  const F = (key: string, method: MetodoPago, texto = ''): FilaPago => ({ key, method, texto })
  const SI: Parameters<typeof PanelPagos>[0]['fiado'] = { ofrece: true, motivo: null }
  const noop = () => undefined
  const panel = (o: Partial<Parameters<typeof PanelPagos>[0]> & { filas: FilaPago[] }) => {
    const total = o.total ?? 100
    const filas = o.filas
    const estado = o.estado ?? evaluarPagos(total, lineasDeFilas(filas, total), { conCliente: true, documentType: 'NOTA_VENTA' })
    return html(createElement(PanelPagos, { total, onFilas: noop, estado, fiado: SI, ficha: fichaBase, onFiadoPorSaldo: noop, onCerrar: noop, ...o }))
  }

  console.log('\nA) El rótulo: «Crédito» ya no es de la tarjeta')
  const rotulos: string[] = METODOS_POS.map((m) => m.label)
  check('>>> la tarjeta se llama «T. crédito» y NINGÚN botón de método se llama solo «Crédito»', METODOS_POS.find((m) => m.value === 'TARJETA_CREDITO')!.label === 'T. crédito' && !rotulos.includes('Crédito'))
  check('el fiado (CREDITO) no es un método de la botonera: tiene su propio botón', !METODOS_POS.some((m) => (m.value as string) === 'CREDITO'))

  console.log('\nB) La ficha de crédito')
  const hOk = html(createElement(FichaCredito, { ficha: fichaBase }))
  check('>>> muestra línea 500, debe 200, disponible 300 y que vencería el 14/11/2026', hOk.includes('S/ 500.00') && hOk.includes('S/ 200.00') && hOk.includes('S/ 300.00') && hOk.includes('14/11/2026') && hOk.includes('data-ficha="ok"'))
  const hMora = html(createElement(FichaCredito, { ficha: { ...fichaBase, vencido: 120, cuentasVencidas: 2 } }))
  check('>>> deuda vencida: aviso NARANJA (clases de advertencia) con el monto y las cuentas, SIN el mensaje de "no se puede fiar"', hMora.includes('data-ficha="mora"') && hMora.includes('stock-low') && hMora.includes('S/ 120.00') && hMora.includes('2 cuentas') && !hMora.includes('data-ficha="no-fia"'))
  check('sin mora no hay aviso', !hOk.includes('data-ficha="mora"'))
  const hNo = html(createElement(FichaCredito, { ficha: { ...fichaBase, puedeFiar: false, motivo: 'El crédito de este cliente está bloqueado.' } }))
  check('>>> bloqueado: lo dice con el motivo del servidor y en rojo', hNo.includes('data-ficha="no-fia"') && hNo.includes('está bloqueado') && hNo.includes('stock-out'))
  check('sin línea: «Sin línea de crédito»', html(createElement(FichaCredito, { ficha: { ...fichaBase, limite: 0, disponible: 0, puedeFiar: false, motivo: 'Este cliente no tiene línea de crédito.' } })).includes('Sin línea de crédito'))
  check('cargando y fallo: se dice, no se inventa una ficha', html(createElement(FichaCredito, { ficha: null, cargando: true })).includes('Consultando') && html(createElement(FichaCredito, { ficha: null, falla: 'No pudimos consultar el crédito del cliente.' })).includes('No pudimos') && html(createElement(FichaCredito, { ficha: null })) === '')

  console.log('\nC) El panel de pago dividido')
  const hFalta = panel({ filas: [F('a', 'EFECTIVO', '40')] })
  check('>>> efectivo 40 sobre 100: «Falta cobrar S/ 60.00»', hFalta.includes('data-estado="falta"') && hFalta.includes('Falta cobrar S/ 60.00'))
  const hListo = panel({ filas: [F('a', 'YAPE', '50'), F('b', 'EFECTIVO', '60')] })
  check('>>> Yape 50 + efectivo 60: «Listo para cobrar · Vuelto S/ 10.00»', hListo.includes('data-estado="listo"') && hListo.includes('Vuelto S/ 10.00'))
  const hErr = panel({ filas: [F('a', 'YAPE', '120')] })
  check('>>> Yape de más: el panel muestra el MISMO error del servidor', hErr.includes('data-estado="error"') && hErr.includes('Solo el efectivo da vuelto'))
  const hFiado = panel({ filas: [F('a', 'EFECTIVO', '30'), F('b', 'CREDITO')] })
  check('>>> efectivo 30 + fila de fiado: la fila vale el SALDO (70) sin teclearlo y queda «Listo · Fiado S/ 70.00»', hFiado.includes('data-fila="fiado"') && hFiado.includes('S/ 70.00') && hFiado.includes('Fiado S/ 70.00') && hFiado.includes('data-estado="listo"'))
  check('>>> si cambia el total del carrito, el fiado se recalcula solo (no queda un monto viejo)', JSON.stringify(lineasDeFilas([F('a', 'EFECTIVO', '30'), F('b', 'CREDITO')], 100)) === JSON.stringify([{ method: 'EFECTIVO', amount: 30 }, { method: 'CREDITO', amount: 70 }]) && JSON.stringify(lineasDeFilas([F('a', 'EFECTIVO', '30'), F('b', 'CREDITO')], 130)) === JSON.stringify([{ method: 'EFECTIVO', amount: 30 }, { method: 'CREDITO', amount: 100 }]))
  check('el importe con coma decimal («12,50») se entiende', lineasDeFilas([F('a', 'EFECTIVO', '12,50')], 100)[0]!.amount === 12.5)
  check('>>> el botón «Fiado por el saldo» aparece SOLO si se ofrece; si no, la razón', panel({ filas: [F('a', 'EFECTIVO', '30')] }).includes('data-boton="fiado-saldo"') && !panel({ filas: [F('a', 'EFECTIVO', '30')], fiado: { ofrece: false, motivo: 'Asigna un cliente con DNI o RUC para poder fiar.' } }).includes('data-boton="fiado-saldo"') && panel({ filas: [F('a', 'EFECTIVO', '30')], fiado: { ofrece: false, motivo: 'Asigna un cliente con DNI o RUC para poder fiar.' } }).includes('Asigna un cliente'))
  check('>>> sin permiso (no se ofrece y sin motivo): ni botón ni texto', (() => { const h = panel({ filas: [F('a', 'EFECTIVO', '30')], fiado: { ofrece: false, motivo: null } }); return !h.includes('fiado-saldo') && !h.includes('data-fiado="no-ofrece"') })())
  check('>>> fiado que pasa la línea: aviso rojo con el texto del servidor («disponible S/ 300.00»)', panel({ total: 400, filas: [F('b', 'CREDITO')] }).includes('data-estado="linea"') && panel({ total: 400, filas: [F('b', 'CREDITO')] }).includes('disponible S/ 300.00 de S/ 500.00'))
  check('dentro de la línea no hay aviso de línea', !panel({ total: 250, filas: [F('b', 'CREDITO')] }).includes('data-estado="linea"'))
  const hMax = panel({ filas: Array.from({ length: 5 }, (_, i) => F(`f${i}`, 'EFECTIVO', '1')) })
  check('>>> el tope del panel es 5, el mismo del servidor (payments.max(5))', MAX_FILAS_PAGO === 5 && /payments: z\.array\(paymentLineSchema\)\.min\(1, 'Registra al menos un pago\.'\)\.max\(5\)/.test(readFileSync('src/features/pos/schemas.ts', 'utf8')))
  check('>>> con 5 líneas (el tope del servidor) ya no se ofrece «Agregar pago»; con 4 sí', !hMax.includes('+ Agregar pago') && panel({ filas: Array.from({ length: 4 }, (_, i) => F(`f${i}`, 'EFECTIVO', '1')) }).includes('+ Agregar pago'))
  check('«Quitar línea» solo cuando hay más de una', !panel({ filas: [F('a', 'EFECTIVO', '1')] }).includes('Quitar línea') && panel({ filas: [F('a', 'EFECTIVO', '1'), F('b', 'YAPE', '1')] }).includes('Quitar línea'))
  check('la botonera del panel usa los mismos rótulos (T. crédito) y no ofrece «Crédito» como método', panel({ filas: [F('a', 'EFECTIVO', '1')] }).includes('T. crédito') && !/<option[^>]*>Crédito</.test(panel({ filas: [F('a', 'EFECTIVO', '1')] })))

  const unaSola = [F('f', 'CREDITO')], mixta = [F('a', 'EFECTIVO', '30'), F('b', 'CREDITO')], sinFiado = [F('a', 'EFECTIVO', '30')]
  check('>>> quitar al cliente: la fila de fiado desaparece y NUNCA deja el panel vacío (si era la única, queda una fila de efectivo en blanco)',
    JSON.stringify(quitarFiado(mixta).map((x) => x.method)) === '["EFECTIVO"]' && quitarFiado(unaSola).length === 1 && quitarFiado(unaSola)[0]!.method === 'EFECTIVO' && quitarFiado(unaSola)[0]!.texto === '')
  check('sin fila de fiado devuelve la MISMA lista (no hay nada que cambiar)', quitarFiado(sinFiado) === sinFiado)

  console.log('\nD) El recibo')
  const base = { saleId: 's1', number: 'V001-00000007', total: 100 }
  const hSin = html(createElement(ReciboEmitido, { recibo: base, onCerrar: noop }))
  check('venta normal: sin línea de fiado y con el botón de Factura disponible', !hSin.includes('data-recibo="fiado"') && !/<button[^>]*disabled=""[^>]*>\s*Factura/.test(hSin) && hSin.includes('Factura'))
  const hFi = html(createElement(ReciboEmitido, { recibo: { ...base, credito: { monto: 70, vence: '2026-11-14', deudaCliente: 270 } }, onCerrar: noop }))
  check('>>> venta fiada: «Fiado S/ 70.00 · vence 14/11/2026 · deuda total S/ 270.00»', hFi.includes('data-recibo="fiado"') && hFi.includes('Fiado S/ 70.00 · vence 14/11/2026 · deuda total S/ 270.00'))
  check('>>> venta fiada: el botón Factura queda DESHABILITADO con el motivo a la vista; la Boleta no', /<button[^>]*disabled=""[^>]*>\s*Factura/.test(hFi.replace(/\n/g, ' ')) && hFi.includes('data-recibo="sin-factura"') && hFi.includes('emite boleta') && !/<button[^>]*disabled=""[^>]*>\s*Boleta/.test(hFi.replace(/\n/g, ' ')) )

  console.log('\nE) Lo que arma la pantalla es lo que cobra el servidor')
  const E = await negocio('a')
  const { O, db, cliente, vender, abrir } = E
  const A = await cliente({ creditLimit: 500 })
  await configurarCredito(db, O, configurarCreditoSchema.parse({ customerId: A.id, creditLimit: 500, creditTermDays: 20, bloqueado: false }))
  await abrir(0)
  const filas = [F('a', 'EFECTIVO', '30'), F('b', 'CREDITO')]
  const pagos = lineasConImporte(lineasDeFilas(filas, 100)).map((l) => ({ method: l.method, amount: l.amount }))
  const v = await vender(100, pagos, A.id)
  const venta = await registerSale(db, O, { warehouseId: E.b1.warehouse.id, customerId: A.id, items: [{ productId: E.prod.id, quantity: 0.5, discount: 0 }], payments: lineasConImporte(lineasDeFilas([F('a', 'EFECTIVO', '10'), F('b', 'CREDITO')], 50)), documentType: 'NOTA_VENTA', allowNegativeStock: false, idempotencyKey: randomUUID() } as never)
  check('>>> efectivo 30 + fiado por el saldo sobre 100: el servidor cobra, fía 70 y devuelve «credito» para el recibo', v.credito?.monto === 70 && v.credito.deudaCliente === 70)
  check('y el recibo, con ese resultado, dice lo mismo que la base', (venta as { credito?: { monto: number } }).credito?.monto === 40 && html(createElement(ReciboEmitido, { recibo: { saleId: v.saleId, number: v.number, total: v.total, credito: v.credito }, onCerrar: noop })).includes('deuda total S/ 70.00'))
  const act = readFileSync('src/features/pos/actions.ts', 'utf8')
  check('>>> la acción registerSale ENTREGA el fiado a la pantalla (credito en el resultado y en SaleReceipt)', /credito: \{ monto: number; vence: string; deudaCliente: number \} \| null/.test(act) && /credito: r\.credito,/.test(act))

  console.log('\nF) Pedidos de la cola: pago dividido sí, fiado no')
  const wh = E.b1.warehouse.id
  const q = (extra: Record<string, unknown> = {}) => registerQuoteSchema.parse({ warehouseId: wh, customerId: A.id, items: [{ productId: E.prod.id, quantity: 1, discount: 0 }], ...extra })
  const c1 = await registerQuote(db, O, q())
  const saleAntes = await prisma.sale.count({ where: { tenantId: E.t.id } })
  const rechazo = await convertQuoteToSale(db, O, convertQuoteSchema.parse({ quoteId: c1.quoteId, payments: [{ method: 'CREDITO', amount: 100 }], documentType: 'NOTA_VENTA' })).then(() => null).catch((e) => e)
  check('>>> cobrar un pedido con una línea de FIADO → rechazado con el motivo (se cobra desde el POS), sin crear venta', rechazo?.code === 'INVALID_DOCUMENT' && /POS/.test(rechazo.message) && (await prisma.sale.count({ where: { tenantId: E.t.id } })) === saleAntes)
  const dividido = await convertQuoteToSale(db, O, convertQuoteSchema.parse({ quoteId: c1.quoteId, payments: [{ method: 'EFECTIVO', amount: 60 }, { method: 'YAPE', amount: 40 }], documentType: 'NOTA_VENTA' }))
  check('>>> el MISMO pedido se cobra bien con pago dividido (efectivo 60 + Yape 40)', !!dividido.saleId && (await prisma.payment.count({ where: { saleId: dividido.saleId } })) === 2)

  console.log('\nG) Estructura de la terminal')
  const pos = readFileSync('src/features/pos/components/PosTerminal.tsx', 'utf8')
  const pg = readFileSync('src/app/(dashboard)/pos/page.tsx', 'utf8')
  check('>>> la terminal usa la botonera compartida (sin lista propia con «Crédito») y las piezas nuevas', pos.includes("from '../metodos'") && !/label: 'Crédito'/.test(pos) && pos.includes('<PanelPagos') && pos.includes('<FichaCredito') && pos.includes("from './ReciboEmitido'"))
  check('>>> la página decide con el permiso del servidor: puedeFiar = credito.otorgar', /puedeFiar=\{puede\(ctx, 'credito\.otorgar'\)\}/.test(pg))
  check('>>> la ficha solo se consulta y se muestra a quien puede fiar, y una respuesta vieja no pisa al cliente nuevo', pos.includes('cliente && puedeFiar') && /if \(!clienteId \|\| !puedeFiar\) return/.test(pos) && pos.includes('esVigente()'))
  check('>>> el fiado NO se ofrece desde un pedido (enPedido) y a la cola nunca se le manda una línea CREDITO', pos.includes('enPedido: !!pedido') && /pagos\.filter\(\(l\) => l\.method !== 'CREDITO'\)/.test(pos))
  check('>>> al quitar al cliente se limpia el fiado con quitarFiado, y el refresco tras un rechazo solo vale si el cajero sigue con ese cliente', /setFilas\(quitarFiado\)/.test(pos) && /cargarFicha\(clienteId, \(\) => clienteRef\.current === clienteId\)/.test(pos))
  check('>>> con pago dividido el botón Cobrar espera a «LISTO» y el cobro lo vuelve a comprobar', /\(dividir && estadoPagos\.estado !== 'LISTO'\)/.test(pos) && /if \(dividir && estadoPagos\.estado !== 'LISTO'\)/.test(pos))
  check('la clave de idempotencia se reutiliza al dividir (un reintento no cobra dos veces)', pos.includes('idemRef.current ??= crypto.randomUUID()') && !/setDividir[^\n]*idemRef/.test(pos))
  check('si el servidor rechaza por crédito, se refresca la ficha', /res\.code\.startsWith\('CREDIT_'\)/.test(pos))

  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}
correr(main)
