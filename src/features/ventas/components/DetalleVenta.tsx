import Link from 'next/link'
import type { ReactNode } from 'react'
import { formatearFechaLocal } from '@/lib/fecha-local'
import { ETIQUETA_ESTADO_VENTA } from '../schemas'
import type { DetalleVenta as Detalle, DevolucionVenta } from '../service'
import { ETIQUETA_ESTADO_COMPROBANTE, ETIQUETA_MODO_REEMBOLSO, ETIQUETA_TIPO_COMPROBANTE, medio } from '../etiquetas'
import { ESTILO_ESTADO_VENTA } from './TablaVentas'

const money = (n: number) => `S/ ${n.toFixed(2)}`
const cant = (n: number) => String(Number(n.toFixed(4)))

function Seccion({ titulo, children, marca }: { titulo: string; children: ReactNode; marca?: string }) {
  return (
    <section aria-label={titulo} data-seccion={marca} className="flex flex-col gap-2">
      <h2 className="text-lg font-bold text-ink">{titulo}</h2>
      {children}
    </section>
  )
}

/** La trazabilidad de una anulación o devolución: qué pasó, quién la autorizó y adónde fue el dinero. */
function Trazabilidad({ d, zona }: { d: DevolucionVenta; zona: string }) {
  return (
    <article data-devolucion={d.numero} className="flex flex-col gap-2 rounded-2xl border-2 border-stock-low/40 bg-stock-low-soft p-4 text-sm text-ink">
      <p className="flex flex-wrap items-center justify-between gap-2">
        <b className="text-base">{d.tipo === 'ANULACION' ? 'Anulación' : 'Devolución'} <span className="font-mono">{d.numero}</span></b>
        <time dateTime={d.cuando} className="text-xs tabular-nums text-ink-muted">{formatearFechaLocal(d.cuando, zona)}</time>
      </p>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <div><dt className="inline text-ink-muted">Autorizó: </dt><dd data-devolucion-campo="autorizo" className="inline font-semibold">{d.autorizo}</dd></div>
        <div className="sm:col-span-2"><dt className="inline text-ink-muted">Motivo: </dt><dd data-devolucion-campo="motivo" className="inline">{d.motivo}</dd></div>
        <div><dt className="inline text-ink-muted">Nota de crédito: </dt><dd data-devolucion-campo="nota" className="inline font-semibold">{d.notaDeCredito ?? 'No hizo falta (sin comprobante vivo)'}</dd></div>
        {d.deudaCancelada > 0 && <div><dt className="inline text-ink-muted">Deuda del cliente cancelada: </dt><dd className="inline font-semibold">{money(d.deudaCancelada)}</dd></div>}
        <div><dt className="inline text-ink-muted">Productos repuestos: </dt><dd className="inline">{d.lineas} {d.lineas === 1 ? 'línea' : 'líneas'}</dd></div>
        {d.turno && <div><dt className="inline text-ink-muted">Turno de caja: </dt><dd data-devolucion-campo="turno" className="inline">abierto el {formatearFechaLocal(d.turno.abiertoEn, zona)}</dd></div>}
      </dl>
      {d.reembolsos.length === 0
        ? <p className="text-xs text-ink-muted">Venta sin dinero pagado (todo fue fiado): no hubo reembolso.</p>
        : (
          <ul aria-label="Reembolsos" className="flex flex-col gap-1">
            {d.reembolsos.map((r, k) => (
              <li key={k} data-reembolso={r.modo} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2">
                <span>{ETIQUETA_MODO_REEMBOLSO[r.modo]}{r.medio ? ` · ${medio(r.medio)}` : ''}{r.referencia ? <span className="text-ink-muted"> · {r.referencia}</span> : null}</span>
                <b className="tabular-nums">{money(r.monto)}</b>
              </li>
            ))}
          </ul>
        )}
    </article>
  )
}

/**
 * Detalle de una venta. No muestra costo, utilidad ni margen (el servicio ni siquiera los lee). La acción de anular o devolver llega como
 * `accion` ya decidida por la página (según permiso, estado y bloqueos).
 */
