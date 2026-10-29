import { formatearFechaLocal } from '@/lib/fecha-local'
import type { TicketCierre } from '../cierre-caja'
import { ETIQUETA_METODO, METODOS_REPORTE } from '@/features/branches/cierre-desglose'

/**
 * Ticket de cierre de turno en papel térmico de 80 mm (misma hoja `ticket.css`). Documento INTERNO de caja, no un comprobante. Muestra la
 * cuenta del cajón en el orden en que se hace —fondo, cobros, vueltos, abonos, pagos a proveedores, devoluciones— y, aparte y rotuladas
 * como informativas, las líneas que NO tocaron el cajón (fiado, otros medios, devoluciones por otro medio o sin salida).
 */
export function TicketCierreCaja({ ticket: c }: { ticket: TicketCierre }) {
  const fmt = (n: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
  const s = (n: number) => `S/ ${fmt(n)}`
  const informativas = c.fiado > 0 || c.abonosOtrosMedios > 0 || c.pagosProveedorOtrosMedios > 0 || c.devolucionesOtrosMedios > 0 || c.compensacionesOtrosMedios > 0
  return (
    <article className="ticket" data-ticket="cierre-caja">
      <header className="t-centro">
        <p className="t-grande t-fuerte t-mayus">{c.emisor.nombre}</p>
        {c.emisor.razonSocial && c.emisor.razonSocial !== c.emisor.nombre && <p>{c.emisor.razonSocial}</p>}
        {c.emisor.ruc && <p className="t-fuerte">RUC {c.emisor.ruc}</p>}
        {c.emisor.direccion && <p className="t-chico">{c.emisor.direccion}</p>}
        {c.emisor.telefono && <p className="t-chico">Tel. {c.emisor.telefono}</p>}
      </header>

      <div className="t-sep t-sep-doble" aria-hidden />

      <div className="t-centro">
        <p className="t-caja">CIERRE DE CAJA</p>
        <p className="t-grande t-fuerte" data-ticket="numero">{c.numero}</p>
      </div>

      <div className="t-sep t-sep-doble" aria-hidden />

      <Par etiqueta="Sucursal" valor={c.sucursal} />
      <Par etiqueta="Caja" valor={c.caja} />
      <Par etiqueta="Abrió" valor={c.abrio} />
      <Par etiqueta="Desde" valor={formatearFechaLocal(c.abiertoEn, c.zonaHoraria, c.locale)} />
      {c.cerro && <Par etiqueta="Cerró" valor={c.cerro} />}
      <Par etiqueta="Hasta" valor={formatearFechaLocal(c.cerradoEn, c.zonaHoraria, c.locale)} />
      <Par etiqueta="Ventas" valor={`${c.ventasCantidad} · ${s(c.ventasTotal)}`} />

      {c.desglose && (
        <div data-ticket="por-medio">
          <div className="t-sep" aria-hidden />
          <p className="t-chico t-fuerte">Ventas por medio de pago</p>
          {METODOS_REPORTE.filter((m) => c.desglose!.ventasPorMetodo[m].operaciones > 0).map((m) => (
            <Par key={m} etiqueta={`${ETIQUETA_METODO[m]} (${c.desglose!.ventasPorMetodo[m].operaciones})`} valor={s(c.desglose!.ventasPorMetodo[m].monto)} />
          ))}
          {c.desglose.ventas.descuentos.total > 0 && <Par etiqueta="Descuentos otorgados" valor={s(c.desglose.ventas.descuentos.total)} />}
          {c.desglose.ventas.anuladas.cantidad > 0 && <Par etiqueta={`Anuladas o devueltas (${c.desglose.ventas.anuladas.cantidad})`} valor={s(c.desglose.ventas.anuladas.monto)} />}
        </div>
      )}

      <div className="t-sep" aria-hidden />

      <p className="t-chico t-fuerte">Cuenta del cajón</p>
      <Par etiqueta="Fondo inicial" valor={s(c.fondoInicial)} />
      <Par etiqueta="+ Cobrado en efectivo" valor={s(c.cobradoEfectivo)} />
      <Par etiqueta="- Vueltos" valor={s(c.vueltos)} />
      {c.abonosEfectivo > 0 && <Par etiqueta="+ Abonos en efectivo" valor={s(c.abonosEfectivo)} />}
      {c.pagosProveedorEfectivo > 0 && <Par etiqueta="- Pagos a proveedores" valor={s(c.pagosProveedorEfectivo)} />}
      {c.devolucionesCajon > 0 && <div data-ticket="devoluciones-cajon"><Par etiqueta="- Devoluciones pagadas del cajón" valor={s(c.devolucionesCajon)} /></div>}
      {c.ingresosManuales > 0 && <div data-ticket="ingresos-manuales"><Par etiqueta="+ Ingresos manuales" valor={s(c.ingresosManuales)} /></div>}
      {c.egresosManuales > 0 && <div data-ticket="egresos-manuales"><Par etiqueta="- Egresos manuales" valor={s(c.egresosManuales)} /></div>}
      {c.compensacionesEfectivo > 0 && <div data-ticket="compensaciones-efectivo"><Par etiqueta="- Compensaciones de abonos anulados" valor={s(c.compensacionesEfectivo)} /></div>}

      <div className="t-sep" aria-hidden />

      <Par etiqueta="Esperado" valor={s(c.esperado)} />
      <Par etiqueta="Contado" valor={s(c.contado)} />
      <div className="t-total t-fuerte" data-ticket="diferencia">
        <span>{c.diferencia < 0 ? 'FALTANTE' : c.diferencia > 0 ? 'SOBRANTE' : 'CUADRA'}</span>
        <span>{c.diferencia === 0 ? s(0) : s(Math.abs(c.diferencia))}</span>
      </div>

      {informativas && (
        <>
          <div className="t-sep" aria-hidden />
          <p className="t-chico t-fuerte">Informativo (no tocó el cajón)</p>
          {c.fiado > 0 && <Par etiqueta="Fiado" valor={s(c.fiado)} />}
          {c.abonosOtrosMedios > 0 && <Par etiqueta="Abonos otros medios" valor={s(c.abonosOtrosMedios)} />}
          {c.pagosProveedorOtrosMedios > 0 && <Par etiqueta="Pagos prov. otros medios" valor={s(c.pagosProveedorOtrosMedios)} />}
          {c.compensacionesOtrosMedios > 0 && (
            <div data-ticket="compensaciones-otros"><Par etiqueta="Compensaciones otros medios" valor={s(c.compensacionesOtrosMedios)} /></div>
          )}
          {c.devolucionesOtrosMedios > 0 && (
            <div data-ticket="devoluciones-otros"><Par etiqueta="Devoluciones otro medio / sin salida" valor={s(c.devolucionesOtrosMedios)} /></div>
          )}
        </>
      )}

      {c.notas && (
        <>
          <div className="t-sep" aria-hidden />
          <p className="t-chico">Notas: {c.notas}</p>
        </>
      )}

      <div className="t-sep t-sep-doble" aria-hidden />

      <footer className="t-centro t-chico">
        <p>Cierre interno de caja. No es un comprobante de pago electrónico.</p>
        <p aria-hidden>&nbsp;</p>
        <p aria-hidden>&nbsp;</p>
      </footer>
    </article>
  )
}

function Par({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="t-fila">
      <span>{etiqueta}</span>
      <span>{valor}</span>
    </div>
  )
}
