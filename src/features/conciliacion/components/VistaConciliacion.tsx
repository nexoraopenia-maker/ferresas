import Link from 'next/link'
import { ETIQUETA_MODO } from '@/features/invoicing/modo-fiscal'
import type { ParametrosRegistros } from '@/features/registros/schemas'
import { ETIQUETA_PUENTE, UMBRAL_ADVERTENCIA_HORAS, UMBRAL_ERROR_HORAS, type EstadoGeneral, type Hallazgo, type InformeConciliacion, type Nivel } from '../conciliacion-calculo'
import { enlaceCsvConciliacion } from '../urls'

const money = (n: number) => `${n < 0 ? '−' : ''}S/ ${Math.abs(n).toFixed(2)}`
const th = 'px-3 py-2 text-right'
const td = 'px-3 py-2 text-right tabular-nums'
/** Cuántos ejemplos de cada hallazgo se muestran; el CSV trae todos. */
export const EJEMPLOS_POR_HALLAZGO = 10

const ESTILO_ESTADO: Record<EstadoGeneral, string> = {
  SIN_COMPROBANTES: 'bg-surface-sunken text-ink', LIMPIO: 'bg-stock-ok-soft text-stock-ok', ADVERTENCIAS: 'bg-stock-low-soft text-stock-low', ERRORES: 'bg-stock-out-soft text-stock-out',
}
const ESTILO_NIVEL: Record<Nivel, string> = { ERROR: 'bg-stock-out-soft text-stock-out', ADVERTENCIA: 'bg-stock-low-soft text-stock-low', INFO: 'bg-surface-sunken text-ink-muted' }
const ETIQUETA_NIVEL: Record<Nivel, string> = { ERROR: 'Error', ADVERTENCIA: 'Advertencia', INFO: 'Información' }

export function BarraDescargaConciliacion({ params, texto }: { params: ParametrosRegistros; texto: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p data-periodo className="text-sm font-semibold text-ink">{texto}</p>
      <a href={enlaceCsvConciliacion(params)} download data-enlace="csv" className="inline-flex h-touch items-center rounded-xl border border-hairline px-4 font-semibold text-ink">Descargar CSV</a>
    </div>
  )
}

