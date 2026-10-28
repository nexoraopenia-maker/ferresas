import { formatearFechaLocal } from '@/lib/fecha-local'
import { formatQuantity } from '@/lib/quantity'
import type { KardexResultado, LineaKardex } from '../kardex-service'
import { AYUDA_ORIGEN_COSTO, ETIQUETA_ORIGEN_COSTO, enlaceCsvKardex, enlaceKardex, etiquetaMovimiento, textoDocumento, type FiltrosKardexUrl } from '../kardex-enlaces'

/**
 * El kardex en pantalla (F6.4c). Presentacional: recibe el resultado del servicio y no consulta nada. Las columnas de valor SOLO existen si el servicio
 * mandó costos (`conCostos`): quien no ve costos no recibe ni las cifras ni sus encabezados. El saldo inicial va arriba (primera página) y los totales abajo
 * (última página); el resumen del rango completo, siempre.
 */

const money = (n: number) => `S/ ${new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`
const dash = '—'

const ESTILO_ALERTA: Record<string, string> = {
  STOCK_NEGATIVO: 'border-stock-out/40 bg-stock-out-soft text-stock-out',
  NO_CUADRA: 'border-stock-out/40 bg-stock-out-soft text-stock-out',
  LIBRO_INCONSISTENTE: 'border-stock-out/40 bg-stock-out-soft text-stock-out',
  COSTO_PENDIENTE: 'border-stock-low/40 bg-stock-low-soft text-stock-low',
  SIN_COSTO: 'border-stock-low/40 bg-stock-low-soft text-stock-low',
}

export function KardexResumen({ k, filtros }: { k: KardexResultado; filtros: FiltrosKardexUrl }) {
  const u = k.producto.unidad
  const q = (n: number) => formatQuantity(n, u)
  const csv = enlaceCsvKardex({ ...filtros, desde: k.desde, hasta: k.hasta })
  const cuadra = k.totales.cuadraConStock
  return (
    <section data-kardex="resumen" className="rounded-2xl border border-hairline bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-bold text-ink">{k.producto.nombre}</h2>
          <p className="font-mono text-xs text-ink-muted">{k.producto.sku}</p>
          <p className="mt-1 text-sm text-ink-muted">
            Del {k.desde} al {k.hasta} · {k.almacenElegido ? k.almacenes.find((a) => a.id === k.almacenElegido)?.nombre ?? 'Almacén' : 'Todos mis almacenes'}
          </p>
        </div>
        {csv && (
          <a data-kardex="csv" href={csv} download className="inline-flex h-touch items-center rounded-xl border border-hairline px-4 text-sm font-semibold text-ink">
            Descargar CSV
          </a>
        )}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Dato k="Saldo inicial" v={q(k.saldoInicial.cantidad)} />
        <Dato k="Entradas" v={`+ ${q(k.totales.entradas)}`} />
        <Dato k="Salidas" v={`- ${q(k.totales.salidas)}`} />
        <Dato k="Saldo final" v={q(k.totales.saldoFinal)} fuerte />
        <Dato k="Movimientos" v={String(k.totales.movimientos)} />
        <Dato k="Stock actual" v={q(k.totales.stockActual)} />
        <div className="col-span-2" data-kardex="cuadre">
          <dt className="text-xs text-ink-muted">Cuadre con el stock</dt>
          <dd className={`font-semibold ${cuadra === false ? 'text-stock-out' : cuadra ? 'text-stock-ok' : 'text-ink-muted'}`}>
            {cuadra === null ? 'Hay movimientos posteriores a este rango' : cuadra ? 'Cuadra con el stock actual' : 'No cuadra con el stock actual'}
          </dd>
        </div>
        {k.conCostos && (
          <>
            <Dato k="Costo promedio" v={k.totales.costos?.costoPromedio == null ? dash : money(k.totales.costos.costoPromedio)} />
            <Dato k="Saldo final valorizado" v={k.totales.costos?.saldoFinalValorizado == null ? dash : money(k.totales.costos.saldoFinalValorizado)} fuerte />
          </>
        )}
      </dl>
      {!k.conCostos && (
        <p data-kardex="sin-costos" className="mt-3 text-xs text-ink-muted">Ves el kardex en unidades. Para ver costos y valores hace falta el permiso «Ver costos y márgenes».</p>
      )}
    </section>
  )
}

