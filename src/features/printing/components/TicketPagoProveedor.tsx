import { formatearFechaLocal } from '@/lib/fecha-local'
import type { VoucherPago } from '../voucher-pago'
import { nombreMetodo } from './TicketTermico'

/**
 * Voucher de pago a proveedor en papel térmico de 80 mm. Misma hoja de estilos y aspecto que el recibo de abono (`ticket.css`).
 * Es un documento INTERNO de caja, no un comprobante electrónico: el pie lo dice. Si el pago se anuló, el voucher lo declara con marca
 * de agua y con el motivo, para que nadie lo archive como un pago vigente.
 */
export function TicketPagoProveedor({ voucher }: { voucher: VoucherPago }) {
  const fmt = (n: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
  const v = voucher
  return (
    <article className="ticket" data-ticket="pago-proveedor">
      {v.anulado && <div className="t-marca" aria-hidden><span>ANULADO</span></div>}

      <header className="t-centro">
        <p className="t-grande t-fuerte t-mayus">{v.emisor.nombre}</p>
        {v.emisor.razonSocial && v.emisor.razonSocial !== v.emisor.nombre && <p>{v.emisor.razonSocial}</p>}
        {v.emisor.ruc && <p className="t-fuerte">RUC {v.emisor.ruc}</p>}
        {v.emisor.direccion && <p className="t-chico">{v.emisor.direccion}</p>}
        {v.emisor.telefono && <p className="t-chico">Tel. {v.emisor.telefono}</p>}
      </header>

      <div className="t-sep t-sep-doble" aria-hidden />

      <div className="t-centro">
        <p className="t-caja">PAGO A PROVEEDOR</p>
        <p className="t-grande t-fuerte" data-ticket="numero">{v.numero}</p>
      </div>

      <div className="t-sep t-sep-doble" aria-hidden />

      <Par etiqueta="Fecha" valor={formatearFechaLocal(v.fecha, v.zonaHoraria, v.locale)} />
      <Par etiqueta="Pagó" valor={v.pagadoPor} />

      <div className="t-sep" aria-hidden />

      <Par etiqueta="Proveedor" valor={v.proveedor.nombre} />
      {v.proveedor.ruc && <Par etiqueta="RUC" valor={v.proveedor.ruc} />}

      <div className="t-sep" aria-hidden />

      <Par etiqueta="Forma de pago" valor={nombreMetodo(v.metodo)} />
      {v.referencia && <Par etiqueta="Ref." valor={v.referencia} />}

      <div className="t-sep" aria-hidden />

      <div className="t-total t-caja" data-ticket="monto">
        <span>PAGO</span>
        <span>S/ {fmt(v.monto)}</span>
      </div>

      {v.reparto.length > 0 && (
        <>
          <div className="t-sep" aria-hidden />
          <p className="t-chico t-fuerte">Aplicado a:</p>
          {v.reparto.map((x) => <Par key={x.compra} etiqueta={x.compra} valor={`S/ ${fmt(x.monto)}`} />)}
        </>
      )}

      {v.deudaDespues !== null && (
        <>
          <div className="t-sep" aria-hidden />
          <div className="t-total t-fuerte" data-ticket="deuda">
            <span>Deuda restante</span>
            <span>S/ {fmt(v.deudaDespues)}</span>
          </div>
        </>
      )}

      {v.anulado && (
        <>
          <div className="t-sep" aria-hidden />
          <p className="t-centro t-fuerte">** PAGO ANULADO **</p>
          {v.motivoAnulacion && <p className="t-chico t-centro">{v.motivoAnulacion}</p>}
        </>
      )}

      <div className="t-sep t-sep-doble" aria-hidden />

      <footer className="t-centro t-chico">
        <p>Voucher interno de caja. No es un comprobante de pago electrónico.</p>
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
