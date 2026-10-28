import Link from 'next/link'
import { formatQuantity, unitLabel } from '@/lib/quantity'
import type { AlertaStock, ProductoTop, RendimientoCaja, TotalPeriodo, VentasDelDia } from '../service'

export const soles = (n: number) =>
  new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(n)

/** Tarjeta de un periodo: el número grande, y debajo el detalle. */
export function KpiVentas({
  titulo, datos, destacado = false,
}: { titulo: string; datos: TotalPeriodo; destacado?: boolean }) {
  return (
    <div
      className={`rounded-2xl p-4 shadow-sm ${
        destacado
          ? 'bg-brand-gradient text-white shadow-industrial-600/25'
          : 'border border-hairline bg-surface'
      }`}
    >
      <p className={`text-xs font-bold uppercase tracking-wide ${destacado ? 'text-white/85' : 'text-ink-muted'}`}>
        {titulo}
      </p>
      <p className={`mt-1 text-2xl font-extrabold tabular-nums ${destacado ? '' : 'text-ink'}`}>
        {soles(datos.total)}
      </p>
      <p className={`mt-0.5 text-xs ${destacado ? 'text-white/85' : 'text-ink-muted'}`}>
        {datos.ventas} {datos.ventas === 1 ? 'venta' : 'ventas'}
        {datos.ventas > 0 && ` · ticket ${soles(datos.ticketPromedio)}`}
      </p>
    </div>
  )
}

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']