export function KardexAlertas({ k }: { k: KardexResultado }) {
  if (k.alertas.length === 0) return null
  return (
    <ul data-kardex="alertas" className="flex flex-col gap-2">
      {k.alertas.map((a) => (
        <li key={a.codigo} role="alert" data-alerta={a.codigo} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${ESTILO_ALERTA[a.codigo] ?? 'border-hairline bg-surface text-ink'}`}>
          {a.mensaje}
        </li>
      ))}
    </ul>
  )
}

export function KardexTabla({ k, filtros, primeraPagina }: { k: KardexResultado; filtros: FiltrosKardexUrl; primeraPagina: boolean }) {
  const u = k.producto.unidad
  const q = (n: number) => formatQuantity(n, u)
  const consolidado = !k.almacenElegido && k.almacenes.length > 1
  const ultimaPagina = k.siguiente === null
  const cols = 6 + (consolidado ? 1 : 0) + (k.conCostos ? 5 : 0)
  const siguiente = k.siguiente ? enlaceKardex({ ...filtros, desde: k.desde, hasta: k.hasta, cursor: k.siguiente }) : null
  const inicio = enlaceKardex({ ...filtros, desde: k.desde, hasta: k.hasta, cursor: undefined })

  return (
    <section data-kardex="tabla" className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              <th className="px-3 py-2">Fecha</th>
              {consolidado && <th className="px-3 py-2">Almacén</th>}
              <th className="px-3 py-2">Movimiento</th>
              <th className="px-3 py-2">Documento</th>
              <th className="px-3 py-2 text-right">Entrada</th>
              <th className="px-3 py-2 text-right">Salida</th>
              <th className="px-3 py-2 text-right">Saldo</th>
              {k.conCostos && (
                <>
                  <th className="px-3 py-2 text-right">Costo unit.</th>
                  <th className="px-3 py-2 text-right">Valor</th>
                  <th className="px-3 py-2 text-right">Costo prom.</th>
                  <th className="px-3 py-2 text-right">Saldo valorizado</th>
                  <th className="px-3 py-2">Costo</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {primeraPagina && (
              <tr data-kardex="saldo-inicial" className="bg-surface-sunken font-semibold">
                <td className="px-3 py-2" colSpan={cols - 1 - (k.conCostos ? 5 : 0)}>Saldo inicial al {k.desde}</td>
                <td className="px-3 py-2 text-right">{q(k.saldoInicial.cantidad)}</td>
                {k.conCostos && (
                  <>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2 text-right">{k.saldoInicial.costos?.costoPromedio == null ? dash : money(k.saldoInicial.costos.costoPromedio)}</td>
                    <td className="px-3 py-2 text-right">{k.saldoInicial.costos?.valorizado == null ? dash : money(k.saldoInicial.costos.valorizado)}</td>
                    <td className="px-3 py-2">{k.saldoInicial.costos?.origen ? ETIQUETA_ORIGEN_COSTO[k.saldoInicial.costos.origen] : ''}</td>
                  </>
                )}
              </tr>
            )}
            {k.lineas.length === 0 && (
              <tr data-kardex="vacio"><td className="px-3 py-6 text-center text-ink-muted" colSpan={cols}>No hubo movimientos de este producto en el rango.</td></tr>
            )}
            {k.lineas.map((l) => <Fila key={l.id} l={l} k={k} consolidado={consolidado} q={q} />)}
            {ultimaPagina && (
              <tr data-kardex="totales" className="bg-surface-sunken font-semibold">
                <td className="px-3 py-2" colSpan={3 + (consolidado ? 1 : 0)}>Totales del periodo</td>
                <td className="px-3 py-2 text-right">{q(k.totales.entradas)}</td>
                <td className="px-3 py-2 text-right">{q(k.totales.salidas)}</td>
                <td className="px-3 py-2 text-right">{q(k.totales.saldoFinal)}</td>
                {k.conCostos && (
                  <>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2 text-right">{k.totales.costos?.costoPromedio == null ? dash : money(k.totales.costos.costoPromedio)}</td>
                    <td className="px-3 py-2 text-right">{k.totales.costos?.saldoFinalValorizado == null ? dash : money(k.totales.costos.saldoFinalValorizado)}</td>
                    <td className="px-3 py-2" />
                  </>
                )}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {(siguiente || !primeraPagina) && (
        <nav data-kardex="paginas" className="flex items-center justify-between gap-3 text-sm font-semibold">
          {!primeraPagina ? <a data-kardex="inicio" href={inicio} className="text-industrial-700 dark:text-industrial-300">← Volver al inicio</a> : <span />}
          {siguiente ? <a data-kardex="siguiente" href={siguiente} className="rounded-xl border border-hairline px-4 py-2 text-ink">Ver más movimientos →</a> : <span />}
        </nav>
      )}
    </section>
  )
}

function Fila({ l, k, consolidado, q }: { l: LineaKardex; k: KardexResultado; consolidado: boolean; q: (n: number) => string }) {
  const doc = textoDocumento(l.documento)
  return (
    <tr data-kardex="linea" data-negativo={l.stockNegativo ? 'si' : 'no'} data-descuadre={l.descuadre ? 'si' : 'no'} className={l.stockNegativo || l.descuadre ? 'bg-stock-out-soft/40' : ''}>
      <td className="whitespace-nowrap px-3 py-2 text-ink-muted">{formatearFechaLocal(l.cuando, k.zonaHoraria)}</td>
      {consolidado && <td className="px-3 py-2">{l.almacen.nombre}</td>}
      <td className="px-3 py-2">
        <span className="font-medium text-ink">{etiquetaMovimiento(l)}</span>
        {l.motivo && <span className="block text-xs text-ink-muted">{l.motivo}</span>}
        {l.presentacion && <span className="block text-xs text-ink-muted">{l.presentacion.cantidad} × {l.presentacion.nombre}</span>}
        {l.stockNegativo && <span data-kardex="negativo" className="mt-1 inline-block rounded-full bg-stock-out-soft px-2 py-0.5 text-xs font-bold text-stock-out">Stock negativo</span>}
        {l.descuadre && <span data-kardex="descuadre" className="mt-1 inline-block rounded-full bg-stock-out-soft px-2 py-0.5 text-xs font-bold text-stock-out">Saldo no coincide</span>}
      </td>
      <td className="px-3 py-2">{l.documento.href ? <a href={l.documento.href} className="font-semibold text-industrial-700 underline dark:text-industrial-300">{doc}</a> : doc || dash}</td>
      <td className="px-3 py-2 text-right">{l.entrada > 0 ? q(l.entrada) : ''}</td>
      <td className="px-3 py-2 text-right">{l.salida > 0 ? q(l.salida) : ''}</td>
      <td className={`px-3 py-2 text-right font-semibold ${l.saldo < 0 ? 'text-stock-out' : 'text-ink'}`}>{q(l.saldo)}</td>
      {l.costos && (
        <>
          <td className="px-3 py-2 text-right">{l.costos.costoUnitario === null ? dash : money(l.costos.costoUnitario)}</td>
          <td className="px-3 py-2 text-right">{l.costos.valor === null ? dash : money(l.costos.valor)}</td>
          <td className="px-3 py-2 text-right">{l.costos.costoPromedio === null ? dash : money(l.costos.costoPromedio)}</td>
          <td className="px-3 py-2 text-right">{l.costos.saldoValorizado === null ? dash : money(l.costos.saldoValorizado)}</td>
          <td className="px-3 py-2">
            <span title={AYUDA_ORIGEN_COSTO[l.costos.origen]} data-origen={l.costos.origen} className={`rounded-full px-2 py-0.5 text-xs font-bold ${l.costos.origen === 'EXACTO' ? 'bg-stock-ok-soft text-stock-ok' : l.costos.origen === 'RECONSTRUIDO' ? 'bg-stock-low-soft text-stock-low' : 'bg-surface-sunken text-ink-muted'}`}>
              {ETIQUETA_ORIGEN_COSTO[l.costos.origen]}
            </span>
            {l.costos.pendiente && <span data-kardex="pendiente" className="ml-1 rounded-full bg-stock-low-soft px-2 py-0.5 text-xs font-bold text-stock-low">Costo pendiente</span>}
          </td>
        </>
      )}
    </tr>
  )
}

function Dato({ k, v, fuerte = false }: { k: string; v: string; fuerte?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{k}</dt>
      <dd className={fuerte ? 'text-base font-bold text-ink' : 'font-semibold text-ink'}>{v}</dd>
    </div>
  )
}
