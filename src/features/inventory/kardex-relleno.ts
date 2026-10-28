import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { reconstruirCostos, type MovimientoHistorico, type OrigenCosto } from './kardex-reconstruccion'

/**
 * Rellenado histórico del costo de los movimientos de stock (F6.4a) para UN negocio. Lo llama `scripts/rellenar-costo-kardex.ts` y lo prueban los tests.
 *
 *  · Solo escribe movimientos `SIN_DATO` (cada UPDATE lleva esa condición: dos corridas, o una corrida mientras el negocio vende, no se pisan).
 *  · Sin `aplicar` es una SIMULACIÓN: cuenta lo que haría y no escribe nada.
 *  · De paso enlaza con su venta los movimientos de venta anteriores (referencia `VENTA`), que antes quedaban como «MANUAL» sin enlace: es lo que permite
 *    al kardex llevar de cada fila a su documento, y la prueba de qué venta ancla cada costo.
 */

export interface InformeRelleno {
  productos: number
  /** Movimientos que estaban SIN_DATO y se examinaron. */
  examinados: number
  /** Cuántos quedaron en cada marca tras la reconstrucción (los que siguen SIN_DATO no se escriben). */
  resultado: Record<OrigenCosto, number>
  /** Movimientos de venta que se enlazaron con su venta. */
  ventasEnlazadas: number
  aplicado: boolean
}

const num = (d: { toString(): string } | null | undefined): number | null => (d === null || d === undefined ? null : Number(d.toString()))
const LOTE_PRODUCTOS = 100
const REF_VENTA = /^Venta (\S+)/