export function DetalleVenta({ venta: v, accion }: { venta: Detalle; accion?: ReactNode }) {
  const cerrada = v.estado === 'ANULADA' || v.estado === 'DEVUELTA'
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2">
          <span data-insignia={`estado-${v.estado}`} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ESTILO_ESTADO_VENTA[v.estado]}`}>{v.estado === 'BORRADOR' ? 'Borrador' : ETIQUETA_ESTADO_VENTA[v.estado]}</span>
        </p>
        <h1 className="text-2xl font-bold text-ink">Venta <span className="font-mono">{v.numero}</span></h1>
        <p className="text-sm text-ink-muted">
          {v.cuando ? formatearFechaLocal(v.cuando, v.zona) : 'Sin fecha'} · {v.sucursal.nombre} · cobró {v.cobro}
          {v.cliente ? <> · cliente <b className="text-ink">{v.cliente.nombre}</b>{v.cliente.documento ? ` (${v.cliente.documento})` : ''}</> : ' · sin cliente'}
        </p>
        {v.notas && <p className="text-sm text-ink">Notas: {v.notas}</p>}
      </header>

      {cerrada && v.devoluciones.length === 0 && (
        <p role="status" data-aviso="sin-registro" className="rounded-xl bg-surface-sunken px-3 py-2 text-sm text-ink-muted">Esta venta figura como {ETIQUETA_ESTADO_VENTA[v.estado as 'ANULADA' | 'DEVUELTA'].toLowerCase()} pero no tiene registro de devolución (es anterior a este módulo).</p>
      )}
      {v.devoluciones.length > 0 && (
        <Seccion titulo={v.estado === 'ANULADA' ? 'Venta anulada' : 'Venta devuelta'} marca="trazabilidad">
          {v.devoluciones.map((d) => <Trazabilidad key={d.id} d={d} zona={v.zona} />)}
        </Seccion>
      )}

      {accion}

      <Seccion titulo="Productos" marca="productos">
        <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
          <table data-venta="lineas" className="w-full min-w-[34rem] text-sm">
            <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted">
              <th scope="col" className="px-3 py-2 text-left">Producto</th><th scope="col" className="px-3 py-2 text-right">Cantidad</th><th scope="col" className="px-3 py-2 text-right">Precio</th>
              <th scope="col" className="px-3 py-2 text-right">Desc.</th><th scope="col" className="px-3 py-2 text-right">Total</th>
            </tr></thead>
            <tbody>
              {v.lineas.map((l, k) => (
                <tr key={k} data-linea className="border-b border-hairline last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-semibold">{l.nombre}<span className="block text-xs font-normal text-ink-muted">{l.sku}</span></th>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {l.presentacion ? <>{cant(l.presentacion.ingresada)} × {l.presentacion.nombre}<span className="block text-xs text-ink-muted">= {cant(l.cantidad)} u. (factor {cant(l.presentacion.factor)})</span></> : <>{cant(l.cantidad)} <span className="text-xs text-ink-muted">{l.unidad.toLowerCase()}</span></>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(l.precio)}</td><td className="px-3 py-2 text-right tabular-nums">{l.descuento > 0 ? money(l.descuento) : '—'}</td>
                  <td className="px-3 py-2 text-right font-bold tabular-nums">{money(l.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="ml-auto flex w-full max-w-xs flex-col gap-1 text-sm">
          <div className="flex justify-between"><dt className="text-ink-muted">Valor de venta</dt><dd className="tabular-nums">{money(v.subtotal)}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-muted">IGV</dt><dd className="tabular-nums">{money(v.igv)}</dd></div>
          {v.descuento > 0 && <div className="flex justify-between"><dt className="text-ink-muted">Descuentos</dt><dd className="tabular-nums">{money(v.descuento)}</dd></div>}
          <div className="flex justify-between border-t border-hairline pt-1 text-base font-bold text-ink"><dt>Total</dt><dd data-venta="total" className="tabular-nums">{money(v.total)}</dd></div>
        </dl>
      </Seccion>

      <Seccion titulo="Pagos" marca="pagos">
        <ul className="flex flex-col gap-1.5">
          {v.pagos.map((p, k) => (
            <li key={k} data-pago={p.metodo} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline bg-surface px-3 py-2 text-sm">
              <span>{medio(p.metodo)}{p.referencia ? <span className="text-ink-muted"> · {p.referencia}</span> : null}{p.vuelto > 0 ? <span className="text-ink-muted"> · vuelto {money(p.vuelto)}</span> : null}</span>
              <b className="tabular-nums">{money(p.monto)}</b>
            </li>
          ))}
        </ul>
      </Seccion>

      {v.cuenta && (
        <Seccion titulo="Cuenta por cobrar" marca="cuenta">
          <p data-cuenta={v.cuenta.estado} className="rounded-xl border border-hairline bg-surface px-3 py-2 text-sm text-ink">
            {v.cuenta.estado === 'ANULADA' ? 'Cuenta dada de baja' : v.cuenta.estado === 'PAGADA' ? 'Cuenta pagada' : 'Cuenta abierta'} · fiado {money(v.cuenta.monto)} · abonado {money(v.cuenta.abonado)} · saldo {money(v.cuenta.saldo)} · vence {v.cuenta.vence}
            {v.cuenta.enRevision && <b className="ml-1 text-stock-low">· pendiente de revisión por una nota de crédito</b>}
          </p>
        </Seccion>
      )}

      <Seccion titulo="Comprobantes" marca="comprobantes">
        {v.comprobantes.length === 0
          ? <p className="text-sm text-ink-muted">Sin comprobante: es una nota de venta interna.</p>
          : (
            <ul className="flex flex-col gap-1.5">
              {v.comprobantes.map((c) => (
                <li key={c.id} data-comprobante={c.tipo} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline bg-surface px-3 py-2 text-sm">
                  <span><b>{ETIQUETA_TIPO_COMPROBANTE[c.tipo] ?? c.tipo} {c.numero}</b>{c.relacionado ? <span className="text-ink-muted"> · corrige {c.relacionado}</span> : null}{c.esEnsayo ? <span className="ml-1 rounded-full bg-surface-sunken px-1.5 text-xs text-ink-muted">ensayo</span> : null}</span>
                  <span className="text-xs text-ink-muted">{c.anuladoEn ? 'Anulado (ensayo)' : (ETIQUETA_ESTADO_COMPROBANTE[c.estado] ?? c.estado)}</span>
                </li>
              ))}
            </ul>
          )}
        <p className="text-xs"><Link href="/comprobantes" className="font-semibold text-industrial-600 underline">Ir a comprobantes</Link></p>
      </Seccion>

      {v.guias.length > 0 && (
        <p role="note" data-aviso="guia" className="rounded-xl bg-surface-sunken px-3 py-2 text-sm text-ink">
          Esta venta tiene {v.guias.length === 1 ? 'la guía de remisión' : 'guías de remisión'} <b>{v.guias.join(', ')}</b>. Anular o devolver la venta <b>no anula la guía</b>: es un documento de traslado aparte.
        </p>
      )}
    </div>
  )
}
