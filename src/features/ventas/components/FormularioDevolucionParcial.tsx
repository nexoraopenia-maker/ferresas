'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition, type ReactNode } from 'react'
import { MENSAJE_SIN_RED, useEnLinea } from '@/lib/en-linea'
import { devolverProductos } from '@/features/devoluciones/actions'
import type { DiagnosticoParcial } from '@/features/devoluciones/parcial-service'
import type { ResultadoDevolucionParcial } from '@/features/devoluciones/parcial-service'
import { UMBRAL_ADVERTENCIA_DEVOLUCION_DIAS } from '@/features/devoluciones/parcial'
import type { ModoReembolso } from '@/features/devoluciones/reglas'
import { calcularDevolucionParcial, equivalenciaPresentacion, pendienteComoTexto, sePuedeEnviar, type PedidoPantalla } from '../devolucion-parcial'
import { ETIQUETA_MODO_REEMBOLSO, MEDIOS_EXTERNOS, medio } from '../etiquetas'

const money = (n: number) => `S/ ${n.toFixed(2)}`
const cant = (n: number) => String(Number(n.toFixed(4)))
const campo = 'h-touch w-full rounded-xl border border-hairline bg-surface px-3 text-base text-ink disabled:bg-surface-sunken disabled:text-ink-muted'

interface AjusteReembolso { mode?: ModoReembolso; method?: string; reference?: string }

/**
 * «Devolver productos»: la persona elige cuánto devuelve de cada línea (en unidades base, con su equivalencia en cajas si se vendió por
 * presentación), a dónde va (stock vendible o dañado → merma), el motivo y, si hay dinero que devolver, por dónde. El importe, el reparto entre
 * deuda y dinero y el tope se calculan EN VIVO con la misma función que el servidor; el servidor vuelve a comprobarlo todo. La clave de
 * idempotencia nace al abrir el formulario.
 */
