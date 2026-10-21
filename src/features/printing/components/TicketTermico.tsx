import { formatQuantity, unitLabel } from '@/lib/quantity'
import { formatearFechaLocal } from '@/lib/fecha-local'
import type { DocumentoImprimible } from '../queries'

/**
 * Representación impresa en papel térmico de 80 mm.
 *
 * Es un Server Component puro: no necesita estado, y renderizarlo en el
 * servidor evita el parpadeo de un ticket a medio hidratar justo cuando el
 * navegador abre el diálogo de impresión.
 *
 * Las clases son de `ticket.css`, no de Tailwind: ver la cabecera de ese
 * archivo para el motivo.
 */
export function TicketTermico({ doc }: { doc: DocumentoImprimible }) {
  /*
   * Separador de miles: "1,645.00" y no "1645.00". En papel de 72 mm, sin
   * separador un total de cuatro cifras se lee mal, y un importe mal leído
   * en el mostrador es un reclamo.
   */
  const fmt = (n: number) =>
    new Intl.NumberFormat('es-PE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  const fecha = formatearFechaLocal(doc.fecha, doc.zonaHoraria, doc.locale)
  const simbolo = doc.moneda === 'PEN' ? 'S/' : doc.moneda

  return (
    <article className="ticket">
      {doc.marcaAgua && (
        <div className="t-marca" aria-hidden>
          <span>{doc.marcaAgua}</span>
        </div>
      )}

      {/* ══ Emisor ══════════════════════════════════════════════════════ */}
      <header className="t-centro">
        <p className="t-grande t-fuerte t-mayus">{doc.emisor.nombre}</p>
        {doc.emisor.razonSocial && doc.emisor.razonSocial !== doc.emisor.nombre && (
          <p>{doc.emisor.razonSocial}</p>
        )}
        {doc.emisor.ruc && <p className="t-fuerte">RUC {doc.emisor.ruc}</p>}
        {doc.emisor.direccion && <p className="t-chico">{doc.emisor.direccion}</p>}
        {doc.emisor.telefono && <p className="t-chico">Tel. {doc.emisor.telefono}</p>}
      </header>

      <div className="t-sep t-sep-doble" aria-hidden />

      {/* ══ Tipo y número de documento ══════════════════════════════════ */}
      <div className="t-centro">
        {doc.titulo.split('\n').map((linea) => (
          <p key={linea} className="t-caja">{linea}</p>
        ))}
        <p className="t-grande t-fuerte">{doc.numero}</p>
      </div>

      <div className="t-sep t-sep-doble" aria-hidden />

      {/* ══ Metadatos ═══════════════════════════════════════════════════ */}
      <Par etiqueta="Fecha" valor={fecha} />
      <Par etiqueta="Atendió" valor={doc.cajero} />
      {doc.almacen && <Par etiqueta="Almacén" valor={doc.almacen} />}
      {doc.validUntil && (
        <Par
          etiqueta="Válida hasta"
          valor={formatearFechaLocal(doc.validUntil, doc.zonaHoraria, doc.locale, {
            conHora: false,
          })}
        />
      )}
      {doc.estadoTributario && <Par etiqueta="Estado" valor={doc.estadoTributario} />}

      <div className="t-sep" aria-hidden />

      {/* ══ Receptor ════════════════════════════════════════════════════ */}
      {doc.cliente ? (
        <>
          <Par etiqueta="Cliente" valor={doc.cliente.nombre} />
          {doc.cliente.docEtiqueta && doc.cliente.docNumero && (
            <Par etiqueta={doc.cliente.docEtiqueta} valor={doc.cliente.docNumero} />
          )}
          {doc.cliente.direccion && <Par etiqueta="Dir." valor={doc.cliente.direccion} />}
        </>
      ) : (
        <Par etiqueta="Cliente" valor="Público general" />
      )}

      <div className="t-sep" aria-hidden />

      {/* ══ Detalle ═════════════════════════════════════════════════════ */}
      <div className="t-fila t-chico t-fuerte">
        <span>CANT. x P. UNIT.</span>
        <span>IMPORTE</span>
      </div>
      <div className="t-sep" aria-hidden />

      {doc.lineas.map((l, i) => (
        <div className="t-item" key={`${l.sku}-${i}`}>
          <p className="t-item-nombre">{l.nombre}</p>
          <div className="t-item-calculo">
            <span>
              {formatQuantity(l.cantidad, l.unitType)} {unitLabel(l.unitType)} x {fmt(l.unitPrice)}
              {l.descuento > 0 && ` - ${fmt(l.descuento)} dscto.`}
            </span>
            <span className="t-fuerte">{fmt(l.importe)}</span>
          </div>
          <p className="t-chico t-item-sku">{l.sku}</p>
        </div>
      ))}

      <div className="t-sep" aria-hidden />

      {/* ══ Importes ════════════════════════════════════════════════════ */}
      {doc.opGravada > 0 && (
        <Total etiqueta="Op. gravada" valor={`${simbolo} ${fmt(doc.opGravada)}`} />
      )}
      {doc.opExonerada > 0 && (
        <Total etiqueta="Op. exonerada" valor={`${simbolo} ${fmt(doc.opExonerada)}`} />
      )}
      {doc.descuento > 0 && <Total etiqueta="Descuentos" valor={`- ${fmt(doc.descuento)}`} />}
      <Total
        etiqueta={`IGV${doc.tasaIgv !== null ? ` (${(doc.tasaIgv * 100).toFixed(0)}%)` : ''}`}
        valor={fmt(doc.igv)}
      />

      <div className="t-sep" aria-hidden />

      <div className="t-total t-caja">
        <span>TOTAL</span>
        <span>{simbolo} {fmt(doc.total)}</span>
      </div>

      {/* ══ Importe en letras (exigido en comprobantes) ═════════════════ */}
      <div className="t-sep" aria-hidden />
      <p className="t-chico">{doc.totalEnLetras}</p>

      {/* ══ Pagos ═══════════════════════════════════════════════════════ */}
      {doc.pagos.length > 0 && (
        <>
          <div className="t-sep" aria-hidden />
          {doc.pagos.map((p, i) => (
            <div key={`${p.metodo}-${i}`}>
              <Total etiqueta={nombreMetodo(p.metodo)} valor={fmt(p.monto)} />
              {p.referencia && <p className="t-chico">Ref. {p.referencia}</p>}
            </div>
          ))}
          {doc.vuelto > 0 && <Total etiqueta="Vuelto" valor={fmt(doc.vuelto)} fuerte />}
        </>
      )}

      {/* ══ Pie ═════════════════════════════════════════════════════════ */}
      {doc.notas && (
        <>
          <div className="t-sep" aria-hidden />
          <p className="t-chico">{doc.notas}</p>
        </>
      )}

      {doc.anulado && (
        <>
          <div className="t-sep" aria-hidden />
          <p className="t-centro t-fuerte">** DOCUMENTO ANULADO **</p>
          {doc.motivoAnulacion && <p className="t-chico t-centro">{doc.motivoAnulacion}</p>}
        </>
      )}

      <div className="t-sep t-sep-doble" aria-hidden />

      <footer className="t-centro t-chico">
        {doc.tipo === 'comprobante' ? (
          <>
            <p>
              Representación impresa del comprobante electrónico.
              {doc.emisor.ruc
                ? ' Consulte su validez en www.sunat.gob.pe'
                : ' Pendiente de declarar el RUC del emisor.'}
            </p>
            {doc.qr ? (
              <>
                {/* SVG generado aquí mismo a partir de la trama; no hay nada del usuario en el marcado. */}
                <div
                  aria-label="Código QR del comprobante"
                  style={{ width: '32mm', height: '32mm', margin: '2mm auto' }}
                  dangerouslySetInnerHTML={{ __html: doc.qr.svg }}
                />
                {doc.hashXml && <p className="t-chico" style={{ wordBreak: 'break-all' }}>Hash: {doc.hashXml}</p>}
              </>
            ) : doc.estadoTributario !== 'ACEPTADO' && doc.estadoTributario !== 'OBSERVADO' ? (
              <p className="t-fuerte">Pendiente de validación por SUNAT</p>
            ) : null}
          </>
        ) : (
          doc.avisoNoFiscal && <p>{doc.avisoNoFiscal}</p>
        )}
        <p className="t-fuerte" style={{ marginTop: '2mm' }}>
          {doc.tipo === 'cotizacion' ? 'Gracias por su consulta' : '¡Gracias por su compra!'}
        </p>
        {/* Papel de sobra para que la cuchilla no corte la última línea. */}
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

function Total({
  etiqueta, valor, fuerte,
}: { etiqueta: string; valor: string; fuerte?: boolean }) {
  return (
    <div className={`t-total${fuerte ? ' t-fuerte' : ''}`}>
      <span>{etiqueta}</span>
      <span>{valor}</span>
    </div>
  )
}

const METODOS: Record<string, string> = {
  EFECTIVO: 'Efectivo',
  YAPE: 'Yape',
  PLIN: 'Plin',
  TARJETA_DEBITO: 'T. débito',
  TARJETA_CREDITO: 'T. crédito',
  TRANSFERENCIA: 'Transferencia',
  CREDITO: 'Crédito',
}

function nombreMetodo(m: string): string {
  return METODOS[m] ?? m.replace(/_/g, ' ').toLowerCase()
}
