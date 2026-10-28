import { Fragment } from 'react'
import Link from 'next/link'
import { formatQuantity, unitLabel } from '@/lib/quantity'
import { enlaceKardex } from '../kardex-enlaces'
import type { LineaReposicion, ReporteReposicion } from '../reposicion-reporte'
import { BotonBorradorCompra, BotonTransferencia } from './AccionesReposicion'

const soles = (n: number) => new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(n)

/** «2 cajas de 12 (24 u)» o «15 u»: lo que se pide, ya redondeado hacia arriba. */
export function textoPedir(l: Pick<LineaReposicion, 'pedir' | 'unitType'>): string {
  const p = l.pedir
  if (p.presentacion) return `${formatQuantity(p.cantidad, 'UNIDAD')} × ${p.presentacion.name} de ${formatQuantity(p.presentacion.factor, l.unitType)} (${formatQuantity(p.unidadesBase, l.unitType)} ${unitLabel(l.unitType)})`
  return `${formatQuantity(p.cantidad, l.unitType)} ${unitLabel(l.unitType)}`
}

/** Los almacenes (de la sucursal de la persona) con líneas en este grupo: un borrador de compra es de UN almacén, y se crea en la sucursal en la que se está. */
function almacenesDe(lineas: readonly LineaReposicion[], sucursalActualId: string | null): { id: string; nombre: string }[] {
  const vistos = new Map<string, string>()
  for (const l of lineas) if (l.warehouseId && l.variantId === null && l.branchId === sucursalActualId && !vistos.has(l.warehouseId)) vistos.set(l.warehouseId, l.almacen ?? '')
  return [...vistos].map(([id, nombre]) => ({ id, nombre }))
}

const ESTADO = { OUT: 'Agotado', LOW: 'En su mínimo', OK: 'Disponible' } as const
const CLASE = { OUT: 'bg-stock-out-soft text-stock-out', LOW: 'bg-stock-low-soft text-stock-low', OK: 'bg-stock-ok-soft text-stock-ok' } as const