function TarjetaHallazgo({ h }: { h: Hallazgo }) {
  const vistos = h.items.slice(0, EJEMPLOS_POR_HALLAZGO)
  return (
    <li data-hallazgo={h.codigo} data-nivel={h.nivel} className="rounded-2xl border border-hairline bg-surface">
      <details className="group" open={h.nivel === 'ERROR'}>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${ESTILO_NIVEL[h.nivel]}`}>{ETIQUETA_NIVEL[h.nivel]}</span>
          <span className="min-w-0 flex-1 font-semibold text-ink">{h.titulo}</span>
          <span className="shrink-0 text-xs tabular-nums text-ink-muted">{h.cantidad > 0 ? `${h.cantidad} ${h.cantidad === 1 ? 'caso' : 'casos'}` : ''}{h.importe !== 0 ? ` · ${money(h.importe)}` : ''}</span>
        </summary>
        <div className="flex flex-col gap-2 border-t border-hairline px-3 py-3 text-sm">
          <p className="text-ink-muted">{h.explicacion}</p>
          {vistos.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {vistos.map((it, k) => (
                <li key={`${it.referencia}-${k}`} data-item className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-sunken px-3 py-2">
                  <span className="min-w-0"><b className="text-ink">{it.referencia}</b> <span className="text-ink-muted">{it.detalle}</span></span>
                  <span className="flex shrink-0 items-center gap-3">
                    {it.importe !== null && <span className="tabular-nums text-ink">{money(it.importe)}</span>}
                    {it.enlace && <Link href={it.enlace} className="text-xs font-semibold text-industrial-600 underline">Abrir</Link>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {h.items.length > vistos.length && <p data-hallazgo-recorte className="text-xs text-ink-muted">Se muestran {vistos.length} de {h.items.length}. La descarga CSV trae todos.</p>}
        </div>
      </details>
    </li>
  )
}

export function VistaConciliacion({ r }: { r: InformeConciliacion }) {
  const p = r.puente
  const conAlerta = r.estado === 'ERRORES' || r.estado === 'ADVERTENCIAS'
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Resultado" data-conciliacion={r.estado} role={conAlerta ? 'alert' : 'status'} className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl px-4 py-3 ${ESTILO_ESTADO[r.estado]}`}>
        <p className="text-lg font-bold">{r.mensaje}</p>
        <p className="text-sm font-semibold">Modo: {ETIQUETA_MODO[r.modo]}{r.resumen.errores + r.resumen.advertencias > 0 ? ` · ${r.resumen.errores} ${r.resumen.errores === 1 ? 'error' : 'errores'} · ${r.resumen.advertencias} ${r.resumen.advertencias === 1 ? 'advertencia' : 'advertencias'}` : ''}</p>
      </section>

      <section aria-label="Puente de ventas a comprobantes" className="flex flex-col gap-2">
        <h2 className="text-lg font-bold text-ink">De las ventas al registro</h2>
        <p className="text-xs text-ink-muted">Cada venta completada del periodo cae en una sola fila. Lo que no es comprobante por diseño (notas de venta) se separa; lo demás se clasifica por el estado de su comprobante. La diferencia sin explicar debe ser cero.</p>
        <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
          <table data-reporte="puente" className="w-full min-w-[26rem] text-sm">
            <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted"><th scope="col" className="px-3 py-2 text-left">Concepto</th><th scope="col" className={th}>Ventas</th><th scope="col" className={th}>Importe</th></tr></thead>
            <tbody>
              <tr data-puente="completadas" className="border-b border-hairline font-bold text-ink"><th scope="row" className="px-3 py-2 text-left">Ventas completadas</th><td className={td}>{p.ventasCompletadas.documentos}</td><td className={td}>{money(p.ventasCompletadas.total)}</td></tr>
              <tr data-puente="notas-de-venta" className="border-b border-hairline text-ink-muted"><th scope="row" className="px-3 py-2 text-left font-normal">− Notas de venta (sin comprobante por diseño)</th><td className={td}>{p.notasDeVenta.documentos}</td><td className={td}>{money(p.notasDeVenta.total)}</td></tr>
              <tr data-puente="con-comprobante" className="border-b border-hairline font-semibold text-ink"><th scope="row" className="px-3 py-2 text-left">= Ventas con comprobante emitido o pedido</th><td className={td}>{p.conComprobante.documentos}</td><td className={td}>{money(p.conComprobante.total)}</td></tr>
              {(['valido', 'pendiente', 'rechazado', 'anulado', 'ensayo', 'sinComprobante'] as const).map((k) => (
                <tr key={k} data-puente={k} className={`border-b border-hairline ${p.clasificacion[k].documentos === 0 ? 'text-ink-muted' : 'text-ink'}`}>
                  <th scope="row" className="px-3 py-2 pl-7 text-left font-normal">{ETIQUETA_PUENTE[k]}</th><td className={td}>{p.clasificacion[k].documentos}</td><td className={td}>{money(p.clasificacion[k].total)}</td>
                </tr>
              ))}
              <tr data-puente="diferencia" className={`border-b border-hairline font-bold ${p.diferencia === 0 ? 'text-stock-ok' : 'text-stock-out'}`}><th scope="row" className="px-3 py-2 text-left">Diferencia sin explicar</th><td className={td} /><td className={td}>{money(p.diferencia)}</td></tr>
              <tr data-puente="anuladas" className="border-b border-hairline text-ink-muted"><th scope="row" className="px-3 py-2 text-left font-normal">Ventas anuladas del periodo (no suman)</th><td className={td}>{p.anuladas.documentos}</td><td className={td}>{money(p.anuladas.total)}</td></tr>
              <tr data-puente="devueltas" className="text-ink-muted"><th scope="row" className="px-3 py-2 text-left font-normal">Ventas devueltas del periodo (no suman)</th><td className={td}>{p.devueltas.documentos}</td><td className={td}>{money(p.devueltas.total)}</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Cuadre con los registros" className="flex flex-col gap-2">
        <h2 className="text-lg font-bold text-ink">Los registros contra la base</h2>
        <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
          <table data-reporte="cuadre" className="w-full min-w-[26rem] text-sm">
            <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted"><th scope="col" className="px-3 py-2 text-left">Registro</th><th scope="col" className={th}>Registro</th><th scope="col" className={th}>Cálculo independiente</th><th scope="col" className={th}>Diferencia</th></tr></thead>
            <tbody>
              {([['ventas', 'Ventas', r.cuadreVentas], ['compras', 'Compras', r.cuadreCompras]] as const).map(([k, nombre, q]) => (
                <tr key={k} data-cuadre={k} className="border-b border-hairline last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-semibold text-ink">{nombre}</th><td className={td}>{money(q.registro)}</td><td className={td}>{money(q.independiente)}</td>
                  <td className={`${td} font-bold ${q.diferencia === 0 ? 'text-stock-ok' : 'text-stock-out'}`}>{money(q.diferencia)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Hallazgos" className="flex flex-col gap-2">
        <h2 className="text-lg font-bold text-ink">Hallazgos</h2>
        {r.hallazgos.length === 0
          ? <p data-reporte="vacio" className="rounded-2xl border border-hairline bg-surface p-6 text-center text-sm text-ink-muted">No hay nada que revisar.</p>
          : <ul aria-label="Hallazgos" className="flex flex-col gap-2">{r.hallazgos.map((h, k) => <TarjetaHallazgo key={`${h.codigo}-${h.nivel}-${k}`} h={h} />)}</ul>}
      </section>

      <p data-conciliacion-nota className="text-xs text-ink-muted">
        ⚠️ Los umbrales de tiempo ({UMBRAL_ADVERTENCIA_HORAS} h advierte, {UMBRAL_ERROR_HORAS} h es error) para lo que sigue sin emitir o sin respuesta son un criterio operativo, no plazos de SUNAT, y
        están pendientes de validar con tu contador. Esta pantalla solo informa: no corrige nada.
      </p>
    </div>
  )
}