export function FormularioDevolucionParcial({ saleId, numero, diagnostico: d, puedeOperar, pedidosIniciales, ayudaAbonos }: {
  saleId: string
  numero: string
  diagnostico: DiagnosticoParcial
  /** La cuenta del negocio permite escribir (no está en solo lectura). */
  puedeOperar: boolean
  /** Cantidades y destinos con que arranca el formulario (por defecto, ninguno). Sirve para «devolver lo que falta» y para probar cada estado. */
  pedidosIniciales?: Record<string, { cantidad: string; destino?: 'STOCK' | 'MERMA' }>
  /** Qué hacer cuando el cálculo en vivo se bloquea por abonos cobrados (`AyudaAbonos`): la página la arma con el permiso y el cliente. */
  ayudaAbonos?: ReactNode
}) {
  const router = useRouter()
  const enLinea = useEnLinea()
  const [pendiente, startTransition] = useTransition()
  const [clave] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000'))
  const [pedidos, setPedidos] = useState<PedidoPantalla[]>(() => d.lineas.map((l) => ({ saleItemId: l.saleItemId, cantidad: pedidosIniciales?.[l.saleItemId]?.cantidad ?? '', destino: pedidosIniciales?.[l.saleItemId]?.destino ?? 'STOCK' })))
  const [motivo, setMotivo] = useState('')
  const [ajustes, setAjustes] = useState<Record<string, AjusteReembolso>>({})
  const [confirmo, setConfirmo] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hecho, setHecho] = useState<ResultadoDevolucionParcial | null>(null)

  const calc = useMemo(() => calcularDevolucionParcial(
    d.lineas.map((l) => ({ saleItemId: l.saleItemId, nombre: l.nombre, controlaStock: l.controlaStock, calculo: l.calculo })), pedidos, d.cuenta, d.contadoPorMedioCent,
  ), [d, pedidos])

  const reembolsos = useMemo(() => (calc.estado !== 'OK' ? [] : calc.sugerencia.map((x) => {
    const a = ajustes[x.method] ?? {}
    const mode: ModoReembolso = a.mode ?? (x.method === 'EFECTIVO' ? 'CAJA' : 'EXTERNO')
    return { original: x.method, mode, method: mode === 'CAJA' ? 'EFECTIVO' : mode === 'EXTERNO' ? (a.method ?? (x.method === 'EFECTIVO' ? 'YAPE' : x.method)) : null, amount: x.cent / 100, reference: a.reference ?? '' }
  })), [calc, ajustes])

  const sinCaja = reembolsos.some((r) => r.mode === 'CAJA') && !d.hayTurnoAbierto
  const faltaMotivoSinSalida = reembolsos.some((r) => r.mode === 'SIN_SALIDA' && r.reference.trim().length < 3)
  const bloqueado = !sePuedeEnviar({ puedeOperar, calculoOk: calc.estado === 'OK', sinCaja, faltaMotivoSinSalida, motivo, confirmo, pendiente })
  const cambiarPedido = (i: number, cambio: Partial<PedidoPantalla>) => setPedidos((ps) => ps.map((p, k) => (k === i ? { ...p, ...cambio } : p)))
  const ajustar = (m: string, cambio: AjusteReembolso) => setAjustes((a) => ({ ...a, [m]: { ...a[m], ...cambio } }))

  const enviar = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!enLinea) { setError(MENSAJE_SIN_RED); return }
    if (bloqueado || calc.estado !== 'OK') return
    setError(null)
    startTransition(async () => {
      const r = await devolverProductos({
        saleId, reason: motivo.trim(), idempotencyKey: clave,
        lines: pedidos.filter((p) => p.cantidad.trim() !== '' && Number(p.cantidad) !== 0).map((p) => ({ saleItemId: p.saleItemId, quantity: Number(p.cantidad.replace(',', '.')), destination: p.destino })),
        ...(reembolsos.length > 0 ? { refunds: reembolsos.map((x) => ({ mode: x.mode, method: x.method, amount: x.amount, reference: x.reference.trim() || undefined })) } : {}),
      })
      if (!r.ok) { setError(r.message); return }
      setHecho(r.data)
      router.refresh()
    })
  }

  if (hecho) {
    return (
      <section data-devolucion-resultado={hecho.number} role="status" className="flex flex-col gap-1 rounded-2xl border-2 border-stock-ok bg-stock-ok-soft p-4 text-sm text-ink">
        <p className="text-base font-bold text-stock-ok">{hecho.completaVenta ? 'Venta devuelta por completo' : 'Devolución parcial registrada'}: {hecho.number} · {money(hecho.total)}</p>
        <p>
          {hecho.mermas > 0 ? `${hecho.mermas} ${hecho.mermas === 1 ? 'línea pasó' : 'líneas pasaron'} a merma` : 'El stock se repuso'}
          {hecho.creditNote ? `; se emitió la nota de crédito ${hecho.creditNote.fullNumber}` : ''}
          {hecho.receivableReducedAmount > 0 ? `; bajó la deuda del cliente en ${money(hecho.receivableReducedAmount)}` : ''}.
        </p>
        <p><Link href="/ventas" className="font-semibold text-industrial-600 underline">Volver al historial de ventas</Link></p>
      </section>
    )
  }

  return (
    <form onSubmit={enviar} data-form="devolucion-parcial" className="flex flex-col gap-4 rounded-2xl border-2 border-industrial-600 bg-surface p-4 text-sm text-ink">
      <div>
        <h2 className="text-lg font-bold">Devolver productos de esta venta</h2>
        <p className="text-ink-muted">Venta {numero}. Elige cuánto devuelve el cliente de cada producto. Lo que ya se devolvió no se puede devolver otra vez.</p>
      </div>

      {d.antiguedad.avisar && (
        <p role="note" data-devolucion="aviso-antiguedad" className="rounded-xl bg-stock-low-soft px-3 py-2 font-semibold text-stock-low">
          Esta venta tiene {d.antiguedad.dias} días (más de {UMBRAL_ADVERTENCIA_DEVOLUCION_DIAS}). Puedes devolverla igual; solo confirma que corresponde. ⚠️ El plazo de 30 días es un criterio operativo, no una norma.
        </p>
      )}
      {d.tieneDevoluciones && (
        <p role="note" data-devolucion="ya-tiene-parciales" className="rounded-xl bg-surface-sunken px-3 py-2 text-ink-muted">
          Esta venta ya tiene devoluciones parciales: ya no se puede anular entera. Lo que falta se devuelve aquí{d.comprobante && !d.comprobante.esEnsayo ? ' (con nota de crédito 07)' : ''}.
        </p>
      )}

      <fieldset className="flex flex-col gap-3" disabled={pendiente}>
        <legend className="mb-1 flex w-full items-center justify-between font-semibold">
          <span>Productos</span>
          <button type="button" data-boton="devolver-lo-que-falta" onClick={() => setPedidos(d.lineas.map((l) => ({ saleItemId: l.saleItemId, cantidad: l.pendiente > 0 ? pendienteComoTexto(l) : '', destino: 'STOCK' })))} className="rounded-lg border border-hairline px-3 py-1 text-xs font-semibold">
            Devolver lo que falta
          </button>
        </legend>
        {d.lineas.map((l, i) => {
          const p = pedidos[i]!
          const q = Number(p.cantidad.replace(',', '.'))
          const eq = equivalenciaPresentacion(Number.isFinite(q) ? q : 0, l.presentacion)
          return (
            <div key={l.saleItemId} data-linea-devolucion={l.saleItemId} className="flex flex-col gap-2 rounded-xl border border-hairline p-3">
              <p className="flex flex-wrap items-baseline justify-between gap-2">
                <b>{l.nombre}</b>
                <span className="text-xs text-ink-muted" data-progreso>Vendido {cant(l.vendida)} · devuelto {cant(l.devuelta)} · queda {cant(l.pendiente)}{l.presentacion ? ` (caja de ${cant(l.presentacion.factor)})` : ''}</span>
              </p>
              {l.pendiente === 0
                ? <p className="text-xs font-semibold text-ink-muted">Ya se devolvió por completo.</p>
                : (
                  <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr]">
                    <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">Cantidad a devolver (unidades)
                      <input name={`cant-${i}`} inputMode="decimal" value={p.cantidad} onChange={(e) => cambiarPedido(i, { cantidad: e.target.value })} placeholder="0" className={campo} />
                      {eq && <span data-equivalencia className="font-normal">= {eq}</span>}
                    </label>
                    {l.controlaStock
                      ? (
                        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">¿En qué estado vuelve?
                          <select name={`destino-${i}`} value={p.destino} onChange={(e) => cambiarPedido(i, { destino: e.target.value as 'STOCK' | 'MERMA' })} className={campo}>
                            <option value="STOCK">Reingresa a stock vendible</option>
                            <option value="MERMA">Dañado (pasa a merma)</option>
                          </select>
                        </label>
                      )
                      : <p className="self-end text-xs text-ink-muted">Servicio sin control de stock: no mueve inventario.</p>}
                  </div>
                )}
            </div>
          )
        })}
      </fieldset>

      <label className="flex flex-col gap-1 font-semibold">Motivo (obligatorio)
        <textarea name="motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={250} rows={2} disabled={pendiente} className={`${campo} h-auto py-2 font-normal`} placeholder="Ej.: el cliente devolvió 3 bolsas sin abrir" />
      </label>

      {calc.estado === 'ERROR' && <p role="alert" data-devolucion="error-calculo" className="rounded-lg bg-stock-out-soft px-3 py-2 font-semibold text-stock-out">{calc.mensaje}</p>}
      {calc.estado === 'BLOQUEADO' && calc.code === 'CREDIT_HAS_PAYMENTS' && ayudaAbonos}
      {calc.estado === 'BLOQUEADO' && <p role="alert" data-devolucion="bloqueado" data-codigo={calc.code} className="rounded-lg bg-stock-out-soft px-3 py-2 font-semibold text-stock-out">{calc.mensaje}</p>}

      {calc.estado === 'OK' && (
        <div data-devolucion="resumen" className="flex flex-col gap-2 rounded-xl bg-surface-sunken p-3">
          <p className="flex justify-between text-base font-bold"><span>Se devuelve</span><span data-resumen="total" className="tabular-nums">{money(calc.totalCent / 100)}</span></p>
          {calc.reparto.deudaCent > 0 && <p className="flex justify-between"><span>Baja la deuda del cliente (primero)</span><b data-resumen="deuda" className="tabular-nums">{money(calc.reparto.deudaCent / 100)}</b></p>}
          <p className="flex justify-between"><span>A reembolsar al cliente</span><b data-resumen="dinero" className="tabular-nums">{money(calc.reparto.dineroCent / 100)}</b></p>
          <ul className="list-disc pl-5 text-xs text-ink-muted">
            {calc.lineas.some((l) => l.destino === 'STOCK') && <li>Lo sano vuelve al stock vendible.</li>}
            {calc.mermas > 0 && <li>{calc.mermas === 1 ? 'Una línea pasa' : `${calc.mermas} líneas pasan`} a <b>merma</b> (dañado): el stock vendible no sube.</li>}
            {d.comprobante && !d.comprobante.esEnsayo && <li>Se emite una <b>nota de crédito parcial (07)</b> del comprobante {d.comprobante.numero}.</li>}
            {d.comprobante?.esEnsayo && <li>El comprobante es de ensayo (sin valor tributario): no se emite nota.</li>}
            {!d.comprobante && <li>Sin comprobante real vivo: no se emite nota de crédito.</li>}
            {calc.completaVenta && <li>Con esto la venta queda <b>devuelta por completo</b>.</li>}
          </ul>
        </div>
      )}

      {calc.estado === 'OK' && reembolsos.length > 0 && (
        <fieldset className="flex flex-col gap-2" disabled={pendiente}>
          <legend className="mb-1 font-semibold">¿Adónde va el dinero? (propuesto según lo que pagó)</legend>
          {reembolsos.map((r) => (
            <div key={r.original} data-reembolso-linea={r.original} className="flex flex-col gap-2 rounded-xl border border-hairline p-3">
              <p className="flex justify-between"><span>Pagó con <b>{medio(r.original)}</b></span><b className="tabular-nums">{money(r.amount)}</b></p>
              <select aria-label="Destino del reembolso" name={`modo-${r.original}`} value={r.mode} onChange={(e) => ajustar(r.original, { mode: e.target.value as ModoReembolso })} className={campo}>
                {(['CAJA', 'EXTERNO', 'SIN_SALIDA'] as const).map((m) => <option key={m} value={m}>{ETIQUETA_MODO_REEMBOLSO[m]}</option>)}
              </select>
              {r.mode === 'EXTERNO' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <select aria-label="Medio de devolución" name={`medio-${r.original}`} value={r.method ?? ''} onChange={(e) => ajustar(r.original, { method: e.target.value })} className={campo}>
                    {MEDIOS_EXTERNOS.map((m) => <option key={m} value={m}>{medio(m)}</option>)}
                  </select>
                  <input name={`ref-${r.original}`} value={r.reference} onChange={(e) => ajustar(r.original, { reference: e.target.value })} maxLength={120} placeholder="N.º de operación (opcional)" className={campo} />
                </div>
              )}
              {r.mode === 'SIN_SALIDA' && <input name={`ref-${r.original}`} value={r.reference} onChange={(e) => ajustar(r.original, { reference: e.target.value })} maxLength={120} placeholder="Motivo: por qué no se devuelve dinero (obligatorio)" className={campo} />}
            </div>
          ))}
          {sinCaja && <p role="alert" data-devolucion="sin-caja" className="rounded-lg bg-stock-low-soft px-3 py-2 font-semibold text-stock-low">Para sacar efectivo del cajón hace falta un turno de caja abierto en la sucursal de la venta. Abre la caja, o elige devolverlo por otro medio.</p>}
        </fieldset>
      )}

      <label className="flex items-start gap-2">
        <input type="checkbox" name="confirmo" checked={confirmo} onChange={(e) => setConfirmo(e.target.checked)} disabled={pendiente} className="mt-1" />
        <span>Entiendo que esta devolución de la venta {numero} <b>no se puede deshacer</b>.</span>
      </label>

      {!puedeOperar && <p role="alert" data-devolucion="solo-lectura" className="rounded-lg bg-stock-low-soft px-3 py-2 font-semibold text-stock-low">Tu cuenta está en solo lectura: no se pueden registrar cambios.</p>}
      {error && <p role="alert" data-error className="rounded-lg bg-stock-out-soft px-3 py-2 font-semibold text-stock-out">{error}</p>}
      <button type="submit" data-boton="confirmar-devolucion-parcial" disabled={bloqueado} className="h-touch rounded-xl bg-stock-out px-4 font-bold text-white disabled:opacity-40">
        {pendiente ? 'Procesando…' : 'Devolver los productos'}
      </button>
    </form>
  )
}
