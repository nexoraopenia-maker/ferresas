import Link from 'next/link'
import { fechaDiaCorta } from '@/lib/fecha-local'
import type { FilaMargen, InventarioValorizado, Margenes } from '../rentabilidad-calculo'
import type { DatosAbc } from '../rentabilidad-service'
import { ETIQUETA_REPORTE_COSTOS, TIPOS_REPORTE_COSTOS, type ParametrosCostos, type TipoReporteCostos } from '../schemas'
import { enlaceCsvRentabilidad, enlaceRentabilidad } from '../urls'

const money = (n: number) => `S/ ${n.toFixed(2)}`
const pct = (n: number) => `${n.toFixed(1)} %`
const cant = (n: number) => String(Number(n.toFixed(4)))
const th = 'px-3 py-2 text-right'
const td = 'px-3 py-2 text-right tabular-nums'

/** Cuántas filas se pintan: la descarga CSV trae todas. Una ferretería puede tener miles de productos y una página de miles de filas no sirve a nadie. */
export const LIMITE_FILAS = 200

export function PestanasCostos({ activa, params }: { activa: TipoReporteCostos; params: ParametrosCostos }) {
  return (
    <nav aria-label="Reportes de rentabilidad" className="flex flex-wrap gap-2">
      {TIPOS_REPORTE_COSTOS.map((t) => (
        <Link key={t} href={enlaceRentabilidad(t, params)} aria-current={t === activa ? 'page' : undefined} data-pestana={t}
          className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${t === activa ? 'border-industrial-600 bg-industrial-600 text-white' : 'border-hairline text-ink'}`}>
          {ETIQUETA_REPORTE_COSTOS[t]}
        </Link>
      ))}
    </nav>
  )
}

export function BarraDescargaCostos({ tipo, params, texto }: { tipo: TipoReporteCostos; params: ParametrosCostos; texto: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p data-periodo className="text-sm font-semibold text-ink">{texto}</p>
      <a href={enlaceCsvRentabilidad(tipo, params)} download data-enlace="csv" className="inline-flex h-touch items-center rounded-xl border border-hairline px-4 font-semibold text-ink">Descargar CSV</a>
    </div>
  )
}

function Tarjetas({ items }: { items: { k: string; v: string; fuerte?: boolean; alerta?: boolean }[] }) {
  return (
    <section aria-label="Resumen" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((i) => (
        <div key={i.k} className={`rounded-2xl border px-3 py-2 ${i.alerta ? 'border-stock-low/40 bg-stock-low-soft' : 'border-hairline bg-surface'}`}>
          <p className="text-xs text-ink-muted">{i.k}</p>
          <p className={`tabular-nums ${i.fuerte ? 'text-xl font-extrabold' : 'text-lg font-bold'} ${i.alerta ? 'text-stock-low' : 'text-ink'}`}>{i.v}</p>
        </div>
      ))}
    </section>
  )
}

const Vacio = ({ texto }: { texto: string }) => <p data-reporte="vacio" className="rounded-2xl border border-hairline bg-surface p-6 text-center text-sm text-ink-muted">{texto}</p>
const Recorte = ({ n, total }: { n: number; total: number }) => (total > n ? <p data-reporte="recorte" className="text-xs text-ink-muted">Se muestran los {n} primeros de {total}. La descarga CSV trae todos.</p> : null)

// ─── Margen ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function Cobertura({ m }: { m: Margenes['totales'] }) {
  if (m.lineas === 0) return null
  if (m.lineasSinCosto === 0) {
    return <p data-cobertura="completa" className="rounded-xl bg-stock-ok-soft px-3 py-2 text-sm font-semibold text-stock-ok">Todo lo vendido en el periodo tiene costo registrado: el margen cubre el 100 % de las ventas.</p>
  }
  return (
    <p role="alert" data-cobertura="parcial" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
      Solo el {pct(m.cobertura)} de lo vendido ({money(m.ventaConCosto)} de {money(m.ventaSinIgv)}, sin IGV) tiene costo registrado. El margen se calcula ÚNICAMENTE sobre esa parte:
      los {money(m.ventaSinCosto)} vendidos sin costo ({m.lineasSinCosto} {m.lineasSinCosto === 1 ? 'línea' : 'líneas'}) no entran, para no inventar un margen del 100 %.{' '}
      <Link href="/costos" className="underline">Completar costos pendientes</Link>
    </p>
  )
}

function MargenDe({ f }: { f: Pick<FilaMargen, 'margen' | 'cobertura' | 'lineasSinCosto'> }) {
  if (f.margen === null) return <span data-margen="sin" className="text-ink-muted">— <span className="rounded-full bg-surface-sunken px-1.5 text-xs">sin costo</span></span>
  return <span>{pct(f.margen)}{f.cobertura < 100 && <span data-margen="parcial" title={`El costo cubre el ${pct(f.cobertura)} de lo vendido`} className="ml-1 rounded-full bg-stock-low-soft px-1.5 text-xs font-semibold text-stock-low">costo parcial</span>}</span>
}

export function TablaMargen({ r }: { r: Margenes }) {
  const t = r.totales
  const vistos = r.filas.slice(0, LIMITE_FILAS)
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">Utilidad = venta sin IGV − costo, solo de las líneas cuyo costo se conocía al vender. El margen es utilidad entre venta (no sobre costo). Un costo de 0 se toma como «aún no se sabe», nunca como gratis.</p>
      <Cobertura m={t} />
      <Tarjetas items={[
        { k: 'Venta sin IGV', v: money(t.ventaSinIgv), fuerte: true }, { k: 'Utilidad (con costo)', v: money(t.utilidad) },
        { k: 'Margen (sobre lo que tiene costo)', v: t.margen === null ? '—' : pct(t.margen) }, { k: 'Cobertura de costo', v: t.lineas === 0 ? '—' : pct(t.cobertura), alerta: t.lineas > 0 && t.lineasSinCosto > 0 },
      ]} />
      {r.filas.length === 0 ? <Vacio texto="No hay ventas completadas en este periodo." /> : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
            <table data-reporte="margen" className="w-full min-w-[40rem] text-sm">
              <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted">
                <th scope="col" className="px-3 py-2 text-left">Producto</th><th scope="col" className={th}>Unidades</th><th scope="col" className={th}>Venta sin IGV</th>
                <th scope="col" className={th}>Costo</th><th scope="col" className={th}>Utilidad</th><th scope="col" className={th}>Margen</th><th scope="col" className={th}>Cobertura</th>
              </tr></thead>
              <tbody>
                {vistos.map((f) => (
                  <tr key={f.productId} data-fila={f.productId} className="border-b border-hairline last:border-0">
                    <th scope="row" className="px-3 py-2 text-left font-semibold text-ink">{f.nombre}<span className="block text-xs font-normal text-ink-muted">{f.sku}</span></th>
                    <td className={td}>{cant(f.unidades)} <span className="text-xs text-ink-muted">{f.unidad.toLowerCase()}</span></td><td className={`${td} font-bold text-ink`}>{money(f.ventaSinIgv)}</td>
                    <td className={td}>{f.costo > 0 ? money(f.costo) : '—'}</td><td className={`${td} ${f.margen !== null && f.utilidad < 0 ? 'font-bold text-stock-out' : ''}`}>{f.margen === null ? '—' : money(f.utilidad)}</td>
                    <td className={td}><MargenDe f={f} /></td><td className={td}>{pct(f.cobertura)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr data-reporte-total className="border-t-2 border-hairline font-bold text-ink">
                <th scope="row" className="px-3 py-2 text-left">Total</th><td className={td} /><td className={td}>{money(t.ventaSinIgv)}</td><td className={td}>{money(t.costo)}</td>
                <td className={td}>{money(t.utilidad)}</td><td className={td}>{t.margen === null ? '—' : pct(t.margen)}</td><td className={td}>{pct(t.cobertura)}</td>
              </tr></tfoot>
            </table>
          </div>
          <Recorte n={LIMITE_FILAS} total={r.filas.length} />
        </>
      )}
      {r.sinCosto.length > 0 && (
        <section aria-label="Ventas sin costo" data-reporte="sin-costo" className="flex flex-col gap-2">
          <h2 className="text-lg font-bold text-ink">Vendido sin costo ({r.sinCosto.length} {r.sinCosto.length === 1 ? 'producto' : 'productos'})</h2>
          <p className="text-xs text-ink-muted">Lo que más conviene completar primero: son las ventas que hoy no tienen margen.</p>
          <ul className="flex flex-col gap-1.5">
            {r.sinCosto.slice(0, 10).map((f) => (
              <li key={f.productId} className="flex items-center justify-between gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-sm">
                <span className="min-w-0 truncate font-semibold text-ink">{f.nombre} <span className="font-normal text-ink-muted">{f.sku}</span></span>
                <span className="shrink-0 tabular-nums text-stock-low">{money(f.ventaSinCosto)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

// ─── Inventario valorizado ──────────────────────────────────────────────────────────────────────────────────────────

export function TablaInventario({ r, fecha }: { r: InventarioValorizado; fecha: string }) {
  const t = r.totales
  const conStock = r.productos.filter((p) => p.cantidad > 0 || p.conSaldoNegativo)
  const vistos = conStock.slice(0, LIMITE_FILAS)
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">Al {fechaDiaCorta(fecha)}: cada saldo positivo por el costo promedio ACTUAL del producto, sin IGV. No hay valor histórico: es el de hoy. Lo que tiene stock pero no costo NO se valoriza (no se cuenta como cero).</p>
      {t.productosSinCosto > 0 && (
        <p role="alert" data-inventario="sin-costo" className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
          {t.productosSinCosto} {t.productosSinCosto === 1 ? 'producto tiene' : 'productos tienen'} stock ({cant(t.unidadesSinCosto)} unidades) pero no costo: no están en el valor de abajo, que por eso es MENOR que el real.{' '}
          <Link href="/costos" className="underline">Completar costos pendientes</Link>
        </p>
      )}
      <Tarjetas items={[
        { k: 'Valor del inventario', v: money(t.valor), fuerte: true }, { k: 'Productos con stock', v: String(t.productosConStock) },
        { k: 'Valorizados', v: `${t.productosValorizados} de ${t.productosConStock}`, alerta: t.productosSinCosto > 0 }, { k: 'Cobertura de costo', v: t.productosConStock === 0 ? '—' : pct(t.coberturaProductos), alerta: t.productosSinCosto > 0 },
      ]} />
      {t.productosConSaldoNegativo > 0 && <p data-inventario="negativos" className="text-xs font-semibold text-stock-low">{t.productosConSaldoNegativo} {t.productosConSaldoNegativo === 1 ? 'producto tiene' : 'productos tienen'} un saldo negativo en algún almacén: no se valoriza ni resta.</p>}
      {conStock.length === 0 ? <Vacio texto="No hay productos con stock en tus sucursales." /> : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
            <table data-reporte="inventario" className="w-full min-w-[32rem] text-sm">
              <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted">
                <th scope="col" className="px-3 py-2 text-left">Producto</th><th scope="col" className={th}>Cantidad</th><th scope="col" className={th}>Costo unitario</th><th scope="col" className={th}>Valor</th>
              </tr></thead>
              <tbody>
                {vistos.map((p) => (
                  <tr key={p.productId} data-fila={p.productId} className="border-b border-hairline last:border-0">
                    <th scope="row" className="px-3 py-2 text-left font-semibold text-ink">{p.nombre}<span className="block text-xs font-normal text-ink-muted">{p.sku}{p.eliminado ? ' · dado de baja' : ''}</span></th>
                    <td className={td}>{cant(p.cantidad)} <span className="text-xs text-ink-muted">{p.unidad.toLowerCase()}</span></td>
                    <td className={td}>{p.sinCosto ? '—' : money(p.costoUnitario)}</td>
                    <td className={`${td} font-bold text-ink`}>{p.valor === null ? <span data-inventario="fila-sin-costo" className="rounded-full bg-stock-low-soft px-2 text-xs font-semibold text-stock-low">sin costo</span> : money(p.valor)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr data-reporte-total className="border-t-2 border-hairline font-bold text-ink"><th scope="row" className="px-3 py-2 text-left">Total valorizado</th><td className={td} /><td className={td} /><td className={td}>{money(t.valor)}</td></tr></tfoot>
            </table>
          </div>
          <Recorte n={LIMITE_FILAS} total={conStock.length} />
        </>
      )}
      {r.almacenes.length > 0 && (
        <section aria-label="Por almacén" className="flex flex-col gap-2">
          <h2 className="text-lg font-bold text-ink">Por almacén</h2>
          <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
            <table data-reporte="almacenes" className="w-full min-w-[26rem] text-sm">
              <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted"><th scope="col" className="px-3 py-2 text-left">Almacén</th><th scope="col" className={th}>Productos</th><th scope="col" className={th}>Valor</th></tr></thead>
              <tbody>
                {r.almacenes.map((a) => (
                  <tr key={a.almacenId} data-almacen={a.almacenId} className="border-b border-hairline last:border-0">
                    <th scope="row" className="px-3 py-2 text-left font-semibold text-ink">{a.almacen}</th><td className={td}>{a.productos}</td><td className={`${td} font-bold text-ink`}>{money(a.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

// ─── ABC ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const COLOR_CLASE = { A: 'bg-stock-ok-soft text-stock-ok', B: 'bg-stock-low-soft text-stock-low', C: 'bg-surface-sunken text-ink-muted' } as const

export function TablaAbc({ r }: { r: DatosAbc }) {
  const vistos = r.filas.slice(0, LIMITE_FILAS)
  const etiquetaValor = r.base === 'VENTAS' ? 'Venta sin IGV' : 'Utilidad'
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">
        Se ordenan los productos de mayor a menor {r.base === 'VENTAS' ? 'venta sin IGV' : 'utilidad'} y se acumula su participación: <b>A</b> reúne hasta el {r.umbrales.a} % del total, <b>B</b> hasta el {r.umbrales.b} % y <b>C</b> el resto.
        El producto que cruza un umbral se queda en la clase que está llenando. Lo que no vendió o perdió dinero va a C y no suma al total.
      </p>
      {r.base === 'UTILIDAD' && (
        <p data-abc="cobertura" className={`rounded-xl px-3 py-2 text-sm font-semibold ${r.sinClasificar > 0 ? 'bg-stock-low-soft text-stock-low' : 'bg-stock-ok-soft text-stock-ok'}`} role={r.sinClasificar > 0 ? 'alert' : undefined}>
          {r.sinClasificar > 0
            ? `${r.sinClasificar} ${r.sinClasificar === 1 ? 'producto vendido no tiene' : 'productos vendidos no tienen'} costo: no se pueden clasificar por utilidad y no aparecen aquí (no se mandan a C como si rindieran poco). Cobertura de costo de las ventas: ${pct(r.cobertura)}.`
            : 'Todos los productos vendidos tienen costo: la clasificación por utilidad los cubre a todos.'}
        </p>
      )}
      {r.filas.length === 0 ? <Vacio texto={r.base === 'UTILIDAD' ? 'No hay productos vendidos con costo en este periodo.' : 'No hay ventas completadas en este periodo.'} /> : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
            <table data-reporte="abc-resumen" className="w-full min-w-[26rem] text-sm">
              <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted">
                <th scope="col" className="px-3 py-2 text-left">Clase</th><th scope="col" className={th}>Productos</th><th scope="col" className={th}>% de productos</th><th scope="col" className={th}>{etiquetaValor}</th><th scope="col" className={th}>% del total</th>
              </tr></thead>
              <tbody>
                {r.resumen.map((x) => (
                  <tr key={x.clase} data-clase={x.clase} className="border-b border-hairline last:border-0">
                    <th scope="row" className="px-3 py-2 text-left"><span className={`rounded-full px-2.5 py-0.5 font-bold ${COLOR_CLASE[x.clase]}`}>{x.clase}</span></th>
                    <td className={td}>{x.productos}</td><td className={td}>{pct(x.participacionProductos)}</td><td className={`${td} font-bold text-ink`}>{money(x.valor)}</td><td className={td}>{pct(x.participacionValor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
            <table data-reporte="abc" className="w-full min-w-[34rem] text-sm">
              <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted">
                <th scope="col" className={th}>#</th><th scope="col" className="px-3 py-2 text-left">Producto</th><th scope="col" className={th}>{etiquetaValor}</th><th scope="col" className={th}>Participación</th><th scope="col" className={th}>Acumulado</th><th scope="col" className={th}>Clase</th>
              </tr></thead>
              <tbody>
                {vistos.map((f) => (
                  <tr key={f.id} data-fila={f.id} className="border-b border-hairline last:border-0">
                    <td className={td}>{f.posicion}</td><th scope="row" className="px-3 py-2 text-left font-semibold text-ink">{f.nombre}<span className="block text-xs font-normal text-ink-muted">{f.sku}</span></th>
                    <td className={`${td} ${f.valor < 0 ? 'text-stock-out' : ''}`}>{money(f.valor)}</td><td className={td}>{pct(f.participacion)}</td><td className={td}>{pct(f.acumulado)}</td>
                    <td className={td}><span className={`rounded-full px-2.5 py-0.5 font-bold ${COLOR_CLASE[f.clase]}`}>{f.clase}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Recorte n={LIMITE_FILAS} total={r.filas.length} />
        </>
      )}
    </div>
  )
}
