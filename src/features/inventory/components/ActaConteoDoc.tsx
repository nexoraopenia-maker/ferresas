import { formatearFechaLocal } from '@/lib/fecha-local'
import { formatQuantity } from '@/lib/quantity'
import type { ActaConteo } from '../conteo-documentos'
import { ETIQUETA_ESTADO, ETIQUETA_ESTADO_LINEA } from '../conteo-ui'

/**
 * El acta de la toma de inventario en A4 (F6.5c): documento INTERNO para archivar y firmar. Lista lo contado frente a lo que decía el sistema al contar, las diferencias, quién hizo
 * cada paso y el espacio para las firmas (almacenero, contador y dueño). Los valores (costos y diferencias valorizadas) aparecen SOLO si el servicio los mandó (`conCostos`).
 */

const money = (n: number) => `S/ ${new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`
const firma = (n: number) => (n > 0 ? `+${n}` : String(n))

const ESTILO = `
@page { size: A4; margin: 14mm; }
.acta { background: #fff; color: #111; width: 210mm; max-width: 100%; box-sizing: border-box; padding: 14mm; font: 11px/1.45 system-ui, sans-serif; box-shadow: 0 2px 12px rgba(0,0,0,.35); }
.acta h1 { font-size: 18px; margin: 0; letter-spacing: .04em; }
.acta h2 { font-size: 12px; margin: 14px 0 4px; text-transform: uppercase; letter-spacing: .06em; }
.acta table { width: 100%; border-collapse: collapse; }
.acta th, .acta td { border: 1px solid #999; padding: 3px 5px; text-align: left; vertical-align: top; }
.acta th { background: #eee; font-size: 10px; text-transform: uppercase; }
.acta .num { text-align: right; white-space: nowrap; }
.acta .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 18px; margin-top: 8px; }
.acta .firmas { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 46px; }
.acta .firma { border-top: 1px solid #111; padding-top: 4px; text-align: center; font-size: 10px; }
.acta .chico { font-size: 10px; color: #444; }
@media print { .ticket-pantalla { padding: 0 !important; background: #fff !important; } .acta { box-shadow: none; width: auto; padding: 0; } .acta tr { break-inside: avoid; } }
`

