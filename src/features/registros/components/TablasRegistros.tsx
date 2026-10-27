import Link from 'next/link'
import { fechaDiaCorta } from '@/lib/fecha-local'
import type { RegistroCompras, RegistroVentas } from '../registro-calculo'
import { ETIQUETA_REGISTRO, TIPOS_REGISTRO, type ParametrosRegistros, type TipoRegistro } from '../schemas'
import { enlaceCsvRegistro, enlaceRegistros } from '../urls'

const money = (n: number) => `${n < 0 ? '−' : ''}S/ ${Math.abs(n).toFixed(2)}`
const th = 'px-3 py-2 text-right'
const td = 'px-3 py-2 text-right tabular-nums'
/** Cuántas filas se pintan; los totales y el CSV son de TODAS. */
export const LIMITE_FILAS = 200
const ETIQUETA_TIPO: Record<string, string> = { FACTURA: 'Factura', BOLETA: 'Boleta', NOTA_CREDITO: 'Nota de crédito', NOTA_DEBITO: 'Nota de débito' }
const ETIQUETA_ESTADO: Record<string, string> = { PENDIENTE: 'Pendiente', ENVIADO: 'Enviado', ACEPTADO: 'Aceptado', OBSERVADO: 'Observado', RECHAZADO: 'Rechazado', ANULADO: 'Anulado' }

