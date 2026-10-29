import './guard'
import { correr } from './teardown'
import { crearSucursal, asignarSucursal } from './fixtures'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { getTenantPrisma } from '../src/lib/tenant-prisma'
import { resolveTenantContext } from '../src/lib/session'
import { registerSale } from '../src/features/pos/sale-service'
import { registerSaleSchema } from '../src/features/pos/schemas'
import { brutoDe, descuentoDe, itemDe, precioDe, type LineaCarrito } from '../src/features/pos/carrito'
import { cargarDatosDePrecio, crearLista, guardarPrecios } from '../src/features/precios/service'
import { redondearCentimos as cent } from '../src/lib/dinero'
import type { PosProduct } from '../src/features/pos/actions'
import type { Role } from '../src/generated/prisma/enums'
import type { TenantContext } from '../src/lib/tenant-context'

/**
 * F6.7c · «Lo que el cajero ve es lo que el servidor cobra». Genera cientos de carritos al azar (precios con 2 a 4 decimales, listas con plano y tramos, tramos de la Base, presentaciones
 * con y sin precio propio, cantidades fraccionarias, descuentos en %) y compara el total que calcula el CARRITO del navegador (las mismas funciones puras que usa el POS) con el que
 * calcula `registerSale`. Cada venta se manda con `totalEsperado` = el del carrito: si el servidor calculara otro, rechazaría con `PRICE_CHANGED`. Después comprueba ese rechazo.
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`) }
const code = (p: Promise<unknown>) => p.then(() => null).catch((e) => e.code ?? e.name ?? String(e))

/** PRNG determinista (mulberry32): una falla se reproduce con la misma semilla. */
function prng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

