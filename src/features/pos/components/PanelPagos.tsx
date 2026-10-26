'use client'

import type { InfoCreditoCliente } from '@/features/credito/reglas'
import { motivoNoCabe } from '@/features/credito/reglas'
import type { MetodoPago } from '../pagos'
import { METODOS_POS, ROTULO_FIADO } from '../metodos'
import { saldoPorCobrar, type DisponibilidadFiado, type EstadoPagos, type LineaPago } from '../pagos-ui'

const money = (n: number) => `S/ ${n.toFixed(2)}`

/** Una fila del panel. El importe va como TEXTO (lo que teclea el cajero); `CREDITO` no se teclea: es siempre el saldo. */
export interface FilaPago { key: string; method: MetodoPago; texto: string }

export const MAX_FILAS_PAGO = 5   // el mismo tope que el servidor (`payments.max(5)`)

/** Las filas → líneas de pago. La fila de fiado vale SIEMPRE lo que falta, así que si cambia el carrito no se queda vieja. */
export function lineasDeFilas(filas: readonly FilaPago[], total: number): LineaPago[] {
  const dinero = filas.filter((f) => f.method !== 'CREDITO').map((f): LineaPago => ({ method: f.method, amount: Number(f.texto.replace(',', '.')) || 0 }))
  const saldo = saldoPorCobrar(total, dinero)
  return filas.map((f) => (f.method === 'CREDITO'
    ? { method: 'CREDITO' as const, amount: saldo }
    : { method: f.method, amount: Number(f.texto.replace(',', '.')) || 0 }))
}

/**
 * Pago dividido: varias líneas (método + importe), lo que falta, el vuelto y «Fiado por el saldo». Es solo presentación: ni decide
 * ni calcula nada (eso es de `pagos-ui` y `reglas`, las funciones que también usa el servidor).
 *
 * En móvil vive DENTRO del bloque fijo del fondo (que ya tiene scroll propio), sin pantalla aparte.
 */
export function PanelPagos({ total, filas, onFilas, estado, fiado, ficha, onFiadoPorSaldo, onCerrar }: {
  total: number
  filas: readonly FilaPago[]
  onFilas: (f: FilaPago[]) => void
  estado: EstadoPagos
  fiado: DisponibilidadFiado
  ficha: InfoCreditoCliente | null
  onFiadoPorSaldo: () => void
  onCerrar: () => void
}) {
  const lineas = lineasDeFilas(filas, total)
  const montoFiado = lineas.find((l) => l.method === 'CREDITO')?.amount ?? 0
  const avisoLinea = montoFiado > 0 && ficha ? motivoNoCabe(ficha, montoFiado) : null
  const cambiar = (key: string, parcial: Partial<FilaPago>) => onFilas(filas.map((f) => (f.key === key ? { ...f, ...parcial } : f)))

  return (
    <div role="group" aria-label="Pago dividido" data-panel="dividido" className="mt-3 rounded-2xl border border-hairline bg-surface-sunken p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-ink">Dividir pago</h3>
        <button type="button" onClick={onCerrar} className="text-xs font-semibold text-ink-muted underline">Cobro simple</button>
      </div>

      <ul className="mt-2 flex flex-col gap-2">
        {filas.map((f) => (
          <li key={f.key} className="flex items-center gap-2">
            {f.method === 'CREDITO' ? (
              <>
                <span data-fila="fiado" className="flex h-12 min-w-0 flex-1 items-center rounded-xl bg-stock-low-soft px-3 text-sm font-bold text-stock-low">{ROTULO_FIADO}</span>
                <span aria-label="Monto fiado" className="w-28 shrink-0 text-right text-base font-bold tabular-nums text-ink">{money(montoFiado)}</span>
              </>
            ) : (
              <>
                <select aria-label="Método de la línea" value={f.method} onChange={(e) => cambiar(f.key, { method: e.target.value as MetodoPago })}
                  className="h-12 min-w-0 flex-1 rounded-xl border-2 border-hairline bg-surface px-2 text-sm font-semibold text-ink">
                  {METODOS_POS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
                <input type="number" inputMode="decimal" min="0" step="0.01" value={f.texto} placeholder="0.00" aria-label="Importe de la línea"
                  onChange={(e) => cambiar(f.key, { texto: e.target.value })}
                  className="h-12 w-28 shrink-0 rounded-xl border-2 border-hairline bg-surface px-2 text-right text-base font-bold text-ink focus:border-industrial-600 focus:outline-none" />
              </>
            )}
            {filas.length > 1 && (
              <button type="button" aria-label="Quitar línea" onClick={() => onFilas(filas.filter((x) => x.key !== f.key))}
                className="h-12 w-10 shrink-0 rounded-xl text-lg font-bold text-ink-muted">×</button>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-2 flex flex-wrap gap-2">
        {filas.length < MAX_FILAS_PAGO && (
          <button type="button" onClick={() => onFilas([...filas, { key: `p-${Date.now()}-${filas.length}`, method: 'EFECTIVO', texto: '' }])}
            className="h-10 rounded-xl border-2 border-hairline px-3 text-sm font-semibold text-ink">+ Agregar pago</button>
        )}
        {fiado.ofrece && (
          <button type="button" data-boton="fiado-saldo" onClick={onFiadoPorSaldo}
            className="h-10 rounded-xl border-2 border-stock-low px-3 text-sm font-bold text-stock-low">Fiado por el saldo</button>
        )}
      </div>
      {!fiado.ofrece && fiado.motivo && <p data-fiado="no-ofrece" className="mt-1 text-xs text-ink-muted">{fiado.motivo}</p>}

      <div aria-live="polite" className="mt-3 text-sm">
        {estado.estado === 'FALTA' && <p data-estado="falta" className="font-bold text-stock-low">Falta cobrar {money(estado.falta)}</p>}
        {estado.estado === 'LISTO' && (
          <p data-estado="listo" className="font-bold text-stock-ok">
            Listo para cobrar{estado.vuelto > 0 ? ` · Vuelto ${money(estado.vuelto)}` : ''}{estado.fiado > 0 ? ` · Fiado ${money(estado.fiado)}` : ''}
          </p>
        )}
        {estado.estado === 'ERROR' && <p role="alert" data-estado="error" className="font-bold text-stock-out">{estado.mensaje}</p>}
        {avisoLinea && <p role="alert" data-estado="linea" className="mt-1 font-semibold text-stock-out">{avisoLinea}</p>}
      </div>
    </div>
  )
}