export function PestanasRegistros({ activa, params }: { activa: TipoRegistro; params: ParametrosRegistros }) {
  return (
    <nav aria-label="Registros" className="flex flex-wrap gap-2">
      {TIPOS_REGISTRO.map((t) => (
        <Link key={t} href={enlaceRegistros(t, params)} aria-current={t === activa ? 'page' : undefined} data-pestana={t}
          className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${t === activa ? 'border-industrial-600 bg-industrial-600 text-white' : 'border-hairline text-ink'}`}>
          {ETIQUETA_REGISTRO[t]}
        </Link>
      ))}
    </nav>
  )
}

export function BarraDescargaRegistro({ tipo, params, texto }: { tipo: TipoRegistro; params: ParametrosRegistros; texto: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p data-periodo className="text-sm font-semibold text-ink">{texto}</p>
      <a href={enlaceCsvRegistro(tipo, params)} download data-enlace="csv" className="inline-flex h-touch items-center rounded-xl border border-hairline px-4 font-semibold text-ink">Descargar CSV</a>
    </div>
  )
}

const Vacio = ({ texto }: { texto: string }) => <p data-reporte="vacio" className="rounded-2xl border border-hairline bg-surface p-6 text-center text-sm text-ink-muted">{texto}</p>
const Aviso = ({ children, marca }: { children: React.ReactNode; marca: string }) => (
  <p role="alert" data-registro-aviso={marca} className="rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">{children}</p>
)

function Tarjetas({ items }: { items: { k: string; v: string; fuerte?: boolean }[] }) {
  return (
    <section aria-label="Totales" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((i) => (
        <div key={i.k} className="rounded-2xl border border-hairline bg-surface px-3 py-2">
          <p className="text-xs text-ink-muted">{i.k}</p>
          <p className={`tabular-nums text-ink ${i.fuerte ? 'text-xl font-extrabold' : 'text-lg font-bold'}`}>{i.v}</p>
        </div>
      ))}
    </section>
  )
}

export function TablaRegistroVentas({ r }: { r: RegistroVentas }) {
  const t = r.totales
  const fuera = r.control.filter((k) => k.documentos > 0)
  const vistas = r.filas.slice(0, LIMITE_FILAS)
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">
        Comprobantes de venta del periodo (facturas, boletas y notas), por su fecha de emisión en la hora del negocio. Los totales suman solo los <b>aceptados y observados</b>; las notas de
        crédito restan. Los comprobantes de ensayo y las notas de venta no entran. Los pendientes, enviados, rechazados y anulados no suman: aparecen en el control.
      </p>
      <Tarjetas items={[{ k: 'Base imponible', v: money(t.base) }, { k: 'IGV', v: money(t.igv) }, { k: 'Total', v: money(t.total), fuerte: true }, { k: 'Documentos que suman', v: String(t.documentos) }]} />
      {fuera.length > 0 && (
        <section aria-label="Control" data-registro="control" className="flex flex-col gap-2 rounded-2xl border border-stock-low/40 bg-stock-low-soft p-3">
          <h2 className="text-base font-bold text-stock-low">Fuera de los totales — revisa estos comprobantes</h2>
          <ul className="flex flex-col gap-1 text-sm text-ink">
            {fuera.map((k) => (
              <li key={k.estado} data-control={k.estado} className="flex justify-between gap-2">
                <span>{ETIQUETA_ESTADO[k.estado]}: {k.documentos} {k.documentos === 1 ? 'documento' : 'documentos'}</span>
                <b className="tabular-nums">{money(k.total)}</b>
              </li>
            ))}
          </ul>
        </section>
      )}
      {r.alertas.facturasSinRuc > 0 && <Aviso marca="sin-ruc">{r.alertas.facturasSinRuc} {r.alertas.facturasSinRuc === 1 ? 'factura no tiene' : 'facturas no tienen'} un RUC válido del cliente.</Aviso>}
      {r.alertas.otraMoneda > 0 && <Aviso marca="moneda">{r.alertas.otraMoneda} {r.alertas.otraMoneda === 1 ? 'comprobante está' : 'comprobantes están'} en una moneda distinta de soles: los importes se muestran tal cual.</Aviso>}
      {r.filas.length === 0 ? <Vacio texto="No hay comprobantes de venta en este periodo. Los comprobantes de ensayo no se registran." /> : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
            <table data-reporte="registro-ventas" className="w-full min-w-[56rem] text-sm">
              <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted">
                <th scope="col" className="px-3 py-2 text-left">Fecha</th><th scope="col" className="px-3 py-2 text-left">Comprobante</th><th scope="col" className="px-3 py-2 text-left">Cliente</th>
                <th scope="col" className={th}>Base</th><th scope="col" className={th}>IGV</th><th scope="col" className={th}>Total</th><th scope="col" className="px-3 py-2 text-left">Estado</th>
              </tr></thead>
              <tbody>
                {vistas.map((f) => (
                  <tr key={f.id} data-fila={f.id} data-suma={f.suma ? 'si' : 'no'} className={`border-b border-hairline last:border-0 ${f.suma ? '' : 'bg-surface-sunken text-ink-muted'}`}>
                    <td className="px-3 py-2 tabular-nums">{fechaDiaCorta(f.fecha)}</td>
                    <th scope="row" className="px-3 py-2 text-left font-semibold">{ETIQUETA_TIPO[f.tipo]} {f.numero}{f.relacionado && <span className="block text-xs font-normal text-ink-muted">Corrige {f.relacionado}</span>}</th>
                    <td className="px-3 py-2">{f.receptorNombre ?? 'Sin nombre'}<span className="block text-xs text-ink-muted">{f.receptorNumero ? `${f.receptorTipo} ${f.receptorNumero}` : 'Sin documento'}</span></td>
                    <td className={td}>{money(f.signo * f.base)}</td><td className={td}>{money(f.signo * f.igv)}</td><td className={`${td} font-bold`}>{money(f.signo * f.total)}</td>
                    <td className="px-3 py-2"><span data-estado={f.estado} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${f.suma ? 'bg-stock-ok-soft text-stock-ok' : 'bg-stock-low-soft text-stock-low'}`}>{ETIQUETA_ESTADO[f.estado]}</span>{f.alertas.length > 0 && <span className="block text-xs text-stock-low">{f.alertas.join('; ')}</span>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr data-reporte-total className="border-t-2 border-hairline font-bold text-ink">
                <th scope="row" colSpan={3} className="px-3 py-2 text-left">Total (aceptados y observados)</th><td className={td}>{money(t.base)}</td><td className={td}>{money(t.igv)}</td><td className={td}>{money(t.total)}</td><td />
              </tr></tfoot>
            </table>
          </div>
          {r.filas.length > LIMITE_FILAS && <p data-reporte="recorte" className="text-xs text-ink-muted">Se muestran los {LIMITE_FILAS} primeros de {r.filas.length}. Los totales y la descarga CSV son de todos.</p>}
        </>
      )}
    </div>
  )
}

export function TablaRegistroCompras({ r }: { r: RegistroCompras }) {
  const t = r.totales, k = r.control
  const vistas = r.filas.slice(0, LIMITE_FILAS)
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">
        Compras recibidas del periodo, por la fecha de emisión del documento del proveedor. Si la compra aún no tiene su documento se usa la fecha de recepción como <b>provisional</b>.
        Las notas de crédito restan. Es el total de cada documento, no el costo de cada producto.
      </p>
      <Tarjetas items={[{ k: 'Base', v: money(t.base) }, { k: 'IGV', v: money(t.igv) }, { k: 'Total', v: money(t.total), fuerte: true }, { k: 'Documentos', v: String(t.documentos) }]} />
      {k.provisionales > 0 && (
        <Aviso marca="provisionales">
          {k.provisionales} {k.provisionales === 1 ? 'compra tiene' : 'compras tienen'} fecha provisional ({money(k.importeProvisional)}): les falta el tipo, la serie, el número y la fecha de emisión del documento.
          Ábrelas desde Compras y usa «Completar documento».
        </Aviso>
      )}
      {k.proveedorSinRuc > 0 && <Aviso marca="sin-ruc">{k.proveedorSinRuc} {k.proveedorSinRuc === 1 ? 'compra tiene' : 'compras tienen'} un proveedor sin RUC válido.</Aviso>}
      {k.sinProveedor > 0 && <Aviso marca="sin-proveedor">{k.sinProveedor} {k.sinProveedor === 1 ? 'compra no tiene' : 'compras no tienen'} proveedor.</Aviso>}
      {r.filas.length === 0 ? <Vacio texto="No hay compras recibidas en este periodo." /> : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
            <table data-reporte="registro-compras" className="w-full min-w-[56rem] text-sm">
              <thead><tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted">
                <th scope="col" className="px-3 py-2 text-left">Fecha</th><th scope="col" className="px-3 py-2 text-left">Documento</th><th scope="col" className="px-3 py-2 text-left">Proveedor</th>
                <th scope="col" className={th}>Base</th><th scope="col" className={th}>IGV</th><th scope="col" className={th}>Total</th><th scope="col" className="px-3 py-2 text-left">Compra</th>
              </tr></thead>
              <tbody>
                {vistas.map((f) => (
                  <tr key={f.id} data-fila={f.id} data-provisional={f.provisional ? 'si' : 'no'} className="border-b border-hairline last:border-0">
                    <td className="px-3 py-2 tabular-nums">{fechaDiaCorta(f.fecha)}{f.provisional && <span data-fecha="provisional" title="Falta el documento: se usa la fecha de recepción" className="ml-1 rounded-full bg-stock-low-soft px-1.5 text-xs font-semibold text-stock-low">provisional</span>}</td>
                    <th scope="row" className="px-3 py-2 text-left font-semibold">{f.tipoEtiqueta}{f.documento && <span className="block text-xs font-normal text-ink-muted">{f.documento}</span>}</th>
                    <td className="px-3 py-2">{f.proveedorNombre ?? 'Sin proveedor'}<span className="block text-xs text-ink-muted">{f.proveedorRuc ?? 'Sin RUC'}</span></td>
                    <td className={td}>{money(f.signo * f.base)}</td><td className={td}>{money(f.signo * f.igv)}</td><td className={`${td} font-bold`}>{money(f.signo * f.total)}</td>
                    <td className="px-3 py-2"><Link href={`/compras/${f.id}`} className="font-semibold text-industrial-600 underline">{f.compra}</Link></td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr data-reporte-total className="border-t-2 border-hairline font-bold text-ink">
                <th scope="row" colSpan={3} className="px-3 py-2 text-left">Total</th><td className={td}>{money(t.base)}</td><td className={td}>{money(t.igv)}</td><td className={td}>{money(t.total)}</td><td />
              </tr></tfoot>
            </table>
          </div>
          {r.filas.length > LIMITE_FILAS && <p data-reporte="recorte" className="text-xs text-ink-muted">Se muestran los {LIMITE_FILAS} primeros de {r.filas.length}. Los totales y la descarga CSV son de todos.</p>}
        </>
      )}
    </div>
  )
}