export async function rellenarCostoKardex(db: TenantPrismaClient, opts: { aplicar: boolean }): Promise<InformeRelleno> {
  const informe: InformeRelleno = { productos: 0, examinados: 0, resultado: { EXACTO: 0, RECONSTRUIDO: 0, SIN_DATO: 0 }, ventasEnlazadas: 0, aplicado: opts.aplicar }

  const pendientes = await db.stockMovement.findMany({ where: { costOrigin: 'SIN_DATO' }, distinct: ['productId'], select: { productId: true }, orderBy: { productId: 'asc' } })
  const productIds = pendientes.map((p) => p.productId)
  informe.productos = productIds.length

  for (let i = 0; i < productIds.length; i += LOTE_PRODUCTOS) {
    const lote = productIds.slice(i, i + LOTE_PRODUCTOS)
    const filas = await db.stockMovement.findMany({
      where: { productId: { in: lote } },
      orderBy: [{ productId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, productId: true, warehouseId: true, variantId: true, type: true, source: true, quantity: true, balanceAfter: true, unitCost: true,
        referenceType: true, referenceId: true, reason: true, costPending: true, costOrigin: true, costAfter: true,
      },
    })

    // Las ventas: por su enlace si ya lo tienen, o por el número que dice el motivo («Venta B001-12»).
    const esVenta = (f: { type: string; source: string }) => f.type === 'SALIDA' && f.source === 'VENTA'
    const numeros = new Set<string>()
    const ids = new Set<string>()
    for (const f of filas) {
      if (!esVenta(f)) continue
      if (f.referenceType === 'VENTA' && f.referenceId) ids.add(f.referenceId)
      else { const m = f.reason ? REF_VENTA.exec(f.reason) : null; if (m) numeros.add(m[1]!) }
    }
    const ventas = numeros.size || ids.size
      ? await db.sale.findMany({ where: { OR: [...(numeros.size ? [{ number: { in: [...numeros] } }] : []), ...(ids.size ? [{ id: { in: [...ids] } }] : [])] }, select: { id: true, number: true, items: { where: { productId: { in: lote } }, select: { productId: true, unitCost: true }, orderBy: { id: 'asc' } } } })
      : []
    const ventaPorNumero = new Map(ventas.map((v) => [v.number, v]))
    const ventaPorId = new Map(ventas.map((v) => [v.id, v]))

    // Las compras anuladas: el costo de la línea de la factura.
    const compraIds = [...new Set(filas.filter((f) => f.type === 'DEVOLUCION_PROVEEDOR' && f.referenceType === 'COMPRA' && f.referenceId).map((f) => f.referenceId!))]
    const lineasCompra = compraIds.length
      ? await db.purchaseItem.findMany({ where: { purchaseId: { in: compraIds }, productId: { in: lote } }, select: { purchaseId: true, productId: true, unitCost: true }, orderBy: { id: 'asc' } })
      : []
    const costoCompra = new Map<string, number>()
    for (const l of lineasCompra) if (!costoCompra.has(`${l.purchaseId}|${l.productId}`)) costoCompra.set(`${l.purchaseId}|${l.productId}`, Number(l.unitCost.toString()))

    const porProducto = new Map<string, typeof filas>()
    for (const f of filas) porProducto.set(f.productId, [...(porProducto.get(f.productId) ?? []), f])

    for (const [productId, movs] of porProducto) {
      const enlazar: { id: string; saleId: string }[] = []
      const historia: MovimientoHistorico[] = movs.map((f) => {
        let costoVenta: number | null = null
        if (esVenta(f)) {
          const venta = f.referenceType === 'VENTA' && f.referenceId ? ventaPorId.get(f.referenceId) : (REF_VENTA.exec(f.reason ?? '') ? ventaPorNumero.get(REF_VENTA.exec(f.reason ?? '')![1]!) : undefined)
          const linea = venta?.items.find((it) => it.productId === productId)
          if (venta && linea) {
            costoVenta = Number(linea.unitCost.toString())
            if (f.referenceType !== 'VENTA') enlazar.push({ id: f.id, saleId: venta.id })
          }
        }
        return {
          id: f.id, filaStock: `${f.warehouseId}|${f.variantId ?? ''}`, type: f.type, source: f.source, quantity: Number(f.quantity.toString()),
          balanceAfter: Number(f.balanceAfter.toString()), unitCost: num(f.unitCost), referenceType: f.referenceType, costPending: f.costPending,
          origenGuardado: f.costOrigin, costAfterGuardado: num(f.costAfter), costoVenta,
          costoCompra: f.referenceType === 'COMPRA' && f.referenceId ? (costoCompra.get(`${f.referenceId}|${productId}`) ?? null) : null,
        }
      })

      const nuevos = reconstruirCostos(historia)
      informe.examinados += nuevos.length
      for (const n of nuevos) informe.resultado[n.costOrigin]++

      if (!opts.aplicar) { informe.ventasEnlazadas += enlazar.length; continue }
      for (const n of nuevos) {
        if (n.costOrigin === 'SIN_DATO') continue   // ya está así
        await db.stockMovement.updateMany({
          where: { id: n.id, costOrigin: 'SIN_DATO' },
          data: { unitCostApplied: n.unitCostApplied, costAfter: n.costAfter, costOrigin: n.costOrigin },
        })
      }
      for (const e of enlazar) {
        const r = await db.stockMovement.updateMany({ where: { id: e.id, referenceType: 'MANUAL' }, data: { referenceType: 'VENTA', referenceId: e.saleId } })
        informe.ventasEnlazadas += r.count
      }
    }
  }
  return informe
}

export function formatearInformeRelleno(slug: string, i: InformeRelleno): string {
  const modo = i.aplicado ? 'APLICADO' : 'SIMULACIÓN (no se escribió nada)'
  return `${slug}: ${i.productos} producto(s) con movimientos sin costo · ${i.examinados} examinados → EXACTO ${i.resultado.EXACTO}, RECONSTRUIDO ${i.resultado.RECONSTRUIDO}, SIN_DATO ${i.resultado.SIN_DATO} · ventas enlazadas ${i.ventasEnlazadas} · ${modo}`
}
