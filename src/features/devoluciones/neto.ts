import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { aDiezmilesimas, divRedondeada, repartirEnProporcion } from './parcial'

/**
 * Lo DEVUELTO de las ventas COMPLETADAS (devoluciones parciales, F6.2), en un solo sitio para que TODOS los reportes resten lo mismo.
 *
 *  · Una venta con devoluciones parciales sigue COMPLETADA y sigue contando en el periodo de la venta; lo devuelto se resta ahí (convención de
 *    F6.1: la devolución cambia el periodo de la venta, no el de la devolución). Las ventas ANULADA o DEVUELTA no pasan por aquí: ya no cuentan.
 *  · Este módulo NO lee costos ni márgenes: solo importes, base e IGV (los reportes con `reportes.ver` lo usan). La parte del costo de la
 *    rentabilidad se lee aparte, con `productos.ver_costo`.
 *  · Todo en céntimos enteros; las cantidades, en diezmilésimas de unidad base.
 */

const c = (v: unknown): number => Math.round(Number(v ?? 0) * 100)
const LOTE_IDS = 500

/** Lo devuelto de una línea: solo las unidades base (diezmilésimas), que es lo que hace falta para repartir su descuento. El costo y el destino (stock o merma) los lee la rentabilidad aparte. */
export interface LineaDevuelta { cantidadM: number }

export interface DevolucionesDeVenta {
  /** Σ de lo devuelto (con IGV), su base y su IGV. */
  totalCent: number
  baseCent: number
  igvCent: number
  /** Parte del descuento de las líneas que se devolvió con ellas (proporcional a lo devuelto de cada línea). */
  descuentoCent: number
  /** De lo devuelto: lo que bajó la deuda del cliente y lo que se devolvió en dinero. */
  deudaCent: number
  dineroCent: number
  operaciones: number
  /** Por línea de venta. */
  lineas: Map<string, LineaDevuelta>
}

const vacia = (): DevolucionesDeVenta => ({ totalCent: 0, baseCent: 0, igvCent: 0, descuentoCent: 0, deudaCent: 0, dineroCent: 0, operaciones: 0, lineas: new Map() })

/**
 * Las devoluciones de las ventas dadas, agrupadas por venta. Solo hay entrada para las que tienen alguna. El descuento devuelto de una línea es
 * `round(descuento · devuelto / vendido)` calculado UNA vez sobre lo devuelto en total: al devolverla entera da exactamente su descuento.
 */
export async function leerDevolucionesDeVentas(db: TenantPrismaClient, saleIds: readonly string[]): Promise<Map<string, DevolucionesDeVenta>> {
  const out = new Map<string, DevolucionesDeVenta>()
  const descuentos = new Map<string, { descuentoCent: number; vendidaM: number }>()
  for (let i = 0; i < saleIds.length; i += LOTE_IDS) {
    const filas = await db.saleReturn.findMany({
      where: { saleId: { in: saleIds.slice(i, i + LOTE_IDS) } },
      select: {
        saleId: true, returnTotal: true, receivableVoidedAmount: true, paidNet: true,
        items: { select: { saleItemId: true, quantity: true, subtotal: true, taxAmount: true, saleItem: { select: { discount: true, quantity: true } } } },
      },
    })
    for (const r of filas) {
      const d = out.get(r.saleId) ?? vacia()
      d.totalCent += c(r.returnTotal); d.deudaCent += c(r.receivableVoidedAmount); d.dineroCent += c(r.paidNet); d.operaciones++
      for (const it of r.items) {
        const l = d.lineas.get(it.saleItemId) ?? { cantidadM: 0 }
        const q = aDiezmilesimas(Number(it.quantity))
        l.cantidadM += q
        d.lineas.set(it.saleItemId, l)
        d.baseCent += c(it.subtotal); d.igvCent += c(it.taxAmount)
        descuentos.set(it.saleItemId, { descuentoCent: c(it.saleItem.discount), vendidaM: aDiezmilesimas(Number(it.saleItem.quantity)) })
      }
      out.set(r.saleId, d)
    }
  }
  for (const d of out.values()) {
    for (const [itemId, l] of d.lineas) {
      const x = descuentos.get(itemId)
      if (x && x.vendidaM > 0 && x.descuentoCent > 0) d.descuentoCent += Number(divRedondeada(BigInt(x.descuentoCent) * BigInt(l.cantidadM), BigInt(x.vendidaM)))
    }
  }
  return out
}

export interface PagoNeto { metodo: string; monto: number; vuelto: number }

/**
 * Los pagos de una venta DESPUÉS de sus devoluciones: lo fiado baja con la deuda que se redujo, y el resto de los medios baja con el dinero
 * devuelto, repartido en proporción a lo que cada medio pagó (nunca más de lo que pagó). La suma de los medios, neta de vuelto, queda igual al
 * total de la venta menos lo devuelto. Se conserva una fila por pago (para contar operaciones); solo se reduce `monto`.
 */
export function pagosTrasDevoluciones(pagos: readonly PagoNeto[], dev: DevolucionesDeVenta | undefined): PagoNeto[] {
  if (!dev || dev.totalCent === 0) return pagos.map((p) => ({ ...p }))
  const filas = pagos.map((p) => ({ ...p, netoCent: c(p.monto) - c(p.vuelto) }))
  const reducir = (indices: number[], cent: number) => {
    let resta = cent
    for (const i of indices) {
      const quita = Math.min(resta, filas[i]!.netoCent)
      filas[i]!.netoCent -= quita; resta -= quita
      if (resta === 0) break
    }
  }
  const credito = filas.map((f, i) => (f.metodo === 'CREDITO' ? i : -1)).filter((i) => i >= 0)
  reducir(credito, dev.deudaCent)
  const resto = filas.map((f, i) => (f.metodo !== 'CREDITO' ? i : -1)).filter((i) => i >= 0)
  const porMedio = new Map<string, number>()
  for (const i of resto) porMedio.set(filas[i]!.metodo, (porMedio.get(filas[i]!.metodo) ?? 0) + filas[i]!.netoCent)
  const disponible = [...porMedio.values()].reduce((a, b) => a + b, 0)
  const aQuitar = repartirEnProporcion(Math.min(dev.dineroCent, disponible), [...porMedio].map(([method, cent]) => ({ method, cent })))
  for (const q of aQuitar) reducir(resto.filter((i) => filas[i]!.metodo === q.method), q.cent)
  return filas.map((f, i) => ({ metodo: f.metodo, monto: (f.netoCent + c(pagos[i]!.vuelto)) / 100, vuelto: pagos[i]!.vuelto }))
}