/** Barras de los últimos 7 días. Sin librería: cada barra lleva su monto en texto. */
export function GraficoSemana({ dias }: { dias: VentasDelDia[] }) {
  const max = Math.max(1, ...dias.map((d) => d.total))
  const total = dias.reduce((s, d) => s + d.total, 0)
  return (
    <section className="rounded-2xl border border-hairline bg-surface p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-bold text-ink">Últimos 7 días</h2>
        <p className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">{soles(total)}</p>
      </div>
      {total === 0 ? (
        <p className="mt-6 rounded-xl bg-surface-sunken px-3 py-6 text-center text-sm text-ink-muted">
          Todavía no hay ventas esta semana. En cuanto cobres la primera, aparece aquí.
        </p>
      ) : (
        <ol className="mt-4 flex h-40 items-end gap-2" aria-label="Ventas por día">
          {dias.map((d, i) => {
            const alto = Math.max(4, Math.round((d.total / max) * 100))
            const hoy = i === dias.length - 1
            const fecha = new Date(`${d.dia}T12:00:00Z`)
            return (
              <li key={d.dia} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                <span className="text-[0.625rem] font-semibold tabular-nums text-ink-muted">
                  {d.total > 0 ? Math.round(d.total) : ''}
                </span>
                <div
                  title={`${d.dia}: ${soles(d.total)}`}
                  style={{ height: `${alto}%` }}
                  className={`w-full rounded-t-lg ${hoy ? 'bg-accent-500' : 'bg-industrial-500'}`}
                />
                <span className={`text-[0.6875rem] font-bold ${hoy ? 'text-accent-700 dark:text-accent-300' : 'text-ink-muted'}`}>
                  {DIAS[fecha.getUTCDay()]}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

export function TopProductos({ items }: { items: ProductoTop[] }) {
  const max = Math.max(1, ...items.map((i) => i.total))
  return (
    <section className="rounded-2xl border border-hairline bg-surface p-4 shadow-sm">
      <h2 className="font-bold text-ink">Más vendidos del mes</h2>
      {items.length === 0 ? (
        <p className="mt-4 rounded-xl bg-surface-sunken px-3 py-5 text-center text-sm text-ink-muted">
          Aún no hay ventas este mes.
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-3">
          {items.map((p, i) => (
            <li key={p.productId}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 truncate font-semibold text-ink">
                  <span className="mr-1.5 text-accent-600 dark:text-accent-400">{i + 1}.</span>{p.nombre}
                </span>
                <span className="shrink-0 font-bold tabular-nums text-ink">{soles(p.total)}</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-industrial-100 dark:bg-graphite-800">
                <div className="h-full rounded-full bg-industrial-500" style={{ width: `${(p.total / max) * 100}%` }} />
              </div>
              <p className="mt-0.5 text-xs text-ink-muted">{formatQuantity(p.cantidad, 'UNIDAD')} vendidas</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export function CajaWidget({ caja }: { caja: RendimientoCaja }) {
  const hora = (d: Date) =>
    new Intl.DateTimeFormat('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Lima' }).format(d)
  return (
    <section className="rounded-2xl border border-hairline bg-surface p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-bold text-ink">Caja</h2>
        <Link href="/caja" className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">Ir a caja →</Link>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-industrial-50 p-3 dark:bg-graphite-800">
          <p className="text-xs font-bold uppercase tracking-wide text-industrial-800 dark:text-industrial-200">Abiertas ahora</p>
          <p className="mt-1 text-2xl font-extrabold text-industrial-800 dark:text-industrial-200">{caja.abiertos.length}</p>
        </div>
        <div
          className={`rounded-xl p-3 ${
            caja.descuadreHoy === 0 ? 'bg-stock-ok-soft text-stock-ok' : 'bg-stock-out-soft text-stock-out'
          }`}
        >
          <p className="text-xs font-bold uppercase tracking-wide">Descuadre de hoy</p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums">{soles(caja.descuadreHoy)}</p>
          <p className="text-xs font-semibold">{caja.descuadreHoy === 0 ? 'Cuadrado' : caja.descuadreHoy < 0 ? 'Faltante' : 'Sobrante'}</p>
        </div>
      </div>
      {caja.abiertos.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {caja.abiertos.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-semibold text-ink">{t.sucursal}</span>
                <span className="text-ink-muted"> · {t.abiertoPor} desde {hora(t.abiertaEn)}</span>
              </span>
              <span className="shrink-0 font-bold tabular-nums text-ink">{soles(t.ventas)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function AlertasStockWidget({
  agotados, criticos, items, completo = false,
}: { agotados: number; criticos: number; items: AlertaStock[]; completo?: boolean }) {
  const total = agotados + criticos
  return (
    <section className="rounded-2xl border border-hairline bg-surface p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-bold text-ink">Alertas de stock</h2>
        {!completo && total > 0 && (
          <Link href="/inventario/alertas" className="text-sm font-semibold text-industrial-700 dark:text-industrial-300">
            Ver todas ({total}) →
          </Link>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-stock-out-soft p-3 text-stock-out">
          <p className="text-xs font-bold uppercase tracking-wide">Agotados</p>
          <p className="mt-1 text-2xl font-extrabold">{agotados}</p>
        </div>
        <div className="rounded-xl bg-stock-low-soft p-3 text-stock-low">
          <p className="text-xs font-bold uppercase tracking-wide">En su mínimo</p>
          <p className="mt-1 text-2xl font-extrabold">{criticos}</p>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="mt-3 rounded-xl bg-stock-ok-soft px-3 py-4 text-center text-sm font-semibold text-stock-ok">
          Todo el inventario está sobre su mínimo.
        </p>
      ) : !completo ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {items.map((a) => (
            <li key={a.clave}>
              <Link
                href={`/inventario/alertas#${a.clave}`}
                className="flex items-center justify-between gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-sm hover:bg-industrial-50 dark:hover:bg-graphite-800"
              >
                <span className="min-w-0 truncate font-semibold text-ink">
                  {a.nombre}
                  {a.almacen && <span className="font-normal text-ink-muted"> · {a.almacen}</span>}
                </span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${
                  a.estado === 'OUT' ? 'bg-stock-out-soft text-stock-out' : 'bg-stock-low-soft text-stock-low'
                }`}>
                  {a.estado === 'OUT' ? 'Agotado' : `${formatQuantity(a.stock, a.unitType)} / ${formatQuantity(a.minimo, a.unitType)} ${unitLabel(a.unitType)}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/**
 * Lo que espera una decisión: mermas por revisar y costos por completar.
 * Solo aparece para quien puede actuar sobre ello; un número en cero se queda
 * en gris para no pedir atención por nada.
 */
export function PendientesWidget({
  mermas, costos,
}: { mermas: number | null; costos: number | null }) {
  const tarjetas = [
    mermas !== null && { href: '/mermas', titulo: 'Mermas por revisar', n: mermas, ayuda: 'Pérdidas que alguien pidió dar de baja' },
    costos !== null && { href: '/costos', titulo: 'Costos por completar', n: costos, ayuda: 'Entradas registradas sin costo' },
  ].filter(Boolean) as { href: string; titulo: string; n: number; ayuda: string }[]
  if (tarjetas.length === 0) return null

  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Pendientes">
      {tarjetas.map((t) => (
        <Link
          key={t.href} href={t.href}
          className={`flex items-center justify-between gap-3 rounded-2xl border p-4 shadow-sm transition hover:shadow-md ${
            t.n > 0 ? 'border-accent-500/50 bg-accent-50' : 'border-hairline bg-surface'
          }`}
        >
          <span className="min-w-0">
            <span className={`block text-xs font-bold uppercase tracking-wide ${t.n > 0 ? 'text-accent-800' : 'text-ink-muted'}`}>{t.titulo}</span>
            <span className={`block text-xs ${t.n > 0 ? 'text-accent-900' : 'text-ink-muted'}`}>{t.ayuda}</span>
          </span>
          <span className={`shrink-0 text-3xl font-extrabold tabular-nums ${t.n > 0 ? 'text-accent-700' : 'text-ink-muted'}`}>{t.n}</span>
        </Link>
      ))}
    </section>
  )
}
