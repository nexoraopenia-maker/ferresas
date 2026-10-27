import Link from 'next/link'
import { ETIQUETA_REPORTE_VENTAS, TIPOS_REPORTE_VENTAS, type ParametrosVentas, type TipoReporteVentas } from '../schemas'
import { enlaceCsvVentas, enlaceVentas } from '../urls'
import type { CobrosPorMedio, VentasPorMedio, VentasPorPeriodo, VentasPorVendedor } from '../ventas-calculo'

const money = (n: number) => `S/ ${n.toFixed(2)}`
const pct = (n: number) => `${n.toFixed(1)} %`
const th = 'px-3 py-2 text-right'
const td = 'px-3 py-2 text-right tabular-nums'

export function PestanasVentas({ activa, params }: { activa: TipoReporteVentas; params: ParametrosVentas }) {
  return (
    <nav aria-label="Reportes de ventas" className="flex flex-wrap gap-2">
      {TIPOS_REPORTE_VENTAS.map((t) => (
        <Link key={t} href={enlaceVentas(t, params)} aria-current={t === activa ? 'page' : undefined} data-pestana={t}
          className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${t === activa ? 'border-industrial-600 bg-industrial-600 text-white' : 'border-hairline text-ink'}`}>
          {ETIQUETA_REPORTE_VENTAS[t]}
        </Link>
      ))}
    </nav>
  )
}

export function BarraDescarga({ tipo, params, textoPeriodo }: { tipo: TipoReporteVentas; params: ParametrosVentas; textoPeriodo: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p data-periodo className="text-sm font-semibold text-ink">{textoPeriodo}</p>
      <a href={enlaceCsvVentas(tipo, params)} download data-enlace="csv" className="inline-flex h-touch items-center rounded-xl border border-hairline px-4 font-semibold text-ink">Descargar CSV</a>
    </div>
  )
}

function Vacio({ texto }: { texto: string }) {
  return <p data-reporte="vacio" className="rounded-2xl border border-hairline bg-surface p-6 text-center text-sm text-ink-muted">{texto}</p>
}

function Tarjetas({ items }: { items: { k: string; v: string; fuerte?: boolean }[] }) {
  return (
    <section aria-label="Resumen" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((i) => (
        <div key={i.k} className="rounded-2xl border border-hairline bg-surface px-3 py-2">
          <p className="text-xs text-ink-muted">{i.k}</p>
          <p className={`tabular-nums text-ink ${i.fuerte ? 'text-xl font-extrabold' : 'text-lg font-bold'}`}>{i.v}</p>
        </div>
      ))}
    </section>
  )
}

export function TablaPorPeriodo({ r }: { r: VentasPorPeriodo }) {
  const t = r.totales
  return (
    <div className="flex flex-col gap-4">
      <Tarjetas items={[{ k: 'Vendido', v: money(t.total), fuerte: true }, { k: 'Ventas', v: String(t.ventas) }, { k: 'Ticket promedio', v: money(t.ticketPromedio) }, { k: 'IGV', v: money(t.igv) }]} />
      {t.ventas === 0 ? <Vacio texto="No hay ventas completadas en este periodo." /> : (
        <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
          <table data-reporte="periodo" className="w-full min-w-[34rem] text-sm">
            <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted">
              <th scope="col" className="px-3 py-2 text-left">Periodo</th><th scope="col" className={th}>Ventas</th><th scope="col" className={th}>Total</th>
              <th scope="col" className={th}>IGV</th><th scope="col" className={th}>Descuentos</th><th scope="col" className={th}>Ticket prom.</th>
            </tr></thead>
            <tbody>
              {r.filas.map((f) => (
                <tr key={f.clave} data-fila={f.clave} className="border-b border-hairline last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-semibold text-ink">{f.etiqueta}</th>
                  <td className={td}>{f.ventas}</td><td className={`${td} font-bold text-ink`}>{f.ventas > 0 ? money(f.total) : '—'}</td>
                  <td className={td}>{f.ventas > 0 ? money(f.igv) : '—'}</td><td className={td}>{f.descuentos > 0 ? money(f.descuentos) : '—'}</td><td className={td}>{f.ventas > 0 ? money(f.ticketPromedio) : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr data-reporte-total className="border-t-2 border-hairline font-bold text-ink">
              <th scope="row" className="px-3 py-2 text-left">Total</th><td className={td}>{t.ventas}</td><td className={td}>{money(t.total)}</td><td className={td}>{money(t.igv)}</td><td className={td}>{money(t.descuentos)}</td><td className={td}>{money(t.ticketPromedio)}</td>
            </tr></tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

export function TablaPorVendedor({ r }: { r: VentasPorVendedor }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">{r.atribucion === 'VENDEDOR' ? 'Cada venta se atribuye a quien armó el pedido o la cotización de la que nació; si no viene de uno, a quien la registró.' : 'Cada venta se atribuye a quien la cobró en caja.'}</p>
      {r.totales.ventas === 0 ? <Vacio texto="No hay ventas completadas en este periodo." /> : (
        <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
          <table data-reporte="vendedor" className="w-full min-w-[30rem] text-sm">
            <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted">
              <th scope="col" className="px-3 py-2 text-left">{r.atribucion === 'VENDEDOR' ? 'Vendedor' : 'Cobró en caja'}</th><th scope="col" className={th}>Ventas</th><th scope="col" className={th}>Total</th><th scope="col" className={th}>Ticket prom.</th><th scope="col" className={th}>Participación</th>
            </tr></thead>
            <tbody>
              {r.filas.map((f) => (
                <tr key={f.userId} data-fila={f.userId} className="border-b border-hairline last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-semibold text-ink">{f.nombre}</th>
                  <td className={td}>{f.ventas}</td><td className={`${td} font-bold text-ink`}>{money(f.total)}</td><td className={td}>{money(f.ticketPromedio)}</td><td className={td}>{pct(f.participacion)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr data-reporte-total className="border-t-2 border-hairline font-bold text-ink">
              <th scope="row" className="px-3 py-2 text-left">Total</th><td className={td}>{r.totales.ventas}</td><td className={td}>{money(r.totales.total)}</td><td className={td}>{money(r.totales.ticketPromedio)}</td><td className={td}>100.0 %</td>
            </tr></tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

export function TablaPorMedio({ r }: { r: VentasPorMedio }) {
  const d = r.descuadradas
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">Cómo se pagaron las ventas del periodo. El fiado cuenta como un medio más: la venta se pagó con deuda. El monto en efectivo es lo cobrado menos el vuelto.</p>
      {d.ventas > 0 && (
        <p role="alert" data-reporte="descuadre" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
          {d.ventas} {d.ventas === 1 ? 'venta tiene' : 'ventas tienen'} pagos que no suman su total (diferencia {money(d.diferencia)}). Suele ser de ventas antiguas; el total de los medios no coincide con el vendido por esa diferencia.
        </p>
      )}
      {r.filas.length === 0 ? <Vacio texto="No hay ventas completadas en este periodo." /> : (
        <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
          <table data-reporte="medios" className="w-full min-w-[26rem] text-sm">
            <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted">
              <th scope="col" className="px-3 py-2 text-left">Medio de pago</th><th scope="col" className={th}>Ventas</th><th scope="col" className={th}>Monto</th><th scope="col" className={th}>Participación</th>
            </tr></thead>
            <tbody>
              {r.filas.map((f) => (
                <tr key={f.metodo} data-fila={f.metodo} className="border-b border-hairline last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-semibold text-ink">{f.etiqueta}</th>
                  <td className={td}>{f.ventas}</td><td className={`${td} font-bold text-ink`}>{money(f.monto)}</td><td className={td}>{pct(f.participacion)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr data-reporte-total className="border-t-2 border-hairline font-bold text-ink"><th scope="row" className="px-3 py-2 text-left">Total de los medios</th><td className={td} /><td className={td}>{money(r.totalMedios)}</td><td className={td}>100.0 %</td></tr>
              <tr className="text-ink-muted"><th scope="row" className="px-3 py-2 text-left font-semibold">Total de las ventas</th><td className={td} /><td className={td}>{money(r.totalVentas)}</td><td className={td} /></tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

export function TablaCobros({ r }: { r: CobrosPorMedio }) {
  const t = r.totales
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">El dinero que ENTRÓ en el periodo: lo cobrado en el acto por las ventas (sin la parte fiada y sin el vuelto) más los abonos de deuda de los clientes. Una venta a crédito no aparece hasta que el cliente abona.</p>
      <Tarjetas items={[{ k: 'Cobrado', v: money(t.total), fuerte: true }, { k: 'En ventas', v: money(t.contado) }, { k: 'Abonos de deuda', v: money(t.abonos) }, { k: 'Operaciones', v: String(t.operacionesContado + t.operacionesAbono) }]} />
      {r.filas.length === 0 ? <Vacio texto="No hubo cobros en este periodo." /> : (
        <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
          <table data-reporte="cobros" className="w-full min-w-[34rem] text-sm">
            <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted">
              <th scope="col" className="px-3 py-2 text-left">Medio de pago</th><th scope="col" className={th}>En ventas</th><th scope="col" className={th}>Abonos</th><th scope="col" className={th}>Total</th><th scope="col" className={th}>Participación</th>
            </tr></thead>
            <tbody>
              {r.filas.map((f) => (
                <tr key={f.metodo} data-fila={f.metodo} className="border-b border-hairline last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-semibold text-ink">{f.etiqueta}</th>
                  <td className={td}>{f.contado > 0 ? money(f.contado) : '—'}</td><td className={td}>{f.abonos > 0 ? money(f.abonos) : '—'}</td><td className={`${td} font-bold text-ink`}>{money(f.total)}</td><td className={td}>{pct(f.participacion)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr data-reporte-total className="border-t-2 border-hairline font-bold text-ink">
              <th scope="row" className="px-3 py-2 text-left">Total</th><td className={td}>{money(t.contado)}</td><td className={td}>{money(t.abonos)}</td><td className={td}>{money(t.total)}</td><td className={td}>100.0 %</td>
            </tr></tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
