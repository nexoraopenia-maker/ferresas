import { formatearFechaLocal } from '@/lib/fecha-local'
import { ETIQUETA_CATEGORIA } from '@/features/branches/cash-movement-reglas'
import { ETIQUETA_METODO, METODOS_REPORTE, type DesgloseCierre, type MetodoReporte } from '@/features/branches/cierre-desglose'
import type { TicketCierre } from '../cierre-caja'

/**
 * El cierre de turno en A4 (F6.8c): el mismo contenido que el ticket de 80 mm, con el detalle por medio de pago (Yape y Plin aparte), descuentos, devoluciones por medio, abonos,
 * pagos a proveedores y movimientos por categoría, y el espacio para las firmas. Sale de las columnas congeladas y de `closingBreakdown`: una reimpresión es idéntica. Documento INTERNO.
 * **Nunca muestra costos, márgenes ni valor de inventario** (solo los números de las ventas hechas bajo el piso de margen).
 */
const money = (n: number) => `S/ ${new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`

const ESTILO = `
@page { size: A4; margin: 14mm; }
.cierre-a4 { background: #fff; color: #111; width: 210mm; max-width: 100%; box-sizing: border-box; padding: 14mm; font: 11px/1.45 system-ui, sans-serif; box-shadow: 0 2px 12px rgba(0,0,0,.15); }
.cierre-a4 h1 { font-size: 18px; margin: 0; letter-spacing: .04em; }
.cierre-a4 h2 { font-size: 12px; margin: 14px 0 4px; text-transform: uppercase; letter-spacing: .06em; }
.cierre-a4 table { width: 100%; border-collapse: collapse; }
.cierre-a4 th, .cierre-a4 td { border: 1px solid #999; padding: 3px 5px; text-align: left; }
.cierre-a4 th { background: #eee; font-size: 10px; text-transform: uppercase; }
.cierre-a4 .num { text-align: right; white-space: nowrap; }
.cierre-a4 .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 18px; margin-top: 8px; }
.cierre-a4 .firmas { display: grid; grid-template-columns: repeat(2, 1fr); gap: 30px; margin-top: 56px; }
.cierre-a4 .firma { border-top: 1px solid #111; padding-top: 4px; text-align: center; font-size: 10px; }
.cierre-a4 .chico { font-size: 10px; color: #444; }
@media print { .a4-pantalla { padding: 0 !important; background: #fff !important; } .cierre-a4 { box-shadow: none; width: auto; padding: 0; } .cierre-a4 tr { break-inside: avoid; } }
`

function TablaMedios({ titulo, filas }: { titulo: string; filas: Record<MetodoReporte, { operaciones: number; monto: number }> }) {
  const usadas = METODOS_REPORTE.filter((m) => filas[m].operaciones > 0)
  if (usadas.length === 0) return null
  return (
    <>
      <h2>{titulo}</h2>
      <table>
        <thead><tr><th>Medio</th><th className="num">Operaciones</th><th className="num">Monto</th></tr></thead>
        <tbody>{usadas.map((m) => <tr key={m}><td>{ETIQUETA_METODO[m]}</td><td className="num">{filas[m].operaciones}</td><td className="num">{money(filas[m].monto)}</td></tr>)}</tbody>
      </table>
    </>
  )
}

function Movimientos({ titulo, filas }: { titulo: string; filas: Record<string, number> }) {
  const e = Object.entries(filas)
  if (e.length === 0) return null
  return (
    <>
      <h2>{titulo}</h2>
      <table><tbody>{e.map(([k, v]) => <tr key={k}><td>{ETIQUETA_CATEGORIA[k as keyof typeof ETIQUETA_CATEGORIA] ?? k}</td><td className="num">{money(v)}</td></tr>)}</tbody></table>
    </>
  )
}