export function ActaConteoDoc({ acta: a }: { acta: ActaConteo }) {
  const f = (iso: string | null) => (iso ? formatearFechaLocal(iso, a.zonaHoraria, a.locale) : '—')
  const q = (n: number | null, u: ActaConteo['lineas'][number]['unidad']) => (n === null ? '—' : formatQuantity(n, u))
  const r = a.resumen
  return (
    <article className="acta" data-acta="conteo">
      <style dangerouslySetInnerHTML={{ __html: ESTILO }} />
      <header>
        <p style={{ fontWeight: 700, textTransform: 'uppercase' }}>{a.emisor.nombre}</p>
        {a.emisor.razonSocial && a.emisor.razonSocial !== a.emisor.nombre && <p>{a.emisor.razonSocial}</p>}
        {a.emisor.ruc && <p>RUC {a.emisor.ruc}</p>}
        {a.emisor.direccion && <p className="chico">{a.emisor.direccion}</p>}
        <h1 style={{ marginTop: 10 }}>ACTA DE TOMA DE INVENTARIO</h1>
        <p data-acta="numero" style={{ fontWeight: 700, fontSize: 14 }}>{a.numero} · {ETIQUETA_ESTADO[a.estado]}</p>
      </header>

      <div className="meta">
        <p><b>Sucursal:</b> {a.sucursal}</p><p><b>Almacén:</b> {a.almacen}</p>
        <p><b>Alcance:</b> {a.alcance}</p><p><b>Modo:</b> Conteo {a.modo.toLowerCase()}</p>
        <p><b>Creada:</b> {f(a.fechas.creado)} · {a.responsables.creo}</p><p><b>Iniciada:</b> {f(a.fechas.iniciado)}{a.responsables.inicio ? ` · ${a.responsables.inicio}` : ''}</p>
        <p><b>Cerrada:</b> {f(a.fechas.cerrado)}{a.responsables.cerro ? ` · ${a.responsables.cerro}` : ''}</p><p><b>Aplicada:</b> {f(a.fechas.aplicado)}{a.responsables.aplico ? ` · ${a.responsables.aplico}` : ''}</p>
        <p style={{ gridColumn: '1 / -1' }}><b>Contaron:</b> {a.responsables.contadores.length > 0 ? a.responsables.contadores.join(', ') : '—'}</p>
      </div>
      {a.notas && <p style={{ marginTop: 6 }}><b>Nota:</b> {a.notas}</p>}

      <h2>Resumen</h2>
      <table data-acta="resumen">
        <tbody>
          <tr><th>Líneas</th><td className="num">{r.lineas}</td><th>Sin contar</th><td className="num">{r.sinContar}</td><th>Sin diferencia</th><td className="num">{r.sinDiferencia}</td><th>Con diferencia</th><td className="num">{r.conDiferencia}</td></tr>
          <tr><th>Aprobadas</th><td className="num">{r.aprobadas}</td><th>Rechazadas</th><td className="num">{r.rechazadas}</td><th>Por recontar</th><td className="num">{r.porRecontar}</td><th /><td /></tr>
          <tr><th>Sobrantes aprobados</th><td className="num">+{r.sobrantes}</td><th>Faltantes aprobados</th><td className="num">−{r.faltantes}</td><th>Netas</th><td className="num">{firma(r.netas)}</td><th /><td /></tr>
          {a.conCostos && (
            <tr data-acta="valores"><th>Valor sobrantes</th><td className="num">{money(r.valorSobrantes ?? 0)}</td><th>Valor faltantes</th><td className="num">{money(r.valorFaltantes ?? 0)}</td><th>Sin costo</th><td className="num">{r.sinCosto ?? 0}</td><th /><td /></tr>
          )}
        </tbody>
      </table>

      <h2>{a.detalleCompleto ? 'Detalle completo' : 'Diferencias y líneas observadas'}</h2>
      {a.lineas.length === 0 ? <p data-acta="sin-diferencias">No hubo diferencias ni líneas observadas.</p> : (
        <table data-acta="detalle">
          <thead>
            <tr><th>Producto</th><th>SKU</th><th className="num">Contado</th><th className="num">Sistema</th><th className="num">Diferencia</th>{a.conCostos && <th className="num">Valor</th>}<th>Estado</th></tr>
          </thead>
          <tbody>
            {a.lineas.map((l, i) => (
              <tr key={`${l.sku}-${i}`} data-acta-linea>
                <td>{l.nombre}{l.nota && <span className="chico"> · {l.nota}</span>}</td><td>{l.sku}</td>
                <td className="num">{q(l.contado, l.unidad)}</td><td className="num">{q(l.sistemaAlContar, l.unidad)}</td>
                <td className="num"><b>{l.diferencia === null ? '—' : firma(l.diferencia)}</b></td>
                {a.conCostos && <td className="num">{l.valorDiferencia == null ? '—' : money(l.valorDiferencia)}</td>}
                <td>{ETIQUETA_ESTADO_LINEA[l.estado]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {a.truncado && <p data-acta="truncado" className="chico">El detalle se cortó en {a.lineas.length} líneas; el CSV lleva todas.</p>}
      {!a.detalleCompleto && r.sinDiferencia > 0 && <p className="chico">{r.sinDiferencia} línea(s) contadas sin diferencia no se detallan aquí (pide el detalle completo o el CSV).</p>}

      <div className="firmas" data-acta="firmas">
        <div className="firma">Almacenero<br />Nombre y firma</div>
        <div className="firma">Contador<br />Nombre y firma</div>
        <div className="firma">Dueño<br />Nombre y firma</div>
      </div>
      <p className="chico" style={{ marginTop: 18 }}>Documento interno de control de inventario. Las cantidades están en la unidad base de cada producto. El «sistema» es lo que decía el kardex a la hora en que se contó cada producto.</p>
    </article>
  )
}