async function cuerpo() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } })
  const t = await prisma.tenant.create({ data: { slug: `pu-${randomUUID().slice(0, 8)}`, name: 'Precios unificado', planId: plan.id } })
  await prisma.subscription.create({ data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE' } })
  const bA = await crearSucursal(t.id, { code: 'NORTE', seriesNumber: 1, isDefault: true })
  const wA = await prisma.warehouse.create({ data: { tenantId: t.id, branchId: bA.id, code: 'WA', name: 'A', isDefault: true } })
  const mk = async (role: Role, tag: string) => {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${tag}-${randomUUID()}@x.com`.toLowerCase(), name: tag, role } })
    await asignarSucursal(t.id, u.id, bA.id)
    return u
  }
  const owner = await mk('OWNER', 'dueno')
  const cOwner: TenantContext = await resolveTenantContext(owner.id)
  const db = getTenantPrisma(cOwner)

  const rnd = prng(20261128)
  const entre = (a: number, b: number, dec = 2) => Math.round((a + rnd() * (b - a)) * 10 ** dec) / 10 ** dec
  const elige = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!

  // 12 productos, 3 listas, tramos en la Base y en las listas, 4 con presentación (la mitad con precio propio).
  const listas = await Promise.all(['Mayorista', 'Constructor', 'Instalador'].map((name) => crearLista(db, cOwner, { name })))
  const productos: { id: string; precio: number; unitType: 'UNIDAD' | 'KILOGRAMO'; caja?: { id: string; factor: number; propio: number | null } }[] = []
  for (let i = 0; i < 12; i++) {
    const kilos = i % 4 === 3
    const precio = entre(0.5, 80, i % 3 === 0 ? 4 : 2)
    const p = await prisma.product.create({ data: { tenantId: t.id, sku: `U${i}`, name: `Producto ${i}`, salePrice: precio, costPrice: 0, unitType: kilos ? 'KILOGRAMO' : 'UNIDAD' } })
    await prisma.stock.create({ data: { tenantId: t.id, productId: p.id, warehouseId: wA.id, quantity: 1e7 } })
    const fila: (typeof productos)[number] = { id: p.id, precio, unitType: kilos ? 'KILOGRAMO' : 'UNIDAD' }
    if (i % 3 === 0 && !kilos) {
      const factor = elige([6, 12, 24, 50])
      const propio = i % 6 === 0 ? Math.round(precio * factor * 0.9 * 100) / 100 : null
      const pr = await prisma.productPresentation.create({ data: { tenantId: t.id, productId: p.id, name: `Caja ${factor}`, unitType: 'UNIDAD', factor, ...(propio !== null ? { salePrice: propio } : {}) } })
      fila.caja = { id: pr.id, factor, propio }
    }
    productos.push(fila)
  }
  const tramosValidos = (plano: number) => {
    const n = Math.floor(rnd() * 4)
    const ts: { minQuantity: number; unitPrice: number }[] = []
    let min = 0, precio = plano
    for (let k = 0; k < n; k++) {
      min = Math.round((min + entre(1, 40, 0 + (rnd() < 0.3 ? 1 : 0))) * 10_000) / 10_000
      precio = Math.round(precio * entre(0.6, 1, 3) * 10_000) / 10_000
      ts.push({ minQuantity: min, unitPrice: precio })
    }
    return ts
  }
  for (const p of productos) {
    if (rnd() < 0.5) await guardarPrecios(db, cOwner, { priceListId: null, cambios: [{ productId: p.id, tiers: tramosValidos(p.precio) }] })
    for (const l of listas) {
      if (rnd() < 0.7) {
        const plano = rnd() < 0.8 ? Math.round(p.precio * entre(0.7, 1, 3) * 10_000) / 10_000 : null
        const tiers = tramosValidos(plano ?? p.precio)
        if (plano !== null || tiers.length > 0) await guardarPrecios(db, cOwner, { priceListId: l.id, cambios: [{ productId: p.id, ...(plano !== null ? { price: plano } : {}), tiers }] })
      }
    }
  }

  console.log('\n1) El carrito del navegador y el servidor dicen lo MISMO (240 carritos al azar)')
  let iguales = 0, distintos = 0, rechazadosOtro = 0, primero = ''
  const vistos = { BASE: 0, LISTA: 0, VOLUMEN: 0, cajaPropio: 0, cajaOtra: 0, descuento: 0, fraccion: 0 }
  for (let n = 0; n < 240; n++) {
    const listaElegida = elige<string | null>([null, ...listas.map((l) => l.id)])
    const nLineas = 1 + Math.floor(rnd() * 3)
    const usados = new Set<string>()
    const carrito: LineaCarrito[] = []
    const precios = await cargarDatosDePrecio(db, productos.map((p) => p.id), listaElegida)   // lo mismo que devuelve el lookup del POS
    for (let k = 0; k < nLineas; k++) {
      const p = elige(productos.filter((x) => !usados.has(x.id)))
      usados.add(p.id)
      const conCaja = p.caja && rnd() < 0.5
      const prod = {
        productId: p.id, variantId: null, name: 'x', sku: 'x', barcode: null, qrCode: null, unitType: p.unitType, salePrice: p.precio, taxRate: 0.18, trackStock: true, stock: 1e7, minStock: 0,
        stockStatus: 'OK', warehouseId: wA.id, warehouseName: 'A', precios: precios.get(p.id)!,
      } as unknown as PosProduct
      let l: LineaCarrito
      if (conCaja) {
        const c = p.caja!
        const precioCaja = c.propio ?? Math.round(p.precio * c.factor * 100) / 100
        const ingresada = elige([1, 2, 3, 5])
        l = { key: `${k}`, producto: prod, quantity: ingresada * c.factor, discount: 0, presentacion: { id: c.id, name: `Caja ${c.factor}`, unitType: 'UNIDAD', factor: c.factor, precio: precioCaja, precioPropio: c.propio !== null }, ingresada }
      } else {
        const q = p.unitType === 'KILOGRAMO' ? entre(0.25, 60, 3) : elige([1, 2, 5, 11, 12, 13, 24, 49, 50, 99, 100, 150])
        l = { key: `${k}`, producto: prod, quantity: q, discount: 0 }
      }
      const pct = rnd() < 0.4 ? elige([5, 10, 12.5]) : undefined
      carrito.push(pct ? { ...l, pct, discount: descuentoDe({ ...l, pct }) } : l)
    }
    for (const l of carrito) {
      vistos[precioDe(l).fuente]++
      if (l.presentacion) vistos[l.presentacion.precioPropio && precioDe(l).fuente === 'BASE' ? 'cajaPropio' : 'cajaOtra']++
      if (l.pct) vistos.descuento++
      if (!Number.isInteger(l.quantity)) vistos.fraccion++
    }
    // El total del carrito: la MISMA cuenta que `totales.total` de PosTerminal.
    const totalCarrito = cent(carrito.reduce((s, l) => s + cent(brutoDe(l) - l.discount), 0))
    const pago = [{ method: 'EFECTIVO', amount: totalCarrito }]
    const r = await registerSale(db, cOwner, registerSaleSchema.parse({
      warehouseId: wA.id, items: carrito.map(itemDe), payments: pago, priceListId: listaElegida, totalEsperado: totalCarrito, idempotencyKey: randomUUID(),
    })).catch((e) => e as { code?: string; message: string; details?: { total?: number } })
    if ('saleId' in r && r.total === totalCarrito) iguales++
    else {
      distintos++
      if (!primero) primero = JSON.stringify({ n, listaElegida, totalCarrito, r: 'saleId' in r ? r.total : { c: r.code, m: r.message.slice(0, 80), d: r.details }, lineas: carrito.map((l) => ({ q: l.quantity, i: l.ingresada, pct: l.pct, bruto: brutoDe(l), d: l.discount })) })
      if ('code' in r && r.code !== 'PRICE_CHANGED') rechazadosOtro++
    }
  }
  check('>>> >>> en los 240 carritos el total de la pantalla es EXACTAMENTE el que cobra el servidor', iguales === 240 && distintos === 0, `${iguales} iguales, ${distintos} distintos ${primero}`)
  check('>>> y ninguno fue rechazado por otro motivo (piso, stock, descuento)', rechazadosOtro === 0)
  check('>>> el azar cubrió de verdad cada caso (no es una prueba vacía): Base, lista, volumen, caja con precio propio, caja sin él, descuentos y cantidades fraccionarias', Object.values(vistos).every((v) => v >= 8), JSON.stringify(vistos))

  console.log('\n2) Si algo cambia mientras se arma la venta, el servidor lo dice')
  const p0 = productos[0]!
  const lista0 = listas[0]!
  await guardarPrecios(db, cOwner, { priceListId: lista0.id, cambios: [{ productId: p0.id, price: Math.round(p0.precio * 0.5 * 10_000) / 10_000, tiers: [] }] })
  const dViejos = await cargarDatosDePrecio(db, [p0.id], lista0.id)
  const prodViejo = { productId: p0.id, variantId: null, salePrice: p0.precio, taxRate: 0.18, unitType: p0.unitType, precios: dViejos.get(p0.id)! } as unknown as PosProduct
  const lVieja: LineaCarrito = { key: 'a', producto: prodViejo, quantity: 10, discount: 0 }
  const totalViejo = cent(brutoDe(lVieja))
  // El gestor cambia el precio de la lista DESPUÉS de que el cajero armó el carrito.
  await guardarPrecios(db, cOwner, { priceListId: lista0.id, cambios: [{ productId: p0.id, price: Math.round(p0.precio * 0.9 * 10_000) / 10_000 }] })
  const e = await registerSale(db, cOwner, registerSaleSchema.parse({ warehouseId: wA.id, items: [itemDe(lVieja)], payments: [{ method: 'EFECTIVO', amount: totalViejo }], priceListId: lista0.id, totalEsperado: totalViejo, idempotencyKey: randomUUID() })).then(() => null).catch((x) => x as { code?: string; message: string; details?: { total?: number } })
  const totalNuevo = cent(Math.round(p0.precio * 0.9 * 10_000) / 10_000 * 10)
  check('>>> >>> un precio que cambió → PRICE_CHANGED con el total de AHORA (no cobra distinto a lo que el cliente vio)', e?.code === 'PRICE_CHANGED' && e.details?.total === totalNuevo && new RegExp(totalNuevo.toFixed(2)).test(e.message), JSON.stringify(e && [e.code, e.details]))
  check('>>> el rechazo no deja venta alguna para ese intento', (await prisma.sale.count({ where: { tenantId: t.id, total: totalNuevo } })) === 0)
  const otraVez = await registerSale(db, cOwner, registerSaleSchema.parse({ warehouseId: wA.id, items: [itemDe(lVieja)], payments: [{ method: 'EFECTIVO', amount: totalNuevo }], priceListId: lista0.id, totalEsperado: totalNuevo, idempotencyKey: randomUUID() }))
  check('>>> con el total nuevo el cobro pasa', otraVez.total === totalNuevo)
  check('>>> sin totalEsperado (cobrar un pedido o una cotización) no se compara nada', await code(registerSale(db, cOwner, registerSaleSchema.parse({ warehouseId: wA.id, items: [itemDe(lVieja)], payments: [{ method: 'EFECTIVO', amount: totalNuevo }], priceListId: lista0.id, idempotencyKey: randomUUID() }))) === null)
  check('>>> un total esperado con un céntimo de diferencia ya se rechaza', await code(registerSale(db, cOwner, registerSaleSchema.parse({ warehouseId: wA.id, items: [itemDe(lVieja)], payments: [{ method: 'EFECTIVO', amount: totalNuevo }], priceListId: lista0.id, totalEsperado: cent(totalNuevo + 0.01), idempotencyKey: randomUUID() }))) === 'PRICE_CHANGED')
  check('>>> y la lista que ya no existe: el carrito creía Mayorista, el servidor vende a Base y avisa', await (async () => {
    const baja = await crearLista(db, cOwner, { name: 'Efímera' })
    await guardarPrecios(db, cOwner, { priceListId: baja.id, cambios: [{ productId: p0.id, price: 0.1 }] })
    const d = await cargarDatosDePrecio(db, [p0.id], baja.id)
    const l: LineaCarrito = { key: 'b', producto: { ...prodViejo, precios: d.get(p0.id)! }, quantity: 10, discount: 0 }
    const total = cent(brutoDe(l))
    const { darDeBajaLista } = await import('../src/features/precios/service')
    await darDeBajaLista(db, cOwner, { priceListId: baja.id })
    return (await code(registerSale(db, cOwner, registerSaleSchema.parse({ warehouseId: wA.id, items: [itemDe(l)], payments: [{ method: 'EFECTIVO', amount: total }], priceListId: baja.id, totalEsperado: total, idempotencyKey: randomUUID() })))) === 'PRICE_CHANGED'
  })())

  await prisma.tenant.delete({ where: { id: t.id } })
  console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
  return fail
}

async function main() {
  try { return await cuerpo() } catch (e) { check(`EXCEPCIÓN no controlada: ${e instanceof Error ? e.message.slice(0, 200) : e}`, false); return 1 }
}
correr(main)
