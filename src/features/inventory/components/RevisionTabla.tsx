import { formatQuantity } from '@/lib/quantity'
import type { LineaRevision } from '../conteo-revision'
import { ETIQUETA_ALERTA, ETIQUETA_ESTADO_LINEA } from '../conteo-ui'
import { AccionesLinea } from './AccionesLinea'

/**
 * La tabla de diferencias de la revisión (F6.5c). Presentacional: lo contado frente a lo que decía el KARDEX a la hora de contar. Las diferencias grandes se resaltan; las columnas de
 * costo existen SOLO si el servicio las mandó (`conCostos`). Los botones de decidir (`puedeDecidir`) solo con el conteo en revisión y la línea sin aplicar.
 */

const money = (n: number) => `S/ ${new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`
const dash = '—'
const firma = (n: number) => (n > 0 ? `+${n}` : String(n))

export function RevisionTabla({ countId, lineas, conCostos, puedeDecidir }: { countId: string; lineas: LineaRevision[]; conCostos: boolean; puedeDecidir: boolean }) {
  if (lineas.length === 0) return <p data-revision="vacio" className="rounded-xl bg-surface-sunken px-3 py-4 text-sm text-ink-muted">No hay líneas con ese filtro.</p>
  return (
    <div data-revision="tabla" className="overflow-x-auto rounded-2xl border border-hairline bg-surface">
      <table className="w-full min-w-[56rem] text-sm">
        <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-ink-muted">
          <tr>
            <th className="px-3 py-2">Producto</th>
            <th className="px-3 py-2 text-right">Contado</th>
            <th className="px-3 py-2 text-right">Sistema al contar</th>
            <th className="px-3 py-2 text-right">Diferencia</th>
            <th className="px-3 py-2 text-right">%</th>
            <th className="px-3 py-2 text-right">Mov. después</th>
            <th className="px-3 py-2 text-right">Stock hoy</th>
            {conCostos && <><th className="px-3 py-2 text-right">Costo prom.</th><th className="px-3 py-2 text-right">Valor dif.</th></>}
            <th className="px-3 py-2">Estado</th>
            {puedeDecidir && <th className="px-3 py-2">Decidir</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {lineas.map((l) => {
            const grande = l.alertas.includes('SOBRE_UMBRAL')
            const dif = l.diferencia
            return (
              <tr key={l.id} data-linea={l.id} data-estado={l.estado} data-grande={grande ? 'si' : 'no'} className={grande ? 'bg-stock-low-soft/50' : ''}>
                <td className="px-3 py-2">
                  <span className="font-medium text-ink">{l.nombre}</span><span className="block font-mono text-xs text-ink-muted">{l.sku}</span>
                  {l.alertas.length > 0 && (
                    <ul data-linea-alertas className="mt-1 flex flex-wrap gap-1">{l.alertas.map((a) => (
                      <li key={a} data-alerta={a} className={`rounded-full px-2 py-0.5 text-xs font-bold ${a === 'DEJARIA_NEGATIVO' ? 'bg-stock-out-soft text-stock-out' : 'bg-stock-low-soft text-stock-low'}`}>{ETIQUETA_ALERTA[a]}{a === 'SOBRE_UMBRAL' && l.causasUmbral.length > 0 ? ` (${l.causasUmbral.map((c) => (c === 'PORCENTAJE' ? 'más del 10 %' : c === 'VALOR' ? 'más de S/ 200' : 'grande')).join(' y ')})` : ''}</li>))}
                    </ul>
                  )}
                  {l.notaRevision && <span className="mt-1 block text-xs text-ink-muted">Nota: {l.notaRevision}</span>}
                </td>
                <td className="px-3 py-2 text-right">{l.contado === null ? dash : formatQuantity(l.contado, l.unidad)}</td>
                <td className="px-3 py-2 text-right">{l.sistemaAlContar === null ? dash : formatQuantity(l.sistemaAlContar, l.unidad)}</td>
                <td className={`px-3 py-2 text-right font-bold ${dif === null || dif === 0 ? 'text-ink' : dif > 0 ? 'text-stock-ok' : 'text-stock-out'}`}>{dif === null ? dash : firma(dif)}</td>
                <td className="px-3 py-2 text-right">{l.diferencia === null ? dash : l.porcentaje === null ? 'n/d' : `${Math.round(l.porcentaje * 1000) / 10} %`}</td>
                <td className="px-3 py-2 text-right">{l.contado === null ? dash : l.movimientosDesdeContar}</td>
                <td className="px-3 py-2 text-right">{formatQuantity(l.stockActual, l.unidad)}</td>
                {conCostos && (
                  <>
                    <td className="px-3 py-2 text-right">{l.costos?.costoPromedio == null ? dash : money(l.costos.costoPromedio)}</td>
                    <td className="px-3 py-2 text-right">{l.costos?.valorDiferencia == null ? dash : money(l.costos.valorDiferencia)}</td>
                  </>
                )}
                <td className="px-3 py-2"><span className="text-xs font-semibold text-ink">{ETIQUETA_ESTADO_LINEA[l.estado]}</span>{l.aplicada && <span data-linea-aplicada className="block text-xs font-bold text-stock-ok">Aplicada al stock</span>}</td>
                {puedeDecidir && <td className="px-3 py-2">{l.aplicada ? <span className="text-xs text-ink-muted">—</span> : <AccionesLinea countId={countId} linea={{ id: l.id, estado: l.estado, alertas: l.alertas, nombre: l.nombre }} />}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