/** Reposición sugerida agrupada por proveedor habitual (F6.6b). Solo muestra costos si el reporte los trae (`productos.ver_costo`). */
export function ReposicionReporte({
  reporte, verKardex = false, puedeComprar = false, puedeTransferir = false, sucursalActualId = null,
}: { reporte: ReporteReposicion; verKardex?: boolean; puedeComprar?: boolean; puedeTransferir?: boolean; sucursalActualId?: string | null }) {
  const { grupos, verCostos } = reporte
  if (grupos.length === 0) {
    return (
      <p data-reposicion="vacio" className="rounded-2xl bg-stock-ok-soft px-3 py-6 text-center text-sm font-semibold text-stock-ok">
        Nada que reponer: todo está sobre su mínimo o ya viene en camino.
      </p>
    )
  }
  return (
    <div data-reposicion="reporte" className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">
        {reporte.totalLineas} {reporte.totalLineas === 1 ? 'producto por reponer' : 'productos por reponer'} en {grupos.length} {grupos.length === 1 ? 'grupo' : 'grupos'}.
        {verCostos && reporte.valorEstimado !== undefined && <> Valor estimado del pedido: <b data-reposicion="valor-total" className="text-ink">{soles(reporte.valorEstimado)}</b> (sin IGV, al costo promedio).</>}
        {reporte.omitidosBajoPedido > 0 && <> {reporte.omitidosBajoPedido} {reporte.omitidosBajoPedido === 1 ? 'producto se trabaja' : 'productos se trabajan'} contra pedido y no se listan.</>}
      </p>
      {grupos.map((g) => (
        <section key={g.supplierId ?? 'sin-proveedor'} data-reposicion="grupo" data-proveedor={g.supplierId ?? ''} className="rounded-2xl border border-hairline bg-surface p-3 shadow-sm">
          <header className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-bold text-ink">{g.nombre} <span className="text-sm font-normal text-ink-muted">· {g.lineas.length}</span></h2>
            {verCostos && g.valorEstimado !== undefined && (
              <p data-reposicion="valor-grupo" className="text-sm font-semibold text-ink">
                {soles(g.valorEstimado)}{(g.sinCosto ?? 0) > 0 && <span className="font-normal text-ink-muted"> · {g.sinCosto} sin costo</span>}
              </p>
            )}
          </header>
          {puedeComprar && (
            <div data-reposicion="comprar" className="mt-2 flex flex-wrap items-start justify-end gap-3">
              {almacenesDe(g.lineas, sucursalActualId).map((a) => (
                <BotonBorradorCompra key={a.id} supplierId={g.supplierId} warehouseId={a.id}
                  etiqueta={`${g.supplierId === null ? 'Crear borrador sin proveedor' : 'Crear borrador de compra'}${almacenesDe(g.lineas, sucursalActualId).length > 1 ? ` · ${a.nombre}` : ''}`} />
              ))}
            </div>
          )}
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th scope="col" className="py-1 pr-2">Producto</th>
                  <th scope="col" className="px-2 py-1 text-right">Disponible</th>
                  <th scope="col" className="px-2 py-1 text-right">En camino</th>
                  <th scope="col" className="px-2 py-1 text-right">Posición</th>
                  <th scope="col" className="px-2 py-1 text-right">Mín / Obj.</th>
                  <th scope="col" className="px-2 py-1 text-right">Sugerida</th>
                  <th scope="col" className="py-1 pl-2">Pedir</th>
                  {verCostos && <th scope="col" className="py-1 pl-2 text-right">Valor</th>}
                </tr>
              </thead>
              <tbody>
                {g.lineas.map((l) => (
                  <Fragment key={l.clave}>
                  <tr data-linea={l.clave} className="border-t border-hairline align-top">
                    <td className="py-2 pr-2">
                      <span className="block font-semibold text-ink">{l.nombre}</span>
                      <span className="block font-mono text-xs text-ink-muted">{l.sku}{l.almacen ? ` · ${l.almacen}` : ' · sin existencias cargadas'}</span>
                      <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-bold ${CLASE[l.estado]}`}>{ESTADO[l.estado]}</span>
                      {l.bajoPedidoNegativo && <span className="ml-1 text-xs font-semibold text-stock-out">vendido sin existencias</span>}
                      {verKardex && <a data-producto="kardex" href={enlaceKardex({ producto: l.productId })} className="ml-2 text-xs font-semibold text-industrial-700 underline dark:text-industrial-300">kardex</a>}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatQuantity(l.disponible, l.unitType)}{l.reservado > 0 && <span className="block text-xs text-ink-muted">{formatQuantity(l.reservado, l.unitType)} reserv.</span>}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatQuantity(l.enTransito, l.unitType)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatQuantity(l.posicion, l.unitType)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatQuantity(l.minimo, l.unitType)} / {formatQuantity(l.objetivo, l.unitType)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatQuantity(l.sugerida, l.unitType)}</td>
                    <td data-pedir="" className="py-2 pl-2 font-semibold text-ink">{textoPedir(l)}</td>
                    {verCostos && <td className="py-2 pl-2 text-right tabular-nums">{l.valorEstimado != null ? soles(l.valorEstimado) : <span className="text-xs text-ink-muted">sin costo</span>}</td>}
                  </tr>
                  {(l.excedentes.length > 0 || l.pendienteDeLlegar > 0) && (
                    <tr data-excedente={l.clave}>
                      <td colSpan={verCostos ? 8 : 7} className="pb-2 pr-2">
                        {l.excedentes.length > 0 && (
                          <div role="note" className="flex flex-wrap items-center gap-3 rounded-xl border border-accent-500/50 bg-accent-50 px-3 py-2 text-sm text-accent-900">
                            <span>
                              <b>Antes de comprar:</b> a {l.excedentes.map((e) => `${e.sucursal} le sobran ${formatQuantity(e.excedente, l.unitType)} ${unitLabel(l.unitType)}`).join('; a ')}.
                            </span>
                            {puedeTransferir && l.transferible > 0 && l.warehouseId && l.branchId === sucursalActualId && (
                              <BotonTransferencia fromWarehouseId={l.excedentes[0]!.warehouseId} toWarehouseId={l.warehouseId} productId={l.productId} variantId={l.variantId}
                                texto={`Sugerir transferencia desde ${l.excedentes[0]!.sucursal} (${formatQuantity(l.transferible, l.unitType)} ${unitLabel(l.unitType)})`} />
                            )}
                          </div>
                        )}
                        {l.pendienteDeLlegar > 0 && <p data-pendiente="" className="mt-1 text-xs text-ink-muted">Ya hay {formatQuantity(l.pendienteDeLlegar, l.unitType)} {unitLabel(l.unitType)} pedidas en transferencias sin despachar (aún no cuentan como «en camino»).</p>}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <p className="text-xs text-ink-muted">
        Posición = disponible (existencias − reservado) + lo que viene en transferencias en camino. Se repone hasta el máximo, o 2 × el mínimo si no hay máximo. Lo pedido se redondea hacia arriba a la
        última presentación con la que se compró el producto. Los borradores de compra y las transferencias sin despachar no cuentan como mercadería en camino: si pides una transferencia, no compres lo mismo.
      </p>
      <p className="text-xs text-ink-muted"><Link href="/inventario/alertas" className="font-semibold text-industrial-700 underline dark:text-industrial-300">Ver alertas de stock</Link></p>
    </div>
  )
}