export function CierreCajaA4({ ticket: c }: { ticket: TicketCierre }) {
  const d: DesgloseCierre | null = c.desglose
  const f = (iso: string) => formatearFechaLocal(iso, c.zonaHoraria, c.locale)
  return (
    <article className="cierre-a4" data-a4="cierre-caja">
      <style dangerouslySetInnerHTML={{ __html: ESTILO }} />
      <header>
        <p style={{ fontWeight: 700, textTransform: 'uppercase' }}>{c.emisor.nombre}</p>
        {c.emisor.razonSocial && c.emisor.razonSocial !== c.emisor.nombre && <p>{c.emisor.razonSocial}</p>}
        {c.emisor.ruc && <p>RUC {c.emisor.ruc}</p>}
        <h1>Cierre de caja {c.numero}</h1>
        <div className="meta">
          <span>Sucursal: <b>{c.sucursal}</b></span>
          <span>Caja: <b>{c.caja}</b></span>
          <span>Abrió: {c.abrio} · {f(c.abiertoEn)}</span>
          <span>Cerró: {c.cerro ?? '—'} · {f(c.cerradoEn)}</span>
        </div>
      </header>

      <h2>Cuenta del cajón</h2>
      <table>
        <tbody>
          <tr><td>Fondo inicial</td><td className="num">{money(c.fondoInicial)}</td></tr>
          <tr><td>+ Cobrado en efectivo</td><td className="num">{money(c.cobradoEfectivo)}</td></tr>
          <tr><td>− Vueltos</td><td className="num">{money(c.vueltos)}</td></tr>
          <tr><td>+ Abonos en efectivo</td><td className="num">{money(c.abonosEfectivo)}</td></tr>
          <tr><td>− Pagos a proveedores en efectivo</td><td className="num">{money(c.pagosProveedorEfectivo)}</td></tr>
          <tr><td>− Devoluciones pagadas del cajón</td><td className="num">{money(c.devolucionesCajon)}</td></tr>
          <tr><td>+ Ingresos manuales</td><td className="num">{money(c.ingresosManuales)}</td></tr>
          <tr><td>− Egresos manuales</td><td className="num">{money(c.egresosManuales)}</td></tr>
          <tr><td>− Compensaciones de abonos anulados</td><td className="num">{money(c.compensacionesEfectivo)}</td></tr>
          <tr><td><b>Esperado</b></td><td className="num"><b>{money(c.esperado)}</b></td></tr>
          <tr><td><b>Contado</b></td><td className="num"><b>{money(c.contado)}</b></td></tr>
          <tr data-a4="diferencia"><td><b>{c.diferencia < 0 ? 'FALTANTE' : c.diferencia > 0 ? 'SOBRANTE' : 'CUADRA'}</b></td><td className="num"><b>{money(Math.abs(c.diferencia))}</b></td></tr>
        </tbody>
      </table>

      {d ? (
        <div data-a4="por-medio">
          <h2>Ventas del turno</h2>
          <p>{d.ventas.cantidad} venta(s) · {money(d.ventas.total)}. Cobrado neto (sin fiado y sin vueltos): <b>{money(d.cobradoNeto)}</b>.</p>
          <TablaMedios titulo="Ventas por medio de pago" filas={d.ventasPorMetodo} />
          <p className="chico">
            {d.ventas.descuentos.ventasConDescuento > 0 && <>Descuentos otorgados: {money(d.ventas.descuentos.total)} en {d.ventas.descuentos.ventasConDescuento} venta(s). </>}
            {d.ventas.anuladas.cantidad > 0 && <>Anuladas o devueltas: {d.ventas.anuladas.cantidad} por {money(d.ventas.anuladas.monto)}. </>}
            {d.ventas.bajoCosto.cantidad > 0 && <>Vendidas bajo el piso de margen con excepción autorizada: {d.ventas.bajoCosto.ventas.join(', ')}.</>}
          </p>
          <TablaMedios titulo="Devoluciones por medio" filas={d.devoluciones.porMetodo} />
          {d.devoluciones.sinSalida > 0 && <p className="chico">Devoluciones sin salida de dinero: {money(d.devoluciones.sinSalida)}.</p>}
          <TablaMedios titulo="Abonos de clientes por medio" filas={d.abonosPorMetodo} />
          <TablaMedios titulo="Pagos a proveedores por medio" filas={d.pagosProveedorPorMetodo} />
          <Movimientos titulo="Ingresos manuales" filas={d.movimientos.ingresos} />
          <Movimientos titulo="Egresos manuales" filas={d.movimientos.egresos} />
        </div>
      ) : (
        <p className="chico" data-a4="sin-desglose">Este cierre es anterior al detalle por medio de pago: solo existen los totales de arriba. Ventas: {c.ventasCantidad} · {money(c.ventasTotal)}. Fiado: {money(c.fiado)}.</p>
      )}

      {c.notas && <p className="chico">Notas: {c.notas}</p>}

      <div className="firmas">
        <div className="firma">Cajero(a): {c.cerro ?? c.abrio}</div>
        <div className="firma">Supervisión</div>
      </div>
      <p className="chico" style={{ marginTop: 14 }}>Cierre interno de caja. No es un comprobante de pago electrónico.</p>
    </article>
  )
}
