import { formatearFechaLocal } from '@/lib/fecha-local'
import type { ReciboAbono } from '../recibo-abono'
import { nombreMetodo } from './TicketTermico'

/**
 * Recibo de abono en papel térmico de 80 mm. Misma hoja de estilos y mismo aspecto que el ticket de venta (`ticket.css`).
 * Es un recibo INTERNO de caja, no un comprobante electrónico: el pie lo dice. Si el abono se anuló, el recibo lo declara con
 * marca de agua y con el motivo, para que nadie lo presente como cobro vigente.
 */
export function TicketAbono({ recibo }: { recibo: ReciboAbono }) {
  const fmt = (n: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
  const r = recibo
  return (
    <article className="ticket" data-ticket="abono">
      {r.anulado && <div className="t-marca" aria-hidden><span>ANULADO</span></div>}

      <header className="t-centro">
        <p className="t-grande t-fuerte t-mayus">{r.emisor.nombre}</p>
        {r.emisor.razonSocial && r.emisor.razonSocial !== r.emisor.nombre && <p>{r.emisor.razonSocial}</p>}
        {r.emisor.ruc && <p className="t-fuerte">RUC {r.emisor.ruc}</p>}
        {r.emisor.direccion && <p className="t-chico">{r.emisor.direccion}</p>}
        {r.emisor.telefono && <p className="t-chico">Tel. {r.emisor.telefono}</p>}
      </header>

      <div className="t-sep t-sep-doble" aria-hidden />

      <div className="t-centro">
        <p className="t-caja">RECIBO DE ABONO</p>
        <p className="t-grande t-fuerte" data-ticket="numero">{r.numero}</p>
      </div>

      <div className="t-sep t-sep-doble" aria-hidden />

      <Par etiqueta="Fecha" valor={formatearFechaLocal(r.fecha, r.zonaHoraria, r.locale)} />
      <Par etiqueta="Cobró" valor={r.cobradoPor} />

      <div className="t-sep" aria-hidden />

      <Par etiqueta="Cliente" valor={r.cliente.nombre} />
      {r.cliente.docEtiqueta && r.cliente.docNumero && <Par etiqueta={r.cliente.docEtiqueta} valor={r.cliente.docNumero} />}

      <div className="t-sep" aria-hidden />

      <Par etiqueta="Forma de pago" valor={nombreMetodo(r.metodo)} />
      {r.referencia && <Par etiqueta="Ref." valor={r.referencia} />}

      <div className="t-sep" aria-hidden />

      <div className="t-total t-caja" data-ticket="monto">
        <span>ABONO</span>
        <span>S/ {fmt(r.monto)}</span>
      </div>

      {r.reparto.length > 0 && (
        <>
          <div className="t-sep" aria-hidden />
          <p className="t-chico t-fuerte">Aplicado a:</p>
          {r.reparto.map((x) => <Par key={x.venta} etiqueta={x.venta} valor={`S/ ${fmt(x.monto)}`} />)}
        </>
      )}

      {r.deudaDespues !== null && (
        <>
          <div className="t-sep" aria-hidden />
          <div className="t-total t-fuerte" data-ticket="deuda">
            <span>Deuda restante</span>
            <span>S/ {fmt(r.deudaDespues)}</span>
          </div>
        </>
      )}

      {r.anulado && (
        <>
          <div className="t-sep" aria-hidden />
          <p className="t-centro t-fuerte">** RECIBO ANULADO **</p>
          {r.motivoAnulacion && <p className="t-chico t-centro">{r.motivoAnulacion}</p>}
        </>
      )}

      <div className="t-sep t-sep-doble" aria-hidden />

      <footer className="t-centro t-chico">
        <p>Recibo interno de caja. No es un comprobante de pago electrónico.</p>
        <p className="t-fuerte" style={{ marginTop: '2mm' }}>¡Gracias por su pago!</p>
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
