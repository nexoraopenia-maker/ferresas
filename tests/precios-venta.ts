import './guard'
import { correr } from './teardown'
import { crearSucursal, asignarSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { resolveTenantContext } from '../src/lib/session'
import { registerSale } from '../src/features/pos/sale-service'
import { convertQuoteToSale, registerQuote } from '../src/features/pos/quote-service'
import { cobrarPedido, crearPedido, tomarPedido } from '../src/features/pos/pedido-service'
import { convertQuoteSchema, registerQuoteSchema, registerSaleSchema } from '../src/features/pos/schemas'
import { asignarListaACliente, crearLista, darDeBajaLista, guardarPrecios } from '../src/features/precios/service'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.7b · La integración del motor en la venta, la cotización y el pedido, contra la base: la lista elegida o la del cliente, el volumen por cantidad base, las presentaciones, los
 * precios congelados, la trazabilidad y, sobre todo, el piso de margen: `BELOW_COST` sin ninguna cifra de costo, la excepción auditada con `ventas.bajo_costo` y que un negocio sin
 * listas se comporta EXACTAMENTE como antes.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))
const fallo = (p: Promise<unknown>) => p.then(() => null).catch((e) => e as { code?: string; message: string; details?: Record<string, unknown> })

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `pv-${randomUUID().slice(0, 8)}`, name: 'Precios venta', planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' } })
  const bA = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const wA = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WA', name: 'A', isDefault: true } })
  const mk = async (role: Role, tag: string) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${tag}-${randomUUID()}@x.com`.toLowerCase(), name: tag, role } })
    await asignarSucursal(t.id, u.id, bA.id)
    return u
  }
  const owner = await mk('OWNER', 'dueno'), admin = await mk('ADMIN', 'admin'), cajero = await mk('CAJERO', 'cajero'), vend = await mk('VENDEDOR', 'vendedor')
  const g = (c: TenantContext) => getTenantPrisma(c)
  const ctx = (u: { id: string }) => resolveTenantContext(u.id)
  let cOwner = await ctx(owner), cAdmin = await ctx(admin), cCajero = await ctx(cajero), cVend = await ctx(vend)

  // Productos. El costo es un número reconocible (37.4321) para comprobar que NUNCA aparece en un mensaje.
  const prod = (sku: string, data: Record<string, unknown>) => prisma.product.create({ data: { tenantId: t.id, sku, name: sku, ...data } as never })
  const pCinta = await prod('CINTA', { salePrice: 3.5, costPrice: 2 })
  const pCaro = await prod('CARO', { salePrice: 100, costPrice: 37.4321 })
  const pSrv = await prod('SERV', { salePrice: 30, costPrice: 0, trackStock: false })
  const pSinCosto = await prod('SINCOSTO', { salePrice: 10, costPrice: 0 })
  const pCaja = await prod('TORNILLO', { salePrice: 1, costPrice: 0.5 })
  for (const p of [pCinta, pCaro, pSinCosto, pCaja]) await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: wA.id, quantity: 100000 } })
  const caja50 = await prisma.productPresentation.create({ data: { tenantId: t.id, productId: pCaja.id, name: 'Caja 50', unitType: 'UNIDAD', factor: 50, salePrice: 45 } })

  const venta = (c: TenantContext, items: { productId: string; quantity: number; discount?: number; presentationId?: string; enteredQuantity?: string }[], pago: number, extra: Record<string, unknown> = {}) =>
    registerSale(g(c), c, registerSaleSchema.parse({
      warehouseId: wA.id, items: items.map((i) => ({ discount: 0, ...i })), payments: [{ method: 'EFECTIVO', amount: pago }], idempotencyKey: randomUUID(), ...extra,
    }))
  const lineas = (saleId: string) => prisma.saleItem.findMany({ where: { saleId }, orderBy: { createdAt: 'asc' } })

  console.log('\n1) Sin listas todo es EXACTAMENTE como antes')
  const v0 = await venta(cCajero, [{ productId: pCinta.id, quantity: 4 }], 14)
  const l0 = (await lineas(v0.saleId))[0]!
  const s0 = await prisma.sale.findUniqueOrThrow({ where: { id: v0.saleId } })
  check('>>> el precio es el de siempre (3.50 × 4 = 14.00), la fuente es BASE y la venta no lleva lista', Number(l0.unitPrice) === 3.5 && Number(l0.lineTotal) === 14 && l0.priceSource === 'BASE' && l0.tierMinQuantity === null && s0.priceListId === null)
  check('>>> el costo congelado sigue siendo el promedio (2.00)', Number(l0.unitCost) === 2)

  // Listas: Mayorista (3.10 plano, desde 12 → 2.90) ; Base con tramo desde 100 → 3.20
  const mayo = await crearLista(g(cOwner), cOwner, { name: 'Mayorista' })
  const constr = await crearLista(g(cOwner), cOwner, { name: 'Constructor' })
  await guardarPrecios(g(cOwner), cOwner, { priceListId: mayo.id, cambios: [{ productId: pCinta.id, price: 3.1, tiers: [{ minQuantity: 12, unitPrice: 2.9 }] }, { productId: pCaja.id, price: 0.9 }] })
  await guardarPrecios(g(cOwner), cOwner, { priceListId: null, cambios: [{ productId: pCinta.id, tiers: [{ minQuantity: 100, unitPrice: 3.2 }] }] })

  console.log('\n2) La lista elegida y el volumen')
  const vM5 = await venta(cCajero, [{ productId: pCinta.id, quantity: 5 }], 15.5, { priceListId: mayo.id })
  const lM5 = (await lineas(vM5.saleId))[0]!
  check('>>> Mayorista, 5 u → 3.10 (LISTA); la venta guarda la lista', Number(lM5.unitPrice) === 3.1 && lM5.priceSource === 'LISTA' && (await prisma.sale.findUniqueOrThrow({ where: { id: vM5.saleId } })).priceListId === mayo.id && vM5.total === 15.5)
  const vM12 = await venta(cCajero, [{ productId: pCinta.id, quantity: 12 }], 34.8, { priceListId: mayo.id })
  const lM12 = (await lineas(vM12.saleId))[0]!
  check('>>> Mayorista, 12 u → 2.90 (VOLUMEN) y guarda el tramo aplicado (12)', Number(lM12.unitPrice) === 2.9 && lM12.priceSource === 'VOLUMEN' && Number(lM12.tierMinQuantity) === 12 && vM12.total === 34.8)
  const vB120 = await venta(cCajero, [{ productId: pCinta.id, quantity: 120 }], 384)
  check('>>> Base, 120 u → 3.20 (tramo Base, VOLUMEN)', Number((await lineas(vB120.saleId))[0]!.unitPrice) === 3.2 && vB120.total === 384)
  const vC = await venta(cCajero, [{ productId: pCinta.id, quantity: 120 }], 384, { priceListId: constr.id })
  check('>>> >>> una lista SIN entrada para el producto (Constructor) hereda la Base completa, tramo incluido', Number((await lineas(vC.saleId))[0]!.unitPrice) === 3.2 && vC.total === 384)
  const vMix = await venta(cCajero, [{ productId: pCinta.id, quantity: 12 }, { productId: pCaro.id, quantity: 1 }], 134.8, { priceListId: mayo.id })
  const lMix = await lineas(vMix.saleId)
  check('>>> en la misma venta: lo que la lista tiene usa la lista; lo que no, el precio Base', Number(lMix.find((l) => l.productId === pCinta.id)!.unitPrice) === 2.9 && Number(lMix.find((l) => l.productId === pCaro.id)!.unitPrice) === 100 && lMix.find((l) => l.productId === pCaro.id)!.priceSource === 'BASE')
  check('>>> el total cuadra por línea: Σ lineTotal = subtotal + IGV = total', (() => { const sum = lMix.reduce((s, l) => s + Number(l.lineTotal), 0); return Math.abs(sum - vMix.total) < 0.005 && Math.abs(vMix.subtotal + vMix.taxTotal - vMix.total) < 0.005 })())
  check('>>> el servidor ignora el precio que mande el carrito: no hay campo de precio en la entrada', !('unitPrice' in registerSaleSchema.shape) && !JSON.stringify(registerSaleSchema.shape.items.element.shape).includes('unitPrice'))
  const vCant = await venta(cCajero, [{ productId: pCinta.id, quantity: 11.9999 }], 37.2, { priceListId: mayo.id }).catch(() => null)
  check('>>> el borde del tramo se mide en cantidad BASE exacta (11.9999 → plano 3.10)', vCant ? Number((await lineas(vCant.saleId))[0]!.unitPrice) === 3.1 : false)

  console.log('\n3) La lista por defecto del cliente')
  const cli = await prisma.customer.create({ data: { tenantId: t.id, name: 'Constructora Sur' } })
  await asignarListaACliente(g(cOwner), cOwner, { customerId: cli.id, priceListId: mayo.id })
  const vCli = await venta(cCajero, [{ productId: pCinta.id, quantity: 5 }], 15.5, { customerId: cli.id })
  check('>>> >>> sin priceListId, se aplica la lista del cliente (Mayorista: 3.10) y la venta la guarda', Number((await lineas(vCli.saleId))[0]!.unitPrice) === 3.1 && (await prisma.sale.findUniqueOrThrow({ where: { id: vCli.saleId } })).priceListId === mayo.id)
  const vCliBase = await venta(cCajero, [{ productId: pCinta.id, quantity: 5 }], 17.5, { customerId: cli.id, priceListId: null })
  check('>>> >>> priceListId null es Base A PROPÓSITO aunque el cliente tenga lista (3.50)', Number((await lineas(vCliBase.saleId))[0]!.unitPrice) === 3.5 && (await prisma.sale.findUniqueOrThrow({ where: { id: vCliBase.saleId } })).priceListId === null)
  const vCliOtra = await venta(cCajero, [{ productId: pCinta.id, quantity: 120 }], 384, { customerId: cli.id, priceListId: constr.id })
  check('>>> una lista elegida a mano gana a la del cliente', Number((await lineas(vCliOtra.saleId))[0]!.unitPrice) === 3.2)
  const vSinCli = await venta(cCajero, [{ productId: pCinta.id, quantity: 5 }], 17.5)
  check('>>> sin cliente no hay lista por defecto', Number((await lineas(vSinCli.saleId))[0]!.unitPrice) === 3.5)

  console.log('\n4) Una lista que ya no existe NO bloquea la venta')
  const vieja = await crearLista(g(cOwner), cOwner, { name: 'Vieja' })
  await guardarPrecios(g(cOwner), cOwner, { priceListId: vieja.id, cambios: [{ productId: pCinta.id, price: 1 }] })
  await darDeBajaLista(g(cOwner), cOwner, { priceListId: vieja.id })
  const vBaja = await venta(cCajero, [{ productId: pCinta.id, quantity: 5 }], 17.5, { priceListId: vieja.id })
  check('>>> se vende a precio Base y la venta queda sin lista', Number((await lineas(vBaja.saleId))[0]!.unitPrice) === 3.5 && (await prisma.sale.findUniqueOrThrow({ where: { id: vBaja.saleId } })).priceListId === null)
  const cliBaja = await prisma.customer.create({ data: { tenantId: t.id, name: 'Cliente con lista vieja', priceListId: vieja.id } })
  check('>>> igual con la lista dada de baja de un cliente', Number((await lineas((await venta(cCajero, [{ productId: pCinta.id, quantity: 5 }], 17.5, { customerId: cliBaja.id })).saleId))[0]!.unitPrice) === 3.5)
  check('>>> una lista de OTRO negocio tampoco se aplica (ni da error)', await code(venta(cCajero, [{ productId: pCinta.id, quantity: 5 }], 17.5, { priceListId: 'lista-ajena' })) === null)

  console.log('\n5) Presentaciones')
  const vCajaBase = await venta(cCajero, [{ productId: pCaja.id, quantity: 100, presentationId: caja50.id, enteredQuantity: '2' }], 90)
  const lCajaBase = (await lineas(vCajaBase.saleId))[0]!
  check('>>> en Base con precio propio de la caja (45) se respeta: 2 cajas = 90, fuente BASE', vCajaBase.total === 90 && lCajaBase.priceSource === 'BASE' && Number(lCajaBase.presentationFactor) === 50)
  const vCajaLista = await venta(cCajero, [{ productId: pCaja.id, quantity: 100, presentationId: caja50.id, enteredQuantity: '2' }], 90, { priceListId: mayo.id })
  const lCajaLista = (await lineas(vCajaLista.saleId))[0]!
  check('>>> >>> con lista, la caja se cobra por unidad base × factor (0.90 × 100 = 90) y el precio propio se ignora', Number(lCajaLista.unitPrice) === 0.9 && lCajaLista.priceSource === 'LISTA' && vCajaLista.total === 90 && lCajaLista.presentationName === 'Caja 50')
  await guardarPrecios(g(cOwner), cOwner, { priceListId: constr.id, cambios: [{ productId: pCaja.id, price: 1, tiers: [{ minQuantity: 50, unitPrice: 0.8 }] }] })
  const vCajaTramo = await venta(cCajero, [{ productId: pCaja.id, quantity: 50, presentationId: caja50.id, enteredQuantity: '1' }], 40, { priceListId: constr.id })
  const lCajaTramo = (await lineas(vCajaTramo.saleId))[0]!
  check('>>> >>> UNA caja de 50 se evalúa como 50 unidades base contra los tramos (desde 50 → 0.80): 40.00', Number(lCajaTramo.unitPrice) === 0.8 && lCajaTramo.priceSource === 'VOLUMEN' && Number(lCajaTramo.tierMinQuantity) === 50 && vCajaTramo.total === 40)

  console.log('\n6) El descuento manual aplica sobre el NUEVO precio')
  await prisma.discountCap.create({ data: { tenantId: t.id, role: 'CAJERO', maxPercent: 10 } }).catch(() => null)
  cCajero = await ctx(cajero)
  const vDesc = await venta(cAdmin, [{ productId: pCinta.id, quantity: 12, discount: 3.48 }], 31.32, { priceListId: mayo.id })
  check('>>> 10 % de 34.80 (12 × 2.90) = 3.48: el bruto es el de la lista, no el Base (42.00)', vDesc.discountTotal === 3.48 && vDesc.total === 31.32)
  check('>>> y un descuento que supera el importe NUEVO de la línea se rechaza (no el Base)', await code(venta(cAdmin, [{ productId: pCinta.id, quantity: 12, discount: 40 }], 1, { priceListId: mayo.id })) === 'INSUFFICIENT_STOCK')

  console.log('\n7) El piso de margen: BELOW_COST')
  // CARO: costo 37.4321 sin IGV → con IGV 44.1699. Se vende a 100: sobra margen.
  await guardarPrecios(g(cOwner), cOwner, { priceListId: mayo.id, cambios: [{ productId: pCaro.id, price: 40 }] })     // 40 con IGV = 33.90 sin IGV < 37.43
  const stockAntes = Number((await prisma.stock.findFirstOrThrow({ where: { productId: pCaro.id } })).quantity)
  const ventasAntes = await prisma.sale.count({ where: { tenantId: t.id } })
  const e1 = await fallo(venta(cCajero, [{ productId: pCaro.id, quantity: 1 }], 40, { priceListId: mayo.id }))
  check('>>> el cajero NO puede vender bajo el costo: BELOW_COST', e1?.code === 'BELOW_COST')
  const rastro = JSON.stringify([e1?.message, e1?.details, e1])
  check('>>> >>> el mensaje NO revela el costo (ni 37.43, ni 44.17, ni el margen) ni sus dígitos', !/37[.,]4|44[.,]1|37\.4321|4321/.test(rastro), rastro.slice(0, 200))
  check('>>> el mensaje solo nombra el producto y dice qué hacer', /«CARO» quedaría por debajo del costo/.test(e1?.message ?? '') && JSON.stringify(e1?.details) === JSON.stringify({ producto: 'CARO', lineas: 1 }))
  check('>>> >>> una venta rechazada no deja nada: ni venta, ni stock movido, ni correlativo quemado', (await prisma.sale.count({ where: { tenantId: t.id } })) === ventasAntes && Number((await prisma.stock.findFirstOrThrow({ where: { productId: pCaro.id } })).quantity) === stockAntes)
  const vOk = await venta(cCajero, [{ productId: pCinta.id, quantity: 1 }], 3.5)
  check('>>> el correlativo siguiente no tiene hueco', Number(vOk.number.split('-')[1]) === Number((await prisma.sale.findFirstOrThrow({ where: { tenantId: t.id }, orderBy: { createdAt: 'desc' }, skip: 1 })).number.split('-')[1]) + 1)
  const vAdm = await venta(cAdmin, [{ productId: pCaro.id, quantity: 1 }], 40, { priceListId: mayo.id })
  const audBajo = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: t.id, action: 'sale.below_cost', entityId: vAdm.saleId } })
  check('>>> >>> con ventas.bajo_costo (administrador) se vende, y queda auditado: qué producto y a qué importe', Number((await lineas(vAdm.saleId))[0]!.unitPrice) === 40 && JSON.stringify(audBajo.after).includes('CARO') && JSON.stringify(audBajo.after).includes('40'))
  check('>>> y la auditoría NO guarda el costo', !/37[.,]4|4321|costPrice|unitCost|costo/i.test(JSON.stringify(audBajo.after)))
  check('>>> el dueño también puede', await code(venta(cOwner, [{ productId: pCaro.id, quantity: 1 }], 40, { priceListId: mayo.id })) === null)
  check('>>> una venta normal no deja marca de bajo costo', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'sale.below_cost', entityId: vOk.saleId } })) === 0)

  console.log('\n8) Bordes del piso')
  // Exactamente al costo: 37.4321 × 1.18 = 44.1699 con IGV; el precio se redondea a 44.17 (neto 37.43 ≥ 37.4321 con la tolerancia de medio céntimo).
  await guardarPrecios(g(cOwner), cOwner, { priceListId: mayo.id, cambios: [{ productId: pCaro.id, price: 44.17 }] })
  check('>>> exactamente al costo (44.17 con IGV ≈ 37.43 sin IGV) cumple: el redondeo a céntimos no lo rechaza', await code(venta(cCajero, [{ productId: pCaro.id, quantity: 1 }], 44.17, { priceListId: mayo.id })) === null)
  await guardarPrecios(g(cOwner), cOwner, { priceListId: mayo.id, cambios: [{ productId: pCaro.id, price: 44 }] })
  check('>>> un poco bajo el costo (44.00 → 37.29 sin IGV) NO cumple', await code(venta(cCajero, [{ productId: pCaro.id, quantity: 1 }], 44, { priceListId: mayo.id })) === 'BELOW_COST')
  const cCajeroDesc: TenantContext = { ...cCajero, permisosExtra: ['ventas.descuento'], topesDescuento: { CAJERO: 60 } }
  check('>>> un descuento manual dentro de su tope que deja el precio sobre el costo pasa (100 − 40 = 60 con IGV)', await code(venta(cCajeroDesc, [{ productId: pCaro.id, quantity: 1, discount: 40 }], 60)) === null)
  check('>>> >>> un descuento manual DENTRO del tope del cajero pero que hunde la línea bajo el costo se bloquea (100 − 60 = 40 < 44.17)', await code(venta(cCajeroDesc, [{ productId: pCaro.id, quantity: 1, discount: 60 }], 40)) === 'BELOW_COST')
  check('>>> y el administrador sí puede darlo (tiene ventas.bajo_costo)', await code(venta(cAdmin, [{ productId: pCaro.id, quantity: 1, discount: 60 }], 40)) === null)
  check('>>> costo 0 (sin costo conocido): el piso no aplica', await code(venta(cCajero, [{ productId: pSinCosto.id, quantity: 1 }], 10)) === null)
  check('>>> un servicio (costo 0) tampoco', await code(venta(cCajero, [{ productId: pSrv.id, quantity: 1 }], 30)) === null)
  check('>>> el piso mira la CANTIDAD: 10 unidades a 44.00 no cumplen', await code(venta(cCajero, [{ productId: pCaro.id, quantity: 10 }], 440, { priceListId: mayo.id })) === 'BELOW_COST')
  await guardarPrecios(g(cOwner), cOwner, { priceListId: mayo.id, cambios: [{ productId: pCaro.id, price: 44.17 }] })
  check('>>> y a 44.17 sí cumplen', await code(venta(cCajero, [{ productId: pCaro.id, quantity: 10 }], 441.7, { priceListId: mayo.id })) === null)
  await guardarPrecios(g(cOwner), cOwner, { priceListId: mayo.id, cambios: [{ productId: pCaro.id, price: 44 }] })
  const e2 = await fallo(venta(cCajero, [{ productId: pCaro.id, quantity: 2 }, { productId: pCinta.id, quantity: 1 }], 91, { priceListId: mayo.id }))
  check('>>> si fallan varias líneas, el mensaje las nombra todas (hasta 3) y sigue sin cifras de costo', e2?.code === 'BELOW_COST' && /«CARO»/.test(e2.message) && !/37[.,]4|44[.,]1/.test(e2.message))
  const vFiado = await prisma.customer.create({ data: { tenantId: t.id, name: 'Cliente fiado', docType: 'RUC', docNumber: '20123456786' } })
  check('>>> el piso también rige para ventas con cliente', await code(venta(cCajero, [{ productId: pCaro.id, quantity: 1 }], 44, { priceListId: mayo.id, customerId: vFiado.id })) === 'BELOW_COST')

  console.log('\n9) Cotizaciones y pedidos')
  await guardarPrecios(g(cOwner), cOwner, { priceListId: mayo.id, cambios: [{ productId: pCaro.id, price: 90 }] })
  const cotiz = await registerQuote(g(cVend), cVend, registerQuoteSchema.parse({ warehouseId: wA.id, items: [{ productId: pCinta.id, quantity: 12 }], priceListId: mayo.id }))
  const qItem = await prisma.quoteItem.findFirstOrThrow({ where: { quoteId: cotiz.quoteId } })
  check('>>> la cotización congela el precio de la lista y el volumen (2.90) y guarda la lista', Number(qItem.unitPrice) === 2.9 && cotiz.total === 34.8 && (await prisma.quote.findUniqueOrThrow({ where: { id: cotiz.quoteId } })).priceListId === mayo.id)
  const cotizCli = await registerQuote(g(cVend), cVend, registerQuoteSchema.parse({ warehouseId: wA.id, customerId: cli.id, items: [{ productId: pCinta.id, quantity: 5 }] }))
  check('>>> sin priceListId la cotización toma la lista del cliente (3.10)', cotizCli.total === 15.5 && (await prisma.quote.findUniqueOrThrow({ where: { id: cotizCli.quoteId } })).priceListId === mayo.id)
  const eq = await fallo(registerQuote(g(cVend), cVend, registerQuoteSchema.parse({ warehouseId: wA.id, items: [{ productId: pCaro.id, quantity: 1 }], priceListId: constr.id })))
  check('>>> el piso también al cotizar: Constructor sin entrada hereda Base (100): cumple', eq === null)
  await guardarPrecios(g(cOwner), cOwner, { priceListId: constr.id, cambios: [{ productId: pCaro.id, price: 30 }] })
  const eq2 = await fallo(registerQuote(g(cVend), cVend, registerQuoteSchema.parse({ warehouseId: wA.id, items: [{ productId: pCaro.id, quantity: 1 }], priceListId: constr.id })))
  check('>>> y un precio de lista bajo el costo no se puede cotizar sin ventas.bajo_costo (sin cifras)', eq2?.code === 'BELOW_COST' && !/37[.,]4|44[.,]1/.test(JSON.stringify(eq2)))
  check('>>> el administrador sí puede cotizar bajo el costo', await code(registerQuote(g(cAdmin), cAdmin, registerQuoteSchema.parse({ warehouseId: wA.id, items: [{ productId: pCaro.id, quantity: 1 }], priceListId: constr.id }))) === null)
  // Antes de cobrar, la lista BAJA el precio del tramo a 2.50: lo cotizado (2.90) es lo que vale.
  await guardarPrecios(g(cOwner), cOwner, { priceListId: mayo.id, cambios: [{ productId: pCinta.id, tiers: [{ minQuantity: 12, unitPrice: 2.5 }] }] })
  const conv = await convertQuoteToSale(g(cCajero), cCajero, convertQuoteSchema.parse({ quoteId: cotiz.quoteId, payments: [{ method: 'EFECTIVO', amount: 34.8 }], idempotencyKey: randomUUID() }))
  const lConv = (await lineas(conv.saleId))[0]!
  check('>>> >>> convertir la cotización cobra el precio CONGELADO (2.90), no el de hoy, y la venta hereda la lista', Number(lConv.unitPrice) === 2.9 && conv.total === 34.8 && (await prisma.sale.findUniqueOrThrow({ where: { id: conv.saleId } })).priceListId === mayo.id && lConv.priceSource === null)
  await guardarPrecios(g(cOwner), cOwner, { priceListId: mayo.id, cambios: [{ productId: pCinta.id, tiers: [{ minQuantity: 12, unitPrice: 2.9 }] }] })
  // Una cotización con precio congelado sana, y luego el costo SUBE por encima del precio congelado: al convertir se vuelve a comprobar.
  const cotCara = await registerQuote(g(cAdmin), cAdmin, registerQuoteSchema.parse({ warehouseId: wA.id, items: [{ productId: pCaro.id, quantity: 1 }], priceListId: constr.id }))
  const e3 = await fallo(convertQuoteToSale(g(cCajero), cCajero, convertQuoteSchema.parse({ quoteId: cotCara.quoteId, payments: [{ method: 'EFECTIVO', amount: 30 }], idempotencyKey: randomUUID() })))
  check('>>> >>> al convertir se vuelve a comprobar el piso con el costo de HOY aunque el precio esté congelado', e3?.code === 'BELOW_COST')
  const conv2 = await convertQuoteToSale(g(cAdmin), cAdmin, convertQuoteSchema.parse({ quoteId: cotCara.quoteId, payments: [{ method: 'EFECTIVO', amount: 30 }], idempotencyKey: randomUUID() }))
  check('>>> y quien tiene ventas.bajo_costo sí la convierte (queda auditada)', (await prisma.auditLog.count({ where: { tenantId: t.id, action: 'sale.below_cost', entityId: conv2.saleId } })) === 1)
  const ped = await crearPedido(g(cVend), cVend, registerQuoteSchema.parse({ warehouseId: wA.id, items: [{ productId: pCinta.id, quantity: 12 }], priceListId: mayo.id }))
  await tomarPedido(g(cCajero), cCajero, ped.quoteId)
  const cobro = await cobrarPedido(g(cCajero), cCajero, convertQuoteSchema.parse({ quoteId: ped.quoteId, payments: [{ method: 'EFECTIVO', amount: 34.8 }], idempotencyKey: randomUUID() }))
  check('>>> un pedido armado con una lista se cobra al precio de esa lista (34.80)', cobro.total === 34.8)
  const pedBajo = await fallo(crearPedido(g(cVend), cVend, registerQuoteSchema.parse({ warehouseId: wA.id, items: [{ productId: pCaro.id, quantity: 1 }], priceListId: constr.id })))
  check('>>> el vendedor tampoco arma un pedido bajo el costo', pedBajo?.code === 'BELOW_COST')

  console.log('\n10) Idempotencia y concurrencia de la lista')
  const clave = randomUUID()
  const r1 = await venta(cCajero, [{ productId: pCinta.id, quantity: 12 }], 34.8, { priceListId: mayo.id, idempotencyKey: clave })
  const r2 = await venta(cCajero, [{ productId: pCinta.id, quantity: 12 }], 34.8, { priceListId: mayo.id, idempotencyKey: clave })
  check('>>> el reintento con la misma clave devuelve la misma venta (no cobra dos veces)', r2.replayed === true && r2.saleId === r1.saleId)

  await prisma.tenant.delete({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

// Una excepción que nadie esperaba cuenta como fallo (✗), no como un aborto sin veredicto.
async function main() {
  try { return await cuerpo() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? e.message.slice(0, 160) : e}`, false); return 1 }
}

correr(main)
