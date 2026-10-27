import Link from 'next/link'
import { fechaDiaCorta, formatearFechaLocal } from '@/lib/fecha-local'
import type { obtenerCompra } from '../service'
import { ETIQUETA_CONDICION, ETIQUETA_ESTADO } from '../borrador-ui'
import { AccionesCompra, type PermisosCompra } from './AccionesCompra'
import { ESTILO_ESTADO } from './ComprasLista'

const money = (n: number) => `S/ ${n.toFixed(2)}`
const cant = (n: number) => String(Number(n.toFixed(4)))
export type CompraDetalle = Awaited<ReturnType<typeof obtenerCompra>>

const ESTADO_CUENTA: Record<string, string> = { ABIERTA: 'Pendiente', PAGADA: 'Pagada', ANULADA: 'Anulada' }

/**
 * Detalle de una compra: estado, proveedor, líneas (cantidad tecleada y en unidad base, costo sin IGV), totales, la cuenta por pagar si
 * es a crédito, y quién la creó, recibió o anuló. Las acciones dependen del estado y de los permisos (resueltos en el servidor).
 */
export function DetalleCompra({ compra, permisos, zona, verCostos }: {
  compra: CompraDetalle
  permisos: PermisosCompra
  zona: string
  /**
   * Ver el costo de cada línea (`productos.ver_costo` o `compras.registrar`). Quien solo paga ve lo que dice la factura (totales), no el
   * costo unitario de cada producto: el costo es el margen del negocio.
   */
  verCostos: boolean
}) {
  const c = compra
  const cxp = c.accountPayable
  const cuando = (d: Date | null) => (d ? formatearFechaLocal(d, zona) : '')
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3">
        <div>
          <p className="flex flex-wrap items-center gap-2">
            <span data-insignia={`estado-${c.status}`} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ESTILO_ESTADO[c.status]}`}>{ETIQUETA_ESTADO[c.status]}</span>
            <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-semibold text-ink-muted">{ETIQUETA_CONDICION[c.paymentCondition]}</span>
          </p>
          <h1 className="mt-1 text-2xl font-bold text-ink">Compra {c.number}</h1>
          <p className="text-sm text-ink-muted">
            {c.supplier ? <Link href={`/proveedores/${c.supplier.id}`} data-enlace="proveedor" className="font-semibold text-industrial-600 underline">{c.supplier.name}</Link> : 'Sin proveedor'}
            {c.invoiceRef ? ` · Doc. ${c.invoiceRef}` : ''} · {c.warehouse.name}
          </p>
        </div>
        <AccionesCompra
          purchaseId={c.id} numero={c.number} estado={c.status} proveedor={c.supplier ? { id: c.supplier.id, name: c.supplier.name, deudaActual: c.supplier.payableBalance } : null} vence={c.dueDate} condicion={c.paymentCondition} total={c.total} lineas={c.items.length}
          conPagos={!!cxp && cxp.paidAmount > 0} permisos={permisos}
        />
      </header>

      {c.status === 'ANULADA' && <p data-aviso="anulada" className="rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">Anulada{c.voidedBy ? ` por ${c.voidedBy.name}` : ''} el {cuando(c.voidedAt)}: {c.voidReason}</p>}
      {c.status === 'BORRADOR' && <p data-aviso="borrador" className="rounded-xl bg-surface-sunken px-3 py-2 text-sm text-ink">Borrador: todavía no mueve stock, ni costos, ni deuda. Recíbela cuando llegue la mercadería.</p>}

      <section aria-label="Productos" className="flex flex-col gap-2">
        <h2 className="text-lg font-bold text-ink">Productos</h2>
        <ul className="flex flex-col gap-2">
          {c.items.map((i) => (
            <li key={i.id} data-linea={i.productId} className="flex flex-wrap items-start justify-between gap-2 rounded-2xl border border-hairline bg-surface px-4 py-3">
              <div className="min-w-0">
                <p className="font-semibold text-ink">{i.product.name}</p>
                <p className="text-xs text-ink-muted">
                  {i.presentationName && i.enteredQuantity !== null ? `${cant(i.enteredQuantity)} × ${i.presentationName} = ` : ''}{cant(i.quantity)} en unidad base{verCostos ? ` · costo ${money(i.unitCost)} c/u sin IGV` : ''}{i.taxRate === 0 ? ' · sin IGV' : ''}
                </p>
              </div>
              {verCostos && <p data-costo-linea className="font-bold tabular-nums text-ink">{money(i.lineTotal)}</p>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Totales" className="flex flex-col gap-1 rounded-2xl border border-hairline bg-surface p-4 text-sm">
        <p className="flex justify-between text-ink"><span>Valor de compra (sin IGV)</span><b className="tabular-nums">{money(c.subtotal)}</b></p>
        <p className="flex justify-between text-ink"><span>IGV</span><b className="tabular-nums">{money(c.taxTotal)}</b></p>
        <p className="flex justify-between text-lg text-ink"><span className="font-bold">Total</span><b data-total="total" className="tabular-nums">{money(c.total)}</b></p>
      </section>

      {cxp && (
        <section aria-label="Cuenta por pagar" data-cuenta={cxp.status} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface p-4 text-sm text-ink">
          <div>
            <p className="font-bold">Cuenta por pagar · {ESTADO_CUENTA[cxp.status] ?? cxp.status}</p>
            <p className="text-xs text-ink-muted">Vence el {fechaDiaCorta(cxp.dueDate)} · pagado {money(cxp.paidAmount)} de {money(cxp.amount)}</p>
          </div>
          <p className="text-lg font-bold tabular-nums">{cxp.status === 'ABIERTA' ? `Debes ${money(Math.round((cxp.amount - cxp.paidAmount) * 100) / 100)}` : money(cxp.amount)}</p>
        </section>
      )}

      <section aria-label="Historial" className="text-xs text-ink-muted">
        <p>Registrada por {c.user.name} el {cuando(c.createdAt)}.</p>
        {c.receivedAt && <p>Recibida{c.receivedBy ? ` por ${c.receivedBy.name}` : ''} el {cuando(c.receivedAt)}.</p>}
        {c.notes && <p className="mt-1 whitespace-pre-line">Notas: {c.notes}</p>}
      </section>
    </div>
  )
}
