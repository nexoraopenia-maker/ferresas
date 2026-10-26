import { fechaDiaCorta } from '@/lib/fecha-local'
import type { EstadoDeCuenta } from '../cobranza'
import { BotonImprimir } from './BotonImprimir'

const money = (n: number) => `S/ ${n.toFixed(2)}`
const METODO: Record<string, string> = {
  EFECTIVO: 'Efectivo', YAPE: 'Yape', PLIN: 'Plin', TRANSFERENCIA: 'Transferencia', TARJETA_DEBITO: 'T. débito', TARJETA_CREDITO: 'T. crédito', OTRO: 'Otro',
}
const ESTADO: Record<string, string> = { ABIERTA: 'Abierta', PAGADA: 'Pagada', ANULADA: 'Dada de baja' }

export interface EmisorImpreso { nombre: string; razonSocial: string | null; ruc: string | null; direccion: string | null }

/**
 * El estado de cuenta de un cliente, en A4, para entregárselo o archivarlo. Solo presenta lo que calculó `estadoDeCuenta`.
 * Las fechas son días del calendario del negocio (AAAA-MM-DD) y no pasan por `Date`, para que un huso no las corra un día.
 */
export function EstadoCuentaImprimible({ estado, emisor, conAcciones = true }: { estado: EstadoDeCuenta; emisor: EmisorImpreso; conAcciones?: boolean }) {
  const e = estado
  const q = new URLSearchParams()
  if (e.desde) q.set('desde', e.desde)
  if (e.hasta) q.set('hasta', e.hasta)
  const csv = `/api/clientes/${e.cliente.id}/estado-cuenta${q.toString() ? `?${q}` : ''}`
  const abiertas = e.cuentas.filter((c) => c.estado === 'ABIERTA')

  return (
    <>
      {conAcciones && (
        <form method="get" className="a4-acciones no-imprimir" data-a4="acciones">
          <label>Desde<input type="date" name="desde" defaultValue={e.desde ?? ''} /></label>
          <label>Hasta<input type="date" name="hasta" defaultValue={e.hasta ?? ''} /></label>
          <button type="submit">Filtrar</button>
          <BotonImprimir />
          <a href={csv} download data-enlace="estado-cuenta-csv">Descargar CSV</a>
          <a href={`/clientes/${e.cliente.id}`}>Volver a la ficha</a>
        </form>
      )}
      <article className="a4-hoja" data-a4="hoja">
        <div className="cabecera">
          <div>
            <h1>Estado de cuenta</h1>
            <p className="gris">{e.desde || e.hasta ? `Periodo: ${e.desde ? fechaDiaCorta(e.desde) : 'inicio'} al ${e.hasta ? fechaDiaCorta(e.hasta) : fechaDiaCorta(e.fecha)}` : 'Todo el historial'} · emitido el {fechaDiaCorta(e.fecha)}</p>
          </div>
          <div className="derecha">
            <p className="fuerte">{emisor.razonSocial ?? emisor.nombre}</p>
            {emisor.ruc && <p>RUC {emisor.ruc}</p>}
            {emisor.direccion && <p className="gris">{emisor.direccion}</p>}
          </div>
        </div>

        <p className="fuerte" data-a4="cliente">{e.cliente.nombre}</p>
        <p className="gris">{e.cliente.docNumber ? `${e.cliente.docType} ${e.cliente.docNumber}` : 'Sin documento'}{e.cliente.telefono ? ` · Tel. ${e.cliente.telefono}` : ''}</p>

        <div className="resumen">
          <div><p className="gris">Deuda actual</p><p className="fuerte" data-a4="deuda-actual">{money(e.deudaActual)}</p></div>
          <div><p className="gris">Fiado en el periodo</p><p className="fuerte">{money(e.totales.fiadoEnElPeriodo)}</p></div>
          <div><p className="gris">Abonado en el periodo</p><p className="fuerte">{money(e.totales.abonadoEnElPeriodo)}</p></div>
        </div>

        <h2>Ventas a crédito</h2>
        {e.cuentas.length === 0 ? <p className="gris" data-a4="sin-cuentas">Sin ventas a crédito en el periodo.</p> : (
          <table data-a4="cuentas">
            <thead><tr><th>Venta</th><th>Fecha</th><th className="derecha">Monto</th><th className="derecha">Abonado</th><th className="derecha">Saldo</th><th>Vence</th><th>Estado</th></tr></thead>
            <tbody>
              {e.cuentas.map((c) => (
                <tr key={`${c.venta}-${c.fecha}`}>
                  <td>{c.venta}</td><td>{fechaDiaCorta(c.fecha)}</td>
                  <td className="derecha">{money(c.monto)}</td><td className="derecha">{money(c.abonado)}</td><td className="derecha fuerte">{c.estado === 'ABIERTA' ? money(c.saldo) : '—'}</td>
                  <td>{fechaDiaCorta(c.vence)}</td>
                  <td>{ESTADO[c.estado]}{c.diasMora > 0 ? ` · ${c.diasMora} días de atraso` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>Abonos</h2>
        {e.abonos.length === 0 ? <p className="gris" data-a4="sin-abonos">Sin abonos en el periodo.</p> : (
          <table data-a4="abonos">
            <thead><tr><th>Fecha</th><th>Método</th><th>Referencia</th><th>Cobró</th><th className="derecha">Monto</th></tr></thead>
            <tbody>
              {e.abonos.map((a, i) => (
                <tr key={`${a.fecha}-${i}`}>
                  <td>{fechaDiaCorta(a.fecha)}</td><td>{METODO[a.metodo] ?? a.metodo}</td><td>{a.referencia ?? ''}</td><td>{a.cobradoPor}</td>
                  <td className={`derecha ${a.anulado ? 'tachado' : ''}`}>{money(a.monto)}{a.anulado && <> <span className="gris">(anulado: {a.motivoAnulacion})</span></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="pie">
          {abiertas.length > 0
            ? `Saldo pendiente: ${money(e.deudaActual)} en ${abiertas.length} ${abiertas.length === 1 ? 'cuenta' : 'cuentas'}. Los abonos anulados no se descuentan.`
            : 'No tiene cuentas pendientes.'}
        </p>
      </article>
    </>
  )
}
